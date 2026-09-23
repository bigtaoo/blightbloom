// Windowed frame-timing sampler — the pure, Pixi-free half of the perf system, ported
// from `funny`'s client/src/cache/PerfMonitor.ts (see perf/README.md for the deviations).
// Everything that decides "is this slow, and slow in which way" lives here so it can be
// driven from a plain test with no renderer, no rAF and no DOM.
//
// Two parallel signals, exactly as in funny:
//   (1) long-task busy ratio — sum of all >50ms main-thread long-task durations inside the
//       window / window length. Hard evidence of a saturated main thread, so a single
//       window over threshold is enough to report.
//   (2) sustained low FPS — estimated from the frame deltas fed in. Needs several
//       consecutive windows so a room transition or an asset decode doesn't cry wolf.
// The daydayup addition is the SPLIT: every frame also carries how much of it was our own
// update vs. the renderer, so a low-fps report already says which half to look at.

/** Percentile summary of one window's samples of a single timing series (ms). */
export interface MsStats {
  p50: number;
  p95: number;
  max: number;
}

/** One closed sampling window. `discarded` windows are still handed to `onWindow` for the
 *  overlay's benefit but never feed the warning paths — see `markHidden`. */
export interface FrameWindow {
  fps: number;
  frames: number;
  windowMs: number;
  /** 0..1. Always 0 where PerformanceObserver('longtask') is unavailable. */
  busyRatio: number;
  /** Wall-clock time between frames — what the player actually experiences. */
  frame: MsStats;
  /**
   * Share (0..1) of sampled frames markedly longer than this window's own median frame —
   * the JUDDER metric (2026-09-22).
   *
   * Everything else here is an average or a percentile, and the 2026-09-22 report is the
   * demonstration that neither can see the thing being reported: a frame cap dropping 103
   * frames a minute reads as 58 fps with a p50 of 16.7 and a p95 of 16.7, all of which look
   * healthy, while the player sees a frame lasting twice as long as its neighbours nearly
   * twice a second. p95 cannot show it either — at 2.9% of frames the doubled ones are inside
   * the 5% the percentile discards.
   *
   * Measured against the window's own median rather than against a target, so it says nothing
   * about whether the frame rate is high enough and everything about whether it is STEADY. A
   * device holding a rock-solid 30 fps reads 0 here, which is correct: 30 fps is a different
   * complaint from judder, and `fps` is already the field for it.
   */
  longFrameRatio: number;
  /** CPU spent in the game's own update (sim step + scene mirroring + fx + hud). */
  update: MsStats;
  /** CPU spent inside `renderer.render` — scene traversal + draw-call submission. */
  render: MsStats;
  /** True when the tab was hidden at any point during the window: the browser throttles
   *  rAF for power saving, so every number above is meaningless. */
  discarded: boolean;
}

export interface FrameSamplerOptions {
  /** Sampling window length (ms). Default 2000, same as funny. */
  windowMs?: number;
  /** Consecutive low-fps windows before a warning fires. Default 5 (~10s). */
  sustainWindows?: number;
  /** FPS below this counts as a stutter. Default 25. */
  fpsWarn?: number;
  /** Long-task busy ratio at or above this counts as main-thread saturation. Default 0.5. */
  busyWarn?: number;
  /** Per-window sample cap for the percentile arrays, so a runaway ticker cannot grow them
   *  unboundedly. Default 300 (the default window holds ~120 at 60fps). */
  maxSamples?: number;
  onWindow?: (w: FrameWindow) => void;
  onWarn?: (reason: string, w: FrameWindow) => void;
}

const DEFAULT_FPS_WARN = 25; // 5fps of headroom below 30, so a 30Hz-locked device is not "slow"
const DEFAULT_BUSY_WARN = 0.5;
const DEFAULT_WINDOW_MS = 2_000;
const DEFAULT_SUSTAIN_WINDOWS = 5;
const DEFAULT_MAX_SAMPLES = 300;

/** How much longer than the median a frame has to be to count as a long one. 25%: an
 *  ordinary vsynced frame varies by a few percent, a frame that waited for one extra display
 *  interval is at least 25% longer at the slowest rate this client will run at (30 fps on a
 *  60 Hz panel: 41.7 ms against 33.3), and a dropped frame at 60 fps is 100% longer. */
export const LONG_FRAME_TOLERANCE = 0.25;

export const FPS_WARN_KEY = 'daydayup.perf.fpsWarn';
export const BUSY_WARN_KEY = 'daydayup.perf.busyWarn';

/** localStorage threshold override — funny's `nw_fps_warn` / `nw_cpu_busy_warn` escape
 *  hatch, under this repo's own `daydayup.` key namespace (meta/settings stores). */
export function numFromStorage(key: string, fallback: number): number {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    const v = raw == null ? NaN : Number(raw);
    if (Number.isFinite(v) && v > 0) return v;
  } catch {
    /* localStorage unavailable (WeChat, private mode, blocked): use the default */
  }
  return fallback;
}

/** Percentiles of a sample array. Empty ⇒ all zeros, so a window that closed without a
 *  single frame (possible right after install) still reports a well-formed shape. */
export function msStats(samples: readonly number[]): MsStats {
  if (samples.length === 0) return { p50: 0, p95: 0, max: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
  return { p50: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1]! };
}

/**
 * Share (0..1) of `samples` longer than `medianMs * (1 + LONG_FRAME_TOLERANCE)`.
 *
 * Exported and pure so the metric can be reasoned about on its own — it is the one number in
 * `FrameWindow` that is a claim rather than a measurement, and the claim ("this is what judder
 * looks like from inside the client") is worth being able to test directly.
 *
 * An empty sample, or a median of zero, is 0 rather than NaN: a window that closed without a
 * frame is not a juddering window, and a NaN would travel all the way to a dashboard panel as
 * a gap that reads like an outage.
 */
export function longFrameRatio(samples: readonly number[], medianMs: number): number {
  if (samples.length === 0 || medianMs <= 0) return 0;
  const limit = medianMs * (1 + LONG_FRAME_TOLERANCE);
  let long = 0;
  for (const ms of samples) if (ms > limit) long++;
  return long / samples.length;
}

export class FrameSampler {
  private readonly windowMs: number;
  private readonly sustainWindows: number;
  private readonly maxSamples: number;
  private readonly fpsWarnDefault: number;
  private readonly busyWarnDefault: number;
  private readonly onWindow?: (w: FrameWindow) => void;
  private readonly onWarn?: (reason: string, w: FrameWindow) => void;

  private accMs = 0;
  private frames = 0;
  private longTaskMs = 0;
  private lowFpsStreak = 0;
  private readonly frameMs: number[] = [];
  private readonly updateMs: number[] = [];
  private readonly renderMs: number[] = [];
  /** Latched, not sampled at window end — a tab hidden mid-window and shown again before
   *  the closing frame would otherwise pass as a real stutter (funny hit this exact case). */
  private hidden = false;

  /** Whether the long-task path is live. Off ⇒ busyRatio stays 0 and never warns, so an
   *  environment without PerformanceObserver falls back to the FPS path alone. */
  longTaskSupported = false;

  /** Read at window close to decide whether the NEXT window starts already hidden. */
  isHiddenNow: () => boolean = () => false;

  constructor(opts: FrameSamplerOptions = {}) {
    this.windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
    this.sustainWindows = opts.sustainWindows ?? DEFAULT_SUSTAIN_WINDOWS;
    this.maxSamples = opts.maxSamples ?? DEFAULT_MAX_SAMPLES;
    this.fpsWarnDefault = opts.fpsWarn ?? DEFAULT_FPS_WARN;
    this.busyWarnDefault = opts.busyWarn ?? DEFAULT_BUSY_WARN;
    this.onWindow = opts.onWindow;
    this.onWarn = opts.onWarn;
  }

  /** Feed one rendered frame. `frameMs` is the ticker's own delta (wall clock); the other
   *  two are the measured CPU halves of it, and may be 0 when not instrumented. */
  frame(frameMs: number, updateMs = 0, renderMs = 0): void {
    this.frames += 1;
    this.accMs += frameMs;
    if (this.frameMs.length < this.maxSamples) {
      this.frameMs.push(frameMs);
      this.updateMs.push(updateMs);
      this.renderMs.push(renderMs);
    }
    if (this.accMs >= this.windowMs) this.closeWindow();
  }

  /** Add a long task's duration (ms) observed since the last window close. */
  addLongTaskMs(ms: number): void {
    this.longTaskMs += ms;
  }

  /** Latch "the tab was hidden during this window". Cleared at window close, to whatever
   *  `isHiddenNow` reports at that instant. */
  markHidden(): void {
    this.hidden = true;
  }

  private closeWindow(): void {
    const windowMs = this.accMs;
    const frames = this.frames;
    const busyRatio = Math.min(1, this.longTaskMs / Math.max(1, windowMs));
    const frame = msStats(this.frameMs);
    const w: FrameWindow = {
      fps: (frames * 1000) / Math.max(1, windowMs),
      frames,
      windowMs,
      busyRatio: this.longTaskSupported ? busyRatio : 0,
      frame,
      longFrameRatio: longFrameRatio(this.frameMs, frame.p50),
      update: msStats(this.updateMs),
      render: msStats(this.renderMs),
      discarded: this.hidden,
    };
    this.accMs = 0;
    this.frames = 0;
    this.longTaskMs = 0;
    this.frameMs.length = 0;
    this.updateMs.length = 0;
    this.renderMs.length = 0;

    this.onWindow?.(w);

    if (w.discarded) {
      // Throttled rAF, not slowness. Drop the sample AND the streak — a tab returning from
      // the background must not be one window away from a false "sustained low fps".
      this.hidden = this.isHiddenNow();
      this.lowFpsStreak = 0;
      return;
    }

    // (1) Main-thread saturation: one window is enough, a long task is direct evidence.
    if (this.longTaskSupported && w.busyRatio >= numFromStorage(BUSY_WARN_KEY, this.busyWarnDefault)) {
      this.lowFpsStreak = 0;
      this.onWarn?.(
        `main thread busy ${(w.busyRatio * 100).toFixed(0)}% over ${Math.round(w.windowMs)}ms (fps ${w.fps.toFixed(0)})`,
        w,
      );
      return; // already reported this window; don't double-report via the fps path
    }

    // (2) Sustained low fps: several consecutive windows, so transients stay quiet.
    const fpsWarn = numFromStorage(FPS_WARN_KEY, this.fpsWarnDefault);
    if (w.fps < fpsWarn) {
      this.lowFpsStreak += 1;
      if (this.lowFpsStreak >= this.sustainWindows) {
        this.lowFpsStreak = 0;
        // Only claim a culprit when the split was actually measured — an uninstrumented
        // host reports 0/0, and "render-bound" read off two zeros is a confident lie.
        const measured = w.render.p50 > 0 || w.update.p50 > 0;
        const half = measured ? (w.render.p50 >= w.update.p50 ? ' (render-bound)' : ' (update-bound)') : '';
        this.onWarn?.(
          `sustained low fps ~${w.fps.toFixed(0)} (<${fpsWarn}) for `
            + `${(this.windowMs * this.sustainWindows) / 1000}s — frame p50 ${w.frame.p50.toFixed(1)}ms, `
            + `update p50 ${w.update.p50.toFixed(1)}ms, render p50 ${w.render.p50.toFixed(1)}ms${half}`,
          w,
        );
      }
    } else {
      this.lowFpsStreak = 0;
    }
  }
}
