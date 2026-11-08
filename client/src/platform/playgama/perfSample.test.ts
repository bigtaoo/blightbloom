import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  browserPerfHost,
  installPerfSample,
  PERF_MIN_MS,
  PERF_WINDOW_MS,
  PerfSampler,
  type PerfSampleHost,
  type SampleData,
} from './perfSample';

afterEach(() => vi.unstubAllGlobals());

function sampler(now = () => 0) {
  const sent: SampleData[] = [];
  const s = new PerfSampler((d) => sent.push(d), '1.2.3+abc', now);
  return { s, sent };
}

/** `n` frames of `ms` each, all active. */
function play(s: PerfSampler, n: number, ms: number): void {
  for (let i = 0; i < n; i++) s.frame(ms, true);
}

describe('PerfSampler', () => {
  it('sends one sample per ~30 s of active play, in Playgama’s field names', () => {
    let t = 0;
    const { s, sent } = sampler(() => t);
    s.context = () => ({ q: 'high' });
    s.frame(20, true); // the first active frame only arms: the gap before it is not a frame
    // 1500 frames of 20 ms = 30 s, with 3 of them long hitches.
    for (let i = 0; i < 1500; i++) {
      const ms = i === 10 ? 120 : i === 20 ? 600 : i === 30 ? 1200 : 20;
      t += ms;
      s.frame(ms, true);
      if (sent.length) break;
    }
    expect(sent).toHaveLength(1);
    const d = sent[0]!;
    expect(d).toMatchObject({
      target_fps: 60,
      build_version: '1.2.3+abc',
      frame_time_p50_ms: 20,
      frame_time_max_ms: 1200,
      frames_over_50ms: 3,
      frames_over_100ms: 3,
      frames_over_250ms: 2,
      frames_over_500ms: 2,
      frames_over_1000ms: 1,
      q: 'high',
    });
    // 1404 frames of 20 ms plus the three hitches (120 + 600 + 1200) is exactly 30 000 ms.
    expect(d.frame_count).toBe(1407);
    expect(d.active_ms).toBe(PERF_WINDOW_MS);
    expect(d.window_ms).toBe(PERF_WINDOW_MS);
    expect(d.fps_p10).toBe(50);
    expect(d.fps_avg).toBe(46.9);
  });

  it('reports the target the entry wires, read per sample and rounded', () => {
    let t = 0;
    const { s, sent } = sampler(() => t);
    let target = 30;
    s.targetFps = () => target;
    s.frame(33, true); // arm
    const window = (): void => {
      for (let i = 0; i < 400; i++) {
        t += 33;
        s.frame(33, true);
      }
      s.flush(); // 13.2 s: over PERF_MIN_MS, so it is sent
    };
    window();
    target = 144 / 5; // a 144 Hz display at the 30 cap delivers 28.8
    window();
    expect(sent.map((d) => d.target_fps)).toEqual([30, 29]);
  });

  it('never counts the frame that spans a pause, a menu or a hidden tab', () => {
    const { s, sent } = sampler();
    play(s, 2, 16);
    s.frame(5000, false); // paused: leaving play flushes, but 16 ms is under the minimum
    s.frame(5000, true); // the frame that ends the pause arms again, it is not sampled
    play(s, Math.ceil(PERF_WINDOW_MS / 16), 16);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.frame_time_max_ms).toBe(16);
  });

  it('flushes a partial window of at least the minimum when play ends, and keeps a shorter one', () => {
    const { s, sent } = sampler();
    play(s, 1 + (PERF_MIN_MS - 1000) / 100, 100);
    s.frame(16, false);
    expect(sent).toHaveLength(0); // 9 s: kept
    s.frame(16, true);
    play(s, 20, 100); // +2 s → 11 s
    s.flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.frame_count).toBe(110);
    s.flush(); // nothing left
    expect(sent).toHaveLength(1);
  });

  it('counts long tasks only during play, and resets every counter per window', () => {
    const { s, sent } = sampler();
    s.longTask(300); // before play: ignored
    play(s, 2, 16);
    s.longTask(80);
    s.longTask(200);
    s.counts.js_error_count++;
    play(s, PERF_WINDOW_MS / 16, 16);
    expect(sent[0]).toMatchObject({ long_task_count: 2, long_task_total_ms: 280, long_task_max_ms: 200, js_error_count: 1 });
    expect(s.counts).toEqual({
      js_error_count: 0,
      unhandled_rejection_count: 0,
      webgl_context_loss_count: 0,
      long_task_count: 0,
      long_task_total_ms: 0,
      long_task_max_ms: 0,
    });
  });

  it('reads performance.now() by default', () => {
    const s = new PerfSampler(() => {}, 'v');
    expect(() => play(s, 3, 16)).not.toThrow();
  });
});

describe('installPerfSample', () => {
  function host(playing = true) {
    let tick: (t: { deltaMS: number }) => void = () => {};
    const handlers = new Map<string, () => void>();
    let longTask: (ms: number) => void = () => {};
    const state = { playing, hidden: false };
    const h: PerfSampleHost = {
      ticker: { add: (fn) => (tick = fn) },
      playing: () => state.playing,
      hidden: () => state.hidden,
      on: (target, type, fn) => handlers.set(`${target}:${type}`, fn),
      observeLongTasks: (fn) => (longTask = fn),
    };
    return { h, state, frame: (ms: number) => tick({ deltaMS: ms }), fire: (k: string) => handlers.get(k)!(), long: (ms: number) => longTask(ms) };
  }

  it('feeds the ticker’s frames, active only while playing and visible', () => {
    const x = host();
    const s = new PerfSampler(() => {}, 'v');
    const frame = vi.spyOn(s, 'frame');
    installPerfSample(x.h, s);
    x.frame(16);
    x.state.hidden = true;
    x.frame(16);
    x.state.hidden = false;
    x.state.playing = false;
    x.frame(16);
    expect(frame.mock.calls).toEqual([[16, true], [16, false], [16, false]]);
  });

  it('counts the page’s errors, lost contexts and long tasks, and flushes on pagehide and on hide', () => {
    const x = host();
    const s = new PerfSampler(() => {}, 'v');
    const flush = vi.spyOn(s, 'flush');
    installPerfSample(x.h, s);
    x.frame(16);
    x.frame(16);
    x.fire('window:error');
    x.fire('window:unhandledrejection');
    x.fire('canvas:webglcontextlost');
    x.long(90);
    expect(s.counts).toMatchObject({ js_error_count: 1, unhandled_rejection_count: 1, webgl_context_loss_count: 1, long_task_count: 1 });
    x.fire('window:pagehide');
    expect(flush).toHaveBeenCalledTimes(1);
    x.fire('document:visibilitychange'); // visible: no flush
    expect(flush).toHaveBeenCalledTimes(1);
    x.state.hidden = true;
    x.fire('document:visibilitychange');
    expect(flush).toHaveBeenCalledTimes(2);
  });
});

describe('browserPerfHost', () => {
  it('routes listeners to window, document and the canvas, and reads document.hidden', () => {
    const win = { addEventListener: vi.fn() };
    const doc = { addEventListener: vi.fn(), hidden: true };
    const canvas = { addEventListener: vi.fn() };
    vi.stubGlobal('window', win);
    vi.stubGlobal('document', doc);
    const h = browserPerfHost({ add: () => {} }, canvas, () => true);
    const fn = (): void => {};
    h.on('window', 'error', fn);
    h.on('document', 'visibilitychange', fn);
    h.on('canvas', 'webglcontextlost', fn);
    expect(win.addEventListener).toHaveBeenCalledWith('error', fn);
    expect(doc.addEventListener).toHaveBeenCalledWith('visibilitychange', fn);
    expect(canvas.addEventListener).toHaveBeenCalledWith('webglcontextlost', fn);
    expect(h.hidden()).toBe(true);
    expect(h.playing()).toBe(true);
  });

  it('observes long tasks where the browser has them, and shrugs where it does not', () => {
    let cb: (list: { getEntries(): { duration: number }[] }) => void = () => {};
    const observe = vi.fn();
    vi.stubGlobal(
      'PerformanceObserver',
      class {
        constructor(fn: typeof cb) {
          cb = fn;
        }
        observe = observe;
      },
    );
    const seen: number[] = [];
    browserPerfHost({ add: () => {} }, { addEventListener: () => {} }, () => true).observeLongTasks((ms) => seen.push(ms));
    cb({ getEntries: () => [{ duration: 70 }, { duration: 90 }] });
    expect(observe).toHaveBeenCalledWith({ type: 'longtask', buffered: false });
    expect(seen).toEqual([70, 90]);

    vi.stubGlobal(
      'PerformanceObserver',
      class {
        observe(): void {
          throw new TypeError('longtask unsupported');
        }
      },
    );
    expect(() => browserPerfHost({ add: () => {} }, { addEventListener: () => {} }, () => true).observeLongTasks(() => {})).not.toThrow();
  });
});
