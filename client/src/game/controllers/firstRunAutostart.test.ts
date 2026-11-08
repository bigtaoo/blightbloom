/**
 * `firstRunAutostart` — when a boot skips the menu into the first run.
 *
 * What would fail silently: a returning player (or one with a run saved) thrown into a fresh
 * run that wipes the save slot, a dev `?online=1` / `?pvp=1` / `?replay=` page hijacked into a
 * solo dungeon, and a second call (an entry calling twice, or a late portal intent) starting a
 * run on top of a run. Every case asserts BOTH the answer and whether `beginQuickRun` ran, so
 * a rule that answers right and still starts a run cannot pass.
 */
import { describe, expect, it, vi } from 'vitest';
import { autoStartFirstRun, shouldAutoStartFirstRun, type FirstRunAutostartView } from './firstRunAutostart';

const fresh = (over: Partial<FirstRunAutostartView> = {}): FirstRunAutostartView => ({
  phase: 'menu', meta: { hasSeenTutorial: false }, online: false, pvp: false, replayUrl: null, ...over,
});

function run(view: FirstRunAutostartView, hasSave = false) {
  const beginQuickRun = vi.fn();
  const started = autoStartFirstRun({ run: view, runs: { beginQuickRun }, hasSave: () => hasSave });
  return { started, calls: beginQuickRun.mock.calls.length };
}

describe('autoStartFirstRun', () => {
  it('starts the first run for a first-time player on the menu with nothing saved', () => {
    expect(run(fresh())).toEqual({ started: true, calls: 1 });
  });

  it.each<[string, FirstRunAutostartView, boolean]>([
    ['a returning player', fresh({ meta: { hasSeenTutorial: true } }), false],
    ['a run save exists', fresh(), true],
    ['already off the menu (a run, a replay, an invite)', fresh({ phase: 'playing' }), false],
    ['already in the squad screen', fresh({ phase: 'squad' }), false],
    ['a dev ?online=1 page', fresh({ online: true }), false],
    ['a dev ?pvp=1 page', fresh({ pvp: true }), false],
    ['a dev ?replay= page', fresh({ replayUrl: '/r.json' }), false],
  ])('leaves the menu alone for %s', (_name, view, hasSave) => {
    expect(run(view, hasSave)).toEqual({ started: false, calls: 0 });
    expect(shouldAutoStartFirstRun(view, hasSave)).toBe(false);
  });

  it('reads the real save slot when no probe is injected (empty in a fresh test env)', () => {
    const beginQuickRun = vi.fn();
    expect(autoStartFirstRun({ run: fresh(), runs: { beginQuickRun } })).toBe(true);
    expect(beginQuickRun).toHaveBeenCalledTimes(1);
  });
});
