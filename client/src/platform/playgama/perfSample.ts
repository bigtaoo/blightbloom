// Playgama's `performance_sample` (2026-11-06, ported from the sibling project `jump`'s
// `src/platform/perf.ts`): frame times of ACTIVE, VISIBLE play, aggregated per ~30 s window, in
// the field names Playgama's own dashboard reads (`target_fps`, `fps_p10`, `frames_over_*ms`, ...).
//
// Separate from `perf/` on purpose. That system feeds the quality watchdog and our own logger in
// 2 s windows and its own wire format; this one exists only to speak Playgama's contract, and
// goes straight to `bridge.track` rather than through `net/analytics.ts`, whose event vocabulary
// is ours and validated server-side. The two never share a number they could disagree about.

/** Active play per sample (Playgama's contract: about every 30 s). */
export const PERF_WINDOW_MS = 30_000;
/** A partial window shorter than this is dropped on a flush rather than sent: too few frames to mean much. */
export const PERF_MIN_MS = 10_000;
const OVER = [50, 100, 250, 500, 1000] as const;

export type SampleData = Record<string, string | number>;

/**
 * Fed once a frame with that frame's length and whether play was active through it. A frame
 * counts only when it AND the one before were active, so the gap after a pause, a menu, an ad or
 * a hidden tab is never taken for a frozen frame. Leaving play flushes the window so far.
 */
export class PerfSampler {
  private times: number[] = [];
  private active = 0;
  private startedAt = -1;
  private wasActive = false;
  /** Per-window counters the page bumps. */
  readonly counts = {
    js_error_count: 0,
    unhandled_rejection_count: 0,
    webgl_context_loss_count: 0,
    long_task_count: 0,
    long_task_total_ms: 0,
    long_task_max_ms: 0,
  };
  /** Where the game stands, sent with each sample. */
  context: () => SampleData = () => ({});

  constructor(
    private readonly send: (data: SampleData) => void,
    private readonly version: string,
    private readonly now: () => number = () => performance.now(),
  ) {}

  /** One frame: its length in ms and whether play was active and visible through it. */
  frame(ms: number, active: boolean): void {
    if (active && this.wasActive) {
      if (this.startedAt < 0) this.startedAt = this.now() - ms;
      this.times.push(ms);
      this.active += ms;
      if (this.active >= PERF_WINDOW_MS) this.flush(0);
    } else if (!active && this.wasActive) {
      this.flush();
    }
    this.wasActive = active;
  }

  /** A long task the page saw during play (PerformanceObserver 'longtask'). */
  longTask(ms: number): void {
    if (!this.wasActive) return;
    this.counts.long_task_count++;
    this.counts.long_task_total_ms += ms;
    this.counts.long_task_max_ms = Math.max(this.counts.long_task_max_ms, ms);
  }

  /** Sends the window so far if it holds at least `min` ms of play, and starts a new one. A
   *  shorter window is kept, to be topped up by the next stretch of play. */
  flush(min = PERF_MIN_MS): void {
    if (this.times.length === 0 || this.active < min) return;
    this.send(this.sample());
    this.times = [];
    this.active = 0;
    this.startedAt = -1;
    for (const k of Object.keys(this.counts) as (keyof typeof this.counts)[]) this.counts[k] = 0;
  }

  private sample(): SampleData {
    const s = [...this.times].sort((a, b) => a - b);
    const at = (p: number): number => s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
    const r1 = (n: number): number => Math.round(n * 10) / 10;
    const data: SampleData = {
      target_fps: 60,
      window_ms: Math.round(this.now() - this.startedAt),
      active_ms: Math.round(this.active),
      frame_count: s.length,
      fps_avg: r1((s.length / this.active) * 1000),
      fps_p10: r1(1000 / at(0.9)),
      frame_time_p50_ms: r1(at(0.5)),
      frame_time_p95_ms: r1(at(0.95)),
      frame_time_p99_ms: r1(at(0.99)),
      frame_time_max_ms: r1(s[s.length - 1]!),
      build_version: this.version,
    };
    for (const o of OVER) data[`frames_over_${o}ms`] = s.filter((t) => t > o).length;
    for (const [k, v] of Object.entries(this.counts)) data[k] = Math.round(v);
    return Object.assign(data, this.context());
  }
}

/** What `installPerfSample` reads from the page, injectable so a test needs no browser. */
export interface PerfSampleHost {
  /** The render ticker: `add` is called once with a per-frame callback receiving `deltaMS`. */
  ticker: { add(fn: (t: { deltaMS: number }) => void): unknown };
  /** Is play active this frame (a local run, not paused, not on a menu)? */
  playing(): boolean;
  hidden(): boolean;
  on(target: 'window' | 'document' | 'canvas', type: string, fn: () => void): void;
  /** Subscribe to long tasks, where the browser reports them. */
  observeLongTasks(fn: (ms: number) => void): void;
}

/** The browser's own `PerfSampleHost`. */
export function browserPerfHost(
  ticker: PerfSampleHost['ticker'],
  canvas: { addEventListener(type: string, fn: () => void): void },
  playing: () => boolean,
): PerfSampleHost {
  return {
    ticker,
    playing,
    hidden: () => document.hidden,
    on: (target, type, fn) => (target === 'window' ? window : target === 'document' ? document : canvas).addEventListener(type, fn),
    observeLongTasks: (fn) => {
      try {
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) fn(e.duration);
        }).observe({ type: 'longtask', buffered: false });
      } catch {
        /* no longtask entries in this browser: the counters stay 0, as the contract allows */
      }
    },
  };
}

/** Wire a sampler to the page: frames off the ticker, counters off the page's own events, and a
 *  flush whenever the page may be going away. */
export function installPerfSample(host: PerfSampleHost, sampler: PerfSampler): PerfSampler {
  host.ticker.add((t) => sampler.frame(t.deltaMS, host.playing() && !host.hidden()));
  host.on('window', 'error', () => sampler.counts.js_error_count++);
  host.on('window', 'unhandledrejection', () => sampler.counts.unhandled_rejection_count++);
  host.on('canvas', 'webglcontextlost', () => sampler.counts.webgl_context_loss_count++);
  host.on('window', 'pagehide', () => sampler.flush());
  host.on('document', 'visibilitychange', () => {
    if (host.hidden()) sampler.flush();
  });
  host.observeLongTasks((ms) => sampler.longTask(ms));
  return sampler;
}
