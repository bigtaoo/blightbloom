/**
 * Split out of `MatchRoom.ts` (2026-09-26) — the settlement vote and the PvP bounds check,
 * as pure functions over the reports a room collected (design/15, "PvP integrity", decided
 * 2026-09-26). MatchRoom keeps the lifecycle; this file decides what the reports agree on and
 * whether that agreement is a result a ladder may act on.
 *
 * ## The vote
 *
 * Every seat casts ONE vote: its whole `{stateHash, winner, placements}` tuple. Squads do not
 * pool their votes, and a bot seat votes like any other (it runs the same deterministic sim a
 * client does, so it is simply an honest voter the server happens to own).
 *
 * Above `CHECKPOINT_QUORUM` seats, the tuple with a strict majority settles the match, provided
 * that majority is itself at least the quorum; every seat outside it is a dissenter. At or
 * below the quorum there is not enough honest signal to trust a majority (the same rule
 * `MatchRoom.reportCheckpoint` applies mid-match), so only unanimity settles.
 *
 * This replaces first-reporter-wins: `MatchRoom.reportResult` used to require equal hashes and
 * then copy `winner`/`placements` from whichever seat reported first, so a seat that matched
 * the hash but sent a different placement array decided the ladder by being fast, and one
 * divergent hash voided the result for all eight.
 *
 * ## The bounds check
 *
 * An agreed tuple can still describe a match that cannot have happened (a majority running a
 * modified client, or an engine bug every seat shares). `checkPvpBounds` refuses those before
 * anything reaches the ladder: the winner must be a real seat and its squad's representative
 * (the lowest seat index, which is what `WinConditionSystem.tickPlacement` names), the
 * placements must be exactly the seats outside the winning squad, each once, and the match
 * must have lasted long enough to be real.
 */
import { CHECKPOINT_QUORUM, type Winner } from '@dd/engine';
import { teamIdForOwner } from './config';

/** One seat's end-of-match report. */
export interface SeatReport {
  hash: number;
  winner: Winner;
  placements?: readonly number[];
}

/** The tuple the vote settled on, or null when no tuple carried the vote. */
export interface VoteOutcome {
  agreed: SeatReport | null;
  /** Seats whose tuple differs from `agreed`, ascending. Empty when `agreed` is null: with no
   *  settled answer there is nothing to dissent FROM, and naming every seat would be noise. */
  dissenters: number[];
}

/**
 * The fewest frames a PvP match can plausibly last. The 2026-09-26 bot sweep
 * (`client/sim/pvpBalanceSim.sim.ts`, 180 matches over 2–8 seats) never saw one end before
 * frame 954 (about 32 s at 30 Hz); this floor is half of that. The frame compared against it
 * is the SERVER's broadcast frame when the last report lands, which can only be later than
 * the tick the clients ended on, so a legitimate short match is never cut by the lag.
 */
export const MIN_PVP_SETTLE_FRAME = 450;

/** Why a bounds check failed, for the integrity record. */
export type BoundsFailure = 'winner_out_of_range' | 'winner_not_representative' | 'placements_mismatch' | 'too_short';

/** The canonical key of a tuple. JSON over a fixed-order array, so no field can bleed into
 *  another, and an absent `placements` differs from an empty one. */
function tupleKey(r: SeatReport): string {
  return JSON.stringify([r.hash, r.winner, r.placements === undefined ? null : [...r.placements]]);
}

/**
 * Vote over `reports` (seat → report; every seat of the room). See the file header for the
 * rule. `quorum` is a parameter so the tests can state the boundary they are testing; every
 * production caller passes nothing.
 */
export function voteSettlement(
  reports: ReadonlyMap<number, SeatReport>,
  playerCount: number,
  quorum: number = CHECKPOINT_QUORUM,
): VoteOutcome {
  const byKey = new Map<string, { report: SeatReport; seats: number[] }>();
  for (const [seat, report] of reports) {
    const key = tupleKey(report);
    const entry = byKey.get(key);
    if (entry) entry.seats.push(seat);
    else byKey.set(key, { report, seats: [seat] });
  }

  let best: { report: SeatReport; seats: number[] } | null = null;
  for (const entry of byKey.values()) {
    if (best === null || entry.seats.length > best.seats.length) best = entry;
  }
  // `reports` is never empty from MatchRoom (it settles only once every seat has reported),
  // but an empty map is a caller mistake that should settle nothing rather than throw.
  if (best === null) return { agreed: null, dissenters: [] };

  const votes = best.seats.length;
  const settles =
    playerCount <= quorum ? votes === playerCount : votes * 2 > playerCount && votes >= quorum;
  if (!settles) return { agreed: null, dissenters: [] };

  const dissenters: number[] = [];
  for (const seat of reports.keys()) if (!best.seats.includes(seat)) dissenters.push(seat);
  dissenters.sort((a, b) => a - b);
  return { agreed: best.report, dissenters };
}

/**
 * Whether an agreed PvP tuple describes a possible match. `null` means it does; otherwise the
 * first failed rule. Only PvP results are checked — a co-op result carries no placements and
 * rates nothing.
 */
export function checkPvpBounds(
  agreed: SeatReport,
  playerCount: number,
  settleFrame: number,
): BoundsFailure | null {
  const { winner, placements } = agreed;
  if (typeof winner !== 'number' || !Number.isInteger(winner) || winner < 0 || winner >= playerCount) {
    return 'winner_out_of_range';
  }
  const winnerTeam = teamIdForOwner(winner, playerCount);
  const squad: number[] = [];
  const others: number[] = [];
  for (let seat = 0; seat < playerCount; seat++) {
    (teamIdForOwner(seat, playerCount) === winnerTeam ? squad : others).push(seat);
  }
  if (squad[0] !== winner) return 'winner_not_representative';

  if (!placements || placements.length !== others.length) return 'placements_mismatch';
  const seen = new Set<number>();
  for (const seat of placements) {
    if (!Number.isInteger(seat) || seen.has(seat) || !others.includes(seat)) return 'placements_mismatch';
    seen.add(seat);
  }

  if (settleFrame < MIN_PVP_SETTLE_FRAME) return 'too_short';
  return null;
}
