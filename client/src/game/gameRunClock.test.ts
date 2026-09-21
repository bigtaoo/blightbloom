/**
 * Which CLOCK a run is driven by, end to end through `Game` — the seam the 2026-09-20
 * tutorial freeze lived in, and the one no unit test could see.
 *
 * `GameLoop.update` reads one boolean, `run.online`, once per frame and sends the whole frame
 * to one of two loops: the local fixed-step sim, or the confirmed net stream. Every piece of
 * that had coverage while the verb was broken. `OnlineMatch.test.ts` proves `beginSoloQueue`
 * sets the flag; `gameWiring.test.ts` proves BACK calls what it is wired to;
 * `RunLifecycle.test.ts` proves each entry point stands an engine up and flips the phase.
 * None of them can tell you that pressing PVP SOLO QUEUE, then BACK, then TUTORIAL leaves a
 * run that never ticks — because the flag is set by one controller, read by a second, and the
 * screen that leaks it belongs to a third, and every one of those tests stubs the other two.
 *
 * What shipped was a run with its room built and nothing in it: `advanceOnline` found no
 * session, held the scene and returned, so the sim never stepped, the HUD kept the previous
 * run's numbers, and the pause key (gated on the same flag) could not get out of it either.
 *
 * So the assertions here are the observables a player has: does the world advance, and is
 * there anybody in it. Deliberately not `run.online` — that is the mechanism, and asserting
 * the mechanism is what left the gap. The flag's own value is pinned in `RunLifecycle.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import { Container, type Ticker } from 'pixi.js';
import type { GameState } from '@dd/engine';
import { installFakeTextCanvas } from './screens/fakeTextCanvas';
import { Game } from './Game';
import type { Actor } from './scene/Actor';

installFakeTextCanvas();

const NO_TOUCH = {
  active: false, stickRadius: 0, move: null,
  fire: { cx: 0, cy: 0, r: 0, pressed: false },
  weapon1: { cx: 0, cy: 0, r: 0 }, weapon2: { cx: 0, cy: 0, r: 0 },
  interact: { cx: 0, cy: 0, r: 0, pressed: false },
};

/** A real `Game` on a fake app, reached only through the callbacks the real screens expose —
 *  the same shape `gameReplaySave.test.ts` uses, and for the same reason: the thing under test
 *  is the wiring between the parts, so nothing here may inject past it. */
function newGame() {
  const frameCbs: Array<(t: Ticker) => void> = [];
  const app = {
    stage: new Container(),
    renderer: { screen: { width: 1280, height: 720 }, resolution: 1, resize: () => {} },
    ticker: { add: (cb: (t: Ticker) => void) => frameCbs.push(cb), remove: () => {} },
    canvas: {},
  } as unknown as ConstructorParameters<typeof Game>[0];

  const game = new Game(
    app,
    {
      onSwitchWeapon: null,
      attach: () => {},
      read: () => ({ moveX: 1, moveY: 0, firing: false, interacting: false }),
      getTouchVisual: () => NO_TOUCH,
      setControlMirror: () => {},
    } as never,
    { play: () => {}, setSfxVolume: () => {}, setMusicVolume: () => {}, resume: () => {} } as never,
  );
  game.start();

  const inner = game as unknown as {
    run: { phase: string; engine: { state: GameState } | null };
    scene: { player: Actor | null };
    // The lobby and the preview, as the player meets them: these are the REAL screens, so the
    // presses below go through `gameWiring`'s table rather than around it.
    mainMenu: { onPvpSolo: (() => void) | null; onTutorial: (() => void) | null; onSolo: (() => void) | null };
    pvpPreview: { onBack: (() => void) | null };
    forge: { onStart: (() => void) | null };
    runs: { finalizeOnlineRun(session: unknown): void };
  };

  let ms = 0;
  const frames = (n: number) => {
    for (let i = 0; i < n; i++) {
      ms += 16.7;
      for (const cb of frameCbs) cb({ deltaMS: 16.7, lastTime: ms } as Ticker);
    }
  };
  return { inner, frames, tick: () => inner.run.engine?.state.tick ?? -1 };
}

describe('Game — an offline run runs, whatever screens were visited first', () => {
  it('ticks the tutorial after a trip through the PvP preview and back', () => {
    // The exact route in the report: PVP SOLO QUEUE declares the run online before any screen
    // is drawn, BACK returns to the lobby, TUTORIAL starts an OFFLINE run. Three presses, no
    // network, nothing here mocked — the freeze was entirely in what they left behind.
    const g = newGame();
    g.inner.mainMenu.onPvpSolo!();
    g.inner.pvpPreview.onBack!();
    g.inner.mainMenu.onTutorial!();

    expect(g.inner.run.phase).toBe('playing');
    g.frames(30);

    expect(g.tick()).toBeGreaterThan(0); // the sim ran at all
    // ...and somebody is standing in the room it built. `Scene.reconcile` only ever creates the
    // player's view inside a sim step, so this is the half of the frozen screenshot that no
    // tick counter can express: geometry with nothing alive in it.
    expect(g.inner.scene.player).not.toBeNull();
  });

  it('ticks the same tutorial reached straight from the lobby — the control', () => {
    // The route that always worked. Without it the case above could pass for a reason that has
    // nothing to do with the preview (a harness that never ticks anything would fail both).
    const g = newGame();
    g.inner.mainMenu.onTutorial!();
    g.frames(30);
    expect(g.tick()).toBeGreaterThan(0);
    expect(g.inner.scene.player).not.toBeNull();
  });

  it('ticks a dungeon run after the same trip — the flag is not the tutorial’s problem', () => {
    // `run.online` is read by the loop, not by any one entry point, so the preview's leak
    // reached every offline route out of the lobby. The tutorial is simply the row a new
    // player presses next, which is why that is the one that got reported.
    const g = newGame();
    g.inner.mainMenu.onPvpSolo!();
    g.inner.pvpPreview.onBack!();
    g.inner.mainMenu.onSolo!(); // SOLO PvE opens the forge...
    g.inner.forge.onStart!(); // ...and START RUN is the press that enters the dungeon
    g.frames(30);
    expect(g.tick()).toBeGreaterThan(0);
    expect(g.inner.scene.player).not.toBeNull();
  });

  it('does NOT tick the local engine once a real match has started', () => {
    // The other direction, and the reason `finalizeOnlineRun` re-declares the flag rather than
    // inheriting it: a run whose clock is the server must not also be stepped locally. Nothing
    // nulls `run.engine` on that transition, so if the loop fell back to the offline branch it
    // would quietly advance the LAST run's engine under a live match.
    const g = newGame();
    g.inner.mainMenu.onTutorial!();
    g.frames(30);
    const before = g.tick();
    expect(before).toBeGreaterThan(0);

    g.inner.runs.finalizeOnlineRun({ close: () => {} });
    g.frames(30);
    expect(g.tick()).toBe(before);
  });
});
