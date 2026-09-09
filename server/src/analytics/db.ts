/**
 * `analytics.db` — the third database (design/21 §2.4), beside `accounts.db` and
 * `billing.db`.
 *
 * Written by exactly one process (matchsvc, which owns the ingest route) and opened
 * read-only by everything else. That is decision A4, and it is not a performance
 * preference: one writer is SQLite's happy path, and it is what lets the console in §3 say
 * "cannot write player data" as a total statement rather than a careful one.
 *
 * ## Three tables, and why the middle one exists
 *
 * `events` is the raw record and is pruned on a rolling window. `daily_rollup` is the
 * computed record and is A5's authority — Prometheus holds 15 days, this holds all of it.
 *
 * `daily_active` is the one that looks redundant and is not. A retention cohort is "the set
 * of installs active on day D, intersected with the set active on day D+n", and computing
 * that off `events` means a `DISTINCT` scan over every row the window holds, twice per
 * offset, every day — work that grows with traffic to answer a question whose answer is a
 * few hundred ids. More importantly it would make retention DEPEND on the prune: the day
 * `events` drops its oldest week, D7 for that week silently becomes zero rather than
 * unknown. `daily_active` is one small row per install per day, is never pruned on the
 * events window, and is the only table a cohort query reads.
 *
 * ## `PRIMARY KEY (day, install)` and what it decides about `host`
 *
 * An install that plays on two hosts in one day is ONE person, so it gets one row and its
 * `host` is whichever host it appeared on first (`INSERT OR IGNORE`). The consequence is
 * worth stating because it is the useful one: DAU-by-host is a PARTITION of DAU, and the
 * per-host numbers sum to exactly the total. Keying on `(day, install, host)` instead would
 * make the split double-count anyone who switched, and the total would stop being a count
 * of people.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCHEMA = `
-- Raw events. \`props\` is JSON rather than columns: the vocabulary
-- (client/src/net/analyticsEvents.ts) names a different field set per event, and a wide
-- sparse table would gain a column every time one gains a field. Nothing queries INTO
-- props today; the rollup groups by \`name\` and \`day\`.
--
-- \`account_id\` carries no foreign key, deliberately, and the reason is the same shape as
-- \`ratings\`': most rows have none at all (a player who never logged in is exactly who
-- retention is about), and an account deleted later must not take its rows' validity with
-- it. It is a recorded fact, not a reference.
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at_ms INTEGER NOT NULL,
  day TEXT NOT NULL,
  name TEXT NOT NULL,
  install TEXT NOT NULL,
  session TEXT NOT NULL,
  host TEXT NOT NULL,
  build TEXT NOT NULL,
  locale TEXT NOT NULL,
  account_id TEXT,
  props TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_day_name ON events(day, name);
CREATE INDEX IF NOT EXISTS events_account ON events(account_id);

-- The cohort table. See the file header for why it is separate and why the key is
-- (day, install) rather than (day, install, host).
CREATE TABLE IF NOT EXISTS daily_active (
  day TEXT NOT NULL,
  install TEXT NOT NULL,
  host TEXT NOT NULL,
  PRIMARY KEY (day, install)
);
CREATE INDEX IF NOT EXISTS daily_active_install ON daily_active(install, day);

-- The computed record (A5). One row per number per day; \`labels\` is a canonical JSON
-- object so that a metric with a label set is one row and not a column family.
CREATE TABLE IF NOT EXISTS daily_rollup (
  day TEXT NOT NULL,
  metric TEXT NOT NULL,
  labels TEXT NOT NULL,
  value REAL NOT NULL,
  computed_at INTEGER NOT NULL,
  PRIMARY KEY (day, metric, labels)
);
`;

/**
 * How long raw `events` rows are kept. The privacy policy states this number, so the two
 * have to be changed together — a policy that says 90 days over a prune that keeps forever
 * is the failure this comment exists to prevent.
 */
export const EVENT_RETENTION_DAYS = 90;

/**
 * How long `daily_active` rows are kept. Longer than the events window on purpose: these
 * rows are ~40 bytes, they are what every retention answer is computed from, and pruning
 * them on the events window would silently turn "we don't know" into "zero".
 *
 * 180 rather than "keep forever", because the privacy policy has to state this number and a
 * number has to be defensible. 180 days is what a full D90 curve for the last quarter
 * needs: 90 days of cohorts plus 90 days for the newest of them to age. Anything past that
 * would be kept in case a question is asked later, which is the definition of what data
 * minimisation asks us not to do.
 */
export const ACTIVE_RETENTION_DAYS = 180;

/** Opens (creating if needed) the analytics DB and ensures the schema exists. */
export function openAnalyticsDb(path: string = defaultAnalyticsDbPath()): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  return db;
}

/**
 * Opens the analytics DB READ-ONLY — for the console (design/21 B1) and for anything else
 * that only asks questions. `node:sqlite`'s `readOnly` is enforced by SQLite itself, so
 * this is a capability the process does not hold rather than a rule it follows.
 */
export function openAnalyticsDbReadOnly(path: string = defaultAnalyticsDbPath()): DatabaseSync {
  return new DatabaseSync(path, { readOnly: true });
}

export function defaultAnalyticsDbPath(): string {
  const env = process.env.BB_ANALYTICS_DB_PATH;
  if (env && env.length > 0) return env;
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '../../data/analytics.db');
}
