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
 *
 * ## The one-time device merge (design/16 hole 1, closed 2026-09-17)
 *
 * `POST /account/guest-merge` is the third route here, and it stores no progress at all: it
 * CLAIMS a guest install id against this account, atomically, and answers whether the claim
 * was this caller's to make. The client does the merging (it owns `MetaState`'s shape and
 * always has); what it cannot do on its own is decide, exactly once across every tab and
 * device, whether this browser has already been through the question. `accounts
 * .mergedGuestIds` is that decision, and `GET /account/meta` reports it back as the single
 * boolean `guestMerged` so the confirmation screen is offered once and never again.
 *
 * The guest id reaches `GET` as the `x-guest-id` REQUEST HEADER rather than a query
 * parameter, because a query string is logged by every proxy in front of this and an install
 * id is the analytics cohort key (design/21 A2). `routes/http.ts`'s `CORS` block lists the
 * header for the same reason it lists `authorization` — a browser refuses the request at
 * preflight otherwise, with no server log at all.
 *
 * ## Claiming a run drop (2026-09-26)
 *
 * `POST /account/claim-drop` is how a boss's rare character drop (engine `DROP_CHARACTERS`,
 * design/14) reaches a signed-in account. It has to be a server write because `ownedCharacters`
 * is an ownership field: a client-side grant would be stripped on the next `POST` and
 * overwritten on the next `GET`, so the drop would last exactly until the next login.
 *
 * What it trusts is stated plainly: **the client's word that the drop happened.** The server
 * cannot re-run a PvE run (replay verification is deliberately not built), which is the same
 * trust every material and schematic in `meta_state` already rests on. The route bounds what
 * that word can buy — only a `DROP_CHARACTERS` id, never a paid character, and one row per
 * account however often it is called (`grant` is an idempotent upsert) — and records it under
 * source `drop`, which `grantAudit`'s counted sources already include, so an account that
 * claims without ever finishing a run is visible to the anomaly audit rather than invisible.
 */
import type { IncomingMessage } from 'node:http';
import type { AccountsStore } from '../db';
import type { AuthService } from '../AuthService';
import { readJsonBody, send, type RouteHandler } from './http';
import { requireAuth } from './auth';
import { DROP_CHARACTERS } from '@dd/engine';
import { EntitlementService, applyOwnership, characterSku, stripOwnership } from '../EntitlementService';

/** The `GET /account/meta` header carrying this browser's guest install id. */
export const GUEST_ID_HEADER = 'x-guest-id';

/** Longer than a UUID and than `identity.ts`'s `p-{base36}-{8}` fallback, short enough that
 *  a junk value can never become a large array element. */
const MAX_GUEST_ID = 128;

function readGuestId(req: IncomingMessage): string | null {
  const raw = req.headers[GUEST_ID_HEADER];
  // node lowercases header names but a repeated header arrives as an array — take neither
  // side rather than guessing which browser sent which.
  const value = typeof raw === 'string' ? raw : null;
  if (!value || value.length > MAX_GUEST_ID) return null;
  return value;
}

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
  const guestId = readGuestId(req);
  // `true` when the caller sent no id: it means "offer nothing", which is the answer that
  // cannot lose data. A client that did not ask has no merge in flight, and the only way to
  // MOVE this to false is to name an id the account has never been offered.
  const account = guestId
    ? await deps.store.accounts.findOne({ _id: session.accountId }, { projection: { mergedGuestIds: 1 } })
    : null;
  const guestMerged = guestId === null || (account?.mergedGuestIds ?? []).includes(guestId);
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
    guestMerged,
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

/**
 * Claim this browser's guest install id against the logged-in account — the idempotency key
 * of the one-time device merge (see the header). Writes no progress: the client's own
 * `POST /account/meta` does that, after this has told it the claim was its to make.
 *
 * The claim is one conditional update, never a read followed by a write. Two tabs finishing
 * the confirmation screen at the same moment is the case that matters, and a
 * find-then-insert would let both of them merge — which double-counts the material bank,
 * because the second merge adds a local bank that the first has already folded into the
 * account. `modifiedCount` is the only thing here that distinguishes the winner from the
 * loser, and it is the database's answer rather than ours. This is the same shape design/19
 * §4's AMENDMENT 2 requires of billing and `AuthService.register` uses for a taken username.
 *
 * `{ claimed: false }` is a completely ordinary answer, not an error: it means this device
 * has already been through the question, on this tab's own earlier visit or on another's.
 * The caller's correct response to it is to take the account's state unchanged.
 */
export const postGuestMerge: RouteHandler<AccountRouteDeps> = async (req, res, _url, deps) => {
  const session = await requireAuth(req, deps.auth);
  if (!session) return send(res, 401, { error: 'invalid or expired session' });
  const body = await readJsonBody(req);
  const guestId = (body as { guestId?: unknown })?.guestId;
  if (typeof guestId !== 'string' || !guestId || guestId.length > MAX_GUEST_ID) {
    return send(res, 400, { error: 'guestId required' });
  }
  const result = await deps.store.accounts.updateOne(
    { _id: session.accountId, mergedGuestIds: { $ne: guestId } },
    { $addToSet: { mergedGuestIds: guestId } },
  );
  send(res, 200, { claimed: result.modifiedCount === 1 });
};

/**
 * Claim a run drop (see the header's last section). Answers `{ granted }` — `false` when the
 * account already owned it, which is an ordinary answer, not an error.
 */
export const postClaimDrop: RouteHandler<AccountRouteDeps> = async (req, res, _url, deps) => {
  const session = await requireAuth(req, deps.auth);
  if (!session) return send(res, 401, { error: 'invalid or expired session' });
  const body = await readJsonBody(req);
  const skinId = (body as { skinId?: unknown })?.skinId;
  if (typeof skinId !== 'string' || !DROP_CHARACTERS.includes(skinId)) {
    return send(res, 400, { error: 'not a droppable character' });
  }
  const granted = await entitlementsOf(deps).grant(session.accountId, characterSku(skinId), 'drop');
  send(res, 200, { granted });
};
