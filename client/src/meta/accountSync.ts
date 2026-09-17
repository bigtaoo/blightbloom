/**
 * Account-bound sync for MetaState (design/16-accounts.md — Forge blueprints/
 * materials/loadout, previously localStorage-only, see store.ts's own note). Wraps the
 * existing web MetaStore: localStorage stays the synchronous source of truth for every
 * existing `load()`/`save()` call site (Game.ts's ~10 `this.store.save(this.meta)`
 * calls are untouched); a logged-in `save()` ALSO best-effort pushes to
 * `/account/meta` — same fire-and-forget `.catch()` shape as the server's
 * `reportSettledMatch` — so a guest's play is never worse off, only additive once
 * logged in.
 *
 * `getBaseUrl` is a thunk rather than a plain string so this can be constructed as a
 * field initializer BEFORE Game.ts's `?matchBaseUrl=` query-param override applies
 * (mirrors PartyScreen/LoginScreen's own "constructed after the override" comment, but
 * without needing to delay construction — the thunk just reads the current value
 * lazily at save time, once the override has long since landed).
 *
 * The one-time pull-from-server-on-login step is a separate async function
 * (`pullAccountMeta`) since `MetaStore.load()` itself must stay synchronous.
 */
import { createWebMetaStore, migrate, type MetaStore } from './store';
import type { MetaState } from './MetaState';
import { getSession } from '../net/session';
import { saveAccountMeta } from '../net/auth';
import { ACCOUNT_UNAUTHORIZED, entitlementOwnership, fetchAccountState, type Entitlement } from '../net/entitlements';

export function createAccountSyncMetaStore(getBaseUrl: () => string): MetaStore {
  const local = createWebMetaStore();
  return {
    load(): MetaState {
      return local.load();
    },
    save(m: MetaState): void {
      local.save(m);
      const session = getSession();
      if (!session) return;
      saveAccountMeta(getBaseUrl(), session.token, m).catch(() => {
        /* best-effort — a dropped sync never blocks or retries local play */
      });
    },
  };
}

/**
 * Pulls this account's server-side MetaState (if any) right after a login/register.
 * `null` means "no server state yet" (brand-new account) — the caller should push the
 * current local state up instead of overwriting it with nothing.
 *
 * **Since ROADMAP 8.2 the returned blob's ownership fields are the SERVER's answer**, read
 * from its `entitlements` table, not whatever this device last pushed up
 * (design/19-server-platform.md §2). Two consequences worth stating, because they are the
 * whole reason logging in does not visibly change the Forge:
 *
 * - The free baseline is not lost. `migrate()` unions `STARTER_BLUEPRINTS` and
 *   `FREE_CHARACTERS` back in on every load (store.ts), so an account with no entitlements
 *   at all — every account today — comes back owning exactly what it owned as a guest.
 * - What DOES disappear is ownership the client granted itself, which is precisely the
 *   hole 8.2 closes. `ForgeActions.acquireBlueprint`'s `demo: free grant` scaffold is the
 *   only such path in the game today; it needs to become a real purchase (or be hidden
 *   while a session is live) before it stops being a grant that survives until the next
 *   login and then quietly vanishes.
 *
 * `local` is optional and additive-only: it is used ONLY on the brand-new-account branch,
 * where the server has no blob to be authoritative over yet, so that a purchase made
 * before this account's first save still lands on the FIRST login rather than the second.
 * Omitting it is exactly the pre-8.2 behaviour.
 */
export async function pullAccountMeta(baseUrl: string, token: string, local?: MetaState): Promise<MetaState | null> {
  const snapshot = await pullAccountSnapshot(baseUrl, token, { local });
  // A 401 is an ordinary failure to THESE callers — `StorePurchase.refreshOwnership` and the
  // store's assembly, both of which already have a player-facing line for "could not read
  // your ownership back" and neither of which is the boot-time session check. Only
  // `syncMetaWithSession` acts on the distinction, and it calls `pullAccountSnapshot` direct.
  if (snapshot.status === 'unauthorized') throw new Error('account session rejected (401)');
  return snapshot.meta;
}

/**
 * What a login needs to know, in one request: the account's state, and whether this device
 * has already been through the one-time guest-merge question (design/16 holes 1 and 2,
 * 2026-09-17).
 *
 * `pullAccountMeta` above is this function with the 401 turned back into a throw, which is
 * the older and simpler contract every other caller still wants. The split exists because
 * exactly one caller must tell "the stored session is dead" from "the request failed" — and
 * conflating them is what let an expired session paint as `Hi, {name}` for thirty days.
 *
 * `guestId` is passed only by that caller. Omitting it makes the server answer
 * `guestMerged: true`, i.e. offer nothing, which is the answer that cannot lose data.
 */
export type AccountSnapshot =
  | { status: 'unauthorized' }
  | { status: 'ok'; meta: MetaState | null; guestMerged: boolean };

export async function pullAccountSnapshot(
  baseUrl: string,
  token: string,
  opts: { local?: MetaState; guestId?: string } = {},
): Promise<AccountSnapshot> {
  const state = await fetchAccountState(baseUrl, token, { guestId: opts.guestId });
  if (state === ACCOUNT_UNAUTHORIZED) return { status: 'unauthorized' };
  const { local } = opts;
  if (state.data !== null) return { status: 'ok', meta: migrate(state.data), guestMerged: state.guestMerged };
  const meta = !local || state.entitlements.length === 0 ? null : mergeEntitlements(local, state.entitlements);
  return { status: 'ok', meta, guestMerged: state.guestMerged };
}

/** `local` plus everything the server says this account owns. Additive, never subtractive
 * — see `pullAccountMeta`'s note on why this branch is the one place that is correct. */
function mergeEntitlements(local: MetaState, entitlements: readonly Entitlement[]): MetaState {
  const own = entitlementOwnership(entitlements);
  const union = (a: readonly string[], b: readonly string[]): string[] => [...new Set([...a, ...b])];
  return {
    ...local,
    unlockedBlueprints: union(local.unlockedBlueprints, own.unlockedBlueprints),
    ownedCharacters: union(local.ownedCharacters, own.ownedCharacters),
  };
}
