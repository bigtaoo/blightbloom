/**
 * The daily rollup (design/21 §2.5): DAU, event counts and D1–D7 retention, computed from
 * `daily_active` and `events`, written to `daily_rollup`, and offered as gauges.
 *
 * ## Two outputs, and which one is the record
 *
 * `daily_rollup` is the authority (A5). The gauges are a VIEW: Prometheus here keeps 15
 * days and a gauge cannot be backfilled, so a chart built only on scrapes silently begins
 * two weeks ago no matter how long the game has been live. Everything this file computes is
 * therefore written down first and exposed second.
 *
 * ## Only complete days are computed
 *
 * Today is partial, and a partial day's DAU is a number that keeps changing while looking
 * like a measurement. Every function here takes `todayKey` and works strictly before it.
 *
 * ## An unaged cohort is not a zero
 *
 * This is the trap the design doc names, and it is enforced by a type: {@link cohortRate}
 * returns `null` for a cohort that does not exist or has not yet had its offset day arrive,
 * and {@link retentionGauges} SKIPS a null rather than emitting `0`. A gauge has no
 * "unknown", so the only way to say it is to be absent — and the difference matters most
 * exactly when it is easiest to get wrong: in the first week after launch, when every
 * offset is unaged and a zero would read as "nobody ever came back".
 */
import type { DatabaseSync } from 'node:sqlite';

/** The offsets tracked, in one place — adding D14 is this line plus a dashboard panel. */
export const RETENTION_OFFSETS = [1, 2, 3, 4, 5, 6, 7] as const;

/** A number this file produces. Structurally compatible with the server's `Metric`, but
 *  declared here so that computing a rollup does not depend on the exposition layer. */
export interface RollupMetric {
  name: string;
  help: string;
  type: 'gauge' | 'counter';
  value: number;
  labels?: Record<string, string>;
}

/** `YYYY-MM-DD` plus a signed number of days. Text in, text out — the format sorts
 *  chronologically, which is why every comparison in this module is a string compare. */
export function addDays(day: string, delta: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + delta * 86_400_000).toISOString().slice(0, 10);
}

/** The most recent day that is over. Everything computed here is about this day or earlier. */
export function lastCompleteDay(todayKey: string): string {
  return addDays(todayKey, -1);
}

/** Distinct installs active on a day, total. */
export function dau(db: DatabaseSync, day: string): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM daily_active WHERE day = ?').get(day) as { n: number };
  return Number(row.n);
}

/** Distinct installs active on a day, split by host. A partition of {@link dau} — see
 *  `db.ts`'s header for why an install that switched hosts is counted once. */
export function dauByHost(db: DatabaseSync, day: string): { host: string; n: number }[] {
  const rows = db
    .prepare('SELECT host, COUNT(*) AS n FROM daily_active WHERE day = ? GROUP BY host ORDER BY host')
    .all(day) as { host: string; n: number }[];
  return rows.map((r) => ({ host: String(r.host), n: Number(r.n) }));
}

/**
 * `screen_view` events on a day, by which screen.
 *
 * The one place the rollup reaches INTO `props`, and it is worth the exception: the whole
 * early funnel — reached the menu, reached the mode select, reached the forge, opened the
 * store — is one event name with a field, so counting by name alone would collapse every
 * step into a single number. `json_extract` is used rather than a `LIKE`, so a screen id
 * that happens to appear inside another field cannot be miscounted.
 */
export function screenViewCounts(db: DatabaseSync, day: string): { screen: string; n: number }[] {
  const rows = db
    .prepare(
      `SELECT json_extract(props, '$.screen') AS screen, COUNT(*) AS n
       FROM events WHERE day = ? AND name = 'screen_view' AND screen IS NOT NULL
       GROUP BY screen ORDER BY screen`,
    )
    .all(day) as { screen: string; n: number }[];
  return rows.map((r) => ({ screen: String(r.screen), n: Number(r.n) }));
}

/** Events stored on a day, by name. */
export function eventCounts(db: DatabaseSync, day: string): { name: string; n: number }[] {
  const rows = db
    .prepare('SELECT name, COUNT(*) AS n FROM events WHERE day = ? GROUP BY name ORDER BY name')
    .all(day) as { name: string; n: number }[];
  return rows.map((r) => ({ name: String(r.name), n: Number(r.n) }));
}

/** A cohort's return rate at one offset. */
export interface CohortRate {
  cohortDay: string;
  offset: number;
  /** Installs active on `cohortDay`. Never 0 — a zero cohort yields `null` instead. */
  size: number;
  /** How many of them were active again on `cohortDay + offset`. */
  returned: number;
  /** `returned / size`. */
  rate: number;
}

/**
 * The return rate of one cohort at one offset, or `null` when the question has no answer:
 * the offset day has not finished yet, or nobody was active on the cohort day at all.
 *
 * Both nulls are "unknown", and neither is "zero". A caller that renders them the same way
 * is the bug this return type exists to make visible.
 */
export function cohortRate(
  db: DatabaseSync,
  cohortDay: string,
  offset: number,
  todayKey: string,
): CohortRate | null {
  if (addDays(cohortDay, offset) > lastCompleteDay(todayKey)) return null;
  const size = dau(db, cohortDay);
  if (size === 0) return null;
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM daily_active
       WHERE day = ? AND install IN (SELECT install FROM daily_active WHERE day = ?)`,
    )
    .get(addDays(cohortDay, offset), cohortDay) as { n: number };
  const returned = Number(row.n);
  return { cohortDay, offset, size, returned, rate: returned / size };
}

/**
 * The newest cohort whose `offset`-day answer is known.
 *
 * Derived rather than passed in, because getting it wrong is the classic off-by-one here: a
 * cohort's D`n` is knowable once day `cohort + n` is COMPLETE, so the newest such cohort is
 * `lastCompleteDay - n`, not `today - n`.
 */
export function newestKnownCohort(todayKey: string, offset: number): string {
  return addDays(lastCompleteDay(todayKey), -offset);
}

/** Retention gauges for the newest cohort at each offset. A null rate contributes NOTHING —
 *  see the file header. */
export function retentionGauges(db: DatabaseSync, todayKey: string): RollupMetric[] {
  const out: RollupMetric[] = [];
  for (const offset of RETENTION_OFFSETS) {
    const r = cohortRate(db, newestKnownCohort(todayKey, offset), offset, todayKey);
    if (r === null) continue;
    out.push({
      name: 'bb_retention_ratio',
      help: 'Share of a day\'s active installs that were active again N days later.',
      type: 'gauge',
      value: r.rate,
      labels: { d: String(offset) },
    });
    out.push({
      name: 'bb_retention_cohort_size',
      help: 'Installs in the cohort behind bb_retention_ratio at this offset.',
      type: 'gauge',
      value: r.size,
      labels: { d: String(offset) },
    });
  }
  return out;
}

/** Every gauge this module offers, for the last complete day. */
export function rollupMetrics(db: DatabaseSync, todayKey: string): RollupMetric[] {
  const day = lastCompleteDay(todayKey);
  const out: RollupMetric[] = [
    {
      name: 'bb_dau',
      help: 'Distinct installs active on the last complete day.',
      type: 'gauge',
      value: dau(db, day),
      labels: { host: 'all' },
    },
  ];
  for (const { host, n } of dauByHost(db, day)) {
    out.push({ name: 'bb_dau', help: 'Distinct installs active on the last complete day.', type: 'gauge', value: n, labels: { host } });
  }
  for (const { name, n } of eventCounts(db, day)) {
    out.push({
      name: 'bb_events_day',
      help: 'Analytics events stored on the last complete day, by name.',
      type: 'gauge',
      value: n,
      labels: { event: name },
    });
  }
  for (const { screen, n } of screenViewCounts(db, day)) {
    out.push({
      name: 'bb_screen_views_day',
      help: 'Screen views on the last complete day, by screen.',
      type: 'gauge',
      value: n,
      labels: { screen },
    });
  }
  return [...out, ...retentionGauges(db, todayKey)];
}

/**
 * Compute and PERSIST the last complete day's numbers.
 *
 * Idempotent by primary key (`INSERT OR REPLACE` on `(day, metric, labels)`), so running it
 * twice in a day is a no-op rather than a duplicate — which matters because the caller is a
 * timer in a process that restarts on deploy.
 *
 * Returns the number of rows written, so a caller can log something falsifiable rather than
 * "rollup ok".
 */
export function persistRollup(db: DatabaseSync, todayKey: string, nowMs: number): number {
  const day = lastCompleteDay(todayKey);
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO daily_rollup (day, metric, labels, value, computed_at) VALUES (?, ?, ?, ?, ?)`,
  );
  const rows: { metric: string; labels: Record<string, string>; value: number }[] = [
    { metric: 'dau', labels: { host: 'all' }, value: dau(db, day) },
    ...dauByHost(db, day).map((h) => ({ metric: 'dau', labels: { host: h.host }, value: h.n })),
    ...eventCounts(db, day).map((e) => ({ metric: 'events', labels: { event: e.name }, value: e.n })),
    ...screenViewCounts(db, day).map((v) => ({ metric: 'screen_views', labels: { screen: v.screen }, value: v.n })),
  ];
  // Retention is persisted against the COHORT's day, not today's — the row says "this
  // cohort returned at this rate", which is a fact about that day and stays true.
  const retention: { day: string; metric: string; labels: Record<string, string>; value: number }[] = [];
  for (const offset of RETENTION_OFFSETS) {
    const r = cohortRate(db, newestKnownCohort(todayKey, offset), offset, todayKey);
    if (r === null) continue;
    retention.push({ day: r.cohortDay, metric: 'retention', labels: { d: String(offset) }, value: r.rate });
    retention.push({ day: r.cohortDay, metric: 'cohort_size', labels: { d: String(offset) }, value: r.size });
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    for (const r of rows) stmt.run(day, r.metric, canonicalLabels(r.labels), r.value, nowMs);
    for (const r of retention) stmt.run(r.day, r.metric, canonicalLabels(r.labels), r.value, nowMs);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return rows.length + retention.length;
}

/** Labels as a stable string, so the primary key means what it looks like. `JSON.stringify`
 *  preserves insertion order, which two callers building the same object from different code
 *  paths would not — so the keys are sorted before serialising. */
export function canonicalLabels(labels: Record<string, string>): string {
  const keys = Object.keys(labels).sort();
  return JSON.stringify(Object.fromEntries(keys.map((k) => [k, labels[k]])));
}
