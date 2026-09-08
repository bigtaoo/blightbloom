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
 *
 * Use `settleReporting` below where the reason has to be REPORTED (a diagnostics line), not
 * acted on. That is a different thing from branching on it, and the comment above still
 * holds for every caller of this function.
 */
export async function settle(fn: () => unknown): Promise<unknown> {
  return (await settleReporting(fn)).value;
}

/** What `settleReporting` saw. `failed` is true ONLY for a throw or a rejection — a call
 *  that legitimately returned nothing is `{value: undefined, failed: false}`. */
export interface SettleOutcome {
  value: unknown;
  failed: boolean;
  /** A short description of the failure, for a diagnostics string. Never shown to a player
   *  and never parsed — an SDK's message text is not a contract. */
  reason: string | null;
}

/**
 * `settle` with the reason kept, for the one caller that needs to TELL somebody why nothing
 * came back rather than act on it.
 *
 * The distinction `settle` deliberately erases is real and, in one place, expensive: a
 * `getUser()` that throws and a `getUser()` that returns null both mean "play as a guest",
 * but only one of them means the account integration is broken. `PortalSession`'s
 * `diagnostics()` is the only instrument this repository has for that half of the
 * integration, and until 2026-09-08 it reported both as `guest` — so a `getUser` that was
 * gated, revoked, or renamed by the platform was indistinguishable from a player who simply
 * is not signed in.
 *
 * This does NOT reopen what `settle` closes. Nothing branches on `failed` to decide what the
 * game does — every failure path still ends at "keep playing as a guest" (`portalAuth.ts`).
 * It only decides what the diagnostics line SAYS.
 */
export async function settleReporting(fn: () => unknown): Promise<SettleOutcome> {
  try {
    return { value: await fn(), failed: false, reason: null };
  } catch (e) {
    return { value: undefined, failed: true, reason: describe(e) };
  }
}

function describe(e: unknown): string {
  if (e instanceof Error && e.message) return e.message;
  const s = String(e);
  return s.length > 0 ? s : 'threw a non-Error';
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
