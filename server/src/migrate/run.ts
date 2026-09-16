/**
 * The one-time migration off `node:sqlite` (stage 7): reading the four files, writing the
 * cluster, and refusing to do either when the answer would be wrong.
 *
 * `tables.ts` holds the row → document mapping and the reason for every absent-vs-null
 * decision in it; this file is the machinery around it. See that header for why this
 * directory exists at all and when it should be deleted.
 *
 * ## Three properties, in the order they matter
 *
 * 1. **Re-running is safe.** Every write is an upsert on a key derived from the source row,
 *    so a run interrupted halfway through is resumed by running it again rather than by
 *    reasoning about where it stopped. That is the whole reason `tables.ts` goes to the
 *    trouble of a deterministic `_id` for the two tables that had integer keys.
 * 2. **Re-running after the cutover is REFUSED.** The dangerous shape is not a half-finished
 *    migration, it is a finished one re-run a week later: every upsert would overwrite a
 *    live document with the snapshot the file still holds, and players would lose exactly
 *    the progress made since.
 *
 *    TWO guards, because neither sees what the other does. {@link readMarker} is the precise
 *    one — a document this migration writes only after a COMPLETE run, so its absence is
 *    exactly what distinguishes "resume an interrupted run" from "run it again afterwards",
 *    for every collection regardless of how it is keyed. {@link hasForeignDocuments} is the
 *    backstop for the box where the marker never got written or was dropped: a driver-minted
 *    `_id` in a collection whose documents this migration keys by ObjectId is a document the
 *    running server wrote. It is blind to the string-keyed collections, which is precisely
 *    why it is not the only check. `--force` is the only way past either.
 * 3. **It counts both sides.** A migration that reports success and moved nothing is the
 *    failure mode worth engineering against, because it looks identical to one that worked
 *    on an empty box. {@link migrateAll} returns the source count and the target count per
 *    table, and the caller prints both.
 */
import type { Db } from 'mongodb';
import { ObjectId } from 'mongodb';
import { TABLES, isMigratedId, type TableMap } from './tables';

/** What one table did. */
export interface TableResult {
  table: string;
  collection: string;
  /** Rows read out of SQLite. */
  read: number;
  /** Documents written (upserted OR replaced). Equal to `read` on a clean run. */
  written: number;
  /** Documents in the target collection afterwards — the number that is NOT derived from
   *  what this process believes it did. */
  present: number;
}

export interface MigrateResult {
  tables: TableResult[];
  dryRun: boolean;
}

/** The read side: one legacy file, opened read-only. Injected so a test can drive the whole
 *  migration without a SQLite dependency reaching the suite. */
export interface LegacySource {
  /** Rows of one table, in the given order, or `null` when the table does not exist — an
   *  older box is allowed to be missing one, and that is not a failure. */
  rows: (table: string, orderBy: string) => Record<string, unknown>[] | null;
}

/** Where documents go. `db(store)` resolves one of the four logical databases. */
export interface Target {
  db: (store: TableMap['store']) => Db;
}

/**
 * Whether a collection already holds a document this migration did not write.
 *
 * The check property 2 above rests on, and it is deliberately narrow: a document whose `_id`
 * is an ObjectId WITHOUT the migration's marker byte is one the running server minted, which
 * means the cutover has happened. Anything else — a string `_id`, a marked ObjectId — is
 * either this migration's own output or a document whose key the migration would reproduce
 * exactly, so re-running is idempotent for it and there is nothing to protect.
 *
 * It answers the question with ONE document rather than a count, because the question is
 * "has anything been written since", not "how much".
 */
export async function hasForeignDocuments(db: Db, collection: string): Promise<boolean> {
  const doc = await db.collection(collection).findOne<{ _id: unknown }>(
    { _id: { $type: 'objectId' } },
    { projection: { _id: 1 } },
  );
  return doc !== null && doc._id instanceof ObjectId && !isMigratedId(doc._id);
}

export class MigrationRefused extends Error {
  override readonly name = 'MigrationRefused';
}

/** Where the completion marker lives: the `ops` store, which holds no player data. */
export const MARKER_COLLECTION = '_migration';
export const MARKER_ID = 'fromSqlite';

/** What a completed run left behind. */
export interface MigrationMarker {
  completedAt: number;
  /** Rows read, per table, as the completing run counted them — so an operator can compare
   *  a later dry run's numbers against what actually moved without re-reading a log. */
  read: Record<string, number>;
}

/** The marker, or `null` when no run has completed against this cluster. */
export async function readMarker(ops: Db): Promise<MigrationMarker | null> {
  const doc = await ops.collection(MARKER_COLLECTION).findOne<MigrationMarker & { _id: string }>({
    _id: MARKER_ID as never,
  });
  return doc === null ? null : { completedAt: doc.completedAt, read: doc.read };
}

/**
 * Records a COMPLETED run.
 *
 * Written last, after every table, and only when the counts say the run finished — so the
 * marker's presence means "this cluster has the data" rather than "somebody started once".
 * That distinction is the whole value of it: an interrupted run leaves no marker and is
 * resumed by running the command again, which is the thing an operator will actually do at
 * two in the morning.
 */
export async function writeMarker(ops: Db, marker: MigrationMarker): Promise<void> {
  await ops
    .collection(MARKER_COLLECTION)
    .replaceOne({ _id: MARKER_ID as never }, marker as never, { upsert: true });
}

/**
 * Read every table, write every document, count both sides.
 *
 * `dryRun` reads and counts and writes nothing, which is the mode to run first on the real
 * box: it answers "how much is there, and does every row map" without touching the cluster.
 *
 * Writes go through `bulkWrite` in batches rather than one call per row. `events` is the
 * table this matters for — ninety days of raw analytics is the only one that is large — and
 * a round trip per row against Atlas would turn a two-minute migration into an hour.
 */
export async function migrateAll(
  source: LegacySource,
  target: Target,
  opts: { dryRun?: boolean; force?: boolean; batch?: number; now?: () => number } = {},
): Promise<MigrateResult> {
  const dryRun = opts.dryRun ?? false;
  const batchSize = opts.batch ?? 500;
  const now = opts.now ?? Date.now;
  const tables: TableResult[] = [];

  if (!dryRun && !(opts.force ?? false)) {
    const marker = await readMarker(target.db('ops'));
    if (marker !== null) {
      throw new MigrationRefused(
        `this cluster already carries a completed migration (${new Date(marker.completedAt).toISOString()}). ` +
          `Re-running would overwrite live data with the snapshot the .db files still hold — every player's ` +
          `progress since the cutover. Pass --force only if you have decided that is what you want.`,
      );
    }
    for (const map of TABLES) {
      if (await hasForeignDocuments(target.db(map.store), map.collection)) {
        throw new MigrationRefused(
          `${map.store}.${map.collection} already holds documents this migration did not write, which means ` +
            `the cutover has happened even though no completion marker was found. Re-running would overwrite ` +
            `live data with the snapshot in the .db file. Pass --force only if you have decided that is what ` +
            `you want.`,
        );
      }
    }
  }

  for (const map of TABLES) {
    const rows = source.rows(map.table, map.orderBy);
    if (rows === null) {
      // A table an older box never created. Reported as a zero rather than skipped silently,
      // because "this table had no rows" and "this table was not there" look the same in a
      // summary and only one of them is worth a second look.
      tables.push({ table: map.table, collection: map.collection, read: 0, written: 0, present: 0 });
      continue;
    }
    const db = target.db(map.store);
    let written = 0;
    if (!dryRun) {
      for (let i = 0; i < rows.length; i += batchSize) {
        const slice = rows.slice(i, i + batchSize);
        const ops = slice.map((row) => ({
          replaceOne: { filter: map.key(row), replacement: map.doc(row), upsert: true },
        }));
        const res = await db.collection(map.collection).bulkWrite(ops, { ordered: false });
        // Upserted plus MATCHED, not plus modified. A re-run matches every document and
        // modifies none of them — the replacement is byte-identical — and counting modified
        // would report a correct, complete second run as having moved nothing.
        written += res.upsertedCount + res.matchedCount;
      }
    } else {
      // The mapping still RUNS in a dry run, so a row that cannot be mapped — a legacy id
      // past what an ObjectId tail holds, say — is found before anything is written.
      for (const row of rows) {
        map.key(row);
        map.doc(row);
      }
    }
    const present = dryRun ? 0 : await db.collection(map.collection).countDocuments({});
    tables.push({ table: map.table, collection: map.collection, read: rows.length, written, present });
  }

  const result = { tables, dryRun };
  // The marker LAST, and only for a run that finished with every collection holding at least
  // what its table held. A marker written by an incomplete run would refuse the resume that
  // would have fixed it.
  if (!dryRun && migrationComplete(result)) {
    await writeMarker(target.db('ops'), {
      completedAt: now(),
      read: Object.fromEntries(tables.map((t) => [t.table, t.read])),
    });
  }
  return result;
}

/**
 * Whether the run moved everything it read.
 *
 * `present >= read` rather than `===`: a collection can legitimately hold more than the file
 * did — the target is allowed to have been written to by an earlier partial run of a LATER
 * file, and on a re-run every document is already there. What would be wrong is fewer.
 */
export function migrationComplete(result: MigrateResult): boolean {
  return result.dryRun || result.tables.every((t) => t.present >= t.read);
}

/** One line per table, aligned, for the operator running this. */
export function formatResult(result: MigrateResult): string {
  const rows = result.tables.map((t) => ({
    name: `${t.table} -> ${t.collection}`,
    detail: result.dryRun ? `${t.read} row(s) to move` : `${t.read} read, ${t.present} in collection`,
  }));
  const width = Math.max(0, ...rows.map((r) => r.name.length));
  return rows.map((r) => `  ${r.name.padEnd(width)}  ${r.detail}`).join('\n');
}
