/**
 * New-install analytics (design/21 §2.7) — the cohort that "次留 / 七留" actually means, and
 * the first-day funnel of that cohort. Split out of `rollup.ts` as an independent function
 * module; `rollup.ts` calls in, nothing here calls back.
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
 * Days are UTC (`ingest.ts`'s `dayKey`), like everything else in this store: a player in
 * Beijing has their "first day" end at 08:00 local time.
 */
import type { Db, Document } from 'mongodb';
import { DAILY_ACTIVE_COLLECTION, dailyActiveOf, dailyRollupOf, eventsOf } from './db';
import { RETENTION_OFFSETS, addDays, canonicalLabels, lastCompleteDay, newestKnownCohort } from './rollupKeys';

/** The funnel steps, in the order a new player meets them. `installs` is not here: it is
 *  the cohort size, a separate metric, and every step is read against it. */
export const FUNNEL_STEPS = ['menu', 'run_start', 'run_finished'] as const;
export type FunnelStep = (typeof FUNNEL_STEPS)[number];

/** The `run_end` outcomes that count as FINISHING a run. `abandon` is the run the player
 *  walked away from, and "started but never finished" is exactly what the funnel separates. */
const FINISHED_OUTCOMES = ['win', 'loss'];

/**
 * A `$lookup` stage that attaches `earlier: [..]` — at most one `dailyActive` document for the
 * same install on any day BEFORE `day`. An empty array is what "new on `day`" means.
 *
 * The concise `localField`/`foreignField` + `pipeline` form (MongoDB 5.0+), so the equality on
 * `install` is the join key and is served by `daily_active_install` (`{ install, day }`), and
 * the `day` range is a plain `$match` on a literal rather than an `$expr`.
 */
function earlierActivity(day: string): Document {
  return {
    $lookup: {
      from: DAILY_ACTIVE_COLLECTION,
      localField: 'install',
      foreignField: 'install',
      pipeline: [{ $match: { day: { $lt: day } } }, { $limit: 1 }, { $project: { _id: 1 } }],
      as: 'earlier',
    },
  };
}

/** The stages that narrow a stream with an `install` field down to installs NEW on `day`. */
function onlyNewOn(day: string): Document[] {
  return [earlierActivity(day), { $match: { 'earlier.0': { $exists: false } } }];
}

/** Installs whose first active day is `day`. Zero for a day nobody new arrived — and also for
 *  a day with no activity at all, which is why callers decide which days to ask about. */
export async function newInstalls(db: Db, day: string): Promise<number> {
  const got = await dailyActiveOf(db)
    .aggregate<{ n: number }>([{ $match: { day } }, ...onlyNewOn(day), { $count: 'n' }])
    .toArray();
  return got[0]?.n ?? 0;
}

/** A new-install cohort's return rate at one offset. Same shape as `rollup.ts`'s
 *  `CohortRate`, restated here so this module does not import the one that imports it. */
export interface NewCohortRate {
  cohortDay: string;
  offset: number;
  size: number;
  returned: number;
  rate: number;
}

/**
 * The share of installs NEW on `cohortDay` that were active again on `cohortDay + offset`, or
 * `null` when the cohort is empty.
 *
 * Unlike `rollup.ts`'s `cohortRate` this does not check whether the offset day is complete —
 * its one caller (`newInstallRollupDocs`) only asks about cells that are, and owns that rule
 * in one place.
 */
export async function newCohortRate(db: Db, cohortDay: string, offset: number, returnDay: string): Promise<NewCohortRate | null> {
  const got = await dailyActiveOf(db)
    .aggregate<{ size: number; returned: number }>([
      { $match: { day: cohortDay } },
      ...onlyNewOn(cohortDay),
      {
        $lookup: {
          from: DAILY_ACTIVE_COLLECTION,
          localField: 'install',
          foreignField: 'install',
          pipeline: [{ $match: { day: returnDay } }, { $limit: 1 }, { $project: { _id: 1 } }],
          as: 'back',
        },
      },
      {
        $group: {
          _id: null,
          size: { $sum: 1 },
          returned: { $sum: { $cond: [{ $gt: [{ $size: '$back' }, 0] }, 1, 0] } },
        },
      },
    ])
    .toArray();
  const row = got[0];
  if (row === undefined) return null;
  return { cohortDay, offset, size: row.size, returned: row.returned, rate: row.returned / row.size };
}

/**
 * Distinct installs NEW on `day` that did each funnel step on that same day. Every step is
 * present in the result, with `0` when nobody did it.
 *
 * Starts from `events` rather than from the cohort: the `{ day, name }` index narrows the scan
 * to one day's three relevant event names, and the per-install collapse happens BEFORE the
 * join, so the `$lookup` runs once per install rather than once per event.
 */
export async function newInstallFunnel(db: Db, day: string): Promise<{ step: FunnelStep; n: number }[]> {
  const flag = (cond: Document): Document => ({ $max: { $cond: [cond, 1, 0] } });
  const got = await eventsOf(db)
    .aggregate<Record<FunnelStep, number>>([
      { $match: { day, name: { $in: ['screen_view', 'run_start', 'run_end'] } } },
      {
        $group: {
          _id: '$install',
          menu: flag({ $and: [{ $eq: ['$name', 'screen_view'] }, { $eq: ['$props.screen', 'menu'] }] }),
          run_start: flag({ $eq: ['$name', 'run_start'] }),
          run_finished: flag({ $and: [{ $eq: ['$name', 'run_end'] }, { $in: ['$props.outcome', FINISHED_OUTCOMES] }] }),
        },
      },
      { $project: { install: '$_id', menu: 1, run_start: 1, run_finished: 1 } },
      ...onlyNewOn(day),
      {
        $group: {
          _id: null,
          menu: { $sum: '$menu' },
          run_start: { $sum: '$run_start' },
          run_finished: { $sum: '$run_finished' },
        },
      },
    ])
    .toArray();
  const row = got[0];
  return FUNNEL_STEPS.map((step) => ({ step, n: row?.[step] ?? 0 }));
}

/** The `dailyRollup` metric names this module writes. Distinct from `rollup.ts`'s
 *  `retention` / `cohort_size`, which keep their all-active meaning — the two cohorts answer
 *  different questions and both stay in the record. */
export const NEW_METRICS = {
  installs: 'new_installs',
  funnel: 'new_funnel',
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
 * The new-install rows this cycle should write.
 *
 * `rollup.ts`'s all-active numbers are only ever computed for the NEWEST cell — yesterday's
 * DAU, the newest cohort at each offset — so a day the job did not run on (a deploy, an outage
 * longer than a day) is a hole in the record forever. That was tolerable while the record was
 * the only one; for a cohort that starts on the day this ships it would also mean the grid
 * begins empty when every `dailyActive` row needed to fill it already exists. So this fills
 * holes, within {@link NEW_INSTALL_BACKFILL_DAYS}:
 *
 *  - **Per-day rows** (`new_installs`, `new_funnel`) for every day in the window that has
 *    activity and no `new_installs` row yet — plus the last complete day ALWAYS, because late
 *    batches (`ingest.ts` accepts timestamps up to a day old) keep changing it while it is new.
 *  - **Retention cells** for every knowable (cohort, offset) with no row yet — plus the newest
 *    cohort at each offset always, for the same reason.
 *
 * A day with NO activity gets nothing, not zeros: before collection began, or while it was
 * switched off, "nobody new arrived" is not something the data says (design/21 §2.5, absent is
 * not zero). An empty cohort gets no retention cell for the same reason — `rollup.ts` already
 * treats a zero-size cohort as unknown.
 *
 * Steady state, this is the newest cells plus one `find` over the window. The first cycle
 * after deploy computes up to sixty days of them, once.
 */
export async function newInstallRollupRows(db: Db, todayKey: string): Promise<NewInstallRow[]> {
  const last = lastCompleteDay(todayKey);
  const first = addDays(last, -(NEW_INSTALL_BACKFILL_DAYS - 1));

  const stored = await dailyRollupOf(db)
    .find({ day: { $gte: first, $lte: last }, metric: { $in: [NEW_METRICS.installs, NEW_METRICS.retention] } })
    .toArray();
  const sizeByDay = new Map<string, number>();
  const haveCell = new Set<string>();
  for (const r of stored) {
    if (r.metric === NEW_METRICS.installs) sizeByDay.set(r.day, r.value);
    else haveCell.add(`${r.day}|${r.labels}`);
  }

  const activeDays = await dailyActiveOf(db)
    .aggregate<{ _id: string }>([{ $match: { day: { $gte: first, $lte: last } } }, { $group: { _id: '$day' } }])
    .toArray();
  const dayTargets = new Set(activeDays.map((d) => d._id).filter((d) => !sizeByDay.has(d)));
  dayTargets.add(last);

  const out: NewInstallRow[] = [];
  for (const day of [...dayTargets].sort()) {
    const n = await newInstalls(db, day);
    sizeByDay.set(day, n);
    out.push({ day, metric: NEW_METRICS.installs, labels: {}, value: n });
    for (const f of await newInstallFunnel(db, day)) {
      out.push({ day, metric: NEW_METRICS.funnel, labels: { step: f.step }, value: f.n });
    }
  }

  for (const offset of RETENTION_OFFSETS) {
    const newest = newestKnownCohort(todayKey, offset);
    const d = String(offset);
    for (let cohort = first; cohort <= newest; cohort = addDays(cohort, 1)) {
      if ((sizeByDay.get(cohort) ?? 0) === 0) continue;
      if (cohort !== newest && haveCell.has(`${cohort}|${canonicalLabels({ d })}`)) continue;
      const r = await newCohortRate(db, cohort, offset, addDays(cohort, offset));
      // `sizeByDay` says the cohort is non-empty, so a null here means the two reads
      // disagreed (a prune between them); skipping is the absent-not-zero answer.
      if (r === null) continue;
      out.push({ day: cohort, metric: NEW_METRICS.retention, labels: { d }, value: r.rate });
      out.push({ day: cohort, metric: NEW_METRICS.cohortSize, labels: { d }, value: r.size });
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

/**
 * The new-install gauges for `/metrics`: the last complete day's new installs and funnel, and
 * the newest new-install cohort at each offset. An empty cohort contributes no retention gauge
 * — absent, never 0 (see `rollup.ts`'s header).
 */
export async function newInstallGauges(db: Db, todayKey: string): Promise<NewInstallGauge[]> {
  const day = lastCompleteDay(todayKey);
  const out: NewInstallGauge[] = [
    {
      name: 'bb_new_installs',
      help: 'Installs whose first active day was the last complete day.',
      type: 'gauge',
      value: await newInstalls(db, day),
    },
  ];
  for (const f of await newInstallFunnel(db, day)) {
    out.push({
      name: 'bb_new_funnel_installs',
      help: 'New installs of the last complete day that reached each first-day funnel step.',
      type: 'gauge',
      value: f.n,
      labels: { step: f.step },
    });
  }
  for (const offset of RETENTION_OFFSETS) {
    const cohort = newestKnownCohort(todayKey, offset);
    const r = await newCohortRate(db, cohort, offset, addDays(cohort, offset));
    if (r === null) continue;
    const labels = { d: String(offset) };
    out.push({
      name: 'bb_new_retention_ratio',
      help: "Share of a day's NEW installs that were active again N days later.",
      type: 'gauge',
      value: r.rate,
      labels,
    });
    out.push({
      name: 'bb_new_cohort_size',
      help: 'New installs in the cohort behind bb_new_retention_ratio at this offset.',
      type: 'gauge',
      value: r.size,
      labels,
    });
  }
  return out;
}
