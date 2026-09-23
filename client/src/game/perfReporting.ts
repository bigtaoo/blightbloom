// The browser half of frame-pacing telemetry (2026-09-22): builds a `PerfReporter` wired to
// the client logger, the display probe, the quality tier and the frame cap. `perf/perfReport.ts`
// holds the aggregation and the wire format and touches none of them.
//
// Why this lives under `game/` and is driven from `Game.observePerfWindow` rather than from
// `installPerf` like the rest of the perf system: the reporter must see windows from a LIVE RUN
// and no others, and `Game` is the only thing that knows which is which. Mixing them would not
// be a small inaccuracy — an idle screen is capped at `IDLE_MAX_FPS` on purpose, so every menu
// window reports ~30 fps, and a dashboard fed both would show a frame rate that tracks how long
// players spend in the forge. There is also a second, quieter reason: judder on a static menu
// panel is not observable by anyone, so a report of it is noise in the one metric this exists
// to carry.
import { PerfReporter, PERF_LOG_TAG, type PerfReportDeps } from '../perf/perfReport';
import type { FrameWindow } from '../perf/frameSampler';
import { clientLog } from '../net/clientLogInstall';
import { activeDisplayHz, activePlayFrameCap } from './powerBudget';
import { lastRenderedPhase } from './analyticsTracking';
import { activeQuality } from '../render/quality';

/** The window shape this needs — narrowed per CLAUDE.md rather than taking `PerfSnapshot`. */
export type PerfWindowForReport = FrameWindow;

export function createPerfReporter(overrides: Partial<PerfReportDeps> = {}): PerfReporter {
  return new PerfReporter({
    // Resolved per line, not captured: the logger is installed before the perf system on every
    // entry point, but a test may install neither, and a reporter that captured `null` once
    // would stay silent for the rest of the session. `?.` rather than a guard, so a host with
    // no logger at all (a tool, a sim harness) costs one property read per minute.
    emit: (line) => clientLog()?.log('info', PERF_LOG_TAG, line),
    displayHz: activeDisplayHz,
    frameCap: activePlayFrameCap,
    // The tier in force, which for `'auto'` is not the setting — a device the watchdog
    // downgraded is exactly the device whose numbers need reading in that light.
    tier: () => activeQuality().tier,
    ...overrides,
  });
}

/** The two methods `routePerfWindow` needs. Narrowed per CLAUDE.md rather than taking the
 *  whole `PerfReporter`, so a test can hand over two spies. */
export interface PerfWindowSink {
  observe(w: FrameWindow): void;
  flush(): void;
}

/**
 * Send one closed window to the reporter, or end the current report — the whole of the
 * "which windows count" policy, in one place.
 *
 * Split out of `Game.observePerfWindow` rather than left inline (CLAUDE.md's 500-line
 * convention, form (1) — an independent function). It earns the move on its own terms too:
 * the decision is three rules deep and every one of them fails silently.
 *
 * 1. **Only a live run reports.** See this file's header.
 * 2. **`'longFrameRatio' in w` is a shape check, not a guard.** `Game.observePerfWindow`
 *    takes `FrameWindowLike` — the three fields the quality watchdog needs — and a caller is
 *    free to hand over exactly those. The field being tested for is the one the report is
 *    FOR, which is what makes the check honest rather than defensive.
 * 3. **The end of a run flushes.** Driven off the NEXT window rather than off a run-end
 *    callback deliberately: there are several ways a run ends (death, victory, abandon, a
 *    disconnect, the pause menu's quit) and wiring each one is the shape of bug where the one
 *    path nobody remembered is the one that reports nothing. A window closes every 2s
 *    regardless, and `flush` is a no-op when there is nothing accumulated.
 *
 *    The case this does NOT cover is the player closing the tab mid-run: the client logger
 *    flushes its ring on `pagehide`, but a minute that was never formatted is not in the ring
 *    to flush. A known gap rather than an oversight — an exit flush would have to reach from a
 *    DOM event back into `Game`, and what it buys is the last <60s of sessions that end that
 *    way.
 */
export function routePerfWindow(sink: PerfWindowSink, playing: boolean, w: object): void {
  if (!('longFrameRatio' in w)) return;
  if (playing) sink.observe(w as FrameWindow);
  else sink.flush();
}

/**
 * The default `reportWindow` hook `installPerf` uses — a reporter, plus the phase test that
 * decides which windows reach it.
 *
 * Built here and handed to `perf/index.ts` rather than the other way round, because the phase
 * is a `game/` concept and the perf system deliberately knows nothing about the game. Wired
 * inside `installPerf` rather than at the three entry points for the reason this project has
 * already paid for once: a per-entry pin only exists where somebody thought of it, and a build
 * target that silently reports nothing looks exactly like a build target nobody plays on
 * (design/19 §10, `clientLog`'s `host` label).
 */
export function defaultPerfWindowReporter(): (w: FrameWindow) => void {
  const reporter = createPerfReporter();
  return (w) => routePerfWindow(reporter, lastRenderedPhase() === 'playing', w);
}
