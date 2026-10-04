/**
 * The server-side frame-broadcast core (design/06 "server as frame broadcaster", the
 * 王者荣耀 / funny `Room` pattern, ROADMAP 3.1). PURE and headless — no sockets, no
 * timers: the transport owns the metronome (a setInterval) and the sockets, and calls
 * `tick()` each pulse to get the `FrameBatch` to broadcast. Keeping the relay logic
 * here (not buried in the I/O layer) means its correctness — command ordering, the
 * monotonic watermark, the reconnect log — is unit-tested under the engine's own
 * vitest, and the client and server share ONE protocol definition (design/06's anti-
 * drift lesson). It mirrors funny's `server/gameserver/src/Room.ts`, minus the PvP
 * concerns DayDayUp co-op doesn't have (sides/ELO/decks/ticket handshake).
 *
 * Model (design/06):
 *   • The server owns a fixed-rate clock and broadcasts one batch per pulse.
 *   • It NEVER waits for a client — every pulse advances the watermark, whether or not
 *     input arrived. A batch with no commands is a pure metronome pulse (frames: []).
 *   • It never interprets a command beyond folding two from one seat on one frame
 *     (`foldCommands`); it buckets by frame and orders deterministically.
 *
 * Frame numbering matches the engine and NetInputSource: startFrame (0) is the initial
 * state, sim frames advance by `framesPerBatch` per pulse. With the funny-default 3
 * (sim 30 Hz ÷ net 10 Hz) a pulse jumps 3 sim frames. A command lands on the frame of the
 * window its arrival time falls in (2026-10-03, `submit`'s `offset`; the transport owns the
 * clock): before that every command landed on the window's `toFrame`, so a run lasted up to
 * a window longer or shorter than the stick was held, and a stop slid 3-19 px. Frames with
 * no command hold each seat's last one (NetInputSource).
 */
import { foldCommands, type PlayerCommand } from '../state/commands';
import type { FrameBatch, FrameCmds } from './protocol';

export interface FrameBroadcastOptions {
  /** Sim frames advanced per broadcast pulse. Default 3 (30 Hz sim ÷ 10 Hz net, funny). */
  framesPerBatch?: number;
  /** First frame's predecessor — the initial-state frame. Default 0. */
  startFrame?: number;
}

const DEFAULT_FRAMES_PER_BATCH = 3;

export class FrameBroadcast {
  private curFrame: number;
  private readonly framesPerBatch: number;
  /** Commands buffered since the last pulse, in arrival order, each with the frame it lands on. */
  private pending: { frame: number; cmd: PlayerCommand }[] = [];
  /** Non-empty frames only — the reconnect/replay log (design/06 "frame log = replay"). */
  private readonly frameLog: FrameCmds[] = [];

  constructor(opts: FrameBroadcastOptions = {}) {
    this.framesPerBatch = opts.framesPerBatch ?? DEFAULT_FRAMES_PER_BATCH;
    this.curFrame = opts.startFrame ?? 0;
  }

  /**
   * Buffer a command received from a client this window. `owner` rides on the command
   * (the transport stamps it from the connection's claimed seat, not from client-sent
   * data). `offset` is how many whole frames of the open window had passed when it
   * arrived (0 = the window's first frame); it is clamped into the window, never lands
   * before a command that arrived earlier, and defaults to the window's last frame. Two
   * commands from one owner on one frame are folded into one (`foldCommands`), so a tap
   * followed at once by its clear is not lost.
   */
  submit(cmd: PlayerCommand, offset = this.framesPerBatch - 1): void {
    const into = Math.min(this.framesPerBatch - 1, Math.max(0, Math.floor(offset)));
    const after = this.pending.length > 0 ? this.pending[this.pending.length - 1]!.frame : 0;
    this.pending.push({ frame: Math.max(after, this.curFrame + 1 + into), cmd });
  }

  /**
   * One broadcast pulse. Advances the watermark by `framesPerBatch`, flushes the
   * buffered commands onto their frames (ascending; within a frame one command per
   * owner, owners ascending — the sole ordering authority, so every client applies an
   * identical sequence), appends them to the log, and returns the batch to broadcast.
   * When nothing was buffered the batch carries no frames — a pure metronome pulse that
   * still advances every client's clock (the server never waits, design/06).
   */
  tick(): FrameBatch {
    this.curFrame += this.framesPerBatch;
    if (this.pending.length === 0) {
      return { toFrame: this.curFrame, frames: [] };
    }
    const byFrame = new Map<number, Map<number, PlayerCommand>>();
    for (const { frame, cmd } of this.pending) {
      let owners = byFrame.get(frame);
      if (!owners) byFrame.set(frame, (owners = new Map()));
      const prev = owners.get(cmd.owner);
      owners.set(cmd.owner, prev ? foldCommands(prev, cmd) : cmd);
    }
    this.pending = [];
    // `pending` is in landing order already (submit never lands before an earlier arrival).
    const frames: FrameCmds[] = [...byFrame].map(([frame, owners]) => ({
      frame,
      cmds: [...owners.values()].sort((a, b) => a.owner - b.owner),
    }));
    this.frameLog.push(...frames);
    return { toFrame: this.curFrame, frames };
  }

  /** The non-empty frames after `frame` — the reconnect payload (conn_resync.log). */
  logSince(frame: number): FrameCmds[] {
    return this.frameLog.filter((f) => f.frame > frame);
  }

  /** Current confirmed watermark. */
  get frame(): number {
    return this.curFrame;
  }

  /** The full frame log — the embedded replay (design/06 re-judge backstop). */
  get log(): readonly FrameCmds[] {
    return this.frameLog;
  }
}
