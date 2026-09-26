/**
 * Split of the delivery seam (2026-09-05): the DURABLE half of the closed entitlement loop
 * — the `deliveries` collection's reader and writer. `deliveryPump.ts` is the async half
 * that drains it; `delivery.ts` still owns the interface and the ledger-only opt-out.
 *
 * `EntitlementDelivery.grant` is called from inside `BillingService`'s settlement
 * transaction, so the grant this file provides does one upsert into a collection in the
 * SAME logical database, carrying the caller's session — same transaction, same commit —
 * and the HTTP call that actually reaches `entitlements` happens strictly afterwards, from
 * outside.
 *
 * WHAT THE DOCUMENT MEANS. Not "an entitlement was granted"; "an entitlement is OWED, and
 * this obligation survives a crash". After the commit that promise is durable, so the two
 * failures an outbox exists to rule out are ruled out: the process dying between the
 * payment and the grant (the document is still `pending` on restart) and the grant failing
 * after the money was taken (the document is still `pending`, and the pump keeps trying).
 *
 * WHY THIS AND NOT A TWO-PHASE COMMIT. Because the receiving side is already idempotent:
 * `entitlements` carries UNIQUE(accountId, sku) (design/19 §2, `db.ts`), so re-delivering
 * is a no-op rather than a double grant. At-least-once is therefore safe, and once
 * at-least-once is safe a coordinator buys nothing and costs a distributed protocol.
 */
import type { ClientSession, Db } from 'mongodb';
import { billingStore, type DeliveryDoc } from '../billing/collections';
import type { EntitlementDelivery } from './delivery';

/** `pending` → `delivered` on a 2xx, or `pending` → `failed` on a deliberate refusal. */
export type DeliveryState = 'pending' | 'delivered' | 'failed';

/** One `deliveries` document, with the absent fields mapped back to the `null` every caller
 *  has read since this module shipped. */
export interface DeliveryRecord {
  /** The ledger document's id — see the comment in `billing/collections.ts`. */
  id: string;
  accountId: string;
  /** The billsvc SKU (`bp.cannon`), not the namespaced entitlement sku. */
  sku: string;
  /** Raw, unparsed. Parsing is the PUMP's job so a corrupt document fails one delivery
   *  loudly rather than throwing out of a plain collection read (see `deliveryPump.ts`). */
  grantsJson: string;
  orderId: string;
  receiptId: string;
  state: DeliveryState;
  attempts: number;
  createdAt: number;
  deliveredAt: number | null;
  /** `grant` for every purchase; `revoke` for a refund's revocation (ROADMAP 9.3). An absent
   *  field reads as `grant` — every row written before 9.3 is one. */
  action: 'grant' | 'revoke';
}

function toRecord(d: DeliveryDoc): DeliveryRecord {
  return {
    id: d._id,
    accountId: d.accountId,
    sku: d.sku,
    grantsJson: d.grantsJson,
    orderId: d.orderId,
    receiptId: d.receiptId,
    state: d.state as DeliveryState,
    attempts: d.attempts,
    createdAt: d.createdAt,
    deliveredAt: d.deliveredAt ?? null,
    action: d.action === 'revoke' ? 'revoke' : 'grant',
  };
}

/**
 * The shipped `EntitlementDelivery`: one upsert, inside the caller's transaction, on the
 * caller's own session.
 *
 * `$setOnInsert` rather than a bare insert, and the difference is the same one
 * `ON CONFLICT DO NOTHING` used to make. Through `settle` a conflict is unreachable — the
 * ledger claim on this exact id was won two statements earlier, so a duplicate would have
 * been refused there first — but this seam is a public interface and an implementation that
 * threw on a redelivery would turn a harmless at-least-once retry into a rolled-back
 * settlement. Silently keeping the FIRST document is also the correct answer on its own
 * terms: it is the one the money was taken against, and a second would deliver the same SKU
 * twice for one payment.
 *
 * It is also what makes this safe under a transaction the driver may RETRY: re-running the
 * whole callback re-issues this upsert, and re-issuing it changes nothing.
 *
 * A throw from here still rolls the whole settlement back, which is the contract
 * `delivery.ts` documents; nothing is caught.
 */
export function createOutboxDelivery(db: Db): EntitlementDelivery {
  const deliveries = billingStore(db).deliveries;
  return {
    async grant(request) {
      await deliveries.updateOne(
        { _id: request.ledgerId },
        {
          $setOnInsert: {
            accountId: request.accountId,
            sku: request.sku,
            grantsJson: JSON.stringify(request.grants),
            orderId: request.orderId,
            receiptId: request.receiptId,
            state: 'pending',
            attempts: 0,
            createdAt: request.ts,
          },
        },
        { upsert: true, session: request.session },
      );
    },
  };
}

/**
 * The pump's only read: oldest owed delivery first. Ordered by `createdAt` then `_id` so a
 * batch is deterministic even when two settlements share a millisecond — the pump reports
 * per-document outcomes and a test that could not name which one it just saw would be
 * pinning the clock rather than the behaviour.
 *
 * Deliberately NOT filtered by `attempts`. A document that keeps failing retryably is
 * retried forever: the money moved, so abandoning it loses a purchase, and a peer that comes
 * back heals every stuck row on the next sweep. `attempts` is the operator's signal, not a
 * budget.
 */
export async function pendingDeliveries(db: Db, limit: number): Promise<DeliveryRecord[]> {
  const docs = await billingStore(db)
    .deliveries.find({ state: 'pending' })
    .sort({ createdAt: 1, _id: 1 })
    .limit(limit)
    .toArray();
  return docs.map(toRecord);
}

/** One delivery by id — the audit read, and how a test asks what the pump did. */
export async function deliveryById(db: Db, id: string): Promise<DeliveryRecord | null> {
  const doc = await billingStore(db).deliveries.findOne({ _id: id });
  return doc ? toRecord(doc) : null;
}

/**
 * Count one attempt, BEFORE it is made rather than after it fails. A crash mid-attempt then
 * still leaves a trace, which is the case where the count is worth the most: a document
 * whose `attempts` climbs while nothing is ever logged is a peer that accepts the connection
 * and never answers.
 */
export async function countAttempt(db: Db, id: string): Promise<void> {
  await billingStore(db).deliveries.updateOne({ _id: id }, { $inc: { attempts: 1 } });
}

/**
 * Terminal success. Guarded on `state: 'pending'` so a delivery that raced (two pumps, or a
 * pump overlapping an operator's manual fix) cannot rewrite a settled document's timestamp —
 * the same claim-shape the rest of this plane uses instead of a look-before-write.
 */
export async function markDelivered(db: Db, id: string, ts: number): Promise<void> {
  await billingStore(db).deliveries.updateOne(
    { _id: id, state: 'pending' },
    { $set: { state: 'delivered', deliveredAt: ts } },
  );
}

/**
 * Terminal refusal — the control plane said no on purpose (a 4xx), so repeating the call
 * verbatim cannot change the answer. `deliveredAt` stays absent: nothing was delivered, and
 * a field that means "when this landed" must not be used to mean "when we gave up".
 *
 * This state is the loud one. A `failed` document is money taken with nothing granted, and
 * the only way out of it is a human — which is exactly what design/19 §7's reconciliation
 * sweep is for, and why the pump logs an error rather than a warning when it writes one.
 *
 * Takes the pump's session: making a delivery terminal and filing it for review is one
 * transaction (`deliveryPump.ts`'s `retire`).
 */
export async function markFailed(db: Db, id: string, session?: ClientSession): Promise<void> {
  await billingStore(db).deliveries.updateOne({ _id: id, state: 'pending' }, { $set: { state: 'failed' } }, { session });
}
