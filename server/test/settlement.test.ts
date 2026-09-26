/**
 * `settlement.ts` — the per-seat settlement vote and the PvP bounds check (design/15, "PvP
 * integrity", decided 2026-09-26). Pure functions, so every rule is stated at its boundary:
 * the quorum edge, the strict-majority edge, the tie, and each bounds failure one field away
 * from a passing case.
 */
import { describe, expect, it } from 'vitest';
import { CHECKPOINT_QUORUM } from '@dd/engine';
import {
  checkPvpBounds,
  judgeSettlement,
  MIN_PVP_SETTLE_FRAME,
  SETTLE_TIMEOUT_MS,
  voteSettlement,
  type SeatReport,
  type SettlementContext,
} from '../src/settlement';

const A: SeatReport = { hash: 0xa, winner: 0, placements: [3, 2, 1] };
const B: SeatReport = { hash: 0xb, winner: 0, placements: [3, 2, 1] };
const C: SeatReport = { hash: 0xc, winner: 1, placements: [3, 2, 0] };

/** Seat i reports `votes[i]`. */
const reports = (...votes: SeatReport[]): Map<number, SeatReport> => new Map(votes.map((v, seat) => [seat, v]));

describe('voteSettlement — at or below the quorum, unanimity', () => {
  it('pins the production quorum this file reasons about', () => {
    // Every "above/below the quorum" case below is written against 3. If the engine constant
    // moves, these cases need re-deriving rather than silently testing a different edge.
    expect(CHECKPOINT_QUORUM).toBe(3);
  });

  it('settles a unanimous room of exactly the quorum', () => {
    expect(voteSettlement(reports(A, A, A), 3)).toEqual({ agreed: A, dissenters: [] });
  });

  it('settles nothing when one seat of a quorum-sized room differs, even 2-to-1', () => {
    expect(voteSettlement(reports(A, A, B), 3)).toEqual({ agreed: null, dissenters: [] });
  });

  it('settles a unanimous two-seat room and not a split one', () => {
    expect(voteSettlement(reports(A, A), 2).agreed).toBe(A);
    expect(voteSettlement(reports(A, B), 2).agreed).toBeNull();
  });
});

describe('voteSettlement — above the quorum, a strict majority that reaches the quorum', () => {
  it('settles 3-of-4 and names the one dissenter', () => {
    expect(voteSettlement(reports(A, B, A, A), 4)).toEqual({ agreed: A, dissenters: [1] });
  });

  it('settles nothing on a 2-2 tie', () => {
    expect(voteSettlement(reports(A, A, B, B), 4)).toEqual({ agreed: null, dissenters: [] });
  });

  it('settles nothing when the biggest group is a plurality but not a majority', () => {
    // 4 of 8 agree, the rest split: 4 is at least the quorum but not more than half.
    expect(voteSettlement(reports(A, A, A, A, B, B, C, C), 8).agreed).toBeNull();
  });

  it('settles 5-of-8 and lists the three dissenters in ascending seat order', () => {
    const r = new Map<number, SeatReport>([
      [7, C], [0, A], [5, B], [1, A], [2, A], [3, A], [6, B], [4, A],
    ]);
    expect(voteSettlement(r, 8)).toEqual({ agreed: A, dissenters: [5, 6, 7] });
  });

  it('refuses a strict majority that is still under the quorum', () => {
    // Only reachable with a quorum parameter above half the room — the production quorum of 3
    // is always met by any strict majority of 4 or more. Stated so the `>= quorum` half of the
    // rule is not dead to the tests.
    expect(voteSettlement(reports(A, A, A, B, B), 5, 4).agreed).toBeNull();
    expect(voteSettlement(reports(A, A, A, A, B), 5, 4).agreed).toBe(A);
  });
});

describe('voteSettlement — what counts as the same vote', () => {
  it('splits seats that agree on the hash but not on the placements', () => {
    const swapped: SeatReport = { ...A, placements: [2, 3, 1] };
    expect(voteSettlement(reports(A, A, A, swapped), 4)).toEqual({ agreed: A, dissenters: [3] });
  });

  it('splits seats that agree on everything but the winner', () => {
    const other: SeatReport = { ...A, winner: 1 };
    expect(voteSettlement(reports(A, other, A, A), 4).dissenters).toEqual([1]);
  });

  it('tells an absent placements array from an empty one', () => {
    const none: SeatReport = { hash: 1, winner: 0 };
    const empty: SeatReport = { hash: 1, winner: 0, placements: [] };
    expect(voteSettlement(reports(none, none, none, empty), 4).dissenters).toEqual([3]);
  });

  it('settles nothing, without throwing, for an empty report set', () => {
    expect(voteSettlement(new Map(), 4)).toEqual({ agreed: null, dissenters: [] });
  });
});

describe('checkPvpBounds — solo seats', () => {
  const ok = (placements: number[], winner = 0): SeatReport => ({ hash: 1, winner, placements });

  it('passes a real 4-seat result at the duration floor', () => {
    expect(checkPvpBounds(ok([3, 2, 1]), 4, MIN_PVP_SETTLE_FRAME)).toBeNull();
    expect(checkPvpBounds(ok([0, 2, 3], 1), 4, MIN_PVP_SETTLE_FRAME)).toBeNull();
  });

  it('fails a match one frame under the floor', () => {
    expect(checkPvpBounds(ok([3, 2, 1]), 4, MIN_PVP_SETTLE_FRAME - 1)).toBe('too_short');
  });

  it.each([
    ['negative', -1],
    ['past the last seat', 4],
    ['fractional', 0.5],
    ['the co-op wipe marker', 'enemies'],
    ['null', null],
  ] as const)('fails a winner that is %s', (_label, winner) => {
    expect(checkPvpBounds({ hash: 1, winner, placements: [3, 2, 1] }, 4, 900)).toBe('winner_out_of_range');
  });

  it.each([
    ['missing', undefined],
    ['one short', [3, 2]],
    ['one long', [3, 2, 1, 0]],
    ['naming the winner', [3, 2, 0]],
    ['naming a seat twice', [3, 3, 1]],
    ['naming a seat out of range', [4, 2, 1]],
    ['carrying a fraction', [3, 2, 1.5]],
  ] as const)('fails placements that are %s', (_label, placements) => {
    expect(checkPvpBounds({ hash: 1, winner: 0, placements }, 4, 900)).toBe('placements_mismatch');
  });
});

describe('checkPvpBounds — squads (8 seats, two squads of 4)', () => {
  it('passes the lowest seat of the winning squad with the other squad as placements', () => {
    expect(checkPvpBounds({ hash: 1, winner: 0, placements: [7, 6, 5, 4] }, 8, 900)).toBeNull();
    expect(checkPvpBounds({ hash: 1, winner: 4, placements: [0, 1, 2, 3] }, 8, 900)).toBeNull();
  });

  it('fails a winner that is in the winning squad but not its representative', () => {
    expect(checkPvpBounds({ hash: 1, winner: 1, placements: [7, 6, 5, 4] }, 8, 900)).toBe('winner_not_representative');
  });

  it('fails placements that include a member of the winning squad', () => {
    expect(checkPvpBounds({ hash: 1, winner: 0, placements: [7, 6, 5, 1] }, 8, 900)).toBe('placements_mismatch');
  });
});

describe('judgeSettlement — the verdict, and the vote over the seats that reported', () => {
  const ctx = (over: Partial<SettlementContext> = {}): SettlementContext => ({
    mode: 'pvp',
    playerCount: 4,
    settleFrame: MIN_PVP_SETTLE_FRAME,
    kicked: [],
    absent: [],
    ...over,
  });
  /** Only the listed seats reported, each with the given tuple. */
  const some = (entries: [number, SeatReport][]): Map<number, SeatReport> => new Map(entries);

  it('pins the 30 s timeout the owner decided', () => {
    expect(SETTLE_TIMEOUT_MS).toBe(30_000);
  });

  it('is clean when every seat reported the same tuple', () => {
    expect(judgeSettlement(reports(A, A, A, A), ctx())).toEqual({ agreed: A, dissenters: [], bounds: null, hashOk: true, verdict: 'clean' });
  });

  it('is partial, and still rates, when the seats that reported agree and one never did', () => {
    const j = judgeSettlement(some([[0, A], [1, A], [2, A]]), ctx({ absent: [3] }));
    expect(j).toEqual({ agreed: A, dissenters: [], bounds: null, hashOk: true, verdict: 'partial' });
  });

  it('votes over the reporters only: three agreeing seats of eight settle, the five silent ones do not dilute them', () => {
    // Above the quorum by player count, but only three voters — so unanimity among them, which
    // they have. Against the full eight the same three would be a minority and settle nothing.
    const three = some([[0, A], [4, A], [5, A]]);
    expect(voteSettlement(three, 8).agreed).toBeNull();
    const j = judgeSettlement(three, ctx({ playerCount: 8, absent: [1, 2, 3, 6, 7], mode: 'coop' }));
    expect(j.agreed).toEqual(A);
    expect(j.verdict).toBe('partial');
  });

  it('settles on a lone reporter — the withholding seat cannot keep the result off the ladder', () => {
    const j = judgeSettlement(some([[0, { hash: 1, winner: 0, placements: [1] }]]), ctx({ playerCount: 2, absent: [1] }));
    expect(j.hashOk).toBe(true);
    expect(j.verdict).toBe('partial');
  });

  it('still needs the reporters to agree: two of four reporting different tuples settle nothing', () => {
    const j = judgeSettlement(some([[0, A], [1, B]]), ctx({ absent: [2, 3] }));
    expect(j).toEqual({ agreed: null, dissenters: [], bounds: null, hashOk: false, verdict: 'no_consensus' });
  });

  it('ranks dissent above partial, and a kick counts as dissent', () => {
    expect(judgeSettlement(some([[0, A], [1, A], [2, A], [3, B]]), ctx()).verdict).toBe('dissent');
    expect(judgeSettlement(some([[0, A], [1, A], [2, A], [3, B]]), ctx({ absent: [] })).dissenters).toEqual([3]);
    expect(judgeSettlement(some([[0, A], [1, A], [2, A]]), ctx({ absent: [3], kicked: [1] })).verdict).toBe('dissent');
  });

  it('ranks bounds above dissent and partial, and a failed bounds check never rates', () => {
    const j = judgeSettlement(some([[0, A], [1, A], [2, A]]), ctx({ absent: [3], kicked: [2], settleFrame: 1 }));
    expect(j).toMatchObject({ agreed: A, bounds: 'too_short', hashOk: false, verdict: 'bounds' });
  });

  it('never bounds-checks a co-op result', () => {
    const coop: SeatReport = { hash: 1, winner: null };
    const j = judgeSettlement(reports(coop, coop), ctx({ mode: 'coop', playerCount: 2, settleFrame: 0 }));
    expect(j).toEqual({ agreed: coop, dissenters: [], bounds: null, hashOk: true, verdict: 'clean' });
  });
});
