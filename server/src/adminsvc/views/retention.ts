/**
 * The retention view (design/21 §3.2, third section) — `dailyRollup` rendered as a D1–D7
 * cohort grid.
 *
 * This is the one section of the console that is not a convenience. Decision A5: Prometheus
 * here runs with `--storage.tsdb.retention.time=15d` and a gauge cannot be backfilled, so a
 * Grafana retention chart silently begins two weeks ago no matter how long the game has
 * been live. `dailyRollup` is the record, it is kept without a time limit (it holds no id
 * of any kind), and this file is the only thing that reads it as history.
 *
 * ## The one rule this file exists to enforce: absent is not zero
 *
 * `rollup.ts` already refuses to emit a gauge for a cohort that has not aged — a D7 rate
 * for a cohort three days old is UNKNOWN, and a gauge has no way to say so, so the metric
 * is simply not there. That means the grid's empty cells arrive as MISSING ROWS, and a grid
 * that renders a missing row as `0%` would say "nobody came back" for every cohort in the
 * first week after launch — the exact failure the design doc spends a paragraph on, arriving
 * one layer further out.
 *
 * So {@link CohortCell} is `{ rate, size } | null`, `null` means unknown, and `rate: 0` is
 * a real measurement of nobody returning. The two are different types here so that a page
 * cannot accidentally treat them alike, and `adminsvc.retention.test.ts` pins a grid
 * containing both.
 *
 * ## Why the rows are keyed by the COHORT's day
 *
 * `persistRollup` writes a retention row against the cohort's own day rather than the day
 * it was computed, because the row states a fact about that cohort which stays true. The
 * consequence for this grid is the useful one: a cohort's row fills in from the left as
 * days pass, one cell per day, and reading down a column is reading the same offset across
 * cohorts. Nothing here has to reconstruct which day a number was computed on.
 */
import type { Db } from 'mongodb';
import { dailyRollupOf } from '../../analytics/db';

/** The offsets the grid has columns for. Deliberately a local copy of `rollup.ts`'s
 *  `RETENTION_OFFSETS` shape rather than an import of it: this module reads whatever offsets
 *  are actually IN the collection, and the constant only decides which columns are drawn.
 *  If the rollup ever adds D14, this grid shows the column the day this line changes and
 *  shows `—` until documents for it exist, which is the correct order for the two edits. */
export const GRID_OFFSETS = [1, 2, 3, 4, 5, 6, 7] as const;

/** How many cohort days the grid shows. 60 rows is two months of history on one page and
 *  ~500 rollup rows to read — small enough not to need paging, long enough to see a trend
 *  that Prometheus's 15-day window cuts in half. */
export const GRID_DAYS = 60;

/**
 * One cell. `null` for "not known yet" — see the file header. When present, `size` is the
 * cohort's own DAU, so a rate can be read against the number of people behind it rather
 * than on its own (a 100% D1 off a cohort of one is not a retention finding).
 */
export type CohortCell = { rate: number; size: number } | null;

export interface CohortRow {
  /** `YYYY-MM-DD`. */
  day: string;
  /** Distinct installs active that day, from the `dau{host=all}` rollup row. `null` when
   *  that row is missing — which happens for a day before the rollup job existed, and is
   *  not the same as a day on which nobody played. */
  dau: number | null;
  /** Keyed by offset, one entry per {@link GRID_OFFSETS} member. */
  cells: Record<number, CohortCell>;
}

export interface RetentionGrid {
  /** Newest cohort first, so the page opens on the days somebody is actually asking about. */
  rows: CohortRow[];
  offsets: readonly number[];
  /** How many `dailyRollup` documents the whole collection holds. The one honest "is this
   *  instrument seeing anything?" number: an empty grid with a zero here is an empty
   *  collection, and an empty grid with a non-zero here is a bug in this file. §2.5's "the
   *  instrument must be shown to see the change", made visible on the page rather than only
   *  in a test. */
  rollupRows: number;
}

/**
 * Pulls the offset out of a `dailyRollup.labels` value.
 *
 * The field holds `canonicalLabels`'s output — a JSON object with sorted keys, e.g.
 * `{"d":"3"}`. Parsed rather than pattern-matched, because a `{ labels: /3/ }` would also
 * match a host label containing a 3, which is the kind of miscount that looks like data.
 * Returns `null` for anything that is not a `d` label with a positive integer in it, so a
 * document written by some later metric cannot land in a retention column.
 */
export function offsetFromLabels(labels: string): number | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(labels);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const d = (parsed as Record<string, unknown>).d;
  if (typeof d !== 'string' || !/^[1-9][0-9]*$/.test(d)) return null;
  return Number(d);
}

/** The `host` label of a `dau` document, or `null` when it has none. Used to pick out the
 *  `host=all` total, which is the row the grid's DAU column shows. */
export function hostFromLabels(labels: string): string | null {
  try {
    const parsed: unknown = JSON.parse(labels);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const host = (parsed as Record<string, unknown>).host;
    return typeof host === 'string' ? host : null;
  } catch {
    return null;
  }
}

/**
 * The cohort grid, newest cohort first.
 *
 * Reads three metrics over the newest `days` days of `dailyRollup`: `retention` (the
 * rate), `cohort_size` (how many people it is a rate of) and `dau` (the day's total,
 * `host=all`). Two round trips rather than one per cell: the whole grid is a few hundred
 * documents, and per-cell reads would be `days * offsets` round trips to answer a question
 * the collection can answer at once.
 *
 * The first trip is the `SELECT DISTINCT day … ORDER BY day DESC LIMIT ?` subquery this
 * replaces, as a `$group` on `day`. A separate query rather than a self-`$lookup` because
 * the two steps ask different questions — WHICH days, then everything about them — and the
 * subquery deliberately took its distinct days over the WHOLE collection rather than only
 * over the three metrics. A day that exists solely because some later metric was written
 * for it still counts toward the sixty, so the grid's window does not silently lengthen the
 * day a metric is added.
 *
 * A day appears as a row if the rollup wrote ANY of those three metrics for it. A day with
 * a `dau` document and no retention documents is a real and common state — it is every day
 * younger than one offset — and it belongs in the grid with empty cells rather than being
 * missing from it, because a missing row reads as "no data collected that day".
 */
export async function cohortGrid(analytics: Db, days = GRID_DAYS): Promise<RetentionGrid> {
  const rollup = dailyRollupOf(analytics);
  const total = await rollup.countDocuments({});

  const recentDays = (
    await rollup
      .aggregate<{ _id: string }>([{ $group: { _id: '$day' } }, { $sort: { _id: -1 } }, { $limit: days }])
      .toArray()
  ).map((d) => d._id);

  const rows = await rollup
    .find({ metric: { $in: ['retention', 'cohort_size', 'dau'] }, day: { $in: recentDays } })
    .sort({ day: -1 })
    .toArray();

  const byDay = new Map<string, { dau: number | null; rate: Map<number, number>; size: Map<number, number> }>();
  const ensure = (day: string) => {
    const existing = byDay.get(day);
    if (existing !== undefined) return existing;
    const fresh = { dau: null as number | null, rate: new Map<number, number>(), size: new Map<number, number>() };
    byDay.set(day, fresh);
    return fresh;
  };

  for (const row of rows) {
    const day = row.day;
    const value = row.value;
    if (row.metric === 'dau') {
      // Only the `host=all` partition total. The per-host rows are a partition OF this
      // number (`analytics/db.ts`'s header) and summing them here would be right today and
      // wrong the moment a row is written for a host the grid does not know about.
      if (hostFromLabels(row.labels) === 'all') ensure(day).dau = value;
      continue;
    }
    const offset = offsetFromLabels(row.labels);
    if (offset === null) continue;
    const entry = ensure(day);
    if (row.metric === 'retention') entry.rate.set(offset, value);
    else entry.size.set(offset, value);
  }

  const out: CohortRow[] = [...byDay.entries()]
    // Newest first, through `localeCompare` with the arguments swapped rather than a
    // hand-written `a < b ? 1 : -1`. Day keys are `YYYY-MM-DD`, which sorts
    // lexicographically, and the rows already arrive `ORDER BY day DESC` — so a
    // hand-written comparator has an arm no input reaches, and a dead branch is something a
    // coverage gate cannot tell apart from an untested one.
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([day, entry]) => {
      const cells: Record<number, CohortCell> = {};
      for (const offset of GRID_OFFSETS) {
        const rate = entry.rate.get(offset);
        const size = entry.size.get(offset);
        // BOTH have to be present. A rate with no size behind it is a number nobody can
        // judge, and the rollup always writes the pair inside one transaction — so a rate
        // alone means something is wrong with the collection, and showing it as a
        // measurement would hide that.
        cells[offset] = rate === undefined || size === undefined ? null : { rate, size };
      }
      return { day, dau: entry.dau, cells };
    });

  return { rows: out, offsets: GRID_OFFSETS, rollupRows: total };
}
