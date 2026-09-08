/**
 * The webhook event log, driven through the REAL route (design/19 §7, ROADMAP 8.5).
 * `billsvc.webhookLog.test.ts` covers the module; this file covers the thing that module was
 * built for, which only exists at this layer: EVERY branch of `POST /webhook/:platform` leaves
 * a row, including the several that never reach `settle` and therefore cannot be reached from
 * a `BillingService` test at all.
 *
 * The cases worth reading first:
 *
 *   'an unknown event type is recorded and NOT settled' is a behaviour CHANGE, not just a new
 *   row. Before this pass an unrecognised `event` string fell through into `settle`, so a
 *   platform sending `refunded` would have had it treated as a purchase callback.
 *
 *   'records a body that is not JSON at all' is the payload whose bytes are worth the most and
 *   the one a parsed-body log cannot see.
 *
 *   'a redelivery of a settled purchase updates ONE row' is the at-least-once contract at this
 *   layer, with the outcome moving from settled to already-delivered.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { DatabaseSync } from 'node:sqlite';
import { openBillingDb } from '../src/billingDb';
import { createBillsvcServer } from '../src/billsvc/server';
import { createInternalVerifier } from '../src/internalAuth';
import { recentWebhookEvents, webhookEventsForOrder } from '../src/billsvc/webhookLog';

const KEY = 'test-internal-key';
const DEV_ENV = { BB_BILLING_DEV_STUB: '1' };
const SKU = 'bp.cannon';

let baseUrl: string;
let db: DatabaseSync;
let close: () => Promise<void> = async () => {};
let clock = 10_000;

beforeEach(async () => {
  clock = 10_000;
  db = openBillingDb(':memory:');
  const { server, pump } = createBillsvcServer({
    db,
    env: DEV_ENV,
    internalAuth: createInternalVerifier([{ caller: 'matchsvc', key: KEY }]),
    nowMs: () => (clock += 1),
    // The pump must not reach a real control plane from a unit test. A refused connection is
    // a DEFERRED delivery (the row stays pending), so it changes nothing this file asserts.
    pump: { fetchImpl: async () => new Response('', { status: 503 }), retry: { attempts: 1 } },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let shutDown = false;
  close = () =>
    new Promise<void>((resolve) => {
      if (shutDown) return resolve();
      shutDown = true;
      void pump.stop().then(() => {
        server.closeAllConnections();
        server.close(() => {
          db.close();
          resolve();
        });
      });
    });
});

afterEach(async () => {
  await close();
});

/** POSTs a RAW string body, so a payload that is not JSON can be sent at all. */
async function postRaw(path: string, raw: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: raw,
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

const postJson = (path: string, body: unknown) => postRaw(path, JSON.stringify(body));

async function newOrder(): Promise<string> {
  const res = await fetch(`${baseUrl}/order/create`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-key': KEY },
    body: JSON.stringify({ accountId: 'acc-1', sku: SKU, platform: 'dev' }),
  });
  const body = (await res.json()) as { order: { id: string } };
  return body.order.id;
}

describe('every webhook event is recorded', () => {
  it('records a SETTLED purchase with the raw payload it arrived as', async () => {
    const orderId = await newOrder();
    const raw = JSON.stringify({ orderId, receipt: `product:${SKU}`, txnId: 'txn-a' });
    const res = await postRaw('/webhook/dev', raw);
    expect(res.status).toBe(200);
    expect(res.body.delivered).toBe(true);

    const rows = webhookEventsForOrder(db, orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe('txn-a:purchase');
    expect(rows[0]!.outcome).toBe('settled');
    expect(rows[0]!.eventType).toBe('purchase');
    expect(rows[0]!.platform).toBe('dev');
    expect(rows[0]!.raw).toBe(raw);
    expect(rows[0]!.detail).toBeNull();
  });

  it('a redelivery of a settled purchase updates ONE row and moves its outcome', async () => {
    const orderId = await newOrder();
    const body = { orderId, receipt: `product:${SKU}`, txnId: 'txn-b' };
    const first = await postJson('/webhook/dev', body);
    const second = await postJson('/webhook/dev', body);
    expect(first.body.delivered).toBe(true);
    expect(second.body.delivered).toBe(false);
    expect(second.body.note).toBe('already-delivered');

    const rows = webhookEventsForOrder(db, orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.seenCount).toBe(2);
    expect(rows[0]!.outcome).toBe('already-delivered');
    expect(rows[0]!.detail).toBe('already-delivered');
    expect(rows[0]!.divergences).toBe(0);
  });

  it('records a REFUSED settlement with its rejection code — the "why did my payment not go through" row', async () => {
    // Before this pass a refusal answered 400 and left nothing behind anywhere. This row and
    // its `detail` are now the entire evidence trail for that question.
    const orderId = await newOrder();
    const res = await postJson('/webhook/dev', { orderId, receipt: 'product:bp.seeker', txnId: 'txn-c' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('product-mismatch');

    const rows = webhookEventsForOrder(db, orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.outcome).toBe('rejected');
    expect(rows[0]!.detail).toContain('product-mismatch');
    expect(rows[0]!.detail).toContain('bp.seeker');
  });

  it('records a settlement refused for an UNKNOWN order, which has no order row to hang off', async () => {
    const res = await postJson('/webhook/dev', { orderId: 'ghost', receipt: `product:${SKU}`, txnId: 'txn-d' });
    expect(res.status).toBe(404);
    // Recorded against the order id the CALLBACK named, even though no such order exists —
    // that is precisely the case support needs to see, because the alternative explanation is
    // that the callback was never received at all.
    const rows = webhookEventsForOrder(db, 'ghost');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.outcome).toBe('rejected');
    expect(rows[0]!.detail).toContain('unknown-order');
  });

  it('records a verification failure — the branch with no local row of any kind', async () => {
    const orderId = await newOrder();
    const res = await postJson('/webhook/dev', { orderId, receipt: 'not-a-stub-receipt', txnId: 'txn-e' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('verification-failed');
    expect(webhookEventsForOrder(db, orderId)[0]!.detail).toContain('verification-failed');
  });
});

describe('the non-settling branches', () => {
  it('records a CANCELLED event that closed an open order', async () => {
    const orderId = await newOrder();
    const res = await postJson('/webhook/dev', { orderId, txnId: 'txn-f', event: 'cancelled' });
    expect(res.status).toBe(200);
    expect(res.body.changed).toBe(true);

    const rows = webhookEventsForOrder(db, orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe('txn-f:cancelled');
    expect(rows[0]!.eventType).toBe('cancelled');
    expect(rows[0]!.outcome).toBe('marked-failed');
  });

  it('distinguishes a REDELIVERED cancel from the one that actually closed the order', async () => {
    // `changed: false` is a different fact from having just closed it, and an operator reading
    // the row to explain a support case needs to be able to tell them apart.
    const orderId = await newOrder();
    await postJson('/webhook/dev', { orderId, txnId: 'txn-g', event: 'failed' });
    await postJson('/webhook/dev', { orderId, txnId: 'txn-g', event: 'failed' });
    const rows = webhookEventsForOrder(db, orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.seenCount).toBe(2);
    expect(rows[0]!.outcome).toBe('no-change');
  });

  it('records a cancel that named no order at all', async () => {
    const res = await postJson('/webhook/dev', { txnId: 'txn-h', event: 'cancelled' });
    expect(res.status).toBe(400);
    const rows = recentWebhookEvents(db, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.orderId).toBeNull();
    expect(rows[0]!.outcome).toBe('rejected');
    expect(rows[0]!.detail).toBe('orderId required');
  });

  it('an unknown event type is recorded and NOT settled', async () => {
    // The behaviour change. `refunded` used to fall through into `settle` and, with a valid
    // stub receipt, would have DELIVERED. Now it is inert and visible.
    const orderId = await newOrder();
    const res = await postJson('/webhook/dev', {
      orderId,
      receipt: `product:${SKU}`,
      txnId: 'txn-i',
      event: 'refunded',
    });
    expect(res.status).toBe(200);
    expect(res.body.ignored).toBe(true);
    expect(res.body.event).toBe('refunded');

    const rows = webhookEventsForOrder(db, orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.eventType).toBe('unknown');
    expect(rows[0]!.outcome).toBe('ignored');
    expect(rows[0]!.detail).toContain('refunded');

    // And, the half that matters: nothing was delivered and the order is still open.
    const order = await fetch(`${baseUrl}/order/${orderId}`, { headers: { 'x-internal-key': KEY } });
    expect(((await order.json()) as { order: { state: string } }).order.state).toBe('created');
    expect(db.prepare('SELECT COUNT(*) AS n FROM ledger').get()).toEqual({ n: 0 });
  });

  it('an unknown event type that is not even a string is recorded, not crashed on', async () => {
    const orderId = await newOrder();
    const res = await postJson('/webhook/dev', { orderId, txnId: 'txn-j', event: { nested: true } });
    expect(res.status).toBe(200);
    expect(webhookEventsForOrder(db, orderId)[0]!.eventType).toBe('unknown');
  });
});

describe('payloads that never parsed', () => {
  it('records a body that is not JSON at all, with its bytes', async () => {
    // The route treats an unparsable body as `{}`, so before this table the request produced a
    // 400 and vanished. The raw column is the only place the actual bytes ever existed.
    const raw = 'this is not json {{{';
    const res = await postRaw('/webhook/wechat', raw);
    expect(res.status).toBe(400);

    const rows = recentWebhookEvents(db, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.raw).toBe(raw);
    expect(rows[0]!.platform).toBe('wechat');
    expect(rows[0]!.orderId).toBeNull();
    expect(rows[0]!.txnId).toBeNull();
    // Keyed by a hash of those bytes, so the next unparsable body gets its own row instead of
    // overwriting this one.
    expect(rows[0]!.id).toMatch(/^raw:[0-9a-f]{16}:purchase$/);
  });

  it('two different unparsable bodies produce two rows; a repeat of one produces a redelivery', async () => {
    await postRaw('/webhook/dev', 'garbage-a');
    await postRaw('/webhook/dev', 'garbage-b');
    await postRaw('/webhook/dev', 'garbage-a');
    const rows = recentWebhookEvents(db, 10);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.raw === 'garbage-a')!.seenCount).toBe(2);
    expect(rows.find((r) => r.raw === 'garbage-b')!.seenCount).toBe(1);
  });

  it('an OVERSIZED body is recorded as discarded rather than as a truncated prefix', async () => {
    // The route drops everything past 256 KB, so there is no verbatim payload to keep. Saying
    // that is the honest row; storing the first 256 KB would later read like the whole thing.
    const raw = `{"orderId":"o","pad":"${'x'.repeat(300 * 1024)}"}`;
    const res = await postRaw('/webhook/dev', raw);
    expect(res.status).toBe(400);
    const rows = recentWebhookEvents(db, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.raw).toMatch(/^<oversized body discarded: >\d+ bytes>$/);
    expect(rows[0]!.raw.length).toBeLessThan(100);
  });

  it('an unknown PLATFORM writes no row at all', async () => {
    // Deliberate: `/webhook/nonsense` is a routing miss, not a payment event, and recording it
    // would let anyone with the public URL append to an evidence table.
    const res = await postJson('/webhook/nonsense', { orderId: 'o', txnId: 't' });
    expect(res.status).toBe(404);
    expect(recentWebhookEvents(db, 10)).toEqual([]);
  });
});
