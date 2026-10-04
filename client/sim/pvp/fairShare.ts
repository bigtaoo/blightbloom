// A character's PvP wins read against its seat share (volume 127), out of `pvpBalanceSim.sim.ts`
// so the arithmetic the conclusion rests on is pinned by a test of its own.
//
// Raw win counts are NOT comparable across characters: `buildPvpEngineConfig` skins seat i as the
// (i mod 3)-th character, so a 2-seat match has no juggernaut at all. Each character's fair share
// is the sum over decided matches of its seats / seats; wins / fair is the number to read, 1.0
// being par. 8 seats is left out: its winner is whichever member of the winning squad comes first.

export interface ShareInput {
  playerCount: number;
  /** The winner's skin, or 'tie'. */
  winnerSkin: string;
  /** The skin on each seat. */
  skins: readonly string[];
}

export interface ShareRow {
  wins: number;
  fair: number;
}

/** Whether a match counts toward the share: decided, and not a squad match. */
export const countsTowardShare = (r: ShareInput): boolean => r.winnerSkin !== 'tie' && r.playerCount !== 8;

/** Wins and fair share per skin, over the matches `countsTowardShare` keeps. */
export function fairShares(results: readonly ShareInput[]): Map<string, ShareRow> {
  const share = new Map<string, ShareRow>();
  for (const r of results) {
    if (!countsTowardShare(r)) continue;
    for (const skin of new Set(r.skins)) {
      const row = share.get(skin) ?? { wins: 0, fair: 0 };
      row.fair += r.skins.filter((x) => x === skin).length / r.playerCount;
      if (r.winnerSkin === skin) row.wins++;
      share.set(skin, row);
    }
  }
  return share;
}
