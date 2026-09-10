/**
 * The host half of save-and-continue: the one save slot, its cache, and the localStorage
 * adapter's fail-soft behaviour (ENGINE_VERSION 61, design/05 "Only the boss floor ends a
 * run").
 *
 * The cache is the part worth testing rather than the happy path. `Forge.render` asks "is
 * there a save?" on every keystroke, so the answer is memoized — and a memo is exactly where
 * a stale yes survives a `clearSavedRun`, which would offer CONTINUE for a run that has just
 * been abandoned or won. Every case below that looks like bookkeeping is really about that.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { packRunSave, type RunSaveStore, type SavedRun } from './runSave';
import { buildDungeonRunConfig } from './offlineConfig';
import {
  clearSavedRun, createWebRunSaveStore, loadSavedRun, resetRunSaveCacheForTests,
  savedRunSummary, writeSavedRun,
} from './runSaveStore';

function aSave(over: Partial<SavedRun> = {}): SavedRun {
  const config = buildDungeonRunConfig({
    seed: 11, coop: false, localSeat: { skinId: 'vanguard', loadout: [] }, allySkinId: 'skirmisher',
  });
  return { ...packRunSave({ config, commands: [], ticks: 900, floorIndex: 2, score: 5, nowMs: 77 }), ...over };
}

/** An in-memory stand-in for localStorage, with the failure modes named. */
function fakeStore(opts: { full?: boolean; corrupt?: boolean; throwOnLoad?: boolean } = {}) {
  let held: unknown = opts.corrupt ? { saveVersion: 999 } : null;
  const calls: string[] = [];
  const store: RunSaveStore = {
    load() {
      calls.push('load');
      if (opts.throwOnLoad) throw new Error('unreadable');
      return held;
    },
    save(v) {
      calls.push('save');
      if (opts.full) return false;
      held = JSON.parse(JSON.stringify(v));
      return true;
    },
    clear() {
      calls.push('clear');
      held = null;
    },
  };
  return { store, calls, peek: () => held };
}

beforeEach(() => {
  resetRunSaveCacheForTests();
});

describe('the save slot', () => {
  it('reads the store once and answers from the cache afterwards', () => {
    const f = fakeStore();
    f.store.save(aSave());
    f.calls.length = 0;

    expect(loadSavedRun(f.store)!.floorIndex).toBe(2);
    expect(loadSavedRun(f.store)!.floorIndex).toBe(2);
    expect(loadSavedRun(f.store)!.floorIndex).toBe(2);
    expect(f.calls.filter((c) => c === 'load')).toHaveLength(1);
  });

  it('answers null — and caches THAT — when the store is empty', () => {
    // The common case on a fresh account, and the one a naive `if (!cached) reload` cache
    // gets wrong: "no save" has to be a remembered answer, not a reason to re-read.
    const f = fakeStore();
    expect(loadSavedRun(f.store)).toBeNull();
    expect(loadSavedRun(f.store)).toBeNull();
    expect(f.calls.filter((c) => c === 'load')).toHaveLength(1);
  });

  it('a write is visible immediately, without another read', () => {
    const f = fakeStore();
    expect(loadSavedRun(f.store)).toBeNull(); // caches the empty answer
    expect(writeSavedRun(aSave({ floorIndex: 3 }), f.store)).toBe(true);
    expect(loadSavedRun(f.store)!.floorIndex).toBe(3);
    expect(f.calls.filter((c) => c === 'load')).toHaveLength(1);
  });

  it('a clear is visible immediately — the cache cannot outlive the save', () => {
    // The failure this guards: `RunOutcome.handle` clears the slot when a run is won, and a
    // cached yes would leave the Forge offering to continue a finished run.
    const f = fakeStore();
    writeSavedRun(aSave(), f.store);
    expect(loadSavedRun(f.store)).not.toBeNull();

    clearSavedRun(f.store);
    expect(loadSavedRun(f.store)).toBeNull();
    expect(savedRunSummary(f.store)).toBeNull();
    expect(f.peek()).toBeNull(); // and it really left the store, not just the cache
  });

  it('keeps the in-memory copy when the store refuses the write, and still says it failed', () => {
    // A quota failure or a host with no storage. The run is still resumable in THIS session,
    // which is why the value is cached; the false is what makes `saveAndQuitRun` tell the
    // player instead of walking them to the Forge on a promise it cannot keep.
    const f = fakeStore({ full: true });
    expect(writeSavedRun(aSave({ floorIndex: 4 }), f.store)).toBe(false);
    expect(loadSavedRun(f.store)!.floorIndex).toBe(4);
    expect(f.peek()).toBeNull();
  });

  it('treats a save it cannot parse as no save at all', () => {
    const f = fakeStore({ corrupt: true });
    expect(loadSavedRun(f.store)).toBeNull();
  });

  it('replaces rather than accumulates — there is exactly one slot', () => {
    const f = fakeStore();
    writeSavedRun(aSave({ floorIndex: 0 }), f.store);
    writeSavedRun(aSave({ floorIndex: 1 }), f.store);
    expect(loadSavedRun(f.store)!.floorIndex).toBe(1);
  });
});

describe('savedRunSummary', () => {
  it('reports floor, ticks and timestamp without touching the command stream', () => {
    const f = fakeStore();
    writeSavedRun(aSave(), f.store);
    expect(savedRunSummary(f.store)).toEqual({ floorIndex: 2, ticks: 900, savedAtMs: 77 });
  });

  it('shares the slot with loadSavedRun rather than reading again', () => {
    const f = fakeStore();
    writeSavedRun(aSave(), f.store);
    f.calls.length = 0;
    savedRunSummary(f.store);
    savedRunSummary(f.store);
    expect(f.calls).toEqual([]);
  });
});

describe('createWebRunSaveStore — no localStorage in this environment', () => {
  // Node has no localStorage here (the same reason every other UI test avoids the DOM), so
  // this is the NO-STORAGE host shape — which is also WeChat's today, see runSave.ts. Each
  // path has to fail soft in the right direction rather than throw into a keydown handler.
  it('loads nothing, refuses to save, and clears without complaint', () => {
    expect(typeof localStorage).toBe('undefined');
    const store = createWebRunSaveStore('test.key');
    expect(store.load()).toBeNull();
    expect(store.save(aSave())).toBe(false);
    expect(() => store.clear()).not.toThrow();
  });

  it('is the default store, so a caller that passes nothing still gets a safe answer', () => {
    expect(loadSavedRun()).toBeNull();
    expect(savedRunSummary()).toBeNull();
    expect(writeSavedRun(aSave())).toBe(false);
    expect(() => clearSavedRun()).not.toThrow();
  });
});

describe('createWebRunSaveStore — against a stand-in localStorage', () => {
  // The web path itself, which the case above cannot reach. A minimal fake is installed as
  // the global rather than pulling in a DOM: what is under test is this adapter's own
  // JSON/try-catch handling, not the browser's.
  const KEY = 'test.runsave';

  function withLocalStorage<T>(impl: Partial<Storage>, body: () => T): T {
    const g = globalThis as { localStorage?: unknown };
    const had = 'localStorage' in g;
    const prev = g.localStorage;
    g.localStorage = impl;
    try {
      return body();
    } finally {
      if (had) g.localStorage = prev;
      else delete g.localStorage;
    }
  }

  it('round-trips a save through get/setItem', () => {
    const held = new Map<string, string>();
    withLocalStorage({
      getItem: (k: string) => held.get(k) ?? null,
      setItem: (k: string, v: string) => void held.set(k, v),
      removeItem: (k: string) => void held.delete(k),
    }, () => {
      const store = createWebRunSaveStore(KEY);
      expect(store.save(aSave({ floorIndex: 3 }))).toBe(true);
      expect((store.load() as SavedRun).floorIndex).toBe(3);
      store.clear();
      expect(store.load()).toBeNull();
    });
  });

  it('reports false when setItem throws — the quota case a long run really hits', () => {
    withLocalStorage({
      getItem: () => null,
      setItem: () => { throw new Error('QuotaExceededError'); },
      removeItem: () => {},
    }, () => {
      expect(createWebRunSaveStore(KEY).save(aSave())).toBe(false);
    });
  });

  it('answers null for unparseable stored text instead of throwing on the way in', () => {
    withLocalStorage({
      getItem: () => '{not json',
      setItem: () => {},
      removeItem: () => {},
    }, () => {
      expect(createWebRunSaveStore(KEY).load()).toBeNull();
    });
  });

  it('answers null when getItem itself throws (blocked site data)', () => {
    withLocalStorage({
      getItem: () => { throw new Error('access denied'); },
      setItem: () => {},
      removeItem: () => {},
    }, () => {
      expect(createWebRunSaveStore(KEY).load()).toBeNull();
    });
  });

  it('swallows a failing removeItem — a failed clear must not break leaving a run', () => {
    withLocalStorage({
      getItem: () => null,
      setItem: () => {},
      removeItem: () => { throw new Error('nope'); },
    }, () => {
      expect(() => createWebRunSaveStore(KEY).clear()).not.toThrow();
    });
  });
});
