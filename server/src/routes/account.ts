/**
 * Split of `matchsvc.ts` (P0, 2026-09-04, prep for ROADMAP Phase 8) — the `/account/*`
 * route group: account-bound meta state (design/16-accounts.md, ROADMAP 2.x's
 * blueprint/loadout persistence). The client's `MetaState`
 * (blueprints/materials/loadout), previously localStorage-only, mirrored here once a
 * player is logged in.
 *
 * Every route here requires a live session; the bearer-token reader lives with the rest of
 * the account trust boundary in `routes/auth.ts` and is imported from there.
 *
 * ROADMAP 8.2 landed here (design/19-server-platform.md §2): `/account/meta` is no longer
 * a blind whole-blob upsert. `meta_state` still stores a whole blob — materials, loadout,
 * in-progress forge state, everything the client legitimately authors — but the two
 * PURCHASABLE fields are owned by the `entitlements` table instead:
 *
 * - `POST` strips ownership out of the blob before storing it. Ignored, not rejected, so
 *   an older client / a guest promoting its local save / an offline replay all keep
 *   working exactly as before (design/19 §2 is explicit about this).
 * - `GET` writes the server's own answer back over those fields, and also returns the raw
 *   entitlement list so the client can tell WHY it owns something (a store UI needs
 *   `source`, and `client/src/net/entitlements.ts` needs it to merge a purchase into a
 *   brand-new account's local state before its first blob exists).
 *
 * A guest never reaches either route — no session, no row, byte-identical to today.
 */
import type { AccountsStore } from '../db';
import type { AuthService } from '../AuthService';
import { readJsonBody, send, type RouteHandler } from './http';
import { requireAuth } from './auth';
import { EntitlementService, applyOwnership, stripOwnership } from '../EntitlementService';

export interface AccountRouteDeps {
  auth: AuthService;
  store: AccountsStore;
}

/**
 * `EntitlementService` is built per request from `deps.store` rather than wired into
 * matchsvc's shared `deps` bundle. It holds nothing but the collections, and every other
 * handler in this directory already reaches into `deps.store` inline, so the shared bundle
 * would buy a coupling to the assembly shell and no measurable anything.
 */
function entitlementsOf(deps: AccountRouteDeps): EntitlementService {
  return new EntitlementService(deps.store);
}

export const getMeta: RouteHandler<AccountRouteDeps> = async (req, res, _url, deps) => {
  const session = await requireAuth(req, deps.auth);
  if (!session) return send(res, 401, { error: 'invalid or expired session' });
  const entitlements = entitlementsOf(deps);
  const rows = await entitlements.list(session.accountId);
  const row = await deps.store.metaState.findOne({ _id: session.accountId });
  // `data: null` still means "this account has never saved meta state" — unchanged, and
  // load-bearing: the client answers it by pushing its own (possibly guest-accumulated)
  // local state up rather than overwriting it with nothing. Entitlements ride alongside
  // rather than inside so that case can still deliver a purchase made before the first
  // save (see `pullAccountMeta`).
  const data = row
    ? applyOwnership(JSON.parse(row.data) as unknown, await entitlements.ownership(session.accountId))
    : null;
  send(res, 200, {
    data,
    // `orderId` is deliberately not exposed: it addresses a row in billsvc's private
    // database and the client has no use for it.
    entitlements: rows.map((r) => ({ sku: r.sku, source: r.source, grantedAt: r.grantedAt })),
  });
};

export const postMeta: RouteHandler<AccountRouteDeps> = async (req, res, _url, deps) => {
  const session = await requireAuth(req, deps.auth);
  if (!session) return send(res, 401, { error: 'invalid or expired session' });
  const body = await readJsonBody(req);
  const data = (body as { data?: unknown })?.data;
  if (data === undefined) return send(res, 400, { error: 'data required' });
  await deps.store.metaState.updateOne(
    { _id: session.accountId },
    { $set: { data: JSON.stringify(stripOwnership(data)) } },
    { upsert: true },
  );
  send(res, 200, { ok: true });
};
