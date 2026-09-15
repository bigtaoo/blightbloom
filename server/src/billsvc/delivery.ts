/**
 * The entitlement-delivery seam (design/19-server-platform.md §4 and §2).
 *
 * design/19 §4's central claim is that `orders`, the entitlement grant and `ledger` are
 * written inside ONE transaction, which is precisely why funny's verify-and-heal CAS saga
 * is NOT copied here: that saga exists because funny's receipt row and its wallet increment
 * are separate documents with no transaction around them, so a crash between the two loses
 * the purchase and two concurrent healers both re-grant. One transaction makes that tear
 * impossible, and copying the machinery would import a pile of complexity with no failure
 * behind it.
 *
 * For that claim to hold, the grant has to happen INSIDE the transaction — so it is an
 * injected object called from within it, and a throw from `grant` rolls the order document
 * and the ledger document back with it. That is the contract, and `BillingService`'s tests
 * assert it directly rather than trusting the comment.
 *
 * ## The signature changed shape in the MongoDB port (2026-09-15), and why
 *
 * It used to be synchronous and `void`, with a header arguing that an implementation which
 * "does async work and returns before it completes breaks the guarantee this seam exists to
 * provide". Under `node:sqlite` that argument was enforceable: every write was synchronous,
 * so a `void` return WAS the durability statement. Under MongoDB every write is a promise,
 * so a synchronous signature would make the guarantee unexpressible rather than mandatory.
 *
 * Two things replace it, and together they are stronger than the old shape:
 *
 *  - `grant` returns a promise the caller AWAITS inside the transaction, so "returned" still
 *    means "its writes have been issued and acknowledged within this transaction".
 *  - `session` is a REQUIRED field of the request rather than an ambient connection. Every
 *    write an implementation makes must carry it, and one that forgets writes OUTSIDE the
 *    settlement transaction — where a rollback cannot reach it. Passing it explicitly is
 *    what makes that a visible mistake in a diff instead of an invisible one at runtime.
 *
 * design/19 §2 puts the `entitlements` collection in the CONTROL PLANE's `accounts`
 * database. A MongoDB transaction CAN now span two logical databases on one cluster
 * (`test/mongo.semantics.test.ts` pins it), so unlike the SQLite two-file era, delivering
 * directly from inside the settlement transaction is technically possible. It is still not
 * done, and the reason never depended on the store: the grant has to reach the control
 * plane over HTTP (ROADMAP 8.1's internal seam owns that table, not this process), and an
 * HTTP round trip from inside a transaction holds a lock for the duration of a network
 * call to a peer that may be down.
 *
 * So `grant` writes a durable PROMISE rather than performing the delivery: `outbox.ts`
 * inserts one `deliveries` document into billsvc's own store, in the same transaction, and
 * `deliveryPump.ts` drains it over the internal seam afterwards. The single-transaction
 * claim §4 rests on is then exactly as strong as it reads — after the commit the obligation
 * is durable — and the delivery becomes at-least-once, which is safe because
 * `entitlements`' UNIQUE(accountId, sku) makes the receiving grant idempotent. That
 * idempotency is the entire reason an outbox beats a two-phase commit here.
 *
 * `ledgerOnlyDelivery` stays, and is no longer the default anywhere: it is the explicit
 * opt-out for a deployment (or a test) that wants the append-only `ledger` document to be
 * the whole delivery record, replayable into `entitlements` by hand precisely because the
 * ledger is append-only — the same property §7's reconciliation leans on.
 */
import type { ClientSession } from 'mongodb';
import type { SkuGrant } from './skus';

export interface EntitlementGrantRequest {
  /**
   * The `ledger` document's own id, `purchase:<platform>:<txn>` — design/19 §4's named
   * idempotency key, already CLAIMED by the caller before this is called. An implementation
   * that persists anything keys it on this rather than minting its own id: the claim it
   * carries is stronger than one a delivery could make for itself, and sharing the key is
   * what lets a human join a delivery back to the money that caused it in one query.
   */
  ledgerId: string;
  accountId: string;
  /** The SKU that was paid for. */
  sku: string;
  /** What that SKU unlocks — `(kind, id)` pairs, never a quantity or a balance. */
  grants: readonly SkuGrant[];
  orderId: string;
  /** `${platform}:${receipt}` — the document in `receipts` that authorised this grant. */
  receiptId: string;
  ts: number;
  /**
   * The OPEN settlement transaction. Every write an implementation makes must carry it, or
   * that write lands outside the transaction and survives a rollback — the one failure this
   * seam exists to make impossible. Not optional, and not defaulted, so forgetting it is a
   * type error rather than a production surprise.
   */
  session: ClientSession;
}

export interface EntitlementDelivery {
  /**
   * Called INSIDE the settlement transaction, exactly once per delivered order (the caller
   * has already won the idempotency claim, so this never sees a redelivery).
   *
   * Throwing — or returning a rejected promise — is the documented way to refuse: it aborts
   * the whole settlement, so the order stays open and the platform's next retry can try
   * again. The returned promise resolving is a statement that the grant is durable within
   * this transaction, which is why every write it makes has to carry `request.session`.
   *
   * NOTE for an implementer: the caller's transaction may be RETRIED by the driver on a
   * transient error, so this method can be invoked more than once for one settlement. It
   * must therefore be idempotent in itself — no counters incremented in closure variables,
   * no ids or timestamps minted here (both are handed in on the request for that reason).
   */
  grant(request: EntitlementGrantRequest): Promise<void>;
}

/**
 * The default: record nothing beyond the `ledger` document `BillingService` already wrote.
 * Not a stub for a missing implementation — it is the correct behaviour for a deployment
 * that wants the append-only ledger to be the whole record (see the file header).
 */
export const ledgerOnlyDelivery: EntitlementDelivery = {
  async grant() {
    /* the ledger document is the record */
  },
};
