/**
 * MatchRoom's public types, split out of `MatchRoom.ts` (CLAUDE.md's 500-line rule, form 1):
 * the per-seat connection, the room's injected deps, and the settled outcome it reports.
 * `MatchRoom.ts` re-exports every one, so callers import them from there as before.
 */
import { DEFAULT_CHAPTER_ID, type FrameCmds, type ServerMsg, type Winner } from '@dd/engine';
import type { ChapterId, MatchMode } from './ticket';
import type { Scheduler } from './scheduler';
import type { BoundsFailure, IntegrityVerdict } from './settlement';

/** A per-seat sink — one connected client. The transport wraps a socket as this. */
export interface RoomConnection {
  /** Which co-op seat this connection drives (its `owner` in every PlayerCommand). */
  readonly owner: number;
  /** The logged-in account behind this seat (design/16-accounts.md), if any — carried
   * from the verified ticket. `undefined` for guests/bots. */
  readonly accountId?: string;
  /** The display name to show other players for this seat (design/20), from the same
   *  verified ticket. `undefined` for guests/bots, which is most seats. */
  readonly name?: string;
  /** A practice bot's seat (ENGINE_VERSION 88), from the verified ticket. */
  readonly bot?: boolean;
  send(msg: ServerMsg): void;
}

/** How a match settled, for the integrity record (design/15, "PvP integrity", 2026-09-26);
 *  the verdicts are defined beside the rule that picks them, `settlement.ts`. */
export interface MatchIntegrity {
  verdict: IntegrityVerdict;
  /** Seats outside the agreed tuple, ascending. */
  dissenters: number[];
  /** Seats `reportCheckpoint` kicked at any point in the match, ascending — even ones that
   *  reconnected and then voted with the majority, since the divergence still happened. */
  kicked: number[];
  /** Seats that never reported before `SETTLE_TIMEOUT_MS` ran out, ascending — treated as
   *  offline, so they cast no vote. Not suspects: a dropped connection is not a cheat. */
  absent: number[];
  /** Set only when `verdict` is `bounds`. */
  bounds?: BoundsFailure;
  /** The server's broadcast frame when the room settled (the last report, or the timeout). */
  settleFrame: number;
  /** The room's seed, so an archived match can be re-run later. */
  seed: number;
  /** The whole input log (non-empty frames). Present only when `verdict` is not `clean` — a
   *  clean match has nothing to judge, and every PvP match carrying it would be a payload
   *  nobody reads. Shared by reference with the room, which is destroyed right after. */
  log?: readonly FrameCmds[];
}

/** A settled match's outcome, handed to `MatchRoomDeps.onSettled` (design/15,
 * ROADMAP 4.6) — everything the ladder-rating caller needs, and nothing MatchRoom
 * doesn't already legitimately know. `mode` and `hashOk` together are the
 * "checkpoint/hash-verified PvP result" gate design/15 requires before a placement
 * can affect the ladder; a caller should ignore this callback unless BOTH hold. */
export interface SettledMatch {
  roomId: string;
  /**
   * What kind of match this ROOM was, taken from the verified ticket
   * (`MatchRoomDeps.mode`, cross-checked across joiners by `RoomManager.join`) — never
   * from anything a seat said at settlement. This is the field a ladder caller has to
   * gate on, because `winner` and `placements` below are relayed straight off the
   * seats' own `result` messages: a co-op room whose clients agree on a hash and all
   * send a fabricated `placements` array plus a numeric `winner` would otherwise
   * produce a ladder report for a match nobody competed in. Required rather than
   * optional on purpose — a later producer has to state the mode instead of inheriting
   * a default that happens to open the gate.
   */
  mode: MatchMode;
  winner: Winner;
  placements?: readonly number[];
  /** Total seat count — needed by `ladderReport.ts` to recover the winning squad's
   * OTHER members (design/15's squad-aware ladder follow-up), since `placements`
   * only ever holds LOSING seats and `winner` names just one representative. */
  playerCount: number;
  /** True only when a tuple carried the settlement vote AND (for PvP) passed the bounds
   *  check — the one condition under which a result may move a rating. The name predates the
   *  vote, when it meant "every end hash matched". */
  hashOk: boolean;
  integrity: MatchIntegrity;
  /** seat owner index → accountId (design/16-accounts.md), for whichever seats were
   * logged in. Omits guest/bot seats entirely — `ladderReport.ts` falls back to its
   * scaffold accountId for any seat missing here. */
  seatAccounts?: Readonly<Record<number, string>>;
}

/**
 * The chapter a room of `mode` plays when its first ticket said `chapterId`: that chapter (or
 * the first one, for a ticket minted before chapters) for co-op, and none for PvP. The ONE
 * normalisation — `MatchRoom` builds its room with it and both join cross-checks (a fresh
 * `join`, a reconnect's handshake) compare a joiner against the room through it, so a
 * chapter-less co-op ticket and an explicit first-chapter one are the same room.
 */
export function roomChapter(mode: MatchMode, chapterId: ChapterId | undefined): ChapterId | undefined {
  return mode === 'coop' ? (chapterId ?? DEFAULT_CHAPTER_ID) : undefined;
}

export interface MatchRoomDeps {
  scheduler: Scheduler;
  /** PvE co-op vs. PvP arena (design/15) — rides along in `match_start` so the client
   * knows which EngineConfig shape to build. Absent (every pre-PvP caller/test) → 'coop'. */
  mode?: MatchMode;
  /** The PvE chapter a co-op room plays — from the signed ticket, sent in `match_start`.
   *  Absent → the first chapter. Ignored for PvP, which has none. */
  chapterId?: ChapterId;
  onDestroy: (roomId: string) => void;
  /** Fired once, right before destroy(), with the settled outcome (design/15, ROADMAP
   * 4.6) — e.g. wired to matchsvc's ladder-rating report in index.ts. Optional: every
   * pre-4.6 caller (every existing test, every PvE/co-op deployment) omits it and
   * nothing changes — MatchRoom stays generic infra, never importing matchsvc itself. */
  onSettled?: (match: SettledMatch) => void;
  /** Broadcast pulse period (ms). Default 100 (10 Hz, funny). */
  batchMs?: number;
  /** Sim frames per pulse. Default 3 (30 Hz sim ÷ 10 Hz net). Must match the client. */
  framesPerBatch?: number;
}
