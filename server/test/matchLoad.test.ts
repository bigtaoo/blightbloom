/**
 * The matchmaking load driver (`scripts/matchLoad.ts`) against a REAL in-process matchsvc
 * (2026-09-26, the launch-readiness pass on auto-matchmaking).
 *
 * Two questions, both about the shipped configuration rather than a tuned one:
 *
 *  1. **Does anybody get stranded?** Dozens of clients — solo co-op, solo PvP, co-op parties
 *     and squads, arriving over a couple of seconds, each party arriving in pieces the way
 *     real members do — must all end `matched`, with no room over-filled and no party split.
 *  2. **Do the per-IP budgets refuse real players?** The server runs its PRODUCTION limiters
 *     here (no `limits` override). One address per client must see no refusal at all; the
 *     shared-address case pins exactly where a single NAT starts being refused, so a change
 *     to either budget shows up as a changed number here rather than in the field.
 *
 * Only the bot-backfill delays are shortened — to 150 ms from 5 s — because they are a wait,
 * not a limit, and 5 s per round would make the suite slow without changing what is checked.
 */
import { describe, it, expect } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createMatchsvcServer } from '../src/matchsvc';
import { runMatchLoad, checkInvariants, type SeatOutcome } from '../scripts/matchLoad';
import { FIND_RATE_LIMIT } from '../src/routes/match';
import { CREATE_RATE_LIMIT } from '../src/routes/party';
import { freshAccounts } from './mongoHarness';

async function start(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createMatchsvcServer({
    store: await freshAccounts(),
    secret: 'load-secret',
    spawnBot: () => {},
    matchmaker: { coopBotFillMs: 150, pvpBotFillMs: 150 },
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) };
}

describe('matchmaking under load', () => {
  it('matches every one of ~50 mixed clients, keeps parties whole, and refuses none', async () => {
    const ctx = await start();
    try {
      const report = await runMatchLoad({
        baseUrl: ctx.url,
        plan: { coop: 15, pvp: 10, coopParties: 6, squads: 3 }, // 15 + 10 + 12 + 12 = 49 clients
        pollMs: 40,
        staggerMs: 1_500,
        timeoutMs: 10_000,
      });
      expect(report.violations).toEqual([]);
      expect(report.seats).toHaveLength(49);
      expect(report.byStatus).toEqual({ matched: 49, expired: 0, timeout: 0, refused: 0, error: 0 });
      // Control that the invariants can see a party at all: six co-op parties seated as pairs.
      const coopPartyRooms = new Set(report.seats.filter((s) => s.kind === 'coopParty').map((s) => s.roomId));
      expect(coopPartyRooms.size).toBe(6);
    } finally {
      await ctx.close();
    }
  }, 30_000);

  it('behind ONE address, the queue budget refuses exactly the entries past it', async () => {
    // A carrier-grade NAT with more players queueing inside ten minutes than the budget allows.
    // 120 per address per 10 min is the ceiling `FIND_RATE_LIMIT` argues for; the ten past it
    // are refused with a 429 and every one under it still gets a room.
    const ctx = await start();
    try {
      const over = 10;
      const report = await runMatchLoad({
        baseUrl: ctx.url,
        plan: { coop: FIND_RATE_LIMIT.requests + over, pvp: 0, coopParties: 0, squads: 0 },
        sharedIp: '203.0.113.7',
        pollMs: 40,
        staggerMs: 1_000,
        timeoutMs: 10_000,
      });
      expect(report.byStatus.refused).toBe(over);
      expect(report.byStatus.matched).toBe(FIND_RATE_LIMIT.requests);
      expect(report.seats.filter((s) => s.status === 'refused').every((s) => s.httpStatus === 429)).toBe(true);
    } finally {
      await ctx.close();
    }
  }, 30_000);

  it('behind ONE address, party creation is the tighter budget', async () => {
    // Sixty parties per address per 10 min (`CREATE_RATE_LIMIT`). Each co-op party also spends
    // two queue entries, so 64 parties from one address meet the CREATE limit first: four
    // parties (eight players) refused at the lobby, sixty seated.
    const ctx = await start();
    try {
      const over = 4;
      const report = await runMatchLoad({
        baseUrl: ctx.url,
        plan: { coop: 0, pvp: 0, coopParties: CREATE_RATE_LIMIT.requests + over, squads: 0 },
        sharedIp: '203.0.113.8',
        pollMs: 40,
        staggerMs: 1_000,
        timeoutMs: 10_000,
      });
      expect(report.byStatus.refused).toBe(over * 2);
      expect(report.byStatus.matched).toBe(CREATE_RATE_LIMIT.requests * 2);
    } finally {
      await ctx.close();
    }
  }, 30_000);
});

describe('checkInvariants', () => {
  const seat = (over: Partial<SeatOutcome>): SeatOutcome => ({
    client: 'c', unit: 'c', kind: 'coop', status: 'matched', roomId: 'r1', owner: 0, teamId: 0, playerCount: 2, waitedMs: 0, ...over,
  });

  it('passes a clean run', () => {
    expect(checkInvariants([seat({ client: 'a', owner: 0 }), seat({ client: 'b', owner: 1 })])).toEqual([]);
  });

  it('names a stranded seat, with its refusal status when there is one', () => {
    expect(checkInvariants([seat({ client: 'a', status: 'timeout', roomId: undefined })])).toEqual(['a (coop) ended timeout']);
    expect(checkInvariants([seat({ client: 'a', status: 'refused', httpStatus: 429, roomId: undefined })])).toEqual(['a (coop) ended refused 429']);
  });

  it('names a double-seated chair and an over-filled room', () => {
    const v = checkInvariants([seat({ client: 'a' }), seat({ client: 'b' }), seat({ client: 'c', owner: 1 })]);
    expect(v).toEqual(['room r1 seats two clients in one chair', 'room r1 holds 3 of 2']);
  });

  it('names a party split across rooms, and a squad split across teams', () => {
    const split = checkInvariants([
      seat({ client: 'a', unit: 'p', kind: 'coopParty', roomId: 'r1' }),
      seat({ client: 'b', unit: 'p', kind: 'coopParty', roomId: 'r2' }),
    ]);
    expect(split).toEqual(['p was split across rooms']);
    const teams = checkInvariants([
      seat({ client: 'a', unit: 's', kind: 'squad', playerCount: 8, owner: 0, teamId: 0 }),
      seat({ client: 'b', unit: 's', kind: 'squad', playerCount: 8, owner: 4, teamId: 1 }),
    ]);
    expect(teams).toEqual(['s was split across teams']);
  });

  it('does not report a party twice when a member was already reported stranded', () => {
    const v = checkInvariants([
      seat({ client: 'a', unit: 'p', kind: 'coopParty' }),
      seat({ client: 'b', unit: 'p', kind: 'coopParty', status: 'expired', roomId: undefined }),
    ]);
    expect(v).toEqual(['b (coopParty) ended expired']);
  });
});
