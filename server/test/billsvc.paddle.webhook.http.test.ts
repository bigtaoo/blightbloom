/**
 * `POST /webhook/paddle` through the REAL billsvc server (ROADMAP 9.1/9.3): raw bytes in,
 * signature checked, settle → outbox → pump, and a refund's revocation + review case out.
 *
 * Bodies are the fixtures under `fixtures/paddle/` (modelled on Paddle's documented payloads),
 * with the order id substituted, and signed here with the documented algorithm — see
 * `billsvc.paddle.signature.test.ts` for why that signature is self-computed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import type { Db } from 'mongodb';
import { billingStore, ensureBillingIndexes } from '../src/billingDb';
import { openTestMongo, type MongoTestContext } from './mongoHarness';
import { createBillsvcServer, type BillsvcServer, type BillsvcServerOptions } from '../src/billsvc/server';
import { BillingService } from '../src/billsvc/BillingService';
import { createInternalVerifier } from '../src/internalAuth';
import { paddleSignatureFor } from '../src/billsvc/paddle/signature';
import { openReviews } from '../src/billsvc/reviewQueue';
import { webhookEventsForOrder, recentWebhookEvents } from '../src/billsvc/webhookLog';
import { GRANT_PATH, REVOKE_PATH } from '../src/billsvc/deliveryPump';

const KEY = 'test-internal-key';
const SECRET = 'pdl_ntfset_test_secret';
const CANNON_PRICE = 'pri_01j9cannon0000000000000000';
const ENV = { BB_PADDLE_WEBHOOK_SECRET: SECRET, BB_PADDLE_PRICE_IDS: `bp.cannon=${CANNON_PRICE}` };
const TXN = 'txn_01hv8wptq8987qeep44cyrewp9';
const COMPLETED = readFileSync(new URL('./fixtures/paddle/transaction.completed.json', import.meta.url), 'utf8');
const REFUND = readFileSync(new URL('./fixtures/paddle/adjustment.updated.refund.json', import.meta.url), 'utf8');

let ctx: MongoTestContext;
let db: Db;
let handle: BillsvcServer;
let baseUrl: string;
let clockMs: number;
let pumpCalls: { url: string; body: Record<string, unknown> }[];

async function boot(over: Partial<BillsvcServerOptions> = {}): Promise<void> {
  handle = createBillsvcServer({
    db,
    env: ENV,
    internalAuth: createInternalVerifier([{ caller: 'matchsvc', key: KEY }]),
    nowMs: () => clockMs,
    pump: {
      retry: { attempts: 1 },
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        pumpCalls.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
        return new Response('{"ok":true}', { status: 200 });
      }) as unknown as typeof fetch,
    },
    ...over,
  });
  await new Promise<void>((resolve) => handle.server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(handle.server.address() as AddressInfo).port}`;
}

beforeEach(async () => {
  clockMs = 1_790_418_000_000;
  pumpCalls = [];
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  ctx = await openTestMongo();
  db = ctx.db('billing');
  await ensureBillingIndexes(db);
  await boot();
});

afterEach(async () => {
  await handle.pump.stop();
  handle.server.closeAllConnections();
  await new Promise<void>((resolve) => handle.server.close(() => resolve()));
  await ctx.dispose();
  vi.restoreAllMocks();
});

async function newOrder(sku = 'bp.cannon'): Promise<{ id: string; payment: { configured: boolean; params: Record<string, string> } }> {
  const res = await fetch(`${baseUrl}/order/create`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-key': KEY },
    body: JSON.stringify({ accountId: 'acc-1', sku, platform: 'paddle' }),
  });
  const body = (await res.json()) as { order: { id: string }; payment: { configured: boolean; params: Record<string, string> } };
  return { id: body.order.id, payment: body.payment };
}

const withOrder = (raw: string, orderId: string) => raw.replace('ORDER_ID_PLACEHOLDER', orderId);

async function post(raw: string, header?: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const sig = header ?? `ts=${Math.floor(clockMs / 1000)};h1=${paddleSignatureFor(SECRET, Math.floor(clockMs / 1000), raw)}`;
  const res = await fetch(`${baseUrl}/webhook/paddle`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'paddle-signature': sig },
    body: raw,
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

const drain = async () => {
  await handle.pump.stop();
  await handle.pump.pumpOnce();
};

describe('transaction.completed', () => {
  it('createOrder hands out the configured price id and the order id for custom_data', async () => {
    const { id, payment } = await newOrder();
    expect(payment).toMatchObject({ configured: true, params: { priceId: CANNON_PRICE, customDataOrderId: id } });
    const unpriced = await newOrder('bp.seeker');
    expect(unpriced.payment.configured).toBe(false);
  });

  it('a signed completed transaction settles, records the charged money, logs the event, and delivers', async () => {
    const { id } = await newOrder();
    const raw = withOrder(COMPLETED, id);
    const res = await post(raw);
    expect(res).toEqual({ status: 200, body: { ok: true, orderId: id, sku: 'bp.cannon', delivered: true } });

    const order = await billingStore(db).orders.findOne({ _id: id });
    // AMENDMENT 1's relaxation: the signed body's transaction id IS the platform txn id.
    expect(order).toMatchObject({ state: 'settled', platformTxnId: TXN, amountCents: 1800, currency: 'CNY', chargedAmountCents: 296, chargedCurrency: 'USD' });
    expect(await billingStore(db).ledger.findOne({ _id: `purchase:paddle:${TXN}` })).toMatchObject({ kind: 'purchase', receiptId: `paddle:${TXN}` });

    const events = await webhookEventsForOrder(db, id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ id: 'evt_01hv8x2axb33yr5y238zfwcn5p:purchase', outcome: 'settled', platform: 'paddle', raw });

    await drain();
    expect(pumpCalls.map((c) => new URL(c.url).pathname)).toEqual([GRANT_PATH]);
  });

  it('a Paddle retry of the same notification is a replay: one settlement, one row, seenCount 2', async () => {
    const { id } = await newOrder();
    const raw = withOrder(COMPLETED, id);
    await post(raw);
    clockMs += 60_000; // a retry is re-signed with a fresh ts
    const again = await post(raw);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ delivered: false, note: 'already-delivered' });
    const events = await webhookEventsForOrder(db, id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ outcome: 'already-delivered', seenCount: 2, divergences: 0 });
    expect(await billingStore(db).deliveries.countDocuments()).toBe(1);
  });

  it('an UNKNOWN price id fails closed: nothing settles, the refusal is recorded', async () => {
    const { id } = await newOrder();
    const res = await post(withOrder(COMPLETED, id).split(CANNON_PRICE).join('pri_01unmapped'));
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toContain("unknown Paddle price id 'pri_01unmapped'");
    expect(await billingStore(db).orders.findOne({ _id: id })).toMatchObject({ state: 'created' });
    expect((await webhookEventsForOrder(db, id))[0]).toMatchObject({ outcome: 'rejected' });
  });

  it('a price for a DIFFERENT SKU than the order is rule 5 — product-mismatch', async () => {
    await handle.pump.stop();
    handle.server.closeAllConnections();
    await new Promise<void>((resolve) => handle.server.close(() => resolve()));
    await boot({ env: { ...ENV, BB_PADDLE_PRICE_IDS: `bp.cannon=${CANNON_PRICE},bp.seeker=pri_01seeker` } });
    const { id } = await newOrder('bp.seeker');
    const res = await post(withOrder(COMPLETED, id));
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toContain('product-mismatch');
  });

  it.each([
    ['no data.id', (r: string) => r.replace(`"id": "${TXN}"`, '"id": ""'), 'no data.id'],
    ['no custom_data.orderId', (r: string) => r.replace('{ "orderId": "ORDER_ID_PLACEHOLDER" }', 'null'), 'custom_data.orderId'],
    ['no item price', (r: string) => r.split(CANNON_PRICE).join(''), 'no item price id'],
  ])('refuses a signed transaction with %s', async (_l, mutate, reason) => {
    await newOrder();
    const res = await post(mutate(COMPLETED));
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toContain(reason);
  });

  it('refuses a transaction spanning two SKUs', async () => {
    await handle.pump.stop();
    handle.server.closeAllConnections();
    await new Promise<void>((resolve) => handle.server.close(() => resolve()));
    await boot({ env: { ...ENV, BB_PADDLE_PRICE_IDS: `bp.cannon=${CANNON_PRICE},bp.seeker=pri_01seeker` } });
    const { id } = await newOrder();
    const two = JSON.parse(withOrder(COMPLETED, id)) as { data: { items: unknown[] } };
    two.data.items.push({ price: { id: 'pri_01seeker' }, quantity: 1 });
    const res = await post(JSON.stringify(two));
    expect(String(res.body.error)).toContain('spans 2 SKUs');
  });

  it('an order id nobody booked is a 404 (Paddle retries)', async () => {
    const res = await post(withOrder(COMPLETED, 'no-such-order'));
    expect(res.status).toBe(404);
  });

  it('a settlement that THROWS is a recorded 500, not a hung request', async () => {
    const billing = new BillingService({ db, verify: async () => ({ ok: false, reason: 'unused' }) });
    vi.spyOn(billing, 'settleSigned').mockRejectedValue(new Error('pool closed'));
    await handle.pump.stop();
    handle.server.closeAllConnections();
    await new Promise<void>((resolve) => handle.server.close(() => resolve()));
    await boot({ billing });
    const res = await post(withOrder(COMPLETED, 'o-x'));
    expect(res).toEqual({ status: 500, body: { error: 'pool closed', code: 'internal' } });
    expect((await webhookEventsForOrder(db, 'o-x'))[0]).toMatchObject({ outcome: 'rejected', detail: 'internal: pool closed' });
  });
});

describe('what never reaches the database', () => {
  it('NO SECRET CONFIGURED: 503, refused, nothing recorded — and the rest of billsvc still works', async () => {
    await handle.pump.stop();
    handle.server.closeAllConnections();
    await new Promise<void>((resolve) => handle.server.close(() => resolve()));
    await boot({ env: { BB_BILLING_DEV_STUB: '1' } });
    const res = await post(COMPLETED, 'ts=1;h1=' + 'a'.repeat(64));
    expect(res).toEqual({ status: 503, body: { error: 'paddle webhook not configured', code: 'not-configured' } });
    expect(await billingStore(db).webhookEvents.countDocuments()).toBe(0);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('BB_PADDLE_WEBHOOK_SECRET is not configured'));
    // The dev stub path is untouched.
    const order = await fetch(`${baseUrl}/order/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-key': KEY },
      body: JSON.stringify({ accountId: 'a', sku: 'bp.cannon', platform: 'dev' }),
    });
    const { payment } = (await order.json()) as { payment: { params: Record<string, string> } };
    const settled = await fetch(`${baseUrl}/webhook/dev`, { method: 'POST', body: JSON.stringify(payment.params) });
    expect(settled.status).toBe(200);
  });

  it('a bad signature is a 401, logged, and NOT written to the event log', async () => {
    const { id } = await newOrder();
    const res = await post(withOrder(COMPLETED, id), `ts=${Math.floor(clockMs / 1000)};h1=${'0'.repeat(64)}`);
    expect(res).toEqual({ status: 401, body: { error: 'invalid signature', code: 'signature-mismatch' } });
    expect(await billingStore(db).webhookEvents.countDocuments()).toBe(0);
    expect(await billingStore(db).orders.findOne({ _id: id })).toMatchObject({ state: 'created' });
  });

  it('a missing signature header is a 401 naming it', async () => {
    const res = await fetch(`${baseUrl}/webhook/paddle`, { method: 'POST', body: COMPLETED });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe('missing-header');
  });

  it('an oversized body is a 413 — there are no complete bytes to verify', async () => {
    const res = await post('x'.repeat(300 * 1024), 'ts=1;h1=' + 'a'.repeat(64));
    expect(res.status).toBe(413);
  });
});

describe('signed but not actionable', () => {
  it('a signed body that is not a Paddle event object is recorded as rejected', async () => {
    const res = await post('[1,2,3]');
    expect(res.status).toBe(400);
    const rows = await recentWebhookEvents(db, 10);
    expect(rows[0]).toMatchObject({ platform: 'paddle', outcome: 'rejected', eventType: 'unknown' });
    expect((await post('not json')).status).toBe(400);
  });

  it('another event type is recorded and answered 200 without acting', async () => {
    const raw = COMPLETED.replace('"transaction.completed"', '"transaction.paid"');
    const res = await post(raw);
    expect(res).toEqual({ status: 200, body: { ok: true, ignored: true, event: 'transaction.paid' } });
    expect((await recentWebhookEvents(db, 10))[0]).toMatchObject({ outcome: 'ignored', detail: "paddle event 'transaction.paid' is not acted on" });
  });
});

describe('refunds (ROADMAP 9.3)', () => {
  async function settled(): Promise<string> {
    const { id } = await newOrder();
    expect((await post(withOrder(COMPLETED, id))).status).toBe(200);
    await drain();
    pumpCalls = [];
    return id;
  }

  it('an approved refund revokes the entitlement AND files a review case with the money joined', async () => {
    const id = await settled();
    const res = await post(REFUND);
    expect(res).toEqual({ status: 200, body: { ok: true, orderId: id, revoked: true, filed: true } });

    const reversal = await billingStore(db).ledger.findOne({ _id: `reversal:paddle:${TXN}` });
    expect(reversal).toMatchObject({ kind: 'reversal', orderId: id, accountId: 'acc-1' });
    // The purchase ledger row is untouched — append-only.
    expect(await billingStore(db).ledger.findOne({ _id: `purchase:paddle:${TXN}` })).toMatchObject({ kind: 'purchase' });

    const [review] = await openReviews(db);
    expect(review).toMatchObject({ kind: 'refund', id: 'refund:paddle:adj_01hvgf2s84dr6reszzg29zbvcm', accountId: 'acc-1' });
    expect(review!.summary).toContain('296 USD');
    expect(review!.summary).toContain('Ladder/PvP history is not changed');
    expect(review!.evidence).toMatchObject({
      order: { id, listAmountCents: 1800, listCurrency: 'CNY', chargedAmountCents: 296, chargedCurrency: 'USD' },
      adjustment: { action: 'refund', type: 'full', amountCents: 296, currency: 'USD' },
    });

    expect((await webhookEventsForOrder(db, id)).map((e) => e.outcome).sort()).toEqual(['revoked', 'settled']);

    await drain();
    expect(pumpCalls).toHaveLength(1);
    expect(new URL(pumpCalls[0]!.url).pathname).toBe(REVOKE_PATH);
    expect(pumpCalls[0]!.body).toMatchObject({ accountId: 'acc-1', orderId: id, grants: [{ kind: 'blueprint', id: 'cannon' }] });
  });

  it('a retried refund notification changes nothing a second time', async () => {
    await settled();
    await post(REFUND);
    clockMs += 1000;
    const again = await post(REFUND);
    expect(again.body).toMatchObject({ revoked: false, filed: false });
    expect(await openReviews(db)).toHaveLength(1);
    expect(await billingStore(db).deliveries.countDocuments({ action: 'revoke' })).toBe(1);
  });

  it('a chargeback is revoked the same way', async () => {
    await settled();
    const res = await post(REFUND.replace('"action": "refund"', '"action": "chargeback"'));
    expect(res.body).toMatchObject({ revoked: true });
  });

  it('a REVERSED chargeback files a case and revokes / re-grants nothing', async () => {
    await settled();
    const res = await post(REFUND.replace('"action": "refund"', '"action": "chargeback_reverse"').replace('adj_01hvgf2s84dr6reszzg29zbvcm', 'adj_rev'));
    expect(res.body).toMatchObject({ revoked: false, filed: true });
    const [review] = await openReviews(db);
    expect(review!.summary).toContain('a human decides');
    expect(await billingStore(db).ledger.findOne({ _id: `reversal:paddle:${TXN}` })).toBeNull();
  });

  it.each([
    ['pending_approval', '"status": "pending_approval"', '"action": "refund"'],
    ['rejected', '"status": "rejected"', '"action": "refund"'],
    ['a chargeback warning', '"status": "approved"', '"action": "chargeback_warning"'],
    ['a credit', '"status": "approved"', '"action": "credit"'],
  ])('%s is recorded and NOT acted on', async (_l, status, action) => {
    await settled();
    const res = await post(REFUND.replace('"status": "approved"', status).replace('"action": "refund"', action));
    expect(res.body).toMatchObject({ ok: true, ignored: true });
    expect(await openReviews(db)).toEqual([]);
  });

  it('an adjustment for a transaction not settled here is a 404, so Paddle retries after the purchase lands', async () => {
    const res = await post(REFUND);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('unknown-transaction');
  });

  it('an adjustment with no transaction id is refused', async () => {
    const res = await post(REFUND.replace(`"transaction_id": "${TXN}"`, '"transaction_id": null'));
    expect(res.status).toBe(400);
  });

  it('adjustment.created with an auto-approved refund acts exactly like adjustment.updated', async () => {
    await settled();
    const res = await post(REFUND.replace('"adjustment.updated"', '"adjustment.created"'));
    expect(res.body).toMatchObject({ revoked: true });
  });

  it('a refund whose processing THROWS is a recorded 500', async () => {
    await settled();
    const spy = vi.spyOn(db.client, 'startSession').mockImplementation(() => {
      throw new Error('no sessions');
    });
    const res = await post(REFUND);
    spy.mockRestore();
    expect(res).toEqual({ status: 500, body: { error: 'no sessions', code: 'internal' } });
  });

  it('missing totals and type are tolerated — the case says "an unstated amount"', async () => {
    await settled();
    const bare = JSON.parse(REFUND) as { data: Record<string, unknown> };
    delete bare.data.totals;
    delete bare.data.type;
    delete bare.data.reason;
    delete bare.data.currency_code;
    const res = await post(JSON.stringify(bare));
    expect(res.body).toMatchObject({ revoked: true });
    const [review] = await openReviews(db);
    expect(review!.summary).toContain('an unstated amount');
  });
});
