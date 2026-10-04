/**
 * The console's new-install grid — `views/newInstalls.ts` (against a real mongod, seeded by
 * the shipped `persistRollup`) and `newInstallSection` (pure).
 *
 * The fixture is produced by the real writer for the same reason `adminsvc.views.test.ts`'s
 * retention fixture is: a hand-written `dailyRollup` document would test this reader against
 * what the test author believes the rollup writes.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Db } from 'mongodb';
import { dailyRollupOf, ensureAnalyticsIndexes } from '../src/analytics/db';
import { writeBatch } from '../src/analytics/store';
import { persistRollup } from '../src/analytics/rollup';
import { NEW_METRICS } from '../src/analytics/newInstalls';
import { floorFromLabels, newInstallGrid, stepFromLabels, type NewInstallGrid } from '../src/adminsvc/views/newInstalls';
import { newInstallSection } from '../src/adminsvc/page/sections';
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

async function on(day: string, install: string, names: Ev[] = [{ name: 'session_start' }], host = 'web'): Promise<void> {
  const atMs = Date.parse(`${day}T06:00:00Z`);
  await writeBatch(
    db,
    {
      install,
      session: `s-${install}-${day}`,
      host: host as never,
      build: '1.0.0',
      locale: 'en',
      events: names.map((e, i) => ({ name: e.name as never, atMs: atMs + i, props: e.props ?? {} })),
    },
    null,
  );
}

describe('label parsers', () => {
  it('stepFromLabels reads a known step and refuses everything else', () => {
    expect(stepFromLabels('{"host":"all","step":"run_start"}')).toBe('run_start');
    expect(stepFromLabels('{"step":"nope"}')).toBeNull();
    expect(stepFromLabels('{"d":"1"}')).toBeNull();
    expect(stepFromLabels('null')).toBeNull();
    expect(stepFromLabels('not json')).toBeNull();
  });

  it('floorFromLabels reads a positive integer floor and refuses everything else', () => {
    expect(floorFromLabels('{"floor":"3","host":"all"}')).toBe(3);
    expect(floorFromLabels('{"floor":"0"}')).toBeNull();
    expect(floorFromLabels('{"floor":3}')).toBeNull();
    expect(floorFromLabels('nope')).toBeNull();
  });
});

describe('newInstallGrid', () => {
  it('assembles count, funnel, depth and retention per first day, newest first', async () => {
    // 09-10: a and b are new; a reaches the menu and wins a run on floor 2, b only opens the
    // game and its id is not kept. 09-11: a returns. One rollup cycle on 09-13 back-fills both.
    await on('2026-09-10', 'a', [
      { name: 'screen_view', props: { screen: 'menu' } },
      { name: 'run_start' },
      { name: 'run_end', props: { outcome: 'win', floor: 2 } },
    ]);
    await on('2026-09-10', 'b', [{ name: 'session_start', props: { storage: 'unpersisted' } }]);
    await on('2026-09-11', 'a');
    await persistRollup(db, '2026-09-13', 1);

    const grid = await newInstallGrid(db);
    expect(grid.host).toBe('all');
    expect(grid.hosts).toEqual(['all', 'web']);
    expect(grid.rows.map((r) => r.day)).toEqual(['2026-09-12', '2026-09-11', '2026-09-10']);
    const first = grid.rows.find((r) => r.day === '2026-09-10');
    expect(first?.installs).toBe(2);
    expect(first?.funnel).toEqual({ menu: 1, run_start: 1, run_finished: 1 });
    expect(first?.unpersisted).toBe(1);
    expect(first?.depth).toEqual([[2, 1]]);
    expect(first?.cells[1]).toEqual({ rate: 0.5, size: 2 });
    expect(first?.cells[2]).toEqual({ rate: 0, size: 2 });
    // D3 for the 10th is the 13th — today, not complete — so it is unknown, not 0%.
    expect(first?.cells[3]).toBeNull();
    // The 11th had activity and no new installs: a measured 0 with no retention cells.
    const second = grid.rows.find((r) => r.day === '2026-09-11');
    expect(second?.installs).toBe(0);
    expect(second?.depth).toEqual([]);
    expect(second?.cells[1]).toBeNull();
  });

  it("shows one host at a time, with the same days in view and a host's silent day as unknown", async () => {
    await on('2026-09-10', 'w');
    await on('2026-09-10', 'x', undefined, 'wechat');
    await on('2026-09-11', 'w');
    await persistRollup(db, '2026-09-13', 1);

    const wechat = await newInstallGrid(db, 'wechat');
    expect(wechat.hosts).toEqual(['all', 'web', 'wechat']);
    expect(wechat.rows.map((r) => [r.day, r.installs])).toEqual([
      ['2026-09-12', null],
      ['2026-09-11', null],
      ['2026-09-10', 1],
    ]);
    expect(wechat.rows[2].cells[1]).toEqual({ rate: 0, size: 1 });
    const web = await newInstallGrid(db, 'web');
    expect(web.rows[2].cells[1]).toEqual({ rate: 1, size: 1 });
    // A host nobody has is a grid of unknowns, not an error.
    expect((await newInstallGrid(db, 'nope')).rows.every((r) => r.installs === null)).toBe(true);
  });

  it('shows a day with no usable rows as missing, and ignores labels it does not know', async () => {
    // Hand-written on purpose: these are the malformed documents no writer produces.
    await dailyRollupOf(db).insertMany([
      { day: '2026-09-10', metric: NEW_METRICS.funnel, labels: '{"host":"all","step":"bogus"}', value: 9, computedAt: 0 },
      { day: '2026-09-10', metric: NEW_METRICS.depth, labels: '{"floor":"x","host":"all"}', value: 9, computedAt: 0 },
      { day: '2026-09-10', metric: NEW_METRICS.retention, labels: '{"host":"all"}', value: 9, computedAt: 0 },
      { day: '2026-09-10', metric: NEW_METRICS.retention, labels: '{"d":"1","host":"all"}', value: 0.5, computedAt: 0 },
      // No host label at all: belongs to no grid.
      { day: '2026-09-10', metric: NEW_METRICS.installs, labels: '{}', value: 7, computedAt: 0 },
      { day: '2026-09-09', metric: 'dau', labels: '{"host":"all"}', value: 5, computedAt: 0 },
    ]);
    const grid = await newInstallGrid(db);
    // The `dau`-only day is not in the window — the window is over `new_*` days.
    expect(grid.rows.map((r) => r.day)).toEqual(['2026-09-10']);
    const row = grid.rows[0];
    expect(row.installs).toBeNull();
    expect(row.funnel).toEqual({ menu: null, run_start: null, run_finished: null });
    expect(row.unpersisted).toBeNull();
    expect(row.depth).toEqual([]);
    // A rate with no size row behind it is not shown.
    expect(row.cells[1]).toBeNull();
  });

  it('is empty on an empty collection', async () => {
    const grid = await newInstallGrid(db);
    expect(grid.rows).toEqual([]);
    expect(grid.hosts).toEqual(['all']);
  });

  it('limits the window to the requested number of days', async () => {
    for (const day of ['2026-09-08', '2026-09-09', '2026-09-10']) {
      await dailyRollupOf(db).insertOne({ day, metric: NEW_METRICS.installs, labels: '{"host":"all"}', value: 1, computedAt: 0 });
    }
    expect((await newInstallGrid(db, 'all', 2)).rows.map((r) => r.day)).toEqual(['2026-09-10', '2026-09-09']);
  });
});

function grid(over: Partial<NewInstallGrid> = {}): NewInstallGrid {
  const nulls = { 2: null, 3: null, 4: null, 5: null, 6: null, 7: null };
  return {
    host: 'all',
    hosts: ['all', 'crazygames', 'web'],
    offsets: [1, 2, 3, 4, 5, 6, 7],
    steps: ['menu', 'run_start', 'run_finished'],
    rows: [
      {
        day: '2026-09-11',
        installs: 0,
        funnel: { menu: 0, run_start: 0, run_finished: 0 },
        unpersisted: 0,
        depth: [],
        cells: { 1: null, ...nulls },
      },
      {
        day: '2026-09-10',
        installs: 4,
        funnel: { menu: 4, run_start: 2, run_finished: null },
        unpersisted: 1,
        depth: [
          [1, 2],
          [3, 1],
        ],
        cells: { 1: { rate: 0.25, size: 4 }, ...nulls },
      },
      {
        day: '2026-09-09',
        installs: null,
        funnel: { menu: 1, run_start: 1, run_finished: 1 },
        unpersisted: null,
        depth: [],
        cells: { 1: null, ...nulls },
      },
    ],
    ...over,
  };
}

describe('newInstallSection', () => {
  it("shows each step as a count with its share of the day's new installs", () => {
    const html = newInstallSection(grid());
    expect(html).toContain('<td class="num">2 <span class="dim">50.0%</span></td>');
    expect(html).toContain('<td class="num">4 <span class="dim">100.0%</span></td>');
    expect(html).toContain('25.0%');
    expect(html).toContain('title="cohort of 4 new installs on 2026-09-10"');
  });

  it('never divides by an unknown or a zero cohort, and dashes an unknown cell', () => {
    const html = newInstallSection(grid());
    // The 11th: zero new installs, so counts with no share. The 9th: no count row, so counts
    // with no share and a dash where the size would be.
    expect(html).toContain('<tr><td>2026-09-11</td><td class="num">0</td><td class="num">0</td>');
    expect(html).toContain('<tr><td>2026-09-09</td><td class="num dim">—</td><td class="num">1</td>');
    expect(html).not.toContain('Infinity');
    expect(html).not.toContain('NaN');
    // run_finished unknown on the 10th.
    expect(html).toMatch(/2026-09-10<\/td>.*?<td class="num dim">—<\/td>/);
  });

  it('shows unpersisted ids with their share, and the depth histogram as floor:count', () => {
    const html = newInstallSection(grid());
    expect(html).toContain('<td class="num">1 <span class="dim">25.0%</span></td><td>1:2 · 3:1</td>');
    // A known day where nobody reached a floor is an EMPTY cell; an unknown day is a dash.
    expect(html).toMatch(/2026-09-11<\/td>(<td class="num">0<\/td>){5}<td><\/td>/);
    expect(html).toMatch(/2026-09-09<\/td>.*<td class="num">1<\/td><td class="num dim">—<\/td><td class="num dim">—<\/td>/);
  });

  it('links every other host and bolds the current one, escaping both', () => {
    const html = newInstallSection(grid({ host: 'web', hosts: ['all', 'web', '<x>'] }));
    expect(html).toContain('(web)');
    expect(html).toContain('<a href="/admin/?tab=retention&amp;host=all">all</a> · <b>web</b> · ');
    expect(html).toContain('host=%3Cx%3E">&lt;x&gt;</a>');
    expect(html).not.toContain('<x>');
  });

  it('labels the steps, the new columns and the offsets', () => {
    const html = newInstallSection(grid());
    for (const h of ['Reached menu', 'Started a run', 'Finished a run', 'ID not kept', 'Deepest floor', '>D1<', '>D7<']) {
      expect(html).toContain(h);
    }
  });

  it('falls back to the raw step id for a step it has no label for', () => {
    const html = newInstallSection(grid({ steps: ['menu', 'mystery' as never] }));
    expect(html).toContain('>mystery<');
  });

  it('says what an empty grid means rather than drawing an empty table', () => {
    const html = newInstallSection(grid({ rows: [] }));
    expect(html).toContain('No new-install rows yet');
    expect(html).not.toContain('<tbody>');
  });
});
