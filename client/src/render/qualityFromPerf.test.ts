/**
 * The auto-downgrade against the REAL perf pipeline (2026-08-25).
 *
 * `qualityWatchdog.test.ts` covers the policy, but every window it feeds is a hand-written
 * `{ fps, frames, discarded }` literal — and that is the shape of the dominant survivor cause
 * recorded in this repo: the fixture made two different things equal. If the real `FrameWindow`
 * computed `fps` differently, named `frames` something else, or never set `discarded` on the
 * windows it actually delivers, every one of those tests would still pass and no device would
 * ever downgrade.
 *
 * So there is not a single hand-made window in this file. Every window here comes out of a real
 * `FrameSampler` inside a real `PerfMonitor`, driven by a real `Ticker`, delivered through the
 * real `installPerf({ onSnapshot })` seam — the same expression both entries use:
 *
 *     installPerf(app, { onSnapshot: (s) => game.observePerfWindow(s.window) })
 *
 * That expression is otherwise untested in both `main.ts` and `main.wechat.ts`, neither of which
 * has a test file (they kick off a real `boot()` on import). A watchdog wired to a stream that
 * never reaches it is precisely design/04 item 12's failure mode: a system that works perfectly
 * and is connected to nothing.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { Container, Ticker, UPDATE_PRIORITY } from 'pixi.js';
import { installPerf, type InstalledPerf, type PerfSnapshot } from '../perf';
import { QualityWatchdog } from './qualityWatchdog';
import { FRAME_RATE_SETTINGS, IDLE_MAX_FPS } from '../game/powerBudget';

let installed: InstalledPerf | null = null;
afterEach(() => {
  installed?.uninstall();
  installed = null;
});

/** The pieces of `Application` the monitor touches — same shape as `perf/index.test.ts`'s. */
function fakeApp() {
  const ticker = new Ticker();
  ticker.autoStart = false;
  const stage = new Container();
  const gl: Record<string, unknown> = {
    drawArrays: () => {}, useProgram: () => {}, bindTexture: () => {}, bindFramebuffer: () => {},
  };
  const renderer = {
    gl,
    screen: { width: 800, height: 600 },
    texture: { _managedTextures: { items: {} } },
    render() {},
  };
  ticker.add(() => renderer.render(), null, UPDATE_PRIORITY.LOW);
  ticker.update(1000); // prime, so the first measured frame is not the clamped initial one
  return { ticker, app: { ticker, stage, renderer } as never };
}

/** Advance the real ticker by `frames` steps of `stepMs`, i.e. run the game at 1000/stepMs fps. */
function play(ticker: Ticker, frames: number, stepMs: number, startAt = 1000): number {
  let t = startAt;
  for (let i = 0; i < frames; i++) {
    t += stepMs;
    ticker.update(t);
  }
  return t;
}

/** Wire the real monitor to a real watchdog exactly as the entries wire it to `Game`. */
function harness(watchdog = new QualityWatchdog()) {
  const { ticker, app } = fakeApp();
  const windows: PerfSnapshot['window'][] = [];
  let downgrades = 0;
  installed = installPerf(app, {
    onSnapshot: (s) => {
      windows.push(s.window);
      if (watchdog.observe(s.window)) downgrades++;
    },
  });
  return { ticker, windows, watchdog, downgrades: () => downgrades, perf: installed };
}

describe('the real perf stream drives the real watchdog', () => {
  it('delivers windows at all, and a 60fps device never trips', () => {
    // The premise every other case rests on. A pipeline that delivered NOTHING would make the
    // "does not downgrade" assertion below pass for the wrong reason.
    const h = harness();
    play(h.ticker, 400, 16); // ~6.4s of 62fps -> three closed windows
    expect(h.windows.length).toBeGreaterThanOrEqual(3);
    expect(h.downgrades()).toBe(0);
    expect(h.watchdog.downgrades).toBe(0);
  });

  it('the window the sampler really produces carries the three fields the watchdog reads', () => {
    // The fixture-parity check. Named fields, real types, and `fps` actually reflecting the
    // frame rate that was played — not merely "some number is present".
    const h = harness();
    play(h.ticker, 400, 16);
    const w = h.windows[0]!;
    expect(typeof w.fps).toBe('number');
    expect(typeof w.frames).toBe('number');
    expect(typeof w.discarded).toBe('boolean');
    expect(w.fps).toBeGreaterThan(50);
    expect(w.fps).toBeLessThan(70);
    expect(w.frames).toBeGreaterThan(5);
    expect(w.discarded).toBe(false);
  });

  it('trips on a device that really is running at 10fps', () => {
    const h = harness();
    // 100ms per frame. The sampler's window is 2s, so ~20 real frames close each window.
    play(h.ticker, 100, 100);
    expect(h.windows.length).toBeGreaterThanOrEqual(3);
    expect(h.windows.every((w) => w.fps < 25)).toBe(true);
    expect(h.watchdog.downgrades).toBeGreaterThanOrEqual(1);
    // Bounded by the ladder (high -> medium -> low), not once per slow window: this run closes
    // far more slow windows than there are rungs to step down.
    expect(h.downgrades()).toBeLessThanOrEqual(2);
  });

  it('needs the streak — two real slow windows are not enough', () => {
    const h = harness(new QualityWatchdog({ sustainWindows: 3 }));
    play(h.ticker, 40, 100); // ~4s -> two closed windows
    expect(h.windows.length).toBe(2);
    expect(h.watchdog.downgrades).toBe(0);
  });

  it('ignores a window the sampler marks discarded, even though it is delivered and slow', () => {
    // This is the load-bearing half of the `discarded` guard, and it can only be checked against
    // the real sampler: discarded windows ARE still handed to `onWindow` (frameSampler.ts says so
    // explicitly — they exist for the overlay), so they really do arrive at the watchdog in
    // production. A hidden tab has throttled rAF and reports single-digit fps on hardware that is
    // perfectly healthy; counting those would downgrade every player who alt-tabbed.
    const h = harness(new QualityWatchdog({ sustainWindows: 2 }));
    const sampler = h.perf.monitor.sampler;
    let t = 1000;
    for (let i = 0; i < 2; i++) {
      sampler.markHidden();
      t = play(h.ticker, 20, 100, t); // a slow window, but hidden
    }
    expect(h.windows.length).toBe(2);
    expect(h.windows.every((w) => w.discarded)).toBe(true);
    expect(h.windows.every((w) => w.fps < 25)).toBe(true);
    expect(h.watchdog.downgrades).toBe(0);

    // ...and the same number of VISIBLE slow windows does trip it, so the case above is the
    // `discarded` flag doing the work and not the streak simply never being reached.
    play(h.ticker, 40, 100, t);
    expect(h.watchdog.downgrades).toBeGreaterThanOrEqual(1);
  });
});

/**
 * The frame CAP (`game/powerBudget.ts`, 2026-09-08) against this same watchdog — two systems
 * reading one number, in opposite directions.
 *
 * `powerBudget` deliberately renders fewer frames to save battery; the watchdog reads the frames
 * that come out and downgrades the renderer when there are too few. Nothing connects them, so a
 * cap set below the watchdog's floor would quietly make every player who chose it lose the
 * scene lighting as well — a battery setting with a hidden second effect, and no error anywhere.
 * The unit version of this check lives in `game/powerBudget.test.ts` and feeds the watchdog a
 * literal `fps: 30`. This one asks the REAL sampler what a capped game actually measures, which
 * is the number that decides it (Pixi's cap gate truncates, so a 30 cap does not deliver a clean
 * 30.000 and the margin to the floor is not exactly what arithmetic says).
 */
describe('the frame caps stay clear of the downgrade floor, measured', () => {
  const CAPS = [...FRAME_RATE_SETTINGS, IDLE_MAX_FPS];

  it.each(CAPS)('a game running at the %i fps cap never downgrades', (cap) => {
    const h = harness();
    // ~10s at exactly the capped rate — well past the 3-window streak, and long enough that a
    // borderline reading would have three chances to fire.
    play(h.ticker, Math.round(cap * 10), 1000 / cap);
    expect(h.windows.length).toBeGreaterThanOrEqual(3);
    expect(h.windows.every((w) => !w.discarded)).toBe(true);
    expect(h.watchdog.downgrades).toBe(0);
    expect(h.downgrades()).toBe(0);
  });

  it('reports each capped rate back as roughly the rate itself', () => {
    // The control for the case above: if the sampler read every one of these as 60, the
    // "never downgrades" result would be about the fixture and not about the cap. It also
    // pins the direction — a cap must not measure BELOW itself by any meaningful margin.
    for (const cap of CAPS) {
      const h = harness();
      play(h.ticker, Math.round(cap * 10), 1000 / cap);
      const fps = h.windows.map((w) => w.fps);
      for (const f of fps) {
        expect(f, `${cap} cap read ${f}`).toBeGreaterThan(cap - 2);
        expect(f, `${cap} cap read ${f}`).toBeLessThan(cap + 2);
      }
      h.perf.uninstall();
    }
  });

  it('a rate below the floor WOULD downgrade — the margin is real, not assumed', () => {
    // The negative control, and the reason `IDLE_MAX_FPS`/`FRAME_RATE_SETTINGS` may not simply
    // be lowered when someone next wants more battery back: 20 fps is a perfectly reasonable-
    // looking cap and it costs the player their renderer.
    const h = harness();
    play(h.ticker, 200, 1000 / 20);
    expect(h.watchdog.downgrades).toBeGreaterThanOrEqual(1);
  });
});
