/**
 * Where in the open broadcast window a command arrived (2026-10-03), split out of `MatchRoom`
 * so the room only restarts it on each pulse and reads it on each command. `FrameBroadcast`
 * turns the reading into the window frame the command lands on. Before this every command
 * landed on the window's last frame, so a run lasted up to 100 ms longer or shorter than the
 * stick was held, and every client drew that as a slide after the stop.
 */
export class WindowClock {
  private startedAt = 0;

  /** `now` is a monotonic ms clock; without one `offset()` is undefined and every command
   *  lands on the window's last frame, as before. */
  constructor(
    private readonly now: (() => number) | undefined,
    private readonly batchMs: number,
    private readonly framesPerBatch: number,
  ) {}

  /** A new window opens: the metronome started, or a pulse just closed the previous one. */
  restart(): void {
    this.startedAt = this.now?.() ?? 0;
  }

  /** Sim frames of the open window that have passed, fractional and unclamped (a late
   *  metronome can read past the window; `FrameBroadcast.submit` clamps). */
  offset(): number | undefined {
    const t = this.now?.();
    return t === undefined ? undefined : ((t - this.startedAt) * this.framesPerBatch) / this.batchMs;
  }
}
