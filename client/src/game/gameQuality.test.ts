/**
 * The quality tier, end to end through `Game` (2026-08-25).
 *
 * The unit tests either side of this one cover the table (`render/quality.test.ts`), the
 * downgrade policy (`render/qualityWatchdog.test.ts`) and the two consumers
 * (`fx/FxController.test.ts`, `scene/Actor.test.ts`). What none of them can see is the WIRING:
 * whether a settings tap or a slow window actually reaches the renderer. That is the part that
 * has historically shipped broken here — design/04's item 12 was an entire interaction system
 * that rendered perfectly and was connected to nothing.
 *
 * So every case below asserts an observable the RENDERER reads: the resolution the renderer is
 * running at, and the filters mounted on the scene layers.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { Container, Ticker } from 'pixi.js';
import { installFakeTextCanvas } from './screens/fakeTextCanvas';
import { Game } from './Game';
import { resetActiveQuality, activeQuality } from '../render/quality';
import { installPerf } from '../perf';
import { defaultSettingsState, MemorySettingsStore, type SettingsState } from '../settings';
import { SettingsBinding } from './settingsBinding';
import type { RenderQualityController } from './renderQuality';

installFakeTextCanvas();

afterEach(() => resetActiveQuality());

const NO_TOUCH = {
  active: false, stickRadius: 0, move: null,
  fire: { cx: 0, cy: 0, r: 0, pressed: false },
  weapon1: { cx: 0, cy: 0, r: 0 }, weapon2: { cx: 0, cy: 0, r: 0 },
  interact: { cx: 0, cy: 0, r: 0, pressed: false },
};

/** Same shape as gameViewport.test.ts's, plus a recording `resize` — the resolution knob is the
 *  one part of the tier that goes through the renderer API rather than through a layer. */
function fakeApp(screen: { width: number; height: number }, resolution: number) {
  const renderer = {
    screen,
    resolution,
    resizes: [] as Array<[number, number, number | undefined]>,
    resize(w: number, h: number, res?: number) {
      renderer.resizes.push([w, h, res]);
      screen.width = w;
      screen.height = h;
      if (res !== undefined) renderer.resolution = res;
    },
  };
  return { renderer, app: {
    stage: new Container(),
    renderer,
    ticker: { add: () => {}, remove: () => {} },
    canvas: {},
  } as unknown as ConstructorParameters<typeof Game>[0] };
}

interface GameInternals {
  layers: { world: Container; fx: Container; lit: Container };
  settingsScreen: { onChange: ((s: SettingsState) => void) | null };
  settingsBinding: SettingsBinding;
  quality: RenderQualityController;
}

function newGame(settings: Partial<SettingsState> = {}, resolution = 2) {
  const { renderer, app } = fakeApp({ width: 1280, height: 720 }, resolution);
  const game = new Game(
    app,
    {
      onSwitchWeapon: null,
      attach: () => {},
      read: () => ({ moveX: 0, moveY: 0, firing: false, interacting: false }),
      getTouchVisual: () => NO_TOUCH,
      setControlMirror: () => {},
    } as never,
    { play: () => {}, setSfxVolume: () => {}, setMusicVolume: () => {}, resume: () => {} } as never,
  );
  const inner = game as unknown as GameInternals;
  // Re-bind against a store carrying the settings under test and re-run the same `load()` the
  // constructor runs. `Game` builds its own binding over `createWebSettingsStore`, and widening
  // that constructor purely for a test is a bigger change than this file justifies —
  // `settingsBinding.ts` already takes its store as a parameter, so the swap is one field.
  // `settingsScreen.onChange` reads `this.settingsBinding` per call, so it follows the swap.
  inner.settingsBinding = new SettingsBinding(
    { audio: { setSfxVolume: () => {}, setMusicVolume: () => {} }, input: {}, quality: inner.quality },
    new MemorySettingsStore({ ...defaultSettingsState(), ...settings }),
  );
  inner.settingsBinding.load();
  game.start();
  return { game, renderer, inner };
}

/** What is actually mounted on the three filtered layers. */
function mountedCounts(inner: GameInternals) {
  return {
    world: (inner.layers.world.filters ?? ([] as unknown[])).length,
    fx: (inner.layers.fx.filters ?? ([] as unknown[])).length,
    lit: (inner.layers.lit.filters ?? ([] as unknown[])).length,
  };
}

describe('Game — quality tier wiring', () => {
  it('runs the high tier by default, at the platform resolution', () => {
    const { renderer, inner } = newGame({ quality: 'auto' }, 2);
    expect(activeQuality().tier).toBe('high');
    expect(renderer.resolution).toBe(2);
    expect(mountedCounts(inner)).toEqual({ world: 2, fx: 1, lit: 1 });
  });

  it('applies a persisted low tier at boot — filters off and resolution down', () => {
    const { renderer, inner } = newGame({ quality: 'low' }, 2);
    expect(renderer.resolution).toBe(1);
    expect(mountedCounts(inner)).toEqual({ world: 0, fx: 0, lit: 0 });
  });

  it('never raises resolution above what the platform chose', () => {
    // A 1x host (a low-DPR screen, or a mini-game reporting pixelRatio 1) asked for high: the
    // tier's cap of 2 is a CEILING, not a target, so nothing should move.
    const { renderer } = newGame({ quality: 'high' }, 1);
    expect(renderer.resolution).toBe(1);
    expect(renderer.resizes).toHaveLength(0);
  });

  it('resizes at the same logical size, changing only the resolution', () => {
    const { renderer } = newGame({ quality: 'low' }, 2);
    // The logical (CSS-px) viewport is what every layout reads (`game/viewport.ts` reads
    // `renderer.screen`), so a tier change must not move it. Only the third argument changes.
    expect(renderer.resizes).toEqual([[1280, 720, 1]]);
    expect(renderer.screen).toEqual({ width: 1280, height: 720 });
  });

  it('applies a tier picked from the settings screen, live', () => {
    const { renderer, inner } = newGame({ quality: 'auto' }, 2);
    expect(mountedCounts(inner)).toEqual({ world: 2, fx: 1, lit: 1 });
    inner.settingsScreen.onChange!({ ...inner.settingsBinding.state, quality: 'low' });
    expect(mountedCounts(inner)).toEqual({ world: 0, fx: 0, lit: 0 });
    expect(renderer.resolution).toBe(1);
    // ...and back, in the same session.
    inner.settingsScreen.onChange!({ ...inner.settingsBinding.state, quality: 'high' });
    expect(mountedCounts(inner)).toEqual({ world: 2, fx: 1, lit: 1 });
    expect(renderer.resolution).toBe(2);
  });

  it('does not touch the renderer when an unrelated setting changes', () => {
    const { renderer, inner } = newGame({ quality: 'auto' }, 2);
    inner.settingsScreen.onChange!({ ...inner.settingsBinding.state, muted: true });
    // `renderer.resize` reallocates the backing buffer; a volume tap must not pay for one.
    expect(renderer.resizes).toHaveLength(0);
  });
});

/** A window the watchdog counts as slow. */
const SLOW = { fps: 12, frames: 30, discarded: false };
const FAST = { fps: 60, frames: 120, discarded: false };

describe('Game — the auto downgrade', () => {
  function feed(game: Game, windows: Array<typeof SLOW>) {
    for (const w of windows) game.observePerfWindow(w);
  }

  it('steps to MEDIUM after one sustained slow stretch, and to low after a second', () => {
    // The ladder (2026-09-08, `render/quality.ts`'s `AUTO_LADDER`): "high does not fit" is no
    // evidence about medium, so the first streak buys the cheaper rung and the second measures
    // THAT one. What the renderer shows for it: the three passes above the lighting unmounted
    // (`world` 2 -> 0, `fx` 1 -> 0), `lit` still lit, and the resolution untouched.
    const { game, renderer, inner } = newGame({ quality: 'auto' }, 2);
    feed(game, [SLOW, SLOW]);
    expect(mountedCounts(inner)).toEqual({ world: 2, fx: 1, lit: 1 }); // not yet
    feed(game, [SLOW]);
    expect(activeQuality().tier).toBe('medium');
    expect(mountedCounts(inner)).toEqual({ world: 0, fx: 0, lit: 1 });
    expect(renderer.resolution).toBe(2);
    expect(renderer.resizes).toHaveLength(0);

    // A fresh streak, because the step reset it — two more windows are not enough.
    feed(game, [SLOW, SLOW]);
    expect(activeQuality().tier).toBe('medium');
    feed(game, [SLOW]);
    expect(activeQuality().tier).toBe('low');
    expect(mountedCounts(inner)).toEqual({ world: 0, fx: 0, lit: 0 });
    expect(renderer.resolution).toBe(1);
  });

  it('stops at the bottom rung however long the device stays slow', () => {
    const { game, inner } = newGame({ quality: 'auto' }, 2);
    for (let i = 0; i < 30; i++) game.observePerfWindow(SLOW);
    expect(activeQuality().tier).toBe('low');
    expect(mountedCounts(inner)).toEqual({ world: 0, fx: 0, lit: 0 });
  });

  it('leaves a healthy device alone', () => {
    const { game, renderer, inner } = newGame({ quality: 'auto' }, 2);
    feed(game, [FAST, SLOW, FAST, SLOW, SLOW, FAST, SLOW]);
    expect(activeQuality().tier).toBe('high');
    expect(mountedCounts(inner)).toEqual({ world: 2, fx: 1, lit: 1 });
    expect(renderer.resizes).toHaveLength(0);
  });

  it('ignores the watchdog entirely on a pinned tier', () => {
    const { game, inner } = newGame({ quality: 'high' }, 2);
    feed(game, [SLOW, SLOW, SLOW, SLOW, SLOW]);
    // The player asked for high and is still on high — the game does not overrule them.
    expect(activeQuality().tier).toBe('high');
    expect(mountedCounts(inner)).toEqual({ world: 2, fx: 1, lit: 1 });
  });

  it('does not persist the downgrade — the SETTING stays auto', () => {
    const { game, inner } = newGame({ quality: 'auto' }, 2);
    feed(game, [SLOW, SLOW, SLOW]);
    expect(activeQuality().tier).toBe('medium');
    // A downgrade is a fact about this session's measured framerate, not a choice the player
    // made. Writing it to disk would make one bad afternoon permanent.
    expect(inner.settingsBinding.state.quality).toBe('auto');
  });

  it('re-arms the watchdog when the player pins a tier and returns to auto', () => {
    const { game, inner } = newGame({ quality: 'auto' }, 2);
    feed(game, [SLOW, SLOW, SLOW, SLOW, SLOW, SLOW]);
    expect(activeQuality().tier).toBe('low'); // both rungs spent

    inner.settingsScreen.onChange!({ ...inner.settingsBinding.state, quality: 'high' });
    expect(activeQuality().tier).toBe('high');
    inner.settingsScreen.onChange!({ ...inner.settingsBinding.state, quality: 'auto' });
    // Back on auto with the verdict cleared: high again, from the TOP of the ladder and not
    // from where it left off, and it takes a FULL fresh streak to step — otherwise one bad
    // stretch would haunt every later auto session.
    expect(activeQuality().tier).toBe('high');
    feed(game, [SLOW, SLOW]);
    expect(activeQuality().tier).toBe('high');
    feed(game, [SLOW]);
    expect(activeQuality().tier).toBe('medium');
  });
});

describe('Game — the watchdog has no authority on a pinned tier', () => {
  it('does not accumulate a verdict while pinned, so returning to auto re-measures', () => {
    const { game, inner } = newGame({ quality: 'low' }, 2);
    // A slow stretch measured while PINNED LOW says nothing about whether this device could
    // hold the high tier — those windows were produced by a different renderer configuration.
    for (let i = 0; i < 5; i++) game.observePerfWindow(SLOW);

    inner.settingsScreen.onChange!({ ...inner.settingsBinding.state, quality: 'auto' });
    // Auto starts high and measures for itself. Without the guard in `observePerfWindow`, the
    // watchdog would already be latched here and auto would resolve straight to low — a verdict
    // inherited from measurements that never applied to it.
    expect(activeQuality().tier).toBe('high');
  });
});

/**
 * The entries' own expression, end to end:
 *
 *     installPerf(app, { onSnapshot: (s) => game.observePerfWindow(s.window) })
 *
 * Every other case in this file hands `observePerfWindow` a hand-written window literal. That is
 * enough to test the policy and not enough to test the CONTRACT — if the real `FrameWindow` did
 * not carry what the watchdog reads, all of them would still pass while no device ever
 * downgraded. Here the windows come out of a real `FrameSampler` in a real `PerfMonitor` driven
 * by a real `Ticker`, and the thing asserted at the end is the renderer's own state.
 *
 * `render/qualityFromPerf.test.ts` covers the same seam against the watchdog alone; this one
 * closes it through `Game`, which is where the entries actually attach it.
 */
describe('Game — a real perf window drops a real tier', () => {
  it('downgrades the live renderer off the real sampler, not off a literal', () => {
    const { game, renderer, inner } = newGame({ quality: 'auto' }, 2);
    expect(mountedCounts(inner)).toEqual({ world: 2, fx: 1, lit: 1 });

    // A second, independent app purely to run the real perf pipeline — `Game`'s own fake ticker
    // never fires, and standing up a real one would drag the whole update loop into this test.
    const ticker = new Ticker();
    ticker.autoStart = false;
    const perfApp = {
      ticker,
      stage: new Container(),
      renderer: { gl: { drawArrays: () => {}, useProgram: () => {}, bindTexture: () => {}, bindFramebuffer: () => {} },
        screen: { width: 800, height: 600 }, texture: { _managedTextures: { items: {} } }, render() {} },
    } as never;
    ticker.update(1000);
    const perf = installPerf(perfApp, { onSnapshot: (s) => game.observePerfWindow(s.window) });
    try {
      // 100ms per frame — a device genuinely rendering at 10fps, for ~20s. Long enough for
      // BOTH rungs of the ladder: the sampler closes a window every 2s and the watchdog wants a
      // fresh streak of 3 per step, so reaching `low` from a real stream takes ~12s of them.
      let t = 1000;
      for (let i = 0; i < 200; i++) { t += 100; ticker.update(t); }
    } finally {
      perf.uninstall();
    }

    expect(activeQuality().tier).toBe('low');
    expect(mountedCounts(inner)).toEqual({ world: 0, fx: 0, lit: 0 });
    expect(renderer.resolution).toBe(1);
    // The setting itself is untouched — the downgrade is a fact about this session, not a choice.
    expect(inner.settingsBinding.state.quality).toBe('auto');
  });

  it('leaves the renderer alone when the real sampler reports a healthy device', () => {
    const { game, renderer, inner } = newGame({ quality: 'auto' }, 2);
    const ticker = new Ticker();
    ticker.autoStart = false;
    const perfApp = {
      ticker,
      stage: new Container(),
      renderer: { gl: { drawArrays: () => {}, useProgram: () => {}, bindTexture: () => {}, bindFramebuffer: () => {} },
        screen: { width: 800, height: 600 }, texture: { _managedTextures: { items: {} } }, render() {} },
    } as never;
    ticker.update(1000);
    let windows = 0;
    const perf = installPerf(perfApp, { onSnapshot: (s) => { windows++; game.observePerfWindow(s.window); } });
    try {
      let t = 1000;
      for (let i = 0; i < 400; i++) { t += 16; ticker.update(t); }
    } finally {
      perf.uninstall();
    }
    // The control: windows really were produced and really did reach the game.
    expect(windows).toBeGreaterThanOrEqual(3);
    expect(activeQuality().tier).toBe('high');
    expect(mountedCounts(inner)).toEqual({ world: 2, fx: 1, lit: 1 });
    expect(renderer.resizes).toHaveLength(0);
  });
});
