/**
 * `paddle/refunds.ts` and the pump's `action: 'revoke'` arm (ROADMAP 9.3), driven directly —
 * the branches the HTTP test cannot pick: a deployment with no outbox row to take the frozen
 * grants from, a second adjustment on one transaction, and a revocation the control plane
 * refuses.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Db } from 'mongodb';
import { billingStore, ensureBillingIndexes } from '../src/billingDb';
import { openTestMongo, type MongoTestContext } from './mongoHarness';
import { applyRefund, reversalId, type RefundInput } from '../src/billsvc/paddle/refunds';
import { openReviews, reviewById, revocationFailedId } from '../src/billsvc/reviewQueue';
import { DeliveryPump, GRANT_PATH, REVOKE_PATH } from '../src/billsvc/deliveryPump';
import { deliveryById } from '../src/billsvc/outbox';
import { BillingService } from '../src/billsvc/BillingService';

let ctx: MongoTestContext;
let db: Db;

beforeEach(async () => {
  ctx = await openTestMongo();
  db = ctx.db('billing');
  await ensureBillingIndexes(db);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  await ctx.dispose();
  vi.restoreAllMocks();
});

async function settledOrder(over: { sku?: string; charged?: boolean } = {}): Promise<void> {
  await billingStore(db).orders.insertOne({
    _id: 'o1',
    accountId: 'acc-1',
    sku: over.sku ?? 'char.skirmisher',
    platform: 'paddle',
    amountCents: 3800,
    currency: 'CNY',
    state: 'settled',
    platformTxnId: 'txn_1',
    createdAt: 1,
    settledAt: 2,
    ...(over.charged === false ? {} : { chargedAmountCents: 999, chargedCurrency: 'EUR' }),
  });
}

const input = (over: Partial<RefundInput> = {}): RefundInput => ({
  platform: 'paddle',
  adjustmentId: 'adj_1',
  txnId: 'txn_1',
  action: 'refund',
  revoke: true,
  ts: 100,
  ...over,
});

describe('applyRefund', () => {
  it('with no outbox row (ledger-only delivery), revokes what the CATALOGUE says the SKU grants', async () => {
    await settledOrder();
    const res = await applyRefund(db, input());
    expect(res).toEqual({ ok: true, orderId: 'o1', accountId: 'acc-1', revoked: true, filed: true });
    const row = await deliveryById(db, reversalId('paddle', 'txn_1'));
    expect(row).toMatchObject({ action: 'revoke', state: 'pending', grantsJson: '[{"kind":"character","id":"skirmisher"}]' });
  });

  it('a SKU no longer in the catalogue queues an empty revocation — for the control plane to refuse loudly', async () => {
    await settledOrder({ sku: 'bp.retired', charged: false });
    await applyRefund(db, input());
    expect((await deliveryById(db, reversalId('paddle', 'txn_1')))!.grantsJson).toBe('[]');
    const [review] = await openReviews(db);
    expect(review!.evidence).toMatchObject({ order: { chargedAmountCents: null, chargedCurrency: null }, adjustment: { type: null, currency: null } });
    expect(review!.summary).toContain('an unstated amount');
  });

  it('a SECOND adjustment on the same transaction files its own case but revokes nothing new', async () => {
    await settledOrder();
    await applyRefund(db, input({ type: 'partial', amountCents: 100, currency: 'EUR' }));
    const second = await applyRefund(db, input({ adjustmentId: 'adj_2', type: 'partial', amountCents: 50 }));
    expect(second).toMatchObject({ ok: true, revoked: false, filed: true });
    const reviews = await openReviews(db);
    expect(reviews.map((r) => r.id)).toEqual(['refund:paddle:adj_1', 'refund:paddle:adj_2']);
    expect(reviews[1]!.summary).toContain('already queued by an earlier adjustment');
    expect(reviews[1]!.summary).toContain('50 (no currency)');
    expect(await billingStore(db).deliveries.countDocuments({ action: 'revoke' })).toBe(1);
  });

  it('revoke:false writes no reversal and no revocation', async () => {
    await settledOrder();
    const res = await applyRefund(db, input({ action: 'chargeback_reverse', revoke: false }));
    expect(res).toMatchObject({ revoked: false, filed: true });
    expect(await billingStore(db).ledger.countDocuments()).toBe(0);
    expect(await billingStore(db).deliveries.countDocuments()).toBe(0);
  });

  it('an unsettled or unknown transaction is refused', async () => {
    expect(await applyRefund(db, input())).toMatchObject({ ok: false, code: 'unknown-transaction' });
  });
});

describe('the pump drains a revocation to the revoke route', () => {
  function pump(status: number, calls: string[]): DeliveryPump {
    return new DeliveryPump({
      db,
      matchsvcUrl: 'http://control-plane:8788/',
      nowMs: () => 500,
      retry: { attempts: 1 },
      sleep: async () => {},
      fetchImpl: (async (url: string | URL | Request) => {
        calls.push(new URL(String(url)).pathname);
        return new Response('{}', { status });
      }) as unknown as typeof fetch,
    });
  }

  it('a 200 marks the revocation delivered', async () => {
    await settledOrder();
    await applyRefund(db, input());
    const calls: string[] = [];
    expect(await pump(200, calls).pumpOnce()).toMatchObject({ delivered: 1 });
    expect(calls).toEqual([REVOKE_PATH]);
    expect((await deliveryById(db, reversalId('paddle', 'txn_1')))!.state).toBe('delivered');
  });

  it('a 4xx is terminal and files a REVOCATION-FAILED case, not a money-taken one', async () => {
    await settledOrder();
    await applyRefund(db, input());
    const calls: string[] = [];
    expect(await pump(400, calls).pumpOnce()).toMatchObject({ failed: 1 });
    const id = revocationFailedId(reversalId('paddle', 'txn_1'));
    const review = await reviewById(db, id);
    expect(review).toMatchObject({ kind: 'revocation-failed' });
    expect(review!.summary).toContain('STILL HOLDS it');
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Needs a manual revocation'));
  });

  it('an unreadable revocation row is terminal with the revocation wording too', async () => {
    await billingStore(db).deliveries.insertOne({
      _id: 'reversal:paddle:bad',
      accountId: 'a',
      sku: 'bp.cannon',
      grantsJson: '{nope',
      orderId: 'o',
      receiptId: 'paddle:bad',
      state: 'pending',
      attempts: 0,
      createdAt: 1,
      action: 'revoke',
    });
    const calls: string[] = [];
    expect(await pump(200, calls).pumpOnce()).toMatchObject({ failed: 1 });
    expect(calls).toEqual([]);
    expect(await reviewById(db, revocationFailedId('reversal:paddle:bad'))).toMatchObject({ kind: 'revocation-failed' });
  });

  it('a grant row still goes to the grant route', async () => {
    await billingStore(db).deliveries.insertOne({
      _id: 'purchase:paddle:t',
      accountId: 'a',
      sku: 'bp.cannon',
      grantsJson: '[{"kind":"blueprint","id":"cannon"}]',
      orderId: 'o',
      receiptId: 'paddle:t',
      state: 'pending',
      attempts: 0,
      createdAt: 1,
    });
    const calls: string[] = [];
    await pump(200, calls).pumpOnce();
    expect(calls).toEqual([GRANT_PATH]);
  });
});

describe('BillingService.settleSigned', () => {
  it('refuses a blank order id, transaction id or product before touching anything', async () => {
    const billing = new BillingService({ db, verify: async () => ({ ok: false, reason: 'unused' }) });
    for (const bad of [
      { orderId: ' ', txnId: 't', product: 'bp.cannon' },
      { orderId: 'o', txnId: '', product: 'bp.cannon' },
      { orderId: 'o', txnId: 't', product: '' },
    ]) {
      expect(await billing.settleSigned({ platform: 'paddle', ...bad })).toMatchObject({ ok: false, code: 'bad-request' });
    }
  });

  it('settles without a charged amount, leaving the charged fields ABSENT', async () => {
    const billing = new BillingService({ db, verify: async () => ({ ok: false, reason: 'unused' }), nowMs: () => 7 });
    const created = await billing.createOrder({ accountId: 'a', sku: 'bp.cannon', platform: 'paddle' });
    expect(created.ok && created.payment.configured).toBe(false);
    const id = created.ok ? created.order.id : '';
    expect(await billing.settleSigned({ platform: 'paddle', orderId: id, txnId: 'txn_z', product: 'bp.cannon', charged: { currency: 'USD' } })).toMatchObject({ ok: true, delivered: true });
    const doc = await billingStore(db).orders.findOne({ _id: id });
    expect(doc).toMatchObject({ chargedCurrency: 'USD', platformTxnId: 'txn_z' });
    expect(doc).not.toHaveProperty('chargedAmountCents');
  });
});
