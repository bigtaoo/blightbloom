/**
 * New-install cohort and first-day funnel — `src/analytics/newInstalls.ts`, against a real
 * mongod.
 *
 * The case this module exists for is the first one below: a regular who plays every day makes
 * the ALL-ACTIVE cohort (`rollup.ts`'s `cohortRate`) read 100% D1 over a day on which every new
 * player left. Both numbers are computed from the same rows, side by side, so the test shows the
 * divergence rather than asserting one number in isolation.
 *
 * The rest is the hole-filling in `newInstallRollupRows`, whose two rules are each easy to get
 * backwards: a day with NO activity is unknown (nothing written), and a cell already in the
 * record is not recomputed — except the newest one, which late batches keep changing.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Db } from 'mongodb';
import { dailyRollupOf, ensureAnalyticsIndexes } from '../src/analytics/db';
import { writeBatch } from '../src/analytics/store';
import type { IngestedBatch } from '../src/analytics/ingest';
import { cohortRate, persistRollup } from '../src/analytics/rollup';
import { addDays } from '../src/analytics/rollupKeys';
import {
  FUNNEL_STEPS,
  NEW_INSTALL_BACKFILL_DAYS,
  NEW_METRICS,
  newCohortRate,
  newInstallFunnel,
  newInstallGauges,
  newInstallRollupRows,
  newInstalls,
} from '../src/analytics/newInstalls';
import { openTestMongo, type MongoTestContext } from './mongoHarness';

const TODAY = '2026-09-20';
const YESTERDAY = '2026-09-19';
const NOW_MS = Date.UTC(2026, 8, 20, 12, 0, 0);

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

type Ev = { name: string; props?: Record<string, string | number> };

/** Record `install` doing `events` on `day`, via the real write path. */
async function on(day: string, install: string, events: Ev[] = [{ name: 'session_start' }]): Promise<void> {
  const atMs = Date.parse(`${day}T06:00:00Z`);
  await writeBatch(
    db,
    {
      install,
      session: `s-${install}-${day}`,
      host: 'web' as IngestedBatch['host'],
      build: '1.0.0',
      locale: 'en',
      events: events.map((e, i) => ({ name: e.name as never, atMs: atMs + i, props: e.props ?? {} })),
    },
    null,
  );
}

const MENU: Ev = { name: 'screen_view', props: { screen: 'menu' } };
const START: Ev = { name: 'run_start' };
const end = (outcome: string): Ev => ({ name: 'run_end', props: { outcome } });

describe('the new-install cohort', () => {
  it('excludes a returning regular, where the all-active cohort does not', async () => {
    // The regular plays both days; two new players arrive on the 10th and neither returns.
    await on('2026-09-09', 'regular');
    await on('2026-09-10', 'regular');
    await on('2026-09-10', 'new1');
    await on('2026-09-10', 'new2');
    await on('2026-09-11', 'regular');

    const all = await cohortRate(db, '2026-09-10', 1, TODAY);
    const fresh = await newCohortRate(db, '2026-09-10', 1, '2026-09-11');
    expect(all).toMatchObject({ size: 3, returned: 1 });
    expect(fresh).toEqual({ cohortDay: '2026-09-10', offset: 1, size: 2, returned: 0, rate: 0 });
    expect(await newInstalls(db, '2026-09-10')).toBe(2);
  });

  it('counts a new install that came back as returned, at the offset asked about only', async () => {
    await on('2026-09-10', 'a');
    await on('2026-09-10', 'b');
    await on('2026-09-11', 'a');
    await on('2026-09-13', 'b');
    expect(await newCohortRate(db, '2026-09-10', 1, '2026-09-11')).toMatchObject({ size: 2, returned: 1, rate: 0.5 });
    expect(await newCohortRate(db, '2026-09-10', 3, '2026-09-13')).toMatchObject({ size: 2, returned: 1, rate: 0.5 });
    expect(await newCohortRate(db, '2026-09-10', 2, '2026-09-12')).toMatchObject({ size: 2, returned: 0, rate: 0 });
  });

  it('is null for a day with no new installs — unknown, not 0%', async () => {
    await on('2026-09-09', 'regular');
    await on('2026-09-10', 'regular');
    expect(await newInstalls(db, '2026-09-10')).toBe(0);
    expect(await newCohortRate(db, '2026-09-10', 1, '2026-09-11')).toBeNull();
  });
});

describe('the first-day funnel', () => {
  it('counts distinct NEW installs per step, on their first day only', async () => {
    // a: menu twice, a run started and won.  b: menu, a run started and abandoned.
    // c: menu only.  old: a regular who did everything — must not count.
    await on('2026-09-09', 'old');
    await on(YESTERDAY, 'old', [MENU, START, end('win')]);
    await on(YESTERDAY, 'a', [MENU, MENU, START, end('win')]);
    await on(YESTERDAY, 'b', [MENU, START, end('abandon')]);
    await on(YESTERDAY, 'c', [MENU, { name: 'screen_view', props: { screen: 'forge' } }]);
    // d: arrived yesterday, played the next day — the next day is not its first day.
    await on(YESTERDAY, 'd');
    await on(TODAY, 'd', [MENU, START, end('loss')]);

    expect(await newInstallFunnel(db, YESTERDAY)).toEqual([
      { step: 'menu', n: 3 },
      { step: 'run_start', n: 2 },
      { step: 'run_finished', n: 1 },
    ]);
  });

  it('counts a loss as finishing a run', async () => {
    await on(YESTERDAY, 'a', [START, end('loss')]);
    expect(await newInstallFunnel(db, YESTERDAY)).toEqual([
      { step: 'menu', n: 0 },
      { step: 'run_start', n: 1 },
      { step: 'run_finished', n: 1 },
    ]);
  });

  it('reports every step as 0 on a day with no events, rather than an empty list', async () => {
    expect((await newInstallFunnel(db, YESTERDAY)).map((f) => f.step)).toEqual([...FUNNEL_STEPS]);
    expect((await newInstallFunnel(db, YESTERDAY)).every((f) => f.n === 0)).toBe(true);
  });
});

describe('newInstallRollupRows', () => {
  const rowsFor = (rows: Awaited<ReturnType<typeof newInstallRollupRows>>, metric: string) =>
    rows.filter((r) => r.metric === metric);

  it('fills every past day with activity, and writes nothing for a day without any', async () => {
    await on('2026-09-10', 'a');
    await on('2026-09-12', 'b');
    await on('2026-09-13', 'b');
    const rows = await newInstallRollupRows(db, TODAY);
    // The 10th and 12th have activity; the 11th has none and stays unknown; the 13th has
    // activity and zero new installs, which IS a measurement; yesterday always gets a row.
    expect(rowsFor(rows, NEW_METRICS.installs).map((r) => [r.day, r.value])).toEqual([
      ['2026-09-10', 1],
      ['2026-09-12', 1],
      ['2026-09-13', 0],
      [YESTERDAY, 0],
    ]);
    // b came back on the 13th: D1 for the 12th is 100%. The 10th's cohort never returned.
    const ret = rowsFor(rows, NEW_METRICS.retention);
    expect(ret.find((r) => r.day === '2026-09-12' && r.labels.d === '1')?.value).toBe(1);
    expect(ret.find((r) => r.day === '2026-09-10' && r.labels.d === '1')?.value).toBe(0);
    // No retention cell for a zero cohort (the 13th) or an inactive day (the 11th).
    expect(ret.some((r) => r.day === '2026-09-13' || r.day === '2026-09-11')).toBe(false);
    // And a size row beside every rate.
    expect(rowsFor(rows, NEW_METRICS.cohortSize)).toHaveLength(ret.length);
  });

  it('only reaches back NEW_INSTALL_BACKFILL_DAYS', async () => {
    const edge = addDays(YESTERDAY, -(NEW_INSTALL_BACKFILL_DAYS - 1));
    await on(addDays(edge, -1), 'outside');
    await on(edge, 'inside');
    const days = rowsFor(await newInstallRollupRows(db, TODAY), NEW_METRICS.installs).map((r) => r.day);
    expect(days).toContain(edge);
    expect(days).not.toContain(addDays(edge, -1));
  });

  it('leaves a recorded cell alone, but always recomputes the newest', async () => {
    await on('2026-09-10', 'a');
    await on('2026-09-17', 'b');
    await on('2026-09-18', 'b');
    await persistRollup(db, TODAY, NOW_MS);

    // A second cycle the same day: the 10th's per-day row and its cells are in the record, so
    // only yesterday's per-day rows and the newest cohort at each offset come back.
    const rows = await newInstallRollupRows(db, TODAY);
    expect(rowsFor(rows, NEW_METRICS.installs).map((r) => r.day)).toEqual([YESTERDAY]);
    const cells = rowsFor(rows, NEW_METRICS.retention).map((r) => `${r.day}/D${r.labels.d}`);
    // The 18th is the newest D1 cohort (yesterday - 1), and it has a new install (b's first
    // day was the 17th, so the 18th is empty) — so the only newest cohort with anybody in it
    // is the 17th at D2, and the 10th at D7 is not newest (that is the 12th).
    expect(cells).toEqual(['2026-09-17/D2']);
  });

  it('skips a cell whose recorded cohort size the source no longer backs', async () => {
    // A `new_installs` row for a day with no `dailyActive` documents behind it — the record
    // and the source disagree. The answer is no cell, not a 0% one.
    await dailyRollupOf(db).insertOne({
      day: '2026-09-10',
      metric: NEW_METRICS.installs,
      labels: '{}',
      value: 3,
      computedAt: 0,
    });
    const rows = await newInstallRollupRows(db, TODAY);
    expect(rows.some((r) => r.metric === NEW_METRICS.retention)).toBe(false);
  });

  it('is persisted against each row\'s own day, and a second persist is idempotent', async () => {
    await on('2026-09-10', 'a');
    await on('2026-09-11', 'a');
    await persistRollup(db, TODAY, NOW_MS);
    const count = await dailyRollupOf(db).countDocuments({ metric: { $regex: /^new_/ } });
    await persistRollup(db, TODAY, NOW_MS + 1);
    expect(await dailyRollupOf(db).countDocuments({ metric: { $regex: /^new_/ } })).toBe(count);
    const d1 = await dailyRollupOf(db).findOne({ day: '2026-09-10', metric: NEW_METRICS.retention, labels: '{"d":"1"}' });
    expect(d1?.value).toBe(1);
  });
});

describe('newInstallGauges', () => {
  it('offers yesterday\'s count and funnel, and the newest non-empty cohort per offset', async () => {
    await on('2026-09-18', 'a');
    await on(YESTERDAY, 'a');
    await on(YESTERDAY, 'b', [MENU, START]);
    const g = await newInstallGauges(db, TODAY);
    expect(g.find((m) => m.name === 'bb_new_installs')?.value).toBe(1);
    expect(g.filter((m) => m.name === 'bb_new_funnel_installs').map((m) => [m.labels?.step, m.value])).toEqual([
      ['menu', 1],
      ['run_start', 1],
      ['run_finished', 0],
    ]);
    // Only the 18th (D1) has a new install among the newest cohorts; every other offset is
    // absent rather than 0.
    const ratios = g.filter((m) => m.name === 'bb_new_retention_ratio');
    expect(ratios.map((m) => [m.labels?.d, m.value])).toEqual([['1', 1]]);
    expect(g.find((m) => m.name === 'bb_new_cohort_size')?.value).toBe(1);
  });
});
