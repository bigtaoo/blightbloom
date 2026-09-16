/**
 * The billing plane's SCHEMA on MongoDB (design/19-server-platform.md §4 and §7) — the
 * indexes and validators in `src/billing/schema.ts`, asserted against a real server.
 *
 * Every case here is written to FAIL if one option is deleted, because most of these options
 * are silently optional: an index without `unique` still indexes, a validator without
 * `required` still validates, and a suite that only writes well-formed documents through the
 * service is green with all of them gone. The mutants each case kills are named on it.
 *
 * The one to read first is 'orders.platformTxnId'. SQLite's UNIQUE treats every NULL as
 * distinct, so the old column let any number of unsettled orders coexist while making two
 * SETTLED orders sharing one platform transaction impossible. MongoDB's unique index treats
 * a MISSING field as ONE null value and admits exactly one such document — so the naive
 * translation of that column compiles, passes every sequential happy-path test, and rejects
 * the second player with an open checkout. Both halves of the old guarantee are asserted
 * below, and only a partial index satisfies both.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Db } from 'mongodb';
import { openTestMongo, type MongoTestContext } from './mongoHarness';
import { BILLING_COLLECTIONS, billingStore, ensureBillingIndexes } from '../src/billingDb';

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

/** Every index on one collection, keyed by name, so a case can assert an OPTION and not just
 *  that some index exists. */
async function indexes(name: string): Promise<Record<string, Record<string, unknown>>> {
  const list = (await db.collection(name).indexes()) as unknown as Record<string, unknown>[];
  return Object.fromEntries(list.map((i) => [String(i.name), i]));
}

const order = (id: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  _id: id,
  accountId: 'a1',
  sku: 'bp.cannon',
  platform: 'dev',
  amountCents: 1800,
  currency: 'CNY',
  state: 'created',
  createdAt: 1,
  ...over,
});

describe('ensureBillingIndexes', () => {
  it('creates exactly the six collections design/19 §4 and §7 specify, and no more', async () => {
    // Four for the money, two for the operations around it. `deliveries` is the outbox a
    // settlement writes inside its own transaction; `webhookEvents` and `reviewQueue` are
    // §7's operational pair — every callback rather than only the ones that settled, and the
    // one place a human is told to look.
    const names = (await db.listCollections().toArray()).map((c) => c.name).sort();
    expect(names).toEqual([...BILLING_COLLECTIONS].sort());
  });

  it('carries NONE of the accounts store\'s collections', async () => {
    // The logical isolation, asserted from the inside. A shared opener would show up here as
    // `accounts`/`sessions` appearing in the billing database.
    const names = (await db.listCollections().toArray()).map((c) => c.name);
    for (const accountCollection of ['accounts', 'sessions', 'ratings', 'metaState', 'entitlements']) {
      expect(names).not.toContain(accountCollection);
    }
  });

  it('is idempotent — running it again over a populated database changes nothing', async () => {
    // Every `main.ts` calls this at boot, which is what replaces a migration step. If a
    // second run threw (or dropped anything) the second deploy of the day would be the
    // outage.
    await billingStore(db).ledger.insertOne({
      _id: 'l1',
      accountId: 'a1',
      sku: 'bp.cannon',
      kind: 'purchase',
      ts: 1,
    });
    await ensureBillingIndexes(db);
    await ensureBillingIndexes(db);
    expect(await billingStore(db).ledger.countDocuments()).toBe(1);
  });
});

describe('orders.platformTxnId — the partial unique index', () => {
  it('makes two settled orders sharing one platform transaction impossible', async () => {
    // KILLS: deleting `unique: true`. Without it this insert succeeds and two orders claim
    // one payment — the exact guarantee the old `TEXT UNIQUE` column existed for.
    const orders = billingStore(db).orders;
    await orders.insertOne(order('o1', { state: 'settled', platformTxnId: 'txn-1', settledAt: 2 }) as never);
    await expect(
      orders.insertOne(order('o2', { state: 'settled', platformTxnId: 'txn-1', settledAt: 3 }) as never),
    ).rejects.toMatchObject({ code: 11000 });
    expect(await orders.countDocuments()).toBe(1);
  });

  it('but lets any number of UNSETTLED orders coexist, which a plain unique index would not', async () => {
    // KILLS: deleting `partialFilterExpression`. MongoDB treats the missing field as one
    // `null` and admits exactly ONE document carrying it, so without the filter the SECOND
    // order below is rejected with E11000 — on the payment path, for a player with two
    // abandoned checkouts. This is the difference from SQLite that the whole port turns on.
    const orders = billingStore(db).orders;
    for (const id of ['o1', 'o2', 'o3']) await orders.insertOne(order(id) as never);
    expect(await orders.countDocuments()).toBe(3);
  });

  it('holds both halves under CONCURRENT writers, not just sequential ones', async () => {
    // Sequential inserts pass against a schema whose uniqueness is enforced by application
    // code rather than by the index; simultaneous ones do not. Eight open checkouts all
    // land, and eight callbacks racing for one transaction id leave exactly one winner.
    const orders = billingStore(db).orders;
    const opened = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) => orders.insertOne(order(`open-${i}`) as never)),
    );
    expect(opened.filter((r) => r.status === 'fulfilled')).toHaveLength(8);

    const claimed = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) =>
        orders.insertOne(order(`settled-${i}`, { state: 'settled', platformTxnId: 'RACE', settledAt: 9 }) as never),
      ),
    );
    expect(claimed.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  it('declares the filter on `$type: string`, not on `$exists`', async () => {
    // Pinned as a specification rather than only as behaviour: `{ $exists: true }` would also
    // admit a hand-written `platformTxnId: null`, and a null that is IN the index re-creates
    // the one-null-document limit the filter exists to escape.
    const spec = (await indexes('orders')).orders_platform_txn;
    expect(spec).toMatchObject({ unique: true, partialFilterExpression: { platformTxnId: { $type: 'string' } } });
  });

  it('indexes the reads the plane actually makes', async () => {
    // Not correctness, but the three queries that run on every request path, so a rename
    // that orphans one is visible here rather than in a slow-query log nobody reads.
    expect(Object.keys(await indexes('orders'))).toEqual(
      expect.arrayContaining(['orders_account', 'orders_settled_window']),
    );
    expect(Object.keys(await indexes('ledger'))).toContain('ledger_account');
    expect(Object.keys(await indexes('deliveries'))).toContain('deliveries_pending');
    expect(Object.keys(await indexes('webhookEvents'))).toEqual(
      expect.arrayContaining(['webhook_events_order', 'webhook_events_seen']),
    );
    expect(Object.keys(await indexes('reviewQueue'))).toContain('review_queue_open');
  });
});

describe('the validators — the CHECK constraints, kept server-side', () => {
  it('refuses a receipt with no product, and accepts one that has it', async () => {
    // KILLS: dropping `product` from `receipts`' `required`. Found by a 2026-09-04 mutation
    // battery on the SQLite schema: relaxing the column to nullable survived all 211 tests,
    // because no test ever tried to write a receipt without one. It is rule 5's schema-level
    // half — a receipt that resolved to nothing is replayable against any SKU.
    //
    // The second half is what stops this case passing against a broken insert.
    const receipts = billingStore(db).receipts;
    await expect(
      receipts.insertOne({ _id: 'dev:r1', accountId: 'a1', platform: 'dev', raw: 'raw', verifiedAt: 1 } as never),
    ).rejects.toThrow();
    await expect(
      receipts.insertOne({
        _id: 'dev:r1',
        accountId: 'a1',
        platform: 'dev',
        product: 'bp.cannon',
        raw: 'raw',
        verifiedAt: 1,
      }),
    ).resolves.toBeTruthy();
  });

  it('refuses a ledger document with no sku or no kind — the audit minimum', async () => {
    // `source`/`kind` is what design/19 §2/§7 leans on to tell a paid grant from a
    // hand-issued one, and a ledger document naming neither the SKU nor the kind cannot be
    // reconciled or hand-corrected, which is the whole reason it is append-only.
    const ledger = billingStore(db).ledger;
    await expect(ledger.insertOne({ _id: 'l1', accountId: 'a1', kind: 'purchase', ts: 1 } as never)).rejects.toThrow();
    await expect(ledger.insertOne({ _id: 'l2', accountId: 'a1', sku: 'bp.cannon', ts: 1 } as never)).rejects.toThrow();
    await expect(
      ledger.insertOne({ _id: 'l3', accountId: 'a1', sku: 'bp.cannon', kind: 'purchase', ts: 1 }),
    ).resolves.toBeTruthy();
  });

  it('refuses an order with no state, amount or currency', async () => {
    const orders = billingStore(db).orders;
    for (const field of ['amountCents', 'currency', 'state']) {
      const doc = order(`o-${field}`);
      delete doc[field];
      await expect(orders.insertOne(doc as never), field).rejects.toThrow();
    }
    await expect(orders.insertOne(order('ok') as never)).resolves.toBeTruthy();
  });

  it('refuses a delivery state the pump has no branch for', async () => {
    // KILLS: relaxing `state` from an enum to `bsonType: 'string'`. `state` drives which
    // documents are retried, so a typo'd hand-fix that invented `'retry'` would make a paid
    // delivery invisible to the pump forever.
    const deliveries = billingStore(db).deliveries;
    const base = {
      accountId: 'a1',
      sku: 'bp.cannon',
      grantsJson: '[]',
      orderId: 'o1',
      receiptId: 'dev:r1',
      attempts: 0,
      createdAt: 1,
    };
    await expect(deliveries.insertOne({ _id: 'weird', ...base, state: 'retry' } as never)).rejects.toThrow();
    for (const state of ['pending', 'delivered', 'failed']) {
      await expect(deliveries.insertOne({ _id: `ok-${state}`, ...base, state }), state).resolves.toBeTruthy();
    }
  });

  it('refuses a delivery with no order or receipt behind it', async () => {
    // `entitlements`' own CHECK refuses a purchase-sourced grant with no order id, so a
    // delivery that could never satisfy it must not be writable here in the first place.
    const deliveries = billingStore(db).deliveries;
    await expect(
      deliveries.insertOne({
        _id: 'd1',
        accountId: 'a1',
        sku: 'bp.cannon',
        grantsJson: '[]',
        receiptId: 'dev:r1',
        state: 'pending',
        attempts: 0,
        createdAt: 1,
      } as never),
    ).rejects.toThrow();
  });

  it('refuses a review kind and a review state the queue does not know', async () => {
    // KILLS: relaxing either enum. This collection is edited at a prompt (design/19 §8
    // declines to build an admin service), and a typo'd kind there must fail rather than land
    // where neither producer will ever look at it again.
    const reviews = billingStore(db).reviewQueue;
    const base = {
      accountId: 'a1',
      dayKey: null,
      summary: 's',
      evidenceJson: '{}',
      createdAt: 1,
      reviewedAt: null,
      note: null,
    };
    await expect(
      reviews.insertOne({ _id: 'r1', ...base, kind: 'wat', state: 'open' } as never),
    ).rejects.toThrow();
    await expect(
      reviews.insertOne({ _id: 'r2', ...base, kind: 'grant-anomaly', state: 'in-progress' } as never),
    ).rejects.toThrow();
    await expect(reviews.insertOne({ _id: 'r3', ...base, kind: 'grant-anomaly', state: 'open' })).resolves.toBeTruthy();
    await expect(
      reviews.insertOne({ _id: 'r4', ...base, kind: 'money-taken-nothing-granted', state: 'reviewed' }),
    ).resolves.toBeTruthy();
  });

  it('binds a writer that never went through this code — which is the point of a validator', async () => {
    // The distinction between "a rule this module follows" and "a rule the server enforces".
    // Everything above inserts through the driver directly rather than through the service,
    // so an operator at a `mongosh` prompt is bound by exactly the same refusals. Stated once
    // here as a command, because that is the posture design/19 §8 plans corrections under.
    // A raw command reports the refusal in `writeErrors` rather than by rejecting, which is
    // exactly what an operator sees at the prompt.
    const res = (await db.command({ insert: 'deliveries', documents: [{ _id: 'hand', state: 'retry' }] })) as {
      n: number;
      writeErrors?: { errmsg: string }[];
    };
    expect(res.n).toBe(0);
    expect(res.writeErrors?.[0]?.errmsg).toContain('failed validation');
    expect(await billingStore(db).deliveries.countDocuments()).toBe(0);
  });
});
