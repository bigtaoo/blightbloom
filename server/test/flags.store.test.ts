/**
 * The `ops` database (design/21 §4) — the override collection, and the two properties that
 * make it safe.
 *
 * 1. **A document means "overridden"; absence means "as shipped".** So clearing DELETES
 *    rather than writing the default in, and a test here proves the deletion rather than
 *    the value — because a stored copy of the default goes stale the day a deploy changes
 *    it, with the collection looking perfectly consistent.
 * 2. **C1 is enforced on both sides of the collection.** `setFlag` refuses a name outside
 *    the allowlist, and `readOverrides` refuses one too, so a document written by hand at a
 *    `mongosh` prompt cannot become a live flag either.
 *
 * Against a real mongod, like every other store test here. It matters for one case in
 * particular: the flag name is the `_id`, so "a second `setFlag` replaces rather than adds"
 * is a statement about a uniqueness the server enforces, not about a branch in this code.
 */
import { describe, it, expect, beforeEach, afterEach, inject } from 'vitest';
import { MongoClient, type Db } from 'mongodb';
import { FLAG_DEFS, FLAG_NAMES } from '../src/flags/defs';
import {
  clearFlag,
  effectiveFlags,
  ensureOpsIndexes,
  flagsOf,
  listOverrides,
  readOverrides,
  setFlag,
} from '../src/flags/store';
import { openTestMongo, type MongoTestContext } from './mongoHarness';

const T0 = 1_757_000_000_000;

let ctx: MongoTestContext;
let db: Db;
beforeEach(async () => {
  ctx = await openTestMongo();
  db = ctx.db('ops');
  await ensureOpsIndexes(db);
});
afterEach(async () => {
  await ctx.dispose();
});

const count = (): Promise<number> => flagsOf(db).countDocuments();

/** A document written straight into the collection, bypassing `setFlag` — which is what a
 *  human at a `mongosh` prompt does, and the only way to produce the skip cases below. */
async function handWrite(name: string, valueJson: string): Promise<void> {
  await flagsOf(db).replaceOne(
    { _id: name },
    { value: valueJson, updatedAt: T0, setBy: 'mongosh' },
    { upsert: true },
  );
}

describe('ensureOpsIndexes', () => {
  it('declares the sort index the console reads, and nothing it does not need', async () => {
    const indexes = await flagsOf(db).listIndexes().toArray();
    expect(indexes.map((i) => i.name).sort()).toEqual(['_id_', 'flags_updated_at']);
    expect(indexes.find((i) => i.name === 'flags_updated_at')?.key).toEqual({ updatedAt: -1 });
    // Deliberately NOT unique: two flags set in the same millisecond is two clicks, and a
    // unique index here would refuse the second write.
    expect(indexes.every((i) => i.unique !== true)).toBe(true);
  });

  it('is idempotent, so every boot may call it', async () => {
    await ensureOpsIndexes(db);
    expect((await flagsOf(db).listIndexes().toArray()).length).toBe(2);
  });
});

describe('the flag NAME is the identity', () => {
  it('lets the SERVER refuse a second document for one flag', async () => {
    // Why `_id` rather than a `name` field with a unique index beside it: there is no
    // second index to create, to forget, or to create without `unique`.
    await setFlag(db, 'match.queueTimeoutMs', 45_000, T0, 'admin');
    await expect(
      flagsOf(db).insertOne({ _id: 'match.queueTimeoutMs', value: '1', updatedAt: T0, setBy: 'x' }),
    ).rejects.toMatchObject({ code: 11000 });
    expect(await count()).toBe(1);
  });
});

describe('setFlag', () => {
  it('stores a legitimate override and reads it back through a fresh query', async () => {
    expect(await setFlag(db, 'match.queueTimeoutMs', 45_000, T0, 'admin')).toBe(true);
    expect((await readOverrides(db)).values['match.queueTimeoutMs']).toBe(45_000);
  });

  it('stores each of the three value shapes', async () => {
    expect(await setFlag(db, 'ads.rewardedOfferEnabled', false, T0, 'admin')).toBe(true);
    expect(await setFlag(db, 'ui.maintenanceBanner', 'back at 14:00 UTC', T0, 'admin')).toBe(true);
    expect(await setFlag(db, 'match.pvpBotBackfillDelayMs', 0, T0, 'admin')).toBe(true);
    const { values } = await readOverrides(db);
    // All three falsy, and all three legitimate. A truthiness check anywhere in this path
    // would drop every one of them.
    expect(values['ads.rewardedOfferEnabled']).toBe(false);
    expect(values['match.pvpBotBackfillDelayMs']).toBe(0);
    expect(values['ui.maintenanceBanner']).toBe('back at 14:00 UTC');
  });

  it('REFUSES a name outside the allowlist and writes NOTHING', async () => {
    // C1's line at the write path. The document count is what is asserted, not just the
    // return value: a function that answered `false` and stored the document anyway would
    // pass a return-value-only test, and `readOverrides` would then be the only thing
    // between that document and a live flag.
    expect(await setFlag(db, 'billing.devStub', true, T0, 'admin')).toBe(false);
    expect(await setFlag(db, 'auth.skipPasswordCheck', true, T0, 'admin')).toBe(false);
    expect(await setFlag(db, '__proto__', true, T0, 'admin')).toBe(false);
    expect(await count()).toBe(0);
  });

  it('REFUSES a value its definition rejects, and writes nothing', async () => {
    expect(await setFlag(db, 'match.queueTimeoutMs', 1e9, T0, 'admin')).toBe(false);
    expect(await setFlag(db, 'match.queueTimeoutMs', 'soon', T0, 'admin')).toBe(false);
    expect(await setFlag(db, 'ads.rewardedOfferEnabled', 'true', T0, 'admin')).toBe(false);
    expect(await setFlag(db, 'ui.maintenanceBanner', 'x'.repeat(500), T0, 'admin')).toBe(false);
    expect(await count()).toBe(0);
  });

  it('UPSERTS: a second set replaces the value and the metadata, not adds a document', async () => {
    await setFlag(db, 'match.queueTimeoutMs', 45_000, T0, 'admin');
    await setFlag(db, 'match.queueTimeoutMs', 90_000, T0 + 5000, 'ops2');
    expect(await count()).toBe(1);
    const row = (await listOverrides(db)).rows[0]!;
    expect(row.value).toBe(90_000);
    expect(row.updatedAtMs).toBe(T0 + 5000);
    expect(row.setBy).toBe('ops2');
  });
});

describe('clearFlag', () => {
  it('DELETES the document rather than writing the default into it', async () => {
    // The property, asserted as a document count. A "clear" that stored the current default
    // would read identically today and silently stop following the default the day a deploy
    // changed it — with the collection looking perfectly consistent, which is what makes
    // that failure survive.
    await setFlag(db, 'match.queueTimeoutMs', 45_000, T0, 'admin');
    expect(await clearFlag(db, 'match.queueTimeoutMs')).toBe(true);
    expect(await count()).toBe(0);
    expect((await readOverrides(db)).values['match.queueTimeoutMs']).toBeUndefined();
    expect((await effectiveFlags(db))['match.queueTimeoutMs']).toBe(FLAG_DEFS['match.queueTimeoutMs'].default);
  });

  it('answers false for a flag that was not overridden', async () => {
    // So the console can say "cleared" rather than "cleared (there was nothing there)".
    expect(await clearFlag(db, 'match.queueTimeoutMs')).toBe(false);
  });

  it('answers true EXACTLY ONCE when two operators clear the same flag at once', async () => {
    // The look-before-write this function used to be — count, then delete, then report the
    // count — could answer `true` to both. `deleteOne`'s `deletedCount` is the server's
    // answer, so only one caller gets to say it removed anything.
    await setFlag(db, 'match.queueTimeoutMs', 45_000, T0, 'admin');
    const results = await Promise.all([
      clearFlag(db, 'match.queueTimeoutMs'),
      clearFlag(db, 'match.queueTimeoutMs'),
      clearFlag(db, 'match.queueTimeoutMs'),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await count()).toBe(0);
  });

  it('CLEARS a stale document whose name is no longer in the allowlist', async () => {
    // The one operation that has to work on a name outside the allowlist: a flag REMOVED in
    // a deploy leaves a document behind, and if clearing were gated on `isFlagName` the only
    // way to remove it would be a shell session — for a document the console is already
    // showing as a problem.
    await handWrite('removed.oldFlag', 'true');
    expect(await clearFlag(db, 'removed.oldFlag')).toBe(true);
    expect(await count()).toBe(0);
  });
});

describe('readOverrides', () => {
  it('SKIPS a document whose name is not in the allowlist, and reports it', async () => {
    // C1's second enforcement point. The two are edited by different people at different
    // times, so both matter: a document that got in some other way must still not become a
    // flag.
    await handWrite('billing.devStub', 'true');
    const { values, skipped } = await readOverrides(db);
    expect(values).toEqual({});
    expect(skipped).toEqual(['billing.devStub']);
    // ...and the document is LEFT in place. Deleting somebody's data on a read is not a
    // read's business, and the console needs it in order to show it as a problem.
    expect(await count()).toBe(1);
  });

  it('SKIPS a document whose value its definition refuses, and reports it', async () => {
    await handWrite('match.queueTimeoutMs', '999999999');
    await handWrite('ads.rewardedOfferEnabled', '"true"');
    const { values, skipped } = await readOverrides(db);
    expect(values).toEqual({});
    expect(skipped.sort()).toEqual(['ads.rewardedOfferEnabled', 'match.queueTimeoutMs']);
  });

  it('SKIPS a document whose value is not JSON at all', async () => {
    await handWrite('ui.maintenanceBanner', 'not json');
    expect((await readOverrides(db)).skipped).toEqual(['ui.maintenanceBanner']);
  });

  it('keeps the GOOD documents when a bad one is beside them', async () => {
    // The control for all three cases above: a reader that gave up on the first bad
    // document would pass every one of them and silently drop a legitimate override.
    await setFlag(db, 'match.queueTimeoutMs', 45_000, T0, 'admin');
    await handWrite('billing.devStub', 'true');
    const { values, skipped } = await readOverrides(db);
    expect(values['match.queueTimeoutMs']).toBe(45_000);
    expect(skipped).toEqual(['billing.devStub']);
  });
});

describe('listOverrides', () => {
  it('returns validated rows newest first, and names the invalid ones separately', async () => {
    await setFlag(db, 'match.queueTimeoutMs', 45_000, T0, 'admin');
    await setFlag(db, 'ads.rewardedOfferEnabled', false, T0 + 1000, 'admin');
    await flagsOf(db).insertOne({ _id: 'removed.oldFlag', value: 'true', updatedAt: T0 + 2000, setBy: 'mongosh' });
    const { rows, invalid } = await listOverrides(db);
    expect(rows.map((r) => r.name)).toEqual(['ads.rewardedOfferEnabled', 'match.queueTimeoutMs']);
    // The state worth being loud about: the collection says the flag is set and every
    // service is ignoring it.
    expect(invalid).toEqual(['removed.oldFlag']);
  });

  it('reports a document whose value is not JSON as invalid rather than throwing', async () => {
    // A legitimate name with a value nothing can parse — the state a hand-edit produces, and
    // the one the console most needs shown: the collection says the flag is set, every
    // service is on the default, and only this row says why. `readOverrides` skips it
    // silently; this is the reader whose job is to be loud about it.
    await handWrite('ui.maintenanceBanner', 'not json');
    expect(await listOverrides(db)).toEqual({ rows: [], invalid: ['ui.maintenanceBanner'] });
  });

  it('is empty on a fresh database', async () => {
    expect(await listOverrides(db)).toEqual({ rows: [], invalid: [] });
  });
});

describe('effectiveFlags', () => {
  it('is TOTAL — every name, defaults where there is no override', async () => {
    // The wire shape `flags/client.ts` requires: it treats a response missing any name as
    // unusable, so a partial payload here would make every poll fail while the endpoint
    // answered 200.
    const flags = await effectiveFlags(db);
    expect(Object.keys(flags).sort()).toEqual([...FLAG_NAMES].sort());
    for (const name of FLAG_NAMES) expect(flags[name], name).toBe(FLAG_DEFS[name].default);
  });

  it('merges an override over the default and leaves the rest alone', async () => {
    await setFlag(db, 'match.queueTimeoutMs', 45_000, T0, 'admin');
    const flags = await effectiveFlags(db);
    expect(flags['match.queueTimeoutMs']).toBe(45_000);
    expect(flags['match.pvpBotBackfillDelayMs']).toBe(FLAG_DEFS['match.pvpBotBackfillDelayMs'].default);
  });

  it('ignores an override that failed validation, and stays total', async () => {
    await handWrite('match.queueTimeoutMs', '999999999');
    const flags = await effectiveFlags(db);
    expect(Object.keys(flags).sort()).toEqual([...FLAG_NAMES].sort());
    expect(flags['match.queueTimeoutMs']).toBe(FLAG_DEFS['match.queueTimeoutMs'].default);
  });

  it('survives a second CLIENT reading the same database', async () => {
    // `ops.db` was written and read by one process, but the flag an operator sets has to
    // survive a restart. The SQLite version of this case used a real file because
    // `:memory:` is per-connection; the cluster has no such trap, so the case is kept in
    // the only form that still means something — a second connection, not a second handle
    // off the same pooled client.
    await setFlag(db, 'match.queueTimeoutMs', 45_000, T0, 'admin');
    const second = await MongoClient.connect(inject('mongoUri'));
    try {
      expect((await effectiveFlags(second.db(db.databaseName)))['match.queueTimeoutMs']).toBe(45_000);
    } finally {
      await second.close();
    }
  });
});
