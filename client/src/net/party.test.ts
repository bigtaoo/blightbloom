/**
 * Client party calls (design/05/15 PvP squad follow-up). Fake-fetch driven, mirrors
 * matchmaking.test.ts's style — the server's own PartyService.test.ts owns the real
 * grouping/expiry behavior; this just pins the client's request/response shapes.
 */
import { describe, it, expect, vi } from 'vitest';
import { createParty, joinParty, leaveParty, startPartyMatching, getParty, PartyRequestError } from './party';

const PARTY = { partyId: 'p1', code: '482913', leaderId: 'alice', members: ['alice'], mode: 'pvp', capacity: 4, matching: false };

function fakeFetch(status: number, body: unknown) {
  return vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ({ ok: status < 400, status, json: async () => body }) as Response);
}

describe('party client calls', () => {
  it('createParty posts playerId and returns the PartyInfo', async () => {
    const fetch = fakeFetch(200, PARTY);
    const info = await createParty('http://mm', 'alice', 'pvp', { fetch });
    expect(info).toEqual(PARTY);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('http://mm/party/create');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ playerId: 'alice', mode: 'pvp' });
  });

  it('createParty sends the mode it is given, and defaults to a squad', async () => {
    const fetch = fakeFetch(200, { ...PARTY, mode: 'coop', capacity: 2 });
    await createParty('http://mm', 'alice', 'coop', { fetch });
    expect(JSON.parse((fetch.mock.calls[0]![1] as RequestInit).body as string)).toEqual({ playerId: 'alice', mode: 'coop' });
    const fetch2 = fakeFetch(200, PARTY);
    await createParty('http://mm', 'alice', undefined, { fetch: fetch2 });
    expect(JSON.parse((fetch2.mock.calls[0]![1] as RequestInit).body as string)).toMatchObject({ mode: 'pvp' });
  });

  it('joinParty posts playerId+code', async () => {
    const fetch = fakeFetch(200, { ...PARTY, members: ['alice', 'bob'] });
    const info = await joinParty('http://mm', 'bob', '482913', { fetch });
    expect(info.members).toEqual(['alice', 'bob']);
    const [, init] = fetch.mock.calls[0]!;
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ playerId: 'bob', code: '482913' });
  });

  it('rejects with the server error message on a non-ok response', async () => {
    const fetch = fakeFetch(404, { error: 'party not found or full' });
    await expect(joinParty('http://mm', 'bob', '000000', { fetch })).rejects.toThrow(/not found or full/);
  });

  it('rejects a 400 “invalid code” too, not just the 404', async () => {
    // A SECOND refusal shape since the room code became six digits (2026-09-21): the route
    // now answers 400 for a code that is not six digits, distinctly from the 404 a
    // well-formed but unknown code gets. This client must treat both as a rejection — the
    // screen's `doJoin` renders `party.invalidCode` from its catch, so a 400 that resolved
    // instead would set `this.party` to the error object and leave the lobby showing a
    // party that does not exist.
    const fetch = fakeFetch(400, { error: 'invalid code' });
    await expect(joinParty('http://mm', 'bob', '12345', { fetch })).rejects.toThrow(/invalid code/);
  });

  it('rejects a 503 from createParty rather than resolving a non-party', async () => {
    // The other new answer: `/party/create` returns 503 when the code space is momentarily
    // exhausted (`PartyService`'s `CodeSpaceExhausted`). This pins the NON-NULL ASSERTION in
    // `createParty` — it returns `(await post(...))!`, so if `post` ever resolved on a 503
    // the screen would take `undefined` as its `PartyInfo` and crash in `refresh()` reading
    // `.code` off it. A rejection is what makes that `!` honest, and nothing else says so.
    const fetch = fakeFetch(503, { error: 'no room code available' });
    await expect(createParty('http://mm', 'alice', 'pvp', { fetch })).rejects.toThrow(/no room code available/);
  });

  it('rejects a non-ok response that carries no error field at all', async () => {
    // A proxy or a load balancer answering for the service sends an HTML/empty body, not the
    // route's JSON shape. The status alone has to be enough, or `!res.ok` is decorative.
    const fetch = fakeFetch(502, {});
    await expect(createParty('http://mm', 'alice', 'pvp', { fetch })).rejects.toThrow(/502/);
  });

  it('carries the status, so the screen can tell a THROTTLED join from a wrong code', async () => {
    // `/party/join` gained a per-IP budget on 2026-09-22 and answers 429 when it is spent.
    // Every refusal used to be indistinguishable here, and `PartyScreen.doJoin` rendered
    // `party.invalidCode` for all of them — which for a 429 is both untrue and the worst
    // possible advice, since retyping the code spends more of an exhausted budget. The
    // status is what lets the screen say something else, so it is pinned at this layer.
    const fetch = fakeFetch(429, { error: 'too many join attempts from this address' });
    await expect(joinParty('http://mm', 'bob', '482913', { fetch })).rejects.toBeInstanceOf(PartyRequestError);
    const err = await joinParty('http://mm', 'bob', '482913', { fetch }).catch((e: unknown) => e);
    expect((err as PartyRequestError).status).toBe(429);
    expect((err as PartyRequestError).message).toMatch(/too many/i);
  });

  it('carries the status on the refusals that are NOT throttling', async () => {
    // The control for the case above. If `status` were hard-coded — or only set on the 429
    // path — the screen's `=== 429` test would still pass while every other refusal silently
    // became a throttle message.
    for (const status of [400, 404, 503]) {
      const err = await joinParty('http://mm', 'bob', '000000', { fetch: fakeFetch(status, { error: 'nope' }) }).catch(
        (e: unknown) => e,
      );
      expect((err as PartyRequestError).status).toBe(status);
    }
  });

  it('startPartyMatching posts partyId+playerId', async () => {
    const fetch = fakeFetch(200, { ...PARTY, matching: true });
    const info = await startPartyMatching('http://mm', 'p1', 'alice', { fetch });
    expect(info.matching).toBe(true);
  });

  it('leaveParty returns null when the server reports the party dissolved', async () => {
    const fetch = fakeFetch(200, null);
    const info = await leaveParty('http://mm', 'p1', 'alice', { fetch });
    expect(info).toBeNull();
  });

  it('getParty returns null on a 404 instead of throwing', async () => {
    const fetch = fakeFetch(404, { error: 'party not found' });
    const info = await getParty('http://mm', 'gone', { fetch });
    expect(info).toBeNull();
  });

  it('getParty returns the info on success', async () => {
    const fetch = fakeFetch(200, PARTY);
    const info = await getParty('http://mm', 'p1', { fetch });
    expect(info).toEqual(PARTY);
  });
});
