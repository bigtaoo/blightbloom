/**
 * Online co-op input source (design/06 "NetInputSource", ROADMAP 3.1) — the networked
 * sibling of LocalInputSource / ReplayInputSource, all implementing InputSource
 * (state/commands.ts). It bridges the server's frame-broadcast metronome (design/06)
 * to the deterministic engine:
 *
 *   • OUTBOUND — `submit(cmd)` relays the local seat's command to the server (via the
 *     injected sink), but only when it CHANGED since the last one sent (design/15,
 *     ROADMAP 4.5 sparse input sync — see the class doc below `changed()`). It does
 *     NOT choose a frame: the server schedules it onto the current batch window and
 *     broadcasts it back. The command becomes CONFIRMED only when it returns inside a
 *     `frame_batch`.
 *
 *   • INBOUND — `frame_batch{toFrame, frames}` raises the confirmed watermark. Since
 *     an unchanged command is never resent, a boundary frame with nothing NEW from a
 *     given seat does NOT mean that seat went idle — it means "still doing what it
 *     was doing" (design/15's "held input" model). `take(frame)` releases, for each
 *     owner that has ever sent anything, either this frame's fresh command or its last
 *     held one — or `null` when the frame is not yet confirmed, which stalls the
 *     engine (design/06: "clients advance strictly by the confirmed frame stream").
 *
 * Pacing / jitter cushion (design/06 catch-up model): playback is held `bufferFrames`
 * behind the newest watermark, so jitter smaller than the cushion never starves the
 * sim. When the watermark jumps ahead (a burst, or a `conn_resync` after reconnect),
 * `confirmedLead()` reports the backlog and the render loop's accumulator fast-forwards
 * to resync — "a lagging client falls behind the broadcast and catches up alone."
 *
 * This is the confirmed-stream half. LOCAL PREDICTION of the local seat (running ahead
 * of the watermark with self-forwarded input, then reconciling) is a separate layer on
 * top — see the prediction driver (ROADMAP 3.1 part D). Co-op PvE is latency-tolerant
 * (design/06), so it is playable on this source alone; prediction is the twin-stick
 * feel fix that matters most for PvP.
 *
 * Sparse held-input sync (design/15, ROADMAP 4.5) is a WIRE-FORMAT change only — the
 * engine still receives one full command per player for every simulated tick
 * internally (a gap is filled by holding, right here), so nothing about
 * `@dd/engine`'s determinism or ENGINE_VERSION moves; this class is the only place
 * that changes. It's deliberately the SAME hold-then-reconcile consumption pattern
 * `LocalPredictor` already uses for the local seat's own rendering, so a future move
 * to full state-sync only swaps what arrives sparsely, not how it's consumed.
 */
import type { InputSource, PlayerCommand } from '../state/commands';
import type { ConnResync, FrameBatch, FrameCmds, MatchStart, ServerMsg } from './protocol';

const EMPTY: readonly PlayerCommand[] = [];

/** Where outbound commands go — satisfied by the client's transport (WebSocket). */
export interface CmdSink {
  submit(cmd: PlayerCommand): void;
}

export interface NetInputSourceOptions {
  /**
   * Frames kept buffered behind the newest confirmed watermark — the jitter cushion.
   * Default 3 (≈100 ms at 30 Hz, one funny-style 10 Hz batch). 0 = play to the edge of
   * the watermark (no cushion, lowest latency, most vulnerable to jitter).
   */
  bufferFrames?: number;
  /** Fired once when `match_start` arrives, so the app can build + start the engine. */
  onMatchStart?: (info: MatchStart) => void;
  /** Fired when `match_over` arrives (server's authoritative outcome). */
  onMatchOver?: (winner: import('./protocol').MatchOver) => void;
}

const DEFAULT_BUFFER_FRAMES = 3;

export class NetInputSource implements InputSource {
  /** Highest `toFrame` confirmed by the server; -1 before `match_start`. */
  private confirmedTo = -1;
  private startFrame = 0;
  /** Non-empty frames only: frame → commands (an absent frame is an implicit idle-hold,
   * for any owner that has never sent anything at all — see `heldByOwner` below). */
  private readonly cmdsByFrame = new Map<number, PlayerCommand[]>();
  /** Highest frame `take()` has released — reported as `resume{lastFrame}` on reconnect. */
  private lastTaken = -1;
  private matchInfo: MatchStart | null = null;
  private readonly bufferFrames: number;
  // ── Sparse held-input sync (design/15, ROADMAP 4.5) ──────────────────────────────
  /** Last command actually SENT for the local seat — `submit()`'s change filter. */
  private lastSent: PlayerCommand | null = null;
  /** Last known command per owner (INBOUND) — updated strictly in frame order as
   * explicit `FrameCmds` are ingested, so a snapshot taken at ingest time for frame N
   * reflects exactly "as of frame N," independent of wall-clock arrival/burst timing. */
  private readonly heldByOwner = new Map<number, PlayerCommand>();

  constructor(
    private readonly sink: CmdSink,
    private readonly opts: NetInputSourceOptions = {},
  ) {
    this.bufferFrames = opts.bufferFrames ?? DEFAULT_BUFFER_FRAMES;
  }

  // ─── InputSource ─────────────────────────────────────────────────────────────

  /**
   * Relay a locally-produced command to the server — but only when it CHANGED since
   * the last one actually sent (design/15, ROADMAP 4.5): a player holding a direction
   * steady has nothing new to say. It is confirmed only when it returns inside a
   * future `frame_batch`; the server assigns the real frame, so the `tick` on `cmd`
   * is advisory (the prediction layer uses it locally).
   */
  submit(cmd: PlayerCommand): void {
    if (this.lastSent && !changed(this.lastSent, cmd)) return;
    this.lastSent = cmd;
    this.sink.submit(cmd);
  }

  /**
   * Confirmed command set for `frame`, or `null` to stall the engine. A frame is
   * releasable once it sits at or below the playback head (`confirmedTo - bufferFrames`,
   * floored at `startFrame`); holding the head a cushion behind the watermark absorbs
   * sub-cushion jitter.
   */
  take(frame: number): readonly PlayerCommand[] | null {
    if (this.confirmedTo < 0) return null; // no match yet
    const playTo = this.playHead();
    if (frame > playTo) return null; // not yet confirmed → engine pauses
    if (frame > this.lastTaken) this.lastTaken = frame;
    return this.cmdsByFrame.get(frame) ?? EMPTY;
  }

  /**
   * Confirmed playback backlog ahead of `frame` (design/06 catch-up). Mirrors take()'s
   * head exactly, so the two never disagree about what's releasable: this is how many
   * frames take() would return non-null for, starting at `frame`. A large lead means the
   * watermark raced ahead while this client was paused/backgrounded — the loop speeds up.
   */
  confirmedLead(frame: number): number {
    if (this.confirmedTo < 0) return 0;
    return Math.max(0, this.playHead() - frame);
  }

  private playHead(): number {
    return Math.max(this.startFrame, this.confirmedTo - this.bufferFrames);
  }

  // ─── Server message intake (transport wires its onMessage here) ────────────────

  /** Route a decoded server message; ignores everything but the lockstep-relevant ones. */
  handleServerMsg(msg: ServerMsg): void {
    switch (msg.type) {
      case 'match_start': return this.onMatchStart(msg);
      case 'frame_batch': return this.onFrameBatch(msg);
      case 'conn_resync': return this.onConnResync(msg);
      case 'match_over': this.opts.onMatchOver?.(msg); return;
      default: return; // 'error' etc. handled by the transport, not the input path
    }
  }

  /** `match_start` info (seed / localOwner / playerCount), or null before it arrives. */
  get matchStartInfo(): MatchStart | null {
    return this.matchInfo;
  }

  /** Frame to put in `resume{lastFrame}` on reconnect — the highest watermark held. */
  resumeFrame(): number {
    return Math.max(this.startFrame, this.confirmedTo, 0);
  }

  // ─── Internals ─────────────────────────────────────────────────────────────────

  private onMatchStart(m: MatchStart): void {
    // Fresh match: clear any frame state from a prior match so stale commands can't
    // bleed into the new engine and break determinism. (Reconnect uses conn_resync.)
    this.cmdsByFrame.clear();
    this.lastTaken = -1;
    this.lastSent = null;
    this.heldByOwner.clear();
    this.matchInfo = m;
    this.startFrame = m.startFrame;
    // The start frame is playable immediately — its command set is empty (the metronome
    // can only schedule commands onto later frames).
    this.confirmedTo = m.startFrame;
    this.opts.onMatchStart?.(m);
  }

  private onFrameBatch(b: FrameBatch): void {
    for (const fc of b.frames) this.ingestFrame(fc);
    // A pure metronome pulse (frames: []) still needs its own held snapshot recorded
    // at the new boundary frame (design/15, ROADMAP 4.5) — "nobody sent anything new
    // this pulse" means everyone HELD, not everyone went idle.
    this.ensureHeldSnapshot(b.toFrame);
    if (b.toFrame > this.confirmedTo) this.confirmedTo = b.toFrame; // watermark is monotonic
  }

  private onConnResync(r: ConnResync): void {
    // Reconnect: merge the replayed frames (> lastFrame) and jump the watermark to
    // curFrame. Frames already held (≤ old watermark) are deterministic duplicates —
    // re-ingesting overwrites with identical content, a no-op in effect.
    this.startFrame = r.startFrame;
    for (const fc of r.log) this.ingestFrame(fc);
    this.ensureHeldSnapshot(r.curFrame); // same reasoning as onFrameBatch above
    if (r.curFrame > this.confirmedTo) this.confirmedTo = r.curFrame;
  }

  /**
   * Fold one EXPLICIT frame's commands into the held-per-owner state, then snapshot
   * the FULL current set (every owner heard from so far, fresh or held) at exactly
   * this frame number — computed at ingest time (not lazily at `take()`), so it
   * reflects "as of frame N" regardless of wall-clock burst/arrival timing (the
   * ordered log is identical on every client, so this snapshot is too). The server
   * already ordered `fc.cmds` (owner asc, then arrival) — irrelevant here since each
   * owner only ever contributes its own held slot, but preserved for `ApplyInputSystem`
   * were it ever handed the raw list.
   */
  private ingestFrame(fc: FrameCmds): void {
    for (const cmd of fc.cmds) this.heldByOwner.set(cmd.owner, cmd);
    this.cmdsByFrame.set(fc.frame, [...this.heldByOwner.values()]);
  }

  /** Ensure `frame` has a stored command set even when NO explicit `FrameCmds`
   * landed on it this pulse — the held snapshot as of whatever's already known. A
   * no-op before any owner has ever sent anything (still correctly idle, matching
   * the pre-4.5 "no command yet" default). */
  private ensureHeldSnapshot(frame: number): void {
    if (!this.cmdsByFrame.has(frame) && this.heldByOwner.size > 0) {
      this.cmdsByFrame.set(frame, [...this.heldByOwner.values()]);
    }
  }
}

/** Did any of a `PlayerCommand`'s MEANINGFUL fields change (design/15, ROADMAP 4.5)?
 * `moveBrad` is already brad-quantized upstream (state/input.ts) before reaching
 * here, so a plain `!==` on it IS "did the quantized value change" — one existing
 * mechanism (determinism quantization) doing double duty as the compression key,
 * not a second threshold invented on top. Buttons are already edge-shaped
 * (bit-flip = a real change); `owner`/`tick`/`type` never factor in.
 * `pickupTargetId` (ENGINE_VERSION 32) is a one-shot click latch, not a held button —
 * a click can land on a tick where every other field happens to be unchanged (e.g.
 * standing still, already firing), so it must factor in here too or the click is
 * silently swallowed as a duplicate and never reaches the server; `shopBuyId` (2026-09-14)
 * is the same latch for a shop counter. */
function changed(a: PlayerCommand, b: PlayerCommand): boolean {
  return (
    a.moveBrad !== b.moveBrad ||
    a.moveMag !== b.moveMag ||
    a.buttons !== b.buttons ||
    a.pickupTargetId !== b.pickupTargetId ||
    // Same reasoning as `pickupTargetId` above, one verb along: a shop tap can land on a
    // tick where nothing else moved, and a swallowed tap is a purchase the server never
    // hears about.
    a.shopBuyId !== b.shopBuyId
  );
}
