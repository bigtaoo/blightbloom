/**
 * Split of `billingDb.ts` (2026-09-15, the MongoDB port): the INDEXES and VALIDATORS that
 * hold the billing plane's schema-level guarantees. `collections.ts` owns the shapes.
 *
 * Everything here answers one question — where did each guarantee the `node:sqlite` schema
 * enforced end up? Three answers, and only one of them is "unchanged".
 *
 * ## 1. `platform_txn_id TEXT UNIQUE` had to become a PARTIAL unique index
 *
 * The old column comment stated the property the settle path depends on: "SQLite treats
 * NULLs as distinct under UNIQUE, so any number of unsettled orders coexist; two SETTLED
 * orders sharing one platform transaction is what this constraint makes impossible."
 *
 * MongoDB does the opposite. Its unique index treats a MISSING field as a single `null`
 * value and admits exactly ONE document carrying it, rejecting every other with E11000. A
 * plain `unique: true` therefore compiles, passes every sequential happy-path test, and
 * breaks on the SECOND concurrently-open order — on the payment path, in production, for a
 * player with two abandoned checkouts. `partialFilterExpression` is what buys the SQLite
 * property back: the index covers only documents where `platformTxnId` is actually a
 * string, so unsettled orders are not in it at all while two settled orders still cannot
 * claim one payment. `test/mongo.semantics.test.ts` pins both halves against a real server.
 *
 * ## 2. The `CHECK` constraints survive as COLLECTION VALIDATORS
 *
 * `deliveries.state IN ('pending','delivered','failed')` and `review_queue.kind`/`state`
 * are enums the server enforces against every writer, a `mongosh` prompt included — not
 * rules this code follows. That distinction is the whole point: design/19 §8 declines to
 * build an admin service and plans for corrections made by hand, so a typo'd `'retry'`
 * state must fail at the prompt rather than make a paid delivery invisible to the pump
 * forever. The `NOT NULL` columns the §4 rules rest on (`receipts.product` above all, found
 * untested by a 2026-09-04 mutation battery) are the same thing said with `required`.
 *
 * ## 3. Nothing replaces what SQLite never had here
 *
 * The billing tables carried no foreign keys — `entitlements` lives in another store on
 * purpose — so nothing was lost on that front. What IS weaker: `ledger`'s append-only
 * property was always a convention rather than a constraint, and remains one. No validator
 * can express "this document may be inserted but never updated"; it is enforced by the fact
 * that no function in this plane issues an update against `ledger`, and by the tests that
 * assert the collection is byte-identical after every other mutating call.
 */
import type { Db } from 'mongodb';
import { billingStore } from './collections';

/**
 * `orders`. The NOT NULL half of the old table: an order with no state, amount or currency
 * cannot be priced, polled or reconciled, and a hand-written one that omits them is a row
 * every later read has to guess about.
 */
const ORDER_VALIDATOR: Record<string, unknown> = {
  $jsonSchema: {
    bsonType: 'object',
    required: ['accountId', 'sku', 'platform', 'amountCents', 'currency', 'state', 'createdAt'],
    properties: {
      accountId: { bsonType: 'string' },
      sku: { bsonType: 'string' },
      platform: { bsonType: 'string' },
      amountCents: { bsonType: 'number' },
      currency: { bsonType: 'string' },
      state: { bsonType: 'string' },
      platformTxnId: { bsonType: 'string' },
      createdAt: { bsonType: 'number' },
      settledAt: { bsonType: 'number' },
      chargedAmountCents: { bsonType: 'number' },
      chargedCurrency: { bsonType: 'string' },
    },
  },
};

/**
 * `receipts`. `product` is rule 5's schema-level half — `BillingService` passes the
 * verified product today, and this is what stops a future code path from recording a
 * receipt that resolved to nothing and then being replayable against any SKU. A 2026-09-04
 * mutation battery relaxed the SQLite column to nullable and all 211 tests stayed green.
 */
const RECEIPT_VALIDATOR: Record<string, unknown> = {
  $jsonSchema: {
    bsonType: 'object',
    required: ['accountId', 'platform', 'product', 'raw', 'verifiedAt'],
    properties: {
      accountId: { bsonType: 'string' },
      platform: { bsonType: 'string' },
      product: { bsonType: 'string' },
      raw: { bsonType: 'string' },
      verifiedAt: { bsonType: 'number' },
    },
  },
};

/** `ledger`. A row naming neither the SKU nor the kind cannot be reconciled or
 *  hand-corrected, which is the whole reason the collection is append-only. */
const LEDGER_VALIDATOR: Record<string, unknown> = {
  $jsonSchema: {
    bsonType: 'object',
    required: ['accountId', 'sku', 'kind', 'ts'],
    properties: {
      accountId: { bsonType: 'string' },
      sku: { bsonType: 'string' },
      orderId: { bsonType: 'string' },
      receiptId: { bsonType: 'string' },
      kind: { bsonType: 'string' },
      ts: { bsonType: 'number' },
    },
  },
};

/** The three states the pump has a branch for. A fourth would make a paid delivery
 *  invisible to `pendingDeliveries` forever — the loudest reason this is a server-side
 *  enum rather than a TypeScript union. */
export const DELIVERY_STATES = ['pending', 'delivered', 'failed'] as const;
/** What a delivery row asks the control plane to do (ROADMAP 9.3). */
export const DELIVERY_ACTIONS = ['grant', 'revoke'] as const;

const DELIVERY_VALIDATOR: Record<string, unknown> = {
  $jsonSchema: {
    bsonType: 'object',
    required: ['accountId', 'sku', 'grantsJson', 'orderId', 'receiptId', 'state', 'attempts', 'createdAt'],
    properties: {
      accountId: { bsonType: 'string' },
      sku: { bsonType: 'string' },
      grantsJson: { bsonType: 'string' },
      // NOT NULL, both of them: `entitlements`' own CHECK refuses a purchase-sourced row
      // with no order behind it, so a delivery that could not satisfy it must never be
      // written here in the first place.
      orderId: { bsonType: 'string' },
      receiptId: { bsonType: 'string' },
      state: { enum: [...DELIVERY_STATES] },
      // Optional; absent means 'grant' (ROADMAP 9.3). An enum for the same reason `state` is:
      // a hand-typed 'revoked' would otherwise be drained as a GRANT.
      action: { enum: [...DELIVERY_ACTIONS] },
      attempts: { bsonType: 'number' },
      createdAt: { bsonType: 'number' },
      deliveredAt: { bsonType: 'number' },
    },
  },
};

/** The review queue's producers, and nothing else: the grant audit, the delivery pump, and
 *  since ROADMAP 9.3 the refund path (`refund`) and a revocation the control plane refused
 *  (`revocation-failed`). */
export const REVIEW_KIND_VALUES = ['grant-anomaly', 'money-taken-nothing-granted', 'refund', 'revocation-failed'] as const;
export const REVIEW_STATE_VALUES = ['open', 'reviewed'] as const;

const REVIEW_VALIDATOR: Record<string, unknown> = {
  $jsonSchema: {
    bsonType: 'object',
    required: ['kind', 'accountId', 'summary', 'evidenceJson', 'state', 'createdAt'],
    properties: {
      kind: { enum: [...REVIEW_KIND_VALUES] },
      accountId: { bsonType: 'string' },
      dayKey: { bsonType: ['string', 'null'] },
      summary: { bsonType: 'string' },
      evidenceJson: { bsonType: 'string' },
      state: { enum: [...REVIEW_STATE_VALUES] },
      createdAt: { bsonType: 'number' },
      reviewedAt: { bsonType: ['number', 'null'] },
      note: { bsonType: ['string', 'null'] },
    },
  },
};

/**
 * Creates every index and validator the billing plane depends on. Idempotent —
 * `createIndex` with an identical specification is a no-op and `collMod` re-states a
 * validator — so `main.ts` may call it at every boot, and that is what keeps a freshly
 * created cluster correct with no separate migration step.
 */
export async function ensureBillingIndexes(db: Db): Promise<void> {
  const s = billingStore(db);

  // THE trap of this port. See the file header: `unique` alone would reject the second
  // UNSETTLED order, and `partialFilterExpression` alone would reject nothing at all.
  await s.orders.createIndex(
    { platformTxnId: 1 },
    { unique: true, partialFilterExpression: { platformTxnId: { $type: 'string' } }, name: 'orders_platform_txn' },
  );
  await s.orders.createIndex({ accountId: 1 }, { name: 'orders_account' });
  // Reconciliation's only local read (`reconcile.ts`): settled orders for one platform in a
  // half-open window, oldest first. New in the port — SQLite scanned a small table happily
  // and the old schema declared no index for it.
  await s.orders.createIndex({ state: 1, platform: 1, settledAt: 1 }, { name: 'orders_settled_window' });

  // `ledgerFor`: one account's history, oldest first, tie-broken by id.
  await s.ledger.createIndex({ accountId: 1, ts: 1, _id: 1 }, { name: 'ledger_account' });

  // The pump's only query: oldest pending first, tie-broken by id so a batch is
  // deterministic even when two settlements share a millisecond.
  await s.deliveries.createIndex({ state: 1, createdAt: 1, _id: 1 }, { name: 'deliveries_pending' });

  // The support read ("everything the platform told us about this order") and the operator
  // sweep ("what has been arriving lately").
  await s.webhookEvents.createIndex({ orderId: 1, firstSeenAt: 1, _id: 1 }, { name: 'webhook_events_order' });
  await s.webhookEvents.createIndex({ lastSeenAt: -1, _id: 1 }, { name: 'webhook_events_seen' });

  // The queue, in the order it should be worked.
  await s.reviewQueue.createIndex({ state: 1, createdAt: 1, _id: 1 }, { name: 'review_queue_open' });

  await ensureValidator(db, 'orders', ORDER_VALIDATOR);
  await ensureValidator(db, 'receipts', RECEIPT_VALIDATOR);
  await ensureValidator(db, 'ledger', LEDGER_VALIDATOR);
  await ensureValidator(db, 'deliveries', DELIVERY_VALIDATOR);
  await ensureValidator(db, 'reviewQueue', REVIEW_VALIDATOR);
}

/** Installs a collection validator whether or not the collection exists yet.
 *  `createCollection` fails on an existing collection, so an existing one is amended with
 *  `collMod` instead. */
async function ensureValidator(db: Db, name: string, validator: Record<string, unknown>): Promise<void> {
  const existing = await db.listCollections({ name }).toArray();
  if (existing.length === 0) {
    await db.createCollection(name, { validator });
    return;
  }
  await db.command({ collMod: name, validator });
}
