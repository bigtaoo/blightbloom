// Auto-downgrade policy for `QualitySetting: 'auto'` (2026-08-25).
//
// The perf system (src/perf) already closes a sampling window every ~2s and reports its fps,
// and already knows when a window is meaningless (`discarded`: the tab was hidden and rAF was
// throttled). This watches that stream and decides, once, that the device cannot hold the high
// tier. It is pure — no Pixi, no timers, no globals — so the decision can be driven from a test
// by handing it a list of windows.
//
// Why a sustain count rather than a single slow window: a room transition, a subpackage load, or
// a GC pause produces one bad window on hardware that is otherwise fine, and a player whose game
// visibly changed look because of a loading hitch would reasonably call that a bug.

/** The slice of `perf/frameSampler.ts`'s `FrameWindow` this needs. Declared structurally so the
 *  watchdog does not depend on the perf module (and so a test can hand it plain objects). */
export interface FrameWindowLike {
  readonly fps: number;
  readonly frames: number;
  readonly discarded: boolean;
}

export interface QualityWatchdogOptions {
  /** Sustained fps below this is a downgrade candidate. Default 25 — the same floor
   *  `frameSampler` warns at, chosen there as "5fps of headroom below 30, so a 30Hz-locked
   *  device is not slow". */
  fpsFloor?: number;
  /** Consecutive qualifying windows before the downgrade fires. Default 3 (~6s at the
   *  sampler's 2s window) — long enough to outlast a room load, short enough that a player
   *  on a struggling phone is not made to sit through 10s of stutter first. Counted again
   *  from zero after each step, so reaching the bottom rung takes a fresh streak per rung. */
  sustainWindows?: number;
  /** How many times it may step down. Default 2 — the length of `resolveTier`'s ladder minus
   *  its top rung (high -> medium -> low). A third step would resolve to the same tier and so
   *  can only mislead a caller that trusts the return value. */
  maxSteps?: number;
  /** Windows with fewer frames than this are ignored as unrepresentative — a window that
   *  closed right after install, or one spanning a long synchronous load, reports an fps that
   *  describes the load and not the game. Default 5. */
  minFrames?: number;
}

const DEFAULT_FPS_FLOOR = 25;
const DEFAULT_SUSTAIN_WINDOWS = 3;
const DEFAULT_MIN_FRAMES = 5;
const DEFAULT_MAX_STEPS = 2;

/**
 * Stepping downgrade detector. Feed it every closed window; it returns `true` on each window
 * that trips a step down, and `false` on every other one — including every window once it has
 * spent all `maxSteps` of them.
 *
 * The bound is the contract: `resolveTier` has no way back up (see its doc comment) and its
 * ladder ends, so a `true` past the bottom rung could only ever mean "downgrade something that
 * is already at the cheapest tier".
 */
export class QualityWatchdog {
  private readonly fpsFloor: number;
  private readonly sustainWindows: number;
  private readonly minFrames: number;
  private readonly maxSteps: number;
  private streak = 0;
  private steps = 0;

  constructor(opts: QualityWatchdogOptions = {}) {
    this.fpsFloor = opts.fpsFloor ?? DEFAULT_FPS_FLOOR;
    this.sustainWindows = opts.sustainWindows ?? DEFAULT_SUSTAIN_WINDOWS;
    this.minFrames = opts.minFrames ?? DEFAULT_MIN_FRAMES;
    this.maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;
  }

  /** True on a window that trips a step down, false on every other window. */
  observe(w: FrameWindowLike): boolean {
    if (this.steps >= this.maxSteps) return false;
    // A hidden tab's numbers are not this device's numbers. Note this neither counts toward the
    // streak NOR resets it: the game was not being drawn, so the window is no evidence either
    // way, and treating it as evidence of health would let a player who tabbed away mid-stutter
    // come back to a reset counter every time.
    if (w.discarded || w.frames < this.minFrames) return false;
    if (w.fps >= this.fpsFloor) {
      this.streak = 0;
      return false;
    }
    this.streak++;
    if (this.streak < this.sustainWindows) return false;
    // A fresh streak per rung: the windows that condemned the tier we were on say nothing about
    // the cheaper one we are about to run, so they must not count toward condemning that too.
    this.streak = 0;
    this.steps++;
    return true;
  }

  /** How many rungs down `'auto'` has stepped — 0 while the device is holding the top tier.
   *  `RenderQualityController` feeds this straight to `resolveTier`. */
  get downgrades(): number {
    return this.steps;
  }

  /** Clears the steps and the streak — used when the player pins a tier explicitly, so that
   *  going back to `'auto'` re-measures instead of inheriting a verdict from hardware
   *  conditions (a backgrounded video call, a thermal throttle) that may have passed. */
  reset(): void {
    this.streak = 0;
    this.steps = 0;
  }
}
