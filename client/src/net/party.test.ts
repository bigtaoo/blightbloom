/**
 * Client party calls (design/05/15 PvP squad follow-up). Fake-fetch driven, mirrors
 * matchmaking.test.ts's style — the server's own PartyService.test.ts owns the real
 * grouping/expiry behavior; this just pins the client's request/response shapes.
 */
import { describe, it, expect, vi } from 'vitest';
import { createParty, joinParty, leaveParty, startPartyMatching, getParty } from './party';

const PARTY = { partyId: 'p1', code: '482913', leaderId: 'alice', members: ['alice'], matching: false };

function fakeFetch(status: number, body: unknown) {
  return vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ({ ok: status < 400, status, json: async () => body }) as Response);
}

describe('party client calls', () => {
  it('createParty posts playerId and returns the PartyInfo', async () => {
    const fetch = fakeFetch(200, PARTY);
    const info = await createParty('http://mm', 'alice', { fetch });
    expect(info).toEqual(PARTY);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('http://mm/party/create');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ playerId: 'alice' });
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
    await expect(createParty('http://mm', 'alice', { fetch })).rejects.toThrow(/no room code available/);
  });

  it('rejects a non-ok response that carries no error field at all', async () => {
    // A proxy or a load balancer answering for the service sends an HTML/empty body, not the
    // route's JSON shape. The status alone has to be enough, or `!res.ok` is decorative.
    const fetch = fakeFetch(502, {});
    await expect(createParty('http://mm', 'alice', { fetch })).rejects.toThrow(/502/);
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
