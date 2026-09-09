/**
 * The rollup job — `src/analytics/job.ts` — plus `matchsvc.ts`'s `analyticsDbPathFromEnv`.
 *
 * The job is small, and every case here is about a failure mode that looks like success:
 *
 *   - **A cycle that throws must not kill the timer.** A job that dies on its first bad
 *     cycle leaves a dashboard showing the last good numbers forever, which is the worst
 *     possible presentation of "the rollup stopped".
 *   - **The cache holds the last GOOD answer**, so a bad cycle costs freshness rather than
 *     replacing real numbers with nothing.
 *   - **An empty database yields an empty metric list**, never a zeroed one. This is the
 *     rule the whole design turns on, tested here at the layer that serves it.
 *   - **`BB_ANALYTICS_DB_PATH=""` means OFF, not a database at `''`.** SQLite reads an
 *     empty path as a temporary database, so getting this wrong makes collection appear to
 *     work and vanish on restart — the same env-var trap design/19 §9 already records.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { EVENT_RETENTION_DAYS, openAnalyticsDb } from '../src/analytics/db';
import { writeBatch } from '../src/analytics/store';
import { ROLLUP_INTERVAL_MS, runRollupCycle, startRollupJob } from '../src/analytics/job';
import { analyticsDbPathFromEnv } from '../src/matchsvc';
import type { Logger } from '../src/log';

const DAY_MS = 86_400_000;
/** 2026-09-09T12:00:00Z — so "yesterday" is 2026-09-08. */
const NOW = Date.UTC(2026, 8, 9, 12, 0, 0);

function recordingLog(): Logger & { lines: { level: string; msg: string }[] } {
  const lines: { level: string; msg: string }[] = [];
  const log = {
    lines,
    error: (msg: string) => void lines.push({ level: 'error', msg }),
    warn: (msg: string) => void lines.push({ level: 'warn', msg }),
    info: (msg: string) => void lines.push({ level: 'info', msg }),
    debug: (msg: string) => void lines.push({ level: 'debug', msg }),
    child: () => log as never,
  };
  return log as never;
}

let db: DatabaseSync;
let log: ReturnType<typeof recordingLog>;
beforeEach(() => {
  db = openAnalyticsDb(':memory:');
  log = recordingLog();
});
afterEach(() => {
  db.close();
});

/** Record `install` active `daysAgo` days before NOW, through the real write path. */
function active(daysAgo: number, install: string): void {
  writeBatch(
    db,
    {
      install,
      session: `s-${install}`,
      host: 'web',
      build: '1.0.0',
      locale: 'en',
      events: [{ name: 'session_start', atMs: NOW - daysAgo * DAY_MS, props: {} }],
    },
    null,
  );
}

describe('runRollupCycle', () => {
  it('persists yesterday, prunes what aged out, and returns the gauges', () => {
    active(1, 'a');
    active(EVENT_RETENTION_DAYS + 1, 'ancient');
    const metrics = runRollupCycle({ db, log, now: () => NOW });
    expect(metrics.find((m) => m.name === 'bb_dau' && m.labels?.host === 'all')?.value).toBe(1);
    const rollupRows = db.prepare("SELECT COUNT(*) AS n FROM daily_rollup WHERE day = '2026-09-08'").get() as {
      n: number;
    };
    expect(Number(rollupRows.n)).toBeGreaterThan(0);
    expect(Number((db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n)).toBe(1);
  });

  it('logs one falsifiable line rather than "rollup ok"', () => {
    runRollupCycle({ db, log, now: () => NOW });
    expect(log.lines).toEqual([{ level: 'info', msg: 'analytics rollup' }]);
  });

  it('returns an EMPTY list on an empty database — no zeroed retention', () => {
    const metrics = runRollupCycle({ db, log, now: () => NOW });
    expect(metrics.some((m) => m.name === 'bb_retention_ratio')).toBe(false);
    // DAU zero IS a measurement and is reported; retention zero would be a claim.
    expect(metrics.find((m) => m.name === 'bb_dau')?.value).toBe(0);
  });

  it('reports retention once a cohort has aged', () => {
    active(2, 'a');
    active(1, 'a');
    const metrics = runRollupCycle({ db, log, now: () => NOW });
    const d1 = metrics.find((m) => m.name === 'bb_retention_ratio' && m.labels?.d === '1');
    expect(d1?.value).toBe(1);
  });

  it('keeps the prune window wide enough that persist-before-prune cannot matter', () => {
    // The premise behind the ordering note in job.ts. The rollup's day is always yesterday
    // and the prune's cutoff is EVENT_RETENTION_DAYS back, so the two never overlap — as
    // long as the window is more than one day. Shortening it to 1 is the change that makes
    // the order load-bearing, and this is the test that says so.
    expect(EVENT_RETENTION_DAYS).toBeGreaterThan(1);
  });
});

describe('startRollupJob', () => {
  interface FakeTimer {
    fn: () => void;
    ms: number;
  }

  function start(over: Partial<Parameters<typeof startRollupJob>[0]> = {}) {
    const timers: FakeTimer[] = [];
    let cleared = 0;
    const job = startRollupJob({
      db,
      log,
      now: () => NOW,
      setIntervalImpl: (fn, ms) => {
        timers.push({ fn, ms });
        return timers.length;
      },
      clearIntervalImpl: () => void (cleared += 1),
      ...over,
    });
    return { job, timers, cleared: () => cleared };
  }

  it('runs one cycle immediately, so a restarted process serves real gauges at once', () => {
    active(1, 'a');
    const { job } = start();
    expect(job.metrics().find((m) => m.name === 'bb_dau' && m.labels?.host === 'all')?.value).toBe(1);
  });

  it('registers an hourly timer by default', () => {
    const { timers } = start();
    expect(timers).toHaveLength(1);
    expect(timers[0]!.ms).toBe(ROLLUP_INTERVAL_MS);
    expect(ROLLUP_INTERVAL_MS).toBeLessThan(DAY_MS);
  });

  it('refreshes the cache on each tick', () => {
    const { job, timers } = start();
    expect(job.metrics().find((m) => m.name === 'bb_dau')?.value).toBe(0);
    active(1, 'a');
    timers[0]!.fn();
    expect(job.metrics().find((m) => m.name === 'bb_dau')?.value).toBe(1);
  });

  it('survives a cycle that throws, and the timer keeps running', () => {
    // Reached through a real failing write: the trigger makes SQLite abort the persist.
    db.exec(`CREATE TRIGGER no_rollup BEFORE INSERT ON daily_rollup
             BEGIN SELECT RAISE(ABORT, 'disk full'); END`);
    const { job, timers } = start();
    expect(job.metrics()).toEqual([]);
    expect(log.lines).toEqual([{ level: 'warn', msg: 'analytics rollup failed' }]);
    // And the next tick is still attempted rather than the job being dead.
    expect(() => timers[0]!.fn()).not.toThrow();
    expect(log.lines).toHaveLength(2);
  });

  it('keeps the last GOOD answer when a later cycle fails', () => {
    active(1, 'a');
    const { job, timers } = start();
    const good = job.metrics().find((m) => m.name === 'bb_dau' && m.labels?.host === 'all')?.value;
    expect(good).toBe(1);
    db.exec(`CREATE TRIGGER no_rollup BEFORE INSERT ON daily_rollup
             BEGIN SELECT RAISE(ABORT, 'disk full'); END`);
    timers[0]!.fn();
    // Freshness lost, numbers kept — the alternative is a panel that empties on one bad
    // cycle and looks like "nobody played".
    expect(job.metrics().find((m) => m.name === 'bb_dau' && m.labels?.host === 'all')?.value).toBe(1);
  });

  it('clears its timer on stop', () => {
    const h = start();
    h.job.stop();
    expect(h.cleared()).toBe(1);
  });

  it('runOnce is idempotent', () => {
    active(1, 'a');
    const { job } = start();
    job.runOnce();
    job.runOnce();
    const n = db.prepare("SELECT COUNT(*) AS n FROM daily_rollup WHERE metric = 'dau'").get() as { n: number };
    // Two hosts would be two rows; one install on one host is 'all' plus 'web'.
    expect(Number(n.n)).toBe(2);
  });

  it('works with real timers, unref-ed so it cannot hold the process open', () => {
    // The default arms — a real `setInterval(...).unref()` and a real `clearInterval`. If
    // the unref were dropped, vitest would hang at the end of this file rather than fail,
    // which is why this case exists at all.
    const job = startRollupJob({ db, log, now: () => NOW, intervalMs: 3_600_000 });
    expect(job.metrics()).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'bb_dau' })]));
    job.stop();
  });
});

describe('analyticsDbPathFromEnv', () => {
  it('returns the path when it is set', () => {
    expect(analyticsDbPathFromEnv({ BB_ANALYTICS_DB_PATH: '/data/analytics.db' })).toBe('/data/analytics.db');
  });

  it('trims a stray space rather than opening " /data/x.db"', () => {
    expect(analyticsDbPathFromEnv({ BB_ANALYTICS_DB_PATH: '  /data/x.db  ' })).toBe('/data/x.db');
  });

  it('treats an EMPTY value as OFF, not as a database at ""', () => {
    // SQLite opens '' as a temporary database, so the wrong answer here is not a crash —
    // it is collection that appears to work and disappears on restart.
    expect(analyticsDbPathFromEnv({ BB_ANALYTICS_DB_PATH: '' })).toBeNull();
    expect(analyticsDbPathFromEnv({ BB_ANALYTICS_DB_PATH: '   ' })).toBeNull();
  });

  it('is OFF when unset', () => {
    expect(analyticsDbPathFromEnv({})).toBeNull();
  });
});
