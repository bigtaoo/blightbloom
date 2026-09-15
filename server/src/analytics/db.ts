/**
 * The `analytics` database (design/21 §2.4, design/19-server-platform.md §4) — three
 * collections, their document shapes, and the indexes that make two of them constraints
 * rather than conventions.
 *
 * Until 2026-09-15 this was `analytics.db`, a `node:sqlite` file with a `CREATE TABLE`
 * script. It is now one of the four logical databases on the cluster (`src/mongo.ts`). The
 * three tables became three collections; what changed underneath them is recorded here,
 * because two of the old schema's guarantees were SQLite's and had to be bought again.
 *
 * ## Three collections, and why the middle one exists
 *
 * `events` is the raw record and is pruned on a rolling window. `dailyRollup` is the
 * computed record and is A5's authority — Prometheus holds 15 days, this holds all of it.
 *
 * `dailyActive` is the one that looks redundant and is not. A retention cohort is "the set
 * of installs active on day D, intersected with the set active on day D+n", and computing
 * that off `events` means a distinct scan over every row the window holds, twice per
 * offset, every day — work that grows with traffic to answer a question whose answer is a
 * few hundred ids. More importantly it would make retention DEPEND on the prune: the day
 * `events` drops its oldest week, D7 for that week silently becomes zero rather than
 * unknown. `dailyActive` is one small document per install per day, is never pruned on the
 * events window, and is the only collection a cohort query reads.
 *
 * ## `{ day, install }` is UNIQUE, and what it decides about `host`
 *
 * This was `PRIMARY KEY (day, install)` and it is now a unique compound index. It is a
 * compound index rather than a composite `_id` OBJECT for one reason: the key has to be
 * QUERYABLE BY PREFIX. DAU matches `{ day }`, a cohort lookup matches `{ install, day }`,
 * and the prune matches `{ day: { $lt } }` — none of which an `_id` holding
 * `{ day, install }` can serve, because an embedded document in `_id` is only ever matched
 * as a whole value (and, worse, matched in FIELD ORDER, so a filter built with the keys the
 * other way round silently finds nothing).
 *
 * An install that plays on two hosts in one day is ONE person, so it gets one document and
 * its `host` is whichever host it appeared on first (`$setOnInsert`, never `$set`). The
 * consequence is worth stating because it is the useful one: DAU-by-host is a PARTITION of
 * DAU, and the per-host numbers sum to exactly the total. Keying on `{ day, install, host }`
 * instead would make the split double-count anyone who switched, and the total would stop
 * being a count of people.
 *
 * ## `events._id` is an ObjectId, and nothing may depend on that
 *
 * `events.id INTEGER PRIMARY KEY AUTOINCREMENT` has no MongoDB equivalent, so the default
 * `ObjectId` `_id` takes its place. An ObjectId sorts in creation order, which is what the
 * old `ORDER BY id` meant in practice — but it is NOT a dense integer sequence, so nothing
 * may page on "the row after 1041" or count on the gaps being meaningful. No reader in this
 * repository did either (`rollup.ts` groups; the prune matches on `day`); the one test that
 * used `ORDER BY id` wanted insertion order and gets it from `_id`.
 *
 * ## Read-only is no longer a capability this code can hand out
 *
 * `openAnalyticsDbReadOnly` is gone with the file handle it wrapped. SQLite enforced
 * `readOnly: true` itself, so decision B1 — "the console cannot write player data" — was a
 * capability the adminsvc process did not hold. It is now an Atlas ROLE on a separate
 * database user, which lives in the cluster's configuration rather than in this repository;
 * `src/mongo.ts`'s header states that trade, and `adminsvc/dbs.ts` is where it is asserted
 * at startup.
 */
import type { Collection, Db } from 'mongodb';
import type { PropValue } from '@dd/net/analyticsEvents';

/** Collection names, as constants so a typo cannot silently create a fourth collection —
 *  MongoDB creates one on first write and would never complain. */
export const EVENTS_COLLECTION = 'events';
export const DAILY_ACTIVE_COLLECTION = 'dailyActive';
export const DAILY_ROLLUP_COLLECTION = 'dailyRollup';

/**
 * One raw event.
 *
 * `props` is a SUBDOCUMENT rather than the JSON text the column held, and the reason is
 * `rollup.ts`'s screen-view split: it was the one query that reached into the blob, through
 * `json_extract`, and as a subdocument it is a plain `$group` on `props.screen` that an
 * index could serve. The keys are safe to nest because they are not client-chosen — they
 * come from the compiled-in spec in `@dd/net/analyticsEvents` (`screen`, `character`,
 * `outcome`, `floor`, `duration_s`, `sku`), and `ingest.ts` walks the SPEC rather than the
 * payload, so nothing a caller sends can become a field name here.
 *
 * `accountId` carries no reference to `accounts`, deliberately, and the reason is the same
 * shape as `ratings`': most documents have none at all (a player who never logged in is
 * exactly who retention is about), and an account deleted later must not take its rows'
 * validity with it. It is a recorded fact, not a foreign key — which is just as well, since
 * MongoDB has none.
 */
export interface EventDoc {
  atMs: number;
  day: string;
  name: string;
  install: string;
  session: string;
  host: string;
  build: string;
  locale: string;
  accountId: string | null;
  props: Record<string, PropValue>;
}

/** One install's activity on one day. See the file header for why `host` is the FIRST one
 *  seen and not the latest. */
export interface DailyActiveDoc {
  day: string;
  install: string;
  host: string;
}

/**
 * One computed number for one day.
 *
 * `labels` stays a canonical JSON STRING rather than becoming a subdocument, because it is
 * half of the uniqueness key: a unique index has to name its fields, and a label set whose
 * KEYS vary per metric (`{host}`, `{event}`, `{screen}`, `{d}`) cannot be named. One sorted
 * string is one indexable value, which is exactly what `PRIMARY KEY (day, metric, labels)`
 * meant. `rollup.ts`'s `canonicalLabels` is what keeps it canonical.
 */
export interface DailyRollupDoc {
  day: string;
  metric: string;
  labels: string;
  value: number;
  computedAt: number;
}

/** The raw event record. */
export const eventsOf = (db: Db): Collection<EventDoc> => db.collection<EventDoc>(EVENTS_COLLECTION);

/** The cohort record. */
export const dailyActiveOf = (db: Db): Collection<DailyActiveDoc> =>
  db.collection<DailyActiveDoc>(DAILY_ACTIVE_COLLECTION);

/** The computed record. */
export const dailyRollupOf = (db: Db): Collection<DailyRollupDoc> =>
  db.collection<DailyRollupDoc>(DAILY_ROLLUP_COLLECTION);

/**
 * Whether this deployment collects analytics at all — `BB_ANALYTICS_ENABLED` set to `1` or
 * `true`, and nothing else.
 *
 * design/21 §2.4's rule is *"collection is opt-in by env var, with no default path"*, and the
 * no-default half of that was carried entirely by the path: an unset `BB_ANALYTICS_DB_PATH`
 * had nothing to fall back to, so it collected nothing. The cluster removes the path and
 * would have removed the switch with it — `store('analytics')` always resolves, so a naive
 * port turns the one subsystem with a privacy policy attached ON for every deployment that
 * upgrades, silently and by omission. This is that switch, made explicit rather than
 * inherited from a filename.
 *
 * Defaulting to OFF also keeps the `""` trap design/19 §9 records closed from the other side:
 * a compose file with a trailing `BB_ANALYTICS_ENABLED:` and no value collects nothing,
 * which is the safe answer for this subsystem rather than merely the surprising one.
 *
 * It lives HERE, in the leaf module that owns the collections, rather than in either of its
 * two callers. matchsvc decides whether to collect and adminsvc decides whether to show a
 * retention tab, and those two must never be able to disagree — which is exactly what the
 * old arrangement risked: `matchsvc.ts` and `adminsvc/dbs.ts` each carried their own
 * two-line copy of the path reader (importing `matchsvc.ts` into the console would drag
 * `ws`, the matchmaker and every route group into its bundle), with a test pinning the two
 * answers to each other because nothing else could. One home needs no such test.
 */
export function analyticsEnabledFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.BB_ANALYTICS_ENABLED?.trim().toLowerCase();
  return raw === '1' || raw === 'true';
}

/**
 * How long raw `events` documents are kept. The privacy policy states this number, so the
 * two have to be changed together — a policy that says 90 days over a prune that keeps
 * forever is the failure this comment exists to prevent.
 */
export const EVENT_RETENTION_DAYS = 90;

/**
 * How long `dailyActive` documents are kept. Longer than the events window on purpose:
 * these are ~40 bytes, they are what every retention answer is computed from, and pruning
 * them on the events window would silently turn "we don't know" into "zero".
 *
 * 180 rather than "keep forever", because the privacy policy has to state this number and a
 * number has to be defensible. 180 days is what a full D90 curve for the last quarter
 * needs: 90 days of cohorts plus 90 days for the newest of them to age. Anything past that
 * would be kept in case a question is asked later, which is the definition of what data
 * minimisation asks us not to do.
 */
export const ACTIVE_RETENTION_DAYS = 180;

/**
 * Create every index this database's correctness and its queries depend on.
 *
 * MUST be awaited once at boot, before anything writes. Two of these carry `unique: true`
 * and they are not tuning: without them `writeBatch`'s cohort upsert becomes a duplicate
 * factory (DAU counts visits instead of people) and a re-run of the rollup appends a second
 * copy of every number instead of replacing it. `analyticsIndexes.test.ts` asserts the
 * option is present on both, by inserting a duplicate and requiring the refusal — a test
 * that passes for the right reason only against a server that really enforces it.
 *
 * `createIndex` is idempotent for an identical specification, so calling this on every boot
 * is a no-op after the first.
 */
export async function ensureAnalyticsIndexes(db: Db): Promise<void> {
  await eventsOf(db).createIndexes([
    // The rollup's per-day group-by, and the prune's `day < cutoff` on its prefix.
    { key: { day: 1, name: 1 }, name: 'events_day_name' },
    // "Everything this account did", for a support question and for a deletion request.
    { key: { accountId: 1 }, name: 'events_account' },
  ]);
  await dailyActiveOf(db).createIndexes([
    // The old `PRIMARY KEY (day, install)`. See the file header: unique is the constraint,
    // and the prefix is what DAU and the prune read.
    { key: { day: 1, install: 1 }, name: 'daily_active_key', unique: true },
    // The other direction: one install's history, for a cohort's join.
    { key: { install: 1, day: 1 }, name: 'daily_active_install' },
  ]);
  await dailyRollupOf(db).createIndexes([
    // The old `PRIMARY KEY (day, metric, labels)`. `persistRollup` upserts on exactly this
    // triple, so a day recomputed is a day replaced.
    { key: { day: 1, metric: 1, labels: 1 }, name: 'daily_rollup_key', unique: true },
  ]);
}
