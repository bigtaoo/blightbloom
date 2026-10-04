/**
 * `fairShare.ts` — a character's PvP wins against its seat share (volume 127). The sweep's verdict
 * (the juggernaut winning 1.45x its share while raw totals read level) is this arithmetic, so each
 * rule it applies is pinned here: the share per seat, the matches left out, and the sum.
 */
import { describe, expect, it } from 'vitest';
import { countsTowardShare, fairShares, type ShareInput } from './fairShare';

const V = 'vanguard', S = 'skirmisher', J = 'juggernaut';
const match = (skins: string[], winnerSkin: string): ShareInput => ({ playerCount: skins.length, skins, winnerSkin });

describe('fairShares', () => {
  it('splits a match by seats: a character on two of four seats is owed half a win', () => {
    const share = fairShares([match([V, S, J, V], S)]);
    expect(share.get(V)).toEqual({ wins: 0, fair: 0.5 });
    expect(share.get(S)).toEqual({ wins: 1, fair: 0.25 });
    expect(share.get(J)).toEqual({ wins: 0, fair: 0.25 });
  });

  it('a character with no seat in a match is owed nothing from it', () => {
    const share = fairShares([match([V, S], V)]);
    expect(share.has(J)).toBe(false);
    // Control: give it a seat and it is owed a share.
    expect(fairShares([match([V, S, J], V)]).get(J)).toEqual({ wins: 0, fair: 1 / 3 });
  });

  it('leaves out ties and 8-seat squad matches', () => {
    const eight = [V, S, J, V, S, J, V, S];
    expect(fairShares([match([V, S, J], 'tie'), match(eight, V)]).size).toBe(0);
    expect(countsTowardShare(match(eight, V))).toBe(false);
    // Control: the same seats decided at 3 and at 6 count.
    expect(countsTowardShare(match([V, S, J], V))).toBe(true);
    expect(countsTowardShare(match(eight.slice(0, 6), V))).toBe(true);
  });

  it('level raw wins can hide an uneven share: the case volume 127 found', () => {
    // Two 2-seat matches won by the vanguard, two 3-seat matches won by the juggernaut: two wins
    // each, but the juggernaut was owed 2/3 of a win and the vanguard 1 + 2/3.
    const share = fairShares([match([V, S], V), match([V, S], V), match([V, S, J], J), match([V, S, J], J)]);
    expect(share.get(V)!.wins).toBe(share.get(J)!.wins);
    expect(share.get(J)!.wins / share.get(J)!.fair).toBeCloseTo(3, 6);
    expect(share.get(V)!.wins / share.get(V)!.fair).toBeCloseTo(1.2, 6);
  });

  it('the fair shares sum to the matches counted', () => {
    const results = [match([V, S], V), match([V, S, J, V, S], J), match([V, S, J], 'tie'), match([V, S, J, V], S)];
    const total = [...fairShares(results).values()].reduce((n, x) => n + x.fair, 0);
    expect(total).toBeCloseTo(results.filter(countsTowardShare).length, 9);
    expect(total).toBeCloseTo(3, 9);
  });
});
