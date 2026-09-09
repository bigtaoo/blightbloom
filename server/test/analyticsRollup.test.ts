/**
 * The daily rollup — `src/analytics/rollup.ts`.
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
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { openAnalyticsDb } from '../src/analytics/db';
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

const TODAY = '2026-09-09';
const NOW_MS = Date.UTC(2026, 8, 9, 12, 0, 0);

let db: DatabaseSync;
beforeEach(() => {
  db = openAnalyticsDb(':memory:');
});
afterEach(() => {
  db.close();
});

/** Record `install` as active on `day`, via the real write path. */
function active(day: string, install: string, host: IngestedBatch['host'] = 'web', name = 'session_start'): void {
  const atMs = Date.parse(`${day}T06:00:00Z`);
  writeBatch(
    db,
    { install, session: `s-${install}-${day}`, host, build: '1.0.0', locale: 'en', events: [{ name: name as never, atMs, props: {} }] },
    null,
  );
}

/** Record one `screen_view` for `screen` on `day`. */
function view(day: string, install: string, screen: string): void {
  writeBatch(
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
  it('counts an install once however many events it sent', () => {
    active('2026-09-08', 'i-1');
    active('2026-09-08', 'i-1', 'web', 'store_purchase');
    active('2026-09-08', 'i-2');
    expect(dau(db, '2026-09-08')).toBe(2);
  });

  it('is zero for a day with nothing in it', () => {
    expect(dau(db, '2026-09-08')).toBe(0);
    expect(dauByHost(db, '2026-09-08')).toEqual([]);
    expect(eventCounts(db, '2026-09-08')).toEqual([]);
  });

  it('splits by host as a PARTITION — the parts sum to the total', () => {
    active('2026-09-08', 'i-1', 'web');
    active('2026-09-08', 'i-2', 'crazygames');
    active('2026-09-08', 'i-3', 'wechat');
    // The switcher: already counted on web, appears again on crazygames.
    active('2026-09-08', 'i-1', 'crazygames');
    const parts = dauByHost(db, '2026-09-08');
    expect(parts.reduce((s, p) => s + p.n, 0)).toBe(dau(db, '2026-09-08'));
    expect(parts).toEqual([
      { host: 'crazygames', n: 1 },
      { host: 'web', n: 1 },
      { host: 'wechat', n: 1 },
    ]);
  });

  it('counts events by name, not installs', () => {
    active('2026-09-08', 'i-1');
    active('2026-09-08', 'i-1', 'web', 'store_purchase');
    active('2026-09-08', 'i-2', 'web', 'store_purchase');
    expect(eventCounts(db, '2026-09-08')).toEqual([
      { name: 'session_start', n: 1 },
      { name: 'store_purchase', n: 2 },
    ]);
  });
});

describe('screenViewCounts', () => {
  it('splits one event NAME by the screen inside its props', () => {
    // The reason this function exists: the whole early funnel is one event name with a
    // field, so counting by name alone collapses every step into a single number.
    view('2026-09-08', 'a', 'menu');
    view('2026-09-08', 'b', 'menu');
    view('2026-09-08', 'c', 'forge');
    expect(screenViewCounts(db, '2026-09-08')).toEqual([
      { screen: 'forge', n: 1 },
      { screen: 'menu', n: 2 },
    ]);
  });

  it('is empty for a day with no screen views', () => {
    active('2026-09-08', 'a');
    expect(screenViewCounts(db, '2026-09-08')).toEqual([]);
  });

  it('ignores events that are not screen views, even with a screen-shaped prop', () => {
    // `json_extract` on the right ROWS, not just the right field: a `run_start` carrying a
    // `character` must not become a screen, and a name filter is what stops it.
    active('2026-09-08', 'a', 'web', 'run_start');
    view('2026-09-08', 'b', 'menu');
    expect(screenViewCounts(db, '2026-09-08')).toEqual([{ screen: 'menu', n: 1 }]);
  });

  it('ignores a screen_view whose props somehow carry no screen', () => {
    // The parser drops a bad `screen`, so an event with an unusable one still lands as a
    // row with `props = {}`. It must not become a `null` bucket on the dashboard.
    writeBatch(
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
    expect(screenViewCounts(db, '2026-09-08')).toEqual([]);
  });

  it('counts views, not installs — a player who backtracks contributes twice', () => {
    view('2026-09-08', 'a', 'forge');
    view('2026-09-08', 'a', 'forge');
    expect(screenViewCounts(db, '2026-09-08')).toEqual([{ screen: 'forge', n: 2 }]);
  });
});

describe('cohortRate — unknown is not zero', () => {
  it('computes a rate when both days are complete', () => {
    active('2026-09-06', 'a');
    active('2026-09-06', 'b');
    active('2026-09-07', 'a');
    const r = cohortRate(db, '2026-09-06', 1, TODAY);
    expect(r).toEqual({ cohortDay: '2026-09-06', offset: 1, size: 2, returned: 1, rate: 0.5 });
  });

  it('reports 0 — not null — when the day arrived and nobody returned', () => {
    active('2026-09-06', 'a');
    active('2026-09-07', 'z'); // somebody was active, just not from the cohort
    const r = cohortRate(db, '2026-09-06', 1, TODAY);
    expect(r).not.toBeNull();
    expect(r!.rate).toBe(0);
    expect(r!.returned).toBe(0);
  });

  it('reports null — not 0 — when the offset day has not finished', () => {
    active('2026-09-08', 'a');
    // 2026-09-08 + 1 = today, which is still running.
    expect(cohortRate(db, '2026-09-08', 1, TODAY)).toBeNull();
  });

  it('reports null for a cohort nobody was in', () => {
    active('2026-09-07', 'a');
    expect(cohortRate(db, '2026-09-01', 1, TODAY)).toBeNull();
  });

  it('is exactly answerable at the boundary and not one day sooner', () => {
    active('2026-09-01', 'a');
    active('2026-09-08', 'a');
    // cohort + 7 = 2026-09-08 = lastCompleteDay → answerable.
    expect(cohortRate(db, '2026-09-01', 7, TODAY)!.rate).toBe(1);
    // cohort + 8 = today → not answerable.
    expect(cohortRate(db, '2026-09-01', 8, TODAY)).toBeNull();
  });

  it('counts a returning install once even if it was active on many days', () => {
    active('2026-09-06', 'a');
    active('2026-09-07', 'a');
    active('2026-09-07', 'a', 'web', 'store_purchase');
    expect(cohortRate(db, '2026-09-06', 1, TODAY)!.returned).toBe(1);
  });

  it('never reports a rate above 1', () => {
    for (const d of ['2026-09-05', '2026-09-06', '2026-09-07']) {
      active(d, 'a');
      active(d, 'b');
    }
    for (const offset of RETENTION_OFFSETS) {
      const r = cohortRate(db, '2026-09-05', offset, TODAY);
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
  it('emits nothing at all on an empty database', () => {
    // The launch-week case. A zero here would read as "nobody ever came back".
    expect(retentionGauges(db, TODAY)).toEqual([]);
  });

  it('emits only the offsets it can answer', () => {
    // One cohort on 09-07 returning on 09-08: D1 is answerable, D2..D7 are not.
    active('2026-09-07', 'a');
    active('2026-09-08', 'a');
    const gauges = retentionGauges(db, TODAY);
    const offsets = gauges.filter((g) => g.name === 'bb_retention_ratio').map((g) => g.labels!.d);
    expect(offsets).toEqual(['1']);
  });

  it('pairs every rate with the cohort size behind it', () => {
    active('2026-09-07', 'a');
    active('2026-09-08', 'a');
    const gauges = retentionGauges(db, TODAY);
    expect(gauges.map((g) => g.name)).toEqual(['bb_retention_ratio', 'bb_retention_cohort_size']);
    expect(gauges[0]!.value).toBe(1);
    expect(gauges[1]!.value).toBe(1);
  });

  it('does not emit a zero for an offset whose cohort exists but is unaged', () => {
    active('2026-09-08', 'a');
    const gauges = retentionGauges(db, TODAY);
    expect(gauges).toEqual([]);
  });
});

describe('rollupMetrics', () => {
  it('always reports DAU, including zero, and describes the last COMPLETE day', () => {
    // DAU zero is a real measurement (nobody played yesterday) — unlike retention, whose
    // zero would be a claim about people who might still come back.
    const m = rollupMetrics(db, TODAY);
    const total = m.find((x) => x.name === 'bb_dau' && x.labels?.host === 'all');
    expect(total?.value).toBe(0);
  });

  it('reports yesterday, not today', () => {
    active('2026-09-08', 'yesterday');
    active(TODAY, 'today');
    const m = rollupMetrics(db, TODAY);
    expect(m.find((x) => x.name === 'bb_dau' && x.labels?.host === 'all')?.value).toBe(1);
  });

  it('carries per-host DAU, per-event counts and retention together', () => {
    active('2026-09-07', 'a');
    active('2026-09-08', 'a', 'crazygames');
    view('2026-09-08', 'a', 'forge');
    const names = new Set(rollupMetrics(db, TODAY).map((m) => m.name));
    expect([...names].sort()).toEqual([
      'bb_dau',
      'bb_events_day',
      'bb_retention_cohort_size',
      'bb_retention_ratio',
      'bb_screen_views_day',
    ]);
  });

  it('declares one help string per metric name', () => {
    // Prometheus rejects a scrape that declares the same metric name twice with different
    // help text, and it presents as "the target is down" rather than as a format complaint.
    active('2026-09-08', 'a', 'web');
    active('2026-09-08', 'b', 'wechat');
    const help = new Map<string, Set<string>>();
    for (const m of rollupMetrics(db, TODAY)) {
      if (!help.has(m.name)) help.set(m.name, new Set());
      help.get(m.name)!.add(m.help);
    }
    for (const [name, set] of help) expect(set.size, `${name} has ${set.size} help strings`).toBe(1);
  });
});

describe('persistRollup', () => {
  it('writes a row per number and is idempotent', () => {
    active('2026-09-08', 'a');
    const first = persistRollup(db, TODAY, NOW_MS);
    expect(first).toBeGreaterThan(0);
    const rows = () => Number((db.prepare('SELECT COUNT(*) AS n FROM daily_rollup').get() as { n: number }).n);
    const after = rows();
    persistRollup(db, TODAY, NOW_MS + 1000);
    expect(rows()).toBe(after);
  });

  it('persists the screen-view split too, keyed by screen', () => {
    // The funnel's early steps are the half of `daily_rollup` that outlives Prometheus's
    // 15 days, so they have to be WRITTEN and not only exposed.
    view('2026-09-08', 'a', 'menu');
    view('2026-09-08', 'b', 'forge');
    persistRollup(db, TODAY, NOW_MS);
    const got = db
      .prepare("SELECT labels, value FROM daily_rollup WHERE metric = 'screen_views' ORDER BY labels")
      .all() as { labels: string; value: number }[];
    expect(got).toEqual([
      { labels: '{"screen":"forge"}', value: 1 },
      { labels: '{"screen":"menu"}', value: 1 },
    ]);
  });

  it('files a retention row against the COHORT day, not the run day', () => {
    // The row says "this cohort returned at this rate", which is a fact about that day and
    // stays true. Filing it under today would make the same fact move every night.
    active('2026-09-07', 'a');
    active('2026-09-08', 'a');
    persistRollup(db, TODAY, NOW_MS);
    const row = db
      .prepare("SELECT day, value FROM daily_rollup WHERE metric = 'retention'")
      .get() as { day: string; value: number };
    expect(row.day).toBe('2026-09-07');
    expect(row.value).toBe(1);
  });

  it('records the DAU it computed, readable back by day and label', () => {
    active('2026-09-08', 'a', 'web');
    active('2026-09-08', 'b', 'wechat');
    persistRollup(db, TODAY, NOW_MS);
    const got = db
      .prepare("SELECT labels, value FROM daily_rollup WHERE day = '2026-09-08' AND metric = 'dau' ORDER BY labels")
      .all() as { labels: string; value: number }[];
    expect(got).toEqual([
      { labels: '{"host":"all"}', value: 2 },
      { labels: '{"host":"web"}', value: 1 },
      { labels: '{"host":"wechat"}', value: 1 },
    ]);
  });

  it('persists a day with no activity rather than skipping it', () => {
    // A gap in this table has to mean "the rollup did not run", not "nobody played" — those
    // are different facts and only one of them is a problem.
    expect(persistRollup(db, TODAY, NOW_MS)).toBe(1);
    const row = db.prepare('SELECT day, metric, value FROM daily_rollup').get() as {
      day: string;
      metric: string;
      value: number;
    };
    expect(row).toEqual({ day: '2026-09-08', metric: 'dau', value: 0 });
  });

  it('rolls back rather than leaving half a day written', () => {
    active('2026-09-08', 'a');
    db.exec(`CREATE TRIGGER no_rollup BEFORE INSERT ON daily_rollup
             BEGIN SELECT RAISE(ABORT, 'nope'); END`);
    expect(() => persistRollup(db, TODAY, NOW_MS)).toThrow(/nope/);
    expect(Number((db.prepare('SELECT COUNT(*) AS n FROM daily_rollup').get() as { n: number }).n)).toBe(0);
  });
});

describe('canonicalLabels', () => {
  it('is independent of the order the object was built in', () => {
    // The primary key is (day, metric, labels), so two callers producing the same label set
    // in different orders would otherwise write two rows for one number.
    expect(canonicalLabels({ host: 'web', d: '1' })).toBe(canonicalLabels({ d: '1', host: 'web' }));
  });

  it('is an object even when empty', () => {
    expect(canonicalLabels({})).toBe('{}');
  });
});
