/**
 * Client matchmaking (ROADMAP 3.3). Drives findMatch with a fake fetch + fake sleep (no
 * network, no timers) through every branch: inline match, queued→matched polling,
 * expired, timeout, and service error. The ticket it returns is opaque here — the
 * server's ticket/Matchmaker tests own that surface; this pins the client's poll loop.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { resetSessionCacheForTests, setSession } from './session';
import { findMatch, requestResume, type MatchInfo } from './matchmaking';

const MATCH: MatchInfo = {
  wsUrl: 'ws://localhost:8787/ws', roomId: 'room-1', owner: 1, seed: 42, playerCount: 2, teamId: 1, token: 'tok',
};

/** A fetch stub that returns the queued JSON bodies in sequence. */
function fakeFetch(bodies: unknown[]) {
  let i = 0;
  return vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
    const body = bodies[Math.min(i++, bodies.length - 1)];
    return { ok: true, status: 200, json: async () => body } as Response;
  });
}

const noSleep = async () => {};

/** An in-memory SessionStore, so `setSession` never reaches `localStorage` (which does not
 *  exist under the node environment these tests run in). */
function fakeStore() {
  let held: import('./session').Session | null = null;
  return { load: () => held, save: (s: import('./session').Session | null) => { held = s; } };
}

describe('findMatch', () => {
  it('returns the inline match when this arrival completes the group (no polling)', async () => {
    const fetch = fakeFetch([{ queueId: 'q1', match: MATCH }]);
    const info = await findMatch('http://mm', { playerCount: 2, fetch, sleep: noSleep });
    expect(info).toEqual(MATCH);
    expect(fetch).toHaveBeenCalledTimes(1); // POST /find only, never polled
  });

  it('polls while queued, then resolves when the seat is matched', async () => {
    const fetch = fakeFetch([
      { queueId: 'q1' }, // POST /find → queued
      { status: 'queued' }, // poll 1
      { status: 'queued' }, // poll 2
      { status: 'matched', match: MATCH }, // poll 3
    ]);
    const info = await findMatch('http://mm', { playerCount: 2, fetch, sleep: noSleep });
    expect(info).toEqual(MATCH);
    expect(fetch).toHaveBeenCalledTimes(4);
    // The polls hit the queue-scoped URL.
    expect((fetch.mock.calls[1]![0] as string)).toBe('http://mm/find/q1');
  });

  it('rejects when the server expires the request', async () => {
    const fetch = fakeFetch([{ queueId: 'q1' }, { status: 'expired' }]);
    await expect(findMatch('http://mm', { playerCount: 2, fetch, sleep: noSleep })).rejects.toThrow(/expired/);
  });

  it('rejects on a service error body', async () => {
    const fetch = vi.fn(async () => ({ ok: false, status: 400, json: async () => ({ error: 'playerCount must be an integer in [1, 8]' }) } as Response));
    await expect(findMatch('http://mm', { playerCount: 99, fetch, sleep: noSleep })).rejects.toThrow(/playerCount/);
  });

  it('times out after the budget while stuck queued', async () => {
    const fetch = fakeFetch([{ queueId: 'q1' }, { status: 'queued' }]);
    await expect(
      findMatch('http://mm', { playerCount: 2, fetch, sleep: noSleep, pollIntervalMs: 100, timeoutMs: 250 }),
    ).rejects.toThrow(/timed out/);
    // POST + ceil(250/100)=3 polls before the budget is spent.
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it('honours a cancel signal', async () => {
    const signal = { cancelled: true };
    const fetch = fakeFetch([{ queueId: 'q1' }]);
    await expect(
      findMatch('http://mm', { playerCount: 2, fetch, sleep: noSleep, signal }),
    ).rejects.toThrow(/cancelled/);
  });

  it('sends mode in the /find body — defaulting to coop, and passing pvp through explicitly (design/15)', async () => {
    const fetch = fakeFetch([{ queueId: 'q1', match: MATCH }]);
    await findMatch('http://mm', { playerCount: 2, fetch, sleep: noSleep });
    const [, initDefault] = fetch.mock.calls[0]!;
    expect(JSON.parse((initDefault as RequestInit).body as string)).toMatchObject({ mode: 'coop' });

    const fetch2 = fakeFetch([{ queueId: 'q2', match: MATCH }]);
    await findMatch('http://mm', { playerCount: 8, mode: 'pvp', fetch: fetch2, sleep: noSleep });
    const [, initPvp] = fetch2.mock.calls[0]!;
    expect(JSON.parse((initPvp as RequestInit).body as string)).toMatchObject({ playerCount: 8, mode: 'pvp' });
  });

  it('sends partyId in the /find body when queueing with a pre-formed party (design/05/15)', async () => {
    const fetch = fakeFetch([{ queueId: 'q1', match: MATCH }]);
    await findMatch('http://mm', { playerCount: 8, mode: 'pvp', partyId: 'party-123', fetch, sleep: noSleep });
    const [, init] = fetch.mock.calls[0]!;
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({ partyId: 'party-123' });
  });

  it('omits partyId entirely for a plain solo queue (no behavior change for existing callers)', async () => {
    const fetch = fakeFetch([{ queueId: 'q1', match: MATCH }]);
    await findMatch('http://mm', { playerCount: 2, fetch, sleep: noSleep });
    const [, init] = fetch.mock.calls[0]!;
    expect(JSON.parse((init as RequestInit).body as string)).not.toHaveProperty('partyId');
  });
});

/**
 * Who this seat says it is (design/16-accounts.md hole 3, 2026-09-17).
 *
 * The identity moved from the BODY to an `Authorization` header, and these cases pin both
 * halves of that move rather than only the new one. The body assertion is the important one:
 * a request that still carried `accountId` would still be accepted by an older matchsvc, so
 * "the header is present" on its own would not prove the claim was gone.
 */
describe('findMatch identity', () => {
  afterEach(() => resetSessionCacheForTests());

  const headersOf = (fetch: ReturnType<typeof fakeFetch>): Record<string, string> =>
    ((fetch.mock.calls[0]![1] as RequestInit).headers ?? {}) as Record<string, string>;
  const bodyOf = (fetch: ReturnType<typeof fakeFetch>): Record<string, unknown> =>
    JSON.parse((fetch.mock.calls[0]![1] as RequestInit).body as string) as Record<string, unknown>;

  it('sends the stored session as a bearer token, and NO accountId in the body', async () => {
    setSession({ accountId: 'acct-1', username: 'ada', token: 'sess-tok' }, fakeStore());
    const fetch = fakeFetch([{ queueId: 'q1', match: MATCH }]);
    await findMatch('http://mm', { playerCount: 2, fetch, sleep: noSleep });
    expect(headersOf(fetch).authorization).toBe('Bearer sess-tok');
    expect(bodyOf(fetch)).not.toHaveProperty('accountId');
  });

  it('sends NO authorization header at all for a guest, and still no accountId', async () => {
    setSession(null, fakeStore());
    const fetch = fakeFetch([{ queueId: 'q1', match: MATCH }]);
    await findMatch('http://mm', { playerCount: 2, fetch, sleep: noSleep });
    expect(headersOf(fetch)).not.toHaveProperty('authorization');
    // The regression this file exists to catch: the guest's local id used to travel here,
    // and matchsvc scored the match under it. A guest now carries no identity whatsoever.
    expect(bodyOf(fetch)).not.toHaveProperty('accountId');
    expect(bodyOf(fetch)).toEqual({ playerCount: 2, mode: 'coop' });
  });

  it('lets an explicit empty token queue as a guest even while a session is stored', async () => {
    // An omitted field falls back to the session; an explicit '' is a caller SAYING guest.
    // Two different requests, which is why this is not `opts.token ?? getSession()?.token`.
    setSession({ accountId: 'acct-1', username: 'ada', token: 'sess-tok' }, fakeStore());
    const fetch = fakeFetch([{ queueId: 'q1', match: MATCH }]);
    await findMatch('http://mm', { playerCount: 2, token: '', fetch, sleep: noSleep });
    expect(headersOf(fetch)).not.toHaveProperty('authorization');
  });

  it('prefers an explicitly passed token over the stored session', async () => {
    setSession({ accountId: 'acct-1', username: 'ada', token: 'stored' }, fakeStore());
    const fetch = fakeFetch([{ queueId: 'q1', match: MATCH }]);
    await findMatch('http://mm', { playerCount: 2, token: 'explicit', fetch, sleep: noSleep });
    expect(headersOf(fetch).authorization).toBe('Bearer explicit');
  });
});

describe('requestResume (ROADMAP reconnect, design/06)', () => {
  it('POSTs the expired-but-signed token and resolves with the freshly-reissued match', async () => {
    const RESUMED = { ...MATCH, token: 'tok2' };
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ({ ok: true, status: 200, json: async () => ({ match: RESUMED }) }) as unknown as Response);
    const info = await requestResume('http://mm', 'stale-tok', { fetch });
    expect(info).toEqual(RESUMED);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('http://mm/resume');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ token: 'stale-tok' });
  });

  it('rejects with the server error message on a 401 (bad signature)', async () => {
    const fetch = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({ error: 'invalid ticket' }) }) as unknown as Response);
    await expect(requestResume('http://mm', 'forged', { fetch })).rejects.toThrow(/invalid ticket/);
  });

  it('rejects with a generic message when the error body itself is unparseable', async () => {
    const fetch = vi.fn(async () => ({ ok: false, status: 500, json: async () => { throw new Error('not json'); } }) as unknown as Response);
    await expect(requestResume('http://mm', 'tok', { fetch })).rejects.toThrow(/resume/);
  });
});
