// wx.getStorageSync/setStorageSync as this shell's persistence primitive, and the
// `IdentityStore` implementation built on it (design/21 §9; design/04-wechat.md item 19).
//
// This is the adapter four separate features were waiting on. The mini-game shell has no
// `localStorage`, so `net/identity.ts`'s `createWebIdentityStore` answers `null` from
// `load()` and drops every `save()` here — which mints a FRESH install id per visit, and is
// the whole reason analytics was switched off on this host rather than shipped with numbers
// that look plausible and count visits as installs.
//
// Two other ports have the same shape and the same gap — `meta/store.ts` (whose header calls
// this "a later platform impl") and `settings/store.ts` — so the raw get/set below are
// exported for them rather than being private to the identity store. They are not wired yet:
// a meta save also needs a migration story for a guest whose progress has never persisted,
// which is its own change.
import { IDENTITY_STORAGE_KEY, type IdentityStore } from '../../net/identity';

/** Whether this runtime has the storage API at all. `wx` itself is absent in a unit test and
 *  in the web build; `getStorageSync` is core on every base library this project targets,
 *  but a shell without it degrades to "nothing persists" — the state the web store already
 *  falls back to — instead of throwing out of boot. */
function available(): boolean {
  return typeof wx !== 'undefined' && typeof wx.getStorageSync === 'function' && typeof wx.setStorageSync === 'function';
}

/**
 * One string out of the store, or `null`.
 *
 * `''` is mapped to `null` deliberately: that is what this API answers for a key that was
 * never written (see `wx.d.ts`), so a caller that trusted the raw value would read a missing
 * key as an empty-string id and persist it. Anything non-string is also `null` — the store
 * holds whatever a previous build wrote, and a number where an id was expected is a corrupt
 * save, not a value.
 */
export function readWeChatStorage(key: string): string | null {
  if (!available()) return null;
  try {
    const raw = wx.getStorageSync(key);
    return typeof raw === 'string' && raw !== '' ? raw : null;
  } catch {
    // A corrupt store must not brick boot — same rule as every other load path here.
    return null;
  }
}

/** One string into the store. Failure is swallowed, for the same reason the web store
 *  swallows a quota error: an unpersisted value for this session is acceptable, a crash on
 *  the line that saved it is not. */
export function writeWeChatStorage(key: string, value: string): void {
  if (!available()) return;
  try {
    wx.setStorageSync(key, value);
  } catch {
    /* full store / write refused — the id lives for this session only */
  }
}

/**
 * The WeChat half of `net/identity.ts`'s `IdentityStore` seam, installed by
 * `main.wechat.ts` through `setIdentityStore`.
 *
 * The key is left to the caller-facing default in `identity.ts` on purpose: it is the SAME
 * `daydayup.playerId.v1` the web build uses, so the two hosts' analytics rows and ladder
 * keys are the same shape, and a player's id here is one value in one place rather than a
 * per-platform name somebody has to remember to keep in step.
 */
export function createWeChatIdentityStore(key: string = IDENTITY_STORAGE_KEY): IdentityStore {
  return {
    load: () => readWeChatStorage(key),
    save: (id: string) => writeWeChatStorage(key, id),
  };
}
