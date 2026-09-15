/**
 * The MongoDB behaviours this port's design DEPENDS on, pinned against the real server.
 *
 * Not a test of our code. Every assertion here is about mongod itself, and the file exists
 * because four of this server's correctness properties were inherited from `node:sqlite`'s
 * semantics and had to be re-bought under different ones. Each of them is a place where the
 * naive translation compiles, passes a hand-written fake, and is wrong:
 *
 *  1. SQLite's UNIQUE treats every NULL as distinct; MongoDB's treats a missing field as
 *     one null and admits ONE such document. `orders.platform_txn_id` depended on the
 *     former to let unsettled orders coexist.
 *  2. `INSERT … ON CONFLICT DO NOTHING` + `changes()` was the exactly-once CLAIM behind
 *     both rating settlement and billing delivery. Its replacement has to be equally
 *     atomic — never a read followed by a write.
 *  3. `BEGIN IMMEDIATE` … `ROLLBACK` has to actually discard, across collections.
 *  4. The old stores were four FILES; they are four databases now, and a transaction has
 *     to be able to span them or the outbox's sibling writes lose their atomicity.
 *
 * A driver upgrade or a server-version bump that changes any of these turns this file red
 * with the reason attached, instead of turning a payment path red in production.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openTestMongo, type MongoTestContext } from './mongoHarness';

let ctx: MongoTestContext;
beforeEach(async () => { ctx = await openTestMongo(); });
afterEach(async () => { await ctx.dispose(); });

describe('unique indexes and absent fields', () => {
  it('REJECTS a second document missing the indexed field under a plain unique index', async () => {
    // The trap. This is the assertion that makes the naive translation of
    // `platform_txn_id TEXT UNIQUE` a bug rather than a style choice.
    const orders = ctx.db('billing').collection('naive');
    await orders.createIndex({ platformTxnId: 1 }, { unique: true });
    await orders.insertOne({ _id: 'order-1' as never });
    await expect(orders.insertOne({ _id: 'order-2' as never })).rejects.toMatchObject({ code: 11000 });
  });

  it('admits any number of them under a partial index, while still refusing a real duplicate', async () => {
    const orders = ctx.db('billing').collection('partial');
    await orders.createIndex(
      { platformTxnId: 1 },
      { unique: true, partialFilterExpression: { platformTxnId: { $type: 'string' } } },
    );
    await orders.insertOne({ _id: 'order-1' as never });
    await orders.insertOne({ _id: 'order-2' as never });
    await orders.insertOne({ _id: 'order-3' as never, platformTxnId: 'txn-A' });
    // Two settled orders claiming one platform payment stays impossible — the constraint
    // the partial index exists to preserve, not merely to relax.
    await expect(orders.insertOne({ _id: 'order-4' as never, platformTxnId: 'txn-A' })).rejects.toMatchObject({
      code: 11000,
    });
    expect(await orders.countDocuments()).toBe(3);
  });
});

describe('the exactly-once claim', () => {
  it('reports the insert exactly once across concurrent claimants', async () => {
    const claims = ctx.db('accounts').collection('ratingReports');
    const claim = async (key: string): Promise<boolean> => {
      const r = await claims.updateOne({ _id: key as never }, { $setOnInsert: { appliedAt: 1 } }, { upsert: true });
      return r.upsertedCount === 1;
    };
    // Concurrent, not sequential: a SELECT-then-INSERT implementation passes the sequential
    // version of this test and fails this one, which is the whole distinction design/19 §4
    // AMENDMENT 2 is about.
    const results = await Promise.all(Array.from({ length: 8 }, () => claim('room-1:digest')));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await claims.countDocuments()).toBe(1);
  });
});

describe('transactions', () => {
  it('discards every write when the body throws', async () => {
    const client = ctx.db('billing').client;
    const orders = ctx.db('billing').collection('orders');
    const ledger = ctx.db('billing').collection('ledger');
    await orders.insertOne({ _id: 'seed' as never }); // force the collections to exist
    await ledger.insertOne({ _id: 'seed' as never });

    const session = client.startSession();
    await expect(
      session.withTransaction(async () => {
        await orders.insertOne({ _id: 'o1' as never }, { session });
        await ledger.insertOne({ _id: 'l1' as never }, { session });
        throw new Error('settlement failed after both writes');
      }),
    ).rejects.toThrow('settlement failed');
    await session.endSession();

    expect(await orders.countDocuments({ _id: 'o1' as never })).toBe(0);
    expect(await ledger.countDocuments({ _id: 'l1' as never })).toBe(0);
  });

  it('spans two logical stores, so the four-database split costs no atomicity', async () => {
    const client = ctx.db('billing').client;
    const billing = ctx.db('billing').collection('deliveries');
    const accounts = ctx.db('accounts').collection('entitlements');
    await billing.insertOne({ _id: 'seed' as never });
    await accounts.insertOne({ _id: 'seed' as never });

    const session = client.startSession();
    await session.withTransaction(async () => {
      await billing.insertOne({ _id: 'd1' as never }, { session });
      await accounts.insertOne({ _id: 'e1' as never }, { session });
    });
    await session.endSession();

    expect(await billing.countDocuments({ _id: 'd1' as never })).toBe(1);
    expect(await accounts.countDocuments({ _id: 'e1' as never })).toBe(1);
  });
});
