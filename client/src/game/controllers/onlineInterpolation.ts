// Render interpolation for an ONLINE match (2026-09-22), split out of `GameLoop.ts` under
// CLAUDE.md's 500-line convention — form (2), composition: one concern, two fields, and a
// cross-boundary call list of exactly `observe`/`alpha`/`reset`.
//
// ## What it is for
//
// `Entity.pushState` shifts cur → prev, so `Scene.reconcile` is only meaningful ONCE per sim
// tick. The online path used to call it every render frame with whatever state the session
// held, which collapses prev onto cur — leaving nothing between the two to interpolate. That
// is why it passed `alpha = 1`, and why an online match moved in 30 Hz steps on a 60 Hz
// screen: every remote actor, every bullet, and (whenever the local seat was not being
// predicted) the camera advanced twice per frame and then held still.
//
// Offline has never had this problem, because `advanceSim` owns a real accumulator and only
// steps the engine on a tick boundary. This is the same idea for a clock the client does not
// control: the SERVER's tick is the beat, and this measures how far into the current one the
// render frame falls.
//
// ## What it costs
//
// The standard price of entity interpolation, paid by REMOTE entities only: they are drawn up
// to one tick (33 ms) behind the newest confirmed frame. The local seat is unaffected — the
// predictor snaps its view after this, and the camera follows that. Presentation-only, like
// every other render decision here: the sim is never touched (design/06).

/** Milliseconds per sim tick. 30 Hz, matching `SIM_DT_MS` in `GameLoop.ts` and the engine's
 *  own `TICK_RATE` — duplicated rather than imported to keep this module free of both. */
const SIM_DT_MS = 1000 / 30;

export class OnlineInterpolation {
  /** The confirmed tick the scene is currently mirroring. `-1` is "nothing mirrored yet",
   *  which a real tick can never be — see `reset`. */
  private tick = -1;
  /** Milliseconds since that tick landed. */
  private acc = 0;

  /**
   * Report this render frame's confirmed tick and its `dt`.
   *
   * Returns whether the tick ADVANCED, which is the caller's signal to mirror the state into
   * the scene (and to do the other once-per-tick work — see `GameLoop.spawnBulletTrails`).
   *
   * The caller also mirrors on any frame that carried EVENTS, which is the one deliberate
   * exception to "once per tick" and is stated here because it is a statement about what this
   * return value does not cover: `CoopSession.drive()` hands back the events of the frames it
   * applied, and dropping one loses a pickup flight or a death for good, where re-mirroring an
   * unchanged tick costs nothing worse than one frame of a remote actor standing still.
   */
  observe(serverTick: number, dtMs: number): boolean {
    if (serverTick === this.tick) {
      // Floored at 0: a clock that goes backwards across a tab suspend would otherwise give a
      // NEGATIVE alpha, and alpha feeds a lerp — every remote actor would be drawn BEHIND the
      // last place it was seen. Found by the test that asks for it rather than by a player.
      this.acc = Math.max(0, this.acc + dtMs);
      return false;
    }
    this.tick = serverTick;
    this.acc = 0;
    return true;
  }

  /**
   * How far into the current tick this frame falls, 0..1.
   *
   * Clamped, not wrapped: a server stall must leave every remote actor at its newest confirmed
   * position rather than running it past one. Zero on the frame a tick lands, which is not a
   * rounding detail — at 1 the scene would show the newest confirmed frame and then have to
   * stand still until the next one arrived, which is the stutter this exists to remove.
   */
  get alpha(): number {
    return Math.min(1, this.acc / SIM_DT_MS);
  }

  /**
   * Forget the mirrored tick — a new match is starting.
   *
   * Load-bearing: a match starts at tick 0, and a leftover 0 from the previous one would read
   * as "already mirrored" and hold the first confirmed frame off the screen until tick 1. A
   * first frame that never arrives looks like a connection problem, not like an off-by-one.
   */
  reset(): void {
    this.tick = -1;
    this.acc = 0;
  }
}
