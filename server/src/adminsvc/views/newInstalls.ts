/**
 * The new-install view (design/21 §2.7, §2.8) — `dailyRollup`'s `new_*` rows for ONE host (or
 * `all`) rendered as one grid: a cohort day per row, its first-day funnel and depth, then its
 * D1–D7. A sibling of `retention.ts`, which keeps the all-active grid; both read the same
 * collection and share its label parsers.
 *
 * The same absent-is-not-zero rule as `retention.ts`, applied to more kinds of cell: a funnel
 * step with no row is `null` (the rollup never computed that day for that host), not 0, and a
 * retention cell needs BOTH its rate and its size row to be shown. The one exception is the
 * depth histogram, whose writer emits only floors somebody reached — there a missing floor on
 * a day with an `installs` row IS 0, and the grid shows the floors it has.
 */
import type { Db } from 'mongodb';
import { dailyRollupOf } from '../../analytics/db';
import { ALL_HOSTS, FUNNEL_STEPS, NEW_METRICS, type FunnelStep } from '../../analytics/newInstalls';
import { GRID_DAYS, GRID_OFFSETS, hostFromLabels, offsetFromLabels, type CohortCell } from './retention';

export interface NewInstallRow {
  /** `YYYY-MM-DD`, the cohort's first day. */
  day: string;
  /** Installs whose first day this was; `null` when the rollup has no row for the day. */
  installs: number | null;
  /** Distinct new installs that reached each step on their first day. */
  funnel: Record<FunnelStep, number | null>;
  /** New installs whose id did not survive a write; `null` when unknown. */
  unpersisted: number | null;
  /** Deepest first-day floor → new installs, ascending by floor. */
  depth: [number, number][];
  cells: Record<number, CohortCell>;
}

export interface NewInstallGrid {
  /** The host this grid is for — `all`, or one host's label. */
  host: string;
  /** Every host that has any `new_installs` row, for the selector; `all` first. */
  hosts: string[];
  /** Newest cohort first. */
  rows: NewInstallRow[];
  offsets: readonly number[];
  steps: readonly FunnelStep[];
}

/** Parse a labels string to an object, or `null` when it is not one. */
function labelsOf(labels: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(labels);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The `step` label of a `new_funnel` document, or `null` when it is not one of ours. */
export function stepFromLabels(labels: string): FunnelStep | null {
  const step = labelsOf(labels)?.step;
  return (FUNNEL_STEPS as readonly unknown[]).includes(step) ? (step as FunnelStep) : null;
}

/** The `floor` label of a `new_depth` document, or `null` when it is not a positive integer. */
export function floorFromLabels(labels: string): number | null {
  const floor = labelsOf(labels)?.floor;
  return typeof floor === 'string' && /^[1-9][0-9]*$/.test(floor) ? Number(floor) : null;
}

/**
 * The new-install grid for `host` over the newest `days` days that have any `new_*` row,
 * newest first.
 *
 * Unlike `cohortGrid`, the window is taken over the `new_*` metrics only: they start on the
 * day this shipped (plus whatever the rollup back-filled), and taking the window over the
 * whole collection would fill the top of the grid with days that predate the metric.
 *
 * `host` is matched against the stored label exactly, so an unknown value is an empty grid
 * rather than an error — the route passes the query string through, and an empty grid with
 * the host named in its heading is the clear answer to a typo.
 */
export async function newInstallGrid(analytics: Db, host: string = ALL_HOSTS, days = GRID_DAYS): Promise<NewInstallGrid> {
  const metrics = Object.values(NEW_METRICS);
  const rollup = dailyRollupOf(analytics);

  const hostLabels = await rollup.distinct('labels', { metric: NEW_METRICS.installs });
  const known = new Set(hostLabels.map(hostFromLabels).filter((h): h is string => h !== null));
  known.delete(ALL_HOSTS);
  const hosts = [ALL_HOSTS, ...[...known].sort()];

  // The window is the same for every host, so switching host keeps the same days in view: a
  // day on which this host has no rows is a row of dashes — it had no activity there — rather
  // than missing, which would read as the grid skipping a day.
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

  type Acc = {
    installs: number | null;
    unpersisted: number | null;
    funnel: Map<FunnelStep, number>;
    depth: Map<number, number>;
    rate: Map<number, number>;
    size: Map<number, number>;
  };
  const byDay = new Map<string, Acc>(
    recentDays.map((d) => [
      d,
      { installs: null, unpersisted: null, funnel: new Map(), depth: new Map(), rate: new Map(), size: new Map() },
    ]),
  );

  for (const doc of docs) {
    if (hostFromLabels(doc.labels) !== host) continue;
    // Every doc's day is in `recentDays` — the `find` asked for exactly those.
    const acc = byDay.get(doc.day) as Acc;
    if (doc.metric === NEW_METRICS.installs) {
      acc.installs = doc.value;
    } else if (doc.metric === NEW_METRICS.unpersisted) {
      acc.unpersisted = doc.value;
    } else if (doc.metric === NEW_METRICS.funnel) {
      const step = stepFromLabels(doc.labels);
      if (step !== null) acc.funnel.set(step, doc.value);
    } else if (doc.metric === NEW_METRICS.depth) {
      const floor = floorFromLabels(doc.labels);
      if (floor !== null) acc.depth.set(floor, doc.value);
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
    const depth = [...acc.depth].sort((a, b) => a[0] - b[0]);
    return { day, installs: acc.installs, funnel, unpersisted: acc.unpersisted, depth, cells };
  });

  return { host, hosts, rows, offsets: GRID_OFFSETS, steps: FUNNEL_STEPS };
}
