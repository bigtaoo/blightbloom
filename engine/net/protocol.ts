/**
 * The wire protocol for online co-op (design/06, ROADMAP 3.1). Lives in @dd/engine so
 * the client and the server package reference ONE definition — the funny lesson
 * (design/06 "two hand-mirrored copies inevitably drift"): the transport shapes are
 * shared source, not re-declared per side.
 *
 * Unlike funny (which ships opaque `game.proto` bytes the server never decodes),
 * DayDayUp's `PlayerCommand` is already a compact plain-data record (integer
 * brad/mag/buttons — state/commands.ts), so it travels on the wire verbatim. The
 * server still never interprets a command's MEANING; it only buckets commands by
 * frame and broadcasts them (design/06 "server as frame broadcaster").
 *
 * Frame numbering matches the engine: frame 0 is the initial state (no commands ever
 * apply to it); real sim frames start at 1 (GameEngine.advance(frame), frame=tick+1).
 */
import type { PlayerCommand } from '../state/commands';
import type { Winner } from '../state/entities';

/**
 * The confirmed command set for one frame, in the server's authoritative order
 * (design/06 "the server is the sole ordering authority"). A frame with no commands
 * is NOT sent — its absence from a batch's `frames` is an implicit idle-hold, exactly
 * like a sparse Replay stream (replay.ts).
 */
export interface FrameCmds {
  frame: number;
  cmds: readonly PlayerCommand[];
}

/**
 * One broadcast tick (design/06 "broadcast one frame packet per tick"). `toFrame` is
 * the confirmed watermark — every frame ≤ toFrame is now final — and `frames` carries
 * only the non-empty ones since the last batch. A batch with an empty `frames` is a
 * pure metronome pulse: it advances the watermark (so clients keep stepping) with no
 * input. The server never waits for a client, so `toFrame` only ever grows.
 */
export interface FrameBatch {
  toFrame: number;
  frames: readonly FrameCmds[];
}

/** PvE co-op vs. PvP arena (design/15) — tells the client which EngineConfig shape to
 * build (dungeon vs. arena). Optional/absent → 'coop', so every pre-4.x match_start
 * (every existing loopback/test fixture) is unaffected — additive. */
export type MatchMode = 'coop' | 'pvp';

/**
 * Seat index → the name to show for that seat, or `null` where there is none (a guest, a
 * bot, a seat that never authenticated). Sparse-safe: shorter than `playerCount`, or absent
 * entirely, means "no names known" rather than "unnamed seats" — every pre-2026-09-08
 * server sends nothing here and every client must render exactly as it did before.
 *
 * PRESENTATION ONLY. Nothing in the sim reads it, nothing hashes it, and it deliberately
 * does not travel in a `PlayerCommand`: design/06's determinism contract is that the state a
 * frame produces is a function of the commands, and a display name is not an input. It is
 * also SERVER-SUPPLIED rather than client-declared, which is the half that matters for
 * moderation — a client that could name itself could name itself anything.
 */
export type SeatNames = readonly (string | null)[];

/** Sent once when the room fills and the match begins — the engine's build config. */
export interface MatchStart {
  seed: number;
  startFrame: number; // first playable frame's predecessor (0)
  localOwner: number; // which seat index this client drives (owner in its PlayerCommands)
  playerCount: number; // total seats — the client builds EngineConfig.players of this length
  mode?: MatchMode;
  /** Who is in the other seats (design/20 — a game portal requires the platform's own
   *  usernames be shown so players can recognise their friends). */
  names?: SeatNames;
}

/** Reconnect catch-up (design/06 mirror of funny's conn_resync): replay the frame log past `lastFrame`. */
export interface ConnResync {
  startFrame: number;
  curFrame: number; // watermark to jump to
  log: readonly FrameCmds[]; // the non-empty frames the client is missing (> lastFrame)
  /** Carried here as well as in `match_start` because a RECONNECTING client never sees
   *  `match_start` again — without this it would rejoin the match it left with everyone's
   *  nameplate gone. */
  names?: SeatNames;
}

/** End of match — the server's authoritative outcome (clients also re-judge via runHeadless).
 * `placements` (design/15, ROADMAP 4.2e) is the PvP finish order — seat indices, worst
 * to best, the winner's index implicitly 1st and not repeated in this list — present
 * only for a `'placement'`-reason match; absent for every PvE `extract`/`wipe`/`disconnect`. */
export interface MatchOver {
  winner: Winner;
  reason: 'extract' | 'wipe' | 'disconnect' | 'placement';
  placements?: readonly number[];
}

/** Server → client. Discriminated on `type` (a tagged union — no protobuf codegen). */
export type ServerMsg =
  | ({ type: 'match_start' } & MatchStart)
  | ({ type: 'frame_batch' } & FrameBatch)
  | ({ type: 'conn_resync' } & ConnResync)
  | ({ type: 'match_over' } & MatchOver)
  | { type: 'error'; code: string; message: string };

/** Client → server. */
export type ClientMsg =
  // Claim a seat in a room. The FIRST joiner's (seed, playerCount) define the match;
  // later joiners must match or are rejected (server cross-checks, mirrors funny's ticket seed).
  | { type: 'join'; roomId: string; owner: number; seed: number; playerCount: number }
  // Relay one locally-produced command. The server assigns its frame (the current
  // batch window) and broadcasts it; `cmd.tick` from the client is advisory only.
  | { type: 'cmd'; cmd: PlayerCommand }
  // Reconnect into an in-progress match, asking for the frame log past `lastFrame`.
  | { type: 'resume'; roomId: string; owner: number; lastFrame: number }
  // Report the client-computed end state for the server's re-judge/audit backstop
  // (design/06). `placements` (design/15, ROADMAP 4.2e) is present only for a PvP
  // match — GameState.placements, the finish order WinConditionSystem recorded.
  | { type: 'result'; stateHash: number; winner: Winner; placements?: readonly number[] }
  // Periodic anti-cheat checkpoint (design/15, ROADMAP 4.4) — generalizes `result`
  // above from "once, at gameover" to "every CHECKPOINT_TICKS, during the match."
  // `tick` is the CONFIRMED historical tick this hash was computed at (never "whatever
  // tick the client currently claims"), so the server can compare same-tick reports
  // across seats without trusting client clocks.
  | { type: 'checkpoint'; tick: number; stateHash: number };
