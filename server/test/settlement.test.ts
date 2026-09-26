/**
 * `settlement.ts` — the per-seat settlement vote and the PvP bounds check (design/15, "PvP
 * integrity", decided 2026-09-26). Pure functions, so every rule is stated at its boundary:
 * the quorum edge, the strict-majority edge, the tie, and each bounds failure one field away
 * from a passing case.
 */
import { describe, expect, it } from 'vitest';
import { CHECKPOINT_QUORUM } from '@dd/engine';
import { checkPvpBounds, MIN_PVP_SETTLE_FRAME, voteSettlement, type SeatReport } from '../src/settlement';

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
