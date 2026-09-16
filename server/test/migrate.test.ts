/**
 * The one-time migration off SQLite (stage 7), against a real cluster and the shipped
 * indexes and validators.
 *
 * ## Why this is a real mongod and not a fake target
 *
 * Every bug worth catching here is a bug the SERVER would catch and our code would not. The
 * whole absent-vs-null rule exists because a partial unique index treats one stored `null` as
 * a value and admits exactly one such document; the `entitlements` validator refuses a
 * purchase-sourced grant with no order id; two documents whose `_id` collides silently become
 * one. A target that recorded calls would agree with the mapping and prove none of it.
 *
 * ## Why the SQLite side is injected
 *
 * `LegacySource` is an interface, so this file drives the whole migration — every mapping,
 * the refusal, the counts — with row objects, and `node:sqlite` never enters the suite. That
 * is not only tidiness: `deploy.bundle.test.ts` asserts no bundle carries the builtin, and a
 * test importing it would be one more place for it to come back.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ObjectId, type Db } from 'mongodb';
import { accountsStore, ensureAccountsIndexes } from '../src/db';
import { BILLING_COLLECTIONS, ensureBillingIndexes } from '../src/billingDb';
import {
  DAILY_ACTIVE_COLLECTION,
  DAILY_ROLLUP_COLLECTION,
  EVENTS_COLLECTION,
  ensureAnalyticsIndexes,
} from '../src/analytics/db';
import { FLAGS_COLLECTION, ensureOpsIndexes } from '../src/flags/store';
import { TABLES, isMigratedId, legacyObjectId, parseProps } from '../src/migrate/tables';
import {
  MARKER_COLLECTION,
  MARKER_ID,
  MigrationRefused,
  formatResult,
  hasForeignDocuments,
  migrateAll,
  migrationComplete,
  readMarker,
  type LegacySource,
} from '../src/migrate/run';
import { openTestMongo, type MongoTestContext } from './mongoHarness';

let ctx: MongoTestContext;

beforeEach(async () => {
  ctx = await openTestMongo();
  await ensureAccountsIndexes(ctx.db('accounts'));
  await ensureBillingIndexes(ctx.db('billing'));
  await ensureAnalyticsIndexes(ctx.db('analytics'));
  await ensureOpsIndexes(ctx.db('ops'));
});
afterEach(async () => {
  await ctx.dispose();
});

const target = { db: (store: 'accounts' | 'billing' | 'analytics' | 'ops'): Db => ctx.db(store) };

/**
 * A live entitlement, as the RUNNING SERVER writes one.
 *
 * Every field the collection validator requires, because a document that fails validation is
 * not the state these cases are about — they are about a document the cutover produced, and
 * one the server could not have written proves nothing about a re-run after it.
 */
const LIVE_ENTITLEMENT = { accountId: 'live', sku: 'x', source: 'grant', grantedAt: 1 };

/** The error a promise rejected with — see `adminsvc.dbs.test.ts` for why not `.catch`. */
async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error('expected a rejection, got a resolved promise');
}

/** A source holding exactly the tables named; everything else answers "not there". */
function sourceOf(tables: Record<string, Record<string, unknown>[]>): LegacySource {
  return { rows: (table) => tables[table] ?? null };
}

const ACCOUNT = {
  id: 'acc_zoe',
  username: 'zoe',
  password_hash: 'h',
  provider: 'local',
  provider_id: null,
  created_at: 1_757_000_000_000,
  display_name: null,
};

const ORDER = {
  id: 'ord_1',
  account_id: 'acc_zoe',
  sku: 'bp.cannon',
  platform: 'paddle',
  amount_cents: 499,
  currency: 'EUR',
  state: 'pending',
  platform_txn_id: null,
  created_at: 1,
  settled_at: null,
};

describe('legacyObjectId', () => {
  it('embeds the row timestamp, so "oldest grant first" survives the integer key', () => {
    // `db.ts`'s reason for `entitlements._id` being an ObjectId at all: it sorts by its
    // embedded creation time, which is what replaced ordering by an autoincrementing id.
    const early = legacyObjectId(Date.UTC(2026, 0, 1), 1);
    const late = legacyObjectId(Date.UTC(2026, 5, 1), 2);
    expect(early.getTimestamp().getTime()).toBe(Date.UTC(2026, 0, 1));
    expect([late, early].sort((a, b) => (a.toHexString() < b.toHexString() ? -1 : 1))[0]).toEqual(early);
  });

  it('does NOT collide for two rows in the same second', () => {
    // The bug `ObjectId.createFromTime` would have shipped: it zeroes the eight bytes after
    // the timestamp, so a settled multi-SKU order — which mints several entitlements in one
    // millisecond — would have become ONE document, and the migration would have reported
    // success with the rest silently overwritten.
    const at = Date.UTC(2026, 0, 1);
    const ids = [1, 2, 3, 4].map((n) => legacyObjectId(at, n).toHexString());
    expect(new Set(ids).size).toBe(4);
    // ...and they still ascend with the integer, so the ordering within a second is the
    // insert order it was.
    expect([...ids].sort()).toEqual(ids);
  });

  it('is DETERMINISTIC, which is what makes a re-run an upsert', () => {
    expect(legacyObjectId(1_757_000_000_000, 42).toHexString()).toBe(
      legacyObjectId(1_757_000_000_000, 42).toHexString(),
    );
  });

  it('marks its output, and a driver-minted id is not marked', () => {
    expect(isMigratedId(legacyObjectId(1, 1))).toBe(true);
    // 256 fresh ones: the marker byte position is a fixed offset in the driver's random
    // tail, so a single sample would pass one time in 256 by luck.
    const accidental = Array.from({ length: 256 }, () => new ObjectId()).filter(isMigratedId);
    expect(accidental.length).toBeLessThan(4);
  });

  it('REFUSES an id past the six bytes it has, rather than truncating it', () => {
    // Truncating would produce a colliding `_id` — two rows into one document — which is the
    // silent version of the loud failure this throws.
    expect(() => legacyObjectId(1, 0x1_0000_0000_0000)).toThrow(RangeError);
    expect(() => legacyObjectId(1, -1)).toThrow(RangeError);
    expect(() => legacyObjectId(1, 1.5)).toThrow(RangeError);
  });
});

describe('parseProps', () => {
  it('turns the JSON blob into a subdocument', () => {
    expect(parseProps('{"screen":"hub","floor":3}')).toEqual({ screen: 'hub', floor: 3 });
  });

  it('carries a hand-broken value across as an empty object rather than stopping', () => {
    // design/19 §8 declines to build an admin service and plans for corrections made by hand
    // at a prompt, so a row somebody broke is a row this has to carry rather than fail on —
    // the event's other nine fields are what retention is computed from.
    for (const bad of ['not json', '[1,2]', 'null', '"a string"', 42, null]) {
      expect(parseProps(bad), String(bad)).toEqual({});
    }
  });
});

describe('the absent-vs-null rule, against the real indexes', () => {
  it('migrates TWO local accounts, which one stored null in providerId would have refused', () => {
    // The dangerous mapping, and the reason the rule exists. `accounts_provider_id` is a
    // PARTIAL unique index filtered on `{$type: 'string'}`: absence is invisible to it, one
    // stored `null` is a value, and a second document carrying that same null is a duplicate
    // key error. So the naive translation migrates the first local account and refuses every
    // one after it — on the box, once, with the data half moved.
    return expect(
      migrateAll(sourceOf({ accounts: [ACCOUNT, { ...ACCOUNT, id: 'acc_two', username: 'two' }] }), target),
    ).resolves.toMatchObject({ tables: expect.arrayContaining([expect.objectContaining({ table: 'accounts', read: 2, present: 2 })]) });
  });

  it('leaves providerId and displayName ABSENT rather than null', async () => {
    await migrateAll(sourceOf({ accounts: [ACCOUNT] }), target);
    const doc = await ctx.db('accounts').collection('accounts').findOne({ _id: 'acc_zoe' as never });
    expect(doc).not.toBeNull();
    expect('providerId' in doc!).toBe(false);
    expect('displayName' in doc!).toBe(false);
    // ...and a row that HAS them keeps them, so absence is not just "this mapping drops
    // fields". `force` because the run above completed and left the marker whose whole job is
    // to refuse a second run — see the cases for it below.
    await migrateAll(
      sourceOf({ accounts: [{ ...ACCOUNT, id: 'acc_cg', username: 'cg:1', provider: 'cg', provider_id: '1', display_name: 'Zoë' }] }),
      target,
      { force: true },
    );
    const portal = await ctx.db('accounts').collection('accounts').findOne({ _id: 'acc_cg' as never });
    expect(portal).toMatchObject({ providerId: '1', displayName: 'Zoë' });
  });

  it('migrates TWO unsettled orders, which one stored null in platformTxnId would have refused', async () => {
    // The same trap on the payment path, and `billingDb.ts`'s own comment relied in writing
    // on SQLite treating every NULL as distinct: "any number of unsettled orders coexist".
    const result = await migrateAll(
      sourceOf({ orders: [ORDER, { ...ORDER, id: 'ord_2' }] }),
      target,
    );
    expect(result.tables.find((t) => t.table === 'orders')).toMatchObject({ read: 2, present: 2 });
    const doc = await ctx.db('billing').collection('orders').findOne({ _id: 'ord_1' as never });
    expect('platformTxnId' in doc!).toBe(false);
    expect('settledAt' in doc!).toBe(false);
  });

  it('keeps an EXPLICIT null where SQL\'s IS NULL behaviour has to survive', async () => {
    // `webhookEvents.orderId` is read as an equality filter by `webhookEventsForOrder`, so a
    // stored null and an absent field must behave the way they did. Nothing indexes it
    // uniquely, which is what makes the opposite choice safe here and unsafe above.
    await migrateAll(
      sourceOf({
        webhook_events: [
          {
            id: 'unparsable:1',
            platform: 'paddle',
            order_id: null,
            txn_id: null,
            event_type: 'unknown',
            outcome: 'ignored',
            detail: null,
            raw: '<html>502</html>',
            first_seen_at: 1,
            last_seen_at: 1,
            seen_count: 1,
            divergences: 0,
          },
        ],
      }),
      target,
    );
    const doc = await ctx.db('billing').collection('webhookEvents').findOne({});
    expect(doc).toMatchObject({ orderId: null, txnId: null, detail: null });
  });

  it('satisfies the entitlements VALIDATOR, which an absent orderId on a purchase would not', async () => {
    // Both arms, because the mapping has to get a rule the SERVER enforces right in two
    // directions: a purchase-sourced grant needs a string `orderId`, and a `grant` must not
    // acquire a null one just to have the field.
    const base = { account_id: 'acc_zoe', granted_at: 1_757_000_000_000 };
    await migrateAll(
      sourceOf({
        entitlements: [
          { ...base, id: 1, sku: 'blueprint:cannon', source: 'purchase', order_id: 'ord_1' },
          { ...base, id: 2, sku: 'character:scout', source: 'grant', order_id: null },
        ],
      }),
      target,
    );
    const docs = await ctx.db('accounts').collection('entitlements').find({}).sort({ _id: 1 }).toArray();
    expect(docs).toHaveLength(2);
    expect(docs[0]).toMatchObject({ sku: 'blueprint:cannon', orderId: 'ord_1' });
    expect('orderId' in docs[1]!).toBe(false);
  });
});

describe('migrateAll', () => {
  it('is IDEMPOTENT — a second run changes nothing and reports the same counts', async () => {
    // The property a half-finished run rests on: resume by running it again, rather than by
    // reasoning about where it stopped. Everything keyed by a source value upserts onto the
    // same document, including the two tables whose keys were integers.
    const rows = sourceOf({
      accounts: [ACCOUNT],
      entitlements: [{ id: 7, account_id: 'acc_zoe', sku: 'x', source: 'grant', order_id: null, granted_at: 5 }],
      daily_active: [{ day: '2026-09-01', install: 'i1', host: 'web' }],
      daily_rollup: [{ day: '2026-09-01', metric: 'dau', labels: '{"host":"all"}', value: 4, computed_at: 9 }],
    });
    const first = await migrateAll(rows, target);
    // `force` on the second, because the first COMPLETED and left the marker that exists to
    // refuse exactly this. The case below is about that refusal; this one is about what the
    // write itself does when it is allowed to happen twice.
    const second = await migrateAll(rows, target, { force: true });
    expect(second.tables).toEqual(first.tables);
    for (const [store, collection] of [
      ['accounts', 'accounts'],
      ['accounts', 'entitlements'],
      ['analytics', 'dailyActive'],
      ['analytics', 'dailyRollup'],
    ] as const) {
      expect(await ctx.db(store).collection(collection).countDocuments({}), collection).toBe(1);
    }
  });

  it('upserts the two COMPOUND-keyed collections on their key, not on a generated id', async () => {
    // `dailyActive` and `dailyRollup` had compound PRIMARY KEYs and have compound unique
    // INDEXES; neither has a meaningful `_id`. Upserting them on one would duplicate every
    // document on the second run — which the case above would catch — and would also lose to
    // the unique index with a duplicate key error, which is the louder half.
    const one = { day: '2026-09-01', install: 'i1', host: 'web' };
    await migrateAll(sourceOf({ daily_active: [one] }), target);
    await migrateAll(sourceOf({ daily_active: [{ ...one, host: 'crazygames' }] }), target, { force: true });
    const docs = await ctx.db('analytics').collection('dailyActive').find({}).toArray();
    expect(docs).toHaveLength(1);
    // The migration REPLACES, so the second file's value wins. Correct for a re-read of the
    // same file, and the reason the refusal below exists for a re-run after the cutover.
    expect(docs[0]).toMatchObject({ host: 'crazygames' });
  });

  it('reports a table the file never had as zero rather than skipping it', async () => {
    // "This table had no rows" and "this table was not there" look identical in a summary,
    // and only one of them is worth a second look on an older box.
    const result = await migrateAll(sourceOf({}), target);
    expect(result.tables).toHaveLength(TABLES.length);
    expect(result.tables.every((t) => t.read === 0)).toBe(true);
    expect(migrationComplete(result)).toBe(true);
  });

  it('a DRY RUN writes nothing, and still runs every mapping', async () => {
    // The mode to run first on the real box. It has to be more than a count: a row that
    // cannot be mapped — a legacy id past what an ObjectId tail holds — must be found before
    // anything is written, not after half the tables have moved.
    const result = await migrateAll(sourceOf({ accounts: [ACCOUNT] }), target, { dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.tables.find((t) => t.table === 'accounts')).toMatchObject({ read: 1, written: 0, present: 0 });
    expect(await ctx.db('accounts').collection('accounts').countDocuments({})).toBe(0);

    await expect(
      migrateAll(
        sourceOf({ entitlements: [{ id: 2 ** 50, account_id: 'a', sku: 'x', source: 'grant', order_id: null, granted_at: 1 }] }),
        target,
        { dryRun: true },
      ),
    ).rejects.toThrow(RangeError);
  });


  it('REFUSES a re-run once a previous run COMPLETED', async () => {
    // The dangerous shape. A finished migration re-run a week later would upsert every
    // document back to what the `.db` file still says — every player's progress since, gone,
    // reported as a successful migration.
    //
    // The MARKER is what distinguishes it from the resume the idempotency case above relies
    // on, and it is the only signal that works for a STRING-keyed collection: a `metaState`
    // blob a player has changed since the cutover looks, from the outside, exactly like the
    // one the file still holds.
    await migrateAll(sourceOf({ accounts: [ACCOUNT] }), target);
    await expect(migrateAll(sourceOf({ accounts: [ACCOUNT] }), target)).rejects.toThrow(MigrationRefused);
  });

  it('refuses BEFORE writing anything', async () => {
    // What makes the refusal useful rather than a report on a migration that already
    // happened. The completed run below carries NO accounts, so a write that slipped through
    // the second one would be visible as a document the first could not have created.
    await migrateAll(sourceOf({}), target);
    await rejection(migrateAll(sourceOf({ accounts: [ACCOUNT] }), target));
    expect(await ctx.db('accounts').collection('accounts').countDocuments({})).toBe(0);
  });

  it('writes the marker only for a run that COMPLETED, so a resume is not refused', async () => {
    // An interrupted run must leave no marker: the operator's move at two in the morning is
    // to run the command again, and a marker written optimistically would refuse exactly
    // that. Reached with a source whose rows cannot all land — two identical accounts upsert
    // onto one document, so `present` ends below `read`.
    const result = await migrateAll(sourceOf({ accounts: [ACCOUNT, { ...ACCOUNT }] }), target);
    expect(migrationComplete(result)).toBe(false);
    expect(await readMarker(ctx.db('ops'))).toBeNull();
    // ...and the next run is therefore allowed, which is the half that matters.
    await expect(migrateAll(sourceOf({ accounts: [ACCOUNT] }), target)).resolves.toBeDefined();
  });

  it('the marker records WHEN and HOW MUCH, so a later dry run has something to compare to', async () => {
    await migrateAll(sourceOf({ accounts: [ACCOUNT] }), target, { now: () => 1_757_000_000_000 });
    expect(await readMarker(ctx.db('ops'))).toMatchObject({
      completedAt: 1_757_000_000_000,
      read: { accounts: 1, orders: 0 },
    });
  });

  it('REFUSES on a live document even when the marker is gone', async () => {
    // The backstop, for the box where the marker was never written or was dropped: a
    // driver-minted `_id` in a collection this migration keys by ObjectId is a document the
    // running server wrote, so the cutover has happened whatever the `ops` store says.
    await ctx.db('accounts').collection('entitlements').insertOne(LIVE_ENTITLEMENT as never);
    expect(await readMarker(ctx.db('ops'))).toBeNull();
    const err = await rejection(migrateAll(sourceOf({ accounts: [ACCOUNT] }), target));
    expect(err).toBeInstanceOf(MigrationRefused);
    expect(err.message).toContain('accounts.entitlements');
    expect(err.message).toContain('--force');
  });

  it('--force goes ahead past BOTH guards', async () => {
    await ctx.db('accounts').collection('entitlements').insertOne(LIVE_ENTITLEMENT as never);
    await ctx
      .db('ops')
      .collection(MARKER_COLLECTION)
      .insertOne({ _id: MARKER_ID, completedAt: 1, read: {} } as never);
    const result = await migrateAll(sourceOf({ accounts: [ACCOUNT] }), target, { force: true });
    expect(result.tables.find((t) => t.table === 'accounts')).toMatchObject({ read: 1, present: 1 });
  });

  it('batches, and the batch size does not change the outcome', async () => {
    // `events` is the only large table — ninety days of raw analytics — and a round trip per
    // row against Atlas would turn a two-minute migration into an hour. The batching must be
    // invisible in the result, including across a boundary that does not divide evenly.
    const events = Array.from({ length: 7 }, (_, i) => ({
      id: i + 1,
      at_ms: 1_757_000_000_000 + i,
      day: '2026-09-01',
      name: 'session_start',
      install: `i${i}`,
      session: 's',
      host: 'web',
      build: 'b',
      locale: 'en',
      account_id: null,
      props: '{"screen":"hub"}',
    }));
    const result = await migrateAll(sourceOf({ events }), target, { batch: 3 });
    expect(result.tables.find((t) => t.table === 'events')).toMatchObject({ read: 7, written: 7, present: 7 });
    const doc = await ctx.db('analytics').collection('events').findOne({ install: 'i0' });
    expect(doc).toMatchObject({ props: { screen: 'hub' }, accountId: null });
  });
});

describe('hasForeignDocuments', () => {
  it('is false for an empty collection and for one this migration wrote', async () => {
    const db = ctx.db('accounts');
    expect(await hasForeignDocuments(db, 'entitlements')).toBe(false);
    await db.collection('entitlements').insertOne({ ...LIVE_ENTITLEMENT, _id: legacyObjectId(1, 1) } as never);
    expect(await hasForeignDocuments(db, 'entitlements')).toBe(false);
  });

  it('is false for a STRING _id, however it got there', async () => {
    // A string-keyed collection carries its source's own key, so the migration reproduces it
    // exactly and re-running is idempotent for it whoever wrote it. There is nothing to
    // protect, and treating it as foreign would refuse every legitimate resume.
    const db = ctx.db('accounts');
    await db.collection('accounts').insertOne({ _id: 'acc_live' } as never);
    expect(await hasForeignDocuments(db, 'accounts')).toBe(false);
  });

  it('is TRUE for a driver-minted ObjectId, which is what the running server writes', async () => {
    const db = ctx.db('accounts');
    await db.collection('entitlements').insertOne(LIVE_ENTITLEMENT as never);
    expect(await hasForeignDocuments(db, 'entitlements')).toBe(true);
  });
});

describe('formatResult', () => {
  it('reports both sides of the count, so "moved nothing" cannot read as success', async () => {
    const result = await migrateAll(sourceOf({ accounts: [ACCOUNT] }), target);
    const text = formatResult(result);
    expect(text).toContain('accounts -> accounts');
    expect(text).toContain('1 read, 1 in collection');
  });

  it('says what a dry run WOULD move', async () => {
    const result = await migrateAll(sourceOf({ accounts: [ACCOUNT] }), target, { dryRun: true });
    expect(formatResult(result)).toContain('1 row(s) to move');
  });

  it('is false for a run that moved less than it read', () => {
    expect(
      migrationComplete({ dryRun: false, tables: [{ table: 't', collection: 'c', read: 5, written: 5, present: 4 }] }),
    ).toBe(false);
  });
});

describe('TABLES', () => {
  it('covers every table the four legacy schemas declared', () => {
    // Derived from the schemas as they shipped on 2026-09-15 (recoverable from git at
    // `HEAD~1:server/test/legacyAccountsDb.ts` and `HEAD~1:server/src/billing/sqliteLegacy.ts`).
    // A table missing from this list is data that stays on the box and is never noticed,
    // because the migration reports success over the tables it does know about.
    expect(TABLES.map((t) => t.table).sort()).toEqual(
      [
        'accounts',
        'daily_active',
        'daily_rollup',
        'deliveries',
        'entitlements',
        'events',
        'flags',
        'ledger',
        'meta_state',
        'orders',
        'rating_reports',
        'ratings',
        'receipts',
        'review_queue',
        'sessions',
        'webhook_events',
      ].sort(),
    );
  });

  it('targets a collection name each store actually uses', () => {
    // The mapping's other silent failure, and the quietest one in the whole migration: a
    // typo in a collection name creates a NEW collection on first write and MongoDB never
    // complains, so the run reports success while every service reads an empty one.
    //
    // Checked against the names the typed store factories and collection constants use —
    // `accountsStore`'s own keys, `BILLING_COLLECTIONS`, the three analytics constants and
    // `FLAGS_COLLECTION` — rather than against `listCollections`, which would only know
    // about the four that happen to have an index on them.
    const names = {
      accounts: Object.keys(accountsStore(ctx.db('accounts'))).filter((k) => k !== 'client'),
      billing: [...BILLING_COLLECTIONS] as string[],
      analytics: [EVENTS_COLLECTION, DAILY_ACTIVE_COLLECTION, DAILY_ROLLUP_COLLECTION],
      ops: [FLAGS_COLLECTION],
    };
    for (const map of TABLES) {
      expect(names[map.store], `${map.store}.${map.collection}`).toContain(map.collection);
    }
    // ...and the other direction, which is the half that catches a collection nothing
    // migrates into: every name the four stores declare has a table feeding it.
    const targeted = new Set(TABLES.map((t) => `${t.store}.${t.collection}`));
    for (const [store, list] of Object.entries(names)) {
      for (const collection of list) expect([...targeted]).toContain(`${store}.${collection}`);
    }
  });
});

/**
 * Every table, migrated in one run, with its whole document asserted.
 *
 * The cases above take the four mappings whose absent-vs-null decision is dangerous and prove
 * each one against the index or validator that would catch it. This is the other half, and it
 * is the half that matters for the twelve that are merely mechanical: a column dropped from a
 * mapping, or renamed to something nothing reads, produces a migration that reports success
 * and a service that finds `undefined` where a value should be — weeks later, on the only copy
 * of the data.
 *
 * So the assertion is `toEqual` on the whole document rather than `toMatchObject` on the
 * interesting fields. A missing field fails it, and so does an extra one.
 */
describe('every table maps every column', () => {
  const ROWS: Record<string, Record<string, unknown>[]> = {
    accounts: [ACCOUNT],
    sessions: [{ token: 'sess_1', account_id: 'acc_zoe', expires_at: 2_000 }],
    ratings: [{ account_id: 'acc_zoe', rating: 1184 }],
    meta_state: [{ account_id: 'acc_zoe', data: '{"gold":7}' }],
    entitlements: [
      { id: 3, account_id: 'acc_zoe', sku: 'blueprint:cannon', source: 'purchase', order_id: 'ord_1', granted_at: 1_500 },
    ],
    rating_reports: [{ report_key: 'room7:abc', applied_at: 900 }],
    orders: [{ ...ORDER, platform_txn_id: 'txn_a1', settled_at: 42, state: 'settled' }],
    receipts: [
      { id: 'paddle:rcpt', account_id: 'acc_zoe', platform: 'paddle', product: 'bp.cannon', raw: '{}', verified_at: 5 },
    ],
    ledger: [
      {
        id: 'purchase:paddle:txn_a1',
        account_id: 'acc_zoe',
        sku: 'bp.cannon',
        order_id: 'ord_1',
        receipt_id: 'paddle:rcpt',
        kind: 'purchase',
        ts: 6,
      },
    ],
    deliveries: [
      {
        id: 'purchase:paddle:txn_a1',
        account_id: 'acc_zoe',
        sku: 'bp.cannon',
        grants_json: '[["blueprint","cannon"]]',
        order_id: 'ord_1',
        receipt_id: 'paddle:rcpt',
        state: 'delivered',
        attempts: 2,
        created_at: 7,
        delivered_at: 8,
      },
    ],
    webhook_events: [
      {
        id: 'txn_a1:transaction.completed',
        platform: 'paddle',
        order_id: 'ord_1',
        txn_id: 'txn_a1',
        event_type: 'transaction.completed',
        outcome: 'settled',
        detail: 'ok',
        raw: '{"a":1}',
        first_seen_at: 9,
        last_seen_at: 10,
        seen_count: 2,
        divergences: 1,
      },
    ],
    review_queue: [
      {
        id: 'grant-anomaly:acc_zoe:2026-09-06',
        kind: 'grant-anomaly',
        account_id: 'acc_zoe',
        day_key: '2026-09-06',
        summary: '9 grants in one day',
        evidence_json: '{"n":9}',
        state: 'reviewed',
        created_at: 11,
        reviewed_at: 12,
        note: 'expected',
      },
    ],
    events: [
      {
        id: 4,
        at_ms: 1_757_000_000_000,
        day: '2026-09-04',
        name: 'session_start',
        install: 'i1',
        session: 's1',
        host: 'web',
        build: 'b',
        locale: 'en',
        account_id: 'acc_zoe',
        props: '{"screen":"hub"}',
      },
    ],
    daily_active: [{ day: '2026-09-04', install: 'i1', host: 'web' }],
    daily_rollup: [{ day: '2026-09-04', metric: 'dau', labels: '{"host":"all"}', value: 4, computed_at: 13 }],
    flags: [{ name: 'match.queueTimeoutMs', value: '45000', updated_at: 14, set_by: 'admin' }],
  };

  const EXPECTED: Record<string, Record<string, unknown>> = {
    accounts: {
      _id: 'acc_zoe',
      username: 'zoe',
      passwordHash: 'h',
      provider: 'local',
      createdAt: 1_757_000_000_000,
    },
    sessions: { _id: 'sess_1', accountId: 'acc_zoe', expiresAt: 2_000 },
    ratings: { _id: 'acc_zoe', rating: 1184 },
    metaState: { _id: 'acc_zoe', data: '{"gold":7}' },
    entitlements: {
      _id: legacyObjectId(1_500, 3),
      accountId: 'acc_zoe',
      sku: 'blueprint:cannon',
      source: 'purchase',
      orderId: 'ord_1',
      grantedAt: 1_500,
    },
    ratingReports: { _id: 'room7:abc', appliedAt: 900 },
    orders: {
      _id: 'ord_1',
      accountId: 'acc_zoe',
      sku: 'bp.cannon',
      platform: 'paddle',
      amountCents: 499,
      currency: 'EUR',
      state: 'settled',
      platformTxnId: 'txn_a1',
      createdAt: 1,
      settledAt: 42,
    },
    receipts: {
      _id: 'paddle:rcpt',
      accountId: 'acc_zoe',
      platform: 'paddle',
      product: 'bp.cannon',
      raw: '{}',
      verifiedAt: 5,
    },
    ledger: {
      _id: 'purchase:paddle:txn_a1',
      accountId: 'acc_zoe',
      sku: 'bp.cannon',
      orderId: 'ord_1',
      receiptId: 'paddle:rcpt',
      kind: 'purchase',
      ts: 6,
    },
    deliveries: {
      _id: 'purchase:paddle:txn_a1',
      accountId: 'acc_zoe',
      sku: 'bp.cannon',
      grantsJson: '[["blueprint","cannon"]]',
      orderId: 'ord_1',
      receiptId: 'paddle:rcpt',
      state: 'delivered',
      attempts: 2,
      createdAt: 7,
      deliveredAt: 8,
    },
    webhookEvents: {
      _id: 'txn_a1:transaction.completed',
      platform: 'paddle',
      orderId: 'ord_1',
      txnId: 'txn_a1',
      eventType: 'transaction.completed',
      outcome: 'settled',
      detail: 'ok',
      raw: '{"a":1}',
      firstSeenAt: 9,
      lastSeenAt: 10,
      seenCount: 2,
      divergences: 1,
    },
    reviewQueue: {
      _id: 'grant-anomaly:acc_zoe:2026-09-06',
      kind: 'grant-anomaly',
      accountId: 'acc_zoe',
      dayKey: '2026-09-06',
      summary: '9 grants in one day',
      evidenceJson: '{"n":9}',
      state: 'reviewed',
      createdAt: 11,
      reviewedAt: 12,
      note: 'expected',
    },
    events: {
      _id: legacyObjectId(1_757_000_000_000, 4),
      atMs: 1_757_000_000_000,
      day: '2026-09-04',
      name: 'session_start',
      install: 'i1',
      session: 's1',
      host: 'web',
      build: 'b',
      locale: 'en',
      accountId: 'acc_zoe',
      props: { screen: 'hub' },
    },
    dailyActive: { day: '2026-09-04', install: 'i1', host: 'web' },
    dailyRollup: { day: '2026-09-04', metric: 'dau', labels: '{"host":"all"}', value: 4, computedAt: 13 },
    flags: { _id: 'match.queueTimeoutMs', value: '45000', updatedAt: 14, setBy: 'admin' },
  };

  it('writes the whole document, field for field, for all sixteen', async () => {
    const result = await migrateAll(sourceOf(ROWS), target);
    expect(result.tables.every((t) => t.read === 1)).toBe(true);
    expect(migrationComplete(result)).toBe(true);

    // The two analytics collections have no meaningful `_id`: both were keyed by a compound
    // PRIMARY KEY and are keyed by a compound unique INDEX, so the driver mints one and it is
    // stripped before the comparison rather than predicted. Every other collection's `_id` IS
    // part of the assertion, because for those it is data.
    const generatedId = new Set(['dailyActive', 'dailyRollup']);

    for (const map of TABLES) {
      const doc = await ctx.db(map.store).collection(map.collection).findOne({});
      const { _id, ...rest } = doc!;
      const actual = generatedId.has(map.collection) ? rest : doc;
      expect(actual, `${map.store}.${map.collection}`).toEqual(EXPECTED[map.collection]);
    }
  });

  it('has a row for every table, so a mapping added without one is caught here', () => {
    // The gap this file would otherwise have: a seventeenth table whose `doc` is never run,
    // sitting at 0% inside a module the whole-tree percentage says is fine. `design/18`
    // Layer 4 is the general version of that, and this module is where it would cost live
    // player data.
    expect(Object.keys(ROWS).sort()).toEqual(TABLES.map((t) => t.table).sort());
  });
});
