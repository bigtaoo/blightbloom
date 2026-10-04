/**
 * New-install cohort, first-day profile and their per-host split — `src/analytics/
 * newInstallQueries.ts` and `newInstalls.ts`, against a real mongod.
 *
 * The case this module exists for is the first one below: a regular who plays every day makes
 * the ALL-ACTIVE cohort (`rollup.ts`'s `cohortRate`) read 100% D1 over a day on which every new
 * player left. Both numbers are computed from the same rows, side by side, so the test shows the
 * divergence rather than asserting one number in isolation.
 *
 * The rest is the hole-filling in `newInstallRollupRows`, whose two rules are each easy to get
 * backwards: a day with NO activity is unknown (nothing written), and a cell already in the
 * record is not recomputed — except the newest one, which late batches keep changing. The host
 * split adds the same rule one level down: a host with no activity on a day gets no rows.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Db } from 'mongodb';
import { dailyRollupOf, ensureAnalyticsIndexes } from '../src/analytics/db';
import { writeBatch } from '../src/analytics/store';
import type { IngestedBatch } from '../src/analytics/ingest';
import { cohortRate, persistRollup } from '../src/analytics/rollup';
import { addDays } from '../src/analytics/rollupKeys';
import { activeHostsByDay, cohortReturns, countByHost, firstDays, newCohort } from '../src/analytics/newInstallQueries';
import {
  NEW_INSTALL_BACKFILL_DAYS,
  NEW_METRICS,
  firstDayNumbers,
  newInstallGauges,
  newInstallRollupRows,
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

/** Record `install` doing `events` on `day` from `host`, via the real write path. */
async function on(day: string, install: string, events: Ev[] = [{ name: 'session_start' }], host = 'web'): Promise<void> {
  const atMs = Date.parse(`${day}T06:00:00Z`);
  await writeBatch(
    db,
    {
      install,
      session: `s-${install}-${day}`,
      host: host as IngestedBatch['host'],
      build: '1.0.0',
      locale: 'en',
      events: events.map((e, i) => ({ name: e.name as never, atMs: atMs + i, props: e.props ?? {} })),
    },
    null,
  );
}

const MENU: Ev = { name: 'screen_view', props: { screen: 'menu' } };
const START: Ev = { name: 'run_start' };
const end = (outcome: string, floor?: number): Ev => ({ name: 'run_end', props: floor === undefined ? { outcome } : { outcome, floor } });
const floorAt = (floor: number): Ev => ({ name: 'floor_reached', props: { floor } });
const lostId: Ev = { name: 'session_start', props: { storage: 'unpersisted' } };

describe('the new-install cohort', () => {
  it('excludes a returning regular, where the all-active cohort does not', async () => {
    // The regular plays both days; two new players arrive on the 10th and neither returns.
    await on('2026-09-09', 'regular');
    await on('2026-09-10', 'regular');
    await on('2026-09-10', 'new1');
    await on('2026-09-10', 'new2');
    await on('2026-09-11', 'regular');

    const all = await cohortRate(db, '2026-09-10', 1, TODAY);
    const cohort = await newCohort(db, '2026-09-10');
    expect(all).toMatchObject({ size: 3, returned: 1 });
    expect([...cohort.keys()].sort()).toEqual(['new1', 'new2']);
    expect((await cohortReturns(db, cohort, '2026-09-11')).get('all')).toEqual({ size: 2, returned: 0, rate: 0 });
  });

  it('carries each install\'s first-day host', async () => {
    await on('2026-09-10', 'a', undefined, 'wechat');
    await on('2026-09-10', 'b', undefined, 'crazygames');
    expect(Object.fromEntries(await newCohort(db, '2026-09-10'))).toEqual({ a: 'wechat', b: 'crazygames' });
  });
});

describe('cohortReturns', () => {
  it('splits by host, keeps per-host sizes summing to the total, and omits absent hosts', async () => {
    await on('2026-09-10', 'w1');
    await on('2026-09-10', 'w2');
    await on('2026-09-10', 'c1', undefined, 'crazygames');
    await on('2026-09-11', 'w1');
    await on('2026-09-11', 'c1', undefined, 'crazygames');
    const r = await cohortReturns(db, await newCohort(db, '2026-09-10'), '2026-09-11');
    expect(Object.fromEntries(r)).toEqual({
      all: { size: 3, returned: 2, rate: 2 / 3 },
      web: { size: 2, returned: 1, rate: 0.5 },
      crazygames: { size: 1, returned: 1, rate: 1 },
    });
  });

  it('counts a return at the day asked about only', async () => {
    await on('2026-09-10', 'a');
    await on('2026-09-13', 'a');
    const cohort = await newCohort(db, '2026-09-10');
    expect((await cohortReturns(db, cohort, '2026-09-12')).get('all')?.returned).toBe(0);
    expect((await cohortReturns(db, cohort, '2026-09-13')).get('all')?.returned).toBe(1);
  });

  it('is empty for an empty cohort — unknown, not 0%', async () => {
    expect((await cohortReturns(db, new Map(), '2026-09-11')).size).toBe(0);
  });
});

describe('countByHost', () => {
  it('lists every host in the cohort even when none of its members pass', () => {
    const c = new Map([
      ['a', 'web'],
      ['b', 'wechat'],
    ]);
    expect(Object.fromEntries(countByHost(c, (i) => i === 'a'))).toEqual({ all: 1, web: 1, wechat: 0 });
    expect(Object.fromEntries(countByHost(new Map()))).toEqual({ all: 0 });
  });
});

describe('firstDays', () => {
  it('profiles each NEW install on its first day only', async () => {
    // a: menu twice, a run started and won.  b: a run abandoned.  c: menu only.
    // d: arrived yesterday, played the next day — the next day is not its first day.
    await on('2026-09-09', 'old');
    await on(YESTERDAY, 'old', [MENU, START, end('win')]);
    await on(YESTERDAY, 'a', [MENU, MENU, START, end('win', 3)]);
    await on(YESTERDAY, 'b', [MENU, START, end('abandon')]);
    await on(YESTERDAY, 'c', [MENU, { name: 'screen_view', props: { screen: 'forge' } }]);
    await on(YESTERDAY, 'd');
    await on(TODAY, 'd', [MENU, START, end('loss')]);

    const cohort = await newCohort(db, YESTERDAY);
    const p = await firstDays(db, YESTERDAY, cohort);
    expect([...p.keys()].sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(p.get('a')).toEqual({ menu: true, run_start: true, run_finished: true, unpersisted: false, depth: 3 });
    // An abandon with no numbers still reached floor 1, because the run started.
    expect(p.get('b')).toMatchObject({ run_start: true, run_finished: false, depth: 1 });
    expect(p.get('c')).toMatchObject({ menu: true, run_start: false, depth: 0 });
    // `d` had only a bare session_start on its first day.
    expect(p.get('d')).toEqual({ menu: false, run_start: false, run_finished: false, unpersisted: false, depth: 0 });
  });

  it('takes depth from floor_reached when the run never ended — the closed-tab case', async () => {
    await on(YESTERDAY, 'a', [START, floorAt(2), floorAt(4)]);
    await on(YESTERDAY, 'b', [START, floorAt(2), end('loss', 2), START, end('abandon', 5)]);
    const p = await firstDays(db, YESTERDAY, await newCohort(db, YESTERDAY));
    expect(p.get('a')?.depth).toBe(4);
    expect(p.get('b')?.depth).toBe(5);
  });

  it('flags an install whose session_start said its id was not kept', async () => {
    await on(YESTERDAY, 'lost', [lostId]);
    await on(YESTERDAY, 'kept', [{ name: 'session_start', props: { storage: 'new' } }]);
    const p = await firstDays(db, YESTERDAY, await newCohort(db, YESTERDAY));
    expect(p.get('lost')?.unpersisted).toBe(true);
    expect(p.get('kept')?.unpersisted).toBe(false);
  });

  it('is empty for an empty cohort', async () => {
    expect((await firstDays(db, YESTERDAY, new Map())).size).toBe(0);
  });
});

describe('firstDayNumbers', () => {
  it('emits all and every active host, with measured zeros and a depth row only where somebody is', () => {
    const cohort = new Map([
      ['a', 'web'],
      ['b', 'web'],
    ]);
    const profiles = new Map([
      ['a', { menu: true, run_start: true, run_finished: false, unpersisted: true, depth: 2 }],
      ['b', { menu: true, run_start: false, run_finished: false, unpersisted: false, depth: 0 }],
    ]);
    // `wechat` was active that day with no new installs: its zeros are measurements.
    const rows = firstDayNumbers(cohort, profiles, ['web', 'wechat']);
    const get = (metric: string, labels: Record<string, string>) =>
      rows.find((r) => r.metric === metric && JSON.stringify(r.labels) === JSON.stringify(labels))?.value;
    expect(get(NEW_METRICS.installs, { host: 'all' })).toBe(2);
    expect(get(NEW_METRICS.installs, { host: 'wechat' })).toBe(0);
    expect(get(NEW_METRICS.funnel, { host: 'web', step: 'menu' })).toBe(2);
    expect(get(NEW_METRICS.funnel, { host: 'web', step: 'run_start' })).toBe(1);
    expect(get(NEW_METRICS.funnel, { host: 'wechat', step: 'menu' })).toBe(0);
    expect(get(NEW_METRICS.unpersisted, { host: 'all' })).toBe(1);
    expect(get(NEW_METRICS.depth, { host: 'web', floor: '2' })).toBe(1);
    expect(rows.filter((r) => r.metric === NEW_METRICS.depth)).toHaveLength(2); // all + web, floor 2
    expect(rows.some((r) => r.labels.host === 'crazygames')).toBe(false);
    // `all` first, then hosts sorted.
    expect([...new Set(rows.map((r) => r.labels.host))]).toEqual(['all', 'web', 'wechat']);
  });
});

describe('activeHostsByDay', () => {
  it('groups the hosts seen on each day of the range', async () => {
    await on('2026-09-10', 'a');
    await on('2026-09-10', 'b', undefined, 'wechat');
    await on('2026-09-11', 'a');
    await on('2026-09-12', 'a');
    const m = await activeHostsByDay(db, '2026-09-10', '2026-09-11');
    expect([...m.keys()].sort()).toEqual(['2026-09-10', '2026-09-11']);
    expect([...(m.get('2026-09-10') ?? [])].sort()).toEqual(['web', 'wechat']);
  });
});

describe('newInstallRollupRows', () => {
  const rowsFor = (rows: Awaited<ReturnType<typeof newInstallRollupRows>>, metric: string, host = 'all') =>
    rows.filter((r) => r.metric === metric && r.labels.host === host);

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

  it('writes per-host rows only for a host active that day', async () => {
    await on('2026-09-10', 'w');
    await on('2026-09-10', 'x', undefined, 'wechat');
    await on('2026-09-11', 'w');
    const rows = await newInstallRollupRows(db, TODAY);
    expect(rowsFor(rows, NEW_METRICS.installs, 'wechat').map((r) => [r.day, r.value])).toEqual([['2026-09-10', 1]]);
    // The 11th had web activity only: web gets a measured 0, wechat gets nothing.
    expect(rowsFor(rows, NEW_METRICS.installs, 'web').map((r) => [r.day, r.value])).toEqual([
      ['2026-09-10', 1],
      ['2026-09-11', 0],
    ]);
    const d1 = (host: string) =>
      rowsFor(rows, NEW_METRICS.retention, host).find((r) => r.day === '2026-09-10' && r.labels.d === '1')?.value;
    expect([d1('all'), d1('web'), d1('wechat')]).toEqual([0.5, 1, 0]);
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

    // A second cycle the same day: the 10th's per-day rows and its cells are in the record, so
    // only yesterday's per-day rows and the newest cohort at each offset come back.
    const rows = await newInstallRollupRows(db, TODAY);
    expect([...new Set(rows.filter((r) => r.metric !== NEW_METRICS.retention && r.metric !== NEW_METRICS.cohortSize).map((r) => r.day))]).toEqual([
      YESTERDAY,
    ]);
    const cells = rowsFor(rows, NEW_METRICS.retention).map((r) => `${r.day}/D${r.labels.d}`);
    // The newest D2 cohort is the 17th, b's first day; every other newest cohort is empty, and
    // the 10th at D7 is not newest (that is the 12th).
    expect(cells).toEqual(['2026-09-17/D2']);
  });

  it('skips a cell whose recorded cohort size the source no longer backs', async () => {
    // A `new_installs` row for a day with no `dailyActive` documents behind it — the record
    // and the source disagree. The answer is no cell, not a 0% one.
    await dailyRollupOf(db).insertOne({
      day: '2026-09-10',
      metric: NEW_METRICS.installs,
      labels: '{"host":"all"}',
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
    const d1 = await dailyRollupOf(db).findOne({ day: '2026-09-10', metric: NEW_METRICS.retention, labels: '{"d":"1","host":"all"}' });
    expect(d1?.value).toBe(1);
  });
});

describe('newInstallGauges', () => {
  it('offers yesterday\'s first-day numbers and the newest non-empty cohort per offset, per host', async () => {
    await on('2026-09-18', 'a');
    await on(YESTERDAY, 'a');
    await on(YESTERDAY, 'b', [MENU, START, floorAt(2)], 'crazygames');
    await on(YESTERDAY, 'c', [lostId], 'crazygames');
    const g = await newInstallGauges(db, TODAY);
    const val = (name: string, labels: Record<string, string>) =>
      g.find((m) => m.name === name && JSON.stringify(m.labels) === JSON.stringify(labels))?.value;
    expect(val('bb_new_installs', { host: 'all' })).toBe(2);
    expect(val('bb_new_installs', { host: 'web' })).toBe(0);
    expect(val('bb_new_funnel_installs', { host: 'crazygames', step: 'run_start' })).toBe(1);
    expect(val('bb_new_unpersisted_installs', { host: 'crazygames' })).toBe(1);
    expect(val('bb_new_depth_installs', { host: 'all', floor: '2' })).toBe(1);
    // Only the 18th (D1) has a new install among the newest cohorts; every other offset is
    // absent rather than 0.
    const ratios = g.filter((m) => m.name === 'bb_new_retention_ratio');
    expect(ratios.map((m) => [m.labels?.host, m.labels?.d, m.value])).toEqual([
      ['all', '1', 1],
      ['web', '1', 1],
    ]);
    expect(val('bb_new_cohort_size', { host: 'all', d: '1' })).toBe(1);
    expect(g.every((m) => m.help.length > 0 && m.type === 'gauge')).toBe(true);
  });
});
