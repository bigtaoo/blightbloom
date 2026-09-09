/**
 * Local player identity (design/05/15 PvP squad follow-up). Tested against an
 * in-memory fake IdentityStore — real localStorage isn't available in this test
 * environment (same reason settings/store.ts tests its web store separately).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { getInstallId, getPlayerId, resetIdentityCacheForTests, setIdentityStore, type IdentityStore } from './identity';
import { setSession, resetSessionCacheForTests } from './session';

function fakeStore(initial: string | null = null): IdentityStore {
  let value = initial;
  return {
    load: () => value,
    save: (id: string) => {
      value = id;
    },
  };
}

beforeEach(() => {
  resetIdentityCacheForTests();
  resetSessionCacheForTests();
});

describe('getPlayerId', () => {
  it('generates and persists a new id when the store is empty', () => {
    const store = fakeStore();
    const id = getPlayerId(store);
    expect(id).toBeTruthy();
    expect(store.load()).toBe(id); // saved back
  });

  it('reuses an existing persisted id instead of generating a new one', () => {
    const store = fakeStore('existing-id');
    expect(getPlayerId(store)).toBe('existing-id');
  });

  it('caches in-process — a second call does not re-read the store', () => {
    const store = fakeStore();
    const first = getPlayerId(store);
    const second = getPlayerId(fakeStore('different-id-if-read')); // ignored — cache wins
    expect(second).toBe(first);
  });

  it('generates distinct ids across resets with no persisted value', () => {
    const a = getPlayerId(fakeStore());
    resetIdentityCacheForTests();
    const b = getPlayerId(fakeStore());
    expect(a).not.toBe(b);
  });

  it('prefers the logged-in account id over the local guest id (design/16-accounts.md)', () => {
    const store = fakeStore('local-guest-id');
    expect(getPlayerId(store)).toBe('local-guest-id');
    setSession({ accountId: 'acct-1', username: 'alice', token: 'tok-1' });
    expect(getPlayerId(store)).toBe('acct-1');
  });
});

describe('getInstallId', () => {
  it('generates and persists when the store is empty', () => {
    const store = fakeStore();
    const id = getInstallId(store);
    expect(id).toBeTruthy();
    expect(store.load()).toBe(id);
  });

  it('reuses the id an existing player already has', () => {
    // The reason analytics adds no new stored identifier and retention is continuous from
    // the day it ships: this is the same `daydayup.playerId.v1` the ladder already wrote.
    expect(getInstallId(fakeStore('already-here'))).toBe('already-here');
  });

  it('NEVER prefers the account id, even once logged in (design/21 A2)', () => {
    // The one behavioural difference from getPlayerId, and the whole reason this function
    // exists. A player logging in mid-visit must not change identity mid-cohort — that
    // would read as one install that vanished plus one that appeared.
    const store = fakeStore('local-guest-id');
    setSession({ accountId: 'acct-1', username: 'alice', token: 'tok-1' });
    expect(getPlayerId(store)).toBe('acct-1');
    expect(getInstallId(store)).toBe('local-guest-id');
  });

  it('writes an id for a player who logged in before ever playing as a guest', () => {
    // getPlayerId returns early for such a player and never persists anything, so there is
    // no stored id to reuse — this must mint one rather than return the account id.
    const store = fakeStore(null);
    setSession({ accountId: 'acct-2', username: 'bob', token: 'tok-2' });
    const id = getInstallId(store);
    expect(id).not.toBe('acct-2');
    expect(store.load()).toBe(id);
  });

  it('caches in-process, on its own cache rather than getPlayerId\'s', () => {
    const store = fakeStore();
    const first = getInstallId(store);
    expect(getInstallId(fakeStore('different-id-if-read'))).toBe(first);
    resetIdentityCacheForTests();
    expect(getInstallId(fakeStore('after-reset'))).toBe('after-reset');
  });
});

describe('setIdentityStore — the seam an entry point installs a platform store through', () => {
  it('is what the argument-less readers read', () => {
    // The two production callers pass nothing: `installAnalytics` calls `getInstallId()` and
    // the ladder report calls `getPlayerId()`. This sink is how a host whose persistence is
    // not `localStorage` reaches them without a store threaded through everything between —
    // `main.wechat.ts` installs `createWeChatIdentityStore()`.
    setIdentityStore(fakeStore('installed-id'));
    expect(getInstallId()).toBe('installed-id');
    resetIdentityCacheForTests();
    setIdentityStore(fakeStore('installed-id'));
    expect(getPlayerId()).toBe('installed-id');
  });

  it('drops both caches on the way in, so a swap is not answered from the old store', () => {
    setIdentityStore(fakeStore('first'));
    expect(getInstallId()).toBe('first');
    expect(getPlayerId()).toBe('first');
    setIdentityStore(fakeStore('second'));
    // Without the cache drop an id already handed out would keep being answered from a store
    // that is no longer installed, which would make the swap silently a lie.
    expect(getInstallId()).toBe('second');
    expect(getPlayerId()).toBe('second');
  });

  it('falls back to the web store, and `null` puts it back', () => {
    // No `localStorage` in this runner (the mini-game shape), so the web store persists
    // nothing and each read mints its own id. That is the fallback being asserted: not a
    // throw, and not the previously installed store.
    setIdentityStore(fakeStore('installed'));
    expect(getInstallId()).toBe('installed');
    setIdentityStore(null);
    const a = getInstallId();
    expect(a).not.toBe('installed');
    resetIdentityCacheForTests();
    expect(getInstallId()).not.toBe(a);
  });

  it('is cleared by the test reset, so it cannot leak into the next file', () => {
    setIdentityStore(fakeStore('leaky'));
    resetIdentityCacheForTests();
    expect(getInstallId()).not.toBe('leaky');
  });
});
