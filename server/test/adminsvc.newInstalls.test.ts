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
import { newInstallGrid, stepFromLabels, type NewInstallGrid } from '../src/adminsvc/views/newInstalls';
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

async function on(day: string, install: string, names: { name: string; props?: Record<string, string> }[]): Promise<void> {
  const atMs = Date.parse(`${day}T06:00:00Z`);
  await writeBatch(
    db,
    {
      install,
      session: `s-${install}-${day}`,
      host: 'web',
      build: '1.0.0',
      locale: 'en',
      events: names.map((e, i) => ({ name: e.name as never, atMs: atMs + i, props: e.props ?? {} })),
    },
    null,
  );
}

describe('stepFromLabels', () => {
  it('reads a known step and refuses everything else', () => {
    expect(stepFromLabels('{"step":"run_start"}')).toBe('run_start');
    expect(stepFromLabels('{"step":"nope"}')).toBeNull();
    expect(stepFromLabels('{"d":"1"}')).toBeNull();
    expect(stepFromLabels('null')).toBeNull();
    expect(stepFromLabels('not json')).toBeNull();
  });
});

describe('newInstallGrid', () => {
  it('assembles count, funnel and retention per first day, newest first', async () => {
    // 09-10: a and b are new; a reaches the menu and finishes a run, b only opens the game.
    // 09-11: a returns. One rollup cycle on 09-13 back-fills both days.
    await on('2026-09-10', 'a', [
      { name: 'screen_view', props: { screen: 'menu' } },
      { name: 'run_start' },
      { name: 'run_end', props: { outcome: 'win' } },
    ]);
    await on('2026-09-10', 'b', [{ name: 'session_start' }]);
    await on('2026-09-11', 'a', [{ name: 'session_start' }]);
    await persistRollup(db, '2026-09-13', 1);

    const grid = await newInstallGrid(db);
    expect(grid.rows.map((r) => r.day)).toEqual(['2026-09-12', '2026-09-11', '2026-09-10']);
    const first = grid.rows.find((r) => r.day === '2026-09-10');
    expect(first?.installs).toBe(2);
    expect(first?.funnel).toEqual({ menu: 1, run_start: 1, run_finished: 1 });
    expect(first?.cells[1]).toEqual({ rate: 0.5, size: 2 });
    expect(first?.cells[2]).toEqual({ rate: 0, size: 2 });
    // D3 for the 10th is the 13th — today, not complete — so it is unknown, not 0%.
    expect(first?.cells[3]).toBeNull();
    // The 11th had activity and no new installs: a measured 0 with no retention cells.
    const second = grid.rows.find((r) => r.day === '2026-09-11');
    expect(second?.installs).toBe(0);
    expect(second?.cells[1]).toBeNull();
  });

  it('shows a day with no new_* rows at all as missing, and ignores labels it does not know', async () => {
    // Hand-written on purpose: these are the malformed documents no writer produces.
    await dailyRollupOf(db).insertMany([
      { day: '2026-09-10', metric: NEW_METRICS.funnel, labels: '{"step":"bogus"}', value: 9, computedAt: 0 },
      { day: '2026-09-10', metric: NEW_METRICS.retention, labels: '{"host":"web"}', value: 9, computedAt: 0 },
      { day: '2026-09-10', metric: NEW_METRICS.retention, labels: '{"d":"1"}', value: 0.5, computedAt: 0 },
      { day: '2026-09-09', metric: 'dau', labels: '{"host":"all"}', value: 5, computedAt: 0 },
    ]);
    const grid = await newInstallGrid(db);
    // The `dau`-only day is not in the window — the window is over `new_*` days.
    expect(grid.rows.map((r) => r.day)).toEqual(['2026-09-10']);
    const row = grid.rows[0];
    expect(row.installs).toBeNull();
    expect(row.funnel).toEqual({ menu: null, run_start: null, run_finished: null });
    // A rate with no size row behind it is not shown.
    expect(row.cells[1]).toBeNull();
  });

  it('is empty on an empty collection', async () => {
    expect((await newInstallGrid(db)).rows).toEqual([]);
  });

  it('limits the window to the requested number of days', async () => {
    for (const day of ['2026-09-08', '2026-09-09', '2026-09-10']) {
      await dailyRollupOf(db).insertOne({ day, metric: NEW_METRICS.installs, labels: '{}', value: 1, computedAt: 0 });
    }
    expect((await newInstallGrid(db, 2)).rows.map((r) => r.day)).toEqual(['2026-09-10', '2026-09-09']);
  });
});

function grid(over: Partial<NewInstallGrid> = {}): NewInstallGrid {
  const nulls = { 2: null, 3: null, 4: null, 5: null, 6: null, 7: null };
  return {
    offsets: [1, 2, 3, 4, 5, 6, 7],
    steps: ['menu', 'run_start', 'run_finished'],
    rows: [
      { day: '2026-09-11', installs: 0, funnel: { menu: 0, run_start: 0, run_finished: 0 }, cells: { 1: null, ...nulls } },
      {
        day: '2026-09-10',
        installs: 4,
        funnel: { menu: 4, run_start: 2, run_finished: null },
        cells: { 1: { rate: 0.25, size: 4 }, ...nulls },
      },
      { day: '2026-09-09', installs: null, funnel: { menu: 1, run_start: 1, run_finished: 1 }, cells: { 1: null, ...nulls } },
    ],
    ...over,
  };
}

describe('newInstallSection', () => {
  it('shows each step as a count with its share of the day\'s new installs', () => {
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

  it('labels the steps and offsets', () => {
    const html = newInstallSection(grid());
    for (const h of ['Reached menu', 'Started a run', 'Finished a run', '>D1<', '>D7<']) expect(html).toContain(h);
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
