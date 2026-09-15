/**
 * The `analytics` database and the only module that writes it — `src/analytics/db.ts` +
 * `src/analytics/store.ts`.
 *
 * Run against a REAL mongod (`mongoGlobalSetup.ts`, a single-node replica set), because
 * every property worth having here is a property of the server and not of TypeScript:
 *
 *   - **The cohort upsert is an exactly-once CLAIM.** `newActiveDay` used to come from
 *     `INSERT OR IGNORE` + `info.changes > 0`; it comes from `upsertedCount === 1` now, and
 *     the case that separates that from a `findOne`-then-`insertOne` is eight writers
 *     arriving at once for the same `(day, install)`. A sequential test passes against the
 *     broken version, so the concurrent one below is the whole point.
 *   - **`{ day, install }` is UNIQUE, and DAU-by-host is therefore a PARTITION of DAU.**
 *     Asserted twice: once by requiring the server to refuse a duplicate, and once by the
 *     host-switcher case, which is what the constraint is FOR.
 *   - **A batch is atomic.** It writes two collections that answer different questions about
 *     one visit, and half of it is worse than none — an `events` document with no cohort
 *     document is a session that happened to nobody. The rollback case below is reached
 *     through a real refusal (a collection validator the server enforces), not by stubbing
 *     the driver, because a stubbed transaction proves nothing about the one that ships.
 *   - **The prune windows are independent.** `events` ages out at 90 days and `dailyActive`
 *     at 180, and that gap is the whole reason a D7 answer for last month does not silently
 *     become `0` the week the raw documents are dropped. A single window would pass every
 *     test that only checks "old documents go away".
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Db } from 'mongodb';
import {
  ACTIVE_RETENTION_DAYS,
  EVENT_RETENTION_DAYS,
  dailyActiveOf,
  ensureAnalyticsIndexes,
  eventsOf,
} from '../src/analytics/db';
import { prune, writeBatch } from '../src/analytics/store';
import type { IngestedBatch } from '../src/analytics/ingest';
import { openTestMongo, type MongoTestContext } from './mongoHarness';

const DAY_MS = 86_400_000;
const T0 = Date.UTC(2026, 8, 9, 12, 0, 0); // 2026-09-09T12:00:00Z

function batch(over: Partial<IngestedBatch> = {}): IngestedBatch {
  return {
    install: 'i-1',
    session: 's-1',
    host: 'web',
    build: '1.0.0',
    locale: 'en',
    events: [{ name: 'session_start', atMs: T0, props: {} }],
    ...over,
  };
}

let ctx: MongoTestContext;
let db: Db;
beforeEach(async () => {
  ctx = await openTestMongo();
  db = ctx.db('analytics');
  await ensureAnalyticsIndexes(db);
});
afterEach(async () => {
  await ctx.dispose();
});

const events = (): Promise<number> => eventsOf(db).countDocuments();
const active = (): Promise<number> => dailyActiveOf(db).countDocuments();

describe('ensureAnalyticsIndexes', () => {
  it('declares every index the queries and the constraints need', async () => {
    const named = async (name: 'events' | 'dailyActive' | 'dailyRollup'): Promise<Record<string, unknown>[]> =>
      (await db.collection(name).listIndexes().toArray()) as Record<string, unknown>[];

    expect((await named('events')).map((i) => i.name).sort()).toEqual(['_id_', 'events_account', 'events_day_name']);
    expect((await named('dailyActive')).map((i) => i.name).sort()).toEqual([
      '_id_',
      'daily_active_install',
      'daily_active_key',
    ]);
    expect((await named('dailyRollup')).map((i) => i.name).sort()).toEqual(['_id_', 'daily_rollup_key']);
  });

  it('marks the two KEY indexes unique and leaves the query indexes alone', async () => {
    // The option that can be silently omitted. Both `unique: true`s below are constraints
    // the old schema spelled `PRIMARY KEY`, and a `createIndex` that drops the option
    // compiles, runs, and produces a database that duplicates instead of replacing.
    const uniqueness = async (name: string): Promise<Record<string, boolean>> => {
      const out: Record<string, boolean> = {};
      for (const i of await db.collection(name).listIndexes().toArray()) {
        out[String(i.name)] = i.unique === true;
      }
      return out;
    };
    expect(await uniqueness('dailyActive')).toEqual({
      _id_: false,
      daily_active_key: true,
      daily_active_install: false,
    });
    expect(await uniqueness('dailyRollup')).toEqual({ _id_: false, daily_rollup_key: true });
    expect(await uniqueness('events')).toEqual({ _id_: false, events_day_name: false, events_account: false });
  });

  it('makes the SERVER refuse a second cohort document for one (day, install)', async () => {
    // Not "the index object says unique" — the refusal itself, from a server that really
    // enforces it. This is the assertion that goes red when the option is dropped even if
    // the index-name test above were written loosely.
    await dailyActiveOf(db).insertOne({ day: '2026-09-09', install: 'i-1', host: 'web' });
    await expect(
      dailyActiveOf(db).insertOne({ day: '2026-09-09', install: 'i-1', host: 'crazygames' }),
    ).rejects.toMatchObject({ code: 11000 });
    // ...and the same install on ANOTHER day is not a duplicate, so the constraint is the
    // pair and not the install.
    await dailyActiveOf(db).insertOne({ day: '2026-09-10', install: 'i-1', host: 'web' });
    expect(await active()).toBe(2);
  });

  it('is idempotent, so every boot may call it', async () => {
    await ensureAnalyticsIndexes(db);
    await ensureAnalyticsIndexes(db);
    expect((await dailyActiveOf(db).listIndexes().toArray()).length).toBe(3);
  });
});

describe('writeBatch', () => {
  it('stores one document per event and one cohort document per day', async () => {
    const r = await writeBatch(
      db,
      batch({
        events: [
          { name: 'session_start', atMs: T0, props: {} },
          { name: 'run_start', atMs: T0 + 1000, props: { character: 'scrapper', weapon: 'rifle' } },
        ],
      }),
      null,
    );
    expect(r).toEqual({ events: 2, newActiveDay: true });
    expect(await events()).toBe(2);
    expect(await active()).toBe(1);
  });

  it('stores props as a SUBDOCUMENT and reads them back', async () => {
    // A subdocument rather than the JSON text the column held — `rollup.ts`'s screen split
    // groups on `props.screen`, which a blob cannot serve.
    await writeBatch(db, batch({ events: [{ name: 'run_end', atMs: T0, props: { outcome: 'win', floor: 7 } }] }), null);
    const doc = await eventsOf(db).findOne({});
    expect(doc?.props).toEqual({ outcome: 'win', floor: 7 });
    expect(typeof doc?.props).toBe('object');
  });

  it('attaches the account id it was given, and null when there is none', async () => {
    await writeBatch(db, batch({ install: 'i-anon' }), null);
    await writeBatch(db, batch({ install: 'i-known' }), 'acct-9');
    const rows = await eventsOf(db)
      .find({}, { projection: { _id: 0, install: 1, accountId: 1 } })
      .sort({ install: 1 })
      .toArray();
    expect(rows).toEqual([
      { install: 'i-anon', accountId: null },
      { install: 'i-known', accountId: 'acct-9' },
    ]);
  });

  it('reports newActiveDay false on a second batch the same day', async () => {
    expect((await writeBatch(db, batch(), null)).newActiveDay).toBe(true);
    expect((await writeBatch(db, batch({ session: 's-2' }), null)).newActiveDay).toBe(false);
    expect(await active()).toBe(1);
    expect(await events()).toBe(2);
  });

  it('reports the cohort document created EXACTLY ONCE across concurrent writers', async () => {
    // The trap, and the reason this file needs a real server. `findOne` then `insertOne`
    // passes every sequential case above and fails here: several writers would each see no
    // document and each report `newActiveDay: true`, which is a DAU that counts visits.
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) => writeBatch(db, batch({ session: `s-${i}` }), null)),
    );
    expect(results.filter((r) => r.status === 'rejected')).toEqual([]);
    const created = results.filter((r) => r.status === 'fulfilled' && r.value.newActiveDay);
    expect(created).toHaveLength(1);
    expect(await active()).toBe(1);
    // Every batch's events survived — a lost race must cost the CLAIM, not the data. (Eight
    // is also the count that shows `withTransaction`'s retry did not double-write: a
    // retried attempt's earlier inserts are discarded with the attempt.)
    expect(await events()).toBe(8);
  });

  it('writes nothing, and claims nothing, for a batch with no events in it', async () => {
    // `parseAnalyticsBatch` never produces one — it answers null instead — so this is about
    // the exported function's own contract rather than about the route. It exists because
    // `insertMany([])` is an ERROR in MongoDB, not a no-op, so the guard in front of it has
    // to be a branch a test reaches rather than a defensive line nobody can trigger.
    expect(await writeBatch(db, batch({ events: [] }), null)).toEqual({ events: 0, newActiveDay: false });
    expect(await events()).toBe(0);
    expect(await active()).toBe(0);
  });

  it('creates one cohort document per DAY when a batch spans midnight', async () => {
    // A visit that crosses UTC midnight is active on both days, and both cohorts are real.
    await writeBatch(
      db,
      batch({
        events: [
          { name: 'session_start', atMs: Date.UTC(2026, 8, 9, 23, 59, 0), props: {} },
          { name: 'session_end', atMs: Date.UTC(2026, 8, 10, 0, 1, 0), props: {} },
        ],
      }),
      null,
    );
    const days = await dailyActiveOf(db).find({}).sort({ day: 1 }).toArray();
    expect(days.map((d) => d.day)).toEqual(['2026-09-09', '2026-09-10']);
  });

  it('writes ONE cohort document for a 60-event batch on one day', async () => {
    // The in-memory dedup: without it this is 59 no-op upserts inside the transaction.
    const evts = Array.from({ length: 60 }, (_, i) => ({
      name: 'screen_view' as const,
      atMs: T0 + i,
      props: { screen: 'lobby' },
    }));
    await writeBatch(db, batch({ events: evts }), null);
    expect(await events()).toBe(60);
    expect(await active()).toBe(1);
  });

  it('keeps the FIRST host for an install that appears on two hosts the same day', async () => {
    // db.ts's header: DAU-by-host is a PARTITION of DAU, so a switcher is counted once and
    // under the host they arrived on. `$set` instead of `$setOnInsert` would move them.
    await writeBatch(db, batch({ host: 'web' }), null);
    await writeBatch(db, batch({ host: 'crazygames' }), null);
    const rows = await dailyActiveOf(db).find({}, { projection: { _id: 0, host: 1 } }).toArray();
    expect(rows).toEqual([{ host: 'web' }]);
  });

  it('keeps DAU-by-host a PARTITION of DAU: the parts sum to the total', async () => {
    await writeBatch(db, batch({ install: 'i-1', host: 'web' }), null);
    await writeBatch(db, batch({ install: 'i-2', host: 'crazygames' }), null);
    await writeBatch(db, batch({ install: 'i-1', host: 'crazygames' }), null); // the switcher
    const byHost = await dailyActiveOf(db)
      .aggregate<{ _id: string; n: number }>([{ $group: { _id: '$host', n: { $sum: 1 } } }])
      .toArray();
    expect(byHost.reduce((s, h) => s + h.n, 0)).toBe(await active());
    expect(await active()).toBe(2);
  });

  it('rolls the whole batch back when a write inside it fails', async () => {
    // Reached through a real refusal rather than a stub: a collection VALIDATOR the server
    // enforces, which is this port's equivalent of the `RAISE(ABORT)` trigger the SQLite
    // version used. The events insert lands first inside the transaction, so this is
    // exactly the "an events document with no cohort document" state the transaction exists
    // to prevent.
    await writeBatch(db, batch({ install: 'i-seed', host: 'crazygames' }), null);
    await db.command({ collMod: 'dailyActive', validator: { host: { $ne: 'web' } } });

    await expect(writeBatch(db, batch({ install: 'i-blocked', host: 'web' }), null)).rejects.toThrow();
    expect(await eventsOf(db).countDocuments({ install: 'i-blocked' })).toBe(0);
    expect(await dailyActiveOf(db).countDocuments({ install: 'i-blocked' })).toBe(0);
    // The seed survived, so the rollback discarded this batch and not the collection.
    expect(await events()).toBe(1);
  });
});

describe('prune', () => {
  /** Seed one event + cohort document for a day `n` days before T0. */
  const seedAgo = async (n: number): Promise<void> => {
    await writeBatch(
      db,
      batch({ install: `i-${n}`, events: [{ name: 'session_start', atMs: T0 - n * DAY_MS, props: {} }] }),
      null,
    );
  };

  it('keeps a document exactly at the cutoff and drops the one before it', async () => {
    await seedAgo(EVENT_RETENTION_DAYS - 1);
    await seedAgo(EVENT_RETENTION_DAYS);
    await seedAgo(EVENT_RETENTION_DAYS + 1);
    const r = await prune(db, '2026-09-09');
    expect(r.events).toBe(1);
    expect(await events()).toBe(2);
  });

  it('drops raw events long before it drops cohort documents', async () => {
    // The property a single window would break: retention for a month-old cohort still has
    // its `dailyActive` documents after the raw events are gone.
    await seedAgo(EVENT_RETENTION_DAYS + 10);
    const r = await prune(db, '2026-09-09');
    expect(r.events).toBe(1);
    expect(r.active).toBe(0);
    expect(await events()).toBe(0);
    expect(await active()).toBe(1);
  });

  it('eventually drops cohort documents too, at their own window', async () => {
    await seedAgo(ACTIVE_RETENTION_DAYS + 1);
    const r = await prune(db, '2026-09-09');
    expect(r.active).toBe(1);
    expect(await active()).toBe(0);
  });

  it('is a no-op on a database with nothing old in it', async () => {
    await seedAgo(0);
    expect(await prune(db, '2026-09-09')).toEqual({ events: 0, active: 0 });
    expect(await events()).toBe(1);
  });

  it('is idempotent', async () => {
    await seedAgo(EVENT_RETENTION_DAYS + 1);
    await prune(db, '2026-09-09');
    expect(await prune(db, '2026-09-09')).toEqual({ events: 0, active: 0 });
  });

  it('compares the day as TEXT, and `$lt` on that text is chronological', async () => {
    // `YYYY-MM-DD` sorts exactly chronologically, which is why `day` stays a string rather
    // than becoming a `Date` — a `Date` would change the comparison, the index and the
    // document size to answer nothing this module asks. The cutoff here is 2026-06-11.
    await seedAgo(EVENT_RETENTION_DAYS + 1); // 2026-06-10 — before the cutoff
    await seedAgo(EVENT_RETENTION_DAYS - 1); // 2026-06-12 — after it
    await prune(db, '2026-09-09');
    const left = await eventsOf(db).find({}, { projection: { _id: 0, day: 1 } }).toArray();
    expect(left).toEqual([{ day: '2026-06-12' }]);
  });

  it('has windows in the order the retention argument depends on', () => {
    // Stated as an assertion because swapping the two constants would leave every test
    // above passing in shape while making the cohort collection the SHORTER-lived one.
    expect(ACTIVE_RETENTION_DAYS).toBeGreaterThan(EVENT_RETENTION_DAYS + 7);
  });

  it('pins the two numbers the privacy policy states', () => {
    // The policy names both, so a change here is a change there. Written out rather than
    // derived, so the test is the statement and not a restatement of the code.
    expect(EVENT_RETENTION_DAYS).toBe(90);
    expect(ACTIVE_RETENTION_DAYS).toBe(180);
  });
});
