/**
 * Matchmaker queue/grouping (ROADMAP 3.3). Drives the pure core with injected fakes (a
 * hand-advanced clock, a deterministic seed/roomId source, and the real ticket signer) —
 * every branch of enqueue → group formation → poll → expiry is exercised without a
 * network. The ticket's own rejection surface lives in ticket.test.ts; here we assert
 * the tickets a formed group hands out are internally consistent and verifiable.
 */
import { describe, it, expect } from 'vitest';
import { Matchmaker, MAX_PLAYERS, type MatchmakerDeps } from '../src/Matchmaker';
import { signTicket, verifyTicket } from '../src/ticket';

const SECRET = 'mm-secret';

function make(overrides: Partial<MatchmakerDeps> = {}) {
  let now = 1_000;
  let seedN = 100;
  let roomN = 0;
  const deps: MatchmakerDeps = {
    nowMs: () => now,
    nextSeed: () => ++seedN,
    newRoomId: () => `room-${++roomN}`,
    sign: (p) => signTicket(p, SECRET),
    ...overrides,
  };
  const mm = new Matchmaker(deps);
  return { mm, advance: (ms: number) => (now += ms), at: () => now };
}

describe('Matchmaker — grouping', () => {
  it('keeps a partial queue waiting and forms a room only when the seat count is met', () => {
    const { mm } = make();
    const a = mm.enqueue(2);
    expect(a.ticket).toBeUndefined(); // first of two — still waiting
    expect(mm.poll(a.queueId)).toEqual({ status: 'queued', botFillInMs: 5_000 });
    expect(mm.waiting(2)).toBe(1);

    const b = mm.enqueue(2);
    expect(b.ticket).toBeDefined(); // arrival that completes the group gets it inline
    expect(mm.waiting(2)).toBe(0);

    // The first waiter now polls `matched`.
    const polled = mm.poll(a.queueId);
    expect(polled.status).toBe('matched');
  });

  it('assigns one shared seed/room and distinct owners 0..N-1', () => {
    const { mm } = make();
    const ids = [mm.enqueue(3), mm.enqueue(3), mm.enqueue(3)];
    const tickets = ids.map((r) => (r.ticket ?? (mm.poll(r.queueId) as { ticket: any }).ticket));

    const rooms = new Set(tickets.map((t) => t.roomId));
    const seeds = new Set(tickets.map((t) => t.seed));
    expect(rooms.size).toBe(1); // one room
    expect(seeds.size).toBe(1); // one shared seed
    expect(tickets.map((t) => t.owner).sort()).toEqual([0, 1, 2]); // distinct seats
    expect(tickets.every((t) => t.playerCount === 3)).toBe(true);
  });

  it('issues tickets that verify against the same secret and carry the seat grant', () => {
    const { mm, at } = make();
    mm.enqueue(2);
    const b = mm.enqueue(2);
    const payload = verifyTicket(b.ticket!.token, SECRET, at());
    expect(payload).not.toBeNull();
    expect(payload).toMatchObject({ roomId: b.ticket!.roomId, owner: b.ticket!.owner, seed: b.ticket!.seed, playerCount: 2 });
  });

  it('carries a logged-in accountId into the signed ticket (design/16-accounts.md)', () => {
    const { mm, at } = make();
    mm.enqueue(2, 'coop', undefined, 'acct-alice');
    const b = mm.enqueue(2, 'coop', undefined, 'acct-bob');
    const payload = verifyTicket(b.ticket!.token, SECRET, at());
    expect(payload?.accountId).toBe('acct-bob');
  });

  it('omits accountId from the ticket for a guest caller (no behavior change for existing callers)', () => {
    const { mm, at } = make();
    mm.enqueue(2);
    const b = mm.enqueue(2);
    const payload = verifyTicket(b.ticket!.token, SECRET, at());
    expect(payload?.accountId).toBeUndefined();
  });

  it('forms back-to-back groups from a burst (4 → two 2-seat rooms)', () => {
    const { mm } = make();
    const r = [mm.enqueue(2), mm.enqueue(2), mm.enqueue(2), mm.enqueue(2)];
    const rooms = r.map((x) => (x.ticket ?? (mm.poll(x.queueId) as { ticket: any }).ticket).roomId);
    expect(new Set(rooms).size).toBe(2); // two distinct rooms, two per room
  });

  it('handles a 1-seat request by matching immediately', () => {
    const { mm } = make();
    const a = mm.enqueue(1);
    expect(a.ticket).toBeDefined();
    expect(a.ticket!.owner).toBe(0);
  });

  it('does not cross modes — a 2-seat and a 3-seat waiter never group', () => {
    const { mm } = make();
    const a = mm.enqueue(2);
    const b = mm.enqueue(3);
    expect(a.ticket).toBeUndefined();
    expect(b.ticket).toBeUndefined();
    expect(mm.waiting(2)).toBe(1);
    expect(mm.waiting(3)).toBe(1);
  });

  it('does not cross game modes — a coop 2-seat and a pvp 2-seat waiter never group (design/15)', () => {
    const { mm } = make();
    const coop = mm.enqueue(2); // default mode
    const pvp = mm.enqueue(2, 'pvp');
    expect(coop.ticket).toBeUndefined();
    expect(pvp.ticket).toBeUndefined();
    expect(mm.waiting(2)).toBe(1); // coop queue
    expect(mm.waiting(2, 'pvp')).toBe(1); // separate pvp queue

    const coop2 = mm.enqueue(2);
    expect(coop2.ticket).toBeDefined(); // pairs with the coop waiter, not the pvp one
    expect(mm.waiting(2, 'pvp')).toBe(1); // pvp waiter untouched
  });

  it('tags every ticket in a group with the requested mode, defaulting to coop', () => {
    const { mm } = make();
    const a = mm.enqueue(2); // no mode → coop
    const b = mm.enqueue(2);
    const ticketA = a.ticket ?? (mm.poll(a.queueId) as { ticket: any }).ticket;
    expect(ticketA.mode).toBe('coop');
    expect(b.ticket!.mode).toBe('coop');

    const c = mm.enqueue(3, 'pvp');
    mm.enqueue(3, 'pvp');
    const e = mm.enqueue(3, 'pvp');
    expect(e.ticket!.mode).toBe('pvp');
    const ticketC = c.ticket ?? (mm.poll(c.queueId) as { ticket: any }).ticket;
    expect(ticketC.mode).toBe('pvp');
  });
});

describe('Matchmaker — expiry & validation', () => {
  // Every test here has to DISABLE the backfill to reach expiry at all, which is the point
  // of the change it documents: since 2026-09-17 both modes bot-fill long before the TTL,
  // so in the shipped configuration a waiter never expires. `queueTtlMs` is still the rule
  // that decides — it is just now reached only where an operator has put a backfill delay
  // above it, which is exactly what `noBackfill` spells.
  const noBackfill = { pvpBotFillMs: 10 ** 9, coopBotFillMs: 10 ** 9 };

  it('reports a stale waiter as expired and drops it from the queue', () => {
    const { mm, advance } = make(noBackfill);
    const a = mm.enqueue(2);
    advance(30_001); // past the default 30 s queue TTL
    expect(mm.poll(a.queueId)).toEqual({ status: 'expired' });
    expect(mm.waiting(2)).toBe(0); // reaped

    // A fresh partner after the expiry does NOT match the dead waiter.
    const b = mm.enqueue(2);
    expect(b.ticket).toBeUndefined();
  });

  it('an expired waiter is not counted toward a new group', () => {
    const { mm, advance } = make(noBackfill);
    mm.enqueue(2); // will go stale
    advance(30_001);
    const b = mm.enqueue(2); // should NOT pair with the stale one
    expect(b.ticket).toBeUndefined();
    expect(mm.waiting(2)).toBe(1);
  });

  it('reaps an ABANDONED waiter by age even in a mode that bot-fills', () => {
    // The hazard the `liveQueue` age sweep exists for, and the reason it could not simply
    // be switched off once every mode gained a backfill: a client that closed the tab stops
    // polling but leaves its queue entry behind. Left in place it would be seated into the
    // next room formed for that shape — a room that then never starts, because nobody is
    // coming to sit in that seat. Note this is asserted for PvP, which before 2026-09-17
    // was never age-reaped at all.
    const { mm, advance } = make({ pvpBotFillMs: 10 ** 9 }); // backfill out of reach
    mm.enqueue(2, 'pvp'); // enqueued, then abandoned — never polled again
    advance(30_001);
    const b = mm.enqueue(2, 'pvp');
    expect(b.ticket).toBeUndefined(); // did NOT pair with the ghost
    expect(mm.waiting(2, 'pvp')).toBe(1);
  });

  it('never reaps the waiter whose own poll is forming the room', () => {
    // The race `liveQueue`'s `keepId` exists for: this waiter is past the TTL *and* past its
    // backfill point, so the age sweep `formWithBots` runs internally would otherwise drop
    // the very player who just earned a room and hand them `expired` instead. Control: the
    // old `mode !== 'pvp'` guard passed this for PvP by never sweeping, and would fail it
    // outright for coop.
    const { mm, advance } = make({ queueTtlMs: 1_000, coopBotFillMs: 100 });
    const a = mm.enqueue(2);
    advance(5_000); // past BOTH thresholds — backfill (100 ms) and TTL (1 s)
    const polled = mm.poll(a.queueId);
    expect(polled.status).toBe('matched');
    expect(polled).toHaveProperty('ticket.owner', 0);
  });

  it('poll of an unknown/collected queueId is expired', () => {
    const { mm } = make();
    expect(mm.poll('nope')).toEqual({ status: 'expired' });
    mm.enqueue(2);
    const b = mm.enqueue(2);
    mm.poll(b.queueId); // collect (was inline too, but poll drops it)
    expect(mm.poll(b.queueId)).toEqual({ status: 'expired' }); // one-shot
  });

  it('rejects an out-of-bounds playerCount', () => {
    const { mm } = make();
    expect(() => mm.enqueue(0)).toThrow(RangeError);
    expect(() => mm.enqueue(MAX_PLAYERS + 1)).toThrow(RangeError);
    expect(() => mm.enqueue(1.5)).toThrow(RangeError);
  });
});

describe('Matchmaker — PvP practice-bot backfill (design/15 follow-up)', () => {
  it('forms the group with bots after pvpBotFillMs, and keys the delay off the MODE', () => {
    const botFills: { roomId: string; botOwners: readonly number[] }[] = [];
    // The two delays are separate names for a reason (see MatchmakerDeps.coopBotFillMs), so
    // pin them apart here: a coop waiter enqueued at the same instant, for the same shape,
    // must still be sitting at 30 s because ITS delay is the one that applies to it. This
    // replaces an assertion that coop stays queued FOREVER — which is what it did before
    // 2026-09-17, and which design/10's audit called the dead door.
    const { mm, advance } = make({ pvpBotFillMs: 30_000, coopBotFillMs: 120_000, onBotFill: (info) => botFills.push(info) });

    const a = mm.enqueue(4, 'pvp'); // wants a 4-seat PvP match, alone
    const coop = mm.enqueue(4); // same shape, same instant, longer delay

    advance(30_000); // exactly at this test's pvpBotFillMs
    const polledPvp = mm.poll(a.queueId);
    expect(polledPvp.status).toBe('matched');
    expect(polledPvp).toHaveProperty('ticket.owner', 0);
    expect(botFills).toEqual([{ roomId: (polledPvp as { ticket: { roomId: string } }).ticket.roomId, seed: expect.any(Number), playerCount: 4, mode: 'pvp', botOwners: [1, 2, 3] }]);

    // The coop waiter is untouched: its own delay has not come round yet.
    expect(mm.poll(coop.queueId)).toEqual({ status: 'queued', botFillInMs: 90_000 });
    expect(botFills).toHaveLength(1);
  });

  it('includes every real waiter still queued for the shape, bot-filling only the remainder', () => {
    const botFills: { botOwners: readonly number[] }[] = [];
    const { mm, advance } = make({ onBotFill: (info) => botFills.push(info) });

    const a = mm.enqueue(4, 'pvp');
    advance(10_000);
    const b = mm.enqueue(4, 'pvp'); // joins the same shape partway through a's wait
    advance(20_001); // a is now past 30s; b has only waited ~20s

    const polledA = mm.poll(a.queueId);
    expect(polledA.status).toBe('matched');
    expect((polledA as { ticket: { owner: number } }).ticket.owner).toBe(0);
    // b was swept into the SAME group instead of bot-filled — it gets a real seat too.
    const polledB = mm.poll(b.queueId);
    expect(polledB.status).toBe('matched');
    expect((polledB as { ticket: { owner: number } }).ticket.owner).toBe(1);
    expect(botFills).toEqual([expect.objectContaining({ botOwners: [2, 3] })]);
  });

  it('never bot-fills once the shape is already full (formIfReady wins first)', () => {
    const botFills: unknown[] = [];
    const { mm, advance } = make({ onBotFill: (info) => botFills.push(info) });
    const seats = [mm.enqueue(2, 'pvp'), mm.enqueue(2, 'pvp')];
    expect(seats.some((r) => r.ticket)).toBe(true); // already matched instantly, full group
    advance(30_001);
    for (const r of seats) {
      if (!r.ticket) mm.poll(r.queueId);
    }
    expect(botFills).toEqual([]); // nothing left waiting to ever trigger it
  });

  it('a lone PvP waiter still bot-fills all the way down to a 1-real-seat match', () => {
    const botFills: { botOwners: readonly number[] }[] = [];
    const { mm, advance } = make({ onBotFill: (info) => botFills.push(info) });
    const a = mm.enqueue(8, 'pvp');
    advance(30_000);
    const polled = mm.poll(a.queueId);
    expect(polled.status).toBe('matched');
    expect((polled as { ticket: { owner: number; playerCount: number } }).ticket).toMatchObject({ owner: 0, playerCount: 8 });
    expect(botFills).toEqual([expect.objectContaining({ botOwners: [1, 2, 3, 4, 5, 6, 7] })]);
  });

  it('is a no-op without onBotFill wired — PvP still forms the smaller room, just silently', () => {
    const { mm, advance } = make(); // no onBotFill dep at all
    const a = mm.enqueue(3, 'pvp');
    advance(30_000);
    expect(mm.poll(a.queueId).status).toBe('matched');
  });
});

/**
 * Co-op ally backfill (design/10's front-door audit, 2026-09-17). The same mechanism as the
 * block above, and these tests are deliberately near-copies of it — the feature IS "PvP's
 * backfill, for the other mode", and a reader comparing the two should find nothing that
 * differs except the mode and which delay applies.
 *
 * What it fixed: `poll` gated the backfill on `waiter.mode === 'pvp'`, so a solo player who
 * tapped CO-OP with nobody else online sat until `queueTtlMs` and was told the request had
 * expired — while the same game already ships an AI ally for that seat and drives it locally
 * behind `?coop=1`. A route that cannot be walked, past content that exists.
 */
describe('Matchmaker — co-op ally backfill (design/10 front-door audit)', () => {
  it('forms the 2-seat co-op room with one ally after coopBotFillMs', () => {
    const botFills: unknown[] = [];
    const { mm, advance } = make({ onBotFill: (info) => botFills.push(info) });

    const a = mm.enqueue(2); // the lobby's CO-OP button: playerCount 2, mode 'coop'
    expect(mm.poll(a.queueId)).toEqual({ status: 'queued', botFillInMs: 5_000 }); // nothing yet at t=0

    advance(5_000); // the default coopBotFillMs
    const polled = mm.poll(a.queueId);
    expect(polled.status).toBe('matched');
    expect(polled).toHaveProperty('ticket.owner', 0); // the human keeps seat 0
    expect(polled).toHaveProperty('ticket.mode', 'coop');
    expect(botFills).toEqual([{
      roomId: (polled as { ticket: { roomId: string } }).ticket.roomId,
      seed: expect.any(Number),
      playerCount: 2,
      mode: 'coop',
      // Exactly ONE seat, and seat 1 — `BotClient.brainFor` hands the ally
      // `LEADER_SEAT` (0) to regroup on, which is only sound while the bots take the
      // trailing indices. This is the assertion that keeps that true.
      botOwners: [1],
    }]);
  });

  it('a real partner arriving inside the delay still gets the human match', () => {
    // The backfill must not cost co-op the thing it is for. The delay is short, not zero:
    // two players who tap CO-OP within it are paired with each other, and no bot is minted.
    const botFills: unknown[] = [];
    const { mm, advance } = make({ onBotFill: (info) => botFills.push(info) });

    const a = mm.enqueue(2);
    advance(4_000); // still inside the 5 s window
    const b = mm.enqueue(2);

    expect(b.ticket).toBeDefined(); // the arrival completed the group inline
    expect(mm.poll(a.queueId)).toHaveProperty('ticket.owner', 0);
    expect(b.ticket!.owner).toBe(1);
    expect(botFills).toEqual([]); // no ally was minted — the seat went to a person
  });

  it('bot-fills a larger co-op shape down to a single real seat', () => {
    // `playerCount` is 2 for every route the lobby offers today, but `enqueue` accepts any
    // shape and this one must not have a special case hiding in it.
    const botFills: { botOwners: readonly number[]; mode: string }[] = [];
    const { mm, advance } = make({ onBotFill: (info) => botFills.push(info) });
    const a = mm.enqueue(4);
    advance(5_000);
    expect(mm.poll(a.queueId).status).toBe('matched');
    expect(botFills).toEqual([expect.objectContaining({ mode: 'coop', botOwners: [1, 2, 3] })]);
  });

  it('keeps coop and pvp queues of the SAME shape apart when both bot-fill', () => {
    // `queueKey` is (mode, playerCount), and the backfill runs per shape — so two lone
    // waiters, one per mode, must produce two rooms, not one room with a stranger's mode on
    // the ticket. Before co-op bot-filled at all, only one of these two could reach
    // `formWithBots`, so nothing was ever asserted about the pair.
    const botFills: { roomId: string; mode: string }[] = [];
    const { mm, advance } = make({ onBotFill: (info) => botFills.push(info) });
    const coop = mm.enqueue(2);
    const pvp = mm.enqueue(2, 'pvp');

    advance(5_000);
    const polledCoop = mm.poll(coop.queueId);
    const polledPvp = mm.poll(pvp.queueId);
    expect(polledCoop).toHaveProperty('ticket.mode', 'coop');
    expect(polledPvp).toHaveProperty('ticket.mode', 'pvp');
    expect((polledCoop as { ticket: { roomId: string } }).ticket.roomId)
      .not.toBe((polledPvp as { ticket: { roomId: string } }).ticket.roomId);
    expect(botFills.map((f) => f.mode).sort()).toEqual(['coop', 'pvp']);
  });

  it('carries the account and name of the real seat into a bot-filled co-op ticket', () => {
    // The backfill path grants through the same `grantGroup` a full group does, so nothing
    // a logged-in player brings to the queue may be dropped just because the room filled
    // out with an ally (design/16 rating attribution, design/20 nameplates).
    const { mm, advance, at } = make();
    const a = mm.enqueue(2, 'coop', undefined, 'acct-alice', 'Alice');
    advance(5_000);
    const polled = mm.poll(a.queueId) as { status: string; ticket: { token: string } };
    expect(polled.status).toBe('matched');
    expect(verifyTicket(polled.ticket.token, SECRET, at())).toMatchObject({
      accountId: 'acct-alice',
      name: 'Alice',
      mode: 'coop',
    });
  });

  it('honours a LIVE coopBotFillMs — the flag is read per poll, not captured', () => {
    // `match.coopBotBackfillDelayMs` is a flag (design/21 §4), which means an operator's
    // edit has to take effect in the running process. A value captured in the constructor
    // would pass every test above and be a differently-spelled deploy in production.
    let delay = 60_000;
    const { mm, advance } = make({ coopBotFillMs: () => delay });
    const a = mm.enqueue(2);
    advance(10_000);
    expect(mm.poll(a.queueId)).toEqual({ status: 'queued', botFillInMs: 50_000 }); // 10 s < 60 s

    delay = 5_000; // operator lowers it mid-wait
    expect(mm.poll(a.queueId).status).toBe('matched'); // the SAME waiter, no re-enqueue
  });

  it('lets an operator put expiry back in front by raising the delay above the TTL', () => {
    // `poll` checks the backfill before the expiry, so the two thresholds' ORDER is the
    // whole rule. This is the configuration in which a co-op queue still expires — stated
    // in `MatchmakerDeps.queueTtlMs`, and worth pinning because it is the only remaining way
    // to reach that branch.
    const { mm, advance } = make({ queueTtlMs: 2_000, coopBotFillMs: 30_000 });
    const a = mm.enqueue(2);
    advance(2_001);
    expect(mm.poll(a.queueId)).toEqual({ status: 'expired' });
  });

  it('is a no-op without onBotFill wired — co-op still forms the smaller room, just silently', () => {
    // The pre-4.x caller shape, mirrored from the PvP block: `onBotFill` is what SPAWNS the
    // ally, so without it the room forms with an empty seat rather than not forming.
    const { mm, advance } = make(); // no onBotFill dep at all
    const a = mm.enqueue(2);
    advance(5_000);
    expect(mm.poll(a.queueId).status).toBe('matched');
  });
});

describe('Matchmaker — squads (design/05/15 PvP squad follow-up)', () => {
  function ticketOf(mm: Matchmaker, r: { queueId: string; ticket?: any }) {
    return r.ticket ?? (mm.poll(r.queueId) as { ticket: any }).ticket;
  }

  it('an 8-seat match with no parties splits into two 4-seat squads by pure seat order', () => {
    const { mm } = make();
    const rs = Array.from({ length: 8 }, () => mm.enqueue(8, 'pvp'));
    const tickets = rs.map((r) => ticketOf(mm, r));
    const teamIds = tickets.map((t) => t.teamId).sort((a, b) => a - b);
    expect(teamIds).toEqual([0, 0, 0, 0, 1, 1, 1, 1]);
    // owners 0-3 share team 0, owners 4-7 share team 1.
    for (const t of tickets) expect(t.teamId).toBe(Math.floor(t.owner / 4));
  });

  it('a playerCount not divisible by SQUAD_SIZE falls back to one-seat squads (today\'s exact FFA)', () => {
    const { mm } = make();
    const rs = [mm.enqueue(3, 'pvp'), mm.enqueue(3, 'pvp'), mm.enqueue(3, 'pvp')];
    const tickets = rs.map((r) => ticketOf(mm, r));
    expect(tickets.map((t) => t.teamId).sort()).toEqual([0, 1, 2]); // every seat its own squad
  });

  it('a pre-formed party lands in one squad chunk regardless of queue interleaving', () => {
    const { mm } = make();
    // Interleave: solo, party-member, solo, party-member (party = groupId 'g1').
    const solo1 = mm.enqueue(8, 'pvp');
    const party1 = mm.enqueue(8, 'pvp', 'g1');
    const solo2 = mm.enqueue(8, 'pvp');
    const party2 = mm.enqueue(8, 'pvp', 'g1');
    const solo3 = mm.enqueue(8, 'pvp');
    const solo4 = mm.enqueue(8, 'pvp');
    const solo5 = mm.enqueue(8, 'pvp');
    const solo6 = mm.enqueue(8, 'pvp');

    // Collect every ticket exactly once — poll() is one-shot, a second poll of an
    // already-collected queueId returns `expired`, not the ticket again.
    const tickets = [solo1, party1, solo2, party2, solo3, solo4, solo5, solo6].map((r) => ticketOf(mm, r));
    const [, tp1, , tp2] = tickets;
    expect(tp1.teamId).toBe(tp2.teamId); // both party members share one squad
    expect(Math.floor(tp1.owner / 4)).toBe(tp1.teamId);

    // Every solo waiter still got a real seat somewhere.
    const allOwners = tickets.map((t) => t.owner).sort((a, b) => a - b);
    expect(allOwners).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('an undersized party (2 of 4) gets padded by solo waiters into the same squad', () => {
    const { mm } = make();
    const p1 = mm.enqueue(8, 'pvp', 'party');
    const p2 = mm.enqueue(8, 'pvp', 'party');
    const solos = Array.from({ length: 6 }, () => mm.enqueue(8, 'pvp'));

    const t1 = ticketOf(mm, p1);
    const t2 = ticketOf(mm, p2);
    expect(t1.teamId).toBe(t2.teamId);
    // Exactly 2 solo waiters share that same squad (padding it to 4), the rest land elsewhere.
    const sharedTeam = t1.teamId;
    const soloTeams = solos.map((r) => ticketOf(mm, r).teamId);
    expect(soloTeams.filter((tid) => tid === sharedTeam)).toHaveLength(2);
  });

  it('a party larger than SQUAD_SIZE is not silently accepted as one seat — PartyService already caps it, but Matchmaker itself truncates a chunk at squadSize and carries the rest into the next chunk', () => {
    const { mm } = make();
    // 5 waiters sharing one groupId in an 8-seat/4-squad match — the 5th cannot fit
    // its party's own chunk and must start a new one instead of being dropped.
    const rs = Array.from({ length: 5 }, () => mm.enqueue(8, 'pvp', 'oversized'));
    const solos = Array.from({ length: 3 }, () => mm.enqueue(8, 'pvp'));
    const tickets = [...rs, ...solos].map((r) => ticketOf(mm, r));
    expect(tickets).toHaveLength(8);
    const owners = tickets.map((t) => t.owner).sort((a, b) => a - b);
    expect(owners).toEqual([0, 1, 2, 3, 4, 5, 6, 7]); // every seat filled, nobody dropped
  });

  it('PvP bot-fill assigns bots the teamId of the squad chunk their seat falls into', () => {
    const botFills: { botOwners: readonly number[] }[] = [];
    const { mm, advance } = make({ onBotFill: (info) => botFills.push(info) });
    // A 2-person party queues for an 8-seat match, alone — bots must fill the other 6
    // seats, completing this party's own squad (owners 2,3) before opening fresh ones.
    mm.enqueue(8, 'pvp', 'party');
    const p2 = mm.enqueue(8, 'pvp', 'party');
    advance(30_000);
    const t2 = (mm.poll(p2.queueId) as { ticket: any }).ticket;
    expect(t2.owner).toBeLessThan(4); // still seated in squad 0
    expect(botFills).toEqual([expect.objectContaining({ botOwners: [2, 3, 4, 5, 6, 7] })]);
  });

  it('coop (no mode/squad concept exercised) still gets a teamId per seat — solo FFA-shaped by default', () => {
    const { mm } = make();
    const a = mm.enqueue(2);
    const b = mm.enqueue(2);
    const ta = ticketOf(mm, a);
    const tb = ticketOf(mm, b);
    expect(ta.teamId).toBe(0);
    expect(tb.teamId).toBe(1); // playerCount=2 doesn't divide by SQUAD_SIZE=4 → 1-seat squads
  });
});

describe('Matchmaker — the arms a well-formed queue never reaches', () => {
  it('works with NO signer injected, handing back empty tokens', () => {
    // `deps.sign ?? (() => '')`. The documented shape for a test that only asserts grouping —
    // and if the fallback were dropped, every such caller would throw on `this.sign(grant)`
    // instead of getting a ticket with an empty token.
    const { mm } = make({ sign: undefined });
    const a = mm.enqueue(1);
    expect(a.ticket).toBeTruthy();
    expect(a.ticket!.token).toBe('');
    expect(a.ticket!.roomId).toBe('room-1');
  });

  it('skips an already-matched waiter when scanning the queue', () => {
    // The `!w || w.ticket` continue. A matched waiter stays in the queue array until it is
    // polled, so the live-queue scan has to step over it — otherwise a seat that already has
    // a ticket would be counted again and could be granted a SECOND room.
    const { mm } = make();
    const a = mm.enqueue(2);
    const b = mm.enqueue(2);
    expect(b.ticket).toBeTruthy(); // the room formed; neither has been polled yet
    expect(mm.waiting(2)).toBe(0); // both are matched, so nobody is still waiting
    // A third arrival must start a fresh queue rather than joining the settled pair.
    const c = mm.enqueue(2);
    expect(c.ticket).toBeUndefined();
    expect(mm.poll(a.queueId).status).toBe('matched');
  });

  it('does not fire onBotFill when the group filled itself with real players', () => {
    // `botOwners.length > 0`. A queue that reached full size at the exact moment the bot-fill
    // deadline passed must form as an all-human room — spawning bots for zero empty seats
    // would put phantom sockets on a full match.
    const fills: unknown[] = [];
    const { mm } = make({ pvpBotFillMs: 10, onBotFill: (i) => void fills.push(i) });
    const a = mm.enqueue(2, 'pvp');
    const b = mm.enqueue(2, 'pvp');
    expect(b.ticket).toBeTruthy();
    expect(fills).toEqual([]);
    expect(mm.poll(a.queueId).status).toBe('matched');
  });

  it('bot-fills the empty seats when one player waits out the deadline — the control', () => {
    // Without this the three cases above would pass just as happily if onBotFill were never
    // called at all.
    const fills: Array<{ botOwners: readonly number[] }> = [];
    const { mm, advance } = make({ pvpBotFillMs: 10, onBotFill: (i) => fills.push(i) });
    const a = mm.enqueue(4, 'pvp');
    advance(50);
    expect(mm.poll(a.queueId).status).toBe('matched');
    expect(fills).toHaveLength(1);
    expect([...fills[0]!.botOwners]).toEqual([1, 2, 3]);
  });
});

/**
 * A party is matched WHOLE (2026-09-26, co-op room codes). Members POST `/find` one at a time
 * off their own party polls, so for about a second a party is partly queued. Before
 * `groupSize`, a co-op party (squad size 1) was split the moment a stranger was waiting: the
 * first member was paired with the stranger and the second member went to another room.
 */
describe('Matchmaker — whole parties', () => {
  it("never seats a stranger in a co-op party member's chair while that member is on the way", () => {
    const { mm } = make();
    const a1 = mm.enqueue(2, 'coop', 'party-A', undefined, undefined, 2);
    const stranger = mm.enqueue(2, 'coop');
    // Control: two solo waiters would have formed a room here. The party member is held back.
    expect(a1.ticket).toBeUndefined();
    expect(stranger.ticket).toBeUndefined();
    expect(mm.waiting(2, 'coop')).toBe(2);

    const a2 = mm.enqueue(2, 'coop', 'party-A', undefined, undefined, 2);
    expect(a2.ticket).toBeDefined();
    const polled = mm.poll(a1.queueId);
    expect(polled.status).toBe('matched');
    expect((polled as { ticket: { roomId: string } }).ticket.roomId).toBe(a2.ticket!.roomId);
    expect(mm.poll(stranger.queueId).status).toBe('queued'); // still waiting for its own match
  });

  it('holds a partly-queued PvP squad back even when the seat count is already met', () => {
    const { mm } = make();
    const party = [mm.enqueue(8, 'pvp', 'squad', undefined, undefined, 4), mm.enqueue(8, 'pvp', 'squad', undefined, undefined, 4)];
    const solos = Array.from({ length: 6 }, () => mm.enqueue(8, 'pvp'));
    // Eight live waiters, but only six of them may be seated — no room yet.
    expect([...party, ...solos].every((r) => r.ticket === undefined)).toBe(true);

    party.push(mm.enqueue(8, 'pvp', 'squad', undefined, undefined, 4));
    const last = mm.enqueue(8, 'pvp', 'squad', undefined, undefined, 4);
    expect(last.ticket).toBeDefined();
    const seats = party.map((r) => (mm.poll(r.queueId) as { ticket: { teamId: number; roomId: string } }).ticket);
    // All four in the SAME room and the SAME squad.
    expect(new Set([...seats.map((t) => t.roomId), last.ticket!.roomId]).size).toBe(1);
    expect(new Set([...seats.map((t) => t.teamId), last.ticket!.teamId]).size).toBe(1);
  });

  it("a stranger's backfill does not sweep up a party whose second member is one poll away", () => {
    const fills: { botOwners: readonly number[] }[] = [];
    const { mm, advance } = make({ onBotFill: (i) => fills.push(i) });
    const stranger = mm.enqueue(2, 'coop');
    advance(4_000);
    const a1 = mm.enqueue(2, 'coop', 'party-A', undefined, undefined, 2);
    advance(1_000); // the stranger's 5 s backfill point; a1 has waited 1 s

    expect(mm.poll(stranger.queueId).status).toBe('matched');
    expect(fills).toEqual([expect.objectContaining({ botOwners: [1] })]); // an ally, not a1
    expect(mm.poll(a1.queueId).status).toBe('queued');
  });

  it("plays with a bot once the party member's OWN wait passes the backfill delay", () => {
    const fills: { botOwners: readonly number[] }[] = [];
    const { mm, advance } = make({ onBotFill: (i) => fills.push(i) });
    const a1 = mm.enqueue(2, 'coop', 'party-A', undefined, undefined, 2);
    advance(4_999);
    expect(mm.poll(a1.queueId)).toEqual({ status: 'queued', botFillInMs: 1 });
    advance(1); // the friend never came
    expect(mm.poll(a1.queueId).status).toBe('matched');
    expect(fills).toEqual([expect.objectContaining({ botOwners: [1] })]);
  });

  it('pairs a friendless party member with a waiting STRANGER, not a bot, once it ages in', () => {
    const fills: unknown[] = [];
    const { mm, advance } = make({ onBotFill: (i) => fills.push(i) });
    const a1 = mm.enqueue(2, 'coop', 'party-A', undefined, undefined, 2);
    advance(1_000);
    const stranger = mm.enqueue(2, 'coop'); // held apart: a1's friend may still come
    expect(stranger.ticket).toBeUndefined();
    advance(4_000); // a1's own backfill point — the friend is not coming

    const polled = mm.poll(a1.queueId) as { ticket: { roomId: string } };
    const other = mm.poll(stranger.queueId) as { ticket: { roomId: string } };
    expect(other.ticket.roomId).toBe(polled.ticket.roomId);
    expect(fills).toEqual([]); // a full room of humans — no bot minted
  });

  it('treats a groupId with no groupSize as whole — the pre-2026-09-26 shape', () => {
    const { mm } = make();
    mm.enqueue(2, 'coop', 'party-A');
    expect(mm.enqueue(2, 'coop').ticket).toBeDefined();
  });

  it('reports the backfill countdown only while queued', () => {
    const { mm } = make({ coopBotFillMs: 7_000 });
    expect(mm.enqueue(2, 'coop').botFillInMs).toBe(7_000);
    expect(mm.enqueue(2, 'coop')).not.toHaveProperty('botFillInMs'); // matched inline
  });
});
