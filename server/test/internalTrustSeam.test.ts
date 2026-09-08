/**
 * `POST /rating/report` behind the internal key — design/19's D1, ROADMAP 8.1, end to end.
 *
 * The defect being closed is worth restating as the thing this file has to prove, because a
 * "the route answers 200" test proves the opposite of it: before this pass, `/rating/report`
 * had no key, no origin check and open CORS, while being the one endpoint in the project
 * that can move ANY account's ladder rating. A stranger with curl could hand themselves
 * first place and demote a real player, forever, with one request. So every case here is
 * about who is turned away.
 *
 * Two layers, because they answer different questions:
 *
 *  - **Real HTTP through `createMatchsvcServer`** — proves the check is actually WIRED, on
 *    the real dispatch path, with real headers. A verifier that works perfectly in a unit
 *    test and is never called is the failure mode this layer exists to exclude, and it is
 *    not hypothetical: `deps.internalAuth` is optional, so a handler that read it without a
 *    fallback would silently authenticate nobody.
 *  - **The handler directly** — the injection seam and the audit line, which a real request
 *    cannot show you.
 *
 * The player-token case is deliberately built from a REAL registration rather than a
 * hand-written token: design/19's third-namespace rule says an internal route never accepts
 * a player session, and the only convincing evidence for that is a session the server itself
 * just issued and would accept anywhere it IS valid (asserted here against `/auth/me`).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createMatchsvcServer } from '../src/matchsvc';
import { CORS } from '../src/routes/http';
import { INTERNAL_CALLER_HEADER, INTERNAL_KEY_HEADER } from '../src/internalAuth';
import { postReport } from '../src/routes/rating';
import type { RatingStore } from '../src/rating';

/** `config.ts`'s dev fallback, which is what an unset `BB_INTERNAL_KEY` yields under test. */
const DEV_INTERNAL_KEY = 'dev-insecure-internal-key-do-not-use-in-prod';

let baseUrl: string;
let close: () => Promise<void>;

beforeAll(async () => {
  const server = createMatchsvcServer({ dbPath: ':memory:', secret: 'trust-seam-test-secret' });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
  close = () => new Promise<void>((resolve) => server.close(() => resolve()));
});

afterAll(async () => {
  await close();
});

const REPORT = { accountIds: ['seam-alice', 'seam-bob'], places: [1, 2] };

function report(headers: Record<string, string>, body: unknown = REPORT): Promise<Response> {
  return fetch(`${baseUrl}/rating/report`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

async function ratingOf(accountId: string): Promise<number> {
  const res = await fetch(`${baseUrl}/rating/${accountId}`);
  return ((await res.json()) as { rating: number }).rating;
}

describe('POST /rating/report over real HTTP — who is turned away', () => {
  it('rejects a request with NO key at all, and moves no rating', async () => {
    const before = await ratingOf('seam-alice');
    const res = await report({});
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
    // The assertion that matters is not the status code — it is that the write did not
    // happen. A 401 returned after `applyMatch` would look identical from the response.
    expect(await ratingOf('seam-alice')).toBe(before);
  });

  it('rejects a wrong key, and moves no rating', async () => {
    const before = await ratingOf('seam-alice');
    const res = await report({ [INTERNAL_KEY_HEADER]: 'not-the-key' });
    expect(res.status).toBe(401);
    expect(await ratingOf('seam-alice')).toBe(before);
  });

  it.each([
    ['a one-byte-shorter key', DEV_INTERNAL_KEY.slice(0, -1)],
    ['a one-byte-longer key', `${DEV_INTERNAL_KEY}x`],
    ['an empty key', ''],
  ])('rejects %s without a 500 (timingSafeEqual would throw on a length mismatch)', async (_l, key) => {
    const res = await report({ [INTERNAL_KEY_HEADER]: key });
    expect(res.status).toBe(401);
  });

  it('rejects a REAL player session token presented as the internal key', async () => {
    const reg = await fetch(`${baseUrl}/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'seamplayer', password: 'hunter22' }),
    });
    const { token } = (await reg.json()) as { token: string };

    // The token is genuinely valid — where a player token IS the credential, it works.
    const me = await fetch(`${baseUrl}/auth/me`, { headers: { authorization: `Bearer ${token}` } });
    expect(me.status).toBe(200);

    // ...and buys exactly nothing on an internal route, in either header.
    expect((await report({ [INTERNAL_KEY_HEADER]: token })).status).toBe(401);
    expect((await report({ authorization: `Bearer ${token}` })).status).toBe(401);
    expect(
      (await report({ authorization: `Bearer ${token}`, [INTERNAL_CALLER_HEADER]: 'gameserver' })).status,
    ).toBe(401);
  });

  it('rejects a caller that merely CLAIMS to be the gameserver', async () => {
    const res = await report({ [INTERNAL_CALLER_HEADER]: 'gameserver' });
    expect(res.status).toBe(401);
  });

  it('accepts the configured key and applies the match', async () => {
    const res = await report({ [INTERNAL_KEY_HEADER]: DEV_INTERNAL_KEY, [INTERNAL_CALLER_HEADER]: 'gameserver' });
    expect(res.status).toBe(200);
    const { changes } = (await res.json()) as { changes: { accountId: string; before: number; after: number }[] };
    expect(changes).toHaveLength(2);
    const alice = changes.find((c) => c.accountId === 'seam-alice')!;
    expect(alice.after).toBeGreaterThan(alice.before);
    expect(await ratingOf('seam-alice')).toBe(alice.after);
  });

  it('still validates the body AFTER authenticating — the key is not a bypass', async () => {
    const res = await report({ [INTERNAL_KEY_HEADER]: DEV_INTERNAL_KEY }, { accountIds: ['a', 'b'], places: [1] });
    expect(res.status).toBe(400);
  });

  it('leaves GET /rating/:accountId open — it is a public read that writes nothing', async () => {
    const res = await fetch(`${baseUrl}/rating/seam-alice`);
    expect(res.status).toBe(200);
    expect((await res.json()) as { accountId: string }).toMatchObject({ accountId: 'seam-alice' });
  });
});

describe('the internal key is not reachable from a browser', () => {
  it('is absent from access-control-allow-headers, so a cross-origin preflight refuses it', async () => {
    // The CORS block on these routes is wide open (`*`), which is fine for the player-facing
    // reads and would NOT be fine if a page could attach `x-internal-key` to a request. It
    // cannot: a header not listed here fails preflight before the real request is sent.
    // Pinned as a property of the shipped header, not of this file's opinion.
    expect(CORS['access-control-allow-headers']).not.toContain(INTERNAL_KEY_HEADER);
    const preflight = await fetch(`${baseUrl}/rating/report`, { method: 'OPTIONS' });
    expect(preflight.headers.get('access-control-allow-headers')).not.toContain(INTERNAL_KEY_HEADER);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The handler directly: the injection seam and the audit line
// ─────────────────────────────────────────────────────────────────────────────

function fakeReq(headers: Record<string, string>, body: unknown): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage;
  req.headers = headers;
  queueMicrotask(() => {
    req.emit('data', Buffer.from(JSON.stringify(body), 'utf8'));
    req.emit('end');
  });
  return req;
}

function fakeRes(): { res: ServerResponse; sent: { status: number; body: string } } {
  const sent = { status: 0, body: '' };
  const res = {
    writeHead(status: number) {
      sent.status = status;
      return res;
    },
    end(body?: string) {
      sent.body = body ?? '';
    },
  };
  return { res: res as unknown as ServerResponse, sent };
}

const ratingsStub = { applyMatch: () => [{ accountId: 'a', before: 1000, after: 1016 }] } as unknown as RatingStore;
const url = new URL('http://svc.test/rating/report');

describe('postReport — the deps.internalAuth injection seam', () => {
  it('uses an injected verifier instead of the env-derived one', async () => {
    const verify = vi.fn(() => ({ ok: true as const, caller: 'billsvc' }));
    const { res, sent } = fakeRes();
    postReport(fakeReq({}, REPORT), res, url, { ratings: ratingsStub, internalAuth: { verify } });
    await vi.waitFor(() => expect(sent.status).toBe(200));
    // No `x-internal-key` was sent at all, and it still succeeded — proof the injected
    // verifier is what ran, rather than the default happening to agree.
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it('an injected verifier that refuses stops the write', async () => {
    const applyMatch = vi.fn();
    const { res, sent } = fakeRes();
    postReport(
      fakeReq({}, REPORT),
      res,
      url,
      {
        ratings: { applyMatch } as unknown as RatingStore,
        internalAuth: { verify: () => ({ ok: false, reason: 'unknown-key' }) },
      },
    );
    await vi.waitFor(() => expect(sent.status).toBe(401));
    expect(applyMatch).not.toHaveBeenCalled();
  });

  it('logs ONE audit line naming the reason and the untrusted caller claim, sanitized', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { res, sent } = fakeRes();
      postReport(
        fakeReq({ [INTERNAL_CALLER_HEADER]: 'gameserver\nFAKE ACCEPTED' }, REPORT),
        res,
        url,
        { ratings: ratingsStub, internalAuth: { verify: () => ({ ok: false, reason: 'missing-key', claimedCaller: 'gameserver\nFAKE ACCEPTED' }) } },
      );
      await vi.waitFor(() => expect(sent.status).toBe(401));
      const lines = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('/rating/report'));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('missing-key');
      expect(lines[0]).not.toContain('\n'); // the claim cannot forge a second record
    } finally {
      warn.mockRestore();
    }
  });

  it('the refusal body says nothing about WHY — the reason goes to the operator, not the caller', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { res, sent } = fakeRes();
      postReport(fakeReq({}, REPORT), res, url, {
        ratings: ratingsStub,
        internalAuth: { verify: () => ({ ok: false, reason: 'no-keys-configured' }) },
      });
      await vi.waitFor(() => expect(sent.status).toBe(401));
      expect(JSON.parse(sent.body)).toEqual({ error: 'unauthorized' });
      expect(sent.body).not.toContain('no-keys-configured');
    } finally {
      warn.mockRestore();
    }
  });
});
