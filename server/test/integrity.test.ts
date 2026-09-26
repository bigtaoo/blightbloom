/**
 * matchsvc's integrity record (design/15, "PvP integrity", decided 2026-09-26): the
 * `IntegrityStore` on both backends, and `POST /integrity/report` both over real HTTP and
 * against the handler directly.
 *
 * The property everything here protects is the exactly-once count. The gameserver retries a
 * report it did not see acknowledged, so a record that counted on every delivery would
 * inflate an account's suspicion by the retry budget — and a suspicion count is the one
 * number an operator reads to decide whether somebody keeps turning up.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { gzipSync } from 'node:zlib';
import type { AddressInfo } from 'node:net';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createMatchsvcServer } from '../src/matchsvc';
import { INTERNAL_KEY_HEADER } from '../src/internalAuth';
import { IntegrityStore, suspectAccounts } from '../src/integrity';
import { INTEGRITY_BODY_LIMIT, isIntegrityReportBody, postIntegrityReport } from '../src/routes/integrity';
import type { IntegrityReportBody } from '../src/integrityReport';
import type { AccountsStore } from '../src/db';
import { freshAccounts } from './mongoHarness';

const DEV_INTERNAL_KEY = 'dev-insecure-internal-key-do-not-use-in-prod';

function body(roomId: string, over: Partial<IntegrityReportBody> = {}): IntegrityReportBody {
  return {
    roomId,
    verdict: 'dissent',
    playerCount: 4,
    seed: 11,
    engineVersion: 75,
    settleFrame: 900,
    suspects: [
      { seat: 1, accountId: `${roomId}-one`, dissented: true, kicked: true },
      { seat: 3, dissented: true, kicked: false },
    ],
    seatAccounts: { 1: `${roomId}-one`, 2: `${roomId}-two` },
    logGzipB64: gzipSync('[]').toString('base64'),
    ...over,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('suspectAccounts', () => {
  it('names each real account once, sorted, and skips guests', () => {
    expect(
      suspectAccounts({
        suspects: [
          { seat: 2, accountId: 'b', dissented: true, kicked: false },
          { seat: 0, dissented: true, kicked: false },
          { seat: 1, accountId: 'a', dissented: false, kicked: true },
          { seat: 3, accountId: 'b', dissented: false, kicked: true },
        ],
      }),
    ).toEqual(['a', 'b']);
  });
});

const BACKENDS: [string, () => Promise<AccountsStore | undefined>][] = [
  ['in memory', async () => undefined],
  ['on the cluster', async () => freshAccounts()],
];

describe.each(BACKENDS)('IntegrityStore %s', (_label, open) => {
  it('records once per room and counts each suspect account once per record', async () => {
    const s = new IntegrityStore(await open(), () => 1234);
    expect(await s.recordOnce(body('room-a'))).toBe(true);
    expect(await s.recordOnce(body('room-a'))).toBe(false); // the retried delivery
    expect(await s.suspicionCount('room-a-one')).toBe(1);
    // A logged-in seat that was NOT a suspect is never counted.
    expect(await s.suspicionCount('room-a-two')).toBe(0);
  });

  it('accumulates across different rooms', async () => {
    const s = new IntegrityStore(await open());
    await s.recordOnce(body('room-b', { suspects: [{ seat: 0, accountId: 'repeat', dissented: true, kicked: false }] }));
    await s.recordOnce(body('room-c', { suspects: [{ seat: 2, accountId: 'repeat', dissented: false, kicked: true }] }));
    expect(await s.suspicionCount('repeat')).toBe(2);
  });

  it('records a match that names nobody without counting anything', async () => {
    const s = new IntegrityStore(await open());
    expect(await s.recordOnce(body('room-d', { verdict: 'no_consensus', suspects: [] }))).toBe(true);
    expect(await s.suspicionCount('room-d-one')).toBe(0);
  });
});

describe('IntegrityStore on the cluster — the stored document', () => {
  it('stores the log as binary, the seat map with string keys, and the receive time', async () => {
    const store = await freshAccounts();
    const s = new IntegrityStore(store, () => 5555);
    await s.recordOnce(body('room-doc', { verdict: 'bounds', bounds: 'too_short' }));
    const doc = (await store.integrityReports.findOne({ _id: 'room-doc' }))!;
    expect(doc).toMatchObject({
      receivedAt: 5555,
      verdict: 'bounds',
      bounds: 'too_short',
      seed: 11,
      engineVersion: 75,
      seatAccounts: { '1': 'room-doc-one', '2': 'room-doc-two' },
    });
    expect(Buffer.from(doc.log!.buffer).equals(gzipSync('[]'))).toBe(true);
    expect(doc.logDropped).toBeUndefined();
    const sus = (await store.suspicion.findOne({ _id: 'room-doc-one' }))!;
    expect(sus).toEqual({ _id: 'room-doc-one', count: 1, lastRoomId: 'room-doc', lastAt: 5555 });
  });

  it('stores a dropped log as a flag and no binary', async () => {
    const store = await freshAccounts();
    await new IntegrityStore(store).recordOnce(body('room-drop', { logGzipB64: undefined, logDropped: true }));
    const doc = (await store.integrityReports.findOne({ _id: 'room-drop' }))!;
    expect(doc.log).toBeUndefined();
    expect(doc.logDropped).toBe(true);
  });

  it('two deliveries IN FLIGHT AT ONCE count once', async () => {
    const store = await freshAccounts();
    const s = new IntegrityStore(store);
    const results = await Promise.all([s.recordOnce(body('room-race')), s.recordOnce(body('room-race'))]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await s.suspicionCount('room-race-one')).toBe(1);
  });
});

describe('isIntegrityReportBody', () => {
  it('accepts a well-formed body, with or without the optional fields', () => {
    expect(isIntegrityReportBody(body('ok'))).toBe(true);
    expect(isIntegrityReportBody(body('ok', { logGzipB64: undefined, logDropped: true, bounds: 'too_short' }))).toBe(true);
  });

  it.each([
    ['null', null],
    ['a string', 'x'],
    ['an empty room id', { ...body('x'), roomId: '' }],
    ['an over-long room id', { ...body('x'), roomId: 'r'.repeat(257) }],
    ['a clean verdict', { ...body('x'), verdict: 'clean' }],
    ['a numeric bounds', { ...body('x'), bounds: 3 }],
    ['a negative seed', { ...body('x'), seed: -1 }],
    ['a fractional settle frame', { ...body('x'), settleFrame: 1.5 }],
    ['suspects not an array', { ...body('x'), suspects: {} }],
    ['a null suspect', { ...body('x'), suspects: [null] }],
    ['a suspect with no seat', { ...body('x'), suspects: [{ dissented: true, kicked: false }] }],
    ['a suspect with a numeric account', { ...body('x'), suspects: [{ seat: 0, accountId: 5, dissented: true, kicked: false }] }],
    ['a suspect with a string flag', { ...body('x'), suspects: [{ seat: 0, dissented: 'yes', kicked: false }] }],
    ['a null seat map', { ...body('x'), seatAccounts: null }],
    ['an array seat map', { ...body('x'), seatAccounts: [] }],
    ['a seat map with a number', { ...body('x'), seatAccounts: { 0: 1 } }],
    ['a numeric log', { ...body('x'), logGzipB64: 1 }],
    ['a string logDropped', { ...body('x'), logDropped: 'true' }],
  ])('refuses %s', (_label, value) => {
    expect(isIntegrityReportBody(value)).toBe(false);
  });
});

describe('POST /integrity/report over real HTTP', () => {
  let baseUrl: string;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const server = createMatchsvcServer({ store: await freshAccounts(), secret: 'integrity-test-secret' });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  });

  afterAll(async () => {
    await close();
  });

  const post = (payload: unknown, key: string | null = DEV_INTERNAL_KEY) =>
    fetch(`${baseUrl}/integrity/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(key === null ? {} : { [INTERNAL_KEY_HEADER]: key }) },
      body: JSON.stringify(payload),
    });

  it('records a report, and answers a redelivery 200 with recorded:false', async () => {
    const first = await post(body('room-http'));
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ recorded: true });
    const again = await post(body('room-http'));
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ recorded: false });
  });

  it('401s a report with no internal key, and says nothing about why', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await post(body('room-nokey'), null);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
    expect(warn.mock.calls.some((c) => String(c[0]).includes('POST /integrity/report'))).toBe(true);
  });

  it('400s a malformed report', async () => {
    const res = await post({ roomId: 'room-bad' });
    expect(res.status).toBe(400);
  });

  it('accepts a body far past the 4 KB default limit', async () => {
    // A real log is tens of kilobytes; the default limit would truncate it into a 400.
    const big = body('room-big', { logGzipB64: 'A'.repeat(200_000) });
    const res = await post(big);
    expect(res.status).toBe(200);
  });

  it('sizes its limit for the sender cap, base64 included', () => {
    expect(INTEGRITY_BODY_LIMIT).toBeGreaterThan((4 * 1024 * 1024 * 4) / 3);
  });
});

describe('postIntegrityReport — a store that THROWS', () => {
  function fakeReq(payload: unknown): IncomingMessage {
    const req = new EventEmitter() as IncomingMessage;
    req.headers = { [INTERNAL_KEY_HEADER]: DEV_INTERNAL_KEY };
    queueMicrotask(() => {
      req.emit('data', Buffer.from(JSON.stringify(payload), 'utf8'));
      req.emit('end');
    });
    return req;
  }

  it('answers 500, retryable, and logs the reason for the operator only', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const sent = { status: 0, body: '' };
    const res = {
      writeHead(status: number) {
        sent.status = status;
        return res;
      },
      end(b?: string) {
        sent.body = b ?? '';
      },
    } as unknown as ServerResponse;
    const integrity = {
      recordOnce: () => Promise.reject(new Error('cluster unreachable')),
    } as unknown as IntegrityStore;
    await postIntegrityReport(fakeReq(body('room-throw')), res, new URL('http://svc.test/integrity/report'), { integrity });
    expect(sent.status).toBe(500);
    expect(sent.body).not.toContain('cluster unreachable');
    expect(error.mock.calls.some((c) => String(c[0]).includes('cluster unreachable'))).toBe(true);
  });

  it('logs a non-Error rejection as a string', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = { writeHead: () => res, end: () => {} } as unknown as ServerResponse;
    const integrity = { recordOnce: () => Promise.reject('plain') } as unknown as IntegrityStore;
    await postIntegrityReport(fakeReq(body('room-str')), res, new URL('http://svc.test/integrity/report'), { integrity });
    expect(error.mock.calls.some((c) => String(c[0]).includes('plain'))).toBe(true);
  });
});
