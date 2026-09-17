/**
 * Session (design/16-accounts.md). Tested against an in-memory fake SessionStore —
 * mirrors identity.test.ts's style.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createWebSessionStore,
  getSession,
  setSession,
  resetSessionCacheForTests,
  type Session,
  type SessionStore,
} from './session';

function fakeStore(initial: Session | null = null): SessionStore {
  let value = initial;
  return {
    load: () => value,
    save: (s) => {
      value = s;
    },
  };
}

const ALICE: Session = { accountId: 'acct-1', username: 'alice', token: 'tok-1' };

beforeEach(() => resetSessionCacheForTests());

describe('getSession/setSession', () => {
  it('returns null when nothing is stored', () => {
    expect(getSession(fakeStore())).toBeNull();
  });

  it('reads a persisted session on first call', () => {
    expect(getSession(fakeStore(ALICE))).toEqual(ALICE);
  });

  it('caches in-process — a second call does not re-read the store', () => {
    getSession(fakeStore(ALICE));
    expect(getSession(fakeStore(null))).toEqual(ALICE); // ignored — cache wins
  });

  it('setSession updates the cache and persists to the store', () => {
    const store = fakeStore();
    setSession(ALICE, store);
    expect(getSession(store)).toEqual(ALICE);
    expect(store.load()).toEqual(ALICE);
  });

  it('setSession(null) logs out — clears cache and store', () => {
    const store = fakeStore(ALICE);
    setSession(null, store);
    expect(getSession(store)).toBeNull();
    expect(store.load()).toBeNull();
  });
});

/**
 * The store that actually SHIPS (2026-09-17). Everything above injects a fake, and this
 * runner has no `localStorage` at all, so until this block existed `createWebSessionStore`'s
 * two bodies had never run once: 69% of the file's lines, including every arm that decides
 * what happens to a player's login when the browser misbehaves. `identity.ts`'s twin had its
 * own web-store cases from the start; this was the one of the pair that was missed.
 *
 * `localStorage` is installed on `globalThis` per case and removed afterwards, because the
 * module reads `typeof localStorage` when the store is CONSTRUCTED — a store built before
 * the global exists is permanently a no-op, which is itself one of the cases below.
 */
describe('createWebSessionStore — the real localStorage-backed store', () => {
  function installStorage(impl: Partial<Storage> = {}) {
    const map = new Map<string, string>();
    const storage = {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
      ...impl,
    } as Storage;
    (globalThis as { localStorage?: Storage }).localStorage = storage;
    return map;
  }

  afterEach(() => {
    delete (globalThis as { localStorage?: Storage }).localStorage;
  });

  it('round-trips a session through the real key', () => {
    const map = installStorage();
    const store = createWebSessionStore();
    store.save(ALICE);
    // The key is asserted because it is the whole of a returning player's claim on their
    // account — see `src/storageKeys.test.ts`, which pins this string tree-wide.
    expect(map.get('daydayup.session.v1')).toBe(JSON.stringify(ALICE));
    expect(store.load()).toEqual(ALICE);
  });

  it('reads a browser that has never logged in as a guest, not as an error', () => {
    // The other arm of the same ternary as the corrupt case below: nothing stored at all is
    // the state every new player is in, and it has to come back `null` rather than throw on
    // `JSON.parse(null)`.
    installStorage();
    expect(createWebSessionStore().load()).toBeNull();
  });

  it('honours a custom key, which is what a second profile or a test would use', () => {
    const map = installStorage();
    createWebSessionStore('other.key').save(ALICE);
    expect(map.get('other.key')).toBeTruthy();
    expect(map.has('daydayup.session.v1')).toBe(false);
  });

  it('reads a corrupt value as LOGGED OUT rather than throwing', () => {
    // The `catch` in `load`. A truncated write, a half-cleared profile, an extension writing
    // over the key — this is boot, so the alternative to `null` is a JSON parse error thrown
    // out of the first thing the game does with a session.
    const map = installStorage();
    map.set('daydayup.session.v1', '{"accountId":"acct-1",');
    expect(createWebSessionStore().load()).toBeNull();
  });

  it('survives a getItem that throws outright (private mode, blocked storage)', () => {
    installStorage({
      getItem: () => {
        throw new DOMException('denied', 'SecurityError');
      },
    });
    expect(createWebSessionStore().load()).toBeNull();
  });

  it('save swallows a quota/private-mode failure — an unpersisted session is not a crash', () => {
    const setItem = vi.fn(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    installStorage({ setItem });
    expect(() => createWebSessionStore().save(ALICE)).not.toThrow();
    expect(setItem).toHaveBeenCalled();
  });

  it('save(null) REMOVES the key rather than storing "null"', () => {
    // A stored `"null"` would parse back to `null` and read as logged out too, so the
    // difference is invisible from `load()` alone — and it is the difference between a
    // logout that leaves nothing behind and one that leaves a stale row in the player's
    // browser forever.
    const map = installStorage();
    const store = createWebSessionStore();
    store.save(ALICE);
    store.save(null);
    expect(map.has('daydayup.session.v1')).toBe(false);
  });

  it('is an inert no-op where there is no localStorage at all', () => {
    // The WeChat mini-game shape, and this runner's own. Constructed with no global present,
    // the store must neither throw nor pretend to persist.
    const store = createWebSessionStore();
    expect(store.load()).toBeNull();
    expect(() => store.save(ALICE)).not.toThrow();
    expect(store.load()).toBeNull();
  });

  it('is what getSession/setSession use when no store is passed', () => {
    // The default argument, which is the only reason any of the above ships: every
    // production caller reaches this store by NOT naming one.
    const map = installStorage();
    setSession(ALICE);
    expect(map.get('daydayup.session.v1')).toBe(JSON.stringify(ALICE));
    resetSessionCacheForTests();
    expect(getSession()).toEqual(ALICE);
  });
});
