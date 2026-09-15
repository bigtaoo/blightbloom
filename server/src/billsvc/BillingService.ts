/**
 * Orders, receipts and delivery (design/19-server-platform.md §4). A pure class over an
 * injected billing `Db` — the same dependency-injection shape as `AuthService` /
 * `PartyService` / `Matchmaker`, so every test runs against an isolated database on the
 * suite's own mongod (`test/mongoHarness.ts`) with no HTTP and no process-wide handle.
 *
 * The five rules from design/19 §4, and where each one lives:
 *
 *  1. IDEMPOTENCY IS A CLAIM, NEVER A LOOK-BEFORE-WRITE. Platform callbacks are
 *     at-least-once by contract. Delivery is an upsert whose whole payload is
 *     `$setOnInsert`, read back through `upsertedCount === 1` — win the claim or deliver
 *     nothing. There is no find-then-insert anywhere on the settlement path. `settle` claims
 *     TWICE: the receipt document's `_id` and the ledger document's
 *     `purchase:<platform>:<txn>` id. The second claim alone is what design/19 names; the
 *     first is what stops a forged callback from varying `txnId` to re-deliver one receipt
 *     (see `settle`).
 *  2. DELIVERY IS TRIGGERED BY THE CALLBACK, NEVER BY THE CLIENT. `createOrder` books an
 *     order and returns payment parameters; `getOrder` polls. Neither can grant anything —
 *     `deliver.grant` is reachable from `settle` and from nowhere else.
 *  3. PRICE COMES FROM THE SERVER. `createOrder` takes no amount. Not "ignores one" —
 *     there is no parameter, so a caller-supplied price cannot be plumbed in by mistake;
 *     the route layer drops it from the body.
 *  4. A RECEIPT BELONGING TO ANOTHER ACCOUNT IS REJECTED, NOT REPLAYED. funny's comment is
 *     the whole argument: replaying it mirrors another account's state back to the caller.
 *     Decided from INSIDE the transaction, when the receipt claim is lost — see `settle`.
 *  5. A RECEIPT RECORDS THE PRODUCT IT RESOLVED TO. Without it a receipt bought for one
 *     SKU can be replayed to claim another, so the verified product is compared with the
 *     order's SKU before anything is written, and stored on the document afterwards.
 *
 * And the sixth, from `delivery.ts`: the order update, the ledger document and the
 * entitlement grant are one transaction. funny's verify-and-heal CAS saga is deliberately
 * not copied — see that file. This class knows nothing about how the grant is honoured: the
 * shipped implementation (`outbox.ts`) writes a durable delivery obligation into a fourth
 * collection in this same store and a pump drains it afterwards, and swapping that for
 * something else must not require reading a line of this file.
 *
 * ## `BEGIN IMMEDIATE` became `session.withTransaction`, and one rule came with it
 *
 * The driver may RETRY the callback handed to `withTransaction` — a transient error aborts
 * the attempt and re-runs the whole body. So the body has to be idempotent, and everything
 * that must not differ between attempts is computed BEFORE the transaction opens: the
 * timestamp, the receipt id, the ledger id, and the catalogue lookup. Nothing inside the
 * callback reads a clock, mints an id, or increments a closure variable. The single
 * assignment it does make (`replay`) is reset at the top of each attempt, so a retry cannot
 * inherit the previous attempt's answer.
 *
 * Verification happens BEFORE the transaction opens, for the reason it always did: a real
 * adapter is an HTTPS round trip, and holding a transaction open across one would serialise
 * every settlement in the process behind the slowest platform response.
 */
import type { Db } from 'mongodb';
import { randomUUID } from 'node:crypto';
import { billingStore, type BillingStore, type LedgerDoc, type OrderDoc } from '../billing/collections';
import { findSku, listSkus, type SkuDef } from './skus';
import { paymentParamsFor, type PaymentParams } from './paymentParams';
import { ledgerOnlyDelivery, type EntitlementDelivery } from './delivery';
import { asIapPlatform, type IapPlatform, type IapVerifyResult, type ReceiptVerifier } from './iap/types';

export type OrderState = 'created' | 'settled' | 'failed';

export interface OrderView {
  id: string;
  accountId: string;
  sku: string;
  platform: IapPlatform;
  amountCents: number;
  currency: string;
  state: OrderState;
  platformTxnId: string | null;
  createdAt: number;
  settledAt: number | null;
}

export interface LedgerView {
  id: string;
  accountId: string;
  sku: string;
  orderId: string | null;
  receiptId: string | null;
  kind: string;
  ts: number;
}

export type CreateOrderResult =
  | { ok: true; order: OrderView; payment: PaymentParams }
  | { ok: false; error: string };

/** Why a settlement was refused. Every value is a branch with its own test. */
export type SettleRejectionCode =
  | 'bad-request'
  | 'verification-failed'
  | 'unknown-order'
  | 'product-mismatch'
  | 'receipt-other-account'
  | 'txn-conflict'
  | 'order-not-open'
  | 'delivery-failed';

export type SettleResult =
  | { ok: true; orderId: string; sku: string; delivered: boolean; note?: string }
  | { ok: false; code: SettleRejectionCode; reason: string };

export interface SettleInput {
  /** From the webhook path (`/webhook/:platform`), not from the body. */
  platform: IapPlatform;
  /** The merchant order id every platform echoes back (out_trade_no / applicationUsername). */
  orderId: string;
  /** The platform receipt / session id / transaction id to verify. */
  receipt: string;
  /** The platform's transaction id from the callback body. Advisory — see `settle`. */
  txnId: string;
}

export interface BillingServiceDeps {
  db: Db;
  verify: ReceiptVerifier;
  /**
   * Defaults to `ledgerOnlyDelivery`, which writes nothing beyond the ledger document. The
   * PROCESS does not take that default — `server.ts` injects `outbox.ts`'s delivery — but
   * this class keeps it, because a `BillingService` constructed with no delivery at all in
   * a test must write only to the collections it was handed.
   */
  deliver?: EntitlementDelivery;
  nowMs?: () => number;
  newOrderId?: () => string;
  /** `devStubEnabled(env)`, forwarded to `paymentParamsFor`. Defaults to off. */
  devStubOn?: boolean;
}

/** Thrown inside the settlement transaction to roll it back with a named reason.
 *  Carries no MongoDB error label, so `withTransaction` propagates it rather than retrying
 *  — a deliberate refusal is not a transient failure. */
class SettleRejection extends Error {
  constructor(
    readonly code: SettleRejectionCode,
    reason: string,
  ) {
    super(reason);
    this.name = 'SettleRejection';
  }
}

export class BillingService {
  private readonly db: Db;
  private readonly store: BillingStore;
  private readonly verify: ReceiptVerifier;
  private readonly deliver: EntitlementDelivery;
  private readonly now: () => number;
  private readonly newOrderId: () => string;
  private readonly devStubOn: boolean;

  constructor(deps: BillingServiceDeps) {
    this.db = deps.db;
    this.store = billingStore(deps.db);
    this.verify = deps.verify;
    this.deliver = deps.deliver ?? ledgerOnlyDelivery;
    this.now = deps.nowMs ?? (() => Date.now());
    this.newOrderId = deps.newOrderId ?? (() => randomUUID());
    this.devStubOn = deps.devStubOn ?? false;
  }

  listSkus(): readonly SkuDef[] {
    return listSkus();
  }

  /**
   * Books an order and returns the platform payment block. Rule 3 in the type signature:
   * there is no `amount` parameter, so no caller can set a price.
   */
  async createOrder(input: { accountId: unknown; sku: unknown; platform: unknown }): Promise<CreateOrderResult> {
    const accountId = typeof input.accountId === 'string' ? input.accountId.trim() : '';
    if (!accountId) return { ok: false, error: 'accountId required' };
    const platform = asIapPlatform(input.platform);
    if (!platform) return { ok: false, error: 'unknown platform' };
    const def = findSku(input.sku);
    if (!def) return { ok: false, error: 'unknown sku' };

    const id = this.newOrderId();
    const createdAt = this.now();
    // `platformTxnId` and `settledAt` are ABSENT rather than null, which is what keeps the
    // partial unique index in `billing/schema.ts` from seeing every open order as one
    // duplicated `null` — the difference between SQLite's UNIQUE and MongoDB's, and the
    // reason unsettled orders can coexist at all.
    await this.store.orders.insertOne({
      _id: id,
      accountId,
      sku: def.sku,
      platform,
      amountCents: def.amountCents,
      currency: def.currency,
      state: 'created',
      createdAt,
    });

    const order: OrderView = {
      id,
      accountId,
      sku: def.sku,
      platform,
      amountCents: def.amountCents,
      currency: def.currency,
      state: 'created',
      platformTxnId: null,
      createdAt,
      settledAt: null,
    };
    return { ok: true, order, payment: paymentParamsFor(platform, order, this.devStubOn) };
  }

  /** The `GET /order/:id` poll view. Says what the SERVER believes, which is the only input. */
  async getOrder(id: string): Promise<OrderView | null> {
    const doc = await this.store.orders.findOne({ _id: id });
    return doc ? toOrderView(doc) : null;
  }

  /** Append-only history for one account — the support/reconciliation read (design/19 §7). */
  async ledgerFor(accountId: string): Promise<readonly LedgerView[]> {
    const docs = await this.store.ledger.find({ accountId }).sort({ ts: 1, _id: 1 }).toArray();
    return docs.map(toLedgerView);
  }

  /**
   * Marks an open order failed from a platform's failure/cancel callback. Writes NO ledger
   * document and does NOT claim `platformTxnId`: a failed payment moved no money, and
   * holding the transaction id would make a later successful retry of the same order collide
   * with a document that means nothing. Idempotent — a redelivered failure finds the order
   * already failed and reports `changed: false` rather than an error.
   */
  async markFailed(input: { orderId: string }): Promise<{ ok: boolean; changed: boolean }> {
    const res = await this.store.orders.updateOne(
      { _id: input.orderId, state: 'created' },
      { $set: { state: 'failed' } },
    );
    if (res.modifiedCount === 1) return { ok: true, changed: true };
    return { ok: (await this.getOrder(input.orderId)) !== null, changed: false };
  }

  /**
   * The one path that delivers anything (rule 2). Verify off-transaction, then claim and
   * deliver inside one `session.withTransaction`.
   *
   * THE IDEMPOTENCY KEY IS PLATFORM-DERIVED WHERE POSSIBLE. `verified.platformTxnId` wins
   * over the callback body's `txnId` when the adapter supplies one, because the body is
   * unauthenticated and the receipt is not. The dev stub supplies none, which is exactly
   * why the receipt document is claimed too: otherwise the same stub receipt could be posted
   * against several orders with a fresh `txnId` each time and win a fresh claim each time.
   */
  async settle(input: SettleInput): Promise<SettleResult> {
    const orderId = typeof input.orderId === 'string' ? input.orderId.trim() : '';
    const receipt = typeof input.receipt === 'string' ? input.receipt.trim() : '';
    const bodyTxnId = typeof input.txnId === 'string' ? input.txnId.trim() : '';
    if (!orderId || !receipt || !bodyTxnId) {
      return { ok: false, code: 'bad-request', reason: 'orderId, receipt and txnId are all required' };
    }

    // A verifier that THROWS is a verification failure, not a crash. A real adapter is an
    // HTTPS call, so a DNS blip or a socket reset arrives here as a rejected promise —
    // letting it escape would leave the webhook route with no response to send and the
    // platform's request hanging until its own timeout, instead of a retryable 4xx.
    let verified: IapVerifyResult;
    try {
      verified = await this.verify(input.platform, receipt);
    } catch (e) {
      return { ok: false, code: 'verification-failed', reason: `${input.platform}: ${(e as Error).message}` };
    }
    if (!verified.ok) return { ok: false, code: 'verification-failed', reason: verified.reason };

    const order = await this.getOrder(orderId);
    if (!order) return { ok: false, code: 'unknown-order', reason: `no order '${orderId}'` };

    // Rule 5. The receipt says what was bought; the order says what was asked for. If they
    // disagree, this callback is trying to redeem one purchase against another SKU.
    if (verified.product !== order.sku) {
      return {
        ok: false,
        code: 'product-mismatch',
        reason: `receipt resolved to '${verified.product}', order '${orderId}' is for '${order.sku}'`,
      };
    }

    // Everything the transaction body needs, computed BEFORE it opens — see the file header
    // on why a retried callback must not be able to mint a different id or a different clock
    // reading than the attempt before it.
    const receiptId = `${input.platform}:${receipt}`;
    const txnId = verified.platformTxnId ?? bodyTxnId;
    const ledgerId = `purchase:${input.platform}:${txnId}`;
    const ts = this.now();
    // The catalogue can change between booking an order and settling it, so this may be
    // `undefined`. Looked up out here rather than inside the callback because it is an input
    // to the grant, not a decision the transaction makes.
    const def = findSku(order.sku);

    let replay = false;
    const session = this.db.client.startSession();
    try {
      await session.withTransaction(async () => {
        // Reset per attempt: `withTransaction` may re-run this body, and an answer inherited
        // from an aborted attempt would be reported for a transaction that never wrote it.
        replay = false;

        // Claim #1 — the receipt. Losing it means this exact receipt has already been
        // consumed; who consumed it decides whether that is an at-least-once redelivery
        // (replay, deliver nothing, write nothing) or rule 4's refusal.
        const receiptClaim = await this.store.receipts.updateOne(
          { _id: receiptId },
          {
            $setOnInsert: {
              accountId: order.accountId,
              platform: input.platform,
              product: verified.product,
              raw: receipt,
              verifiedAt: ts,
            },
          },
          { upsert: true, session },
        );
        if (receiptClaim.upsertedCount !== 1) {
          // Lost the claim, so this receipt is already on file. WHOSE decides the answer, and
          // the read is exact because it happens inside this transaction — asking before it
          // opened would make rule 4 depend on there being no `await` between the question
          // and the claim, which is a property of today's code rather than of the design.
          const owner = await this.store.receipts.findOne(
            { _id: receiptId },
            { session, projection: { accountId: 1 } },
          );
          // RULE 4: another account's consumed receipt is refused, not replayed. funny's
          // comment is the whole argument — replaying it mirrors the owning account's
          // settlement state back to whoever posted the callback. Deliberately says nothing
          // about the owner.
          // `owner?.` rather than `owner &&`: losing the claim means the document exists, so
          // a missing one is impossible — and if it ever happens, the fail-closed answer is
          // the refusal, not a delivery.
          if (owner?.accountId !== order.accountId) {
            throw new SettleRejection('receipt-other-account', 'receipt already consumed by another account');
          }
          replay = true;
          return;
        }

        // Claim #2 — the platform transaction, design/19's named idempotency key. Losing it
        // after WINNING the receipt claim means one platform transaction is being presented
        // under two different receipts: nothing is delivered and an operator gets a signal,
        // rather than the ambiguity being resolved silently either way.
        const ledgerClaim = await this.store.ledger.updateOne(
          { _id: ledgerId },
          {
            $setOnInsert: {
              accountId: order.accountId,
              sku: order.sku,
              orderId,
              receiptId,
              kind: 'purchase',
              ts,
            },
          },
          { upsert: true, session },
        );
        if (ledgerClaim.upsertedCount !== 1) {
          throw new SettleRejection('txn-conflict', `transaction '${txnId}' was already delivered`);
        }

        // `orders.platformTxnId` carries a partial UNIQUE index, so this is also where a
        // second order trying to claim the same transaction is stopped. Checked explicitly
        // rather than by catching the constraint violation: inside the transaction the read
        // is exact, and a named rejection beats parsing a driver's error code.
        const holder = await this.store.orders.findOne({ platformTxnId: txnId }, { session, projection: { _id: 1 } });
        if (holder && holder._id !== orderId) {
          throw new SettleRejection('txn-conflict', `transaction '${txnId}' already belongs to order '${holder._id}'`);
        }

        const settled = await this.store.orders.updateOne(
          { _id: orderId, state: 'created' },
          { $set: { platformTxnId: txnId, state: 'settled', settledAt: ts } },
          { session },
        );
        if (settled.modifiedCount !== 1) {
          // Re-read rather than quoting the pre-transaction snapshot: the message goes to an
          // operator, and `order.state` was read before the transaction opened.
          const now = await this.store.orders.findOne({ _id: orderId }, { session, projection: { state: 1 } });
          throw new SettleRejection('order-not-open', `order '${orderId}' is '${now?.state}', not 'created'`);
        }

        // Inside the transaction on purpose (delivery.ts): a throw here rolls the order
        // document and the ledger document back with it, so the platform's next retry finds
        // an open order.
        await this.deliver.grant({
          // The key this transaction just WON, handed on so a persisting delivery keys itself
          // on the same claim rather than minting a weaker one (`delivery.ts`).
          ledgerId,
          accountId: order.accountId,
          sku: order.sku,
          grants: def?.grants ?? [],
          orderId,
          receiptId,
          ts,
          session,
        });
      });
    } catch (e) {
      if (e instanceof SettleRejection) return { ok: false, code: e.code, reason: e.message };
      return { ok: false, code: 'delivery-failed', reason: (e as Error).message };
    } finally {
      await session.endSession();
    }

    if (replay) return { ok: true, orderId, sku: order.sku, delivered: false, note: 'already-delivered' };

    // AFTER the commit, deliberately. The catalogue changed between booking this order and
    // settling it, so nothing was granted — but the money moved, and the append-only ledger
    // document is the evidence a human needs to make it right. What must not happen is
    // delivering an empty entitlement quietly, so it is logged as an error; this is one of
    // the cases §7's reconciliation sweep exists to surface. Logged out here rather than
    // inside the callback because `withTransaction` may run that body more than once, and a
    // line an operator is meant to act on must not be emitted twice for one settlement — nor
    // at all for an attempt that rolled back.
    if (!def) {
      console.error(
        `[blightbloom] billsvc: order '${orderId}' settled for SKU '${order.sku}', which is no longer in the ` +
          'catalogue — the ledger row was written but nothing was granted. Needs a manual grant.',
      );
    }
    return { ok: true, orderId, sku: order.sku, delivered: true };
  }
}

function toOrderView(doc: OrderDoc): OrderView {
  return {
    id: doc._id,
    accountId: doc.accountId,
    sku: doc.sku,
    platform: doc.platform as IapPlatform,
    amountCents: doc.amountCents,
    currency: doc.currency,
    state: doc.state as OrderState,
    platformTxnId: doc.platformTxnId ?? null,
    createdAt: doc.createdAt,
    settledAt: doc.settledAt ?? null,
  };
}

function toLedgerView(doc: LedgerDoc): LedgerView {
  return {
    id: doc._id,
    accountId: doc.accountId,
    sku: doc.sku,
    orderId: doc.orderId ?? null,
    receiptId: doc.receiptId ?? null,
    kind: doc.kind,
    ts: doc.ts,
  };
}
