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
import { heldPart, type InputSource, type PlayerCommand } from '../state/commands';
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
  /** Every confirmed frame once any owner has sent anything: frame → commands. Frames with
   * nothing new share one held array (`heldSnapshot`). An absent frame is idle for all —
   * only possible before the first command of the match. */
  private readonly cmdsByFrame = new Map<number, readonly PlayerCommand[]>();
  /** Highest frame given its command set; frames above it up to the watermark do not exist yet. */
  private filledTo = 0;
  /** Highest frame `take()` has released — reported as `resume{lastFrame}` on reconnect. */
  private lastTaken = -1;
  private matchInfo: MatchStart | null = null;
  private readonly bufferFrames: number;
  // ── Sparse held-input sync (design/15, ROADMAP 4.5) ──────────────────────────────
  /** Last command actually SENT for the local seat — `submit()`'s change filter. */
  private lastSent: PlayerCommand | null = null;
  /** What each owner is still doing (INBOUND) — its last command with the one-shot parts
   * stripped (`heldPart`), updated strictly in frame order, so the set stored for frame N
   * reflects exactly "as of frame N," independent of wall-clock arrival/burst timing. */
  private readonly heldByOwner = new Map<number, PlayerCommand>();
  /** `heldByOwner`'s values as one array, shared by every frame with nothing new. */
  private heldSnapshot: readonly PlayerCommand[] = EMPTY;

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
    this.heldSnapshot = EMPTY;
    this.filledTo = m.startFrame;
    this.matchInfo = m;
    this.startFrame = m.startFrame;
    // The start frame is playable immediately — its command set is empty (the metronome
    // can only schedule commands onto later frames).
    this.confirmedTo = m.startFrame;
    this.opts.onMatchStart?.(m);
  }

  private onFrameBatch(b: FrameBatch): void {
    this.fillThrough(b.frames, b.toFrame);
    if (b.toFrame > this.confirmedTo) this.confirmedTo = b.toFrame; // watermark is monotonic
  }

  private onConnResync(r: ConnResync): void {
    // Reconnect: fill the replayed frames (> lastFrame) and jump the watermark to
    // curFrame. Frames already filled are deterministic duplicates and are skipped.
    this.startFrame = r.startFrame;
    this.fillThrough(r.log, r.curFrame);
    if (r.curFrame > this.confirmedTo) this.confirmedTo = r.curFrame;
  }

  /**
   * Give every frame from `filledTo` + 1 through `to` its command set (design/15 "held
   * input": the engine receives one command per player for EVERY tick). A frame in
   * `frames` gets its fresh commands — one-shot parts included, on that frame only — plus
   * the held command of every other owner; a frame between them gets the held set. Before
   * 2026-10-03 only the batch's `toFrame` was filled and the two frames between batches
   * came back EMPTY, so the sim idled every seat on them: online, a player moved and fired
   * on one frame in three.
   */
  private fillThrough(frames: readonly FrameCmds[], to: number): void {
    const fresh = new Map<number, FrameCmds>();
    for (const fc of frames) if (fc.frame > this.filledTo) fresh.set(fc.frame, fc);
    for (let frame = this.filledTo + 1; frame <= to; frame++) {
      const fc = fresh.get(frame);
      if (fc) {
        const now = new Map(this.heldByOwner);
        for (const cmd of fc.cmds) {
          now.set(cmd.owner, cmd);
          this.heldByOwner.set(cmd.owner, heldPart(cmd));
        }
        this.cmdsByFrame.set(frame, [...now.values()]);
        this.heldSnapshot = [...this.heldByOwner.values()];
      } else if (this.heldSnapshot.length > 0) {
        this.cmdsByFrame.set(frame, this.heldSnapshot);
      }
    }
    if (to > this.filledTo) this.filledTo = to;
  }
}

/**
 * A frame log (`FrameBroadcast.log`, a `conn_resync` log) as the full per-frame stream every
 * client simulates through `toFrame` — the gaps held, each one-shot on its own frame — ready
 * for `toReplay` (2026-10-03). A log is NOT a sparse replay stream: replayed as one, every
 * frame between two commands would idle (protocol.ts `FrameCmds`).
 */
export function confirmedStream(log: readonly FrameCmds[], toFrame: number, startFrame = 0): PlayerCommand[] {
  const net = new NetInputSource({ submit: () => {} }, { bufferFrames: 0 });
  net.handleServerMsg({ type: 'match_start', seed: 0, startFrame, localOwner: 0, playerCount: 0 });
  net.handleServerMsg({ type: 'frame_batch', toFrame, frames: log });
  const out: PlayerCommand[] = [];
  for (let frame = startFrame + 1; frame <= toFrame; frame++) {
    for (const cmd of net.take(frame)!) out.push({ ...cmd, tick: frame });
  }
  return out;
}

/** Did any of a `PlayerCommand`'s MEANINGFUL fields change (design/15, ROADMAP 4.5)?
 * `moveBrad` is already brad-quantized upstream (state/input.ts) before reaching
 * here, so a plain `!==` on it IS "did the quantized value change" — one existing
 * mechanism (determinism quantization) doing double duty as the compression key,
 * not a second threshold invented on top. Buttons are already edge-shaped
 * (bit-flip = a real change); `owner`/`tick`/`type` never factor in.
 *
 * Every OTHER field does, by construction rather than by list (2026-10-08). This was a
 * hand-written list of fields, and each value-carrying latch added to `PlayerCommand`
 * had to be remembered here too: `pickupTargetId` and `shopBuyId` were, `cardVote`
 * (ENGINE_VERSION 58) never was. A card tap from a seat standing still at the portal —
 * which is where every card tap happens — differed from the last command in `cardVote`
 * alone, so it was swallowed as a duplicate and never reached the server. And since a
 * descend waits for a vote (`ExtractionSystem`), the Descend button then did nothing
 * either: online, a squad could neither pick a card nor leave the floor (live report,
 * co-op with a bot backfill). A new field is now sent the moment it differs, with no
 * line here to forget. */
const IGNORED: ReadonlySet<string> = new Set<keyof PlayerCommand>(['type', 'owner', 'tick']);

function changed(a: PlayerCommand, b: PlayerCommand): boolean {
  for (const k of Object.keys(b) as (keyof PlayerCommand)[]) {
    if (!IGNORED.has(k) && a[k] !== b[k]) return true;
  }
  return false;
}
