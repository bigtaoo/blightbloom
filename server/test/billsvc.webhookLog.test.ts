/**
 * `billsvc/webhookLog.ts` — design/19 §7's "log every webhook event, not just the successful
 * one" (ROADMAP 8.5). The unit half; `billsvc.webhookEvents.http.test.ts` drives the same
 * module through the real route, because the branches that matter most are the ones that never
 * reach `settle` at all.
 *
 * The cases worth reading first:
 *
 *   'a redelivery upserts onto its own row' is the whole reason the key exists. Platform
 *   callbacks are at-least-once, and an append-only log of them is five near-identical rows an
 *   operator has to reconcile by eye.
 *
 *   'two unparsable payloads do not collapse onto one row' is the case a naive
 *   `${txnId}:${eventType}` key gets wrong — and it gets it wrong for exactly the callbacks
 *   whose evidence is worth the most.
 *
 *   'counts a redelivery whose body CHANGED' is the forgery shape design/19 §4's AMENDMENT 1
 *   closes on the settlement path, seen from the logging side.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Db } from 'mongodb';
import { ensureBillingIndexes } from '../src/billingDb';
import { openTestMongo, type MongoTestContext } from './mongoHarness';
import {
  ORDER_KEY_PREFIX,
  RAW_KEY_PREFIX,
  recentWebhookEvents,
  recordWebhookEvent,
  webhookEventById,
  webhookEventKey,
  webhookEventType,
  webhookEventsForOrder,
  type WebhookEventInput,
} from '../src/billsvc/webhookLog';

let ctx: MongoTestContext;
let db: Db;

beforeEach(async () => {
  ctx = await openTestMongo();
  db = ctx.db('billing');
  await ensureBillingIndexes(db);
});
afterEach(async () => {
  await ctx.dispose();
});

function event(over: Partial<WebhookEventInput> = {}): WebhookEventInput {
  return {
    platform: 'dev',
    orderId: 'o-1',
    txnId: 'txn-1',
    eventType: 'purchase',
    outcome: 'settled',
    detail: null,
    raw: '{"orderId":"o-1","txnId":"txn-1"}',
    ts: 1_000,
    ...over,
  };
}

describe('webhookEventType', () => {
  it('treats an ABSENT event field as a purchase', async () => {
    // Every success callback in this project's shape omits it, and `server.ts` has always read
    // it that way. Refusing one for lacking a field it never had would break all five
    // platforms at once.
    expect(webhookEventType(undefined)).toBe('purchase');
    expect(webhookEventType(null)).toBe('purchase');
    expect(webhookEventType('')).toBe('purchase');
    expect(webhookEventType('   ')).toBe('purchase');
  });

  it('recognises the three named types, case- and whitespace-insensitively', async () => {
    expect(webhookEventType('purchase')).toBe('purchase');
    expect(webhookEventType('failed')).toBe('failed');
    expect(webhookEventType('cancelled')).toBe('cancelled');
    expect(webhookEventType(' FAILED ')).toBe('failed');
  });

  it('narrows ANYTHING else to unknown, including a non-string', async () => {
    // The point of the type existing at all: before it, an unrecognised string fell through
    // into `settle`, so a `refunded` callback would have been treated as a purchase.
    expect(webhookEventType('refunded')).toBe('unknown');
    expect(webhookEventType('chargeback')).toBe('unknown');
    expect(webhookEventType('canceled')).toBe('unknown'); // one 'l' — a real platform spelling
    expect(webhookEventType(42)).toBe('unknown');
    expect(webhookEventType({ event: 'purchase' })).toBe('unknown');
  });
});

describe('webhookEventKey', () => {
  it('is `${txnId}:${eventType}` when the body carries a transaction id', async () => {
    expect(webhookEventKey({ txnId: 'txn-9', orderId: 'o-1', raw: '{}', eventType: 'failed' })).toBe('txn-9:failed');
  });

  it('falls back to the merchant order id, marked as such', async () => {
    const key = webhookEventKey({ txnId: '', orderId: 'o-7', raw: '{}', eventType: 'cancelled' });
    expect(key).toBe(`${ORDER_KEY_PREFIX}o-7:cancelled`);
    // Prefixed rather than bare, so the three key shapes are distinguishable in the table — a
    // bare 'o-7:cancelled' would be indistinguishable from a platform whose txn ids look like
    // order ids.
    expect(key.startsWith(ORDER_KEY_PREFIX)).toBe(true);
  });

  it('falls back to a hash of the raw bytes when the body names neither', async () => {
    const key = webhookEventKey({ raw: 'not json at all', eventType: 'purchase' });
    expect(key).toMatch(new RegExp(`^${RAW_KEY_PREFIX}[0-9a-f]{16}:purchase$`));
  });

  it('gives the SAME hash key to a byte-identical redelivery and a different one otherwise', async () => {
    // This is what makes the hash a key rather than a giving-up value: a platform retrying an
    // unparsable body repeats the same bytes, so the retry lands on the row it already wrote.
    const a = webhookEventKey({ raw: 'garbage', eventType: 'purchase' });
    const b = webhookEventKey({ raw: 'garbage', eventType: 'purchase' });
    const c = webhookEventKey({ raw: 'garbage2', eventType: 'purchase' });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('separates the same transaction by event type', async () => {
    // One payment can legitimately produce a purchase AND a later cancel. They are two rows.
    const purchase = webhookEventKey({ txnId: 't', raw: '{}', eventType: 'purchase' });
    const cancelled = webhookEventKey({ txnId: 't', raw: '{}', eventType: 'cancelled' });
    expect(purchase).not.toBe(cancelled);
  });

  it('treats a whitespace-only txn id as absent', async () => {
    expect(webhookEventKey({ txnId: '   ', orderId: 'o-2', raw: '{}', eventType: 'purchase' })).toBe(
      `${ORDER_KEY_PREFIX}o-2:purchase`,
    );
  });
});

describe('recordWebhookEvent', () => {
  it('writes the raw payload verbatim, which is the whole reason the table exists', async () => {
    const raw = '{"orderId":"o-1",  "txnId":"txn-1", "junk": [1,2,3]}';
    const id = await recordWebhookEvent(db, event({ raw }));
    const row = (await webhookEventById(db, id))!;
    expect(row.raw).toBe(raw);
    expect(row.seenCount).toBe(1);
    expect(row.divergences).toBe(0);
    expect(row.firstSeenAt).toBe(1_000);
    expect(row.lastSeenAt).toBe(1_000);
  });

  it('a redelivery upserts onto its own row rather than appending a second', async () => {
    const id = await recordWebhookEvent(db, event({ ts: 1_000 }));
    await recordWebhookEvent(db, event({ ts: 2_000 }));
    await recordWebhookEvent(db, event({ ts: 3_000 }));
    const row = (await webhookEventById(db, id))!;
    expect(row.seenCount).toBe(3);
    expect(row.firstSeenAt).toBe(1_000); // when it FIRST arrived — never moved
    expect(row.lastSeenAt).toBe(3_000);
    expect(await recentWebhookEvents(db, 10)).toHaveLength(1);
  });

  it('keeps the FIRST raw body and overwrites the LATEST outcome', async () => {
    // Two different rules on purpose. The body is evidence of what the platform sent, so a
    // later call must not be able to erase it; the outcome is what the account state now
    // reflects, so a stale one would mislead in exactly the situation this row is read in.
    const id = await recordWebhookEvent(db, event({ raw: '{"first":true}', outcome: 'settled', detail: null }));
    await recordWebhookEvent(db, event({ raw: '{"first":true}', outcome: 'already-delivered', detail: 'already-delivered' }));
    const row = (await webhookEventById(db, id))!;
    expect(row.raw).toBe('{"first":true}');
    expect(row.outcome).toBe('already-delivered');
    expect(row.detail).toBe('already-delivered');
  });

  it('counts a redelivery whose body CHANGED under the same key', async () => {
    // Somebody varying fields under a key they do not own. Zero is the normal answer, so a
    // non-zero count is the signal — the same forgery shape design/19 §4's AMENDMENT 1 had to
    // close on the settlement path, observed from here.
    const id = await recordWebhookEvent(db, event({ raw: '{"amount":100}' }));
    await recordWebhookEvent(db, event({ raw: '{"amount":1}' }));
    await recordWebhookEvent(db, event({ raw: '{"amount":1}' }));
    const row = (await webhookEventById(db, id))!;
    expect(row.seenCount).toBe(3);
    // Two divergences, not one: BOTH later bodies differ from the stored first one. The count
    // is "how many arrivals disagreed", not "how many distinct bodies".
    expect(row.divergences).toBe(2);
    expect(row.raw).toBe('{"amount":100}');
  });

  it('two unparsable payloads do not collapse onto one row', async () => {
    // The case a naive `${txnId}:${eventType}` key gets wrong: with no txn id every malformed
    // callback would share the key ':purchase' and overwrite the last one's evidence.
    const a = await recordWebhookEvent(
      db,
      event({ orderId: '', txnId: '', raw: 'wat', outcome: 'rejected', detail: 'unparsable' }),
    );
    const b = await recordWebhookEvent(
      db,
      event({ orderId: '', txnId: '', raw: 'wat?!', outcome: 'rejected', detail: 'unparsable' }),
    );
    expect(a).not.toBe(b);
    expect(await recentWebhookEvents(db, 10)).toHaveLength(2);
    expect((await webhookEventById(db, a))!.raw).toBe('wat');
    expect((await webhookEventById(db, b))!.raw).toBe('wat?!');
  });

  it('stores an absent order id and txn id as NULL, not as an empty string', async () => {
    // So a query for "the callbacks that named no order" means what it says, and two callbacks
    // that named nothing are not joined to each other by a shared ''. Stored as an explicit
    // `null` rather than left absent, which is why `webhookEventsForOrder` can filter on
    // equality without an absent field quietly matching.
    const id = await recordWebhookEvent(db, event({ orderId: '  ', txnId: undefined, raw: 'x' }));
    const row = (await webhookEventById(db, id))!;
    expect(row.orderId).toBeNull();
    expect(row.txnId).toBeNull();
  });

  it('returns null for an id nobody recorded', async () => {
    expect(await webhookEventById(db, 'nope:purchase')).toBeNull();
  });
});

describe('the support reads', () => {
  it('webhookEventsForOrder lists one order\'s events oldest first', async () => {
    await recordWebhookEvent(db, event({ orderId: 'o-1', txnId: 't-1', ts: 3_000, eventType: 'cancelled' }));
    await recordWebhookEvent(db, event({ orderId: 'o-1', txnId: 't-1', ts: 1_000 }));
    await recordWebhookEvent(db, event({ orderId: 'o-2', txnId: 't-2', ts: 2_000 }));
    const rows = await webhookEventsForOrder(db, 'o-1');
    expect(rows.map((r) => r.eventType)).toEqual(['purchase', 'cancelled']);
    expect(rows.map((r) => r.firstSeenAt)).toEqual([1_000, 3_000]);
  });

  it('webhookEventsForOrder finds nothing for an order that was never named', async () => {
    await recordWebhookEvent(db, event({ orderId: '', txnId: '', raw: 'orphan' }));
    expect(await webhookEventsForOrder(db, 'o-1')).toEqual([]);
    // ...but the orphan is still recorded, and `recentWebhookEvents` is what finds it.
    expect(await recentWebhookEvents(db, 10)).toHaveLength(1);
  });

  it('recentWebhookEvents is most-recently-seen first and honours its limit', async () => {
    await recordWebhookEvent(db, event({ txnId: 't-1', ts: 1_000 }));
    await recordWebhookEvent(db, event({ txnId: 't-2', ts: 3_000 }));
    await recordWebhookEvent(db, event({ txnId: 't-3', ts: 2_000 }));
    expect((await recentWebhookEvents(db, 10)).map((r) => r.txnId)).toEqual(['t-2', 't-3', 't-1']);
    expect((await recentWebhookEvents(db, 2)).map((r) => r.txnId)).toEqual(['t-2', 't-3']);
  });

  it('orders by LAST seen, so a redelivered old event rises', async () => {
    // The ordering that matters for an operator sweeping the table: a payment from yesterday
    // that the platform is still retrying is the interesting one, not the newest first arrival.
    await recordWebhookEvent(db, event({ txnId: 'old', ts: 1_000 }));
    await recordWebhookEvent(db, event({ txnId: 'new', ts: 2_000 }));
    await recordWebhookEvent(db, event({ txnId: 'old', ts: 3_000 }));
    expect((await recentWebhookEvents(db, 10)).map((r) => r.txnId)).toEqual(['old', 'new']);
  });
});
