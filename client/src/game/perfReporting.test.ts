/**
 * Frame-pacing telemetry, from a closed window to a line in the ring buffer (2026-09-22) —
 * the WIRING half. `perf/perfReport.test.ts` covers the aggregation and the wire format, and
 * nothing in it can tell whether a window ever reaches the reporter, or whether the ones that
 * reach it are the right ones.
 *
 * Both halves of that are easy to get silently wrong and neither goes red:
 *
 *  - **Reporting the wrong windows.** Idle phases are capped at `IDLE_MAX_FPS` on purpose, so
 *    every menu window reports ~30 fps. Mixed into the same stream, the dashboard's fps panel
 *    would track how long players spend in the forge rather than how the game runs.
 *  - **Reading the phase from something that does not move.** The reporter is driven from the
 *    perf monitor's window callback, which knows about frames and nothing about phases, so it
 *    asks `analyticsTracking`'s mirror. If that mirror were only maintained when analytics is
 *    installed, every window in a host without it would read as "not in a run" and the
 *    telemetry would be empty rather than wrong — which is why the last case here installs
 *    nothing at all.
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import { defaultPerfWindowReporter, routePerfWindow } from './perfReporting';
import { reportFrame, resetAnalyticsTrackingForTests, lastRenderedPhase } from './analyticsTracking';
import { resetClientLog, installClientLog } from '../net/clientLogInstall';
import { PERF_LOG_TAG } from '../perf/perfReport';
import type { FrameWindow } from '../perf/frameSampler';
import type { Phase } from './phase';

afterEach(() => {
  resetAnalyticsTrackingForTests();
  resetClientLog();
});

function win(over: Partial<FrameWindow> = {}): FrameWindow {
  return {
    fps: 60, frames: 120, windowMs: 2000, busyRatio: 0,
    frame: { p50: 16.7, p95: 17, max: 20 },
    longFrameRatio: 0.02,
    update: { p50: 0.6, p95: 1, max: 3 },
    render: { p50: 2.1, p95: 4, max: 9 },
    discarded: false,
    ...over,
  };
}

/** A real installed logger whose ring can be read back — the same object production uses, so
 *  the level and the tag asserted below are the ones that would actually reach Loki. Nothing
 *  here flushes, so no request is ever made. */
function captureLog(): () => { level: string; tag?: string; msg: string }[] {
  const logger = installClientLog({
    baseUrl: 'https://bb.example',
    fetchImpl: (() => Promise.resolve(new Response('{}'))) as unknown as typeof fetch,
    setIntervalImpl: () => 1,
    clearIntervalImpl: () => {},
  });
  return () => logger.snapshot().filter((e) => e.tag === PERF_LOG_TAG).map((e) => ({ level: e.level, tag: e.tag, msg: e.msg }));
}

/** Put the phase mirror where a rendered frame would have put it. */
function renderFrameIn(phase: Phase): void {
  reportFrame(phase, null);
}

describe('routePerfWindow', () => {
  it('sends a run window to the reporter and ends the report on anything else', () => {
    const sink = { observe: vi.fn(), flush: vi.fn() };
    routePerfWindow(sink, true, win());
    expect(sink.observe).toHaveBeenCalledTimes(1);
    expect(sink.flush).not.toHaveBeenCalled();

    routePerfWindow(sink, false, win());
    expect(sink.observe).toHaveBeenCalledTimes(1);
    expect(sink.flush).toHaveBeenCalledTimes(1);
  });

  it('ignores a window that is only the watchdog\'s three fields', () => {
    // `installPerf`'s own callers hand over a full `FrameWindow`, but the shape the quality
    // watchdog accepts is three fields wide and a caller is free to build exactly that. The
    // field tested for is the one the report is FOR, so this is a shape check rather than a
    // defensive one — and without it the report would carry `undefined` into its arithmetic
    // and emit `NaN`, which a dashboard renders as a gap.
    const sink = { observe: vi.fn(), flush: vi.fn() };
    routePerfWindow(sink, true, { fps: 60, frames: 120, discarded: false });
    expect(sink.observe).not.toHaveBeenCalled();
    expect(sink.flush).not.toHaveBeenCalled();
  });
});

describe('the wired reporter', () => {
  it('reports a minute of PLAY through the client logger, at info level under the perf tag', () => {
    const lines = captureLog();
    const report = defaultPerfWindowReporter();
    renderFrameIn('playing');
    for (let i = 0; i < 30; i++) report(win());

    expect(lines()).toHaveLength(1);
    // `info`, not `warn`: a frame-rate report is not a failure, and putting it on the level the
    // error panels filter by would make both harder to read.
    expect(lines()[0]!.level).toBe('info');
    expect(lines()[0]!.msg).toMatch(/^fps=\d/);
    expect(lines()[0]!.msg).toContain('long_pct=2.0');
  });

  it('reports NOTHING from a menu, however many windows go by', () => {
    const lines = captureLog();
    const report = defaultPerfWindowReporter();
    renderFrameIn('forge');
    for (let i = 0; i < 120; i++) report(win({ fps: 30, frames: 60 }));
    expect(lines()).toHaveLength(0);
  });

  it('sends the part-minute a run ended on, on the first window after it ended', () => {
    const lines = captureLog();
    const report = defaultPerfWindowReporter();
    renderFrameIn('playing');
    for (let i = 0; i < 5; i++) report(win()); // 10s, well short of a report
    expect(lines()).toHaveLength(0);

    renderFrameIn('victory');
    report(win());
    expect(lines()).toHaveLength(1);
    expect(lines()[0]!.msg).toContain('span_s=10.0'); // the run's 10s, not the menu window's 2

    // ...and it does not keep reporting for every menu window after that.
    for (let i = 0; i < 20; i++) report(win());
    expect(lines()).toHaveLength(1);
  });

  it('reads the phase per WINDOW, not once at install', () => {
    const lines = captureLog();
    renderFrameIn('menu');
    const report = defaultPerfWindowReporter(); // built while the player is in the lobby
    renderFrameIn('playing');
    for (let i = 0; i < 30; i++) report(win());
    expect(lines()).toHaveLength(1);
  });

  it('follows the phase mirror in a host that never installed analytics', () => {
    // `reportFrame` sets the mirror unconditionally and only its `track` calls no-op, so this
    // passes for the right reason — and would fail loudly if that ever stopped being true.
    expect(lastRenderedPhase()).toBe(null);
    renderFrameIn('playing');
    expect(lastRenderedPhase()).toBe('playing');
  });

  it('survives a host with no logger installed at all', () => {
    // A tool, a sim harness, or a boot that failed before `installClientLog`. The reporter
    // resolves the logger per line for exactly this reason.
    const report = defaultPerfWindowReporter();
    renderFrameIn('playing');
    expect(() => {
      for (let i = 0; i < 31; i++) report(win());
    }).not.toThrow();
  });
});
