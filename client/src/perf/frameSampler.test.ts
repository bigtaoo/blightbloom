import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { FrameSampler, LONG_FRAME_TOLERANCE, longFrameRatio, msStats, numFromStorage, FPS_WARN_KEY, BUSY_WARN_KEY, type FrameWindow, type FrameSamplerOptions } from './frameSampler';

// Node's own localStorage needs a --localstorage-file flag to exist at all, so the
// threshold-override paths are exercised against a stub rather than the host's. Stubbed
// per test (not once at module scope) so a test that never touches storage still runs
// against the real absent-storage path the WeChat build ships with.
function stubStorage(): Map<string, string> {
  const map = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  });
  return map;
}

/** Feed `n` frames of `ms` each. Returns nothing — the assertions read the callbacks. */
function feed(s: FrameSampler, n: number, ms: number, updateMs = 0, renderMs = 0): void {
  for (let i = 0; i < n; i++) s.frame(ms, updateMs, renderMs);
}

let storage: Map<string, string>;
beforeEach(() => {
  storage = stubStorage();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('msStats', () => {
  it('reports zeros for an empty window rather than NaN', () => {
    // A window can close with no frames at all (install lands mid-window). NaN here would
    // propagate into the overlay text and every threshold comparison downstream.
    expect(msStats([])).toEqual({ p50: 0, p95: 0, max: 0 });
  });

  it('does not mutate the caller array while sorting', () => {
    const samples = [30, 10, 20];
    msStats(samples);
    expect(samples).toEqual([30, 10, 20]);
  });

  it('reads percentiles off the sorted order, not insertion order', () => {
    const s = msStats([100, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
    expect(s.p50).toBe(1);
    expect(s.max).toBe(100);
    // The 100 is the single worst of ten: p95 has to land on it, or a once-a-window hitch
    // — the thing a player actually notices — averages away into a healthy-looking p50.
    expect(s.p95).toBe(100);
  });
});

describe('numFromStorage', () => {
  it('falls back for absent, unparseable and non-positive values', () => {
    storage.set('k.bad', 'abc');
    storage.set('k.zero', '0');
    storage.set('k.neg', '-4');
    expect(numFromStorage('k.missing', 7)).toBe(7);
    expect(numFromStorage('k.bad', 7)).toBe(7);
    expect(numFromStorage('k.zero', 7)).toBe(7);
    expect(numFromStorage('k.neg', 7)).toBe(7);
  });

  it('uses a stored positive override', () => {
    storage.set('k.ok', '12.5');
    expect(numFromStorage('k.ok', 7)).toBe(12.5);
  });
});

describe('FrameSampler windows', () => {
  it('closes a window once the accumulated frame time reaches the length, not the frame count', () => {
    // The window is a TIME window. Counting frames instead would make a stuttering client
    // (few, long frames) wait far longer for its first report than a healthy one.
    const windows: FrameWindow[] = [];
    const s = new FrameSampler({ windowMs: 1000, onWindow: (w) => windows.push(w) });
    feed(s, 4, 200);
    expect(windows).toHaveLength(0);
    feed(s, 1, 200);
    expect(windows).toHaveLength(1);
    expect(windows[0]!.frames).toBe(5);
    expect(windows[0]!.fps).toBeCloseTo(5, 5);
  });

  it('starts each window from empty — samples do not leak across the boundary', () => {
    const windows: FrameWindow[] = [];
    const s = new FrameSampler({ windowMs: 100, onWindow: (w) => windows.push(w) });
    feed(s, 1, 100, 0, 50); // window 1: one slow render
    feed(s, 1, 100, 0, 1); // window 2: a fast one
    expect(windows[0]!.render.max).toBe(50);
    expect(windows[1]!.render.max).toBe(1);
  });

  it('caps the per-window sample arrays without dropping the frame count', () => {
    // A pathological ticker must not let the profiler become the memory problem, but the
    // fps figure still has to reflect every frame that actually happened.
    const windows: FrameWindow[] = [];
    const s = new FrameSampler({ windowMs: 1000, maxSamples: 10, onWindow: (w) => windows.push(w) });
    feed(s, 1000, 1);
    expect(windows[0]!.frames).toBe(1000);
  });
});

describe('FrameSampler warnings', () => {
  const warns = (opts: FrameSamplerOptions = {}) => {
    const seen: string[] = [];
    const s = new FrameSampler({ ...opts, onWarn: (reason) => seen.push(reason) });
    return { s, seen };
  };

  it('stays quiet through fewer than `sustainWindows` consecutive slow windows', () => {
    const { s, seen } = warns({ windowMs: 100, sustainWindows: 3, fpsWarn: 25 });
    feed(s, 2, 50); // 2 frames per 100ms window = 20fps
    feed(s, 2, 50);
    expect(seen).toEqual([]);
  });

  it('warns once the slow windows are consecutive, then resets the streak', () => {
    const { s, seen } = warns({ windowMs: 100, sustainWindows: 3, fpsWarn: 25 });
    for (let i = 0; i < 3; i++) feed(s, 2, 50); // 20fps windows
    expect(seen).toHaveLength(1);
    for (let i = 0; i < 2; i++) feed(s, 2, 50);
    expect(seen).toHaveLength(1); // streak restarted after firing — no per-window spam
  });

  it('a single healthy window breaks the streak', () => {
    // The whole point of the sustain rule: a room transition inside an otherwise smooth
    // session must not accumulate toward a report.
    const { s, seen } = warns({ windowMs: 100, sustainWindows: 3, fpsWarn: 25 });
    feed(s, 2, 50);
    feed(s, 2, 50);
    feed(s, 10, 10); // 100fps
    feed(s, 2, 50);
    feed(s, 2, 50);
    expect(seen).toEqual([]);
  });

  it('names the expensive half of the frame in the message', () => {
    // A "low fps" line that does not say update-vs-render sends the reader back to the
    // browser to re-measure, which is the whole cost this port exists to remove.
    const { s, seen } = warns({ windowMs: 100, sustainWindows: 1, fpsWarn: 25 });
    feed(s, 2, 50, 1, 40);
    expect(seen[0]).toContain('render-bound');
    const b = warns({ windowMs: 100, sustainWindows: 1, fpsWarn: 25 });
    feed(b.s, 2, 50, 40, 1);
    expect(b.seen[0]).toContain('update-bound');
  });

  it('honours a localStorage fps threshold override', () => {
    const { s, seen } = warns({ windowMs: 100, sustainWindows: 1, fpsWarn: 25 });
    storage.set(FPS_WARN_KEY, '5');
    feed(s, 2, 50); // 20fps — under the default 25, over the override
    expect(seen).toEqual([]);
  });
});

describe('FrameSampler long-task path', () => {
  it('ignores long-task time entirely when the observer is unsupported', () => {
    // Without PerformanceObserver the accumulator is never fed, but a stray call must not
    // be able to synthesise a busy ratio out of nothing either.
    const windows: FrameWindow[] = [];
    const seen: string[] = [];
    const s = new FrameSampler({ windowMs: 100, onWindow: (w) => windows.push(w), onWarn: (r) => seen.push(r) });
    s.addLongTaskMs(100);
    feed(s, 10, 10);
    expect(windows[0]!.busyRatio).toBe(0);
    expect(seen).toEqual([]);
  });

  it('reports a saturated main thread from a single window, unlike the fps path', () => {
    const seen: string[] = [];
    const s = new FrameSampler({ windowMs: 100, sustainWindows: 99, onWarn: (r) => seen.push(r) });
    s.longTaskSupported = true;
    s.addLongTaskMs(80);
    feed(s, 10, 10); // 100fps: the fps path would never fire here
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('main thread busy 80%');
  });

  it('clamps the ratio at 1 when long tasks overlap the window boundary', () => {
    const windows: FrameWindow[] = [];
    const s = new FrameSampler({ windowMs: 100, onWindow: (w) => windows.push(w) });
    s.longTaskSupported = true;
    s.addLongTaskMs(500);
    feed(s, 10, 10);
    expect(windows[0]!.busyRatio).toBe(1);
  });

  it('honours a localStorage busy threshold override', () => {
    const seen: string[] = [];
    const s = new FrameSampler({ windowMs: 100, onWarn: (r) => seen.push(r) });
    s.longTaskSupported = true;
    storage.set(BUSY_WARN_KEY, '0.95');
    s.addLongTaskMs(80);
    feed(s, 10, 10);
    expect(seen).toEqual([]);
  });

  it('does not also fire the fps path in a window it already reported as busy', () => {
    const seen: string[] = [];
    const s = new FrameSampler({ windowMs: 100, sustainWindows: 1, fpsWarn: 25, onWarn: (r) => seen.push(r) });
    s.longTaskSupported = true;
    s.addLongTaskMs(90);
    feed(s, 2, 50); // both signals breach at once
    expect(seen).toHaveLength(1);
  });
});

describe('FrameSampler hidden-tab handling', () => {
  it('discards a window the tab was hidden during, even if it ended visible', () => {
    // The latch, not a sample at window end: a tab hidden mid-window and shown again
    // before the closing frame produced funny's original false stutter reports.
    const windows: FrameWindow[] = [];
    const seen: string[] = [];
    const s = new FrameSampler({ windowMs: 100, sustainWindows: 1, fpsWarn: 25, onWindow: (w) => windows.push(w), onWarn: (r) => seen.push(r) });
    s.markHidden();
    feed(s, 1, 100); // 10fps — would warn immediately if it counted
    expect(windows[0]!.discarded).toBe(true);
    expect(seen).toEqual([]);
  });

  it('resets the low-fps streak on a discarded window', () => {
    // Otherwise a tab returning from the background is one window away from a report it
    // did not earn.
    const seen: string[] = [];
    const s = new FrameSampler({ windowMs: 100, sustainWindows: 3, fpsWarn: 25, onWarn: (r) => seen.push(r) });
    feed(s, 2, 50);
    feed(s, 2, 50);
    s.markHidden();
    feed(s, 2, 50);
    feed(s, 2, 50);
    expect(seen).toEqual([]);
  });

  it('keeps discarding while the tab is still hidden at window close', () => {
    const windows: FrameWindow[] = [];
    const s = new FrameSampler({ windowMs: 100, onWindow: (w) => windows.push(w) });
    s.isHiddenNow = () => true;
    s.markHidden();
    feed(s, 1, 100);
    feed(s, 1, 100);
    expect(windows.map((w) => w.discarded)).toEqual([true, true]);
  });

  it('stops discarding once the tab is visible again', () => {
    const windows: FrameWindow[] = [];
    const s = new FrameSampler({ windowMs: 100, onWindow: (w) => windows.push(w) });
    s.isHiddenNow = () => false;
    s.markHidden();
    feed(s, 1, 100);
    feed(s, 1, 100);
    expect(windows.map((w) => w.discarded)).toEqual([true, false]);
  });
});

describe('FrameSampler frame split', () => {
  it('carries the update/render split into the window percentiles', () => {
    const windows: FrameWindow[] = [];
    const s = new FrameSampler({ windowMs: 100, onWindow: (w) => windows.push(w) });
    for (let i = 0; i < 10; i++) s.frame(10, 2, 6);
    expect(windows[0]!.update.p50).toBe(2);
    expect(windows[0]!.render.p50).toBe(6);
    expect(windows[0]!.frame.p50).toBe(10);
  });

  it('defaults the split to zero when the host does not instrument it', () => {
    const windows: FrameWindow[] = [];
    const s = new FrameSampler({ windowMs: 100, onWindow: (w) => windows.push(w) });
    for (let i = 0; i < 10; i++) s.frame(10);
    expect(windows[0]!.update.p50).toBe(0);
    expect(windows[0]!.render.p50).toBe(0);
    expect(windows[0]!.fps).toBeCloseTo(100, 5);
  });
});

// ---- the judder metric, through the real sampler (2026-09-22) ----
//
// Added after a mutation battery: `longFrameRatio` read 100% line and branch coverage and was
// asserted by nothing. Three mutants survived — measuring against 0 instead of the median,
// measuring the UPDATE series instead of the frame series, and counting a frame exactly at the
// limit — because every existing case in this file runs the line and looks at other fields.
// Coverage says a line ran; only an assertion says it was right.

describe('FrameSampler judder (longFrameRatio)', () => {
  /** Close ONE window holding exactly `frames`, and hand it back.
   *
   *  The window length is the sum, so the sampler closes on the last frame and not before:
   *  a shorter one closes after every frame, each window holds a single sample, and every
   *  ratio below would be 0 for a reason that has nothing to do with the metric. */
  function windowOf(frames: readonly number[], update = 0, render = 0): FrameWindow {
    let closed: FrameWindow | null = null;
    const total = frames.reduce((a, b) => a + b, 0);
    const s = new FrameSampler({ windowMs: total, onWindow: (w) => { closed = w; } });
    for (const ms of frames) s.frame(ms, update, render);
    return closed!;
  }

  it('is zero for a steady frame, at any rate', () => {
    expect(windowOf(Array(60).fill(16.7)).longFrameRatio).toBe(0);
    // 30 fps is a different complaint, and `fps` is the field for it. A metric that read
    // "everything below 60" as judder would make the two indistinguishable on the dashboard.
    const slow = windowOf(Array(60).fill(33.3));
    expect(slow.longFrameRatio).toBe(0);
    expect(slow.fps).toBeLessThan(35);
  });

  it('counts the doubled frames and nothing else', () => {
    // The shipped 60 Hz case from the 2026-09-22 report: three frames in sixty lasting two
    // display intervals instead of one, the rest jittering by tenths of a millisecond.
    const frames = Array.from({ length: 60 }, (_, i) => (i % 20 === 0 ? 33.3 : 16.7 + (i % 3) * 0.2));
    expect(windowOf(frames).longFrameRatio).toBeCloseTo(3 / 60, 5);
  });

  it('is scale-free: the same 50 ms frame is judder in one window and ordinary in another', () => {
    // The property the whole metric rests on, stated as the one comparison that can express
    // it. A fixed threshold ("longer than 20 ms") would answer these two identically and would
    // call every 30 fps device permanently juddering.
    expect(windowOf([...Array(59).fill(16.7), 50]).longFrameRatio).toBeCloseTo(1 / 60, 5);
    expect(windowOf(Array(60).fill(50)).longFrameRatio).toBe(0);
  });

  it('measures the FRAME series, not the update or render one', () => {
    // Every frame long, but the update cost inside them is flat. A metric computed over the
    // wrong series reports 0 here, which is the shape of the second surviving mutant.
    const frames = Array.from({ length: 60 }, (_, i) => (i % 10 === 0 ? 40 : 16.7));
    const w = windowOf(frames, 1, 1);
    expect(w.longFrameRatio).toBeCloseTo(6 / 60, 5);
    // ...and the control: the update series really is flat, so a metric computed over it
    // would have to report 0 — which is exactly what the surviving mutant did.
    expect(w.update.p50).toBe(1);
    expect(w.update.max).toBe(1);
  });

  it('does not count a frame exactly at the tolerance', () => {
    // `>` and not `>=`: the limit is the first length that is NOT ordinary, so a frame landing
    // exactly on it is the last ordinary one. Reachable only with whole numbers, which is why
    // this uses 16 rather than 16.7 — a case built from realistic values cannot express it.
    const at = windowOf([...Array(59).fill(16), 16 * (1 + LONG_FRAME_TOLERANCE)]);
    expect(at.longFrameRatio).toBe(0);
    const past = windowOf([...Array(59).fill(16), 16 * (1 + LONG_FRAME_TOLERANCE) + 0.01]);
    expect(past.longFrameRatio).toBeCloseTo(1 / 60, 5);
  });

  it('is 0 and never NaN for a window that closed without a frame', () => {
    // A NaN travels all the way to a Grafana panel as a gap, which reads like an outage.
    expect(longFrameRatio([], 16.7)).toBe(0);
    expect(longFrameRatio([1, 2, 3], 0)).toBe(0);
  });
});

describe('FrameSampler regression guards', () => {
  it('never divides by zero when every frame reports a zero delta', () => {
    // A ticker that hands out 0ms deltas (a paused/stepped host, or a clock with no
    // sub-ms resolution) must not turn the window into Infinity/NaN.
    const windows: FrameWindow[] = [];
    const s = new FrameSampler({ windowMs: 0, onWindow: (w) => windows.push(w) });
    s.frame(0, 0, 0);
    expect(Number.isFinite(windows[0]!.fps)).toBe(true);
    expect(Number.isFinite(windows[0]!.busyRatio)).toBe(true);
  });

  it('reports the window even while discarding it, so the overlay can say why it is blank', () => {
    const spy = vi.fn();
    const s = new FrameSampler({ windowMs: 100, onWindow: spy });
    s.markHidden();
    feed(s, 1, 100);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
