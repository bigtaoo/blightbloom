import { afterEach, describe, expect, it } from 'vitest';
import { createAnalytics, resetAnalyticsForTests, setAnalytics } from './analytics';
import type { AnalyticsBatch } from './analyticsEvents';
import {
  FIRST_INPUT_MAX_MS,
  isGameKey,
  trackFirstInput,
  watchFirstInput,
  type FirstInputKey,
  type FirstInputTarget,
} from './firstInput';

/** A window stand-in that records listeners with their options, keyed by type. */
function fakeTarget() {
  const listeners = new Map<string, Set<(e: FirstInputKey) => void>>();
  const optsSeen: unknown[] = [];
  const target: FirstInputTarget = {
    addEventListener: (type, fn, opts) => {
      optsSeen.push(opts);
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener: (type, fn) => void listeners.get(type)?.delete(fn),
  };
  const dispatch = (type: string, e: FirstInputKey = { key: 'w' }): void => {
    for (const fn of [...(listeners.get(type) ?? [])]) fn(e);
  };
  const count = (): number => [...listeners.values()].reduce((n, s) => n + s.size, 0);
  return { target, dispatch, count, optsSeen };
}

afterEach(() => resetAnalyticsForTests());

describe('watchFirstInput', () => {
  it('reports a key press with the ms since it was armed', () => {
    const t = fakeTarget();
    let clock = 1_000;
    const seen: [string, number][] = [];
    watchFirstInput(t.target, () => clock, (kind, ms) => seen.push([kind, ms]));
    clock = 3_450.4;
    t.dispatch('keydown');
    expect(seen).toEqual([['key', 2_450]]);
  });

  it('ignores the keys of someone leaving or working the browser, then reports a game key', () => {
    const t = fakeTarget();
    const seen: string[] = [];
    watchFirstInput(t.target, () => 0, (kind) => seen.push(kind));
    for (const key of ['Alt', 'Meta', 'Control', 'Tab', 'F5', 'F12', 'CapsLock']) t.dispatch('keydown', { key });
    t.dispatch('keydown', { key: 'Tab', altKey: true }); // Alt-Tab
    t.dispatch('keydown', { key: 'w', ctrlKey: true }); // Ctrl-W
    t.dispatch('keydown', { key: 't', metaKey: true }); // Cmd-T
    expect(seen).toEqual([]);
    expect(t.count()).toBe(2); // still listening
    t.dispatch('keydown', { key: 'W', shiftKey: true } as FirstInputKey); // the control: a game key
    expect(seen).toEqual(['key']);
  });

  it('isGameKey: movement, action and Escape count; a key-less event is given the benefit', () => {
    for (const key of ['w', 'a', ' ', 'ArrowUp', '1', 'Escape', 'Shift']) {
      expect(isGameKey({ key }), key).toBe(key !== 'Shift');
    }
    expect(isGameKey({})).toBe(true);
  });

  it('reports a pointer press as pointer', () => {
    const t = fakeTarget();
    const seen: string[] = [];
    watchFirstInput(t.target, () => 0, (kind) => seen.push(kind));
    t.dispatch('pointerdown');
    expect(seen).toEqual(['pointer']);
  });

  it('fires ONCE and then removes both listeners', () => {
    const t = fakeTarget();
    const seen: string[] = [];
    watchFirstInput(t.target, () => 0, (kind) => seen.push(kind));
    expect(t.count()).toBe(2);
    t.dispatch('pointerdown');
    t.dispatch('keydown');
    t.dispatch('pointerdown');
    expect(seen).toEqual(['pointer']);
    expect(t.count()).toBe(0);
  });

  it('listens in the capture phase, passively, so the game cannot hide a press', () => {
    const t = fakeTarget();
    watchFirstInput(t.target, () => 0, () => {});
    expect(t.optsSeen).toEqual([
      { capture: true, passive: true },
      { capture: true, passive: true },
    ]);
  });

  it('clamps a long wait to the vocabulary bound rather than sending a value it drops', () => {
    const t = fakeTarget();
    let clock = 0;
    const seen: number[] = [];
    watchFirstInput(t.target, () => clock, (_k, ms) => seen.push(ms));
    clock = FIRST_INPUT_MAX_MS * 3;
    t.dispatch('keydown');
    expect(seen).toEqual([FIRST_INPUT_MAX_MS]);
  });

  it('never reports a negative wait from a clock that stepped back', () => {
    const t = fakeTarget();
    let clock = 500;
    const seen: number[] = [];
    watchFirstInput(t.target, () => clock, (_k, ms) => seen.push(ms));
    clock = 100;
    t.dispatch('keydown');
    expect(seen).toEqual([0]);
  });

  it('the disposer removes the listeners and nothing fires after it', () => {
    const t = fakeTarget();
    const seen: string[] = [];
    const stop = watchFirstInput(t.target, () => 0, (kind) => seen.push(kind));
    stop();
    expect(t.count()).toBe(0);
    t.dispatch('keydown');
    expect(seen).toEqual([]);
  });
});

describe('trackFirstInput', () => {
  it('tracks first_input with ms, kind and the screen read AT the press', () => {
    const batches: AnalyticsBatch[] = [];
    const a = createAnalytics({
      install: 'i', session: 's', host: 'playgama', build: () => 'b', locale: () => 'en', now: () => 0,
      send: (b) => void batches.push(b),
    });
    setAnalytics(a);
    const t = fakeTarget();
    let clock = 0;
    let screen = 'menu';
    trackFirstInput(t.target, () => clock, () => screen);
    clock = 1_200;
    screen = 'playing';
    t.dispatch('keydown');
    a.flush();
    expect(batches[0]!.events).toEqual([{ name: 'first_input', at: 0, props: { ms: 1_200, kind: 'key', screen: 'playing' } }]);
  });
});
