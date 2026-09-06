/**
 * The RECEIVING end of the entitlement-delivery loop (design/19 §4, closed 2026-09-05) —
 * the one route that writes `entitlements` with `source = 'purchase'`, and the only caller
 * `EntitlementService.grant` has ever had.
 *
 * It lives in the control plane because `entitlements` does (design/19 §2, `db.ts`), and
 * billsvc's own database is a different FILE — so this HTTP hop is not a topology choice,
 * it is the only way across. billsvc's `deliveryPump.ts` is what calls it, from outside its
 * settlement transaction, over ROADMAP 8.1's internal-key seam.
 *
 * THREE THINGS MAKE THIS SAFE TO CALL AT LEAST ONCE, which is the property the whole outbox
 * design leans on:
 *
 *  1. `entitlements` carries UNIQUE(account_id, sku), and `EntitlementService.grant` is
 *     `INSERT ... ON CONFLICT DO NOTHING`. A redelivery after a lost ack grants nothing a
 *     second time and answers 200, so the pump can mark its row delivered and stop.
 *  2. The FIRST grant's `source`/`order_id` are never overwritten (that class's own rule),
 *     so a redelivery cannot rewrite the audit record of the payment that caused it.
 *  3. Every write here is inside one transaction, so a multi-grant SKU is all-or-nothing
 *     rather than half-applied by a crash — even though (1) would heal that anyway.
 *
 * WHAT IT REFUSES, AND WHY THE STATUS CODE MATTERS. The pump reads any 4xx as terminal (the
 * row goes `failed` and an operator is told money moved with nothing granted) and any 5xx as
 * retryable. So a refusal here has to be one this route would make again given the same
 * bytes: a missing field, an empty grant list, an unknown account. Anything that might
 * succeed on a retry — a locked database, a disk error — answers 5xx instead, and must never
 * be flattened into a 400 that discards a purchase.
 *
 * `source = 'purchase'` and a non-empty `order_id` are not this route's opinion: `db.ts`
 * carries a CHECK for each, and this route is written to satisfy them rather than to work
 * around them — an unauditable paid entitlement is the thing they exist to make impossible.
 */
import type { DatabaseSync } from 'node:sqlite';
import { internalKeys } from '../config';
import { createInternalVerifier, describeInternalAuthFailure, type InternalVerifier } from '../internalAuth';
import { EntitlementService, blueprintSku, characterSku } from '../EntitlementService';
import { readJson, send, type RouteHandler } from './http';

export const INTERNAL_GRANT_PATH = '/internal/entitlements/grant';

export interface InternalEntitlementRouteDeps {
  db: DatabaseSync;
  /**
   * Internal-key verifier override. OPTIONAL, and the default is not "no auth" — it is the
   * same env-derived registry `routes/rating.ts` falls back to, so the route is guarded even
   * though `matchsvc.ts` wires one untyped `deps` bundle for every group. The seam exists so
   * a test can pin a registry without touching `process.env`.
   */
  internalAuth?: InternalVerifier;
}

/** One `(kind, id)` pair off the wire, narrowed. `null` for anything this route will not
 *  turn into an entitlement sku — an unknown kind included, because silently skipping one
 *  would deliver a partial purchase and report success. */
function entitlementSkuFor(grant: unknown): string | null {
  if (typeof grant !== 'object' || grant === null) return null;
  const { kind, id } = grant as { kind?: unknown; id?: unknown };
  if (typeof id !== 'string' || id.length === 0) return null;
  if (kind === 'blueprint') return blueprintSku(id);
  if (kind === 'character') return characterSku(id);
  return null;
}

/**
 * `POST /internal/entitlements/grant` — billsvc says a purchase settled; this writes it.
 *
 * Body: `{ deliveryId, accountId, sku, orderId, grants: [{kind, id}], ts }`
 * (`billsvc/deliveryPump.ts`'s `GrantDeliveryBody`).
 *
 * Answers `{ ok, granted, alreadyOwned }` — two arrays of entitlement skus rather than one
 * count, because "the account already had it" is the NORMAL answer to a redelivery and an
 * operator reading a log needs to tell it apart from a first delivery. Both are a 200: the
 * pump must mark the row delivered either way.
 */
export const postGrant: RouteHandler<InternalEntitlementRouteDeps> = (req, res, _url, deps) => {
  const verifier = deps.internalAuth ?? createInternalVerifier(internalKeys().registry);
  const auth = verifier.verify(req.headers);
  if (!auth.ok) {
    // Logged, not returned: the caller learns only "unauthorized" while the reason and its
    // own untrusted `x-internal-caller` claim reach the operator (design/19 §7).
    console.warn(describeInternalAuthFailure(auth, `POST ${INTERNAL_GRANT_PATH}`));
    return send(res, 401, { error: 'unauthorized' });
  }

  readJson(req, (body) => {
    const b = (body ?? {}) as { accountId?: unknown; orderId?: unknown; grants?: unknown; deliveryId?: unknown };
    const accountId = typeof b.accountId === 'string' ? b.accountId.trim() : '';
    const orderId = typeof b.orderId === 'string' ? b.orderId.trim() : '';
    if (!accountId || !orderId) {
      return send(res, 400, { error: 'accountId and orderId are both required' });
    }
    // An EMPTY grant list is refused rather than accepted as a no-op. billsvc only writes a
    // delivery row for a SKU it resolved in its own catalogue, so an empty list means
    // something upstream lost the grants — and answering 200 would let the pump mark that
    // row delivered and erase the only remaining evidence that a player paid for nothing.
    if (!Array.isArray(b.grants) || b.grants.length === 0) {
      return send(res, 400, { error: 'grants must be a non-empty array' });
    }
    const skus: string[] = [];
    for (const grant of b.grants) {
      const sku = entitlementSkuFor(grant);
      if (sku === null) return send(res, 400, { error: 'each grant must be { kind: blueprint|character, id }' });
      skus.push(sku);
    }

    // Checked rather than caught. `entitlements.account_id` is a real foreign key, so a
    // grant for an account that does not exist throws out of `node:sqlite` — and telling
    // "no such account" (permanent: the pump should stop and shout) apart from "the write
    // failed" (transient: it must retry) by parsing a driver's error string is the thing
    // `BillingService` already refuses to do on its own claims.
    const known = deps.db.prepare('SELECT 1 AS one FROM accounts WHERE id = ?').get(accountId);
    if (known === undefined) return send(res, 404, { error: `no account '${accountId}'` });

    const entitlements = new EntitlementService(deps.db);
    const granted: string[] = [];
    const alreadyOwned: string[] = [];
    deps.db.exec('BEGIN IMMEDIATE');
    try {
      for (const sku of skus) {
        if (entitlements.grant(accountId, sku, 'purchase', { orderId })) granted.push(sku);
        else alreadyOwned.push(sku);
      }
      deps.db.exec('COMMIT');
    } catch (e) {
      deps.db.exec('ROLLBACK');
      // A 500, deliberately, and NOT a rethrow. A throw from inside `readJson`'s `end`
      // handler is an uncaughtException with no response ever sent, so the pump would hang
      // to its own timeout and then retry anyway — and the 5xx is what tells it to retry
      // rather than to write the purchase off. Whatever failed here (a locked database, a
      // disk error) may well succeed on the next sweep.
      console.error(`[blightbloom] entitlements: grant for account '${accountId}' order '${orderId}' failed — ${(e as Error).message}`);
      return send(res, 500, { error: 'grant failed' });
    }

    const deliveryId = typeof b.deliveryId === 'string' ? b.deliveryId : '(none)';
    console.log(
      `[blightbloom] entitlements: delivery '${deliveryId}' for account '${accountId}' order '${orderId}' — ` +
        `granted [${granted.join(', ')}], already owned [${alreadyOwned.join(', ')}]`,
    );
    send(res, 200, { ok: true, granted, alreadyOwned });
  });
};
