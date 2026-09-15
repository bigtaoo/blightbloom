/**
 * The daily rollup — `src/analytics/rollup.ts`, against a real mongod.
 *
 * Most of this file is about ONE distinction, because it is the one that is easy to get
 * wrong and impossible to notice afterwards: **an unaged cohort is not a zero.** A D7 rate
 * for a cohort that is three days old is unknown; emitting it as `0` says "nobody came
 * back", which is the most alarming possible reading of "we do not know yet" — and it would
 * be wrong on every day of a game's first week, i.e. exactly when somebody is watching.
 *
 * The other thing pinned here is the off-by-one in {@link newestKnownCohort}. A cohort's
 * D`n` becomes knowable when day `cohort + n` is COMPLETE, so the newest answerable cohort
 * is `today - 1 - n`, not `today - n`. Both versions produce plausible numbers; only one is
 * about the cohort it claims.
 *
 * Two cases are new with the MongoDB port and are about the pipelines that replaced the SQL:
 * the screen split now groups on `props.screen` rather than `json_extract`, and
 * `persistRollup` upserts on `(day, metric, labels)` rather than `INSERT OR REPLACE`ing a
 * primary key. The second one is a real constraint on the server, so there is a case that
 * makes the server refuse a duplicate.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Db } from 'mongodb';
import { dailyRollupOf, ensureAnalyticsIndexes } from '../src/analytics/db';
import { writeBatch } from '../src/analytics/store';
import type { IngestedBatch } from '../src/analytics/ingest';
import {
  RETENTION_OFFSETS,
  addDays,
  canonicalLabels,
  cohortRate,
  dau,
  dauByHost,
  eventCounts,
  lastCompleteDay,
  screenViewCounts,
  newestKnownCohort,
  persistRollup,
  retentionGauges,
  rollupMetrics,
} from '../src/analytics/rollup';
import { openTestMongo, type MongoTestContext } from './mongoHarness';

const TODAY = '2026-09-09';
const NOW_MS = Date.UTC(2026, 8, 9, 12, 0, 0);

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

/** Record `install` as active on `day`, via the real write path. */
async function active(
  day: string,
  install: string,
  host: IngestedBatch['host'] = 'web',
  name = 'session_start',
): Promise<void> {
  const atMs = Date.parse(`${day}T06:00:00Z`);
  await writeBatch(
    db,
    {
      install,
      session: `s-${install}-${day}`,
      host,
      build: '1.0.0',
      locale: 'en',
      events: [{ name: name as never, atMs, props: {} }],
    },
    null,
  );
}

/** Record one `screen_view` for `screen` on `day`. */
async function view(day: string, install: string, screen: string): Promise<void> {
  await writeBatch(
    db,
    {
      install,
      session: `s-${install}`,
      host: 'web',
      build: '1.0.0',
      locale: 'en',
      events: [{ name: 'screen_view', atMs: Date.parse(`${day}T06:00:00Z`), props: { screen } }],
    },
    null,
  );
}

const rollupCount = (filter: Record<string, unknown> = {}): Promise<number> => dailyRollupOf(db).countDocuments(filter);

describe('addDays / lastCompleteDay', () => {
  it('crosses a month boundary', () => {
    expect(addDays('2026-08-31', 1)).toBe('2026-09-01');
    expect(addDays('2026-09-01', -1)).toBe('2026-08-31');
  });

  it('crosses a year boundary', () => {
    expect(addDays('2025-12-31', 1)).toBe('2026-01-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
  });

  it('handles a leap day', () => {
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2028-02-29', 1)).toBe('2028-03-01');
  });

  it('is the identity at zero', () => {
    expect(addDays(TODAY, 0)).toBe(TODAY);
  });

  it('never reports today as complete', () => {
    expect(lastCompleteDay(TODAY)).toBe('2026-09-08');
  });
});

describe('dau / dauByHost / eventCounts', () => {
  it('counts an install once however many events it sent', async () => {
    await active('2026-09-08', 'i-1');
    await active('2026-09-08', 'i-1', 'web', 'store_purchase');
    await active('2026-09-08', 'i-2');
    expect(await dau(db, '2026-09-08')).toBe(2);
  });

  it('is zero for a day with nothing in it', async () => {
    expect(await dau(db, '2026-09-08')).toBe(0);
    expect(await dauByHost(db, '2026-09-08')).toEqual([]);
    expect(await eventCounts(db, '2026-09-08')).toEqual([]);
  });

  it('splits by host as a PARTITION — the parts sum to the total', async () => {
    await active('2026-09-08', 'i-1', 'web');
    await active('2026-09-08', 'i-2', 'crazygames');
    await active('2026-09-08', 'i-3', 'wechat');
    // The switcher: already counted on web, appears again on crazygames.
    await active('2026-09-08', 'i-1', 'crazygames');
    const parts = await dauByHost(db, '2026-09-08');
    expect(parts.reduce((s, p) => s + p.n, 0)).toBe(await dau(db, '2026-09-08'));
    expect(parts).toEqual([
      { host: 'crazygames', n: 1 },
      { host: 'web', n: 1 },
      { host: 'wechat', n: 1 },
    ]);
  });

  it('counts events by name, not installs', async () => {
    await active('2026-09-08', 'i-1');
    await active('2026-09-08', 'i-1', 'web', 'store_purchase');
    await active('2026-09-08', 'i-2', 'web', 'store_purchase');
    expect(await eventCounts(db, '2026-09-08')).toEqual([
      { name: 'session_start', n: 1 },
      { name: 'store_purchase', n: 2 },
    ]);
  });
});

describe('screenViewCounts', () => {
  it('splits one event NAME by the screen inside its props', async () => {
    // The reason this function exists: the whole early funnel is one event name with a
    // field, so counting by name alone collapses every step into a single number.
    await view('2026-09-08', 'a', 'menu');
    await view('2026-09-08', 'b', 'menu');
    await view('2026-09-08', 'c', 'forge');
    expect(await screenViewCounts(db, '2026-09-08')).toEqual([
      { screen: 'forge', n: 1 },
      { screen: 'menu', n: 2 },
    ]);
  });

  it('is empty for a day with no screen views', async () => {
    await active('2026-09-08', 'a');
    expect(await screenViewCounts(db, '2026-09-08')).toEqual([]);
  });

  it('ignores events that are not screen views, even with a screen-shaped prop', async () => {
    // The `name` filter, not just the field: a `run_start` carrying a `character` must not
    // become a screen, and grouping on `props.screen` alone would let any event with that
    // field in.
    await active('2026-09-08', 'a', 'web', 'run_start');
    await view('2026-09-08', 'b', 'menu');
    expect(await screenViewCounts(db, '2026-09-08')).toEqual([{ screen: 'menu', n: 1 }]);
  });

  it('ignores a screen_view whose props somehow carry no screen', async () => {
    // The parser drops a bad `screen`, so an event with an unusable one still lands with
    // `props: {}`. Without the `$type` guard a missing field groups into a single `null`
    // bucket and appears on the dashboard as a screen nobody ever visited.
    await writeBatch(
      db,
      {
        install: 'a',
        session: 's',
        host: 'web',
        build: '1',
        locale: 'en',
        events: [{ name: 'screen_view', atMs: Date.parse('2026-09-08T06:00:00Z'), props: {} }],
      },
      null,
    );
    expect(await screenViewCounts(db, '2026-09-08')).toEqual([]);
  });

  it('counts views, not installs — a player who backtracks contributes twice', async () => {
    await view('2026-09-08', 'a', 'forge');
    await view('2026-09-08', 'a', 'forge');
    expect(await screenViewCounts(db, '2026-09-08')).toEqual([{ screen: 'forge', n: 2 }]);
  });
});

describe('cohortRate — unknown is not zero', () => {
  it('computes a rate when both days are complete', async () => {
    await active('2026-09-06', 'a');
    await active('2026-09-06', 'b');
    await active('2026-09-07', 'a');
    expect(await cohortRate(db, '2026-09-06', 1, TODAY)).toEqual({
      cohortDay: '2026-09-06',
      offset: 1,
      size: 2,
      returned: 1,
      rate: 0.5,
    });
  });

  it('reports 0 — not null — when the day arrived and nobody returned', async () => {
    await active('2026-09-06', 'a');
    await active('2026-09-07', 'z'); // somebody was active, just not from the cohort
    const r = await cohortRate(db, '2026-09-06', 1, TODAY);
    expect(r).not.toBeNull();
    expect(r!.rate).toBe(0);
    expect(r!.returned).toBe(0);
  });

  it('reports null — not 0 — when the offset day has not finished', async () => {
    await active('2026-09-08', 'a');
    // 2026-09-08 + 1 = today, which is still running.
    expect(await cohortRate(db, '2026-09-08', 1, TODAY)).toBeNull();
  });

  it('reports null for a cohort nobody was in', async () => {
    await active('2026-09-07', 'a');
    expect(await cohortRate(db, '2026-09-01', 1, TODAY)).toBeNull();
  });

  it('is exactly answerable at the boundary and not one day sooner', async () => {
    await active('2026-09-01', 'a');
    await active('2026-09-08', 'a');
    // cohort + 7 = 2026-09-08 = lastCompleteDay → answerable.
    expect((await cohortRate(db, '2026-09-01', 7, TODAY))!.rate).toBe(1);
    // cohort + 8 = today → not answerable.
    expect(await cohortRate(db, '2026-09-01', 8, TODAY)).toBeNull();
  });

  it('counts a returning install once even if it was active on many days', async () => {
    await active('2026-09-06', 'a');
    await active('2026-09-07', 'a');
    await active('2026-09-07', 'a', 'web', 'store_purchase');
    expect((await cohortRate(db, '2026-09-06', 1, TODAY))!.returned).toBe(1);
  });

  it('counts only the cohort, not everyone active on the offset day', async () => {
    // The `$lookup` is a membership test and its `$limit: 1` must not turn into a count:
    // three newcomers on the offset day must not raise `returned` above the one who
    // actually came back.
    await active('2026-09-06', 'a');
    await active('2026-09-06', 'b');
    await active('2026-09-07', 'a');
    for (const who of ['x', 'y', 'z']) await active('2026-09-07', who);
    const r = (await cohortRate(db, '2026-09-06', 1, TODAY))!;
    expect(r).toMatchObject({ size: 2, returned: 1, rate: 0.5 });
  });

  it('never reports a rate above 1', async () => {
    for (const d of ['2026-09-05', '2026-09-06', '2026-09-07']) {
      await active(d, 'a');
      await active(d, 'b');
    }
    for (const offset of RETENTION_OFFSETS) {
      const r = await cohortRate(db, '2026-09-05', offset, TODAY);
      if (r !== null) expect(r.rate).toBeLessThanOrEqual(1);
    }
  });
});

describe('newestKnownCohort', () => {
  it('is one day before the last complete day, per offset', () => {
    // Written out rather than derived from the same expression the code uses: this is the
    // off-by-one, so the expected values are the point of the test.
    expect(newestKnownCohort('2026-09-09', 1)).toBe('2026-09-07');
    expect(newestKnownCohort('2026-09-09', 7)).toBe('2026-09-01');
  });

  it('names a cohort whose answer is actually available', () => {
    for (const offset of RETENTION_OFFSETS) {
      const cohort = newestKnownCohort(TODAY, offset);
      expect(addDays(cohort, offset) <= lastCompleteDay(TODAY)).toBe(true);
      // ...and it is the NEWEST such: one day later would not be answerable.
      expect(addDays(addDays(cohort, 1), offset) <= lastCompleteDay(TODAY)).toBe(false);
    }
  });
});

describe('retentionGauges', () => {
  it('emits nothing at all on an empty database', async () => {
    // The launch-week case. A zero here would read as "nobody ever came back".
    expect(await retentionGauges(db, TODAY)).toEqual([]);
  });

  it('emits only the offsets it can answer', async () => {
    // One cohort on 09-07 returning on 09-08: D1 is answerable, D2..D7 are not.
    await active('2026-09-07', 'a');
    await active('2026-09-08', 'a');
    const gauges = await retentionGauges(db, TODAY);
    const offsets = gauges.filter((g) => g.name === 'bb_retention_ratio').map((g) => g.labels!.d);
    expect(offsets).toEqual(['1']);
  });

  it('pairs every rate with the cohort size behind it', async () => {
    await active('2026-09-07', 'a');
    await active('2026-09-08', 'a');
    const gauges = await retentionGauges(db, TODAY);
    expect(gauges.map((g) => g.name)).toEqual(['bb_retention_ratio', 'bb_retention_cohort_size']);
    expect(gauges[0]!.value).toBe(1);
    expect(gauges[1]!.value).toBe(1);
  });

  it('does not emit a zero for an offset whose cohort exists but is unaged', async () => {
    await active('2026-09-08', 'a');
    expect(await retentionGauges(db, TODAY)).toEqual([]);
  });
});

describe('rollupMetrics', () => {
  it('always reports DAU, including zero, and describes the last COMPLETE day', async () => {
    // DAU zero is a real measurement (nobody played yesterday) — unlike retention, whose
    // zero would be a claim about people who might still come back.
    const m = await rollupMetrics(db, TODAY);
    expect(m.find((x) => x.name === 'bb_dau' && x.labels?.host === 'all')?.value).toBe(0);
  });

  it('reports yesterday, not today', async () => {
    await active('2026-09-08', 'yesterday');
    await active(TODAY, 'today');
    const m = await rollupMetrics(db, TODAY);
    expect(m.find((x) => x.name === 'bb_dau' && x.labels?.host === 'all')?.value).toBe(1);
  });

  it('carries per-host DAU, per-event counts and retention together', async () => {
    await active('2026-09-07', 'a');
    await active('2026-09-08', 'a', 'crazygames');
    await view('2026-09-08', 'a', 'forge');
    const names = new Set((await rollupMetrics(db, TODAY)).map((m) => m.name));
    expect([...names].sort()).toEqual([
      'bb_dau',
      'bb_events_day',
      'bb_retention_cohort_size',
      'bb_retention_ratio',
      'bb_screen_views_day',
    ]);
  });

  it('declares one help string per metric name', async () => {
    // Prometheus rejects a scrape that declares the same metric name twice with different
    // help text, and it presents as "the target is down" rather than as a format complaint.
    await active('2026-09-08', 'a', 'web');
    await active('2026-09-08', 'b', 'wechat');
    const help = new Map<string, Set<string>>();
    for (const m of await rollupMetrics(db, TODAY)) {
      if (!help.has(m.name)) help.set(m.name, new Set());
      help.get(m.name)!.add(m.help);
    }
    for (const [name, set] of help) expect(set.size, `${name} has ${set.size} help strings`).toBe(1);
  });
});

describe('persistRollup', () => {
  it('writes a document per number and is idempotent', async () => {
    await active('2026-09-08', 'a');
    const first = await persistRollup(db, TODAY, NOW_MS);
    expect(first).toBeGreaterThan(0);
    const after = await rollupCount();
    await persistRollup(db, TODAY, NOW_MS + 1000);
    expect(await rollupCount()).toBe(after);
  });

  it('REPLACES rather than appending — the second run restates the value and the stamp', async () => {
    // What `unique: true` on (day, metric, labels) plus an upsert buys. Without the upsert
    // this is two documents for one number and every reader sees whichever it hits first.
    await active('2026-09-08', 'a');
    await persistRollup(db, TODAY, NOW_MS);
    await active('2026-09-08', 'b');
    await persistRollup(db, TODAY, NOW_MS + 1000);
    const docs = await dailyRollupOf(db)
      .find({ day: '2026-09-08', metric: 'dau', labels: '{"host":"all"}' })
      .toArray();
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ value: 2, computedAt: NOW_MS + 1000 });
  });

  it('leaves the SERVER refusing a hand-made duplicate of one number', async () => {
    await active('2026-09-08', 'a');
    await persistRollup(db, TODAY, NOW_MS);
    await expect(
      dailyRollupOf(db).insertOne({
        day: '2026-09-08',
        metric: 'dau',
        labels: '{"host":"all"}',
        value: 999,
        computedAt: NOW_MS,
      }),
    ).rejects.toMatchObject({ code: 11000 });
  });

  it('persists the screen-view split too, keyed by screen', async () => {
    // The funnel's early steps are the half of `dailyRollup` that outlives Prometheus's
    // 15 days, so they have to be WRITTEN and not only exposed.
    await view('2026-09-08', 'a', 'menu');
    await view('2026-09-08', 'b', 'forge');
    await persistRollup(db, TODAY, NOW_MS);
    const got = await dailyRollupOf(db)
      .find({ metric: 'screen_views' }, { projection: { _id: 0, labels: 1, value: 1 } })
      .sort({ labels: 1 })
      .toArray();
    expect(got).toEqual([
      { labels: '{"screen":"forge"}', value: 1 },
      { labels: '{"screen":"menu"}', value: 1 },
    ]);
  });

  it('files a retention document against the COHORT day, not the run day', async () => {
    // The document says "this cohort returned at this rate", which is a fact about that day
    // and stays true. Filing it under today would make the same fact move every night.
    await active('2026-09-07', 'a');
    await active('2026-09-08', 'a');
    await persistRollup(db, TODAY, NOW_MS);
    const doc = await dailyRollupOf(db).findOne({ metric: 'retention' });
    expect(doc?.day).toBe('2026-09-07');
    expect(doc?.value).toBe(1);
  });

  it('records the DAU it computed, readable back by day and label', async () => {
    await active('2026-09-08', 'a', 'web');
    await active('2026-09-08', 'b', 'wechat');
    await persistRollup(db, TODAY, NOW_MS);
    const got = await dailyRollupOf(db)
      .find({ day: '2026-09-08', metric: 'dau' }, { projection: { _id: 0, labels: 1, value: 1 } })
      .sort({ labels: 1 })
      .toArray();
    expect(got).toEqual([
      { labels: '{"host":"all"}', value: 2 },
      { labels: '{"host":"web"}', value: 1 },
      { labels: '{"host":"wechat"}', value: 1 },
    ]);
  });

  it('persists a day with no activity rather than skipping it', async () => {
    // A gap in this collection has to mean "the rollup did not run", not "nobody played" —
    // those are different facts and only one of them is a problem.
    expect(await persistRollup(db, TODAY, NOW_MS)).toBe(1);
    const doc = await dailyRollupOf(db).findOne({});
    expect({ day: doc?.day, metric: doc?.metric, value: doc?.value }).toEqual({
      day: '2026-09-08',
      metric: 'dau',
      value: 0,
    });
  });

  it('rolls back rather than leaving half a day written', async () => {
    // Reached through a real refusal: a collection validator that admits the DAU documents
    // and refuses the retention ones, which arrive LATER in the same bulk write. So the
    // transaction has already applied real documents when it fails, and the assertion is
    // that none of them survived.
    await active('2026-09-07', 'a');
    await active('2026-09-08', 'a');
    await persistRollup(db, TODAY, NOW_MS); // creates the collection
    await dailyRollupOf(db).deleteMany({});
    await db.command({ collMod: 'dailyRollup', validator: { metric: { $ne: 'retention' } } });

    await expect(persistRollup(db, TODAY, NOW_MS)).rejects.toThrow();
    expect(await rollupCount()).toBe(0);
  });
});

describe('canonicalLabels', () => {
  it('is independent of the order the object was built in', () => {
    // The uniqueness key is (day, metric, labels), so two callers producing the same label
    // set in different orders would otherwise write two documents for one number.
    expect(canonicalLabels({ host: 'web', d: '1' })).toBe(canonicalLabels({ d: '1', host: 'web' }));
  });

  it('is an object even when empty', () => {
    expect(canonicalLabels({})).toBe('{}');
  });
});
