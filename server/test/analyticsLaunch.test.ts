/**
 * The launch numbers (design/21 §2.9) — `newInstallSegments.ts` and `pageOpens.ts`, the pure
 * row builders directly and the reads against a real mongod, seeded through the shipped
 * `writeBatch` so the documents are the ones ingest really writes.
 *
 * The rules worth pinning are each an absence: an install with no playtime report is
 * UNMEASURED (not 0 s, not in the average), a page that never booted is NOT an active install,
 * and a day with no opens writes no open funnel rather than a row of zeros.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Db } from 'mongodb';
import { dailyActiveOf, ensureAnalyticsIndexes } from '../src/analytics/db';
import { writeBatch } from '../src/analytics/store';
import type { IngestedBatch } from '../src/analytics/ingest';
import { newCohort, type Cohort, type FirstDay } from '../src/analytics/newInstallQueries';
import { newInstallGauges, newInstallRollupRows } from '../src/analytics/newInstalls';
import {
  MAX_SOURCES,
  OTHER_SOURCE,
  SEGMENT_METRICS,
  firstDayVisits,
  playtimeBucket,
  playtimeNumbers,
  segmentNumbers,
  segmentReturns,
  type Visit,
} from '../src/analytics/newInstallSegments';
import { OPEN_METRICS, openFunnelNumbers, openVisits, quantile } from '../src/analytics/pageOpens';
import { openTestMongo, type MongoTestContext } from './mongoHarness';

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

type Ev = { name: string; props?: Record<string, string | number>; at?: string };

/** One batch from `install`'s visit `session` on `day` (06:00 UTC unless an event says when). */
async function send(day: string, install: string, session: string, events: Ev[], host = 'web'): Promise<void> {
  const base = Date.parse(`${day}T06:00:00Z`);
  await writeBatch(
    db,
    {
      install,
      session,
      host: host as IngestedBatch['host'],
      build: '1.0.0',
      locale: 'en',
      events: events.map((e, i) => ({ name: e.name as never, atMs: e.at === undefined ? base + i : Date.parse(e.at), props: e.props ?? {} })),
    },
    null,
  );
}

const visit = (v: Partial<Visit> = {}): Visit => ({ source: 'direct', device: 'desktop', os: 'windows', browser: 'chrome', playtime_s: null, ...v });
const label = (rows: { metric: string; labels: Record<string, string>; value: number }[], metric: string, labels: Record<string, string>): number | undefined =>
  rows.find((r) => r.metric === metric && Object.entries(labels).every(([k, v]) => r.labels[k] === v) && Object.keys(r.labels).length === Object.keys(labels).length)?.value;

describe('playtime buckets and rows (pure)', () => {
  it('puts a playtime in the bucket of its lower bound', () => {
    expect(playtimeBucket(0)).toBe(0);
    expect(playtimeBucket(59)).toBe(0);
    expect(playtimeBucket(60)).toBe(1);
    expect(playtimeBucket(179)).toBe(1);
    expect(playtimeBucket(180)).toBe(3);
    expect(playtimeBucket(3599)).toBe(30);
    expect(playtimeBucket(99_999)).toBe(60);
  });

  it('averages over the measured only, and writes every bucket where any is measured', () => {
    const cohort: Cohort = new Map([['a', 'web'], ['b', 'web'], ['c', 'crazygames'], ['d', 'crazygames']]);
    const visits = new Map([
      ['a', visit({ playtime_s: 30 })],
      ['b', visit({ playtime_s: 100 })],
      ['c', visit({ playtime_s: 601 })],
      ['d', visit()], // unmeasured: not 0, not in the average
    ]);
    const rows = playtimeNumbers(cohort, visits, ['web', 'crazygames', 'wechat']);
    expect(label(rows, SEGMENT_METRICS.playtimeMeasured, { host: 'all' })).toBe(3);
    expect(label(rows, SEGMENT_METRICS.playtimeAvg, { host: 'all' })).toBe(244); // 731 / 3, rounded
    expect(label(rows, SEGMENT_METRICS.playtimeP50, { host: 'all' })).toBe(100);
    expect(label(rows, SEGMENT_METRICS.playtimeP50, { host: 'web' })).toBe(65); // even count: mean of the middle two
    expect(label(rows, SEGMENT_METRICS.playtimeMeasured, { host: 'crazygames' })).toBe(1);
    expect(label(rows, SEGMENT_METRICS.playtime, { host: 'all', bucket: '0' })).toBe(1);
    expect(label(rows, SEGMENT_METRICS.playtime, { host: 'all', bucket: '1' })).toBe(1);
    expect(label(rows, SEGMENT_METRICS.playtime, { host: 'all', bucket: '10' })).toBe(1);
    expect(label(rows, SEGMENT_METRICS.playtime, { host: 'all', bucket: '60' })).toBe(0);
    // An active host with nothing measured: the count 0 and NOTHING else.
    expect(label(rows, SEGMENT_METRICS.playtimeMeasured, { host: 'wechat' })).toBe(0);
    expect(rows.filter((r) => r.labels.host === 'wechat')).toHaveLength(1);
  });

  it('keeps a member whose host was not passed as active', () => {
    const rows = playtimeNumbers(new Map([['a', 'web']]), new Map([['a', visit({ playtime_s: 5 })]]), []);
    expect(label(rows, SEGMENT_METRICS.playtimeMeasured, { host: 'all' })).toBe(1);
    expect(rows.some((r) => r.labels.host === 'web')).toBe(false);
  });
});

describe('segment rows (pure)', () => {
  const profile = (p: Partial<FirstDay> = {}): FirstDay => ({ menu: false, run_start: false, run_finished: false, unpersisted: false, depth: 0, ...p });

  it('counts installs, funnel steps and measured playtime per host × dimension × value', () => {
    const cohort: Cohort = new Map([['a', 'web'], ['b', 'web'], ['c', 'crazygames']]);
    const visits = new Map([
      ['a', visit({ source: 'reddit', device: 'phone', playtime_s: 120 })],
      ['b', visit({ source: 'reddit' })],
      ['c', visit({ playtime_s: 30 })],
    ]);
    const profiles = new Map([['a', profile({ menu: true, run_start: true })], ['b', profile({ menu: true })], ['c', profile()]]);
    const rows = segmentNumbers(cohort, profiles, visits);
    const seg = (host: string, dim: string, value: string, stat: string): number | undefined =>
      label(rows, SEGMENT_METRICS.segment, { host, dim, value, stat });
    expect(seg('all', 'source', 'reddit', 'installs')).toBe(2);
    expect(seg('all', 'source', 'reddit', 'menu')).toBe(2);
    expect(seg('all', 'source', 'reddit', 'run_start')).toBe(1);
    expect(seg('all', 'source', 'reddit', 'playtime_n')).toBe(1);
    expect(seg('all', 'source', 'reddit', 'playtime_s')).toBe(120);
    expect(seg('web', 'device', 'phone', 'installs')).toBe(1);
    expect(seg('crazygames', 'source', 'direct', 'playtime_s')).toBe(30);
    expect(seg('crazygames', 'source', 'reddit', 'installs')).toBeUndefined();
  });

  it('treats a member with no visit as direct/unknown', () => {
    const rows = segmentNumbers(new Map([['a', 'web']]), new Map(), new Map());
    expect(label(rows, SEGMENT_METRICS.segment, { host: 'all', dim: 'source', value: 'direct', stat: 'installs' })).toBe(1);
    expect(label(rows, SEGMENT_METRICS.segment, { host: 'all', dim: 'os', value: 'unknown', stat: 'installs' })).toBe(1);
    expect(label(rows, SEGMENT_METRICS.segment, { host: 'all', dim: 'source', value: 'direct', stat: 'menu' })).toBe(0);
  });

  it(`folds sources beyond the top ${MAX_SOURCES} into "${OTHER_SOURCE}", ties broken by name`, () => {
    const cohort: Cohort = new Map();
    const visits = new Map<string, Visit>();
    // s00 has 3 installs, s01 2, then s02..s21 one each: 22 sources, 2 must fold.
    const add = (install: string, source: string): void => {
      cohort.set(install, 'web');
      visits.set(install, visit({ source }));
    };
    add('a0', 's00'); add('a1', 's00'); add('a2', 's00'); add('b0', 's01'); add('b1', 's01');
    for (let i = 2; i < 22; i += 1) add(`c${i}`, `s${String(i).padStart(2, '0')}`);
    const rows = segmentNumbers(cohort, new Map(), visits).filter((r) => r.labels.host === 'all' && r.labels.dim === 'source' && r.labels.stat === 'installs');
    expect(rows).toHaveLength(MAX_SOURCES + 1);
    expect(rows.find((r) => r.labels.value === OTHER_SOURCE)?.value).toBe(2);
    expect(rows.some((r) => r.labels.value === 's20' || r.labels.value === 's21')).toBe(false);
    expect(rows.some((r) => r.labels.value === 's19')).toBe(true);
  });
});

describe('open funnel (pure)', () => {
  it('takes the nearest-rank quantile', () => {
    expect(quantile([10], 0.9)).toBe(10);
    expect(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.5)).toBe(5);
    expect(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9);
    expect(quantile([1, 2], 0)).toBe(1);
  });

  it('writes nothing for a day with no opens', () => {
    expect(openFunnelNumbers(new Map())).toEqual([]);
  });

  it('counts each step per host, and boot quantiles only where something booted', () => {
    const v = (host: string, boot: boolean, bootMs: number | null, menu = false, run_start = false) => ({ host, boot, bootMs, menu, run_start });
    const rows = openFunnelNumbers(
      new Map([
        ['1', v('web', true, 2000, true, true)],
        ['2', v('web', true, 4000, true)],
        ['3', v('web', false, null)],
        ['4', v('crazygames', false, null)],
      ]),
    );
    expect(label(rows, OPEN_METRICS.funnel, { host: 'all', step: 'open' })).toBe(4);
    expect(label(rows, OPEN_METRICS.funnel, { host: 'all', step: 'boot' })).toBe(2);
    expect(label(rows, OPEN_METRICS.funnel, { host: 'web', step: 'menu' })).toBe(2);
    expect(label(rows, OPEN_METRICS.funnel, { host: 'web', step: 'run_start' })).toBe(1);
    expect(label(rows, OPEN_METRICS.bootMs, { host: 'web', q: 'p50' })).toBe(2000);
    expect(label(rows, OPEN_METRICS.bootMs, { host: 'web', q: 'p90' })).toBe(4000);
    expect(label(rows, OPEN_METRICS.funnel, { host: 'crazygames', step: 'open' })).toBe(1);
    expect(rows.some((r) => r.metric === OPEN_METRICS.bootMs && r.labels.host === 'crazygames')).toBe(false);
  });
});

describe('page_open in the store', () => {
  it('stores the event but never makes its sender an active install', async () => {
    await send('2026-09-10', 'v-1', 'v-1', [{ name: 'page_open' }]);
    expect(await dailyActiveOf(db).countDocuments({})).toBe(0);
    await send('2026-09-10', 'i-1', 'v-2', [{ name: 'page_open' }, { name: 'session_start' }]);
    expect(await dailyActiveOf(db).find({}, { projection: { _id: 0, install: 1 } }).toArray()).toEqual([{ install: 'i-1' }]);
  });
});

describe('first-day visits (mongod)', () => {
  it('takes the first session_start\'s context and sums each visit\'s largest playtime report', async () => {
    const day = '2026-09-10';
    await send(day, 'a', 'a1', [
      { name: 'session_start', props: { source: 'reddit', device: 'phone', os: 'ios', browser: 'safari' } },
      { name: 'active_time', props: { active_s: 60 } },
      { name: 'active_time', props: { active_s: 120 } },
      { name: 'session_end', props: { duration_s: 300, active_s: 130 } },
    ]);
    // A second visit, later the same day, from another context: the first one's wins, and
    // its 50 s add to the 130.
    await send(day, 'a', 'a2', [
      { name: 'session_start', props: { source: 'direct', device: 'desktop' }, at: `${day}T09:00:00Z` },
      { name: 'session_end', props: { duration_s: 60, active_s: 50 }, at: `${day}T09:01:00Z` },
    ]);
    // A pre-change client: a session_start with none of the new props and no report.
    await send(day, 'b', 'b1', [{ name: 'session_start' }]);
    const cohort = await newCohort(db, day);
    const visits = await firstDayVisits(db, day, cohort);
    expect(visits.get('a')).toEqual({ source: 'reddit', device: 'phone', os: 'ios', browser: 'safari', playtime_s: 180 });
    expect(visits.get('b')).toEqual({ source: 'direct', device: 'unknown', os: 'unknown', browser: 'unknown', playtime_s: null });
  });

  it('gives a member with no session_start that day the empty context, keeping any playtime', async () => {
    const day = '2026-09-10';
    await send(day, 'c', 'c1', [{ name: 'active_time', props: { active_s: 70 } }]);
    const visits = await firstDayVisits(db, day, await newCohort(db, day));
    expect(visits.get('c')).toEqual({ source: 'direct', device: 'unknown', os: 'unknown', browser: 'unknown', playtime_s: 70 });
  });

  it('reads nothing for an empty cohort', async () => {
    expect((await firstDayVisits(db, '2026-09-10', new Map())).size).toBe(0);
    expect(await segmentReturns(db, new Map(), new Map(), 1, '2026-09-11')).toEqual([]);
  });

  it('counts returns per segment, zeros included', async () => {
    await send('2026-09-10', 'a', 'a1', [{ name: 'session_start', props: { source: 'reddit' } }]);
    await send('2026-09-10', 'b', 'b1', [{ name: 'session_start', props: { source: 'poki' } }]);
    await send('2026-09-11', 'a', 'a2', [{ name: 'session_start' }]);
    const cohort = await newCohort(db, '2026-09-10');
    const rows = await segmentReturns(db, cohort, await firstDayVisits(db, '2026-09-10', cohort), 1, '2026-09-11');
    expect(label(rows, SEGMENT_METRICS.segment, { host: 'all', dim: 'source', value: 'reddit', stat: 'd1' })).toBe(1);
    expect(label(rows, SEGMENT_METRICS.segment, { host: 'all', dim: 'source', value: 'poki', stat: 'd1' })).toBe(0);
  });
});

describe('open visits (mongod)', () => {
  it('joins each opened visit to what its session did, across midnight', async () => {
    const day = '2026-09-10';
    // Booted after midnight, reached the menu and a run.
    await send(day, 'v-a', 'v-a', [{ name: 'page_open', at: `${day}T23:59:50Z` }]);
    await send('2026-09-11', 'i-a', 'v-a', [
      { name: 'session_start', props: { boot_ms: 9000 }, at: '2026-09-11T00:00:01Z' },
      { name: 'screen_view', props: { screen: 'forge' }, at: '2026-09-11T00:00:02Z' },
      { name: 'screen_view', props: { screen: 'menu' }, at: '2026-09-11T00:00:03Z' },
      { name: 'run_start', at: '2026-09-11T00:00:04Z' },
    ]);
    // Booted (an old build with no boot_ms), never got further.
    await send(day, 'i-b', 'v-b', [{ name: 'page_open' }, { name: 'session_start' }], 'crazygames');
    // Bounced.
    await send(day, 'v-c', 'v-c', [{ name: 'page_open' }]);
    // A session with no open is not in the funnel at all.
    await send(day, 'i-d', 'v-d', [{ name: 'session_start', props: { boot_ms: 1 } }]);

    const visits = await openVisits(db, day);
    expect(Object.fromEntries(visits)).toEqual({
      'v-a': { host: 'web', boot: true, menu: true, run_start: true, bootMs: 9000 },
      'v-b': { host: 'crazygames', boot: true, menu: false, run_start: false, bootMs: null },
      'v-c': { host: 'web', boot: false, menu: false, run_start: false, bootMs: null },
    });
    expect((await openVisits(db, '2026-09-12')).size).toBe(0);
  });
});

describe('the launch rows in the new-install rollup', () => {
  it('writes playtime, segments, the open funnel and segment returns, and gauges the playtime', async () => {
    const day = '2026-09-10';
    await send(day, 'i-a', 'v-a', [
      { name: 'page_open' },
      { name: 'session_start', props: { source: 'reddit', device: 'phone', boot_ms: 3000 } },
      { name: 'session_end', props: { duration_s: 400, active_s: 400 } },
    ]);
    await send('2026-09-11', 'i-a', 'v-a2', [{ name: 'session_start' }]);
    const rows = await newInstallRollupRows(db, '2026-09-12');
    const on = (metric: string, labels: Record<string, string>, d = day): number | undefined =>
      rows.find((r) => r.day === d && r.metric === metric && JSON.stringify(r.labels) === JSON.stringify(labels))?.value;
    expect(on(SEGMENT_METRICS.playtimeAvg, { host: 'all' })).toBe(400);
    expect(on(SEGMENT_METRICS.segment, { host: 'web', dim: 'source', value: 'reddit', stat: 'installs' })).toBe(1);
    expect(on(SEGMENT_METRICS.segment, { host: 'all', dim: 'device', value: 'phone', stat: 'd1' })).toBe(1);
    expect(on(OPEN_METRICS.funnel, { host: 'all', step: 'boot' })).toBe(1);
    expect(on(OPEN_METRICS.bootMs, { host: 'web', q: 'p50' })).toBe(3000);

    // The gauges describe the last complete day (the 11th, whose one active install is not
    // new): measured 0, and no average.
    const gauges = await newInstallGauges(db, '2026-09-12');
    expect(gauges.find((g) => g.name === 'bb_new_playtime_measured_installs' && g.labels?.host === 'all')?.value).toBe(0);
    expect(gauges.some((g) => g.name === 'bb_new_playtime_avg_seconds')).toBe(false);
    expect(gauges.some((g) => g.name.includes('seg'))).toBe(false);
    expect(gauges.some((g) => g.name.startsWith('bb_open_'))).toBe(false); // the 11th opened nothing
  });

  it('gauges the open funnel and boot time of the last complete day, per host', async () => {
    const day = '2026-09-11';
    await send(day, 'i-a', 'v-a', [{ name: 'page_open' }, { name: 'session_start', props: { boot_ms: 4000 } }]);
    await send(day, 'v-b', 'v-b', [{ name: 'page_open' }], 'crazygames');
    const gauges = await newInstallGauges(db, '2026-09-12');
    const at = (name: string, labels: Record<string, string>): number | undefined =>
      gauges.find((g) => g.name === name && JSON.stringify(g.labels) === JSON.stringify(labels))?.value;
    expect(at('bb_open_funnel_visits', { host: 'all', step: 'open' })).toBe(2);
    expect(at('bb_open_funnel_visits', { host: 'all', step: 'boot' })).toBe(1);
    expect(at('bb_open_funnel_visits', { host: 'crazygames', step: 'boot' })).toBe(0);
    expect(at('bb_open_boot_ms', { host: 'web', q: 'p90' })).toBe(4000);
    // A host where nothing booted has no boot time — absent, not 0.
    expect(gauges.some((g) => g.name === 'bb_open_boot_ms' && g.labels?.host === 'crazygames')).toBe(false);
  });
});
