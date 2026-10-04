/**
 * New-install analytics (design/21 §2.7, §2.8) — the cohort that D1/D7 retention actually
 * means, the first-day funnel of that cohort, and both split by host. Split out of `rollup.ts`
 * as an independent function module; `rollup.ts` calls in, nothing here calls back. The reads
 * live in `newInstallQueries.ts`; this file decides which rows and gauges they become.
 *
 * ## Why a second cohort definition
 *
 * `rollup.ts`'s `cohortRate` takes as its cohort EVERY install active on the cohort day. That
 * is a real number — "of the people who played on Monday, how many played on Tuesday" — but it
 * is not the one a platform, a portal dashboard or an industry benchmark calls D1 retention.
 * Those count only the installs whose FIRST day was the cohort day. Once a game has a returning
 * base the two diverge sharply and in one direction: the all-active rate is inflated by the
 * regulars, who come back every day, and reads healthy over a launch that is losing nearly
 * every new player.
 *
 * ## "New" is DERIVED from `dailyActive`, not stored
 *
 * An install is new on day D when it has a `dailyActive` document for D and none for any
 * earlier day. That is a query, not a field, deliberately:
 *
 *  - **No schema change and no backfill.** Every `dailyActive` document already written
 *    answers the question; a stored `firstDay` would read as "new on deploy day" for every
 *    install that existed before the deploy, which is a fake acquisition spike on exactly the
 *    day somebody is checking whether the change worked.
 *  - **No new retention window.** A stored first-seen record per install is a new kind of
 *    row the privacy policy would have to name and bound. This reads only rows the policy
 *    already covers.
 *
 * Its one caveat is the same window seen from the other side: `dailyActive` is pruned at
 * `ACTIVE_RETENTION_DAYS` (180), so an install that returns after more than that many days
 * away is counted new again. That is the honest reading of the data we are allowed to keep,
 * and it is ~half a year away from mattering.
 *
 * The other caveat is about the START of collection, not the end: on the first day analytics
 * ran, every install was "new" to it. The earliest cohorts in the grid therefore overstate new
 * installs, and that is visible (they are the first rows) rather than hidden.
 *
 * ## The funnel is per INSTALL, not per event
 *
 * `rollup.ts`'s `screenViewCounts` counts views, so one player bouncing between two screens
 * reads as traffic. The funnel here counts DISTINCT new installs that did each step on their
 * first day, which is the shape "where do new players stop?" needs. The steps are counted
 * independently rather than forced to nest — an install that started a run without a
 * `screen_view{menu}` (a dropped batch, a deep link) still counts as having started one — so a
 * step can in principle exceed the one before it, and when it does that is a finding about the
 * instrument, not something to hide with a `min`.
 *
 * ## Per host, and which zeros are measured
 *
 * Every row carries a `host` label: `all`, or one of the hosts. A host gets per-day rows only
 * on a day it had ANY activity — then "no new installs" is a measurement and is written as 0;
 * on a day it had none (before its build shipped, or with its analytics silently not
 * reaching us — design/21 §9 lists three ways on WeChat) nothing is written, because the data
 * cannot tell "nobody came" from "nothing arrived". A host with no new installs in a cohort
 * gets no retention cell, for the same reason an empty `all` cohort does not.
 *
 * Days are UTC (`ingest.ts`'s `dayKey`), like everything else in this store: a player in
 * Beijing has their "first day" end at 08:00 local time.
 */
import type { Db } from 'mongodb';
import { dailyRollupOf } from './db';
import {
  ALL_HOSTS,
  FUNNEL_STEPS,
  activeHostsByDay,
  cohortReturns,
  countByHost,
  firstDays,
  newCohort,
  type Cohort,
  type FirstDay,
} from './newInstallQueries';
import { RETENTION_OFFSETS, addDays, canonicalLabels, lastCompleteDay, newestKnownCohort } from './rollupKeys';

export { ALL_HOSTS, FUNNEL_STEPS, type FunnelStep } from './newInstallQueries';

/** The `dailyRollup` metric names this module writes. Distinct from `rollup.ts`'s
 *  `retention` / `cohort_size`, which keep their all-active meaning — the two cohorts answer
 *  different questions and both stay in the record. */
export const NEW_METRICS = {
  installs: 'new_installs',
  funnel: 'new_funnel',
  /** New installs whose id did not survive a write — they can never be seen returning. */
  unpersisted: 'new_unpersisted',
  /** New installs by the deepest floor they reached on their first day; one row per floor
   *  that has anybody on it. A floor with no row, on a day with an `installs` row, is 0. */
  depth: 'new_depth',
  retention: 'new_retention',
  cohortSize: 'new_cohort_size',
} as const;

/**
 * How many days back the rollup fills in a new-install number that is MISSING from the
 * record. Matches the console grid's sixty rows (`adminsvc/views/retention.ts`) and sits inside
 * the 90-day `events` window the funnel reads, so every day it reaches can still be computed.
 */
export const NEW_INSTALL_BACKFILL_DAYS = 60;

/** One number to write: `persistRollup` stamps `computedAt` and canonicalises the labels. */
export interface NewInstallRow {
  day: string;
  metric: string;
  labels: Record<string, string>;
  value: number;
}

/**
 * One first day's numbers, per host: the count, the funnel steps, the unpersisted count and
 * the depth histogram. `hosts` is the set active that day; `all` is always included.
 */
export function firstDayNumbers(
  cohort: Cohort,
  profiles: Map<string, FirstDay>,
  hosts: Iterable<string>,
): { metric: string; labels: Record<string, string>; value: number }[] {
  const out: { metric: string; labels: Record<string, string>; value: number }[] = [];
  const keys = [ALL_HOSTS, ...[...hosts].filter((h) => h !== ALL_HOSTS).sort()];
  const of = (install: string): FirstDay => profiles.get(install) as FirstDay;
  const tally = (keep: (p: FirstDay) => boolean): Map<string, number> => countByHost(cohort, (i) => keep(of(i)));

  const installs = countByHost(cohort);
  const steps = FUNNEL_STEPS.map((step) => ({ step, n: tally((p) => p[step]) }));
  const unpersisted = tally((p) => p.unpersisted);
  const depths = new Map<string, Map<number, number>>();
  for (const [install, host] of cohort) {
    const d = of(install).depth;
    if (d === 0) continue;
    for (const key of [ALL_HOSTS, host]) {
      const byFloor = depths.get(key) ?? new Map<number, number>();
      byFloor.set(d, (byFloor.get(d) ?? 0) + 1);
      depths.set(key, byFloor);
    }
  }

  for (const host of keys) {
    out.push({ metric: NEW_METRICS.installs, labels: { host }, value: installs.get(host) ?? 0 });
    for (const { step, n } of steps) out.push({ metric: NEW_METRICS.funnel, labels: { host, step }, value: n.get(host) ?? 0 });
    out.push({ metric: NEW_METRICS.unpersisted, labels: { host }, value: unpersisted.get(host) ?? 0 });
    for (const [floor, n] of [...(depths.get(host) ?? [])].sort((a, b) => a[0] - b[0])) {
      out.push({ metric: NEW_METRICS.depth, labels: { host, floor: String(floor) }, value: n });
    }
  }
  return out;
}

/**
 * The new-install rows this cycle should write.
 *
 * `rollup.ts`'s all-active numbers are only ever computed for the NEWEST cell — yesterday's
 * DAU, the newest cohort at each offset — so a day the job did not run on (a deploy, an outage
 * longer than a day) is a hole in the record forever. That was tolerable while the record was
 * the only one; for a cohort that starts on the day this ships it would also mean the grid
 * begins empty when every `dailyActive` row needed to fill it already exists. So this fills
 * holes, within {@link NEW_INSTALL_BACKFILL_DAYS}:
 *
 *  - **Per-day rows** (everything but retention) for every day in the window that has
 *    activity and no `new_installs{host=all}` row yet — plus the last complete day ALWAYS,
 *    because late batches (`ingest.ts` accepts timestamps up to a day old) keep changing it.
 *  - **Retention cells** for every knowable (cohort, offset) with no `all` row yet — plus the
 *    newest cohort at each offset always, for the same reason. All hosts of one cell are
 *    computed together, so the `all` row stands for the set.
 *
 * A day with NO activity gets nothing, not zeros: before collection began, or while it was
 * switched off, "nobody new arrived" is not something the data says (design/21 §2.5, absent is
 * not zero). An empty cohort gets no retention cell for the same reason.
 *
 * Steady state, this is the newest cells plus two reads over the window. The first cycle
 * after deploy computes up to sixty days of them, once.
 */
export async function newInstallRollupRows(db: Db, todayKey: string): Promise<NewInstallRow[]> {
  const last = lastCompleteDay(todayKey);
  const first = addDays(last, -(NEW_INSTALL_BACKFILL_DAYS - 1));
  const allLabel = (extra: Record<string, string> = {}): string => canonicalLabels({ host: ALL_HOSTS, ...extra });

  const stored = await dailyRollupOf(db)
    .find({ day: { $gte: first, $lte: last }, metric: { $in: [NEW_METRICS.installs, NEW_METRICS.retention] } })
    .toArray();
  const sizeByDay = new Map<string, number>();
  const haveCell = new Set<string>();
  for (const r of stored) {
    if (r.metric === NEW_METRICS.installs && r.labels === allLabel()) sizeByDay.set(r.day, r.value);
    else if (r.metric === NEW_METRICS.retention) haveCell.add(`${r.day}|${r.labels}`);
  }

  const hostsByDay = await activeHostsByDay(db, first, last);
  const dayTargets = new Set([...hostsByDay.keys()].filter((d) => !sizeByDay.has(d)));
  dayTargets.add(last);

  const cohorts = new Map<string, Cohort>();
  const cohortOf = async (day: string): Promise<Cohort> => {
    const known = cohorts.get(day);
    if (known !== undefined) return known;
    const c = await newCohort(db, day);
    cohorts.set(day, c);
    return c;
  };

  const out: NewInstallRow[] = [];
  for (const day of [...dayTargets].sort()) {
    const cohort = await cohortOf(day);
    sizeByDay.set(day, cohort.size);
    const numbers = firstDayNumbers(cohort, await firstDays(db, day, cohort), hostsByDay.get(day) ?? []);
    for (const n of numbers) out.push({ day, ...n });
  }

  for (const offset of RETENTION_OFFSETS) {
    const newest = newestKnownCohort(todayKey, offset);
    const d = String(offset);
    for (let day = first; day <= newest; day = addDays(day, 1)) {
      if ((sizeByDay.get(day) ?? 0) === 0) continue;
      if (day !== newest && haveCell.has(`${day}|${allLabel({ d })}`)) continue;
      // An empty map here, when `sizeByDay` says the cohort is non-empty, means the record and
      // the source disagree (a prune between them, or a hand-written row); no cell is the
      // absent-not-zero answer.
      for (const [host, r] of await cohortReturns(db, await cohortOf(day), addDays(day, offset))) {
        out.push({ day, metric: NEW_METRICS.retention, labels: { host, d }, value: r.rate });
        out.push({ day, metric: NEW_METRICS.cohortSize, labels: { host, d }, value: r.size });
      }
    }
  }
  return out;
}

/** A gauge, structurally `rollup.ts`'s `RollupMetric` — declared here so this module does not
 *  import the one that imports it. */
export interface NewInstallGauge {
  name: string;
  help: string;
  type: 'gauge';
  value: number;
  labels?: Record<string, string>;
}

/** Rollup metric → gauge name and help. One table so a new metric cannot be written to the
 *  record and forgotten on `/metrics` without this file visibly missing an entry. */
const GAUGES: Record<string, { name: string; help: string }> = {
  [NEW_METRICS.installs]: { name: 'bb_new_installs', help: 'Installs whose first active day was the last complete day.' },
  [NEW_METRICS.funnel]: {
    name: 'bb_new_funnel_installs',
    help: 'New installs of the last complete day that reached each first-day funnel step.',
  },
  [NEW_METRICS.unpersisted]: {
    name: 'bb_new_unpersisted_installs',
    help: 'New installs of the last complete day whose install id did not survive a storage write.',
  },
  [NEW_METRICS.depth]: {
    name: 'bb_new_depth_installs',
    help: 'New installs of the last complete day by the deepest floor reached that day.',
  },
  [NEW_METRICS.retention]: { name: 'bb_new_retention_ratio', help: "Share of a day's NEW installs that were active again N days later." },
  [NEW_METRICS.cohortSize]: { name: 'bb_new_cohort_size', help: 'New installs in the cohort behind bb_new_retention_ratio at this offset.' },
};

const gauge = (metric: string, labels: Record<string, string>, value: number): NewInstallGauge => ({
  ...GAUGES[metric],
  type: 'gauge',
  value,
  labels,
});

/**
 * The new-install gauges for `/metrics`: the last complete day's first-day numbers, and the
 * newest new-install cohort at each offset, all per host. A host with no new installs in a
 * cohort contributes no retention gauge — absent, never 0 (see `rollup.ts`'s header).
 */
export async function newInstallGauges(db: Db, todayKey: string): Promise<NewInstallGauge[]> {
  const day = lastCompleteDay(todayKey);
  const cohort = await newCohort(db, day);
  const hosts = (await activeHostsByDay(db, day, day)).get(day) ?? [];
  const out = firstDayNumbers(cohort, await firstDays(db, day, cohort), hosts).map((n) => gauge(n.metric, n.labels, n.value));
  for (const offset of RETENTION_OFFSETS) {
    const start = newestKnownCohort(todayKey, offset);
    const d = String(offset);
    for (const [host, r] of await cohortReturns(db, await newCohort(db, start), addDays(start, offset))) {
      out.push(gauge(NEW_METRICS.retention, { host, d }, r.rate));
      out.push(gauge(NEW_METRICS.cohortSize, { host, d }, r.size));
    }
  }
  return out;
}
