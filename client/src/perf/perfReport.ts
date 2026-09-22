/**
 * Frame-pacing telemetry: the perf monitor's windows, aggregated and sent to the log store
 * so a dashboard can answer "is the game smooth on the machines people actually play it on?"
 * (2026-09-22, design/19 §10 and design/21).
 *
 * ## Why this exists at all
 *
 * `perf/README.md` has said since the port that the monitor has no telemetry sink and that
 * its `onWarn`/`onSnapshot` are seams for one. The 2026-09-22 report ("dizziness after about
 * twenty minutes") is what made the gap concrete: the answer to "do you have statistics?" was
 * no, and the instrument that was running in every session could not have produced them even
 * in principle. Two reasons, both fixed here rather than worked around:
 *
 * 1. **The only sink was a `console.warn` behind a threshold nothing normal reaches.** It
 *    fires at five consecutive windows below 25 fps. The machine in the report was holding
 *    58 fps and juddering, which is not a slow window and never will be.
 * 2. **The window carried no metric for judder.** Added as `FrameWindow.longFrameRatio` —
 *    see its own doc comment for why an average and a p95 both miss it.
 *
 * ## Why the log channel rather than the analytics one
 *
 * `net/analytics.ts` is a closed vocabulary of retention/funnel events, rolled up DAILY into
 * Prometheus gauges (`server/src/analytics/`). It answers "do people come back", on a cadence
 * of a day. This question is the other shape entirely: it is per-session, it wants the numbers
 * within a minute of them happening, and the thing you do with a bad one is filter to that
 * session and read what else it said. That is the log store, which the client already reaches
 * (`net/clientLog.ts` → `POST /client/log` → Loki), with a fixed label set and per-IP limits
 * already in place — so this adds a line, not a trust boundary.
 *
 * The line is logfmt INSIDE the message, which is what lets a Grafana panel do
 * `| logfmt | tag="perf" | line_format "{{.msg}}" | logfmt | unwrap long_pct`. The server
 * quotes `msg` as one field (`server/src/clientLog.ts`), so a second parse is the price of
 * not inventing a second ingest route.
 *
 * ## Cadence, and why not every window
 *
 * One line per {@link REPORT_INTERVAL_MS} of PLAY. A window is 2s, so reporting each one
 * would be 30 lines a minute per player for a number that barely moves — the classic way to
 * make a log store expensive and a dashboard unreadable. A minute of aggregate is also a
 * better statistic: `longFrameRatio` over 30 windows is a rate, where one window's is a
 * coin-flippy sample of ~120 frames.
 *
 * Pure: no globals, no timers, no `Date.now()`. `game/perfReporting.ts` holds the wiring.
 */
import type { FrameWindow } from './frameSampler';

/** How much play time each reported line covers. */
export const REPORT_INTERVAL_MS = 60_000;

/** The log tag every line carries, and what a dashboard filters on. */
export const PERF_LOG_TAG = 'perf';

/** What the reporter needs from the outside world, all injected. */
export interface PerfReportDeps {
  /** Where a finished line goes. `game/perfReporting.ts` passes the client logger's `log`. */
  emit: (line: string) => void;
  /** Measured refresh rate (`perf/displayRate.ts`), or null if it never answered. Read at
   *  REPORT time rather than captured: the probe finishes a second into the session, which is
   *  after the first window but before the first report. */
  displayHz: () => number | null;
  /** The render tier actually in force, which for `'auto'` is not the setting (`quality.ts`). */
  tier: () => string;
  /** The in-run frame rate the player asked for (`powerBudget.ts`). */
  frameCap: () => number;
  /** How long each reported line should cover. Injected for tests only. */
  intervalMs?: number;
}

/** The running total behind one line. */
interface Accumulator {
  windowMs: number;
  frames: number;
  longFrames: number;
  /** Worst single window's fps — the number a mean hides, and the one a player remembers. */
  worstFps: number;
  framePeak: number;
  updatePeak: number;
  renderPeak: number;
  busyPeak: number;
  p50Sum: number;
  windows: number;
}

function empty(): Accumulator {
  return {
    windowMs: 0, frames: 0, longFrames: 0, worstFps: Number.POSITIVE_INFINITY,
    framePeak: 0, updatePeak: 0, renderPeak: 0, busyPeak: 0, p50Sum: 0, windows: 0,
  };
}

/** One decimal, and never `"NaN"`/`"Infinity"` — a dashboard renders those as a gap that
 *  reads exactly like an outage, and this is a report about smoothness. */
function num(v: number): string {
  return Number.isFinite(v) ? v.toFixed(1) : '0.0';
}

/**
 * Aggregate closed windows and emit one logfmt line per {@link REPORT_INTERVAL_MS} of play.
 *
 * Feed it only windows from a live run — see `game/perfReporting.ts` for why a menu's windows
 * are not comparable and must not be mixed in.
 */
export class PerfReporter {
  private acc = empty();

  constructor(private readonly deps: PerfReportDeps) {}

  /** One closed window from a live run. */
  observe(w: FrameWindow): void {
    // A hidden tab's numbers are not this device's numbers (`FrameSampler.markHidden`), and a
    // report built from them would say the game runs at 3 fps on desktop Chrome. Neither
    // counted nor held against the interval: the window did not happen, as far as this is
    // concerned.
    if (w.discarded || w.frames === 0) return;

    const a = this.acc;
    a.windowMs += w.windowMs;
    a.frames += w.frames;
    a.longFrames += w.longFrameRatio * w.frames;
    a.worstFps = Math.min(a.worstFps, w.fps);
    a.framePeak = Math.max(a.framePeak, w.frame.max);
    a.updatePeak = Math.max(a.updatePeak, w.update.p95);
    a.renderPeak = Math.max(a.renderPeak, w.render.p95);
    a.busyPeak = Math.max(a.busyPeak, w.busyRatio);
    a.p50Sum += w.frame.p50;
    a.windows += 1;

    if (a.windowMs >= (this.deps.intervalMs ?? REPORT_INTERVAL_MS)) {
      this.deps.emit(this.format(a));
      this.acc = empty();
    }
  }

  /** Emit whatever is accumulated, however short it is, and start over. Called when a run
   *  ENDS: the most interesting minute of a session is usually the one it ended on, and a run
   *  that lasted 40 seconds would otherwise report nothing at all. */
  flush(): void {
    if (this.acc.windows === 0) return;
    this.deps.emit(this.format(this.acc));
    this.acc = empty();
  }

  private format(a: Accumulator): string {
    const hz = this.deps.displayHz();
    // Field names are short and stable: they are what a Grafana panel's `unwrap` clause
    // names, so renaming one silently empties a panel rather than breaking a build.
    return [
      `fps=${num((a.frames * 1000) / Math.max(1, a.windowMs))}`,
      `worst_fps=${num(a.worstFps)}`,
      // The headline. A percentage rather than a ratio because it is read by people on a
      // dashboard, and 2.9 is a number one can hold in mind where 0.029 is not.
      `long_pct=${num((100 * a.longFrames) / Math.max(1, a.frames))}`,
      `frame_p50=${num(a.p50Sum / Math.max(1, a.windows))}`,
      `frame_max=${num(a.framePeak)}`,
      `update_p95=${num(a.updatePeak)}`,
      `render_p95=${num(a.renderPeak)}`,
      `busy_peak=${num(a.busyPeak)}`,
      // `hz=0` means "never measured", and is distinguishable from every real display because
      // `displayRate.ts` refuses anything below 24. Reported rather than omitted so a panel
      // can count the sessions where the cap had to guess.
      `hz=${num(hz ?? 0)}`,
      `cap=${String(this.deps.frameCap())}`,
      `tier=${this.deps.tier()}`,
      `windows=${String(a.windows)}`,
      `span_s=${num(a.windowMs / 1000)}`,
    ].join(' ');
  }
}
