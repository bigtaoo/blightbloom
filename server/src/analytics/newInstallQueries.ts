// New-install queries — split out of `newInstalls.ts` (design/21 §2.7, §2.8): the reads that
// find a day's new installs, profile their first day, and measure their return. Everything is
// returned PER HOST, plus the `all` total; `newInstalls.ts` turns it into rows and gauges.
//
// ## One cohort list, read once, joined in memory
//
// The first version ran one `$lookup`-per-question aggregate (count, funnel, each retention
// cell). Splitting all of it by host would have multiplied that by four. Instead a day's new
// installs are read ONCE, as `install → host`, and every other question is a plain indexed
// read narrowed by `install: { $in: [...] }` and grouped here. At this game's scale a day's
// cohort is hundreds of ids, not millions, and a list that size is cheaper to hold than to
// re-derive.
//
// ## Which host a new install belongs to
//
// The host of its FIRST-DAY `dailyActive` document — the one `store.ts` writes with
// `$setOnInsert`, so it is the host it was first seen on. That keeps every per-host number a
// PARTITION of the `all` number (the same property `db.ts` documents for DAU-by-host): the
// per-host rows always sum to the total, and nobody has to explain why they do not. In
// practice the question barely arises — the install id is stored per host (`localStorage` on
// the web and the portal, `wx.setStorageSync` on WeChat), so one id seen on two hosts is the
// web build and the portal build sharing a browser profile, which only happens on our domain.
import type { Db } from 'mongodb';
import { DEFAULT_CHAPTER_ID } from '@dd/engine';
import { DAILY_ACTIVE_COLLECTION, dailyActiveOf, eventsOf } from './db';

/** The label value for the total across hosts — the same spelling `rollup.ts` uses for DAU. */
export const ALL_HOSTS = 'all';

/** The funnel steps, in the order a new player meets them. `installs` is not here: it is
 *  the cohort size, a separate metric, and every step is read against it. */
export const FUNNEL_STEPS = ['menu', 'run_start', 'run_finished'] as const;
export type FunnelStep = (typeof FUNNEL_STEPS)[number];

/** The `run_end` outcomes that count as FINISHING a run. `abandon` is the run the player
 *  walked away from, and "started but never finished" is exactly what the funnel separates. */
const FINISHED_OUTCOMES = ['win', 'loss'];

/** A day's new installs: install id → the host it was first seen on. */
export type Cohort = Map<string, string>;

/**
 * Installs whose first active day is `day`, with their host.
 *
 * An install is new on `day` when it has a `dailyActive` document for `day` and none for any
 * earlier day — derived, not stored; `newInstalls.ts`'s header has why, and the two caveats
 * (the 180-day prune, and the first days of collection) that follow from it.
 *
 * The `$lookup` uses the concise `localField`/`foreignField` + `pipeline` form (MongoDB 5.0+),
 * so the equality on `install` is the join key and is served by `daily_active_install`
 * (`{ install, day }`), and the `day` range is a plain `$match` on a literal.
 */
export async function newCohort(db: Db, day: string): Promise<Cohort> {
  const got = await dailyActiveOf(db)
    .aggregate<{ install: string; host: string }>([
      { $match: { day } },
      {
        $lookup: {
          from: DAILY_ACTIVE_COLLECTION,
          localField: 'install',
          foreignField: 'install',
          pipeline: [{ $match: { day: { $lt: day } } }, { $limit: 1 }, { $project: { _id: 1 } }],
          as: 'earlier',
        },
      },
      { $match: { 'earlier.0': { $exists: false } } },
      { $project: { _id: 0, install: 1, host: 1 } },
    ])
    .toArray();
  return new Map(got.map((r) => [r.install, r.host]));
}

/** The hosts with ANY activity on each day in `[first, last]`. A host active on a day is one
 *  whose zero new installs that day is a measurement; a host absent from it is unknown. */
export async function activeHostsByDay(db: Db, first: string, last: string): Promise<Map<string, Set<string>>> {
  const got = await dailyActiveOf(db)
    .aggregate<{ _id: { day: string; host: string } }>([
      { $match: { day: { $gte: first, $lte: last } } },
      { $group: { _id: { day: '$day', host: '$host' } } },
    ])
    .toArray();
  const out = new Map<string, Set<string>>();
  for (const { _id } of got) {
    const hosts = out.get(_id.day) ?? new Set<string>();
    hosts.add(_id.host);
    out.set(_id.day, hosts);
  }
  return out;
}

/** Count the members of `cohort` that pass `keep`, per host and in total. A host with no
 *  member in the cohort is absent from the result; `all` is always present. */
export function countByHost(cohort: Cohort, keep: (install: string) => boolean = () => true): Map<string, number> {
  const out = new Map<string, number>([[ALL_HOSTS, 0]]);
  for (const [install, host] of cohort) {
    if (!out.has(host)) out.set(host, 0);
    if (!keep(install)) continue;
    out.set(ALL_HOSTS, (out.get(ALL_HOSTS) as number) + 1);
    out.set(host, (out.get(host) as number) + 1);
  }
  return out;
}

/** What one new install did on its first day. */
export interface FirstDay {
  menu: boolean;
  run_start: boolean;
  run_finished: boolean;
  /** Its first `session_start` said the install id did not survive a write (design/21 §2.8). */
  unpersisted: boolean;
  /** The deepest floor it reached that day in a CHAPTER-1 run (1-based), or 0 if none. */
  depth: number;
}

const EMPTY_DAY: FirstDay = { menu: false, run_start: false, run_finished: false, unpersisted: false, depth: 0 };

/**
 * The chapter whose floors `depth` counts: the first. Floor numbers are per chapter (every
 * chapter has its own floors 1..5), so a max over all of them would put "floor 3 of chapter 2"
 * in the same bucket as "floor 3 of chapter 1" — two very different distances into the game.
 * And the first chapter is the one a new install's first day is ABOUT: chapter 2 unlocks only
 * by clearing chapter 1, so a new player meets any other chapter on day one only as a guest
 * in a friend's co-op party, which says nothing about how far the game's own on-ramp took them.
 *
 * An event with no `chapter` prop counts as chapter 1: it is from a client that predates the
 * field, and those could play nothing else. A PvP run carries no chapter either, and never
 * carried a meaningful floor — the same as before this split existed.
 */
const DEPTH_CHAPTER = DEFAULT_CHAPTER_ID;

/**
 * Each cohort member's first day, from that day's events. An install with no relevant event
 * (a `dailyActive` row whose events were all something else) gets {@link EMPTY_DAY}.
 *
 * `depth` is the max over `floor_reached.floor` and `run_end.floor` of CHAPTER-1 runs only —
 * see {@link DEPTH_CHAPTER} for why one chapter and why that one. The first is what makes
 * it honest: a run the player left by closing the tab ends with no `run_end` at all (the page
 * is gone before the phase changes), and before `floor_reached` existed that run's depth was
 * simply missing — the most common way a new player leaves was the one case without a number.
 */
export async function firstDays(db: Db, day: string, cohort: Cohort): Promise<Map<string, FirstDay>> {
  const out = new Map<string, FirstDay>();
  if (cohort.size === 0) return out;
  const flag = (cond: object): object => ({ $max: { $cond: [cond, true, false] } });
  const inDepthChapter = { $eq: [{ $ifNull: ['$props.chapter', DEPTH_CHAPTER] }, DEPTH_CHAPTER] };
  const isFloor = { $and: [{ $in: ['$name', ['floor_reached', 'run_end']] }, inDepthChapter] };
  const got = await eventsOf(db)
    .aggregate<FirstDay & { _id: string; depth_start: boolean }>([
      {
        $match: {
          day,
          install: { $in: [...cohort.keys()] },
          name: { $in: ['session_start', 'screen_view', 'run_start', 'run_end', 'floor_reached'] },
        },
      },
      {
        $group: {
          _id: '$install',
          menu: flag({ $and: [{ $eq: ['$name', 'screen_view'] }, { $eq: ['$props.screen', 'menu'] }] }),
          run_start: flag({ $eq: ['$name', 'run_start'] }),
          // Whether a run of the depth chapter was started — what the floor-1 floor below rests on.
          depth_start: flag({ $and: [{ $eq: ['$name', 'run_start'] }, inDepthChapter] }),
          run_finished: flag({ $and: [{ $eq: ['$name', 'run_end'] }, { $in: ['$props.outcome', FINISHED_OUTCOMES] }] }),
          unpersisted: flag({ $and: [{ $eq: ['$name', 'session_start'] }, { $eq: ['$props.storage', 'unpersisted'] }] }),
          // `$ifNull` because an abandon reported without its numbers has no `floor`.
          depth: { $max: { $cond: [isFloor, { $ifNull: ['$props.floor', 0] }, 0] } },
        },
      },
    ])
    .toArray();
  for (const r of got) {
    const { _id, depth_start, ...profile } = r;
    // A run that was started reached floor 1, whether or not anything said so: a tab closed
    // on the first floor leaves a `run_start` and nothing after it. Only a depth-chapter run.
    out.set(_id, { ...profile, depth: depth_start ? Math.max(1, profile.depth) : profile.depth });
  }
  for (const install of cohort.keys()) if (!out.has(install)) out.set(install, EMPTY_DAY);
  return out;
}

/** A cohort's return at one offset, for one host or for all of them. */
export interface CohortReturn {
  size: number;
  returned: number;
  rate: number;
}

/**
 * The share of `cohort` active again on `returnDay`, per host and in total. A host with no
 * member in the cohort is absent, and an empty cohort returns an empty map — an empty cohort
 * has no rate, and absent is not zero (design/21 §2.5).
 */
export async function cohortReturns(db: Db, cohort: Cohort, returnDay: string): Promise<Map<string, CohortReturn>> {
  const out = new Map<string, CohortReturn>();
  if (cohort.size === 0) return out;
  const back = new Set(
    (
      await dailyActiveOf(db)
        .find({ day: returnDay, install: { $in: [...cohort.keys()] } }, { projection: { _id: 0, install: 1 } })
        .toArray()
    ).map((r) => r.install),
  );
  const sizes = countByHost(cohort);
  const returned = countByHost(cohort, (i) => back.has(i));
  for (const [host, size] of sizes) {
    const n = returned.get(host) as number;
    out.set(host, { size, returned: n, rate: n / size });
  }
  return out;
}
