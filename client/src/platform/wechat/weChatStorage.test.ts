/**
 * `wx.getStorageSync`/`setStorageSync` as the `IdentityStore` — the adapter analytics on this
 * host was switched off for (design/21 §9).
 *
 * `wx` is a hand-rolled fake, the convention every other file in this directory uses
 * (`vi.stubGlobal`). The fake reproduces the one behaviour of the real API that a caller has
 * to encode — a key that was never written reads back as `''`, not `null` — because a store
 * that answered "the empty string" for a missing id would persist that empty string as the
 * id and every row keyed by it would collapse into one.
 *
 * The last case here is the one that matters, and it carries its control: the SAME
 * environment, read through the web store, mints a fresh id per boot. That is the bug this
 * file closes, and asserting it reproduces is what stops the persistence claim from passing
 * for the wrong reason.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createWeChatIdentityStore, readWeChatStorage, writeWeChatStorage } from './weChatStorage';
import {
  IDENTITY_STORAGE_KEY,
  createWebIdentityStore,
  getInstallId,
  resetIdentityCacheForTests,
  setIdentityStore,
} from '../../net/identity';

/** A wx storage fake: a Map, plus the empty-string-for-missing behaviour of the real one. */
function storageFake(initial: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>(Object.entries(initial));
  return {
    store,
    wx: {
      getStorageSync: (key: string): unknown => (store.has(key) ? store.get(key) : ''),
      setStorageSync: (key: string, data: unknown): void => {
        store.set(key, data);
      },
    },
  };
}

beforeEach(() => {
  resetIdentityCacheForTests();
});

afterEach(() => {
  resetIdentityCacheForTests();
  vi.unstubAllGlobals();
});

describe('readWeChatStorage / writeWeChatStorage', () => {
  it('round-trips a string through the real key', () => {
    const fake = storageFake();
    vi.stubGlobal('wx', fake.wx);
    writeWeChatStorage('k', 'v');
    expect(fake.store.get('k')).toBe('v');
    expect(readWeChatStorage('k')).toBe('v');
  });

  it('reads a key that was never written as null, not as the empty string', () => {
    vi.stubGlobal('wx', storageFake().wx);
    // The harness check on the assertion above it: the fake really does answer `''` here, so
    // this is the mapping being tested and not a fake that happens to return null.
    expect(wx.getStorageSync('missing')).toBe('');
    expect(readWeChatStorage('missing')).toBeNull();
  });

  it('rejects a stored value that is not a string', () => {
    // The store holds whatever some earlier build wrote. A number where an id was expected is
    // a corrupt save, and answering with it would put a non-string into every analytics row.
    vi.stubGlobal('wx', storageFake({ k: 7, empty: '' }).wx);
    expect(readWeChatStorage('k')).toBeNull();
    expect(readWeChatStorage('empty')).toBeNull();
  });

  it('survives a store that throws on either side', () => {
    vi.stubGlobal('wx', {
      getStorageSync: () => {
        throw new Error('corrupt');
      },
      setStorageSync: () => {
        throw new Error('full');
      },
    });
    expect(readWeChatStorage('k')).toBeNull();
    expect(() => writeWeChatStorage('k', 'v')).not.toThrow();
  });

  it('degrades to "nothing persists" on a shell without the API', () => {
    // Three shapes: no `wx` at all (a unit test, and the web build), and a `wx` missing
    // either half. All of them are the state this host was already in, which is why none of
    // them may throw out of boot.
    vi.stubGlobal('wx', undefined);
    expect(readWeChatStorage('k')).toBeNull();
    expect(() => writeWeChatStorage('k', 'v')).not.toThrow();
    vi.stubGlobal('wx', { setStorageSync: () => {} });
    expect(readWeChatStorage('k')).toBeNull();
    vi.stubGlobal('wx', { getStorageSync: () => 'x' });
    expect(readWeChatStorage('k')).toBeNull();
    expect(() => writeWeChatStorage('k', 'v')).not.toThrow();
  });
});

describe('createWeChatIdentityStore', () => {
  it('uses the same stored key as the web build', () => {
    const fake = storageFake();
    vi.stubGlobal('wx', fake.wx);
    createWeChatIdentityStore().save('id-1');
    // Not "some key": the ladder key and the analytics install id are one value with one
    // name across hosts, so a player's id is not a per-platform thing to keep in step.
    expect([...fake.store.keys()]).toEqual([IDENTITY_STORAGE_KEY]);
    expect(fake.store.get(IDENTITY_STORAGE_KEY)).toBe('id-1');
    expect(createWeChatIdentityStore().load()).toBe('id-1');
  });

  it('keeps one install id across reloads — and the web store in the same shell does not', () => {
    const fake = storageFake();
    vi.stubGlobal('wx', fake.wx);

    setIdentityStore(createWeChatIdentityStore());
    const first = getInstallId();
    // A "reload": the process caches go, the store's backing does not. This is the whole
    // claim — analytics keyed on this id now describes an INSTALL rather than a visit.
    resetIdentityCacheForTests();
    setIdentityStore(createWeChatIdentityStore());
    expect(getInstallId()).toBe(first);
    expect(fake.store.get(IDENTITY_STORAGE_KEY)).toBe(first);

    // The control, in the same environment: this vitest run has no `localStorage`, exactly
    // like the mini-game shell, so the web store persists nothing and every boot is a new
    // install. It is the number that would have read as DAU, and it must still reproduce.
    expect(typeof localStorage).toBe('undefined');
    resetIdentityCacheForTests();
    const webA = getInstallId(createWebIdentityStore());
    resetIdentityCacheForTests();
    const webB = getInstallId(createWebIdentityStore());
    expect(webA).not.toBe(webB);
  });
});
