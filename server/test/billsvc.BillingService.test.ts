/**
 * `BillingService` — design/19-server-platform.md §4's five rules plus the one
 * transaction, each asserted rather than commented.
 *
 * Why this file is mostly refusals: every rule in §4 exists because funny hit the failure
 * it prevents, and every one of them is a BRANCH whose line runs on every settlement while
 * only the granting side is normally taken. A suite that only walked the happy path would
 * be green with rule 4 deleted, with the rollback deleted, and with the idempotency claim
 * replaced by a SELECT-then-INSERT.
 *
 * The two cases worth reading first:
 *
 *   'rolls the whole settlement back when delivery throws' is the one that gives §4's
 *   "one BEGIN IMMEDIATE makes the tear impossible" its teeth — and therefore the one that
 *   justifies NOT copying funny's verify-and-heal CAS saga. If the order row survived a
 *   failed grant, that saga would be necessary here after all.
 *
 *   'refuses a stub receipt re-posted against a second order' is the one the design's
 *   named idempotency key does not cover on its own: the callback body is unauthenticated,
 *   so an attacker varies `txnId` and wins a fresh claim every time unless the receipt row
 *   is claimed too.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { openBillingDb } from '../src/billingDb';
import { BillingService, type SettleResult } from '../src/billsvc/BillingService';
import { ledgerOnlyDelivery, type EntitlementDelivery, type EntitlementGrantRequest } from '../src/billsvc/delivery';
import { createReceiptVerifier } from '../src/billsvc/iap/factory';
import type { ReceiptVerifier } from '../src/billsvc/iap/types';

const SKU = 'bp.cannon'; // 1800 CNY cents in the catalogue
const OTHER_SKU = 'bp.leech'; // 1800 too, so a mismatch test cannot pass on price alone
const THIRD_SKU = 'bp.seeker'; // a distinct SKU for the second account, so no receipt is shared
const STUB = createReceiptVerifier({ BB_BILLING_DEV_STUB: '1' });

let db: DatabaseSync;
let ids = 0;
let clock = 1_000;

/** A recording delivery that can also refuse, and can look at the open transaction. */
function recordingDelivery(onGrant?: (g: EntitlementGrantRequest) => void): {
  delivery: EntitlementDelivery;
  granted: EntitlementGrantRequest[];
} {
  const granted: EntitlementGrantRequest[] = [];
  return {
    granted,
    delivery: {
      grant(g) {
        granted.push(g);
        onGrant?.(g);
      },
    },
  };
}

function service(over: { verify?: ReceiptVerifier; deliver?: EntitlementDelivery; devStubOn?: boolean } = {}) {
  return new BillingService({
    db,
    verify: over.verify ?? STUB,
    deliver: over.deliver,
    devStubOn: over.devStubOn ?? true,
    nowMs: () => (clock += 10),
    newOrderId: () => `o${++ids}`,
  });
}

/** Books an order and returns its id, failing loudly rather than returning undefined. */
function order(svc: BillingService, accountId: string, sku = SKU, platform = 'dev'): string {
  const r = svc.createOrder({ accountId, sku, platform });
  if (!r.ok) throw new Error(`createOrder failed: ${r.error}`);
  return r.order.id;
}

const rows = (table: 'orders' | 'receipts' | 'ledger'): number =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

beforeEach(() => {
  db = openBillingDb(':memory:');
  ids = 0;
  clock = 1_000;
});

afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// Rule 3 — price comes from the server
// ─────────────────────────────────────────────────────────────────────────────

describe('createOrder', () => {
  it('books an order priced from the SKU table', () => {
    const svc = service();
    const r = svc.createOrder({ accountId: 'a1', sku: SKU, platform: 'dev' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.order).toMatchObject({
      id: 'o1',
      accountId: 'a1',
      sku: SKU,
      platform: 'dev',
      amountCents: 1800,
      currency: 'CNY',
      state: 'created',
      platformTxnId: null,
      settledAt: null,
    });
  });

  it('RULE 3: a caller-supplied amount cannot change the price, because there is no such parameter', () => {
    const svc = service();
    // The cast is the point of the test: even when a caller manages to put `amount` on the
    // wire, there is no field for it to land in, so the price is still the catalogue's.
    const r = svc.createOrder({ accountId: 'a1', sku: SKU, platform: 'dev', amount: 1 } as never);
    expect(r.ok && r.order.amountCents).toBe(1800);
    expect(db.prepare('SELECT amount_cents FROM orders WHERE id = ?').get('o1')).toEqual({ amount_cents: 1800 });
  });

  it('returns the dev payment block, which is what makes the chain self-drivable', () => {
    const r = service().createOrder({ accountId: 'a1', sku: SKU, platform: 'dev' });
    expect(r.ok && r.payment.params.receipt).toBe(`product:${SKU}`);
  });

  it('hands out no receipt when the dev stub is off', () => {
    const r = service({ devStubOn: false }).createOrder({ accountId: 'a1', sku: SKU, platform: 'dev' });
    expect(r.ok && r.payment.configured).toBe(false);
  });

  it('refuses an unknown SKU rather than inventing a price', () => {
    expect(service().createOrder({ accountId: 'a1', sku: 'bp.nope', platform: 'dev' })).toEqual({
      ok: false,
      error: 'unknown sku',
    });
    expect(rows('orders')).toBe(0);
  });

  it('refuses an unknown platform', () => {
    expect(service().createOrder({ accountId: 'a1', sku: SKU, platform: 'paypal' })).toEqual({
      ok: false,
      error: 'unknown platform',
    });
  });

  it.each([[''], ['   '], [undefined], [null], [42], [{}]])('refuses accountId %j', (accountId) => {
    expect(service().createOrder({ accountId, sku: SKU, platform: 'dev' })).toEqual({
      ok: false,
      error: 'accountId required',
    });
  });

  it('trims the accountId it stores, so " a1" and "a1" are one account', () => {
    const r = service().createOrder({ accountId: '  a1  ', sku: SKU, platform: 'dev' });
    expect(r.ok && r.order.accountId).toBe('a1');
  });

  it('checks accountId before the SKU, so a garbage request reports the first problem', () => {
    expect(service().createOrder({ accountId: '', sku: 'bp.nope', platform: 'zzz' }).ok).toBe(false);
    expect(rows('orders')).toBe(0);
  });

  it('works with no clock or id injected at all', () => {
    const svc = new BillingService({ db, verify: STUB });
    const r = svc.createOrder({ accountId: 'a1', sku: SKU, platform: 'dev' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.order.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.order.createdAt).toBeGreaterThan(1_600_000_000_000);
    // No devStubOn either — the default is OFF, which is the fail-closed default.
    expect(r.payment.configured).toBe(false);
  });
});

describe('getOrder', () => {
  it('reads back what was booked', () => {
    const svc = service();
    const id = order(svc, 'a1');
    expect(svc.getOrder(id)?.sku).toBe(SKU);
  });

  it('is null for an id that was never booked', () => {
    expect(service().getOrder('nope')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The delivering path
// ─────────────────────────────────────────────────────────────────────────────

describe('settle — the delivering path', () => {
  it('delivers once, settles the order, and writes one ledger row', async () => {
    const { delivery, granted } = recordingDelivery();
    const svc = service({ deliver: delivery });
    const id = order(svc, 'a1');

    const r = await svc.settle({ platform: 'dev', orderId: id, receipt: `product:${SKU}`, txnId: 'T1' });
    expect(r).toMatchObject({ ok: true, orderId: id, sku: SKU, delivered: true });

    const settled = svc.getOrder(id)!;
    expect(settled.state).toBe('settled');
    expect(settled.platformTxnId).toBe('T1');
    expect(settled.settledAt).toBeGreaterThan(settled.createdAt);

    expect(svc.ledgerFor('a1')).toEqual([
      {
        id: 'purchase:dev:T1',
        accountId: 'a1',
        sku: SKU,
        orderId: id,
        receiptId: `dev:product:${SKU}`,
        kind: 'purchase',
        ts: settled.settledAt,
      },
    ]);
    expect(granted).toHaveLength(1);
    expect(granted[0]).toMatchObject({ accountId: 'a1', sku: SKU, orderId: id, grants: [{ kind: 'blueprint', id: 'cannon' }] });
    // The grant carries the key this transaction just WON, not one of its own. A persisting
    // delivery (`outbox.ts`) keys itself on it, so a delivery row and the money that caused
    // it share an id — and a delivery that minted its own would need a second, weaker
    // idempotency mechanism to stay at one row per payment.
    expect(granted[0]!.ledgerId).toBe(svc.ledgerFor('a1')[0]!.id);
  });

  it('RULE 5: the receipt row records the product it resolved to', async () => {
    const svc = service();
    const id = order(svc, 'a1');
    await svc.settle({ platform: 'dev', orderId: id, receipt: `product:${SKU}`, txnId: 'T1' });
    expect(db.prepare('SELECT id, account_id, platform, product, raw FROM receipts').get()).toEqual({
      id: `dev:product:${SKU}`,
      account_id: 'a1',
      platform: 'dev',
      product: SKU,
      raw: `product:${SKU}`,
    });
  });

  it('calls delivery INSIDE the transaction — the order and ledger writes are already visible to it', async () => {
    // The whole point of `delivery.ts`'s seam. If the grant ran after COMMIT (or before the
    // writes), this assertion is what notices.
    let seenState: string | undefined;
    let seenLedger = -1;
    const { delivery } = recordingDelivery(() => {
      seenState = (db.prepare('SELECT state FROM orders WHERE id = ?').get('o1') as { state: string }).state;
      seenLedger = rows('ledger');
    });
    const svc = service({ deliver: delivery });
    const id = order(svc, 'a1');
    await svc.settle({ platform: 'dev', orderId: id, receipt: `product:${SKU}`, txnId: 'T1' });
    expect(seenState).toBe('settled');
    expect(seenLedger).toBe(1);
  });

  it('defaults to ledgerOnlyDelivery, which grants nothing beyond the ledger row', async () => {
    const svc = new BillingService({ db, verify: STUB, newOrderId: () => 'o1', nowMs: () => 5 });
    const id = order(svc, 'a1');
    const r = await svc.settle({ platform: 'dev', orderId: id, receipt: `product:${SKU}`, txnId: 'T1' });
    expect(r.ok && r.delivered).toBe(true);
    expect(svc.ledgerFor('a1')).toHaveLength(1);
    expect(ledgerOnlyDelivery.grant({} as EntitlementGrantRequest)).toBeUndefined();
  });

  it('prefers the verifier\'s platform transaction id over the callback body\'s', async () => {
    // The body is unauthenticated; a verified receipt is not. A real adapter supplies
    // `platformTxnId` (Apple's original_transaction_id), and that must be the claim key.
    const verify: ReceiptVerifier = async () => ({ ok: true, product: SKU, platformTxnId: 'REAL-TXN' });
    const svc = service({ verify });
    const id = order(svc, 'a1');
    await svc.settle({ platform: 'dev', orderId: id, receipt: 'MII', txnId: 'ATTACKER-CHOSEN' });
    expect(svc.getOrder(id)!.platformTxnId).toBe('REAL-TXN');
    expect(svc.ledgerFor('a1')[0]!.id).toBe('purchase:dev:REAL-TXN');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Rule 1 — idempotency
// ─────────────────────────────────────────────────────────────────────────────

describe('settle — idempotency (rule 1)', () => {
  it('a redelivered callback is a replay: delivered:false, and nothing new written', async () => {
    const { delivery, granted } = recordingDelivery();
    const svc = service({ deliver: delivery });
    const id = order(svc, 'a1');
    const call = () => svc.settle({ platform: 'dev', orderId: id, receipt: `product:${SKU}`, txnId: 'T1' });

    expect((await call()).ok && (await svc.getOrder(id)!).state).toBe('settled');
    const second = await call();
    expect(second).toMatchObject({ ok: true, delivered: false, note: 'already-delivered' });

    expect(granted).toHaveLength(1);
    expect(rows('ledger')).toBe(1);
    expect(rows('receipts')).toBe(1);
  });

  it('stays at one delivery across five redeliveries, which is the at-least-once contract', async () => {
    const { delivery, granted } = recordingDelivery();
    const svc = service({ deliver: delivery });
    const id = order(svc, 'a1');
    const results: SettleResult[] = [];
    for (let i = 0; i < 5; i++) {
      results.push(await svc.settle({ platform: 'dev', orderId: id, receipt: `product:${SKU}`, txnId: 'T1' }));
    }
    expect(results.filter((r) => r.ok && r.delivered)).toHaveLength(1);
    expect(granted).toHaveLength(1);
    expect(rows('ledger')).toBe(1);
  });

  it('refuses a stub receipt re-posted against a SECOND order with a fresh txnId', async () => {
    // The hole design/19's named key does not close on its own: the callback body picks
    // `txnId`, so without the receipt-row claim each fresh id wins a fresh delivery.
    const { delivery, granted } = recordingDelivery();
    const svc = service({ deliver: delivery });
    const first = order(svc, 'a1');
    const second = order(svc, 'a1');
    const receipt = `product:${SKU}`;

    await svc.settle({ platform: 'dev', orderId: first, receipt, txnId: 'T1' });
    const replay = await svc.settle({ platform: 'dev', orderId: second, receipt, txnId: 'T2-FRESH' });

    expect(replay).toMatchObject({ ok: true, delivered: false, note: 'already-delivered' });
    expect(granted).toHaveLength(1);
    expect(rows('ledger')).toBe(1);
    expect(svc.getOrder(second)!.state).toBe('created'); // never paid, so never settled
  });

  it('rejects one platform transaction presented under two different receipts', async () => {
    // Receipt claim WON (new receipt), ledger claim LOST (same txn) — an ambiguity that is
    // refused rather than resolved silently in either direction.
    const verify: ReceiptVerifier = async () => ({ ok: true, product: SKU });
    const svc = service({ verify });
    const first = order(svc, 'a1');
    const second = order(svc, 'a1');

    await svc.settle({ platform: 'dev', orderId: first, receipt: 'R1', txnId: 'T1' });
    const conflict = await svc.settle({ platform: 'dev', orderId: second, receipt: 'R2', txnId: 'T1' });

    expect(conflict).toMatchObject({ ok: false, code: 'txn-conflict' });
    expect(rows('ledger')).toBe(1);
    expect(rows('receipts')).toBe(1); // the R2 row was rolled back with the rest
    expect(svc.getOrder(second)!.state).toBe('created');
  });

  it('refuses to deliver a transaction a HAND-WRITTEN ledger row already covers', async () => {
    // The one case where claim #2 is the only guard, and the case a 2026-09-04 mutation
    // battery found untested: deleting the `ledgerClaim.changes` check survived 211 tests
    // because every other scenario is also caught by the order-holder check below it.
    //
    // The scenario is real and design/19 §7 asks for it explicitly — "no admin service...
    // the schema must be queryable and hand-correctable by a human with SQL". A support
    // engineer hand-grants a purchase (which is exactly what `settle`'s own retired-SKU
    // error line tells them to do), and THEN the platform redelivers its callback. No order
    // holds that transaction id, so the holder check sees nothing; the ledger row is the
    // only evidence the grant already happened, and losing its claim is what stops the
    // player being granted the same SKU twice.
    const { delivery, granted } = recordingDelivery();
    const svc = service({ deliver: delivery });
    const id = order(svc, 'a1');
    db.prepare(
      `INSERT INTO ledger (id, account_id, sku, order_id, receipt_id, kind, ts)
       VALUES ('purchase:dev:T1', 'a1', ?, NULL, NULL, 'purchase', 1)`,
    ).run(SKU);

    const r = await svc.settle({ platform: 'dev', orderId: id, receipt: `product:${SKU}`, txnId: 'T1' });

    expect(r).toMatchObject({ ok: false, code: 'txn-conflict' });
    expect(granted).toEqual([]);
    // Nothing was written, including the receipt row claim #1 had already won.
    expect(rows('receipts')).toBe(0);
    expect(rows('ledger')).toBe(1);
    expect(svc.getOrder(id)!.state).toBe('created');
    // And no order picked up the transaction id on the way through.
    expect(svc.getOrder(id)!.platformTxnId).toBeNull();
  });

  it('the holder check is NOT what catches that — no order holds the id at all', async () => {
    // Pins the distinction the battery exposed, so a later "simplify" pass that deletes one
    // of the two checks has to come back through here. Same setup as above, with the
    // orders table asserted empty of that transaction id first.
    const svc = service();
    const id = order(svc, 'a1');
    db.prepare(
      `INSERT INTO ledger (id, account_id, sku, kind, ts) VALUES ('purchase:dev:T1', 'a1', ?, 'purchase', 1)`,
    ).run(SKU);
    expect(db.prepare('SELECT COUNT(*) AS n FROM orders WHERE platform_txn_id = ?').get('T1')).toEqual({ n: 0 });

    const r = await svc.settle({ platform: 'dev', orderId: id, receipt: `product:${SKU}`, txnId: 'T1' });
    expect(r.ok === false && r.reason).toContain('already delivered');
  });

  it('rejects a transaction id already held by another order on a different platform', async () => {
    // The ledger claim is namespaced by platform (`purchase:<platform>:<txn>`) while
    // `orders.platform_txn_id` is not, so this arrives past claim #2 and is caught by the
    // holder check. Stricter on purpose: two platforms are not a reason to book one
    // transaction id twice.
    const verify: ReceiptVerifier = async () => ({ ok: true, product: SKU });
    const svc = service({ verify });
    const first = order(svc, 'a1', SKU, 'dev');
    const second = order(svc, 'a1', SKU, 'stripe');

    await svc.settle({ platform: 'dev', orderId: first, receipt: 'R1', txnId: 'SHARED' });
    const conflict = await svc.settle({ platform: 'stripe', orderId: second, receipt: 'R2', txnId: 'SHARED' });

    expect(conflict).toMatchObject({ ok: false, code: 'txn-conflict' });
    expect(conflict.ok === false && conflict.reason).toContain(first);
    expect(rows('ledger')).toBe(1);
    expect(svc.getOrder(second)!.state).toBe('created');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Rules 4 and 5 — receipt ownership and product binding
// ─────────────────────────────────────────────────────────────────────────────

describe('settle — receipt trust (rules 4 and 5)', () => {
  it("RULE 4: another account's consumed receipt is REJECTED, not replayed", async () => {
    // Replaying it would mirror account a1's settlement state back to whoever posted the
    // callback — funny's comment is the whole argument.
    const svc = service();
    const mine = order(svc, 'a1');
    const theirs = order(svc, 'a2');
    const receipt = `product:${SKU}`;

    await svc.settle({ platform: 'dev', orderId: mine, receipt, txnId: 'T1' });
    const stolen = await svc.settle({ platform: 'dev', orderId: theirs, receipt, txnId: 'T2' });

    expect(stolen).toMatchObject({ ok: false, code: 'receipt-other-account' });
    expect(svc.ledgerFor('a2')).toEqual([]);
    expect(svc.getOrder(theirs)!.state).toBe('created');
    // The refusal is decided inside the transaction, so everything it had already written
    // is rolled back: a1's receipt row is the only one left, and it still says a1.
    expect(rows('receipts')).toBe(1);
    expect(db.prepare('SELECT account_id FROM receipts').get()).toEqual({ account_id: 'a1' });
  });

  it('the rejection leaks nothing about the owning order', async () => {
    const svc = service();
    const mine = order(svc, 'a1');
    const theirs = order(svc, 'a2');
    await svc.settle({ platform: 'dev', orderId: mine, receipt: `product:${SKU}`, txnId: 'T1' });
    const stolen = await svc.settle({ platform: 'dev', orderId: theirs, receipt: `product:${SKU}`, txnId: 'T2' });
    expect(stolen.ok === false && stolen.reason).not.toContain(mine);
    expect(stolen.ok === false && stolen.reason).not.toContain('a1');
  });

  it('RULE 5: a receipt for one SKU cannot be redeemed against an order for another', async () => {
    const svc = service();
    const id = order(svc, 'a1', OTHER_SKU);
    const r = await svc.settle({ platform: 'dev', orderId: id, receipt: `product:${SKU}`, txnId: 'T1' });
    expect(r).toMatchObject({ ok: false, code: 'product-mismatch' });
    expect(rows('receipts')).toBe(0);
    expect(rows('ledger')).toBe(0);
  });

  it('the same receipt string on two platforms is two distinct receipts', async () => {
    // `receipts.id` is `${platform}:${receipt}`, so a WeChat transaction id that happens to
    // collide with a Stripe session id is not a replay of it.
    const verify: ReceiptVerifier = async () => ({ ok: true, product: SKU });
    const svc = service({ verify });
    const a = order(svc, 'a1', SKU, 'wechat');
    const b = order(svc, 'a1', SKU, 'stripe');
    expect((await svc.settle({ platform: 'wechat', orderId: a, receipt: '4200', txnId: 'T1' })).ok).toBe(true);
    const second = await svc.settle({ platform: 'stripe', orderId: b, receipt: '4200', txnId: 'T2' });
    expect(second).toMatchObject({ ok: true, delivered: true });
    expect(rows('receipts')).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Refusals before anything is written
// ─────────────────────────────────────────────────────────────────────────────

describe('settle — refusals', () => {
  it('refuses an unverified receipt and writes nothing', async () => {
    const verify: ReceiptVerifier = async () => ({ ok: false, reason: 'apple: bad signature' });
    const svc = service({ verify });
    const id = order(svc, 'a1');
    const r = await svc.settle({ platform: 'apple', orderId: id, receipt: 'MII', txnId: 'T1' });
    expect(r).toEqual({ ok: false, code: 'verification-failed', reason: 'apple: bad signature' });
    expect(rows('receipts') + rows('ledger')).toBe(0);
    expect(svc.getOrder(id)!.state).toBe('created');
  });

  it('treats a THROWING verifier as a verification failure, not a crash', async () => {
    // A real adapter is an HTTPS call, so a DNS blip or a socket reset arrives as a
    // rejected promise. Letting it escape leaves the webhook route with no response to
    // send, and the platform's request hangs until its own timeout instead of retrying.
    const verify: ReceiptVerifier = async () => {
      throw new Error('ECONNRESET');
    };
    const svc = service({ verify });
    const id = order(svc, 'a1');
    const r = await svc.settle({ platform: 'apple', orderId: id, receipt: 'MII', txnId: 'T1' });
    expect(r).toEqual({ ok: false, code: 'verification-failed', reason: 'apple: ECONNRESET' });
    expect(rows('receipts') + rows('ledger')).toBe(0);
  });

  it('never rejects — every failure comes back as a value', async () => {
    // The property the webhook route depends on. Asserted across a throwing verifier, a
    // throwing delivery and a plain refusal in one place, because `settle` returning a
    // rejected promise is the one failure mode that produces no HTTP response at all.
    const throwing: ReceiptVerifier = async () => {
      throw new Error('x');
    };
    const badDelivery = {
      grant() {
        throw new Error('y');
      },
    };
    const a = service({ verify: throwing });
    const b = service({ deliver: badDelivery });
    const idA = order(a, 'a1');
    const idB = order(b, 'a2');
    await expect(a.settle({ platform: 'dev', orderId: idA, receipt: 'r', txnId: 'T' })).resolves.toMatchObject({
      ok: false,
    });
    await expect(
      b.settle({ platform: 'dev', orderId: idB, receipt: `product:${SKU}`, txnId: 'T' }),
    ).resolves.toMatchObject({ ok: false });
    await expect(a.settle({ platform: 'dev', orderId: 'nope', receipt: '', txnId: '' })).resolves.toMatchObject({
      ok: false,
    });
  });

  it('checks the receipt BEFORE looking the order up, so a bad receipt cannot probe order ids', async () => {
    const verify: ReceiptVerifier = async () => ({ ok: false, reason: 'nope' });
    const r = await service({ verify }).settle({ platform: 'dev', orderId: 'does-not-exist', receipt: 'x', txnId: 'T' });
    expect(r).toMatchObject({ code: 'verification-failed' });
  });

  it('refuses an unknown order', async () => {
    const r = await service().settle({ platform: 'dev', orderId: 'nope', receipt: `product:${SKU}`, txnId: 'T1' });
    expect(r).toMatchObject({ ok: false, code: 'unknown-order' });
  });

  it.each([
    ['orderId', { orderId: '' }],
    ['orderId (whitespace)', { orderId: '   ' }],
    ['receipt', { receipt: '' }],
    ['txnId', { txnId: '' }],
    ['txnId (whitespace)', { txnId: ' ' }],
  ])('refuses a callback missing %s, before verifying anything', async (_label, over) => {
    // An empty txnId in particular would make every ledger id collapse to
    // `purchase:dev:`, so the FIRST settlement would win and every later one would look
    // like a replay.
    let verifyCalls = 0;
    const verify: ReceiptVerifier = async () => {
      verifyCalls++;
      return { ok: true, product: SKU };
    };
    const svc = service({ verify });
    const id = order(svc, 'a1');
    const r = await svc.settle({ platform: 'dev', orderId: id, receipt: `product:${SKU}`, txnId: 'T1', ...over });
    expect(r).toMatchObject({ ok: false, code: 'bad-request' });
    expect(verifyCalls).toBe(0);
  });

  it('refuses non-string fields, which is how a hand-crafted JSON body arrives', async () => {
    const svc = service();
    const r = await svc.settle({ platform: 'dev', orderId: 1 as never, receipt: null as never, txnId: {} as never });
    expect(r).toMatchObject({ ok: false, code: 'bad-request' });
  });

  it('refuses to settle an order that is no longer open', async () => {
    const svc = service();
    const id = order(svc, 'a1');
    expect(svc.markFailed({ orderId: id })).toEqual({ ok: true, changed: true });

    const r = await svc.settle({ platform: 'dev', orderId: id, receipt: `product:${SKU}`, txnId: 'T1' });
    expect(r).toMatchObject({ ok: false, code: 'order-not-open' });
    // The message names the state read under the lock, not the pre-transaction snapshot.
    expect(r.ok === false && r.reason).toContain("is 'failed'");
    // Both claims were won and then rolled back — the state has to be clean for the
    // platform's next retry, or a support-issued re-send would report a phantom replay.
    expect(rows('receipts')).toBe(0);
    expect(rows('ledger')).toBe(0);
    expect(svc.getOrder(id)!.state).toBe('failed');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Rule 6 — one transaction
// ─────────────────────────────────────────────────────────────────────────────

describe('settle — one BEGIN IMMEDIATE (rule 6)', () => {
  it('rolls the WHOLE settlement back when delivery throws', async () => {
    // This is what makes funny's verify-and-heal CAS saga unnecessary here. If the order
    // row survived a failed grant, the tear that saga exists to repair would be real in
    // this codebase too, and design/19's decision not to copy it would be wrong.
    const deliver: EntitlementDelivery = {
      grant() {
        throw new Error('entitlements plane refused');
      },
    };
    const svc = service({ deliver });
    const id = order(svc, 'a1');

    const r = await svc.settle({ platform: 'dev', orderId: id, receipt: `product:${SKU}`, txnId: 'T1' });
    expect(r).toEqual({ ok: false, code: 'delivery-failed', reason: 'entitlements plane refused' });

    expect(rows('receipts')).toBe(0);
    expect(rows('ledger')).toBe(0);
    const after = svc.getOrder(id)!;
    expect(after.state).toBe('created');
    expect(after.platformTxnId).toBeNull();
    expect(after.settledAt).toBeNull();
  });

  it('and the platform\'s next retry then succeeds, because the order is still open', async () => {
    let fail = true;
    const granted: string[] = [];
    const deliver: EntitlementDelivery = {
      grant(g) {
        if (fail) throw new Error('transient');
        granted.push(g.orderId);
      },
    };
    const svc = service({ deliver });
    const id = order(svc, 'a1');

    expect((await svc.settle({ platform: 'dev', orderId: id, receipt: `product:${SKU}`, txnId: 'T1' })).ok).toBe(false);
    fail = false;
    const retry = await svc.settle({ platform: 'dev', orderId: id, receipt: `product:${SKU}`, txnId: 'T1' });
    expect(retry).toMatchObject({ ok: true, delivered: true });
    expect(granted).toEqual([id]);
  });

  it('leaves the connection usable after a rollback', async () => {
    // A missed ROLLBACK leaves the transaction open, and the very next settlement fails
    // with "cannot start a transaction within a transaction" — a cascade that looks like a
    // database problem rather than the delivery bug that caused it.
    const deliver: EntitlementDelivery = {
      grant() {
        throw new Error('boom');
      },
    };
    const svc = service({ deliver });
    const bad = order(svc, 'a1');
    await svc.settle({ platform: 'dev', orderId: bad, receipt: `product:${SKU}`, txnId: 'T1' });

    const good = order(svc, 'a2');
    const r = await service().settle({ platform: 'dev', orderId: good, receipt: `product:${SKU}`, txnId: 'T2' });
    expect(r).toMatchObject({ ok: true, delivered: true });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// markFailed and the ledger read
// ─────────────────────────────────────────────────────────────────────────────

describe('settle — a SKU retired between booking and settlement', () => {
  it('still settles and still writes the ledger row, because the money moved', async () => {
    // The order was booked from the catalogue, so this only happens when the catalogue
    // changes mid-flight. Refusing here would take the payment and deliver nothing with no
    // record of it, which is the one outcome that cannot be repaired by hand afterwards.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    db.prepare(
      `INSERT INTO orders (id, account_id, sku, platform, amount_cents, currency, state, platform_txn_id, created_at)
       VALUES ('legacy', 'a1', 'bp.retired', 'dev', 1800, 'CNY', 'created', NULL, 1)`,
    ).run();
    const { delivery } = recordingDelivery();
    const verify: ReceiptVerifier = async () => ({ ok: true, product: 'bp.retired' });
    const svc = service({ verify, deliver: delivery });

    const r = await svc.settle({ platform: 'dev', orderId: 'legacy', receipt: 'R', txnId: 'T1' });
    expect(r).toMatchObject({ ok: true, delivered: true, sku: 'bp.retired' });
    expect(svc.getOrder('legacy')!.state).toBe('settled');
    expect(svc.ledgerFor('a1')).toHaveLength(1);
  });

  it('grants nothing, and says so loudly instead of delivering an empty entitlement quietly', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    db.prepare(
      `INSERT INTO orders (id, account_id, sku, platform, amount_cents, currency, state, platform_txn_id, created_at)
       VALUES ('legacy', 'a1', 'bp.retired', 'dev', 1800, 'CNY', 'created', NULL, 1)`,
    ).run();
    const { delivery, granted } = recordingDelivery();
    const verify: ReceiptVerifier = async () => ({ ok: true, product: 'bp.retired' });
    await service({ verify, deliver: delivery }).settle({
      platform: 'dev',
      orderId: 'legacy',
      receipt: 'R',
      txnId: 'T1',
    });

    expect(granted).toHaveLength(1);
    expect(granted[0]!.grants).toEqual([]);
    expect(error).toHaveBeenCalledOnce();
    expect(error.mock.calls[0]![0]).toContain('bp.retired');
    expect(error.mock.calls[0]![0]).toContain('manual grant');
  });
});

describe('markFailed', () => {
  it('closes an open order and writes no ledger row', () => {
    const svc = service();
    const id = order(svc, 'a1');
    expect(svc.markFailed({ orderId: id })).toEqual({ ok: true, changed: true });
    expect(svc.getOrder(id)!.state).toBe('failed');
    expect(rows('ledger')).toBe(0);
  });

  it('does NOT claim the transaction id — a failed payment moved no money', () => {
    const svc = service();
    const id = order(svc, 'a1');
    svc.markFailed({ orderId: id });
    expect(svc.getOrder(id)!.platformTxnId).toBeNull();
  });

  it('is idempotent: a redelivered failure reports changed:false, not an error', () => {
    const svc = service();
    const id = order(svc, 'a1');
    svc.markFailed({ orderId: id });
    expect(svc.markFailed({ orderId: id })).toEqual({ ok: true, changed: false });
  });

  it('reports ok:false for an order that does not exist', () => {
    expect(service().markFailed({ orderId: 'nope' })).toEqual({ ok: false, changed: false });
  });

  it('cannot un-settle a delivered order', async () => {
    const svc = service();
    const id = order(svc, 'a1');
    await svc.settle({ platform: 'dev', orderId: id, receipt: `product:${SKU}`, txnId: 'T1' });
    expect(svc.markFailed({ orderId: id })).toEqual({ ok: true, changed: false });
    expect(svc.getOrder(id)!.state).toBe('settled');
  });
});

describe('ledgerFor', () => {
  it('is empty for an account that never bought anything', () => {
    expect(service().ledgerFor('a1')).toEqual([]);
  });

  it('returns only that account\'s rows, oldest first', async () => {
    const svc = service();
    const one = order(svc, 'a1', SKU);
    const two = order(svc, 'a1', OTHER_SKU);
    const theirs = order(svc, 'a2', THIRD_SKU);
    await svc.settle({ platform: 'dev', orderId: one, receipt: `product:${SKU}`, txnId: 'T1' });
    await svc.settle({ platform: 'dev', orderId: two, receipt: `product:${OTHER_SKU}`, txnId: 'T2' });
    await svc.settle({ platform: 'dev', orderId: theirs, receipt: `product:${THIRD_SKU}`, txnId: 'T3' });

    expect(svc.ledgerFor('a1').map((l) => l.sku)).toEqual([SKU, OTHER_SKU]);
    expect(svc.ledgerFor('a2').map((l) => l.sku)).toEqual([THIRD_SKU]);
  });

  it('is append-only — nothing in the service ever updates or deletes a ledger row', async () => {
    // Asserted structurally rather than by inspecting SQL strings: settle a purchase, then
    // drive every other mutating method and confirm the original row is byte-identical.
    const svc = service();
    const id = order(svc, 'a1');
    await svc.settle({ platform: 'dev', orderId: id, receipt: `product:${SKU}`, txnId: 'T1' });
    const before = svc.ledgerFor('a1');

    await svc.settle({ platform: 'dev', orderId: id, receipt: `product:${SKU}`, txnId: 'T1' });
    svc.markFailed({ orderId: id });
    const second = order(svc, 'a1');
    await svc.settle({ platform: 'dev', orderId: second, receipt: `product:${SKU}`, txnId: 'T9' });

    expect(svc.ledgerFor('a1')).toEqual(before);
  });
});

describe('listSkus', () => {
  it('is the catalogue, unfiltered', () => {
    expect(service().listSkus().map((s) => s.sku)).toContain(SKU);
  });
});
