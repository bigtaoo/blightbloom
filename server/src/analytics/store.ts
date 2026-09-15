/**
 * Writing a validated batch down, and pruning what has aged out (design/21 §2.4).
 *
 * The only module that writes the `analytics` database. It takes an already-validated
 * {@link IngestedBatch} — nothing here re-checks a client value, because nothing here has
 * seen one: `ingest.ts` is the boundary and this side of it deals in documents.
 *
 * ## One transaction per batch
 *
 * A batch writes to two collections (`events` and `dailyActive`) and they answer different
 * questions about the same visit. Half a batch is worse than none of it: an `events`
 * document with no `dailyActive` document is a session that happened to nobody, and the
 * reverse is a cohort member with no evidence.
 *
 * That reason is unchanged since this was SQLite. What is no longer true is the sentence
 * that used to follow it — "`node:sqlite` is synchronous, so there is no interleaving to
 * reason about". There is now. Every write below is an `await` against a server another
 * process is also writing to, and the transaction is a real one: `session.withTransaction`,
 * which commits, or aborts and discards, or — the part that decides how this function is
 * written — **RETRIES ITS CALLBACK** when the server reports a transient conflict. Two
 * batches from the same install on the same day really do collide on the cohort upsert, and
 * the retry is what makes that invisible rather than an error.
 *
 * So the callback must be safe to run twice, and this one is, by construction:
 *
 *  - Every document is built BEFORE the transaction opens. Nothing inside it reads a clock,
 *    generates an id, or derives a value that would differ on the second attempt.
 *  - `newActiveDay` is ASSIGNED from the attempt's own upsert results, never accumulated
 *    with `||=` into a variable the previous attempt already touched. A lost race on the
 *    first attempt must not be able to report a cohort row this batch did not create.
 *    Stated as defence rather than as a fix: no test in this repo kills the mutant that
 *    drops the reset, because the only write that can set the flag is the very write that
 *    conflicts, so a retried attempt has not set it yet. That is true of the loop as it is
 *    written today and not of the loop in general — add a second write after the upserts
 *    and the reset starts carrying its own weight.
 *
 * ## The cohort upsert is a CLAIM, and its return value is load-bearing
 *
 * `INSERT OR IGNORE … ; info.changes > 0` was the exactly-once test behind `newActiveDay`.
 * Its replacement is `updateOne(filter, { $setOnInsert }, { upsert: true })` and
 * `upsertedCount === 1`, which the server decides atomically. It is deliberately NOT a
 * `findOne` followed by an `insertOne`, and a mutation run is worth recording here because
 * the reason is narrower than it looks: with the write inside this transaction, the naive
 * version is ALSO correct — a loser's insert raises a write conflict, `withTransaction`
 * retries, and the retry's `findOne` sees the winner's document. Take the same naive pair
 * OUT of the transaction and eight concurrent writers each claim the cohort document
 * (verified: that mutant is killed by `analyticsStore.test.ts`'s concurrent case, while the
 * in-transaction one is not). So the upsert is not what makes today's code correct; it is
 * what keeps the claim true WITHOUT depending on the transaction around it, which is the
 * property a later refactor is most likely to take away by accident.
 */
import type { Db } from 'mongodb';
import { dayKey, type IngestedBatch } from './ingest';
import {
  ACTIVE_RETENTION_DAYS,
  EVENT_RETENTION_DAYS,
  dailyActiveOf,
  eventsOf,
  type EventDoc,
} from './db';

/** What a write reported. `events` is the number of documents stored, which the route
 *  echoes back as `accepted` so a client can tell "refused" from "stored" without a 4xx. */
export interface WriteResult {
  events: number;
  /** True when this batch was this install's first activity today — i.e. it created a
   *  cohort document. Not used by the route; asserted by tests, which is the point of
   *  returning it: "the cohort document was created" is otherwise only observable by
   *  re-querying, and a re-query cannot tell "I created it" from "somebody else did". */
  newActiveDay: boolean;
}

/**
 * Store one batch. `accountId` comes from the request's bearer token and is the ONLY field
 * on these documents the client did not supply — see `ingest.ts`'s header for why it is
 * resolved on this side.
 */
export async function writeBatch(db: Db, batch: IngestedBatch, accountId: string | null): Promise<WriteResult> {
  // Built out here, not inside the transaction. See the file header: the callback can run
  // more than once, so everything that must be identical on a retry is computed before it.
  const docs: EventDoc[] = batch.events.map((e) => ({
    atMs: e.atMs,
    day: dayKey(e.atMs),
    name: e.name,
    install: batch.install,
    session: batch.session,
    host: batch.host,
    build: batch.build,
    locale: batch.locale,
    accountId,
    props: e.props,
  }));
  // Deduped in memory first: a 100-event batch is usually one day, and one upsert per event
  // would be 99 no-op writes inside the transaction.
  const days = [...new Set(docs.map((d) => d.day))];

  const session = db.client.startSession();
  try {
    let newActiveDay = false;
    await session.withTransaction(async () => {
      // Reset, not `||=`. This attempt's answer is this attempt's.
      newActiveDay = false;
      if (docs.length > 0) await eventsOf(db).insertMany(docs, { session });
      for (const day of days) {
        const r = await dailyActiveOf(db).updateOne(
          { day, install: batch.install },
          // `$setOnInsert`, so an install that appears on a second host the same day keeps
          // the first one and DAU-by-host stays a partition of DAU (`db.ts`'s header).
          // `day` and `install` are seeded from the filter's equalities; `host` is the only
          // field a new document needs that the filter does not already carry.
          { $setOnInsert: { host: batch.host } },
          { upsert: true, session },
        );
        if (r.upsertedCount === 1) newActiveDay = true;
      }
    });
    return { events: batch.events.length, newActiveDay };
  } finally {
    await session.endSession();
  }
}

/** What a prune removed, so a caller can log it rather than guess. */
export interface PruneResult {
  events: number;
  active: number;
}

/**
 * Drop what has aged out of both windows.
 *
 * `todayKey` is passed in rather than read from the clock so that the boundary is testable
 * without waiting a day — the same reason every other dated thing in this server takes its
 * `now`. Comparison is lexicographic on `YYYY-MM-DD`, which is exactly chronological for
 * that format and is why the day is stored as a STRING here and not as a `Date`. Storing a
 * `Date` would change the comparison, the index and the document size for no answer this
 * module needs — every query about a day is an equality or a range on that text.
 *
 * Not in a transaction, unlike {@link writeBatch}, and the difference is the point: these
 * two deletes answer to two independent retention windows (90 days and 180). There is no
 * state in which half of this is wrong — an events prune that lands without the cohort
 * prune is simply a prune that will finish on the next cycle.
 */
export async function prune(db: Db, todayKey: string): Promise<PruneResult> {
  const cutoff = (days: number): string => {
    const t = Date.parse(`${todayKey}T00:00:00Z`) - days * 86_400_000;
    return new Date(t).toISOString().slice(0, 10);
  };
  const events = await eventsOf(db).deleteMany({ day: { $lt: cutoff(EVENT_RETENTION_DAYS) } });
  const active = await dailyActiveOf(db).deleteMany({ day: { $lt: cutoff(ACTIVE_RETENTION_DAYS) } });
  return { events: events.deletedCount, active: active.deletedCount };
}
