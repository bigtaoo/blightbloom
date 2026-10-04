/**
 * The new-install view (design/21 §2.7) — `dailyRollup`'s `new_*` rows rendered as one grid:
 * a cohort day per row, its first-day funnel, then its D1–D7. A sibling of `retention.ts`,
 * which keeps the all-active grid; both read the same collection and share its label parsers.
 *
 * The same absent-is-not-zero rule as `retention.ts`, applied to two more kinds of cell: a
 * funnel step with no row is `null` (the rollup never computed that day), not 0, and a
 * retention cell needs BOTH its rate and its size row to be shown.
 */
import type { Db } from 'mongodb';
import { dailyRollupOf } from '../../analytics/db';
import { FUNNEL_STEPS, NEW_METRICS, type FunnelStep } from '../../analytics/newInstalls';
import { GRID_DAYS, GRID_OFFSETS, offsetFromLabels, type CohortCell } from './retention';

export interface NewInstallRow {
  /** `YYYY-MM-DD`, the cohort's first day. */
  day: string;
  /** Installs whose first day this was; `null` when the rollup has no row for the day. */
  installs: number | null;
  /** Distinct new installs that reached each step on their first day. */
  funnel: Record<FunnelStep, number | null>;
  cells: Record<number, CohortCell>;
}

export interface NewInstallGrid {
  /** Newest cohort first. */
  rows: NewInstallRow[];
  offsets: readonly number[];
  steps: readonly FunnelStep[];
}

/** The `step` label of a `new_funnel` document, or `null` when it is not one of ours. */
export function stepFromLabels(labels: string): FunnelStep | null {
  try {
    const parsed: unknown = JSON.parse(labels);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const step = (parsed as Record<string, unknown>).step;
    return (FUNNEL_STEPS as readonly unknown[]).includes(step) ? (step as FunnelStep) : null;
  } catch {
    return null;
  }
}

/**
 * The new-install grid over the newest `days` days that have any `new_*` row, newest first.
 *
 * Unlike `cohortGrid`, the window is taken over the `new_*` metrics only: they start on the
 * day this shipped (plus whatever the rollup back-filled), and taking the window over the
 * whole collection would fill the top of the grid with days that predate the metric.
 */
export async function newInstallGrid(analytics: Db, days = GRID_DAYS): Promise<NewInstallGrid> {
  const metrics = Object.values(NEW_METRICS);
  const rollup = dailyRollupOf(analytics);
  const recentDays = (
    await rollup
      .aggregate<{ _id: string }>([
        { $match: { metric: { $in: metrics } } },
        { $group: { _id: '$day' } },
        { $sort: { _id: -1 } },
        { $limit: days },
      ])
      .toArray()
  ).map((d) => d._id);

  const docs = await rollup.find({ metric: { $in: metrics }, day: { $in: recentDays } }).toArray();

  type Acc = { installs: number | null; funnel: Map<FunnelStep, number>; rate: Map<number, number>; size: Map<number, number> };
  const byDay = new Map<string, Acc>(
    recentDays.map((d) => [d, { installs: null, funnel: new Map(), rate: new Map(), size: new Map() }]),
  );

  for (const doc of docs) {
    // Every doc's day is in `recentDays` — the `find` asked for exactly those.
    const acc = byDay.get(doc.day) as Acc;
    if (doc.metric === NEW_METRICS.installs) {
      acc.installs = doc.value;
    } else if (doc.metric === NEW_METRICS.funnel) {
      const step = stepFromLabels(doc.labels);
      if (step !== null) acc.funnel.set(step, doc.value);
    } else {
      const offset = offsetFromLabels(doc.labels);
      if (offset === null) continue;
      (doc.metric === NEW_METRICS.retention ? acc.rate : acc.size).set(offset, doc.value);
    }
  }

  const rows: NewInstallRow[] = recentDays.map((day) => {
    const acc = byDay.get(day) as Acc;
    const funnel = Object.fromEntries(FUNNEL_STEPS.map((s) => [s, acc.funnel.get(s) ?? null])) as Record<
      FunnelStep,
      number | null
    >;
    const cells: Record<number, CohortCell> = {};
    for (const offset of GRID_OFFSETS) {
      const rate = acc.rate.get(offset);
      const size = acc.size.get(offset);
      cells[offset] = rate === undefined || size === undefined ? null : { rate, size };
    }
    return { day, installs: acc.installs, funnel, cells };
  });

  return { rows, offsets: GRID_OFFSETS, steps: FUNNEL_STEPS };
}
