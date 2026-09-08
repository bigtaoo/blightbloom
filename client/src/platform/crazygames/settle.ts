// Split of `sdk.ts` (2026-09-08) — the two wrappers every call into the portal's SDK goes
// through. Free functions with no state, which is why they came out first when that file
// reached its 500-line limit: they were already independent of the class that held them,
// and `sdkUser.ts` needs both.
//
// They are the whole reason `sdk.ts` can claim that nothing in the game can be broken by the
// SDK: every remote call in this directory is wrapped in one of them, so a method that is
// missing, a promise that rejects and a callback that throws all arrive as "nothing
// happened" instead of as an exception in the middle of a frame.

/**
 * Run `fn`, awaiting it if it returned a promise, and swallow every failure. Returns
 * `undefined` on any failure path, which is indistinguishable from a method that
 * legitimately returns nothing — and that is the point: no caller branches on it.
 */
export async function settle(fn: () => unknown): Promise<unknown> {
  try {
    return await fn();
  } catch {
    return undefined;
  }
}

/**
 * Synchronous version, for forwarding an SDK callback into game code. A throw inside a hook
 * must not propagate back into the SDK's own callback dispatch, which would leave the
 * remaining hooks unrun (this is the failure that makes an ad end with the game still
 * muted).
 */
export function guard(fn: (() => void) | undefined): void {
  try {
    fn?.();
  } catch {
    /* a hook's failure is the hook's problem, never the ad's */
  }
}
