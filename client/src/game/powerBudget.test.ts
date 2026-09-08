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
  activePlayFrameCap,
  applyPowerBudget,
  maxFpsForPhase,
  resetPlayFrameCap,
  setPlayFrameCap,
  worldDrawnInPhase,
} from './powerBudget';

// The play cap is a module mirror (same shape as `render/quality.ts`'s), so one case's pick
// would otherwise leak into the next — and the leak would be invisible, since both values are
// legal.
afterEach(() => resetPlayFrameCap());

/** Every phase, with the answer for each. A `Record` and not an array on purpose: a new
 *  member of the `Phase` union is a type error here until it is given a row. */
const DRAWS_WORLD: Record<Phase, boolean> = {
  playing: true,
  menu: false,
  modeSelect: false,
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
    expect(ticker.maxFPS).toBe(PLAY_MAX_FPS);

    expect(applyPowerBudget('forge', world, ticker)).toBe(false);
    expect(world.renderable).toBe(false);
    expect(ticker.maxFPS).toBe(IDLE_MAX_FPS);
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
