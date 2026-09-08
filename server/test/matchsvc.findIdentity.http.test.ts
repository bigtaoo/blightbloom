/**
 * Who a `/find` seat belongs to, over the real HTTP layer (design/20).
 *
 * This is the trust boundary that makes a display name safe to show other players. The name
 * in a match ticket is what every other client renders on its roster, so a client-declared
 * one would be an impersonation primitive — `/find` reads it from the bearer session it
 * verifies, and never from the body.
 *
 * Asserted by DECODING the signed ticket the route hands back, rather than by reading a
 * service's internals: the ticket is the artefact the gameserver trusts, and it is the only
 * place the answer actually matters.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createMatchsvcServer } from '../src/matchsvc';
import { verifyTicket } from '../src/ticket';

const SECRET = 'test-secret';

let baseUrl: string;
let close: () => Promise<void>;

beforeAll(async () => {
  const server = createMatchsvcServer({ dbPath: ':memory:', secret: SECRET });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
  close = () => new Promise<void>((resolve) => server.close(() => resolve()));
});

afterAll(async () => {
  await close();
});

async function register(username: string) {
  const res = await fetch(`${baseUrl}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: 'hunter22' }),
  });
  return (await res.json()) as { accountId: string; username: string; token: string };
}

/** A single-seat `/find`, which matches instantly and returns its own ticket inline. */
async function find(body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${baseUrl}/find`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as { match?: { token: string } };
  if (!json.match) throw new Error('no match formed');
  const payload = verifyTicket(json.match.token, SECRET, Date.now());
  if (!payload) throw new Error('the route signed a ticket that does not verify');
  return payload;
}

describe('POST /find — a logged-in caller', () => {
  it('puts the account AND name from the session into the signed ticket', async () => {
    const session = await register('ada');
    const ticket = await find({ playerCount: 1 }, { authorization: `Bearer ${session.token}` });
    expect(ticket.accountId).toBe(session.accountId);
    expect(ticket.name).toBe('ada');
  });

  it('IGNORES a body accountId that disagrees with the session', async () => {
    // The whole point of the ordering. A client that could name its own seat could name it
    // anything, including somebody else's account.
    const session = await register('grace');
    const ticket = await find(
      { playerCount: 1, accountId: 'somebody-elses-account' },
      { authorization: `Bearer ${session.token}` },
    );
    expect(ticket.accountId).toBe(session.accountId);
    expect(ticket.name).toBe('grace');
  });

  it('uses the DISPLAY name from the session, which is what /auth/me reports', async () => {
    // A federated account's login handle is `{provider}:{providerId}` and its display name
    // is the platform's username; the roster must show the second, never the first. This
    // route reads whatever `verifySession` reports, and `/auth/me` reads the same field —
    // asserting they agree is what pins the two to one answer.
    const session = await register('hopper');
    const me = await fetch(`${baseUrl}/auth/me`, { headers: { authorization: `Bearer ${session.token}` } });
    const { username } = (await me.json()) as { username: string };
    const ticket = await find({ playerCount: 1 }, { authorization: `Bearer ${session.token}` });
    expect(ticket.name).toBe(username);
  });
});

describe('POST /find — a guest', () => {
  it('keeps the body accountId and carries NO name', async () => {
    // The pre-existing behaviour, unchanged: a guest id is trusted no more than
    // `playerCount` is, and it only ever reaches `ladderReport.ts`, which falls back to its
    // own seat scaffold anyway.
    const ticket = await find({ playerCount: 1, accountId: 'guest-uuid' });
    expect(ticket.accountId).toBe('guest-uuid');
    expect(ticket.name).toBeUndefined();
  });

  it('carries neither when the body has no accountId either', async () => {
    const ticket = await find({ playerCount: 1 });
    expect(ticket.accountId).toBeUndefined();
    expect(ticket.name).toBeUndefined();
  });

  it('falls back to the body for an INVALID bearer token rather than refusing', async () => {
    // A 401 here would break a player whose 30-day session simply expired mid-session:
    // they are a guest for this match, which is a state the game fully supports.
    const ticket = await find(
      { playerCount: 1, accountId: 'guest-uuid' },
      { authorization: 'Bearer not-a-real-token' },
    );
    expect(ticket.accountId).toBe('guest-uuid');
    expect(ticket.name).toBeUndefined();
  });

  it('ignores a malformed Authorization header', async () => {
    for (const authorization of ['Basic abc', 'Bearer', 'bearer lowercase-scheme', '']) {
      const ticket = await find({ playerCount: 1, accountId: 'guest-uuid' }, { authorization });
      expect(ticket.accountId, authorization).toBe('guest-uuid');
      expect(ticket.name, authorization).toBeUndefined();
    }
  });
});
