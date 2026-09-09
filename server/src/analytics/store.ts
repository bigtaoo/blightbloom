/**
 * Writing a validated batch down, and pruning what has aged out (design/21 §2.4).
 *
 * The only module that writes `analytics.db`. It takes an already-validated
 * {@link IngestedBatch} — nothing here re-checks a client value, because nothing here has
 * seen one: `ingest.ts` is the boundary and this side of it deals in rows.
 *
 * ## One transaction per batch
 *
 * A batch writes to two tables (`events` and `daily_active`) and they answer different
 * questions about the same visit. Half a batch is worse than none of it: an `events` row
 * with no `daily_active` row is a session that happened to nobody, and the reverse is a
 * cohort member with no evidence. `node:sqlite` is synchronous, so the transaction is a
 * plain try/rollback with no await inside it and therefore no interleaving to reason about.
 */
import type { DatabaseSync } from 'node:sqlite';
import { dayKey, type IngestedBatch } from './ingest';
import { ACTIVE_RETENTION_DAYS, EVENT_RETENTION_DAYS } from './db';

/** What a write reported. `events` is the number of rows stored, which the route echoes
 *  back as `accepted` so a client can tell "refused" from "stored" without a 4xx. */
export interface WriteResult {
  events: number;
  /** True when this batch was this install's first activity today — i.e. it created a
   *  cohort row. Not used by the route; asserted by tests, which is the point of returning
   *  it: "the cohort row was created" is otherwise only observable by re-querying. */
  newActiveDay: boolean;
}

/**
 * Store one batch. `accountId` comes from the request's bearer token and is the ONLY field
 * on these rows the client did not supply — see `ingest.ts`'s header for why it is resolved
 * on this side.
 */
export function writeBatch(db: DatabaseSync, batch: IngestedBatch, accountId: string | null): WriteResult {
  const insertEvent = db.prepare(
    `INSERT INTO events (at_ms, day, name, install, session, host, build, locale, account_id, props)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertActive = db.prepare('INSERT OR IGNORE INTO daily_active (day, install, host) VALUES (?, ?, ?)');

  db.exec('BEGIN IMMEDIATE');
  try {
    let newActiveDay = false;
    const days = new Set<string>();
    for (const e of batch.events) {
      const day = dayKey(e.atMs);
      insertEvent.run(
        e.atMs,
        day,
        e.name,
        batch.install,
        batch.session,
        batch.host,
        batch.build,
        batch.locale,
        accountId,
        JSON.stringify(e.props),
      );
      days.add(day);
    }
    // Deduped in memory first: a 100-event batch is usually one day, and one statement per
    // event would be 99 no-op writes inside the transaction.
    for (const day of days) {
      const info = insertActive.run(day, batch.install, batch.host);
      if (info.changes > 0) newActiveDay = true;
    }
    db.exec('COMMIT');
    return { events: batch.events.length, newActiveDay };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
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
 * that format and is why the day is stored as text rather than as three integers.
 */
export function prune(db: DatabaseSync, todayKey: string): PruneResult {
  const cutoff = (days: number): string => {
    const t = Date.parse(`${todayKey}T00:00:00Z`) - days * 86_400_000;
    return new Date(t).toISOString().slice(0, 10);
  };
  const events = db.prepare('DELETE FROM events WHERE day < ?').run(cutoff(EVENT_RETENTION_DAYS));
  const active = db.prepare('DELETE FROM daily_active WHERE day < ?').run(cutoff(ACTIVE_RETENTION_DAYS));
  return { events: Number(events.changes), active: Number(active.changes) };
}
