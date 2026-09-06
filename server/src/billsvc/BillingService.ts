/**
 * Orders, receipts and delivery (design/19-server-platform.md §4). A pure class over an
 * injected `DatabaseSync` — the same dependency-injection shape as `AuthService` /
 * `PartyService` / `Matchmaker`, so every test runs against a `:memory:` billing DB with
 * no disk I/O and no HTTP.
 *
 * The five rules from design/19 §4, and where each one lives:
 *
 *  1. IDEMPOTENCY IS A CLAIM, NEVER A LOOK-BEFORE-WRITE. Platform callbacks are
 *     at-least-once by contract. Delivery is `INSERT ... ON CONFLICT DO NOTHING` followed
 *     by reading `changes()` — win the claim or deliver nothing. There is no
 *     SELECT-then-INSERT anywhere on the settlement path. `settle` claims TWICE: the
 *     receipt row's primary key and the ledger row's `purchase:<platform>:<txn>` id. The
 *     second claim alone is what design/19 names; the first is what stops a forged
 *     callback from varying `txnId` to re-deliver one receipt (see `settle`).
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
 *     order's SKU before anything is written, and stored on the row afterwards.
 *
 * And the sixth, from `delivery.ts`: the order update, the ledger row and the entitlement
 * grant are one `BEGIN IMMEDIATE`. funny's verify-and-heal CAS saga is deliberately not
 * copied — see that file. This class knows nothing about how the grant is honoured: the
 * shipped implementation (`outbox.ts`) writes a durable delivery obligation into a fourth
 * table in this same file and a pump drains it afterwards, and swapping that for something
 * else must not require reading a line of this file.
 *
 * Verification happens BEFORE the transaction opens. A real adapter is an HTTPS round
 * trip, and holding SQLite's write lock across one would serialise every settlement in
 * the process behind the slowest platform response.
 */
import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
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
  db: DatabaseSync;
  verify: ReceiptVerifier;
  /**
   * Defaults to `ledgerOnlyDelivery`, which writes nothing beyond the ledger row. The
   * PROCESS does not take that default — `server.ts` injects `outbox.ts`'s delivery — but
   * this class keeps it, because a `BillingService` constructed with no delivery at all in
   * a test must write only to the tables it was handed.
   */
  deliver?: EntitlementDelivery;
  nowMs?: () => number;
  newOrderId?: () => string;
  /** `devStubEnabled(env)`, forwarded to `paymentParamsFor`. Defaults to off. */
  devStubOn?: boolean;
}

/** Thrown inside the settlement transaction to roll it back with a named reason. */
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
  private readonly db: DatabaseSync;
  private readonly verify: ReceiptVerifier;
  private readonly deliver: EntitlementDelivery;
  private readonly now: () => number;
  private readonly newOrderId: () => string;
  private readonly devStubOn: boolean;

  constructor(deps: BillingServiceDeps) {
    this.db = deps.db;
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
  createOrder(input: { accountId: unknown; sku: unknown; platform: unknown }): CreateOrderResult {
    const accountId = typeof input.accountId === 'string' ? input.accountId.trim() : '';
    if (!accountId) return { ok: false, error: 'accountId required' };
    const platform = asIapPlatform(input.platform);
    if (!platform) return { ok: false, error: 'unknown platform' };
    const def = findSku(input.sku);
    if (!def) return { ok: false, error: 'unknown sku' };

    const id = this.newOrderId();
    const createdAt = this.now();
    this.db
      .prepare(
        `INSERT INTO orders (id, account_id, sku, platform, amount_cents, currency, state, platform_txn_id, created_at, settled_at)
         VALUES (?, ?, ?, ?, ?, ?, 'created', NULL, ?, NULL)`,
      )
      .run(id, accountId, def.sku, platform, def.amountCents, def.currency, createdAt);

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
  getOrder(id: string): OrderView | null {
    const row = this.db.prepare('SELECT * FROM orders WHERE id = ?').get(id) as OrderRow | undefined;
    return row ? toOrderView(row) : null;
  }

  /** Append-only history for one account — the support/reconciliation read (design/19 §7). */
  ledgerFor(accountId: string): readonly LedgerView[] {
    const rows = this.db
      .prepare('SELECT * FROM ledger WHERE account_id = ? ORDER BY ts ASC, id ASC')
      .all(accountId) as unknown as LedgerRow[];
    return rows.map(toLedgerView);
  }

  /**
   * Marks an open order failed from a platform's failure/cancel callback. Writes NO ledger
   * row and does NOT claim `platform_txn_id`: a failed payment moved no money, and holding
   * the transaction id would make a later successful retry of the same order collide with
   * a row that means nothing. Idempotent — a redelivered failure finds the order already
   * failed and reports `changed: false` rather than an error.
   */
  markFailed(input: { orderId: string }): { ok: boolean; changed: boolean } {
    const res = this.db
      .prepare(`UPDATE orders SET state = 'failed' WHERE id = ? AND state = 'created'`)
      .run(input.orderId);
    if (Number(res.changes) === 1) return { ok: true, changed: true };
    return { ok: this.getOrder(input.orderId) !== null, changed: false };
  }

  /**
   * The one path that delivers anything (rule 2). Verify off-transaction, then claim and
   * deliver inside one `BEGIN IMMEDIATE`.
   *
   * THE IDEMPOTENCY KEY IS PLATFORM-DERIVED WHERE POSSIBLE. `verified.platformTxnId` wins
   * over the callback body's `txnId` when the adapter supplies one, because the body is
   * unauthenticated and the receipt is not. The dev stub supplies none, which is exactly
   * why the receipt row is claimed too: otherwise the same stub receipt could be posted
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

    const order = this.getOrder(orderId);
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

    const receiptId = `${input.platform}:${receipt}`;
    const txnId = verified.platformTxnId ?? bodyTxnId;
    const ts = this.now();
    const db = this.db;
    db.exec('BEGIN IMMEDIATE');
    try {
      // Claim #1 — the receipt. Losing it means this exact receipt has already been
      // consumed; who consumed it decides whether that is an at-least-once redelivery
      // (replay, deliver nothing, write nothing) or rule 4's refusal.
      const receiptClaim = db
        .prepare(
          `INSERT INTO receipts (id, account_id, platform, product, raw, verified_at)
           VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
        )
        .run(receiptId, order.accountId, input.platform, verified.product, receipt, ts);
      if (Number(receiptClaim.changes) !== 1) {
        // Lost the claim, so this receipt is already on file. WHOSE decides the answer, and
        // the read is exact because it happens under the write lock this transaction holds
        // — asking before `BEGIN IMMEDIATE` would make rule 4 depend on there being no
        // `await` between the question and the claim, which is a property of today's code
        // rather than of the design.
        const owner = db.prepare('SELECT account_id FROM receipts WHERE id = ?').get(receiptId) as
          | { account_id: string }
          | undefined;
        // RULE 4: another account's consumed receipt is refused, not replayed. funny's
        // comment is the whole argument — replaying it mirrors the owning account's
        // settlement state back to whoever posted the callback. Deliberately says nothing
        // about the owner.
        // `owner?.` rather than `owner &&`: losing the claim means the row exists, so a
        // missing one is impossible — and if it ever happens, the fail-closed answer is the
        // refusal, not a delivery.
        if (owner?.account_id !== order.accountId) {
          throw new SettleRejection('receipt-other-account', 'receipt already consumed by another account');
        }
        db.exec('COMMIT');
        return { ok: true, orderId, sku: order.sku, delivered: false, note: 'already-delivered' };
      }

      // Claim #2 — the platform transaction, design/19's named idempotency key. Losing it
      // after WINNING the receipt claim means one platform transaction is being presented
      // under two different receipts: nothing is delivered and an operator gets a signal,
      // rather than the ambiguity being resolved silently either way.
      const ledgerId = `purchase:${input.platform}:${txnId}`;
      const ledgerClaim = db
        .prepare(
          `INSERT INTO ledger (id, account_id, sku, order_id, receipt_id, kind, ts)
           VALUES (?, ?, ?, ?, ?, 'purchase', ?) ON CONFLICT(id) DO NOTHING`,
        )
        .run(ledgerId, order.accountId, order.sku, orderId, receiptId, ts);
      if (Number(ledgerClaim.changes) !== 1) {
        throw new SettleRejection('txn-conflict', `transaction '${txnId}' was already delivered`);
      }

      // `orders.platform_txn_id` is UNIQUE, so this is also where a second order trying to
      // claim the same transaction is stopped. Checked explicitly rather than by catching
      // the constraint violation: inside `BEGIN IMMEDIATE` the read is exact, and a named
      // rejection beats parsing a driver's error string.
      const holder = db.prepare('SELECT id FROM orders WHERE platform_txn_id = ?').get(txnId) as
        | { id: string }
        | undefined;
      if (holder && holder.id !== orderId) {
        throw new SettleRejection('txn-conflict', `transaction '${txnId}' already belongs to order '${holder.id}'`);
      }

      const settled = db
        .prepare(
          `UPDATE orders SET platform_txn_id = ?, state = 'settled', settled_at = ?
            WHERE id = ? AND state = 'created'`,
        )
        .run(txnId, ts, orderId);
      if (Number(settled.changes) !== 1) {
        // Re-read rather than quoting the pre-transaction snapshot: the message goes to an
        // operator, and `order.state` was read before the lock was held.
        const now = db.prepare('SELECT state FROM orders WHERE id = ?').get(orderId) as { state: string };
        throw new SettleRejection('order-not-open', `order '${orderId}' is '${now.state}', not 'created'`);
      }

      // The catalogue can change between booking an order and settling it. When it has,
      // the settlement STILL commits: the money moved, and the append-only ledger row is
      // the evidence a human needs to make it right. What must not happen is delivering an
      // empty entitlement quietly, so it is logged as an error — this is one of the rows
      // §7's reconciliation sweep exists to surface.
      const def = findSku(order.sku);
      if (!def) {
        console.error(
          `[blightbloom] billsvc: order '${orderId}' settled for SKU '${order.sku}', which is no longer in the ` +
            'catalogue — the ledger row was written but nothing was granted. Needs a manual grant.',
        );
      }

      // Inside the transaction on purpose (delivery.ts): a throw here rolls the order row
      // and the ledger row back with it, so the platform's next retry finds an open order.
      this.deliver.grant({
        // The key this transaction just WON, handed on so a persisting delivery keys itself
        // on the same claim rather than minting a weaker one (`delivery.ts`).
        ledgerId,
        accountId: order.accountId,
        sku: order.sku,
        grants: def?.grants ?? [],
        orderId,
        receiptId,
        ts,
      });

      db.exec('COMMIT');
      return { ok: true, orderId, sku: order.sku, delivered: true };
    } catch (e) {
      db.exec('ROLLBACK');
      if (e instanceof SettleRejection) return { ok: false, code: e.code, reason: e.message };
      return { ok: false, code: 'delivery-failed', reason: (e as Error).message };
    }
  }
}

interface OrderRow {
  id: string;
  account_id: string;
  sku: string;
  platform: string;
  amount_cents: number;
  currency: string;
  state: string;
  platform_txn_id: string | null;
  created_at: number;
  settled_at: number | null;
}

interface LedgerRow {
  id: string;
  account_id: string;
  sku: string;
  order_id: string | null;
  receipt_id: string | null;
  kind: string;
  ts: number;
}

function toOrderView(row: OrderRow): OrderView {
  return {
    id: row.id,
    accountId: row.account_id,
    sku: row.sku,
    platform: row.platform as IapPlatform,
    amountCents: row.amount_cents,
    currency: row.currency,
    state: row.state as OrderState,
    platformTxnId: row.platform_txn_id,
    createdAt: row.created_at,
    settledAt: row.settled_at,
  };
}

function toLedgerView(row: LedgerRow): LedgerView {
  return {
    id: row.id,
    accountId: row.account_id,
    sku: row.sku,
    orderId: row.order_id,
    receiptId: row.receipt_id,
    kind: row.kind,
    ts: row.ts,
  };
}
