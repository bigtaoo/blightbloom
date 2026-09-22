/**
 * The per-phase power budget (`powerBudget.ts`, 2026-09-08).
 *
 * Two things are being pinned, and they fail in different ways:
 *
 *  - the POLICY (which phases draw the world, what each phase's frame-rate cap is), as an
 *    exhaustive `Record<Phase, …>` so that adding a phase to `phase.ts` does not compile
 *    until someone has decided whether it shows the world. A list would have let a new
 *    phase default silently to "no world", which is the visible failure of the two;
 *  - the CAP ITSELF, against the real `pixi.js` `Ticker`. `maxFPS` is not a number Pixi
 *    stores and honours: it becomes `_minElapsedMS`, and the gate that reads it truncates
 *    the elapsed time to an integer (`currentTime - this._lastFrame | 0`). A cap of 60 on a
 *    60 Hz display therefore has an obvious way to go wrong — 16 < 16.667 skips the frame —
 *    which would halve the frame rate of every player on the platform we were trying to
 *    help. That is not a claim about our code, so nothing in this repo would have caught it;
 *    it needs the real ticker driven with real timestamps.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { Ticker } from 'pixi.js';
import type { Phase } from './phase';
import { QualityWatchdog } from '../render/qualityWatchdog';
import type { FrameRateSetting } from './powerBudget';
import {
  FRAME_RATE_SETTINGS,
  IDLE_MAX_FPS,
  PLAY_MAX_FPS,
  GATE_EPSILON_MS,
  activeDisplayHz,
  activePlayFrameCap,
  applyPowerBudget,
  maxFpsForPhase,
  resetDisplayHz,
  resetPlayFrameCap,
  setDisplayHz,
  setPlayFrameCap,
  tickerCapFor,
  worldDrawnInPhase,
} from './powerBudget';

// The play cap is a module mirror (same shape as `render/quality.ts`'s), so one case's pick
// would otherwise leak into the next — and the leak would be invisible, since both values are
// legal.
afterEach(() => {
  resetPlayFrameCap();
  resetDisplayHz();
});

/** Every phase, with the answer for each. A `Record` and not an array on purpose: a new
 *  member of the `Phase` union is a type error here until it is given a row. */
const DRAWS_WORLD: Record<Phase, boolean> = {
  playing: true,
  menu: false,
  loadout: false,
  forge: false,
  pvpPreview: false,
  matchmaking: false,
  paused: false,
  victory: false,
  defeat: false,
  settings: false,
  squad: false,
  account: false,
  store: false,
};

const ALL_PHASES = Object.keys(DRAWS_WORLD) as Phase[];

describe('worldDrawnInPhase', () => {
  it('draws the world in exactly one phase', () => {
    for (const phase of ALL_PHASES) {
      expect(worldDrawnInPhase(phase), phase).toBe(DRAWS_WORLD[phase]);
    }
    // The count is asserted separately from the table so that flipping a row to `true`
    // without meaning to (a merge, a copy-paste) fails here rather than passing quietly.
    expect(ALL_PHASES.filter(worldDrawnInPhase)).toEqual(['playing']);
  });
});

describe('maxFpsForPhase', () => {
  it('caps a run at the play rate and every other screen lower', () => {
    expect(maxFpsForPhase('playing')).toBe(PLAY_MAX_FPS);
    for (const phase of ALL_PHASES.filter((p) => p !== 'playing')) {
      expect(maxFpsForPhase(phase), phase).toBe(IDLE_MAX_FPS);
    }
  });

  it('never returns 0, which is Pixi for "no cap at all"', () => {
    // The bug being fixed was a `maxFPS` of 0 (`Ticker`'s default): a 120 Hz panel then
    // renders at 120. A phase that resolved to 0 here would silently restore it.
    for (const phase of ALL_PHASES) expect(maxFpsForPhase(phase)).toBeGreaterThan(0);
    expect(IDLE_MAX_FPS).toBeLessThan(PLAY_MAX_FPS);
  });

  it('stays above Pixi\'s default minFPS, or capping would also loosen the catch-up clamp', () => {
    // `Ticker.maxFPS`'s setter lowers `minFPS` to match when the cap is below it, and
    // `minFPS` is what bounds `deltaMS` after a stall (100 ms by default). An idle cap of,
    // say, 5 fps would quietly widen that to 200 ms for the whole session, including the
    // run that follows.
    const ticker = new Ticker();
    try {
      const before = ticker.minFPS;
      ticker.maxFPS = IDLE_MAX_FPS;
      expect(ticker.minFPS).toBe(before);
      ticker.maxFPS = PLAY_MAX_FPS;
      expect(ticker.minFPS).toBe(before);
    } finally {
      ticker.destroy();
    }
  });
});

describe('the play-cap mirror', () => {
  it('starts at the play rate, so a host that never wires the setting is uncapped-safe', () => {
    expect(activePlayFrameCap()).toBe(PLAY_MAX_FPS);
    expect(maxFpsForPhase('playing')).toBe(PLAY_MAX_FPS);
  });

  it('caps a run at whatever the player picked', () => {
    setPlayFrameCap(30);
    expect(activePlayFrameCap()).toBe(30);
    expect(maxFpsForPhase('playing')).toBe(30);
  });

  it('never lets an idle screen cost MORE frames than the run does', () => {
    // A player who asked for 30 in a fight has not asked for 30 in a menu, and a menu drawing
    // more frames than the game would be an absurd place to spend the battery they were
    // trying to save. The idle cap is a ceiling, not a target.
    //
    // The cast is the point, and it is why this case had to be rewritten: the lowest OFFERED
    // rate is 30, which is `IDLE_MAX_FPS` exactly, so every assertion made from a legal value
    // passes whether `maxFpsForPhase` takes the `min` or ignores it — a mutation battery
    // (2026-09-08) killed 13 of 15 mutants here and this was one of the two survivors, for
    // precisely the reason this repo's notes name as the dominant survivor cause: the fixture
    // made two different things equal. A rate BELOW the idle cap is exactly what the `min`
    // exists for, so the guard has to reach a state the type does not offer yet.
    setPlayFrameCap(15 as FrameRateSetting);
    expect(maxFpsForPhase('playing')).toBe(15);
    expect(maxFpsForPhase('menu')).toBe(15);
    expect(maxFpsForPhase('forge')).toBe(15);

    // ...and it really is a min and not "always the play cap": above the idle cap the idle
    // screens stay at the idle cap.
    setPlayFrameCap(60);
    expect(maxFpsForPhase('playing')).toBe(60);
    expect(maxFpsForPhase('menu')).toBe(IDLE_MAX_FPS);

    // Every legal rate, stated as the relationship rather than as a number.
    for (const fps of FRAME_RATE_SETTINGS) {
      setPlayFrameCap(fps);
      for (const phase of ALL_PHASES) {
        expect(maxFpsForPhase(phase), `${phase} @ ${fps}`).toBeLessThanOrEqual(fps);
      }
    }
  });

  it('offers exactly the two rates, most frames first', () => {
    expect([...FRAME_RATE_SETTINGS]).toEqual([60, 30]);
    // 60 is the default and the top of the range: a setting whose first entry was the cheap one
    // would change what an unconfigured host runs at, which is a different decision entirely.
    expect(FRAME_RATE_SETTINGS[0]).toBe(PLAY_MAX_FPS);
    // Both are multiples of the 30 Hz sim tick, so the render rate and the sim never beat
    // against each other (see `FrameRateSetting`'s note).
    for (const fps of FRAME_RATE_SETTINGS) expect(fps % 30).toBe(0);
  });
});

describe('IDLE_MAX_FPS vs the auto-quality watchdog', () => {
  it('never reads as a device that cannot hold the frame', () => {
    // The two systems share one input. `PerfMonitor` keeps sampling while the player sits in a
    // menu, and `QualityWatchdog` latches a permanent downgrade after three consecutive windows
    // under its fps floor — so an idle cap set below that floor would make every player who
    // paused for six seconds come back to the low tier, with the settings screen still saying
    // `auto` and nothing having actually been slow. 30 clears the floor of 25 by design; this is
    // the assertion that keeps it clearing it.
    const watchdog = new QualityWatchdog();
    for (let i = 0; i < 10; i++) {
      expect(watchdog.observe({ fps: IDLE_MAX_FPS, frames: IDLE_MAX_FPS * 2, discarded: false })).toBe(false);
    }
    expect(watchdog.downgrades).toBe(0);
    // ...and the same watchdog does latch on a genuinely slow window, so the case above is
    // passing because the cap clears the floor and not because the watchdog is inert.
    for (let i = 0; i < 3; i++) watchdog.observe({ fps: 12, frames: 24, discarded: false });
    expect(watchdog.downgrades).toBeGreaterThanOrEqual(1);
  });
});

describe('applyPowerBudget', () => {
  it('writes both knobs and reports whether the world is drawn', () => {
    const world = { renderable: false };
    const ticker = { maxFPS: 0 };
    expect(applyPowerBudget('playing', world, ticker)).toBe(true);
    expect(world.renderable).toBe(true);
    // Not `PLAY_MAX_FPS` itself: what reaches the ticker is what `tickerCapFor` makes of the
    // phase's target, which is the entire fix of 2026-09-22. Asserted THROUGH that function
    // rather than as a literal, so the two cannot disagree silently.
    expect(ticker.maxFPS).toBe(tickerCapFor(PLAY_MAX_FPS, null));

    expect(applyPowerBudget('forge', world, ticker)).toBe(false);
    expect(world.renderable).toBe(false);
    expect(ticker.maxFPS).toBe(tickerCapFor(IDLE_MAX_FPS, null));
  });

  it('honours the measured display rate — a 60 Hz panel asked for 60 is left uncapped', () => {
    // The report this came from. A cap can only remove frames the display was going to show,
    // so on a panel already at the target it is pure loss; the ticker is left at 0, which is
    // Pixi for "no gate at all", and the display does the limiting.
    const world = { renderable: false };
    const ticker = { maxFPS: 999 };
    setDisplayHz(60);
    applyPowerBudget('playing', world, ticker);
    expect(ticker.maxFPS).toBe(0);

    // ...and the idle screens are still capped, because 30 really is below 60. The power
    // budget's whole purpose survives the fix.
    applyPowerBudget('menu', world, ticker);
    expect(ticker.maxFPS).toBeGreaterThan(0);
    expect(ticker.maxFPS).toBe(tickerCapFor(IDLE_MAX_FPS, 60));

    // A 120 Hz panel is still halved — the 2026-09-08 finding, unchanged by this.
    setDisplayHz(120);
    applyPowerBudget('playing', world, ticker);
    expect(ticker.maxFPS).toBeGreaterThan(0);
  });

  it('is safe to call every frame — the same phase twice changes nothing', () => {
    const world = { renderable: true };
    const ticker = { maxFPS: 0 };
    applyPowerBudget('menu', world, ticker);
    const after = { renderable: world.renderable, maxFPS: ticker.maxFPS };
    applyPowerBudget('menu', world, ticker);
    expect({ renderable: world.renderable, maxFPS: ticker.maxFPS }).toEqual(after);
  });
});

// ---- the cap, against the real ticker ----

/** Drive a real `Ticker` with synthetic timestamps and count how many times its listeners
 *  ran. `update(t)` needs no rAF and no `start()`, which is what makes this testable at all. */
function framesRun(maxFPS: number, stepMs: number, frames: number): number {
  const ticker = new Ticker();
  ticker.maxFPS = maxFPS;
  let ran = 0;
  ticker.add(() => {
    ran++;
  });
  let t = 1000;
  for (let i = 0; i < frames; i++) {
    t += stepMs;
    ticker.update(t);
  }
  ticker.destroy();
  return ran;
}

const HZ_60 = 1000 / 60;
const HZ_120 = 1000 / 120;

describe('PLAY_MAX_FPS against pixi.js Ticker', () => {
  it('halves a 120 Hz display', () => {
    // The iPad/iPhone ProMotion case, and the whole point of the cap: two render frames per
    // 30 Hz sim tick instead of four.
    // 117 of 240 as measured, not exactly 120: the gate truncates the elapsed time to an
    // integer, so the phase it carries forward loses a fraction of a millisecond per frame.
    const ran = framesRun(PLAY_MAX_FPS, HZ_120, 240);
    expect(ran).toBeGreaterThanOrEqual(115);
    expect(ran).toBeLessThanOrEqual(122);
  });

  it('does NOT halve a 60 Hz display', () => {
    // The failure mode described in this file's header. Anything near 60 of 120 here means
    // the cap is eating every other frame on ordinary hardware.
    const ran = framesRun(PLAY_MAX_FPS, HZ_60, 120);
    expect(ran).toBeGreaterThanOrEqual(118);
  });

  it('leaves an uncapped ticker running every frame — the state this replaced', () => {
    expect(framesRun(0, HZ_120, 240)).toBe(240);
  });
});

describe('IDLE_MAX_FPS against pixi.js Ticker', () => {
  it('halves a 60 Hz display and quarters a 120 Hz one', () => {
    expect(framesRun(IDLE_MAX_FPS, HZ_60, 120)).toBeGreaterThanOrEqual(58);
    expect(framesRun(IDLE_MAX_FPS, HZ_60, 120)).toBeLessThanOrEqual(62);
    expect(framesRun(IDLE_MAX_FPS, HZ_120, 240)).toBeGreaterThanOrEqual(58);
    expect(framesRun(IDLE_MAX_FPS, HZ_120, 240)).toBeLessThanOrEqual(62);
  });
});

// ---- frame CADENCE, against the real ticker ----
//
// Everything above this line counts frames. Counting frames is what missed the 2026-09-22
// report: a cap that drops 103 frames a minute still counts 58 of 60, which every assertion
// in this file read as healthy. What a player feels is not the count, it is whether the
// frames are evenly spaced — one frame that lasts twice as long as its neighbours, 1.7 times
// a second, forever. So these cases ask WHEN each frame ran.
//
// Two things make them mean something, and both were absent before:
//
//  - **jitter**. `t += stepMs` produces vsync timestamps no real display has ever produced.
//    With them the gate's truncated arithmetic lands on the same side every time and the bug
//    is invisible; ±0.2 ms — less than the noise in any real rAF timestamp — is enough to
//    expose it. The jitter is from a seeded generator, so a failure here is reproducible.
//  - **a cadence metric**, not an average. `unevenPct` is the share of drawn frames whose
//    length differs from the usual one, measured in whole display intervals. A cap that
//    draws every second vsync on a 120 Hz panel is perfectly even at 0%; the shipped cap at
//    58.3 fps is 2.9% on a 60 Hz panel, and 44.7% on a 144 Hz one.

/** Deterministic ±`amp` ms of timestamp noise. A real rAF timestamp is vsync-derived and
 *  still not exact; `Math.random` here would make a real regression flake instead of fail. */
function jitter(amp: number): () => number {
  let seed = 24680;
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed / 0x7fffffff - 0.5) * 2 * amp;
  };
}

interface Cadence {
  fps: number;
  /** Share (0..100) of drawn frames that lasted a different number of display intervals
   *  than the most common one. */
  unevenPct: number;
}

/** Drive a real `Ticker` at `refreshHz` for `seconds` and report what the player would see. */
function cadence(maxFPS: number, refreshHz: number, seconds = 30, amp = 0.2): Cadence {
  const ticker = new Ticker();
  ticker.maxFPS = maxFPS;
  const period = 1000 / refreshHz;
  const noise = jitter(amp);
  const ranAt: number[] = [];
  let now = 0;
  ticker.add(() => ranAt.push(now));
  for (let t = 1000; t < 1000 + seconds * 1000; t += period) {
    now = t + noise();
    ticker.update(now);
  }
  ticker.destroy();

  // Frame lengths in whole display intervals. The first gap is dropped: it spans the
  // ticker's own first update, which has no predecessor to be spaced from.
  const intervals: number[] = [];
  for (let i = 2; i < ranAt.length; i++) intervals.push(Math.round((ranAt[i]! - ranAt[i - 1]!) / period));
  const counts = new Map<number, number>();
  for (const n of intervals) counts.set(n, (counts.get(n) ?? 0) + 1);
  const mode = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
  return {
    fps: ranAt.length / seconds,
    unevenPct: (100 * intervals.filter((n) => n !== mode).length) / intervals.length,
  };
}

describe('frame cadence', () => {
  it('reproduces the 2026-09-22 report: a raw 60 cap stutters on a 60 Hz display', () => {
    // This is the bug, pinned as a fact about Pixi rather than about our code — if a future
    // Pixi fixes its own gate, this case fails and the whole section can be reconsidered.
    const shipped = cadence(60, 60);
    expect(shipped.unevenPct).toBeGreaterThan(1.5);
    // ...and it is invisible to a frame COUNT, which is how it shipped: still ~58 of 60.
    expect(shipped.fps).toBeGreaterThan(57);
  });

  it('...and the fix removes it outright on that display', () => {
    const fixed = cadence(tickerCapFor(PLAY_MAX_FPS, 60), 60);
    expect(fixed.unevenPct).toBe(0);
    expect(fixed.fps).toBeGreaterThan(59.5);
  });

  it('is at least as even as the raw target on every ordinary refresh rate', () => {
    // A table rather than one case, because the failure being guarded against is a rule that
    // helps the display it was written for and hurts the next one. `+0.5` of slack so that a
    // rate where the two are equal (nothing to win) does not read as a regression.
    for (const hz of [60, 75, 90, 100, 120, 144, 165, 240]) {
      for (const target of FRAME_RATE_SETTINGS) {
        const before = cadence(target, hz);
        const after = cadence(tickerCapFor(target, hz), hz);
        expect(after.unevenPct, `${hz}Hz @ ${target}`).toBeLessThanOrEqual(before.unevenPct + 0.5);
        expect(after.fps, `${hz}Hz @ ${target} fps`).toBeGreaterThan(0);
      }
    }
  });

  it('buys evenness with frames where it has to, and 90 Hz is where', () => {
    // The one case where the snap costs a visible amount of frame rate, stated rather than
    // discovered: 90 Hz asked for 60 is 1.5 vsyncs per frame, so the nearest even division is
    // 45 — 13 fps below what the raw cap DELIVERS on that panel. It is still the right trade,
    // and this case is here so that it is a decision somebody can find and revisit rather
    // than a surprise. An even 45 is what a player reads as smooth; a 58 fps average
    // alternating one and two vsyncs per frame is what they read as a stutter.
    const raw = cadence(60, 90);
    const snapped = cadence(tickerCapFor(60, 90), 90);
    expect(raw.fps).toBeGreaterThan(snapped.fps);
    expect(raw.unevenPct).toBeGreaterThan(30);
    // Not zero, and the reason is the same fractional millisecond as the idle case below:
    // 45 fps is a 22.22 ms interval, so the integer the gate can be given sits 0.22 ms under
    // it and the carried-forward phase drifts into a dropped frame every so often. 45% down
    // to 7% is the win; the last 7% is not available through `maxFPS` at all.
    expect(snapped.unevenPct).toBeLessThan(10);
  });

  it('never delivers less than the rate it snapped to', () => {
    // What the `- 1` in `ceil(interval) - 1` is actually worth, measured rather than asserted
    // from the formula — a mutation battery (2026-09-22) showed a `floor` mutant surviving
    // every arithmetic property in this file, because `floor` differs only where the interval
    // is already a whole number of milliseconds and the difference there is 0.001 ms on paper.
    //
    // It is not 0.001 ms in frames. 100 Hz asked for 60 resolves to 50 fps, i.e. 20 ms exactly:
    // with `ceil - 1` the gate sits at 19 and a delta that truncated to 19 still passes, so the
    // cap delivers 51.3 fps; with `floor` it sits at 20, that delta is dropped, and the cap
    // delivers 48.8 — BELOW the rate it just chose. A cap undershooting its own target is the
    // honest statement of the bug, and it is what this case pins.
    for (const hz of [75, 90, 100, 120, 144, 165, 240]) {
      for (const target of FRAME_RATE_SETTINGS) {
        const aimed = hz / Math.max(1, Math.round(hz / target));
        const got = cadence(tickerCapFor(target, hz), hz).fps;
        expect(got, `${hz}Hz @ ${target} -> aimed ${aimed}`).toBeGreaterThan(aimed * 0.98);
      }
    }
  });

  it('leaves a run on the two panels this project ships against completely even', () => {
    // 60 Hz (the desktop report) and 120 Hz (the ProMotion iPad the cap was written for).
    for (const hz of [60, 120]) {
      expect(cadence(tickerCapFor(60, hz), hz).unevenPct, `${hz}Hz`).toBeLessThan(1);
    }
  });

  it('leaves a RESIDUE on the idle cap, and that is the accepted trade', () => {
    // 30 fps on a 60 Hz panel is 33.33 ms, which is not a whole number of milliseconds, so no
    // integer `_minElapsedMS` can divide it and the gate's carried-forward phase drifts until
    // it drops a frame: ~2.7% of frames, about one every two seconds. That cannot be fixed
    // through `maxFPS` at all (see `tickerCapFor`'s header). It is accepted rather than worked
    // around because of WHERE it lands: `IDLE_MAX_FPS` applies only to phases that draw no
    // world (`worldDrawnInPhase`), i.e. to a static menu panel, where a frame of the same
    // unchanged image lasting twice as long is not observable by anyone. The moment that
    // stops being true — an animated menu — this case is the one that has to be revisited.
    const idle = cadence(tickerCapFor(30, 60), 60);
    expect(idle.unevenPct).toBeLessThan(4);
    expect(idle.fps).toBeGreaterThan(29);
    expect(ALL_PHASES.filter((p) => maxFpsForPhase(p) === IDLE_MAX_FPS).some(worldDrawnInPhase)).toBe(false);
  });
});

describe('tickerCapFor', () => {
  it('does not cap a display that is already at or below the target', () => {
    expect(tickerCapFor(60, 60)).toBe(0);
    expect(tickerCapFor(60, 59.94)).toBe(0);
    expect(tickerCapFor(60, 30)).toBe(0);
    // The 1.02 slack: a panel reported as 60 Hz is routinely 60.02, and which side of the
    // line it falls on must not be decided by the third decimal of a measurement.
    expect(tickerCapFor(60, 60.02)).toBe(0);
    // ...but a genuinely faster panel is still capped.
    expect(tickerCapFor(60, 75)).toBeGreaterThan(0);
  });

  it('caps at a whole millisecond, which is what the gate can actually honour', () => {
    // The property the whole fix rests on, asserted on the value PIXI ends up holding rather
    // than on the one we passed it — `maxFPS` is a setter that stores `1 / (fps / 1000)`, and
    // the round trip through it is exactly where the first version of this went wrong. Read
    // back through the private field for the same reason the file header gives: this is a
    // claim about Pixi, so nothing but Pixi can confirm it.
    for (const target of [60, 30]) {
      for (const hz of [null, 75, 90, 100, 120, 144, 165, 240]) {
        const cap = tickerCapFor(target, hz);
        if (cap === 0) continue;
        const ticker = new Ticker();
        try {
          ticker.maxFPS = cap;
          const min = (ticker as unknown as { _minElapsedMS: number })._minElapsedMS;
          const whole = Math.round(min);
          // Whole, so the phase the gate carries forward cannot drift...
          expect(Math.abs(min - whole), `${hz} @ ${target} integral`).toBeLessThan(0.01);
          // ...and never ABOVE that whole millisecond, which an integer `delta` would lose to.
          expect(min, `${hz} @ ${target} not above`).toBeLessThanOrEqual(whole);
          // ...and strictly below the interval it is gating, but not by more than the one
          // millisecond of truncation that makes the margin necessary. Both bounds matter and
          // they pull opposite ways: at or above the interval is the shipped 2026-09-08 bug,
          // and too far below lets an EARLIER vsync through, which is judder of the other kind.
          const aimed = hz === null ? target : hz / Math.max(1, Math.round(hz / target));
          expect(min, `${hz} @ ${target} below interval`).toBeLessThan(1000 / aimed);
          expect(min, `${hz} @ ${target} not needlessly low`).toBeGreaterThan(1000 / aimed - 2);
        } finally {
          ticker.destroy();
        }
      }
    }
  });

  it('snaps a faster display to a whole number of vsyncs per frame', () => {
    // 144 Hz asked for 60 is 2.4 vsyncs per frame, which a vsynced display can only draw as
    // an endless 2,2,3 — so the target moves to 72 (two vsyncs) rather than the cadence
    // being sacrificed to keep the number 60.
    const gateMs = (cap: number): number => 1000 / cap + GATE_EPSILON_MS;
    expect(gateMs(tickerCapFor(60, 144))).toBeCloseTo(Math.floor(1000 / 72), 6);
    expect(gateMs(tickerCapFor(60, 120))).toBeCloseTo(Math.floor(1000 / 60), 6);
    expect(gateMs(tickerCapFor(30, 120))).toBeCloseTo(Math.floor(1000 / 30), 6);
  });

  it('treats an unknown display rate as the target itself, never as uncapped', () => {
    // Case 2. `null` is the state every session is in for its first second, and the 120 Hz
    // waste this file exists to stop is real during it.
    const cap = tickerCapFor(60, null);
    expect(cap).toBeGreaterThan(0);
    expect(1000 / cap + GATE_EPSILON_MS).toBeCloseTo(16, 6);
  });
});

describe('the display-rate mirror', () => {
  it('starts unmeasured and refuses a rate that cannot be one', () => {
    expect(activeDisplayHz()).toBe(null);
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      setDisplayHz(bad);
      // A nonsense rate must land on "not measured", not on the nonsense: `tickerCapFor`
      // reads a 0 Hz display as "slower than the target, do not cap", which is the exact
      // state the fix exists to avoid reaching by accident.
      expect(activeDisplayHz(), String(bad)).toBe(null);
    }
    setDisplayHz(144);
    expect(activeDisplayHz()).toBe(144);
    setDisplayHz(null);
    expect(activeDisplayHz()).toBe(null);
  });
});

describe('every offered rate against pixi.js Ticker', () => {
  it('actually delivers roughly the rate it names on a 120 Hz panel', () => {
    // The setting is only worth having if the number reaches the frames. Both rates divide
    // 120 Hz exactly, so the truncation slop in the gate is small — a few frames in 240.
    for (const fps of FRAME_RATE_SETTINGS) {
      const ran = framesRun(fps, HZ_120, 240);
      const expected = 240 * (fps / 120);
      expect(ran, `${fps}fps`).toBeGreaterThan(expected * 0.95);
      expect(ran, `${fps}fps`).toBeLessThanOrEqual(expected * 1.02);
    }
  });
});
