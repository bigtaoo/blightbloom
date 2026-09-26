/**
 * Split of `billingDb.ts` (2026-09-15, the MongoDB port): the billing plane's DOCUMENT
 * SHAPES and the typed handles onto them. `schema.ts` owns the indexes and validators that
 * enforce them.
 *
 * Six collections on the `billing` logical database (`mongo.ts`), one per table of the
 * `node:sqlite` file this plane owned until 2026-09-15 — four for the money, two for the
 * operations around it. design/19-server-platform.md §4's "money gets its own process and
 * its own database" survives the move as a separate DATABASE on the cluster, not merely a
 * separate collection prefix, because a shared handle is how a later refactor quietly
 * re-merges the planes.
 *
 * ## snake_case becomes camelCase, and the PRIMARY KEY becomes `_id`
 *
 * Every column name is carried over verbatim except for the case convention
 * (`platform_txn_id` → `platformTxnId`, `created_at` → `createdAt`, …), and every table
 * that had a `TEXT PRIMARY KEY` keeps that exact string as `_id`. Nothing is renamed and
 * nothing is merged, so the one-time data migration is a mechanical column→field rename
 * rather than a transformation anybody has to reason about.
 *
 * ## ABSENT, not null, wherever a unique index can see the field
 *
 * `orders.platformTxnId` is ABSENT on an unsettled order rather than stored as `null`, and
 * so are `settledAt`, `deliveries.deliveredAt` and `ledger.orderId`/`receiptId`. The reads
 * below map absence back to `null` at the boundary, so every caller still sees the SQLite
 * shape. `webhookEvents.orderId`/`txnId`/`detail` and `reviewQueue.dayKey`/`reviewedAt`/
 * `note` are the exception and hold an explicit `null`: nothing indexes them uniquely, and
 * `webhookEventsForOrder` reads `orderId` as an equality filter where a stored `null` and
 * an absent field must behave the same way SQL's `IS NULL` did.
 *
 * ## `grantsJson` and `evidenceJson` stay STRINGS
 *
 * Both could have become sub-documents. They deliberately do not: `deliveryPump.ts` makes a
 * row whose `grantsJson` cannot be parsed TERMINAL and files it for review, and
 * `reviewQueue.ts` reads an unparsable `evidenceJson` back as `null` rather than throwing —
 * both of which exist because design/19 §8 declines to build an admin service and plans for
 * corrections made by hand at a prompt. A typed sub-document would make the hand-edited
 * corrupt value unrepresentable, which does not remove the failure, it removes the handling.
 */
import type { Collection, Db } from 'mongodb';

/** One purchase attempt. `_id` is the merchant order id every platform echoes back. */
export interface OrderDoc {
  _id: string;
  accountId: string;
  sku: string;
  platform: string;
  amountCents: number;
  currency: string;
  state: string;
  /** ABSENT until a platform callback claims this order — see the header, and the partial
   *  unique index in `schema.ts` that the absence is load-bearing for. */
  platformTxnId?: string;
  createdAt: number;
  settledAt?: number;
  /** What the platform says it CHARGED, when its settlement callback says so (Paddle, ROADMAP
   *  9.2). A record beside `amountCents`, never an authority over it: a difference is a
   *  reconciliation finding. ABSENT for every receipt platform. */
  chargedAmountCents?: number;
  chargedCurrency?: string;
}

/** One verified receipt, keyed `${platform}:${receipt}`. `product` is what the receipt
 *  RESOLVED to — without it a receipt for one SKU can be replayed to claim another
 *  (design/19 §4 rule 5). */
export interface ReceiptDoc {
  _id: string;
  accountId: string;
  platform: string;
  product: string;
  raw: string;
  verifiedAt: number;
}

/**
 * APPEND-ONLY. Never updated, never deleted — a reversal is a new document with
 * `kind: 'reversal'`, which is what makes the store hand-auditable without the admin
 * service design/19 §8 declines to build. That is a locked decision, not a current
 * implementation detail: nothing in this plane may call `updateOne`/`deleteOne` here.
 */
export interface LedgerDoc {
  _id: string;
  accountId: string;
  sku: string;
  orderId?: string;
  receiptId?: string;
  kind: string;
  ts: number;
}

/**
 * The delivery OUTBOX (design/19 §4's closed loop). `_id` is the ledger document's own id,
 * shared rather than generated: the ledger claim inside the settlement transaction has
 * already been WON by the time this is written, so reusing that key makes a second document
 * impossible without a second idempotency mechanism.
 *
 * A MongoDB transaction CAN span the `billing` and `accounts` databases (pinned in
 * `test/mongo.semantics.test.ts`), so the outbox is no longer forced by the store. It stays
 * anyway, and the reason never depended on SQLite: delivering from inside the settlement
 * transaction means holding a lock across an HTTP round trip to the control plane. The row
 * is a durable PROMISE; `deliveryPump.ts` keeps it afterwards, at-least-once, made safe by
 * `entitlements`' own UNIQUE(accountId, sku) on the receiving side.
 */
export interface DeliveryDoc {
  _id: string;
  accountId: string;
  /** The BILLSVC sku (`bp.cannon`), advisory: what the receiver writes is derived from
   *  `grantsJson` and namespaced by `EntitlementService` (`blueprint:cannon`). */
  sku: string;
  /** The `(kind, id)` pairs from the SKU catalogue, frozen AT SETTLEMENT. Not re-read from
   *  the catalogue at delivery time: a SKU edited between the payment and a retried delivery
   *  must deliver what was paid for, not what the table says later. */
  grantsJson: string;
  orderId: string;
  receiptId: string;
  /** `pending` | `delivered` | `failed`, enforced by the validator in `schema.ts`. */
  state: string;
  /**
   * `revoke` for a refund's entitlement REVOCATION (ROADMAP 9.3, `paddle/refunds.ts`); ABSENT
   * means `grant`, which is every row written before 9.3 and every purchase since. The pump
   * posts a revoke row to the control plane's revoke route instead of its grant route. Same
   * outbox, same at-least-once drain, same review-on-terminal-refusal — a revocation is an
   * obligation that must survive a crash exactly as a grant is.
   */
  action?: 'grant' | 'revoke';
  attempts: number;
  createdAt: number;
  /** ABSENT unless `state` is `delivered`. `failed` means we gave up, which is a different
   *  fact from a landing time and must not borrow this field to say so. */
  deliveredAt?: number;
}

/** Every platform callback, not just the one that settled (design/19 §7). `_id` is
 *  `webhookLog.ts`'s key: `${txnId}:${eventType}`, or one of its two fallbacks. */
export interface WebhookEventDoc {
  _id: string;
  platform: string;
  /** Explicit `null` when the body named none — see the header on why these three are not
   *  absent. */
  orderId: string | null;
  txnId: string | null;
  eventType: string;
  outcome: string;
  detail: string | null;
  /** The ORIGINAL bytes, verbatim, parsed or not. The field the whole collection is for. */
  raw: string;
  firstSeenAt: number;
  lastSeenAt: number;
  seenCount: number;
  /** How many redeliveries under this key arrived with a DIFFERENT body. Non-zero is
   *  somebody varying fields under a key they do not own. */
  divergences: number;
}

/** design/19 §7's "files rather than acts". `_id` is the producer's idempotency key:
 *  `grant-anomaly:<accountId>:<dayKey>` or `money-taken-nothing-granted:<deliveryId>`. */
export interface ReviewDoc {
  _id: string;
  kind: string;
  accountId: string;
  /** `YYYY-MM-DD` (UTC) for the daily audit; `null` for a delivery, which is an event. */
  dayKey: string | null;
  summary: string;
  evidenceJson: string;
  state: string;
  createdAt: number;
  reviewedAt: number | null;
  note: string | null;
}

/** The billing plane's collections, typed. Handed to every store that reads them the way a
 *  `DatabaseSync` used to be — see `test/mongoHarness.ts` on why nothing here reaches for a
 *  process-wide handle to get a database. */
export interface BillingStore {
  orders: Collection<OrderDoc>;
  receipts: Collection<ReceiptDoc>;
  ledger: Collection<LedgerDoc>;
  deliveries: Collection<DeliveryDoc>;
  webhookEvents: Collection<WebhookEventDoc>;
  reviewQueue: Collection<ReviewDoc>;
}

/** The six collection names, in one place, so a typo cannot silently create a seventh —
 *  MongoDB creates a collection on first write and would never complain. */
export const BILLING_COLLECTIONS = [
  'orders',
  'receipts',
  'ledger',
  'deliveries',
  'webhookEvents',
  'reviewQueue',
] as const;

export function billingStore(db: Db): BillingStore {
  return {
    orders: db.collection<OrderDoc>('orders'),
    receipts: db.collection<ReceiptDoc>('receipts'),
    ledger: db.collection<LedgerDoc>('ledger'),
    deliveries: db.collection<DeliveryDoc>('deliveries'),
    webhookEvents: db.collection<WebhookEventDoc>('webhookEvents'),
    reviewQueue: db.collection<ReviewDoc>('reviewQueue'),
  };
}
