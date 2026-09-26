/**
 * Sibling of `internalEntitlements.ts` (ROADMAP 9.3): the RECEIVING end of a refund's
 * entitlement revocation. billsvc's `deliveryPump.ts` drains an `action: 'revoke'` outbox row
 * here, over the same internal-key seam and with the same body shape as a grant.
 *
 * WHAT IT REMOVES, AND WHAT IT CANNOT. Each `(kind, id)` becomes an entitlement sku, and only
 * a row held BECAUSE OF THIS ORDER is deleted (`EntitlementService.revokePurchase`:
 * `source: 'purchase'` AND the same `orderId`). An entitlement the account also earned,
 * was hand-granted, or bought under a different order stays — a refund gives back the money
 * for one purchase, nothing more. Nothing else is touched: no match record, no rating, no
 * replay (the owner's decision, 2026-09-26 — ladder/PvP history is not rewritten).
 *
 * AT-LEAST-ONCE SAFE for the same reason the grant route is: deleting what is already gone
 * deletes nothing and still answers 200, reported as `notHeld`, so the pump can mark the row
 * delivered and stop. Status codes follow the grant route's contract exactly — a 4xx is a
 * refusal this route would repeat given the same bytes (the pump goes terminal and files a
 * `revocation-failed` case), a 5xx is transient (the pump retries).
 */
import { internalKeys } from '../config';
import { createInternalVerifier, describeInternalAuthFailure } from '../internalAuth';
import { EntitlementService } from '../EntitlementService';
import { entitlementSkuFor, type InternalEntitlementRouteDeps } from './internalEntitlements';
import { readJsonBody, send, type RouteHandler } from './http';

export const INTERNAL_REVOKE_PATH = '/internal/entitlements/revoke';

/**
 * `POST /internal/entitlements/revoke` — body `{ deliveryId, accountId, sku, orderId, grants, ts }`.
 * Answers `{ ok, revoked, notHeld }`.
 */
export const postRevoke: RouteHandler<InternalEntitlementRouteDeps> = async (req, res, _url, deps) => {
  const verifier = deps.internalAuth ?? createInternalVerifier(internalKeys().registry);
  const auth = verifier.verify(req.headers);
  if (!auth.ok) {
    console.warn(describeInternalAuthFailure(auth, `POST ${INTERNAL_REVOKE_PATH}`));
    return send(res, 401, { error: 'unauthorized' });
  }

  const b = ((await readJsonBody(req)) ?? {}) as { accountId?: unknown; orderId?: unknown; grants?: unknown; deliveryId?: unknown };
  const accountId = typeof b.accountId === 'string' ? b.accountId.trim() : '';
  const orderId = typeof b.orderId === 'string' ? b.orderId.trim() : '';
  if (!accountId || !orderId) return send(res, 400, { error: 'accountId and orderId are both required' });
  // Refused rather than a no-op, for the grant route's reason: an empty list means something
  // upstream lost what the purchase delivered, and a 200 would erase that evidence.
  if (!Array.isArray(b.grants) || b.grants.length === 0) {
    return send(res, 400, { error: 'grants must be a non-empty array' });
  }
  const skus: string[] = [];
  for (const grant of b.grants) {
    const sku = entitlementSkuFor(grant);
    if (sku === null) return send(res, 400, { error: 'each grant must be { kind: blueprint|character, id }' });
    skus.push(sku);
  }

  const entitlements = new EntitlementService(deps.store);
  let revoked: string[] = [];
  let notHeld: string[] = [];
  const session = deps.store.client.startSession();
  try {
    await session.withTransaction(async () => {
      // Reset per attempt — `withTransaction` may re-run this body.
      revoked = [];
      notHeld = [];
      for (const sku of skus) {
        if (await entitlements.revokePurchase(accountId, sku, orderId, session)) revoked.push(sku);
        else notHeld.push(sku);
      }
    });
  } catch (e) {
    console.error(`[blightbloom] entitlements: revocation for account '${accountId}' order '${orderId}' failed — ${(e as Error).message}`);
    return send(res, 500, { error: 'revoke failed' });
  } finally {
    await session.endSession();
  }

  const deliveryId = typeof b.deliveryId === 'string' ? b.deliveryId : '(none)';
  console.log(
    `[blightbloom] entitlements: revocation '${deliveryId}' for account '${accountId}' order '${orderId}' — ` +
      `revoked [${revoked.join(', ')}], not held under this order [${notHeld.join(', ')}]`,
  );
  send(res, 200, { ok: true, revoked, notHeld });
};
