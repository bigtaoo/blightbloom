/**
 * The way OUT of a run, end to end through `Game` — the two buttons on the result screen, and
 * which verb each of them reaches.
 *
 * Since 2026-09-22 leaving a run is a HELD transition (`controllers/TransitionGate.ts`): the
 * loading screen stays up for `MIN_TRANSITION_MS` so the run ending reads as a transition
 * rather than a jump cut. `ScreenNav.leaveRunTo` is what applies it, and the trap this file
 * exists for is that **`leaveRunTo('menu')` and `showMenu()` land on exactly the same screen**.
 * Every phase assertion in the suite passes either way; the difference is three seconds of
 * screen that one of them skips. A mutation battery (2026-09-22) found both of these result-
 * screen exits re-wired to the plain call with 7,330 tests green.
 *
 * So the assertion is the VERB, spied on the prototype, and the phase is asserted beside it so
 * the case cannot pass on a spy that was called and then went nowhere.
 *
 * The result phase is written directly rather than played to. `Game.confirm` is a phase
 * ROUTER — `victory`/`defeat` is an input to it, produced by `RunOutcome` from the sim's own
 * gameover state (covered in `controllers/RunOutcome.test.ts`) — and reaching a real boss kill
 * through a headless `Game` would test the dungeon, not the door out of it.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Container, type Ticker } from 'pixi.js';
import { installFakeTextCanvas } from './screens/fakeTextCanvas';
import { Game } from './Game';
import { ScreenNav } from './controllers/ScreenNav';

installFakeTextCanvas();

const NO_TOUCH = {
  active: false, stickRadius: 0, move: null,
  fire: { cx: 0, cy: 0, r: 0, pressed: false },
  weapon1: { cx: 0, cy: 0, r: 0 }, weapon2: { cx: 0, cy: 0, r: 0 },
  interact: { cx: 0, cy: 0, r: 0, pressed: false },
};

/** A real `Game` on a fake app, reached through the callbacks the real screens expose — same
 *  shape and same reason as `gameRunClock.test.ts`: the thing under test is the wiring, so
 *  nothing here may inject past it. */
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
      read: () => ({ moveX: 0, moveY: 0, firing: false, interacting: false }),
      getTouchVisual: () => NO_TOUCH,
      setControlMirror: () => {},
    } as never,
    { play: () => {}, setSfxVolume: () => {}, setMusicVolume: () => {}, resume: () => {} } as never,
  );
  game.start();

  return game as unknown as {
    run: { phase: string; tutorialActive: boolean };
    mainMenu: { onTutorial: (() => void) | null; onSolo: (() => void) | null };
    loadout: { onStart: (() => void) | null };
    // The REAL result screen: its two buttons are what `gameWiring` points at `confirm()` and
    // at the menu exit.
    screens: { onConfirm: (() => void) | null; onMenu: (() => void) | null };
  };
}

afterEach(() => vi.restoreAllMocks());

describe('the result screen leaves the RUN, not just the screen', () => {
  it('CONTINUE from a finished PvE run goes through the held exit, to the loadout screen', () => {
    const leave = vi.spyOn(ScreenNav.prototype, 'leaveRunTo');
    const g = newGame();
    g.mainMenu.onSolo!();
    g.loadout.onStart!();
    g.run.phase = 'victory'; // what RunOutcome writes when the sim reaches gameover

    g.screens.onConfirm!();

    expect(leave).toHaveBeenCalledWith('loadout');
    expect(g.run.phase).toBe('loadout'); // ...and it really went there, not just reported it
  });

  it('CONTINUE from a finished TUTORIAL goes to the LOBBY, and clears the flag', () => {
    // A tutorial run never touched the loadout, so that screen is the wrong destination
    // (design/10). The flag is also read BEFORE it is cleared, and the two statements are one
    // line apart: clearing first makes every tutorial exit land on the loadout screen, and
    // nothing about either screen looks wrong when it does.
    const leave = vi.spyOn(ScreenNav.prototype, 'leaveRunTo');
    const g = newGame();
    g.mainMenu.onTutorial!();
    g.run.phase = 'victory';

    g.screens.onConfirm!();

    expect(leave).toHaveBeenCalledWith('menu');
    expect(g.run.phase).toBe('menu');
    expect(g.run.tutorialActive).toBe(false);
  });

  it('a DEFEAT takes the same door as a victory', () => {
    // Both terminal phases route through one branch. Losing a run is the more common way to
    // reach this screen, and a branch that named only `victory` would leave it unheld.
    const leave = vi.spyOn(ScreenNav.prototype, 'leaveRunTo');
    const g = newGame();
    g.mainMenu.onSolo!();
    g.loadout.onStart!();
    g.run.phase = 'defeat';

    g.screens.onConfirm!();

    expect(leave).toHaveBeenCalledWith('loadout');
  });

  it('MENU, the other button, is held too', () => {
    // Wired separately from CONTINUE (`gameWiring`'s `screens.onMenu`), so it is a separate
    // chance to reach the plain `showMenu` and skip the transition.
    const leave = vi.spyOn(ScreenNav.prototype, 'leaveRunTo');
    const g = newGame();
    g.mainMenu.onSolo!();
    g.loadout.onStart!();
    g.run.phase = 'defeat';

    g.screens.onMenu!();

    expect(leave).toHaveBeenCalledWith('menu');
    expect(g.run.phase).toBe('menu');
  });

  it('does NOT reach the exit from a phase that is not a result screen — the control', () => {
    // `confirm()` is a router over four phases and the other two mean something else entirely
    // (from the lobby it opens the loadout screen; from the loadout screen it STARTS a run).
    // Without this, a `leaveRunTo` called unconditionally would pass every case above.
    const leave = vi.spyOn(ScreenNav.prototype, 'leaveRunTo');
    const g = newGame();
    g.screens.onConfirm!(); // phase is 'menu' here — the lobby
    expect(leave).not.toHaveBeenCalled();
    expect(g.run.phase).toBe('loadout');
  });
});
