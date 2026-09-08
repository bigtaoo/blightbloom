/**
 * The power budget, end to end through `Game` (2026-09-08) — the WIRING half, in the same
 * spirit as `gameQuality.test.ts`: `powerBudget.test.ts` covers the policy, and nothing in it
 * can tell whether the policy reaches the real `layers.world` and the real `app.ticker`. Both
 * arrive through `gameAssembly.ts`'s deps table, where handing over the wrong container or
 * forgetting the ticker entirely type-checks fine and shows up only as a battery bill.
 *
 * So the assertions below read the observables a renderer reads: the `renderable` bit on the
 * layer the scene is actually mounted under, and the cap on the ticker the app actually runs.
 */
import { afterEach, describe, it, expect } from 'vitest';
import { Container } from 'pixi.js';
import { installFakeTextCanvas } from './screens/fakeTextCanvas';
import { Game } from './Game';
import type { Phase } from './phase';
import { IDLE_MAX_FPS, PLAY_MAX_FPS, resetPlayFrameCap } from './powerBudget';
import { SettingsBinding } from './settingsBinding';
import { MemorySettingsStore, defaultSettingsState, type SettingsState } from '../settings';
import type { RenderQualityController } from './renderQuality';
import type { Layers } from './scene/layers';

installFakeTextCanvas();

afterEach(() => resetPlayFrameCap());

const NO_TOUCH = {
  active: false, stickRadius: 0, move: null,
  fire: { cx: 0, cy: 0, r: 0, pressed: false },
  weapon1: { cx: 0, cy: 0, r: 0 }, weapon2: { cx: 0, cy: 0, r: 0 },
  interact: { cx: 0, cy: 0, r: 0, pressed: false },
};

/** Same shape as `gameQuality.test.ts`'s fake app, plus the two things this file needs: a
 *  ticker that RECORDS `maxFPS` and hands back the update callback `start()` registers. */
function fakeApp() {
  const screen = { width: 1280, height: 720 };
  const renderer = { screen, resolution: 2, resize: () => {} };
  const listeners: Array<(t: { deltaMS: number }) => void> = [];
  const ticker = {
    maxFPS: 0,
    add: (fn: (t: { deltaMS: number }) => void) => listeners.push(fn),
    remove: () => {},
  };
  const app = {
    stage: new Container(), renderer, ticker, canvas: {},
  } as unknown as ConstructorParameters<typeof Game>[0];
  return { app, ticker, listeners };
}

function newGame(settings: Partial<SettingsState> = {}) {
  const { app, ticker, listeners } = fakeApp();
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
  const inner = game as unknown as {
    layers: Layers;
    run: { phase: Phase };
    settingsBinding: SettingsBinding;
    quality: RenderQualityController;
  };
  // Same store swap `gameQuality.test.ts` uses, and for the same reason: `Game` builds its own
  // binding over `createWebSettingsStore`, and widening the constructor for a test is a bigger
  // change than this file justifies.
  inner.settingsBinding = new SettingsBinding(
    { audio: { setSfxVolume: () => {}, setMusicVolume: () => {} }, input: {}, quality: inner.quality },
    new MemorySettingsStore({ ...defaultSettingsState(), ...settings }),
  );
  inner.settingsBinding.load();
  game.start();
  return {
    ticker,
    world: inner.layers.world,
    setPhase: (phase: Phase) => {
      inner.run.phase = phase;
    },
    frame: () => {
      for (const fn of listeners) fn({ deltaMS: 16 });
    },
  };
}

describe('Game — power budget wiring', () => {
  it('stops drawing the world and drops the cap on the first frame of the menu', () => {
    const g = newGame();
    // Before any frame runs, the layer is in Pixi's default state and the ticker uncapped —
    // so the assertions below cannot pass on the initial values.
    expect(g.world.renderable).toBe(true);
    expect(g.ticker.maxFPS).toBe(0);

    g.frame(); // `start()` leaves the game on the main menu
    expect(g.world.renderable).toBe(false);
    expect(g.ticker.maxFPS).toBe(IDLE_MAX_FPS);
  });

  it('draws the world at the play rate once a run is on screen, and stops again after it', () => {
    const g = newGame();
    g.frame();

    g.setPhase('playing');
    g.frame();
    expect(g.world.renderable).toBe(true);
    expect(g.ticker.maxFPS).toBe(PLAY_MAX_FPS);

    // ...and back. This is the case that motivated the whole change: the room stays mounted
    // when a run ends (`RunLifecycle.resetRenderState` runs at the START of the next one), so
    // a forge sitting on a finished dungeon must not keep drawing it.
    g.setPhase('forge');
    g.frame();
    expect(g.world.renderable).toBe(false);
    expect(g.ticker.maxFPS).toBe(IDLE_MAX_FPS);
  });

  it('caps a run at the frame rate the PLAYER picked, not just at the default', () => {
    // The setting is persisted in `SettingsState`, applied by `SettingsBinding` to a module
    // mirror, and read by the loop off that mirror — three hops, none of which any single unit
    // test can see end to end. What a real device would show is the ticker's own cap.
    const g = newGame({ frameRate: 30 });
    g.setPhase('playing');
    g.frame();
    expect(g.ticker.maxFPS).toBe(30);

    // ...and the idle screens do not go back UP. 30 is written out rather than computed from
    // `IDLE_MAX_FPS`: an expected value derived from the same expression as the code under test
    // agrees with it by construction (and at these two values it agrees either way — see
    // `powerBudget.test.ts`'s note on the surviving mutant).
    g.setPhase('forge');
    g.frame();
    expect(g.ticker.maxFPS).toBe(30);
  });

  it('keeps the world drawn while a run is PAUSED-adjacent but the phase is still playing', () => {
    // Guards the one direction that would be a visible bug rather than a wasted frame: any
    // phase that shows the world must not be switched off. `playing` is that phase, and the
    // pause menu is reached FROM it, so a stale `renderable = false` would black out the
    // resumed run.
    const g = newGame();
    g.setPhase('paused');
    g.frame();
    expect(g.world.renderable).toBe(false);
    g.setPhase('playing');
    g.frame();
    expect(g.world.renderable).toBe(true);
  });
});
