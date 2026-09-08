/**
 * `POST /rating/report` is exactly-once (design/19 §3, closing the one item ROADMAP 8.1 left
 * open at its own call site) — the ROUTE half. `rating.test.ts` covers the store's claim and
 * its transaction; this file covers what a caller sees, which is where the two decisions
 * that are easy to get wrong live.
 *
 * THE DEFECT. 8.1 gave `reportSettledMatch` a retry budget, which made the route an
 * at-least-once delivery: a report that landed and lost only its response — a timeout, or a
 * 5xx written after the write — came back and was applied again, adding a whole match's
 * rating deltas a second time. Not a theoretical race; the only reason the budget was 3 and
 * not 10.
 *
 * THE TWO DECISIONS.
 *
 *  1. A lost claim answers **200 with `duplicate: true`**, not 409. The sender is
 *     `internalFetch`, which counts any non-2xx a failure: a 409 would log a "ladder report
 *     failed" line naming a match whose rating actually landed, and (for the retryable
 *     statuses) keep asking. 200 is what ENDS an at-least-once ladder against an idempotent
 *     receiver, so the marker goes in the body where an operator can still see it.
 *  2. A thrown apply is a **500**, not an escaped exception. `applyMatchOnce` rolls its
 *     claim back before rethrowing, so the report provably did not land, and 500 is the one
 *     status `internalFetch` retries. Let the throw escape `req.on('end')` instead and node
 *     answers nothing at all — the caller waits out its own timeout, and the retry it then
 *     makes is indistinguishable from a redelivery.
 *
 * Two layers, for the reason `internalTrustSeam.test.ts` states: the handler directly can
 * show the refusals and the logs, and only real HTTP through `createMatchsvcServer` proves
 * the whole thing is wired to the dispatch path with a real store behind it.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createMatchsvcServer } from '../src/matchsvc';
import { INTERNAL_KEY_HEADER } from '../src/internalAuth';
import { MAX_REPORT_KEY_LENGTH, postReport } from '../src/routes/rating';
import { RatingStore, type ApplyMatchOnceResult, type RatingChange } from '../src/rating';
import { openDb } from '../src/db';

/** `config.ts`'s dev fallback, which is what an unset `BB_INTERNAL_KEY` yields under test. */
const DEV_INTERNAL_KEY = 'dev-insecure-internal-key-do-not-use-in-prod';

interface ReportBody {
  accountIds: string[];
  places: number[];
  teamIds?: number[];
  reportKey?: string;
}

interface ReportResponse {
  duplicate?: boolean;
  reportKey?: string;
  changes?: RatingChange[];
  error?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Real HTTP through createMatchsvcServer, against a real SQLite-backed store
// ─────────────────────────────────────────────────────────────────────────────

let baseUrl: string;
let close: () => Promise<void>;

beforeAll(async () => {
  const server = createMatchsvcServer({ dbPath: ':memory:', secret: 'report-once-test-secret' });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
  close = () => new Promise<void>((resolve) => server.close(() => resolve()));
});

afterAll(async () => {
  await close();
});

// `vi.spyOn` on an ALREADY-spied method hands back the existing mock, so without this a
// later case counting console lines reads the earlier cases' calls too — the exact trap
// `index.lifecycle.test.ts` records.
afterEach(() => {
  vi.restoreAllMocks();
});

function post(body: ReportBody): Promise<Response> {
  return fetch(`${baseUrl}/rating/report`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [INTERNAL_KEY_HEADER]: DEV_INTERNAL_KEY },
    body: JSON.stringify(body),
  });
}

async function ratingOf(accountId: string): Promise<number> {
  const res = await fetch(`${baseUrl}/rating/${accountId}`);
  return ((await res.json()) as { rating: number }).rating;
}

/** A distinct settlement per case, so no two cases share a claim. */
function settlement(room: string): ReportBody {
  return {
    accountIds: [`${room}-alice`, `${room}-bob`],
    places: [1, 2],
    teamIds: [0, 1],
    reportKey: `${room}:0123456789abcdef`,
  };
}

describe('POST /rating/report over real HTTP — the same settlement reported twice', () => {
  it('moves the rating ONCE, and says so the second time', async () => {
    const body = settlement('room-twice');
    const before = await ratingOf(body.accountIds[0]!);

    const first = (await (await post(body)).json()) as ReportResponse;
    expect(first.duplicate).toBe(false);
    const afterFirst = await ratingOf(body.accountIds[0]!);
    expect(afterFirst).toBeGreaterThan(before);

    const res = await post(body);
    // 200, so `internalFetch` treats this as a landed report and stops the ladder — the
    // status is the mechanism, and 409 here would keep the sender retrying.
    expect(res.status).toBe(200);
    const second = (await res.json()) as ReportResponse;
    expect(second.duplicate).toBe(true);
    expect(second.changes).toEqual([]); // and it reports no deltas, because none happened
    expect(second.reportKey).toBe(body.reportKey);

    // The assertion the whole pass exists for.
    expect(await ratingOf(body.accountIds[0]!)).toBe(afterFirst);
    expect(await ratingOf(body.accountIds[1]!)).toBeLessThan(before);
  });

  it('a redelivery of the LOSER half does not un-lose them either', async () => {
    // Stated separately because a rating that moves the wrong way is the complaint a player
    // actually files: the loser's delta is negative, so a double-apply demotes them twice.
    const body = settlement('room-loser');
    await post(body);
    const afterFirst = await ratingOf(body.accountIds[1]!);
    await post(body);
    expect(await ratingOf(body.accountIds[1]!)).toBe(afterFirst);
  });

  it('two reports IN FLIGHT AT ONCE: exactly one wins the claim', async () => {
    // Both requests are sent before either response is read, which is the real shape of a
    // retry overtaking a slow first attempt. The claim, not the arrival order, decides.
    const body = settlement('room-race');
    const before = await ratingOf(body.accountIds[0]!);
    const [a, b] = await Promise.all([post(body), post(body)]);
    const bodies = (await Promise.all([a.json(), b.json()])) as ReportResponse[];

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(bodies.filter((r) => r.duplicate === false)).toHaveLength(1);
    expect(bodies.filter((r) => r.duplicate === true)).toHaveLength(1);
    const applied = bodies.find((r) => r.duplicate === false)!;
    expect(await ratingOf(body.accountIds[0]!)).toBe(applied.changes![0]!.after);
    expect(await ratingOf(body.accountIds[0]!)).toBeGreaterThan(before);
  });

  it('a different match in the same room still applies — the key is not just the room id', async () => {
    // The over-broad-key failure, end to end. `index.ts`'s legacy dev handshake takes
    // `roomId` off the query string and a room is destroyed when it settles, so one room id
    // really can host two matches; swallowing the second as a duplicate would lose its
    // rating with nothing logged.
    const first = settlement('room-shared');
    await post(first);
    const afterFirst = await ratingOf(first.accountIds[0]!);
    const second = { ...first, places: [2, 1], reportKey: 'room-shared:fedcba9876543210' };
    const res = (await (await post(second)).json()) as ReportResponse;
    expect(res.duplicate).toBe(false);
    expect(await ratingOf(first.accountIds[0]!)).toBeLessThan(afterFirst); // they lost this one
  });

  it('the report is still authenticated — a duplicate marker is not a way past the key', async () => {
    const body = settlement('room-nokey');
    const res = await fetch(`${baseUrl}/rating/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(401);
    expect(await ratingOf(body.accountIds[0]!)).toBe(1000); // DEFAULT_RATING — nothing ran
  });

  it.each([
    ['an empty reportKey', ''],
    ['an over-long reportKey', 'x'.repeat(MAX_REPORT_KEY_LENGTH + 1)],
  ])('refuses %s with a 400 and moves nothing', async (_label, reportKey) => {
    const body = { ...settlement('room-badkey'), reportKey };
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(((await res.json()) as ReportResponse).error).toContain('reportKey');
    expect(await ratingOf(body.accountIds[0]!)).toBe(1000);
  });

  it('a reportKey of exactly the maximum length is ACCEPTED — the bound is inclusive', async () => {
    // Pins the boundary rather than the neighbourhood. A `>=` here would refuse a key one
    // character short of the limit, and since a 4xx is never retried that report's rating
    // would be gone — for a key the sender is entitled to send.
    const body = { ...settlement('room-maxkey'), reportKey: 'k'.repeat(MAX_REPORT_KEY_LENGTH) };
    const res = await post(body);
    expect(res.status).toBe(200);
    expect(((await res.json()) as ReportResponse).duplicate).toBe(false);
    expect(await ratingOf(body.accountIds[0]!)).toBeGreaterThan(1000);
  });

  it('a non-string reportKey is refused rather than coerced into a claim', async () => {
    // `42` and `'42'` would be two different claims for one settlement if this were
    // coerced, which is the same lost-key failure with extra steps.
    const res = await post({ ...settlement('room-numkey'), reportKey: 42 as unknown as string });
    expect(res.status).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The handler directly: the logs and the 500, which a real request cannot show
// ─────────────────────────────────────────────────────────────────────────────

function fakeReq(body: unknown): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage;
  req.headers = { [INTERNAL_KEY_HEADER]: DEV_INTERNAL_KEY };
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

const url = new URL('http://svc.test/rating/report');

describe('postReport — a report whose apply THROWS', () => {
  it('answers 500 (retryable) rather than letting the throw escape the end handler', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ratings = {
      applyMatchOnce: (): ApplyMatchOnceResult => {
        throw new Error('database is locked');
      },
    } as unknown as RatingStore;
    const { res, sent } = fakeRes();
    postReport(fakeReq(settlement('room-throw')), res, url, { ratings });
    await vi.waitFor(() => expect(sent.status).toBe(500));
    // 500 and not 400/409 on purpose: `internalFetch` retries a 5xx and nothing else, and
    // `applyMatchOnce` has already rolled its claim back, so the retry can actually land.
    expect(JSON.parse(sent.body)).toEqual({ error: 'rating apply failed' });
    const lines = error.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('/rating/report'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('database is locked'); // the reason reaches the operator...
    expect(lines[0]).toContain('room-throw'); // ...along with WHICH settlement it was
    expect(sent.body).not.toContain('database is locked'); // ...and not the caller
  });

  it('cannot be used to forge a second log line — the reportKey is sanitized', async () => {
    // `reportKey` arrives in a request BODY, so it is untrusted the same way
    // `x-internal-caller` is; `internalAuth.ts` learned this lesson on that header and this
    // line reuses its sanitizer rather than re-deciding.
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ratings = {
      applyMatchOnce: (): ApplyMatchOnceResult => {
        throw new Error('nope');
      },
    } as unknown as RatingStore;
    const { res, sent } = fakeRes();
    const hostile = ['r:', 'FAKE APPLIED'].join('\n');
    postReport(fakeReq({ ...settlement('room-inject'), reportKey: hostile }), res, url, { ratings });
    await vi.waitFor(() => expect(sent.status).toBe(500));
    const lines = error.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('/rating/report'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('\n'); // the claim cannot forge a second record
    expect(lines[0]).toContain('FAKE APPLIED'); // ...but is still shown, on the one line
  });

  it('a real store whose write is refused mid-transaction produces that 500, claim released', async () => {
    // The same path with nothing stubbed: a SQLite trigger aborts the rating write, so the
    // 500 comes from the transaction actually rolling back rather than from a fake throw.
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const db = openDb(':memory:');
    const ratings = new RatingStore(db);
    db.exec(`CREATE TRIGGER ratings_refuse BEFORE INSERT ON ratings BEGIN SELECT RAISE(ABORT, 'refused'); END`);
    const body = settlement('room-refused');

    const first = fakeRes();
    postReport(fakeReq(body), first.res, url, { ratings });
    await vi.waitFor(() => expect(first.sent.status).toBe(500));
    expect(error).toHaveBeenCalled();

    // The retry the 500 invites: it must APPLY, not be turned away as a duplicate.
    db.exec('DROP TRIGGER ratings_refuse');
    const second = fakeRes();
    postReport(fakeReq(body), second.res, url, { ratings });
    await vi.waitFor(() => expect(second.sent.status).toBe(200));
    expect((JSON.parse(second.sent.body) as ReportResponse).duplicate).toBe(false);
    expect(ratings.get(body.accountIds[0]!)).toBeGreaterThan(1000);
    db.close();
  });
});

describe('postReport — a report with NO reportKey (an un-redeployed sender)', () => {
  const keyless = (): ReportBody => ({ accountIds: ['skew-alice', 'skew-bob'], places: [1, 2] });

  it('is applied the old, non-deduped way rather than refused', async () => {
    // Deliberate, and the argument is asymmetric: only one process legitimately calls this
    // route, so a keyless report means version skew during a rolling deploy. Accepting it
    // risks 8.1's bounded double-apply; a 400 would lose those matches' ratings for good,
    // because `internalFetch` never retries a 4xx. The recoverable failure wins.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ratings = new RatingStore(openDb(':memory:'));
    const { res, sent } = fakeRes();
    postReport(fakeReq(keyless()), res, url, { ratings });
    await vi.waitFor(() => expect(sent.status).toBe(200));
    const parsed = JSON.parse(sent.body) as ReportResponse;
    expect(parsed.duplicate).toBe(false);
    expect(parsed.changes).toHaveLength(2);
    expect(parsed.reportKey).toBeUndefined(); // nothing invented a key on the sender's behalf
    expect(ratings.get('skew-alice')).toBeGreaterThan(1000);
  });

  it('warns, because "the gameserver has not been redeployed" is actionable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { res, sent } = fakeRes();
    postReport(fakeReq(keyless()), res, url, { ratings: new RatingStore() });
    await vi.waitFor(() => expect(sent.status).toBe(200));
    const lines = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('reportKey'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('/rating/report');
  });

  it('a throwing keyless apply still answers 500, naming no key it does not have', async () => {
    // Both remaining arms of the error line at once: no `reportKey` clause (there is no key
    // to name), and a thrown NON-Error still reaches the operator as text rather than as
    // `[object Object]` swallowed by a `.message` that does not exist.
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ratings = {
      applyMatch: () => {
        throw 'the store said no'; // eslint-disable-line no-throw-literal
      },
    } as unknown as RatingStore;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { res, sent } = fakeRes();
    postReport(fakeReq(keyless()), res, url, { ratings });
    await vi.waitFor(() => expect(sent.status).toBe(500));
    const lines = error.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('/rating/report'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('the store said no');
    expect(lines[0]).not.toContain('reportKey');
  });

  it('a keyless report is NOT deduped — two of them both apply', async () => {
    // The honest statement of what the fallback costs. If this ever starts passing as a
    // duplicate, something has begun inventing keys, and a key derived from the body would
    // silently collapse two identical matches into one.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ratings = new RatingStore();
    for (const _ of [0, 1]) {
      const { res, sent } = fakeRes();
      postReport(fakeReq(keyless()), res, url, { ratings });
      await vi.waitFor(() => expect(sent.status).toBe(200));
    }
    const changes = ratings.applyMatch(['skew-alice'], [1]);
    expect(changes[0]!.before).toBeGreaterThan(1000 + 15); // two wins' worth, not one
  });
});

describe('rating_reports — the schema constraint the claim rests on', () => {
  it('a second row with the same report_key is refused by the PRIMARY KEY, not by app code', () => {
    // `applyMatchOnce`'s `ON CONFLICT DO NOTHING` + `changes()` is only a claim because the
    // column cannot hold two of the same key. Asserted against the real error text, so
    // dropping the constraint fails here rather than quietly making every retry a winner.
    const db = openDb(':memory:');
    db.prepare('INSERT INTO rating_reports (report_key, applied_at) VALUES (?, ?)').run('k', 1);
    expect(() => db.prepare('INSERT INTO rating_reports (report_key, applied_at) VALUES (?, ?)').run('k', 2)).toThrow(
      /UNIQUE constraint failed: rating_reports.report_key/,
    );
    db.close();
  });

  it('takes no foreign key — a guest/bot scaffold settlement is claimable too', () => {
    // Same reasoning `ratings` records: a report key names a MATCH, and the accounts in it
    // may be `seat:{roomId}:{seatIdx}` scaffolds with no accounts row anywhere.
    const store = new RatingStore(openDb(':memory:'));
    expect(store.applyMatchOnce('seat-room:0000000000000000', ['seat:r:0', 'seat:r:1'], [1, 2]).applied).toBe(true);
  });
});
