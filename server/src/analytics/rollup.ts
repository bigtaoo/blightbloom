/**
 * The daily rollup (design/21 §2.5): DAU, event counts and D1–D7 retention, computed from
 * `dailyActive` and `events`, written to `dailyRollup`, and offered as gauges.
 *
 * ## Two outputs, and which one is the record
 *
 * `dailyRollup` is the authority (A5). The gauges are a VIEW: Prometheus here keeps 15
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
 *
 * ## Every read here is a query against a server now
 *
 * The SQL these functions used to hold became aggregation pipelines, and two of them are
 * worth pointing at:
 *
 *  - The screen-view split was `json_extract(props, '$.screen')`. `props` is a subdocument
 *    now (`db.ts`), so it is a `$group` on `props.screen` — with the `name` filter kept,
 *    because a `run_start` carrying a `character` must not be able to become a screen.
 *  - The cohort join was `install IN (SELECT install FROM daily_active WHERE day = ?)`. It
 *    is a `$lookup` against the same collection rather than a two-step "fetch the cohort's
 *    ids, then match `$in` that array": the array version sends a list whose LENGTH grows
 *    with DAU through the driver on every offset, every day, to answer a question the
 *    server can answer where the index already is.
 */
import type { Db } from 'mongodb';
import { dailyActiveOf, dailyRollupOf, eventsOf, DAILY_ACTIVE_COLLECTION, type DailyRollupDoc } from './db';

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

/** One bucket of a group-by, as every counter below returns it. */
interface Bucket {
  _id: string;
  n: number;
}

/** `$group` by one field over one day, sorted by the key — the shape three of the four
 *  counters below share, so the pipeline is written once. */
async function countBy(
  db: Db,
  collection: 'events' | 'dailyActive',
  match: Record<string, unknown>,
  field: string,
): Promise<Bucket[]> {
  const source = collection === 'events' ? eventsOf(db) : dailyActiveOf(db);
  return source
    .aggregate<Bucket>([{ $match: match }, { $group: { _id: `$${field}`, n: { $sum: 1 } } }, { $sort: { _id: 1 } }])
    .toArray();
}

/** Distinct installs active on a day, total. */
export async function dau(db: Db, day: string): Promise<number> {
  return dailyActiveOf(db).countDocuments({ day });
}

/** Distinct installs active on a day, split by host. A partition of {@link dau} — see
 *  `db.ts`'s header for why an install that switched hosts is counted once. */
export async function dauByHost(db: Db, day: string): Promise<{ host: string; n: number }[]> {
  const rows = await countBy(db, 'dailyActive', { day }, 'host');
  return rows.map((r) => ({ host: String(r._id), n: r.n }));
}

/**
 * `screen_view` events on a day, by which screen.
 *
 * The one place the rollup reaches INTO `props`, and it is worth the exception: the whole
 * early funnel — reached the menu, reached the mode select, reached the forge, opened the
 * store — is one event name with a field, so counting by name alone would collapse every
 * step into a single number.
 *
 * The `$type: 'string'` guard replaces the old `screen IS NOT NULL`. `ingest.ts` drops a
 * malformed `screen`, so a `screen_view` can legitimately land with `props: {}` — and a
 * missing field would otherwise `$group` into a single `null` bucket and appear on the
 * dashboard as a screen nobody ever visited.
 */
export async function screenViewCounts(db: Db, day: string): Promise<{ screen: string; n: number }[]> {
  const rows = await countBy(
    db,
    'events',
    { day, name: 'screen_view', 'props.screen': { $type: 'string' } },
    'props.screen',
  );
  return rows.map((r) => ({ screen: String(r._id), n: r.n }));
}

/** Events stored on a day, by name. */
export async function eventCounts(db: Db, day: string): Promise<{ name: string; n: number }[]> {
  const rows = await countBy(db, 'events', { day }, 'name');
  return rows.map((r) => ({ name: String(r._id), n: r.n }));
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
export async function cohortRate(
  db: Db,
  cohortDay: string,
  offset: number,
  todayKey: string,
): Promise<CohortRate | null> {
  if (addDays(cohortDay, offset) > lastCompleteDay(todayKey)) return null;
  const size = await dau(db, cohortDay);
  if (size === 0) return null;
  const got = await dailyActiveOf(db)
    .aggregate<{ n: number }>([
      { $match: { day: addDays(cohortDay, offset) } },
      {
        $lookup: {
          from: DAILY_ACTIVE_COLLECTION,
          let: { install: '$install' },
          pipeline: [
            { $match: { $expr: { $and: [{ $eq: ['$day', cohortDay] }, { $eq: ['$install', '$$install'] }] } } },
            // One match is the whole question — this is a membership test, not a count.
            { $limit: 1 },
            { $project: { _id: 1 } },
          ],
          as: 'inCohort',
        },
      },
      { $match: { 'inCohort.0': { $exists: true } } },
      { $count: 'n' },
    ])
    .toArray();
  const returned = got[0]?.n ?? 0;
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
export async function retentionGauges(db: Db, todayKey: string): Promise<RollupMetric[]> {
  const out: RollupMetric[] = [];
  for (const offset of RETENTION_OFFSETS) {
    const r = await cohortRate(db, newestKnownCohort(todayKey, offset), offset, todayKey);
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

const DAU_HELP = 'Distinct installs active on the last complete day.';

/** Every gauge this module offers, for the last complete day. */
export async function rollupMetrics(db: Db, todayKey: string): Promise<RollupMetric[]> {
  const day = lastCompleteDay(todayKey);
  const out: RollupMetric[] = [
    { name: 'bb_dau', help: DAU_HELP, type: 'gauge', value: await dau(db, day), labels: { host: 'all' } },
  ];
  for (const { host, n } of await dauByHost(db, day)) {
    out.push({ name: 'bb_dau', help: DAU_HELP, type: 'gauge', value: n, labels: { host } });
  }
  for (const { name, n } of await eventCounts(db, day)) {
    out.push({
      name: 'bb_events_day',
      help: 'Analytics events stored on the last complete day, by name.',
      type: 'gauge',
      value: n,
      labels: { event: name },
    });
  }
  for (const { screen, n } of await screenViewCounts(db, day)) {
    out.push({
      name: 'bb_screen_views_day',
      help: 'Screen views on the last complete day, by screen.',
      type: 'gauge',
      value: n,
      labels: { screen },
    });
  }
  return [...out, ...(await retentionGauges(db, todayKey))];
}

/**
 * Compute and PERSIST the last complete day's numbers.
 *
 * Idempotent by key: every write is an upsert on `(day, metric, labels)`, which is the
 * unique index `db.ts` creates, so running this twice in a day replaces rather than
 * duplicates. That matters because the caller is a timer in a process that restarts on
 * deploy.
 *
 * The reads all happen BEFORE the transaction opens, for the reason `store.ts`'s header
 * gives at length: `withTransaction` may run its callback more than once, so the callback
 * holds writes of already-decided values and nothing else. `nowMs` is a parameter for the
 * same reason — a `Date.now()` inside would stamp a different `computedAt` on a retry.
 *
 * Returns the number of documents written, so a caller can log something falsifiable rather
 * than "rollup ok".
 */
export async function persistRollup(db: Db, todayKey: string, nowMs: number): Promise<number> {
  const day = lastCompleteDay(todayKey);
  const rows: { metric: string; labels: Record<string, string>; value: number }[] = [
    { metric: 'dau', labels: { host: 'all' }, value: await dau(db, day) },
    ...(await dauByHost(db, day)).map((h) => ({ metric: 'dau', labels: { host: h.host }, value: h.n })),
    ...(await eventCounts(db, day)).map((e) => ({ metric: 'events', labels: { event: e.name }, value: e.n })),
    ...(await screenViewCounts(db, day)).map((v) => ({
      metric: 'screen_views',
      labels: { screen: v.screen },
      value: v.n,
    })),
  ];
  // Retention is persisted against the COHORT's day, not today's — the document says "this
  // cohort returned at this rate", which is a fact about that day and stays true.
  const retention: { day: string; metric: string; labels: Record<string, string>; value: number }[] = [];
  for (const offset of RETENTION_OFFSETS) {
    const r = await cohortRate(db, newestKnownCohort(todayKey, offset), offset, todayKey);
    if (r === null) continue;
    retention.push({ day: r.cohortDay, metric: 'retention', labels: { d: String(offset) }, value: r.rate });
    retention.push({ day: r.cohortDay, metric: 'cohort_size', labels: { d: String(offset) }, value: r.size });
  }

  const docs: DailyRollupDoc[] = [
    ...rows.map((r) => ({ day, metric: r.metric, labels: canonicalLabels(r.labels), value: r.value, computedAt: nowMs })),
    ...retention.map((r) => ({
      day: r.day,
      metric: r.metric,
      labels: canonicalLabels(r.labels),
      value: r.value,
      computedAt: nowMs,
    })),
  ];

  const session = db.client.startSession();
  try {
    await session.withTransaction(async () => {
      await dailyRollupOf(db).bulkWrite(
        docs.map((d) => ({
          replaceOne: { filter: { day: d.day, metric: d.metric, labels: d.labels }, replacement: d, upsert: true },
        })),
        { session },
      );
    });
  } finally {
    await session.endSession();
  }
  return docs.length;
}

/** Labels as a stable string, so the uniqueness key means what it looks like.
 *  `JSON.stringify` preserves insertion order, which two callers building the same object
 *  from different code paths would not — so the keys are sorted before serialising. */
export function canonicalLabels(labels: Record<string, string>): string {
  const keys = Object.keys(labels).sort();
  return JSON.stringify(Object.fromEntries(keys.map((k) => [k, labels[k]])));
}
