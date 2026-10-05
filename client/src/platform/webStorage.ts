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
 */
export function webStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}
