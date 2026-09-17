/**
 * Who a `/find` seat belongs to, over the real HTTP layer (design/20; design/16 hole 3).
 *
 * This is the trust boundary that makes a display name safe to show other players AND a
 * ladder rating safe to record. Both travel in the match ticket: the name is what every
 * other client renders on its roster, and the accountId is what `ladderReport.ts` credits
 * when the match settles. A client-declared value in either is an impersonation primitive,
 * so `/find` reads both from the bearer session it verifies, and NEITHER from the body.
 *
 * The body half is the 2026-09-17 change, and the guest block below is where it shows. Until
 * then a body `accountId` was accepted whenever no session outranked it — and since the
 * client sent no bearer at all, that was every request in production, so anyone could post a
 * stranger's account id and move their rating. The route no longer parses the field.
 *
 * Asserted by DECODING the signed ticket the route hands back, rather than by reading a
 * service's internals: the ticket is the artefact the gameserver trusts, and it is the only
 * place the answer actually matters.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createMatchsvcServer } from '../src/matchsvc';
import { verifyTicket } from '../src/ticket';
import { buildRatingReportBody } from '../src/ladderReport';
import { freshAccounts } from './mongoHarness';

const SECRET = 'test-secret';

let baseUrl: string;
let close: () => Promise<void>;

beforeAll(async () => {
  const server = createMatchsvcServer({ store: await freshAccounts(), secret: SECRET });
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
  it('DISCARDS a body accountId rather than scoring under it (design/16 hole 3)', async () => {
    // The 2026-09-17 reversal, and the single most load-bearing assertion in this file.
    // `'victims-real-account'` is the attack in one literal: with no bearer to contradict
    // it, the old route put this string in the ticket, the gameserver copied it into
    // `seatAccounts`, and matchsvc moved that account's rating by whatever place the caller
    // arranged to finish in. An undefined accountId here is what makes that impossible.
    const ticket = await find({ playerCount: 1, accountId: 'victims-real-account' });
    expect(ticket.accountId).toBeUndefined();
    expect(ticket.name).toBeUndefined();
  });

  it('is scored by the per-match scaffold, which is what an absent accountId MEANS', async () => {
    // The other half of the same fact, asserted where a reader can see it: an undefined
    // ticket accountId is not a hole in the report, it is the instruction to key this seat
    // by `seat:{roomId}:{seatIdx}` — an identity that lasts exactly one match.
    const ticket = await find({ playerCount: 1 });
    expect(ticket.accountId).toBeUndefined();
    const { accountIds } = buildRatingReportBody(ticket.roomId, 0, [], 1, {});
    expect(accountIds).toEqual([`seat:${ticket.roomId}:0`]);
  });

  it('treats an INVALID bearer token as a guest rather than refusing', async () => {
    // A 401 here would break a player whose 30-day session simply expired mid-session:
    // they are a guest for this match, which is a state the game fully supports. What
    // changed is only what a guest gets — the scaffold, not the body's claim.
    const ticket = await find(
      { playerCount: 1, accountId: 'guest-uuid' },
      { authorization: 'Bearer not-a-real-token' },
    );
    expect(ticket.accountId).toBeUndefined();
    expect(ticket.name).toBeUndefined();
  });

  it('ignores a malformed Authorization header', async () => {
    for (const authorization of ['Basic abc', 'Bearer', 'bearer lowercase-scheme', '']) {
      const ticket = await find({ playerCount: 1, accountId: 'guest-uuid' }, { authorization });
      expect(ticket.accountId, authorization).toBeUndefined();
      expect(ticket.name, authorization).toBeUndefined();
    }
  });

  it('still gets a playable seat — nothing but the ladder key is withheld', async () => {
    // The design's own promise, pinned: design/16's "a guest is a first-class player".
    // A guest queues, matches, and is handed the same signed seat as anyone else.
    const ticket = await find({ playerCount: 1, mode: 'pvp' });
    expect(ticket.roomId).toBeTruthy();
    expect(ticket.owner).toBe(0);
    expect(ticket.playerCount).toBe(1);
    expect(ticket.mode).toBe('pvp');
  });
});
