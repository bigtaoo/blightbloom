// The playout clock for an ONLINE match (2026-09-22; rewritten 2026-10-01 as a jitter buffer),
// split out of `GameLoop.ts` under CLAUDE.md's 500-line convention — form (2), composition: one
// concern, a cross-boundary call list of exactly `plan`/`alpha`/`reset`.
//
// ## What it is for
//
// `Entity.pushState` shifts cur → prev, so `Scene.reconcile` must run ONCE per sim tick, and
// the render frames between two ticks interpolate across them by `alpha`. Offline that is
// `advanceSim`'s own accumulator. Online the ticks come from the server, and they do not come
// evenly: `MatchRoom` sends them in batches of THREE every 100 ms (`DEFAULT_FRAMES_PER_BATCH`),
// on top of whatever the network adds. Until 2026-10-01 the loop stepped every confirmed frame
// the moment it was playable, so a batch landed as three ticks inside one render frame, mirrored
// once, and every remote player, enemy and bullet covered 100 ms of movement in 33 ms and then
// stood still for 67 — a 10 Hz stutter of everything on screen the player was not driving, and
// two thirds of each batch's events (`CoopSession.drive` returns the last frame's only) dropped.
//
// ## What it does
//
// It STEPS the confirmed stream at the sim's own 30 Hz, from render time, the way the offline
// accumulator does: `plan` says how many frames to step this render frame (usually 0 or 1), and
// whatever arrives early waits in the queue. That queue is the jitter buffer, and its depth is
// managed by the playout RATE rather than by a fixed delay:
//
//   - **running dry** holds `alpha` at 1 (every remote entity at its newest confirmed position,
//     never past it) and the next frame steps the moment it is playable — no catch-up burst;
//   - **the depth** is read as the SLACK at the worst moment of each second: ticks of play left
//     before the queue would run dry, were nothing more to arrive. Under one tick, the clock
//     plays 5% slow for the next second; over three, 5% fast. Either is invisible (a remote
//     player walking 5% faster for a second), where a stall or a skipped tick is not, and the
//     buffer settles at the shallowest depth this connection's jitter allows;
//   - **a backlog of half a second or more** (a backgrounded tab, a reconnect's resync) is not
//     paced at all: it is skipped down to a two-frame queue in one go, the old catch-up.
//
// ## What it costs
//
// Latency for REMOTE entities: they are drawn the jitter buffer's depth behind the newest
// confirmed frame, typically one to three ticks. The local seat is drawn from the predictor,
// whose correction target is the same paced confirmed position. Presentation-only, like every
// other render decision here: the sim is never touched (design/06), and what is stepped is the
// identical confirmed stream in the identical order, only at a different wall-clock moment.

/** Milliseconds per sim tick. 30 Hz, matching `SIM_DT_MS` in `GameLoop.ts` and the engine's
 *  own `TICK_RATE` — duplicated rather than imported to keep this module free of both. */
const SIM_DT_MS = 1000 / 30;

/** A queue this deep is not jitter, it is a client that fell behind: skip, do not pace. */
export const CATCHUP_FRAMES = 15;
/** What a skip leaves queued, so the frame after it does not start dry. */
const SKIP_KEEP = 2;
/** The slack band, in ticks, the rate steers the worst moment of each window into. */
const SLACK_LOW = 1;
const SLACK_HIGH = 3;
/** How far the rate leans, and how often it is reconsidered. */
const RATE_LEAN = 0.05;
const WINDOW_MS = 1000;

export class OnlineInterpolation {
  /** Milliseconds into the tick currently being drawn. */
  private acc = SIM_DT_MS;
  private playRate = 1;
  private windowMs = 0;
  private slackMin = Infinity;

  /**
   * How many confirmed frames to step this render frame, given `dtMs` of render time and the
   * `ready` frames playable now (`CoopSession.steppable`). The caller steps exactly that many,
   * mirroring each into the scene, and draws with {@link alpha}.
   *
   * A fresh clock steps on its first frame, so a new match is drawn the moment its first frame
   * is playable rather than one tick later.
   */
  plan(dtMs: number, ready: number): number {
    if (ready >= CATCHUP_FRAMES) {
      this.acc = 0;
      return ready - SKIP_KEEP;
    }
    // Floored at 0: a clock that goes backwards across a tab suspend would otherwise give a
    // NEGATIVE alpha, and alpha feeds a lerp — every remote actor would be drawn BEHIND the
    // last place it was seen.
    this.acc += Math.max(0, dtMs) * this.playRate;
    const steps = Math.min(ready, Math.floor(this.acc / SIM_DT_MS));
    this.acc -= steps * SIM_DT_MS;
    if (steps === ready) this.acc = Math.min(this.acc, SIM_DT_MS); // dry: hold, do not bank time
    this.steer(Math.max(0, dtMs), ready - steps + 1 - this.alpha);
    return steps;
  }

  private steer(dtMs: number, slack: number): void {
    this.slackMin = Math.min(this.slackMin, slack);
    this.windowMs += dtMs;
    if (this.windowMs < WINDOW_MS) return;
    this.playRate =
      this.slackMin < SLACK_LOW ? 1 - RATE_LEAN : this.slackMin > SLACK_HIGH ? 1 + RATE_LEAN : 1;
    this.windowMs = 0;
    this.slackMin = Infinity;
  }

  /**
   * How far into the current tick this frame falls, 0..1. Clamped, not wrapped: a server stall
   * must leave every remote actor at its newest confirmed position rather than running it past.
   */
  get alpha(): number {
    return Math.min(1, this.acc / SIM_DT_MS);
  }

  /** The current playout rate — 1, or 5% either side of it while the buffer is being steered. */
  get rate(): number {
    return this.playRate;
  }

  /** A new match is starting: step its first frame immediately, at the neutral rate. */
  reset(): void {
    this.acc = SIM_DT_MS;
    this.playRate = 1;
    this.windowMs = 0;
    this.slackMin = Infinity;
  }
}
