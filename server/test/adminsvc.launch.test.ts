/**
 * The console's launch section — `views/launch.ts` (against a real mongod, seeded by the
 * shipped `persistRollup`, for the reason `adminsvc.newInstalls.test.ts` gives) and
 * `launchSection` (pure).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Db } from 'mongodb';
import { dailyRollupOf, ensureAnalyticsIndexes } from '../src/analytics/db';
import { writeBatch } from '../src/analytics/store';
import { persistRollup } from '../src/analytics/rollup';
import { launchView, type LaunchView, type SegmentRow } from '../src/adminsvc/views/launch';
import { fmtSeconds, launchSection } from '../src/adminsvc/page/launch';
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

type Ev = { name: string; props?: Record<string, string | number> };

async function send(day: string, install: string, session: string, events: Ev[], host = 'web'): Promise<void> {
  const atMs = Date.parse(`${day}T06:00:00Z`);
  await writeBatch(
    db,
    {
      install,
      session,
      host: host as never,
      build: '1.0.0',
      locale: 'en',
      events: events.map((e, i) => ({ name: e.name as never, atMs: atMs + i, props: e.props ?? {} })),
    },
    null,
  );
}

const rollUpTo = async (today: string): Promise<void> => {
  await persistRollup(db, today, Date.parse(`${today}T01:00:00Z`));
};

describe('launchView', () => {
  it('is empty before any launch row exists', async () => {
    expect(await launchView(db)).toEqual({ host: 'all', days: [], segments: { source: [], device: [], os: [], browser: [] } });
  });

  it('reads the open funnel, boot time and playtime per day, newest first', async () => {
    await send('2026-09-10', 'a', 'v-a', [
      { name: 'page_open' },
      { name: 'session_start', props: { source: 'reddit', device: 'phone', boot_ms: 2500 } },
      { name: 'screen_view', props: { screen: 'menu' } },
      { name: 'session_end', props: { duration_s: 100, active_s: 90 } },
    ]);
    await send('2026-09-10', 'v-b', 'v-b', [{ name: 'page_open' }]);
    await rollUpTo('2026-09-11');
    await send('2026-09-11', 'c', 'v-c', [{ name: 'session_start' }], 'crazygames');
    await rollUpTo('2026-09-12');

    const view = await launchView(db);
    expect(view.days.map((d) => d.day)).toEqual(['2026-09-11', '2026-09-10']);
    const [d11, d10] = view.days;
    expect(d10.open).toEqual({ open: 2, boot: 1, menu: 1, run_start: 0 });
    expect([d10.bootP50, d10.bootP90]).toEqual([2500, 2500]);
    expect([d10.measured, d10.avgS, d10.p50S]).toEqual([1, 90, 90]);
    expect(d10.buckets[0]).toEqual([0, 0]);
    expect(d10.buckets[1]).toEqual([1, 1]);
    expect(d10.buckets.map(([b]) => b)).toEqual([0, 1, 3, 5, 10, 20, 30, 60]);
    // The 11th: no opens (absent, not zero) and a new install with no playtime report.
    expect(d11.open).toBeNull();
    expect([d11.bootP50, d11.measured, d11.avgS]).toEqual([null, 0, null]);
    expect(d11.buckets).toEqual([]);

    const reddit = view.segments.source.find((r) => r.value === 'reddit') as SegmentRow;
    expect(reddit).toMatchObject({ installs: 1, menu: 1, run_start: 0, playtimeN: 1, playtimeS: 90 });
    // D1 of the 10th is known (the 11th was rolled up), and nobody came back.
    expect(reddit.returns[1]).toEqual({ back: 0, base: 1 });
    expect(reddit.returns[7]).toEqual({ back: 0, base: 0 });
    // Sorted by installs, then name.
    expect(view.segments.source.map((r) => r.value)).toEqual(['direct', 'reddit']);
  });

  it('filters to one host and caps the days', async () => {
    await send('2026-09-10', 'a', 'v-a', [{ name: 'session_start' }], 'crazygames');
    await rollUpTo('2026-09-11');
    await send('2026-09-11', 'b', 'v-b', [{ name: 'session_start' }]);
    await rollUpTo('2026-09-12');
    const cg = await launchView(db, 'crazygames', 1);
    expect(cg.days.map((d) => d.day)).toEqual(['2026-09-11']);
    expect(cg.days[0].measured).toBeNull(); // crazygames was not active on the 11th
    expect(cg.segments.device).toEqual([]);
    expect((await launchView(db, 'crazygames')).segments.device.map((r) => r.installs)).toEqual([1]);
  });

  it('ignores rows whose labels it does not recognise', async () => {
    await send('2026-09-10', 'a', 'v-a', [{ name: 'page_open' }, { name: 'session_start' }]);
    await rollUpTo('2026-09-11');
    const day = '2026-09-10';
    const junk = (metric: string, labels: string): { day: string; metric: string; labels: string; value: number } => ({ day, metric, labels, value: 99 });
    await dailyRollupOf(db).insertMany([
      junk('open_funnel', '{"host":"all","step":"nope"}'),
      junk('open_boot_ms', '{"host":"all","q":"p99"}'),
      junk('new_playtime', '{"bucket":"7","host":"all"}'),
      junk('new_seg', '{"dim":"planet","host":"all","stat":"installs","value":"mars"}'),
      junk('new_seg', '{"dim":"os","host":"all","stat":"wat","value":"x"}'),
      junk('new_seg', '{"dim":"os","host":"all","stat":"installs","value":7}'),
      junk('new_seg', 'not json'),
      junk('new_seg', 'null'),
    ] as never);
    const view = await launchView(db);
    expect(view.days[0].open).toEqual({ open: 1, boot: 1, menu: 0, run_start: 0 });
    expect(view.days[0].buckets.some(([b]) => b === 7)).toBe(false);
    expect(view.days[0].bootP90).not.toBe(99);
    expect(view.segments.os.map((r) => r.value)).toEqual(['unknown']);
  });
});

describe('launchSection', () => {
  const row = (p: Partial<SegmentRow> = {}): SegmentRow => ({
    value: 'reddit',
    installs: 4,
    menu: 2,
    run_start: 1,
    run_finished: 0,
    playtimeN: 2,
    playtimeS: 125,
    returns: { 7: { back: 0, base: 0 }, 1: { back: 1, base: 4 } },
    ...p,
  });
  const view = (p: Partial<LaunchView> = {}): LaunchView => ({
    host: 'all',
    days: [
      { day: '2026-09-10', open: { open: 10, boot: 5, menu: 4, run_start: 2 }, bootP50: 2500, bootP90: 8000, measured: 4, avgS: 61, p50S: 30, buckets: [[0, 3], [1, 1]] },
      { day: '2026-09-09', open: null, bootP50: null, bootP90: null, measured: null, avgS: null, p50S: null, buckets: [] },
    ],
    segments: { source: [row()], device: [], os: [], browser: [] },
    ...p,
  });

  it('formats seconds as m:ss', () => {
    expect(fmtSeconds(null)).toBe('—');
    expect(fmtSeconds(0)).toBe('0:00');
    expect(fmtSeconds(61.4)).toBe('1:01');
    expect(fmtSeconds(-3)).toBe('0:00');
  });

  it('says so when there are no rows', () => {
    const html = launchSection(view({ days: [] }));
    expect(html).toContain('No launch rows yet');
    expect(html).not.toContain('<table>');
  });

  it('renders the day table with shares of the opens, and dashes for the unknown', () => {
    const html = launchSection(view());
    expect(html).toContain('<td class="num">10</td>');
    expect(html).toContain('<td class="num">5 <span class="dim">50.0%</span></td>');
    expect(html).toContain('2.5s / 8.0s');
    expect(html).toContain('<td class="num">1:01</td>');
    expect(html).toContain('<td>0m+:3 · 1m+:1</td>');
    // The 9th: every open cell a dash, the boot cell dashed on both sides, no histogram.
    expect(html).toContain('<tr><td>2026-09-09</td><td class="num dim">—</td>');
    expect(html).toContain('— / —');
    expect(html).toContain('<td></td></tr>');
  });

  it('renders a segment table per dimension that has rows, D1 before D7, dashes where unknown', () => {
    const html = launchSection(view());
    expect(html).toContain('<h3>By source</h3>');
    expect(html).not.toContain('By device');
    expect(html.indexOf('>D1<')).toBeLessThan(html.indexOf('>D7<'));
    expect(html).toContain('<td class="num" title="1 of 4">25.0%</td>');
    expect(html).toContain('<td class="num" title="over 2 measured">1:03</td>');
    expect(launchSection(view({ segments: { source: [row({ playtimeN: 0 })], device: [], os: [], browser: [] } }))).not.toContain('measured">');
  });

  it('escapes what came from a client', () => {
    const html = launchSection(view({ host: '<h>', segments: { source: [row({ value: '<script>' })], device: [], os: [], browser: [] } }));
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<h>');
    expect(html).toContain('&lt;script&gt;');
  });
});
