/**
 * MetaStore (design/14 persistent between-run layer). Structural twin of
 * settings/store.test.ts — same fails-soft/migrate() convention (see store.ts's own
 * note), mirrored here with the same fake-localStorage shim and test style.
 */
import { describe, it, expect } from 'vitest';
import { createWebMetaStore, MemoryMetaStore, migrate } from './store';
import { defaultMetaState } from './MetaState';

// jsdom-free: this repo's plain-node vitest has no `localStorage`, so exercise the
// migrate()/fails-soft path directly the way store.ts itself falls back — via an
// in-memory `localStorage` shim scoped to this file only.
function withFakeLocalStorage<T>(fn: () => T): T {
  const data = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => data.set(k, v),
    removeItem: (k: string) => data.delete(k),
  };
  try {
    return fn();
  } finally {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  }
}

describe('MemoryMetaStore', () => {
  it('defaults to defaultMetaState() when constructed with no initial state', () => {
    expect(new MemoryMetaStore().load()).toEqual(defaultMetaState());
  });

  it('round-trips a saved state', () => {
    const store = new MemoryMetaStore();
    const next = { ...defaultMetaState(), materialBank: { mat_fire: 3 } };
    store.save(next);
    expect(store.load()).toEqual(next);
  });

  it('accepts an initial state via the constructor', () => {
    const initial = { ...defaultMetaState(), hasSeenTutorial: true };
    expect(new MemoryMetaStore(initial).load()).toEqual(initial);
  });
});

describe('createWebMetaStore — no localStorage available', () => {
  it('load() returns a fresh default state instead of throwing', () => {
    expect(() => createWebMetaStore('t.meta.nolocalstorage').load()).not.toThrow();
    expect(createWebMetaStore('t.meta.nolocalstorage').load()).toEqual(defaultMetaState());
  });

  it('save() is a silent no-op instead of throwing', () => {
    expect(() => createWebMetaStore('t.meta.nolocalstorage').save(defaultMetaState())).not.toThrow();
  });
});

describe('createWebMetaStore — round-trip', () => {
  it('save() then load() returns the saved state', () => {
    withFakeLocalStorage(() => {
      const store = createWebMetaStore('t.meta.1');
      const next = { ...defaultMetaState(), unlockedBlueprints: [...defaultMetaState().unlockedBlueprints, 'extra_bp'] };
      store.save(next);
      expect(createWebMetaStore('t.meta.1').load()).toEqual(next);
    });
  });

  it('load() with no prior save returns a fresh default state', () => {
    withFakeLocalStorage(() => {
      expect(createWebMetaStore('t.meta.2').load()).toEqual(defaultMetaState());
    });
  });
});

describe('createWebMetaStore — fails soft on a corrupt/unreadable save', () => {
  it('a value that is not JSON still yields a fully-defaulted state, not a throw', () => {
    withFakeLocalStorage(() => {
      localStorage.setItem('t.meta.3', 'not json');
      expect(() => createWebMetaStore('t.meta.3').load()).not.toThrow();
      expect(createWebMetaStore('t.meta.3').load()).toEqual(defaultMetaState());
    });
  });

  it('a localStorage.getItem that throws (e.g. private-mode/security error) still yields a default state', () => {
    withFakeLocalStorage(() => {
      localStorage.getItem = () => {
        throw new Error('SecurityError');
      };
      expect(() => createWebMetaStore('t.meta.4').load()).not.toThrow();
      expect(createWebMetaStore('t.meta.4').load()).toEqual(defaultMetaState());
    });
  });

  it('a localStorage.setItem that throws (e.g. quota exceeded) is swallowed, not thrown', () => {
    withFakeLocalStorage(() => {
      localStorage.setItem = () => {
        throw new Error('QuotaExceededError');
      };
      expect(() => createWebMetaStore('t.meta.5').save(defaultMetaState())).not.toThrow();
    });
  });
});

describe('migrate()', () => {
  it('returns full defaults for a non-object/null parsed value', () => {
    expect(migrate(null)).toEqual(defaultMetaState());
    expect(migrate(undefined)).toEqual(defaultMetaState());
    expect(migrate('a string')).toEqual(defaultMetaState());
    expect(migrate(42)).toEqual(defaultMetaState());
  });

  it('passes through a well-formed, already-valid save unchanged', () => {
    const saved = defaultMetaState();
    expect(migrate(saved)).toEqual(saved);
  });

  it('backfills a field missing entirely (an older save predating it)', () => {
    const { hasSeenTutorial, ...rest } = defaultMetaState();
    void hasSeenTutorial;
    expect(migrate(rest).hasSeenTutorial).toBe(defaultMetaState().hasSeenTutorial);
  });

  it('keeps a saved best floor, and backfills 0 for a save from before it existed or a bad value', () => {
    expect(migrate({ ...defaultMetaState(), bestFloor: 6 }).bestFloor).toBe(6);
    const { bestFloor, ...older } = defaultMetaState();
    void bestFloor;
    expect(migrate(older).bestFloor).toBe(0);
    for (const bad of [-2, Number.NaN, '7', null]) {
      expect(migrate({ ...defaultMetaState(), bestFloor: bad }).bestFloor, String(bad)).toBe(0);
    }
    expect(migrate({ ...defaultMetaState(), bestFloor: 4.7 }).bestFloor).toBe(4);
  });

  it('backfills chapter 1 and no clears for a save from before chapters existed', () => {
    const { selectedChapter, clearedChapters, ...older } = defaultMetaState();
    void selectedChapter;
    void clearedChapters;
    const m = migrate(older);
    expect(m.selectedChapter).toBe('ember');
    expect(m.clearedChapters).toEqual([]);
  });

  it('keeps a known chapter pick and falls back to chapter 1 for anything else', () => {
    expect(migrate({ ...defaultMetaState(), selectedChapter: 'frost' }).selectedChapter).toBe('frost');
    for (const bad of ['sand', 3, null, '']) {
      expect(migrate({ ...defaultMetaState(), selectedChapter: bad }).selectedChapter, String(bad)).toBe('ember');
    }
  });

  it('keeps cleared chapter ids, de-duplicated, dropping non-strings — and KEEPS an id this build does not know', () => {
    // An id a newer build wrote (chapter 3) must survive a round trip through this one, or a
    // stale tab would re-lock a chapter the player already opened.
    const m = migrate({ ...defaultMetaState(), clearedChapters: ['ember', 'ember', 7, null, 'storm'] });
    expect(m.clearedChapters).toEqual(['ember', 'storm']);
    expect(migrate({ ...defaultMetaState(), clearedChapters: 'ember' }).clearedChapters).toEqual([]);
  });

  it('unions unlockedBlueprints with the current defaults rather than replacing them', () => {
    const saved = { ...defaultMetaState(), unlockedBlueprints: ['custom_bp'] };
    const result = migrate(saved).unlockedBlueprints;
    for (const bp of defaultMetaState().unlockedBlueprints) expect(result).toContain(bp);
    expect(result).toContain('custom_bp');
  });

  it('unions ownedCharacters with the current defaults rather than replacing them', () => {
    const saved = { ...defaultMetaState(), ownedCharacters: ['custom_skin'] };
    const result = migrate(saved).ownedCharacters;
    for (const c of defaultMetaState().ownedCharacters) expect(result).toContain(c);
    expect(result).toContain('custom_skin');
  });

  it('drops non-string entries from a saved unlockedBlueprints/ownedCharacters array', () => {
    const saved = { ...defaultMetaState(), unlockedBlueprints: ['ok_bp', 42, null, {}], ownedCharacters: ['ok_skin', 7] };
    const result = migrate(saved);
    expect(result.unlockedBlueprints).toContain('ok_bp');
    expect(result.unlockedBlueprints).not.toContain(42);
    expect(result.ownedCharacters).toContain('ok_skin');
    expect(result.ownedCharacters).not.toContain(7);
  });

  it('falls back to the defaults when unlockedBlueprints/ownedCharacters is not an array', () => {
    const saved = { ...defaultMetaState(), unlockedBlueprints: 'not-an-array', ownedCharacters: 123 };
    const result = migrate(saved);
    expect(result.unlockedBlueprints).toEqual([...defaultMetaState().unlockedBlueprints]);
    expect(result.ownedCharacters).toEqual([...defaultMetaState().ownedCharacters]);
  });

  it('filters loadout down to string entries and defaults to empty when not an array', () => {
    expect(migrate({ ...defaultMetaState(), loadout: ['w1', 5, 'w2'] }).loadout).toEqual(['w1', 'w2']);
    expect(migrate({ ...defaultMetaState(), loadout: 'nope' }).loadout).toEqual([]);
    expect(migrate({ ...defaultMetaState(), loadout: undefined }).loadout).toEqual([]);
  });

  it('keeps a well-typed selectedSkin, falls back to the default otherwise', () => {
    expect(migrate({ ...defaultMetaState(), selectedSkin: 'custom' }).selectedSkin).toBe('custom');
    expect(migrate({ ...defaultMetaState(), selectedSkin: 99 }).selectedSkin).toBe(defaultMetaState().selectedSkin);
  });

  it('keeps a well-typed hasSeenTutorial, falls back to the default otherwise', () => {
    expect(migrate({ ...defaultMetaState(), hasSeenTutorial: true }).hasSeenTutorial).toBe(true);
    expect(migrate({ ...defaultMetaState(), hasSeenTutorial: 'yes' }).hasSeenTutorial).toBe(defaultMetaState().hasSeenTutorial);
  });

  describe('materialBank number-coercion fix (see store.ts\'s own comment on this field)', () => {
    it('keeps well-typed finite-number entries', () => {
      expect(migrate({ ...defaultMetaState(), materialBank: { mat_fire: 3, mat_ice: 0 } }).materialBank).toEqual({
        mat_fire: 3,
        mat_ice: 0,
      });
    });

    it('drops a string quantity instead of trusting it — the bug this fix defends against: forge.ts\'s `sum + e.qty` reduce would do string concatenation, not addition', () => {
      const result = migrate({ ...defaultMetaState(), materialBank: { mat_fire: '3' } }).materialBank;
      expect(result).toEqual({});
      expect(result.mat_fire).toBeUndefined();
    });

    it('drops NaN/Infinity entries', () => {
      const result = migrate({ ...defaultMetaState(), materialBank: { a: NaN, b: Infinity, c: -Infinity, d: 5 } }).materialBank;
      expect(result).toEqual({ d: 5 });
    });

    it('drops non-number, non-string junk entries (null/object/boolean)', () => {
      const result = migrate({ ...defaultMetaState(), materialBank: { a: null, b: {}, c: true, d: 2 } }).materialBank;
      expect(result).toEqual({ d: 2 });
    });

    it('falls back to an empty bank when materialBank itself is not an object', () => {
      expect(migrate({ ...defaultMetaState(), materialBank: 'nope' }).materialBank).toEqual({});
      expect(migrate({ ...defaultMetaState(), materialBank: null }).materialBank).toEqual({});
      expect(migrate({ ...defaultMetaState(), materialBank: undefined }).materialBank).toEqual({});
    });
  });
});
