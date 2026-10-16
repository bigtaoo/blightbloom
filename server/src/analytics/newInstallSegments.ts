// New-install visits — split out of `newInstalls.ts` (design/21 §2.9): what a new install's
// first day says about WHERE it came from, WHAT it ran on, and HOW LONG it played. Read beside
// `newInstallQueries.ts`'s `firstDays` rather than folded into it, because the two answer
// different questions — that one "how far did they get", this one "who were they, and did they
// stay" — and the rows this one writes (`new_seg`) are deliberately never gauges.
//
// ## Playtime is VISIBLE time, and a visit counts once
//
// A visit reports its visible seconds cumulatively (`active_time` about once a minute, and
// `session_end` when the page goes away), so a visit's playtime is the MAX it reported, and an
// install's first-day playtime is the sum over its visits. An install with no such report at
// all is UNMEASURED, not zero: every client before this shipped, and a visit killed inside its
// first minute without a `pagehide`. Averages are over the measured, and the count of them is
// written beside the average so a reader can see how many there were.
//
// ## Segments carry counts, not rates
//
// `new_seg{host, dim, value, stat}` stores COUNTS — installs, each funnel step, the measured
// playtime's sum and count, and D1/D7 returns — so the console can pool a week of small days
// into one rate. A rate per day per segment, at tens of installs a day, is noise; seven days
// summed are a number.
import type { Db } from 'mongodb';
import { eventsOf, dailyActiveOf } from './db';
import { ALL_HOSTS, FUNNEL_STEPS, type Cohort, type FirstDay } from './newInstallQueries';

/** What a new install's first visit said about itself, and how long its first day lasted. */
export interface Visit {
  /** The campaign tag or `ref:<host>`; `direct` when the visit carried neither. */
  source: string;
  device: string;
  os: string;
  browser: string;
  /** Visible seconds summed over the day's visits, or null when no visit reported any. */
  playtime_s: number | null;
}

/** The label a segment gets when the first visit did not say: a pre-split client, or a host
 *  that cannot know (WeChat has no referrer). */
export const UNKNOWN = 'unknown';
export const DIRECT = 'direct';

const EMPTY_VISIT: Visit = { source: DIRECT, device: UNKNOWN, os: UNKNOWN, browser: UNKNOWN, playtime_s: null };

/** The dimensions `new_seg` splits by — each a `session_start` prop. */
export const SEGMENT_DIMS = ['source', 'device', 'os', 'browser'] as const;
export type SegmentDim = (typeof SEGMENT_DIMS)[number];

/** More distinct sources than this on one day fold the smallest into `other`: a referrer is
 *  somebody else's hostname, and a day of scrapers must not become a thousand rows. */
export const MAX_SOURCES = 20;
export const OTHER_SOURCE = 'other';

/**
 * Playtime histogram bucket lower bounds, in MINUTES. Uneven on purpose: the question at
 * launch is "did they leave in the first minute, the first five, or stay", and the platform's
 * own benchmark sits somewhere in the tens of minutes.
 */
export const PLAYTIME_BUCKETS_MIN = [0, 1, 3, 5, 10, 20, 30, 60] as const;

/** The `dailyRollup` metric names this module writes. */
export const SEGMENT_METRICS = {
  /** Installs with at least one playtime report — the denominator of the two below. */
  playtimeMeasured: 'new_playtime_measured',
  playtimeAvg: 'new_playtime_avg_s',
  playtimeP50: 'new_playtime_p50_s',
  /** Measured installs per {@link PLAYTIME_BUCKETS_MIN} bucket, labelled by its lower bound. */
  playtime: 'new_playtime',
  segment: 'new_seg',
} as const;

/**
 * Each cohort member's first visit context and first-day playtime. Two reads: the day's first
 * `session_start` per install, and the max visible time per visit.
 */
export async function firstDayVisits(db: Db, day: string, cohort: Cohort): Promise<Map<string, Visit>> {
  const out = new Map<string, Visit>();
  if (cohort.size === 0) return out;
  const installs = [...cohort.keys()];
  const starts = await eventsOf(db)
    .aggregate<{ _id: string; source?: string | null; device?: string | null; os?: string | null; browser?: string | null }>([
      { $match: { day, install: { $in: installs }, name: 'session_start' } },
      { $sort: { atMs: 1 } },
      {
        $group: {
          _id: '$install',
          source: { $first: '$props.source' },
          device: { $first: '$props.device' },
          os: { $first: '$props.os' },
          browser: { $first: '$props.browser' },
        },
      },
    ])
    .toArray();
  const played = await eventsOf(db)
    .aggregate<{ _id: string; s: number }>([
      { $match: { day, install: { $in: installs }, name: { $in: ['active_time', 'session_end'] }, 'props.active_s': { $type: 'number' } } },
      { $group: { _id: { install: '$install', session: '$session' }, s: { $max: '$props.active_s' } } },
      { $group: { _id: '$_id.install', s: { $sum: '$s' } } },
    ])
    .toArray();
  const playtime = new Map(played.map((r) => [r._id, r.s]));
  for (const r of starts) {
    out.set(r._id, {
      source: r.source ?? DIRECT,
      device: r.device ?? UNKNOWN,
      os: r.os ?? UNKNOWN,
      browser: r.browser ?? UNKNOWN,
      playtime_s: playtime.get(r._id) ?? null,
    });
  }
  for (const install of cohort.keys()) {
    if (!out.has(install)) out.set(install, { ...EMPTY_VISIT, playtime_s: playtime.get(install) ?? null });
  }
  return out;
}

type Row = { metric: string; labels: Record<string, string>; value: number };

/** The median of a non-empty sorted list, rounded to a whole second. */
function median(sorted: number[]): number {
  const mid = sorted.length >> 1;
  return Math.round(sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2);
}

/** The bucket a playtime falls in, as its lower bound in minutes. */
export function playtimeBucket(seconds: number): number {
  let b = 0;
  for (const lower of PLAYTIME_BUCKETS_MIN) if (seconds >= lower * 60) b = lower;
  return b;
}

/**
 * The first-day playtime rows, per host (`all` first). A host with no measured install gets
 * the measured count 0 and no average — there is nothing to average, and absent is not zero.
 * Every bucket is written for a host that has a measurement, zeros included, so a histogram
 * reads complete.
 */
export function playtimeNumbers(cohort: Cohort, visits: Map<string, Visit>, hosts: Iterable<string>): Row[] {
  const keys = [ALL_HOSTS, ...[...hosts].filter((h) => h !== ALL_HOSTS).sort()];
  const byHost = new Map<string, number[]>(keys.map((h) => [h, []]));
  for (const [install, host] of cohort) {
    const s = visits.get(install)?.playtime_s;
    if (s === null || s === undefined) continue;
    byHost.get(ALL_HOSTS)?.push(s);
    if (!byHost.has(host)) byHost.set(host, []);
    byHost.get(host)?.push(s);
  }
  const out: Row[] = [];
  for (const host of keys) {
    const all = (byHost.get(host) as number[]).sort((a, b) => a - b);
    out.push({ metric: SEGMENT_METRICS.playtimeMeasured, labels: { host }, value: all.length });
    if (all.length === 0) continue;
    out.push({ metric: SEGMENT_METRICS.playtimeAvg, labels: { host }, value: Math.round(all.reduce((a, b) => a + b, 0) / all.length) });
    out.push({ metric: SEGMENT_METRICS.playtimeP50, labels: { host }, value: median(all) });
    for (const lower of PLAYTIME_BUCKETS_MIN) {
      const n = all.filter((s) => playtimeBucket(s) === lower).length;
      out.push({ metric: SEGMENT_METRICS.playtime, labels: { host, bucket: String(lower) }, value: n });
    }
  }
  return out;
}

/** The segment value an install falls in for `dim`, after the source cap. */
function segmentOf(visit: Visit, dim: SegmentDim, keptSources: Set<string>): string {
  if (dim !== 'source') return visit[dim];
  return keptSources.has(visit.source) ? visit.source : OTHER_SOURCE;
}

/** The {@link MAX_SOURCES} commonest sources in the cohort; ties break by name so a rerun
 *  folds the same ones. */
function keptSourcesOf(cohort: Cohort, visits: Map<string, Visit>): Set<string> {
  const n = new Map<string, number>();
  for (const install of cohort.keys()) {
    const s = (visits.get(install) ?? EMPTY_VISIT).source;
    n.set(s, (n.get(s) ?? 0) + 1);
  }
  const ranked = [...n].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  return new Set(ranked.slice(0, MAX_SOURCES).map(([s]) => s));
}

/**
 * Group the cohort by host (`all` and each member's own) × dimension × value, and hand each
 * group to `stats`. Shared by the first-day rows and the return rows so both fold sources
 * identically — a D1 count under a different `other` than its install count is a wrong rate.
 */
function bySegment(cohort: Cohort, visits: Map<string, Visit>, stats: (members: string[]) => [string, number][]): Row[] {
  const kept = keptSourcesOf(cohort, visits);
  const groups = new Map<string, string[]>();
  for (const [install, host] of cohort) {
    const visit = visits.get(install) ?? EMPTY_VISIT;
    for (const h of [ALL_HOSTS, host]) {
      for (const dim of SEGMENT_DIMS) {
        const key = JSON.stringify([h, dim, segmentOf(visit, dim, kept)]);
        const list = groups.get(key) ?? [];
        list.push(install);
        groups.set(key, list);
      }
    }
  }
  const out: Row[] = [];
  for (const key of [...groups.keys()].sort()) {
    const [host, dim, value] = JSON.parse(key) as [string, string, string];
    for (const [stat, v] of stats(groups.get(key) as string[])) {
      out.push({ metric: SEGMENT_METRICS.segment, labels: { host, dim, value, stat }, value: v });
    }
  }
  return out;
}

/**
 * The first-day `new_seg` rows: per segment, the installs, each funnel step, and the measured
 * playtime's count and sum. Only segments somebody is in get rows.
 */
export function segmentNumbers(cohort: Cohort, profiles: Map<string, FirstDay>, visits: Map<string, Visit>): Row[] {
  return bySegment(cohort, visits, (members) => {
    const measured = members.map((i) => visits.get(i)?.playtime_s).filter((s): s is number => typeof s === 'number');
    return [
      ['installs', members.length],
      ...FUNNEL_STEPS.map((step): [string, number] => [step, members.filter((i) => profiles.get(i)?.[step] === true).length]),
      ['playtime_n', measured.length],
      ['playtime_s', measured.reduce((a, b) => a + b, 0)],
    ];
  });
}

/** The offsets whose returns are split by segment. The rest of the grid is there in total;
 *  these two are the ones a platform benchmark names. */
export const SEGMENT_RETURN_OFFSETS = [1, 7] as const;

/** The `new_seg` return rows for one cohort: `stat = d<offset>`, the members active again on
 *  `returnDay`. Written against the cohort's day, like every retention cell. */
export async function segmentReturns(db: Db, cohort: Cohort, visits: Map<string, Visit>, offset: number, returnDay: string): Promise<Row[]> {
  if (cohort.size === 0) return [];
  const back = new Set(
    (
      await dailyActiveOf(db)
        .find({ day: returnDay, install: { $in: [...cohort.keys()] } }, { projection: { _id: 0, install: 1 } })
        .toArray()
    ).map((r) => r.install),
  );
  return bySegment(cohort, visits, (members) => [[`d${offset}`, members.filter((i) => back.has(i)).length]]);
}
