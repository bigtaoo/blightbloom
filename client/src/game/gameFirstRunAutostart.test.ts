/**
 * The first-boot autostart end to end through a real `Game` (`controllers/firstRunAutostart.ts`):
 * `start()` alone still lands on the menu — every entry point's `start()` is shared with the
 * tests and the replay path — and `startFirstRunIfNew()` is what moves a first-time player into
 * a live run with the first-run hints armed. A returning player stays on the menu, and a second
 * call cannot stack a run on the first.
 */
import { describe, it, expect } from 'vitest';
import { Container, type Ticker } from 'pixi.js';
import { installFakeTextCanvas } from './screens/fakeTextCanvas';
import { Game } from './Game';

installFakeTextCanvas();

const NO_TOUCH = {
  active: false, stickRadius: 0, move: null,
  fire: { cx: 0, cy: 0, r: 0, pressed: false },
  weapon1: { cx: 0, cy: 0, r: 0 }, weapon2: { cx: 0, cy: 0, r: 0 },
  interact: { cx: 0, cy: 0, r: 0, pressed: false },
};

interface RunView {
  phase: string;
  firstRunHints: boolean;
  runCount: number;
  meta: { hasSeenTutorial: boolean };
  setMeta(m: unknown): void;
}

function newGame(seen: boolean) {
  const app = {
    stage: new Container(),
    renderer: { screen: { width: 1280, height: 720 }, resolution: 1, resize: () => {} },
    ticker: { add: (_cb: (t: Ticker) => void) => {}, remove: () => {} },
    canvas: {},
  } as unknown as ConstructorParameters<typeof Game>[0];
  const game = new Game(
    app,
    {
      onSwitchWeapon: null, attach: () => {},
      read: () => ({ moveX: 0, moveY: 0, firing: false, interacting: false }),
      getTouchVisual: () => NO_TOUCH, setControlMirror: () => {},
    } as never,
    { play: () => {}, setSfxVolume: () => {}, setMusicVolume: () => {}, resume: () => {} } as never,
  );
  const run = (game as unknown as { run: RunView }).run;
  run.setMeta({ ...run.meta, hasSeenTutorial: seen });
  game.start();
  return { game, run };
}

describe('Game.startFirstRunIfNew', () => {
  it('start() alone lands on the menu; the autostart moves a first-time player into a taught run', () => {
    const { game, run } = newGame(false);
    expect(run.phase).toBe('menu');
    expect(game.startFirstRunIfNew()).toBe(true);
    expect(run.phase).toBe('playing');
    expect(run.firstRunHints).toBe(true);
    expect(run.runCount).toBe(1);
    // A second call — a late portal intent, an entry calling twice — starts nothing more.
    expect(game.startFirstRunIfNew()).toBe(false);
    expect(run.runCount).toBe(1);
  });

  it('leaves a returning player on the menu', () => {
    const { game, run } = newGame(true);
    expect(game.startFirstRunIfNew()).toBe(false);
    expect(run.phase).toBe('menu');
    expect(run.runCount).toBe(0);
  });
});
