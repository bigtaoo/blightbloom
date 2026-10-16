/**
 * The launch view (design/21 §2.9) — the three numbers a portal grades a launch on, read back
 * from `dailyRollup` for ONE host (or `all`): conversion to gameplay (the open funnel),
 * first-day playtime, and who the new installs were (the segment split, with their D1/D7).
 * A sibling of `newInstalls.ts`, which keeps the first-day funnel and the retention grid.
 *
 * Per-day rows for the funnel and playtime, newest first. The segment table is POOLED over
 * the window instead: its counts were written as counts precisely so that a week of small
 * days can be summed into one rate. A D1/D7 rate pools only the days whose return is known —
 * a day with no `d1` row for this host is a day whose day-after has not been rolled up yet,
 * and counting its installs in the denominator would read as nobody coming back.
 */
import type { Db } from 'mongodb';
import { dailyRollupOf } from '../../analytics/db';
import { ALL_HOSTS, FUNNEL_STEPS } from '../../analytics/newInstallQueries';
import { PLAYTIME_BUCKETS_MIN, SEGMENT_DIMS, SEGMENT_METRICS, SEGMENT_RETURN_OFFSETS, type SegmentDim } from '../../analytics/newInstallSegments';
import { OPEN_METRICS, OPEN_STEPS, type OpenStep } from '../../analytics/pageOpens';

/** How many days the console shows and the segment table pools. */
export const LAUNCH_DAYS = 7;

export interface LaunchDay {
  day: string;
  /** Visits per open-funnel step; `null` when the rollup wrote no open funnel that day. */
  open: Record<OpenStep, number> | null;
  bootP50: number | null;
  bootP90: number | null;
  /** New installs with a playtime report, and their mean and median first-day seconds. */
  measured: number | null;
  avgS: number | null;
  p50S: number | null;
  /** Measured installs per bucket lower bound (minutes). */
  buckets: [number, number][];
}

export interface SegmentRow {
  value: string;
  installs: number;
  menu: number;
  run_start: number;
  run_finished: number;
  playtimeN: number;
  playtimeS: number;
  /** Returned, and the installs of the days whose return at that offset is known. */
  returns: Record<number, { back: number; base: number }>;
}

export interface LaunchView {
  host: string;
  days: LaunchDay[];
  segments: Record<SegmentDim, SegmentRow[]>;
}

type Labels = Record<string, unknown>;
function labelsOf(labels: string): Labels {
  try {
    const parsed: unknown = JSON.parse(labels);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Labels) : {};
  } catch {
    return {};
  }
}

const SEG_STATS = new Set<string>(['installs', ...FUNNEL_STEPS, 'playtime_n', 'playtime_s', ...SEGMENT_RETURN_OFFSETS.map((d) => `d${d}`)]);

/** The launch view for `host` over the newest `days` days that have any of its metrics. */
export async function launchView(analytics: Db, host: string = ALL_HOSTS, days = LAUNCH_DAYS): Promise<LaunchView> {
  const metrics = [...Object.values(OPEN_METRICS), ...Object.values(SEGMENT_METRICS)];
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

  const byDay = new Map<string, LaunchDay>(
    recentDays.map((day) => [day, { day, open: null, bootP50: null, bootP90: null, measured: null, avgS: null, p50S: null, buckets: [] }]),
  );
  // segment key → per-day stat → value
  const seg = new Map<string, Map<string, Map<string, number>>>();
  const returnDays = new Map<string, Set<string>>();

  for (const doc of docs) {
    const l = labelsOf(doc.labels);
    if (l.host !== host) continue;
    const d = byDay.get(doc.day) as LaunchDay;
    switch (doc.metric) {
      case OPEN_METRICS.funnel:
        if ((OPEN_STEPS as readonly unknown[]).includes(l.step)) {
          d.open ??= { open: 0, boot: 0, menu: 0, run_start: 0 };
          d.open[l.step as OpenStep] = doc.value;
        }
        break;
      case OPEN_METRICS.bootMs:
        if (l.q === 'p50') d.bootP50 = doc.value;
        else if (l.q === 'p90') d.bootP90 = doc.value;
        break;
      case SEGMENT_METRICS.playtimeMeasured:
        d.measured = doc.value;
        break;
      case SEGMENT_METRICS.playtimeAvg:
        d.avgS = doc.value;
        break;
      case SEGMENT_METRICS.playtimeP50:
        d.p50S = doc.value;
        break;
      case SEGMENT_METRICS.playtime: {
        const b = Number(l.bucket);
        if ((PLAYTIME_BUCKETS_MIN as readonly number[]).includes(b)) d.buckets.push([b, doc.value]);
        break;
      }
      default: {
        // `new_seg`
        const { dim, value, stat } = l;
        if (!(SEGMENT_DIMS as readonly unknown[]).includes(dim) || typeof value !== 'string' || typeof stat !== 'string' || !SEG_STATS.has(stat)) break;
        const key = JSON.stringify([dim, value]);
        const stats = seg.get(key) ?? new Map<string, Map<string, number>>();
        const perDay = stats.get(stat) ?? new Map<string, number>();
        perDay.set(doc.day, doc.value);
        stats.set(stat, perDay);
        seg.set(key, stats);
        if (stat.startsWith('d')) {
          const known = returnDays.get(stat) ?? new Set<string>();
          known.add(doc.day);
          returnDays.set(stat, known);
        }
      }
    }
  }

  const segments = Object.fromEntries(SEGMENT_DIMS.map((dim) => [dim, [] as SegmentRow[]])) as Record<SegmentDim, SegmentRow[]>;
  for (const [key, stats] of seg) {
    const [dim, value] = JSON.parse(key) as [SegmentDim, string];
    const sum = (stat: string, only?: Set<string>): number =>
      [...(stats.get(stat) ?? new Map<string, number>())].filter(([day]) => only === undefined || only.has(day)).reduce((a, [, v]) => a + v, 0);
    const returns: SegmentRow['returns'] = {};
    for (const offset of SEGMENT_RETURN_OFFSETS) {
      const known = returnDays.get(`d${offset}`) ?? new Set<string>();
      returns[offset] = { back: sum(`d${offset}`), base: sum('installs', known) };
    }
    segments[dim].push({
      value,
      installs: sum('installs'),
      menu: sum('menu'),
      run_start: sum('run_start'),
      run_finished: sum('run_finished'),
      playtimeN: sum('playtime_n'),
      playtimeS: sum('playtime_s'),
      returns,
    });
  }
  for (const dim of SEGMENT_DIMS) segments[dim].sort((a, b) => b.installs - a.installs || (a.value < b.value ? -1 : 1));
  for (const d of byDay.values()) d.buckets.sort((a, b) => a[0] - b[0]);

  return { host, days: recentDays.map((day) => byDay.get(day) as LaunchDay), segments };
}
