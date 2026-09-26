/**
 * The gameserver's half of the PvP integrity record (design/15, "PvP integrity", decided
 * 2026-09-26): turn a settled match that did NOT settle cleanly into the body matchsvc's
 * `POST /integrity/report` stores. Pure, like `ladderReport.ts` beside it, so the shape is
 * testable without a socket or a fetch.
 *
 * Record, never ban. Nothing on either side of this route acts on a record: it is stored,
 * counted per account, and shown in the ops console. The input log rides along so a later
 * replay has something to judge, but nothing judges it yet.
 *
 * Only PvP. A co-op divergence rates nothing and wins nothing, so there is no one it could
 * have been cheated against.
 */
import { gzipSync } from 'node:zlib';
import { ENGINE_VERSION } from '@dd/engine';
import type { IntegrityVerdict, SettledMatch } from './MatchRoom';
import type { BoundsFailure } from './settlement';

/**
 * The largest gzipped input log the report carries. Past it the log is dropped and the
 * record says so (`logDropped`), rather than the whole report failing: the verdict and the
 * suspects are the part an operator reads, and they are a few hundred bytes. The 2026-09-26
 * estimate for an 8-seat match of typical length is well under a tenth of this.
 */
export const MAX_LOG_GZIP_BYTES = 4 * 1024 * 1024;

/** One named seat in a record: a dissenter, a kicked seat, or both. */
export interface IntegritySuspect {
  seat: number;
  /** Absent for a guest or bot seat, which is recorded but counts against no account. */
  accountId?: string;
  dissented: boolean;
  kicked: boolean;
}

export interface IntegrityReportBody {
  roomId: string;
  verdict: Exclude<IntegrityVerdict, 'clean'>;
  bounds?: BoundsFailure;
  playerCount: number;
  seed: number;
  engineVersion: number;
  settleFrame: number;
  suspects: IntegritySuspect[];
  /** Seats that never reported and were treated as offline (`MatchIntegrity.absent`). Not
   *  suspects, and counted against nobody. */
  absent: number[];
  /** Every logged-in seat, suspect or not, so a record can be read against the players who
   *  were there. Same shape as `SettledMatch.seatAccounts`. */
  seatAccounts: Record<number, string>;
  /** base64 of the gzipped JSON frame log, or absent when it was dropped for size. */
  logGzipB64?: string;
  logDropped?: boolean;
}

/** The report for `match`, or null when there is nothing to record. */
export function buildIntegrityReportBody(
  match: SettledMatch,
  maxLogBytes: number = MAX_LOG_GZIP_BYTES,
): IntegrityReportBody | null {
  const { integrity } = match;
  if (match.mode !== 'pvp' || integrity.verdict === 'clean') return null;

  const seatAccounts: Record<number, string> = { ...match.seatAccounts };
  const seats = [...new Set([...integrity.dissenters, ...integrity.kicked])].sort((a, b) => a - b);
  const suspects = seats.map((seat): IntegritySuspect => {
    const accountId = seatAccounts[seat];
    return {
      seat,
      ...(accountId !== undefined ? { accountId } : {}),
      dissented: integrity.dissenters.includes(seat),
      kicked: integrity.kicked.includes(seat),
    };
  });

  const gz = gzipSync(JSON.stringify(integrity.log ?? []));
  const log = gz.length <= maxLogBytes ? { logGzipB64: gz.toString('base64') } : { logDropped: true };

  return {
    roomId: match.roomId,
    verdict: integrity.verdict,
    ...(integrity.bounds !== undefined ? { bounds: integrity.bounds } : {}),
    playerCount: match.playerCount,
    seed: integrity.seed,
    engineVersion: ENGINE_VERSION,
    settleFrame: integrity.settleFrame,
    suspects,
    absent: integrity.absent,
    seatAccounts,
    ...log,
  };
}
