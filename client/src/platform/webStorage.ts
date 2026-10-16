/**
 * The one way to reach `localStorage`: the object, or `null` when this document may not use
 * it.
 *
 * Every web store here used to open with `const available = typeof localStorage !== 'undefined'`
 * and then fail soft inside a `try`. The `typeof` was the unguarded line. `localStorage` is a
 * getter on `window`, and when the browser denies storage to the document — an embedded frame
 * with third-party storage blocked, which is exactly how the CrazyGames build runs for some
 * viewers, or a sandboxed frame — the GETTER throws `SecurityError`, and `typeof` does not
 * catch a throwing getter (it only guards an undeclared name). Measured 2026-10-04 in a
 * sandboxed frame: "Failed to read the 'localStorage' property from 'Window'". So the stores
 * that were written to fail soft threw at construction instead, at boot, before the game drew
 * anything.
 *
 * Read per call rather than cached: it is cheap, and a cached `null` would outlive a test that
 * installs a fake.
 *
 * An OVERRIDE, when one is installed, wins: the portal entry routes every store through the
 * CrazyGames `SDK.data` module (`platform/crazygames/portalStorage.ts`), which follows the
 * player across devices once they sign in to the portal. Installed before the first store is
 * constructed, so no store ever holds the real `localStorage` beside it.
 */
export type KeyValueStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

let override: KeyValueStorage | null = null;

/** Route every store through `s` instead of `localStorage`; `null` restores the default. */
export function setStorageOverride(s: KeyValueStorage | null): void {
  override = s;
}

export function webStorage(): KeyValueStorage | null {
  if (override) return override;
  return browserStorage();
}

/** The real `localStorage`, ignoring any override — what a migration INTO the override reads. */
export function browserStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}
