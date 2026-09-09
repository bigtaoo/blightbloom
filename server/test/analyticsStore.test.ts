/**
 * `analytics.db` and the only module that writes it — `src/analytics/db.ts` +
 * `src/analytics/store.ts`.
 *
 * Run against a real `openAnalyticsDb(':memory:')`, because the two properties worth having
 * here are properties of SQLite and not of TypeScript:
 *
 *   - **A batch is atomic.** It writes two tables that answer different questions about one
 *     visit, and half of it is worse than none — an `events` row with no cohort row is a
 *     session that happened to nobody. The rollback case below is reached through a real
 *     failing write (a `RAISE(ABORT)` trigger), not by stubbing the handle, because a
 *     stubbed transaction proves nothing about the one that ships.
 *   - **The prune windows are independent.** `events` ages out at 90 days and
 *     `daily_active` at 400, and that gap is the whole reason a D7 answer for last month
 *     does not silently become `0` the week the raw rows are dropped. A single window would
 *     pass every test that only checks "old rows go away".
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ACTIVE_RETENTION_DAYS,
  EVENT_RETENTION_DAYS,
  defaultAnalyticsDbPath,
  openAnalyticsDb,
  openAnalyticsDbReadOnly,
} from '../src/analytics/db';
import { prune, writeBatch } from '../src/analytics/store';
import type { IngestedBatch } from '../src/analytics/ingest';

const DAY_MS = 86_400_000;
const T0 = Date.UTC(2026, 8, 9, 12, 0, 0); // 2026-09-09T12:00:00Z

function batch(over: Partial<IngestedBatch> = {}): IngestedBatch {
  return {
    install: 'i-1',
    session: 's-1',
    host: 'web',
    build: '1.0.0',
    locale: 'en',
    events: [{ name: 'session_start', atMs: T0, props: {} }],
    ...over,
  };
}

let db: DatabaseSync;
beforeEach(() => {
  db = openAnalyticsDb(':memory:');
});
afterEach(() => {
  db.close();
});

const count = (sql: string, ...args: unknown[]): number =>
  Number((db.prepare(`SELECT COUNT(*) AS n FROM ${sql}`).get(...(args as never[])) as { n: number }).n);

describe('writeBatch', () => {
  it('stores one row per event and one cohort row per day', () => {
    const r = writeBatch(
      db,
      batch({
        events: [
          { name: 'session_start', atMs: T0, props: {} },
          { name: 'run_start', atMs: T0 + 1000, props: { character: 'scrapper', weapon: 'rifle' } },
        ],
      }),
      null,
    );
    expect(r).toEqual({ events: 2, newActiveDay: true });
    expect(count('events')).toBe(2);
    expect(count('daily_active')).toBe(1);
  });

  it('stores props as JSON and reads them back', () => {
    writeBatch(db, batch({ events: [{ name: 'run_end', atMs: T0, props: { outcome: 'win', floor: 7 } }] }), null);
    const row = db.prepare('SELECT props FROM events').get() as { props: string };
    expect(JSON.parse(row.props)).toEqual({ outcome: 'win', floor: 7 });
  });

  it('attaches the account id it was given, and null when there is none', () => {
    writeBatch(db, batch({ install: 'i-anon' }), null);
    writeBatch(db, batch({ install: 'i-known' }), 'acct-9');
    const rows = db.prepare('SELECT install, account_id FROM events ORDER BY install').all() as {
      install: string;
      account_id: string | null;
    }[];
    expect(rows).toEqual([
      { install: 'i-anon', account_id: null },
      { install: 'i-known', account_id: 'acct-9' },
    ]);
  });

  it('reports newActiveDay false on a second batch the same day', () => {
    expect(writeBatch(db, batch(), null).newActiveDay).toBe(true);
    expect(writeBatch(db, batch({ session: 's-2' }), null).newActiveDay).toBe(false);
    expect(count('daily_active')).toBe(1);
    expect(count('events')).toBe(2);
  });

  it('creates one cohort row per DAY when a batch spans midnight', () => {
    // A visit that crosses UTC midnight is active on both days, and both cohorts are real.
    writeBatch(
      db,
      batch({
        events: [
          { name: 'session_start', atMs: Date.UTC(2026, 8, 9, 23, 59, 0), props: {} },
          { name: 'session_end', atMs: Date.UTC(2026, 8, 10, 0, 1, 0), props: {} },
        ],
      }),
      null,
    );
    const days = db.prepare('SELECT day FROM daily_active ORDER BY day').all() as { day: string }[];
    expect(days.map((d) => d.day)).toEqual(['2026-09-09', '2026-09-10']);
  });

  it('writes ONE cohort row for a 60-event batch on one day', () => {
    // The in-memory dedup: without it this is 59 no-op writes inside the transaction.
    const events = Array.from({ length: 60 }, (_, i) => ({
      name: 'screen_view' as const,
      atMs: T0 + i,
      props: { screen: 'lobby' },
    }));
    writeBatch(db, batch({ events }), null);
    expect(count('events')).toBe(60);
    expect(count('daily_active')).toBe(1);
  });

  it('keeps the first host for an install that appears on two hosts the same day', () => {
    // db.ts's header: DAU-by-host is a PARTITION of DAU, so a switcher is counted once.
    writeBatch(db, batch({ host: 'web' }), null);
    writeBatch(db, batch({ host: 'crazygames' }), null);
    const rows = db.prepare('SELECT host FROM daily_active').all() as { host: string }[];
    expect(rows).toEqual([{ host: 'web' }]);
  });

  it('rolls the whole batch back when a write inside it fails', () => {
    // Reached through a real failing write rather than a stub: the trigger makes SQLite
    // itself abort the second statement, which is the only version of this that exercises
    // the ROLLBACK that ships.
    db.exec(`CREATE TRIGGER no_active BEFORE INSERT ON daily_active
             BEGIN SELECT RAISE(ABORT, 'nope'); END`);
    expect(() => writeBatch(db, batch(), null)).toThrow(/nope/);
    expect(count('events')).toBe(0);
    expect(count('daily_active')).toBe(0);
  });
});

describe('prune', () => {
  /** Seed one event + cohort row for a day `n` days before T0. */
  const seedAgo = (n: number): void => {
    writeBatch(db, batch({ install: `i-${n}`, events: [{ name: 'session_start', atMs: T0 - n * DAY_MS, props: {} }] }), null);
  };

  it('keeps a row exactly at the cutoff and drops the one before it', () => {
    seedAgo(EVENT_RETENTION_DAYS - 1);
    seedAgo(EVENT_RETENTION_DAYS);
    seedAgo(EVENT_RETENTION_DAYS + 1);
    const r = prune(db, '2026-09-09');
    expect(r.events).toBe(1);
    expect(count('events')).toBe(2);
  });

  it('drops raw events long before it drops cohort rows', () => {
    // The property a single window would break: retention for a month-old cohort still has
    // its `daily_active` rows after the raw events are gone.
    seedAgo(EVENT_RETENTION_DAYS + 10);
    const r = prune(db, '2026-09-09');
    expect(r.events).toBe(1);
    expect(r.active).toBe(0);
    expect(count('events')).toBe(0);
    expect(count('daily_active')).toBe(1);
  });

  it('eventually drops cohort rows too, at their own window', () => {
    seedAgo(ACTIVE_RETENTION_DAYS + 1);
    const r = prune(db, '2026-09-09');
    expect(r.active).toBe(1);
    expect(count('daily_active')).toBe(0);
  });

  it('is a no-op on a database with nothing old in it', () => {
    seedAgo(0);
    expect(prune(db, '2026-09-09')).toEqual({ events: 0, active: 0 });
    expect(count('events')).toBe(1);
  });

  it('is idempotent', () => {
    seedAgo(EVENT_RETENTION_DAYS + 1);
    prune(db, '2026-09-09');
    expect(prune(db, '2026-09-09')).toEqual({ events: 0, active: 0 });
  });

  it('has windows in the order the retention argument depends on', () => {
    // Stated as an assertion because swapping the two constants would leave every test
    // above passing in shape while making the cohort table the SHORTER-lived one.
    expect(ACTIVE_RETENTION_DAYS).toBeGreaterThan(EVENT_RETENTION_DAYS + 7);
  });
});

describe('defaultAnalyticsDbPath', () => {
  const saved = process.env.BB_ANALYTICS_DB_PATH;
  afterEach(() => {
    if (saved === undefined) delete process.env.BB_ANALYTICS_DB_PATH;
    else process.env.BB_ANALYTICS_DB_PATH = saved;
  });

  it('prefers the environment variable', () => {
    process.env.BB_ANALYTICS_DB_PATH = '/data/elsewhere.db';
    expect(defaultAnalyticsDbPath()).toBe('/data/elsewhere.db');
  });

  it('treats an EMPTY variable as unset rather than as a path', () => {
    // design/19 §9's standing rule, one layer out: an env var set to "" overrides a `??`
    // fallback, and the symptom here would be a database created at the filesystem root or
    // a silent failure to open one at all.
    process.env.BB_ANALYTICS_DB_PATH = '';
    expect(defaultAnalyticsDbPath()).toMatch(/analytics\.db$/);
  });

  it('falls back to a path beside the other two databases', () => {
    delete process.env.BB_ANALYTICS_DB_PATH;
    const p = defaultAnalyticsDbPath().replace(/\\/g, '/');
    expect(p).toMatch(/\/data\/analytics\.db$/);
  });
});

describe('openAnalyticsDbReadOnly', () => {
  it('cannot write — which is the whole security argument for the console (B1)', () => {
    // Not a rule the console follows — a capability the handle does not have.
    //
    // Against a real FILE in the OS temp dir, for two reasons: `:memory:` opened read-only
    // is a fresh empty database with no schema, so the assertion would pass for the wrong
    // reason; and a scratch file inside the repo is one the repo's own tooling can see.
    const dir = mkdtempSync(join(tmpdir(), 'bb-analytics-'));
    const path = join(dir, 'analytics.db');
    try {
      const rw = openAnalyticsDb(path);
      writeBatch(rw, batch(), null);
      rw.close();

      const ro = openAnalyticsDbReadOnly(path);
      expect(Number((ro.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n)).toBe(1);
      expect(() =>
        ro.exec("INSERT INTO daily_active (day, install, host) VALUES ('2026-01-01','x','web')"),
      ).toThrow(/readonly|read-only/i);
      ro.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
