/**
 * `ForgeInput` — the between-run keyboard table.
 *
 * Measured right after the 2026-09-03 split, this file was at 17.85% lines / 4.16% branches:
 * the verb wrappers were driven by the screens' button tests, and the key table above them
 * was reachable only through a real `window` on a real `Game`. It is a dispatch table, so the
 * interesting content is entirely in the branches — which key does what, and which keys do
 * nothing.
 *
 * The phase guard is the load-bearing one, and since 2026-09-21 there are two of them: the
 * hub is two screens (LOADOUT and FORGE) and each key belongs to exactly one. Every one of
 * these keys is also a normal key in some other screen (C, X, B, F, digits), so a handler
 * that fired outside its own phase would craft weapons while a player is typing their
 * password into the login screen — and, one screen closer to home, a [1] on the loadout
 * screen would craft from a grid that is not on it.
 */
import { describe, expect, it, vi } from 'vitest';
import { defaultMetaState, type MetaState, type MetaStore } from '../../meta';
import { RunState } from '../runState';
import { ForgeInput, type ForgeInputDeps } from './ForgeInput';

const store: MetaStore = { load: () => defaultMetaState(), save: () => {} };

function make(over: Partial<ForgeInputDeps> = {}) {
  const run = new RunState(store);
  run.phase = 'forge';
  const tagged = (tag: string) => vi.fn((m: MetaState) => ({ ...m, selectedSkin: tag }));
  const forgeActions = {
    craftAt: vi.fn((m: MetaState) => ({ ...m, selectedSkin: 'crafted' })),
    cycleCharacter: tagged('cycled'),
    clear: tagged('cleared'),
    moveSelection: vi.fn(),
  };
  const deps: ForgeInputDeps = {
    run,
    layers: { menu: { fit: () => ({ w: 800, h: 600 }) } } as never,
    forge: { order: ['a', 'b', 'c'] } as never,
    forgeActions: forgeActions as never,
    screenSize: () => ({ w: 1600, h: 1200 }),
    openSettings: vi.fn(),
    openStore: vi.fn(),
    openForge: vi.fn(),
    confirm: vi.fn(),
    ...over,
  };
  return { fi: new ForgeInput(deps), run, deps, forgeActions };
}

describe('the verbs', () => {
  it.each([
    ['craftAt', 'crafted'],
    ['cycleCharacter', 'cycled'],
    ['clear', 'cleared'],
  ] as const)('%s writes the result back onto run.meta', (verb, tag) => {
    // The wrapper looks like ceremony, and the assertion is why it is not: `ForgeActions`
    // returns a NEW meta rather than mutating, so a wrapper that dropped the return value
    // would leave the screen redrawn and the state unchanged — the craft would visibly
    // happen and then be gone on the next render.
    const t = make();
    if (verb === 'craftAt') t.fi.craftAt(0);
    else t.fi[verb]();
    expect(t.run.meta.selectedSkin).toBe(tag);
  });

  it('passes menu design space, not the raw renderer size', () => {
    // These screens lay out in menu space (800x600 here); handing them the renderer's
    // 1600x1200 puts every row off-screen on a HiDPI display.
    const t = make();
    t.fi.craftAt(2);
    expect(t.forgeActions.craftAt).toHaveBeenCalledWith(expect.anything(), 2, 800, 600);
  });
});

describe('onKey — the FORGE phase table', () => {
  it.each([
    ['Digit1', 'craftAt'],
    ['Digit3', 'craftAt'],
  ] as const)('%s runs %s', (code, action) => {
    const t = make();
    t.fi.onKey(code);
    expect(t.forgeActions[action]).toHaveBeenCalledTimes(1);
  });

  it('maps a digit to its ZERO-BASED row', () => {
    // Off by one here crafts the wrong weapon, spends the wrong materials, and looks
    // perfectly normal.
    const t = make();
    t.fi.onKey('Digit2');
    expect(t.forgeActions.craftAt).toHaveBeenCalledWith(expect.anything(), 1, 800, 600);
  });

  it('IGNORES a digit past the end of the row list', () => {
    // `forge.order` has three entries here. Without the bounds check `craftAt` runs against
    // an undefined row.
    const t = make();
    t.fi.onKey('Digit4');
    t.fi.onKey('Digit9');
    expect(t.forgeActions.craftAt).not.toHaveBeenCalled();
  });

  it('B opens the STORE — it no longer grants a blueprint', () => {
    // This key used to run `ForgeActions.acquireBlueprint`, the `demo: free grant` scaffold
    // (ROADMAP 2.4). Asserting on the forge actions too is the point of the second half: a
    // regression that put the grant back would still leave `openStore` called.
    const t = make();
    t.fi.onKey('KeyB');
    expect(t.deps.openStore).toHaveBeenCalledTimes(1);
    for (const fn of Object.values(t.forgeActions)) expect(fn).not.toHaveBeenCalled();
  });

  it('the arrows only MOVE the browse cursor — they never craft', () => {
    // design/10's compare card. An arrow that crafted would spend materials on a keypress
    // whose whole purpose is to look at something.
    const t = make();
    t.fi.onKey('ArrowUp');
    t.fi.onKey('ArrowDown');
    expect(t.forgeActions.moveSelection.mock.calls.map((c) => c[1])).toEqual([-1, 1]);
    expect(t.forgeActions.craftAt).not.toHaveBeenCalled();
  });

  it('ignores the LOADOUT screen\'s own keys — that screen is not on top', () => {
    // The half of the split a single merged table would get wrong: [X] on the crafting page
    // would empty a loadout whose cards the player cannot see, and [Enter] would start a run
    // from a screen with no START RUN on it.
    const t = make();
    for (const code of ['KeyC', 'KeyX', 'KeyF', 'KeyO', 'Enter', 'NumpadEnter']) t.fi.onKey(code);
    expect(t.forgeActions.cycleCharacter).not.toHaveBeenCalled();
    expect(t.forgeActions.clear).not.toHaveBeenCalled();
    expect(t.deps.openForge).not.toHaveBeenCalled();
    expect(t.deps.openSettings).not.toHaveBeenCalled();
    expect(t.deps.confirm).not.toHaveBeenCalled();
  });

  it('ignores a key that means nothing here', () => {
    const t = make();
    for (const code of ['KeyQ', 'Space', 'F9', 'Escape', 'Digit0', 'ShiftLeft']) t.fi.onKey(code);
    for (const fn of Object.values(t.forgeActions)) expect(fn).not.toHaveBeenCalled();
    expect(t.deps.openStore).not.toHaveBeenCalled();
  });
});

describe('onKey — the LOADOUT phase table', () => {
  function loadoutPhase() {
    const t = make();
    t.run.phase = 'loadout';
    return t;
  }

  it.each([
    ['KeyC', 'cycleCharacter'],
    ['KeyX', 'clear'],
  ] as const)('%s runs %s', (code, action) => {
    const t = loadoutPhase();
    t.fi.onKey(code);
    expect(t.forgeActions[action]).toHaveBeenCalledTimes(1);
  });

  it('F opens the crafting page — the FORGE card, as a key', () => {
    const t = loadoutPhase();
    t.fi.onKey('KeyF');
    expect(t.deps.openForge).toHaveBeenCalledTimes(1);
    for (const fn of Object.values(t.forgeActions)) expect(fn).not.toHaveBeenCalled();
  });

  it('O opens settings and Enter confirms — neither touches the meta', () => {
    const t = loadoutPhase();
    t.fi.onKey('KeyO');
    expect(t.deps.openSettings).toHaveBeenCalledTimes(1);
    t.fi.onKey('Enter');
    t.fi.onKey('NumpadEnter');
    expect(t.deps.confirm).toHaveBeenCalledTimes(2);
    expect(t.forgeActions.craftAt).not.toHaveBeenCalled();
  });

  it('ignores the FORGE page\'s own keys — its grid is not on this screen', () => {
    const t = loadoutPhase();
    for (const code of ['Digit1', 'Digit2', 'KeyB', 'ArrowUp', 'ArrowDown']) t.fi.onKey(code);
    expect(t.forgeActions.craftAt).not.toHaveBeenCalled();
    expect(t.forgeActions.moveSelection).not.toHaveBeenCalled();
    expect(t.deps.openStore).not.toHaveBeenCalled();
  });
});

describe('the phase guard', () => {
  it.each(['menu', 'playing', 'paused', 'settings', 'account', 'squad', 'victory', 'store'] as const)(
    'does nothing at all in the %s phase',
    (phase) => {
      const t = make();
      t.run.phase = phase;
      for (const code of ['Digit1', 'KeyC', 'KeyX', 'KeyB', 'KeyF', 'KeyO', 'Enter', 'ArrowUp']) {
        t.fi.onKey(code);
      }
      for (const fn of Object.values(t.forgeActions)) expect(fn, phase).not.toHaveBeenCalled();
      expect(t.deps.openSettings, phase).not.toHaveBeenCalled();
      expect(t.deps.openForge, phase).not.toHaveBeenCalled();
      // 'store' is the one that matters most here: the purchase screen is a full phase
      // precisely so no craft digit is live under a modal asking for money.
      expect(t.deps.openStore, phase).not.toHaveBeenCalled();
      expect(t.deps.confirm, phase).not.toHaveBeenCalled();
    },
  );

  it('...and the same keys all work in the two hub phases — the control', () => {
    // Without this, every assertion above would pass just as happily if `onKey` did nothing
    // in any phase.
    const t = make();
    t.run.phase = 'forge';
    t.fi.onKey('Digit1');
    t.fi.onKey('KeyB');
    expect(t.forgeActions.craftAt).toHaveBeenCalled();
    expect(t.deps.openStore).toHaveBeenCalled();

    t.run.phase = 'loadout';
    t.fi.onKey('KeyO');
    t.fi.onKey('KeyF');
    t.fi.onKey('Enter');
    expect(t.deps.openSettings).toHaveBeenCalled();
    expect(t.deps.openForge).toHaveBeenCalled();
    expect(t.deps.confirm).toHaveBeenCalled();
  });
});
