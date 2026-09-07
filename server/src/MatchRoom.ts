/**
 * One co-op match — the server-side room (design/06, ROADMAP 3.1). A thin lifecycle
 * shell around the pure @dd/engine FrameBroadcast core: it fills seats, starts the
 * metronome when the room is full, relays each client's commands into the broadcaster,
 * and fans the resulting batches back out. It is the co-op adaptation of funny's
 * `gameserver/src/Room.ts`, minus the PvP concerns Blightbloom doesn't have (sides/ELO/
 * decks/ticket settlement) and generalised from 2 fixed sides to N co-op seats.
 *
 * Deliberately free of any socket/timer import: the WebSocket glue lives only in the
 * entrypoint (index.ts), which passes in a `Scheduler` (the metronome clock) and
 * `RoomConnection`s (per-seat senders). That keeps the whole lifecycle — seat
 * assignment, match start, batch broadcast, reconnect, settlement — unit-testable with
 * a fake clock and fake connections (see test/MatchRoom.test.ts). The determinism-
 * critical relay logic it wraps is already proven in @dd/engine's own tests.
 */
import {
  FrameBroadcast,
  CHECKPOINT_QUORUM,
  INTEGRITY_KICK_STREAK,
  type PlayerCommand,
  type ServerMsg,
  type Winner,
} from '@dd/engine';
import type { MatchMode } from './ticket';

/** A per-seat sink — one connected client. The transport wraps a socket as this. */
export interface RoomConnection {
  /** Which co-op seat this connection drives (its `owner` in every PlayerCommand). */
  readonly owner: number;
  /** The logged-in account behind this seat (design/16-accounts.md), if any — carried
   * from the verified ticket. `undefined` for guests/bots. */
  readonly accountId?: string;
  send(msg: ServerMsg): void;
}

/** The metronome clock, injected so tests can drive it by hand (no real timers). */
export interface Scheduler {
  setInterval(fn: () => void, ms: number): IntervalHandle;
  clearInterval(handle: IntervalHandle): void;
}
export type IntervalHandle = unknown;

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
  hashOk: boolean;
  /** seat owner index → accountId (design/16-accounts.md), for whichever seats were
   * logged in. Omits guest/bot seats entirely — `ladderReport.ts` falls back to its
   * scaffold accountId for any seat missing here. */
  seatAccounts?: Readonly<Record<number, string>>;
}

export interface MatchRoomDeps {
  scheduler: Scheduler;
  /** PvE co-op vs. PvP arena (design/15) — rides along in `match_start` so the client
   * knows which EngineConfig shape to build. Absent (every pre-PvP caller/test) → 'coop'. */
  mode?: MatchMode;
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

// Exported so index.ts's handshake can tell "still filling seats" (a fresh `join`)
// apart from "already running" (a reconnect must wait for an explicit `resume`
// instead) without duplicating the enum or poking a private field.
export const Phase = { WAITING: 0, IN_MATCH: 1, OVER: 2 } as const;
export type PhaseVal = (typeof Phase)[keyof typeof Phase];

const DEFAULT_BATCH_MS = 100;
const DEFAULT_FRAMES_PER_BATCH = 3;
const START_FRAME = 0;

interface Seat {
  owner: number;
  conn: RoomConnection | null;
  /** Set from `conn.accountId` on join/resume (design/16-accounts.md) and kept across a
   * disconnect so a settled match can still credit a briefly-dropped player's account. */
  accountId?: string;
}

export class MatchRoom {
  phase: PhaseVal = Phase.WAITING;
  private readonly seats: Seat[];
  private readonly broadcast: FrameBroadcast;
  private readonly batchMs: number;
  private metronome: IntervalHandle | null = null;
  private readonly results = new Map<number, { hash: number; winner: Winner; placements?: readonly number[] }>();
  private settled = false;
  // Anti-cheat periodic checkpoints (design/15, ROADMAP 4.4): tick -> (owner -> hash),
  // evaluated (and discarded) the instant every seat has reported for that tick — the
  // server never needs to remember a tick again once it's been compared. Per-seat
  // consecutive-mismatch streak drives the kick rule (a clean report resets it).
  private readonly checkpoints = new Map<number, Map<number, number>>();
  private readonly integrityStrikes = new Map<number, number>();

  private readonly mode: MatchMode;

  constructor(
    readonly roomId: string,
    private readonly seed: number,
    private readonly playerCount: number,
    private readonly deps: MatchRoomDeps,
  ) {
    this.mode = deps.mode ?? 'coop';
    this.batchMs = deps.batchMs ?? DEFAULT_BATCH_MS;
    this.broadcast = new FrameBroadcast({
      framesPerBatch: deps.framesPerBatch ?? DEFAULT_FRAMES_PER_BATCH,
      startFrame: START_FRAME,
    });
    this.seats = Array.from({ length: playerCount }, (_, owner) => ({ owner, conn: null }));
  }

  get seedValue(): number {
    return this.seed;
  }
  get playerCountValue(): number {
    return this.playerCount;
  }
  get modeValue(): MatchMode {
    return this.mode;
  }
  get frame(): number {
    return this.broadcast.frame;
  }
  private get connected(): boolean {
    return this.seats.every((s) => s.conn !== null);
  }

  // ───────────────────────── join / start ─────────────────────────

  /**
   * Claim a seat. The room fills in seat (owner) order; once every seat has a
   * connection the match launches. Returns false (and the caller closes the socket)
   * for an out-of-range or already-taken seat, or a join after the match started
   * (a reconnect must use `resume`, not `join`).
   */
  join(conn: RoomConnection): boolean {
    if (this.phase !== Phase.WAITING) return false;
    const seat = this.seats[conn.owner];
    if (!seat || seat.conn !== null) return false;
    seat.conn = conn;
    if (conn.accountId !== undefined) seat.accountId = conn.accountId;
    if (this.connected) this.launch();
    return true;
  }

  private launch(): void {
    this.phase = Phase.IN_MATCH;
    for (const seat of this.seats) {
      seat.conn?.send({
        type: 'match_start',
        seed: this.seed,
        startFrame: START_FRAME,
        localOwner: seat.owner,
        playerCount: this.playerCount,
        mode: this.mode,
      });
    }
    this.startMetronome();
  }

  // ───────────────────────── in-match relay ─────────────────────────

  /**
   * Relay a command from a seat. The server is the seat authority: it stamps the
   * command's `owner` from the connection (never trusts a client-sent owner) so a
   * client can only ever move its own player. The frame is assigned by the metronome
   * (the command lands on the current window's `toFrame`).
   */
  submitCmd(owner: number, cmd: PlayerCommand): void {
    if (this.phase !== Phase.IN_MATCH) return;
    if (!this.seats[owner]) return;
    this.broadcast.submit({ ...cmd, owner });
  }

  private startMetronome(): void {
    if (this.metronome !== null) return;
    // Belt-and-braces: both callers already gate on `connected` (launch fires only once the
    // last seat joins, resume checks it), so this arm is unreachable from the public surface
    // and stays permanently uncovered. Kept as the invariant a third caller would have to
    // respect — a metronome ticking a seat nobody is on advances the clock past that player.
    if (!this.connected) return;
    this.metronome = this.deps.scheduler.setInterval(() => this.pulse(), this.batchMs);
  }

  private stopMetronome(): void {
    if (this.metronome !== null) {
      this.deps.scheduler.clearInterval(this.metronome);
      this.metronome = null;
    }
  }

  /** One broadcast pulse — advance the shared clock and fan the batch out to every seat. */
  private pulse(): void {
    const batch = this.broadcast.tick();
    this.sendAll({ type: 'frame_batch', ...batch });
  }

  private sendAll(msg: ServerMsg): void {
    for (const seat of this.seats) seat.conn?.send(msg);
  }

  // ───────────────────────── reconnect ─────────────────────────

  /**
   * A client rejoins mid-match. Rebind its seat, send the frame log it missed
   * (everything after `lastFrame`) plus the current watermark, and resume the
   * metronome once every seat is connected again (it pauses on a disconnect).
   */
  resume(conn: RoomConnection, lastFrame: number): boolean {
    const seat = this.seats[conn.owner];
    if (!seat || this.phase !== Phase.IN_MATCH || this.settled) return false;
    seat.conn = conn;
    if (conn.accountId !== undefined) seat.accountId = conn.accountId;
    conn.send({
      type: 'conn_resync',
      startFrame: START_FRAME,
      curFrame: this.broadcast.frame,
      log: this.broadcast.logSince(lastFrame),
    });
    if (this.connected) this.startMetronome();
    return true;
  }

  /**
   * A connection dropped. Free its seat and pause the metronome (the shared clock
   * cannot advance past a player who can't receive it — co-op is latency-tolerant, so
   * it waits for a reconnect rather than forfeiting). If every seat is gone, destroy.
   */
  onDisconnect(conn: RoomConnection): void {
    const seat = this.seats[conn.owner];
    if (!seat || seat.conn !== conn) return; // already replaced by a newer connection
    seat.conn = null;
    if (this.phase === Phase.IN_MATCH) this.stopMetronome();
    if (this.seats.every((s) => s.conn === null)) this.destroy();
  }

  // ───────────────────────── anti-cheat checkpoints (design/15, ROADMAP 4.4) ─────────────────────────

  /**
   * A client's periodic mid-match state hash (design/15) — v1 mechanism: the server
   * just collects each seat's report and flags whichever value disagrees with the
   * majority, needing zero new server-side simulation. Evaluated only once every
   * seat has reported for that SAME historical tick (never "whatever tick a client
   * currently claims"), so a seat merely catching up under lag never looks divergent
   * — it simply hasn't reported that tick yet.
   *
   * Below `CHECKPOINT_QUORUM` real (connected) seats, this is a no-op: an early
   * low-population match is expected to be internally inconsistent, and "not enough
   * honest signal to trust a majority" applies at any seat count this low.
   */
  reportCheckpoint(owner: number, tick: number, stateHash: number): void {
    if (this.phase !== Phase.IN_MATCH) return;
    if (!this.seats[owner]) return;
    if (this.playerCount <= CHECKPOINT_QUORUM) return;

    let byOwner = this.checkpoints.get(tick);
    if (!byOwner) {
      byOwner = new Map();
      this.checkpoints.set(tick, byOwner);
    }
    byOwner.set(owner, stateHash);
    if (byOwner.size < this.playerCount) return; // wait for every seat's report at this tick

    // Majority vote (v1, design/15): the most-agreed-on hash wins; whichever seats
    // disagree get a strike. A clean report resets a seat's streak — only a
    // CONSECUTIVE run of INTEGRITY_KICK_STREAK mismatches (never a single stray
    // one, more likely a benign catch-up race) actually severs the seat.
    const counts = new Map<number, number>();
    for (const hash of byOwner.values()) counts.set(hash, (counts.get(hash) ?? 0) + 1);
    let majorityHash = 0;
    let majorityCount = -1;
    for (const [hash, count] of counts) {
      if (count > majorityCount) {
        majorityHash = hash;
        majorityCount = count;
      }
    }

    for (const [seatOwner, hash] of byOwner) {
      if (hash === majorityHash) {
        this.integrityStrikes.delete(seatOwner);
        continue;
      }
      const strikes = (this.integrityStrikes.get(seatOwner) ?? 0) + 1;
      if (strikes >= INTEGRITY_KICK_STREAK) {
        this.kickSeat(seatOwner);
      } else {
        this.integrityStrikes.set(seatOwner, strikes);
      }
    }
    this.checkpoints.delete(tick); // evaluated — never needed again, bounds memory
  }

  /**
   * Sever a seat for a confirmed integrity divergence. Reconnecting uses the
   * existing `resume`/`conn_resync` path (design/15) — no new plumbing needed, only
   * this new trigger that decides to disconnect it in the first place. Otherwise
   * identical to a voluntary `onDisconnect`: free the seat, pause the metronome
   * (co-op/PvP alike are latency-tolerant), destroy if the room is now empty.
   */
  private kickSeat(owner: number): void {
    const seat = this.seats[owner];
    if (!seat || !seat.conn) return;
    seat.conn.send({
      type: 'error',
      code: 'integrity_mismatch',
      message: 'State diverged from the match majority at a confirmed checkpoint.',
    });
    seat.conn = null;
    this.integrityStrikes.delete(owner);
    // Same shape as `onDisconnect`, and the phase check is likewise unreachable here (the
    // only caller, reportCheckpoint, refuses outside IN_MATCH) — symmetry with the ordinary
    // disconnect path is worth more than deleting a branch the coverage report will keep
    // showing. The destroy arm below is NOT dead: a kick can take the room's last seat.
    if (this.phase === Phase.IN_MATCH) this.stopMetronome();
    if (this.seats.every((s) => s.conn === null)) this.destroy();
  }

  // ───────────────────────── settlement ─────────────────────────

  /**
   * A client reports its end-of-match state (the deterministic hash + the outcome).
   * Once every seat has reported, the room settles: it broadcasts `match_over` and
   * destroys itself. Divergent hashes are flagged (design/06: the authoritative
   * backstop is a server-side runHeadless re-judge, not realtime trust).
   *
   * `placements` (design/15, ROADMAP 4.2e) is present only for a PvP match (a config
   * with `arena` set — GameState.placements); its presence, not the room's own
   * knowledge of match type, is what selects the `'placement'` reason — MatchRoom
   * stays generic infrastructure, same as it already is for co-op vs. solo. That is
   * still true of the client-facing `reason` string, which is cosmetic. It is NOT true
   * of `SettledMatch`, which now carries the room's own `mode` precisely so a consumer
   * with real consequences attached (the ladder) gates on something no seat can
   * fabricate — see `SettledMatch.mode`.
   */
  reportResult(owner: number, stateHash: number, winner: Winner, placements?: readonly number[]): void {
    if (this.phase !== Phase.IN_MATCH || this.settled) return;
    if (!this.seats[owner]) return;
    this.results.set(owner, { hash: stateHash, winner, placements });
    if (this.results.size < this.playerCount) return;

    const reports = [...this.results.values()];
    const hashOk = reports.every((r) => r.hash === reports[0]!.hash);
    const agreedWinner = reports[0]!.winner;
    const agreedPlacements = reports[0]!.placements;
    this.settled = true;
    this.stopMetronome();
    this.phase = Phase.OVER;
    this.sendAll({
      type: 'match_over',
      winner: agreedWinner,
      reason: hashOk ? (agreedPlacements ? 'placement' : agreedWinner === 'enemies' ? 'wipe' : 'extract') : 'disconnect',
      placements: agreedPlacements,
    });
    const seatAccounts: Record<number, string> = {};
    for (const seat of this.seats) if (seat.accountId) seatAccounts[seat.owner] = seat.accountId;
    this.deps.onSettled?.({
      roomId: this.roomId,
      mode: this.mode,
      winner: agreedWinner,
      placements: agreedPlacements,
      playerCount: this.playerCount,
      hashOk,
      // Omitted entirely when no seat was logged in — keeps the pre-account SettledMatch
      // shape byte-identical for every guest-only match (and every existing test).
      ...(Object.keys(seatAccounts).length > 0 ? { seatAccounts } : {}),
    });
    this.destroy();
  }

  destroy(): void {
    this.stopMetronome();
    this.deps.onDestroy(this.roomId);
  }
}
