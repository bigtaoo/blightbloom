/**
 * One consistent copy of one logical database on the cluster, and the naming that makes a
 * set of them prunable and restorable by hand.
 *
 * ## What this stopped being on 2026-09-15
 *
 * It was `VACUUM INTO` over a live SQLite file, through a `readOnly: true` handle, behind a
 * `:ro` bind mount. Every one of those words is gone with the files, and two properties
 * went with them that are worth naming rather than quietly losing:
 *
 *  - **Point-in-time consistency.** `VACUUM INTO` ran inside a read transaction, so the
 *    copy was a single instant of the whole database. What replaces it is a cursor per
 *    collection, which is consistent PER DOCUMENT and not across them: a settlement that
 *    lands between the `orders` read and the `ledger` read appears in one and not the
 *    other. A cluster-wide snapshot needs a transaction with `snapshot` read concern held
 *    open across every collection, which on a large collection is a long-running
 *    transaction against the live cluster — a worse trade for a worker whose job is to be
 *    invisible. The restore procedure says to expect it (design/19).
 *  - **The capability.** The worker held no writable handle on anything, enforced by SQLite
 *    and by Docker. It holds one connection now, and what keeps it from writing is the
 *    Atlas role on its credential — the same shift adminsvc's decision B1 made, and with
 *    the same consequence: it is true, and no longer true in a way a code review confirms.
 *
 * ## The format is NDJSON, one document per line, in Extended JSON
 *
 * Not BSON and not `mongodump`'s archive. Three reasons, in order:
 *
 *  1. **It restores without this repository.** A `.ndjson.gz` is readable by `zcat`, by
 *     `mongoimport`, and by any script somebody writes at 3am. The old format had the same
 *     property — a `.db.gz` opens in `sqlite3` — and it is the one that decides whether a
 *     backup is usable by the person holding it rather than by the system that made it.
 *  2. **Extended JSON is lossless for the types this project stores.** `entitlements._id`
 *     is an ObjectId and a plain `JSON.stringify` would flatten it to a string, which
 *     restores as a different document. `EJSON` round-trips it, and `relaxed: false` keeps
 *     an integer an integer rather than guessing from its value.
 *  3. **A per-line format fails per line.** One unreadable document is one bad line in a
 *     file whose other thousands are fine, rather than an archive that will not open.
 *
 * ## The order is still the point
 *
 * The `.gz` only appears under its final name once it has been read back and its lines
 * counted, so nothing in the directory is ever a file that merely looks like a backup: an
 * interrupted or corrupt run leaves a `.part`, which `prune.ts` neither counts nor deletes
 * and a human can see.
 */
import { EJSON } from 'bson';
import type { Db } from 'mongodb';
import { gunzipSync, gzipSync } from 'node:zlib';
import { readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { store, type StoreName } from '../mongo';

/** What one successful snapshot produced. */
export interface Snapshot {
  /** The logical database this came from. */
  source: string;
  /** Absolute path of the written `.ndjson.gz`. */
  file: string;
  /** Compressed size on disk. */
  bytes: number;
  /** Size of the uncompressed NDJSON, before gzip — what a restore expands to. */
  rawBytes: number;
  /** How many documents it holds, across every collection. The one number that tells an
   *  operator whether a small file is a small database or an empty read. */
  documents: number;
}

/** `accounts` out of `accounts`. Kept as a function because `runner.ts` calls it to group a
 *  source's own snapshots, and because it was not always the identity. */
export function sourceStem(source: string): string {
  return source;
}

/**
 * `accounts-2026-09-07T14-30-00Z.ndjson.gz`.
 *
 * The timestamp is IN THE NAME and not left to the file's mtime, because a restore, an
 * `rsync -a` or a volume move rewrites mtimes and would silently reorder the set that
 * `prune.ts` then trims. Colons are illegal on some filesystems and awkward in every
 * shell, so the ISO time's `:` become `-`; milliseconds are dropped (a cycle is hours).
 */
export function snapshotName(source: string, at: Date): string {
  const stamp = at.toISOString().replace(/\.\d+Z$/, 'Z').replace(/:/g, '-');
  return `${sourceStem(source)}-${stamp}.ndjson.gz`;
}

/**
 * Matches exactly what `snapshotName` writes — see `prune.ts` on why that matters.
 *
 * It deliberately does NOT also match the retired `.db.gz` names. A box upgraded in place
 * still has SQLite-era snapshots in `/backups`, and they must become invisible to the
 * pruner rather than be aged out: they are the only copy of the pre-migration data until
 * the one-time migration has run and been verified, which is exactly the window in which a
 * retention policy would delete them on schedule.
 */
export const SNAPSHOT_RE = /^(.+)-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z)\.ndjson\.gz$/;

/** One NDJSON line: which collection, and the document. The collection name is IN the line
 *  rather than implied by a file per collection, so one store is one file and a restore is
 *  one pass. */
export interface SnapshotLine {
  c: string;
  d: unknown;
}

/**
 * Read every collection of `db` into NDJSON.
 *
 * Collections are taken in name order so two snapshots of an unchanged database produce
 * byte-identical output — which is what makes "did anything change" answerable with a
 * checksum rather than a restore. System collections are skipped: they are the server's,
 * not ours, and a credential scoped the way this one should be cannot read them anyway.
 */
export async function dumpDatabase(db: Db): Promise<{ text: string; documents: number }> {
  const names = (await db.listCollections({}, { nameOnly: true }).toArray())
    .map((c) => c.name)
    .filter((n) => !n.startsWith('system.'))
    .sort();
  const lines: string[] = [];
  for (const name of names) {
    for await (const doc of db.collection(name).find({})) {
      lines.push(EJSON.stringify({ c: name, d: doc }, { relaxed: false }));
    }
  }
  return { text: lines.length === 0 ? '' : `${lines.join('\n')}\n`, documents: lines.length };
}

/**
 * Read a written snapshot back and require it to be exactly what was meant to be written.
 *
 * Separate and exported rather than four lines inside the publish below, because it is the
 * one part of this module whose FAILURE arm matters and whose failure arm nothing else can
 * reach: a truncated write, a gzip that cannot inflate and a corrupt line are all states a
 * caller cannot produce on demand. Given the compressed bytes and the count that was meant
 * to be in them, this either returns or throws — so both arms are drivable.
 *
 * It checks the COUNT and then every LINE, in that order, because they fail differently: a
 * short file is a disk or a kill, a corrupt line is data, and an operator reading the
 * cycle's log line needs to know which.
 */
export function verifyDump(compressed: Buffer, documents: number): void {
  const text = gunzipSync(compressed).toString('utf8');
  const lines = text === '' ? [] : text.split('\n').slice(0, -1);
  if (lines.length !== documents) {
    throw new Error(`read back ${lines.length} line(s), wrote ${documents}`);
  }
  // Every line has to parse. One corrupt document would otherwise be discovered by whoever
  // is restoring, which is the worst possible moment to discover it.
  for (const line of lines) EJSON.parse(line);
}

/**
 * Snapshot one logical database into `destDir`, verify it, and publish it atomically.
 *
 * `db` is injected rather than resolved here so a test can point it at its own scratch
 * database; `snapshotStore` below is what the worker actually calls.
 */
export async function snapshotDatabase(source: string, db: Db, destDir: string, at: Date): Promise<Snapshot> {
  const file = join(destDir, snapshotName(source, at));
  const part = `${file}.part`;
  rmSync(part, { force: true });

  try {
    const { text, documents } = await dumpDatabase(db);
    const raw = Buffer.from(text, 'utf8');
    writeFileSync(part, gzipSync(raw));

    // Verify the COPY, not the source: this is the only moment the snapshot can be checked
    // while there is still time to fail the CYCLE rather than the restore. Re-reading the
    // FILE is what makes it a check of the artefact rather than of the buffer that was
    // about to become it.
    //
    // NOT wrapped in a catch that re-throws with the source name attached. That read well
    // and was a branch no input could reach, which a coverage gate cannot tell apart from an
    // untested one — and it was redundant besides: `runner.ts` already logs
    // `backup FAILED <source>: <message>` and records the source beside the error in
    // `status.json`, so the name is on both surfaces an operator reads.
    verifyDump(readFileSync(part), documents);

    renameSync(part, file);
    return { source, file, bytes: statSync(file).size, rawBytes: raw.byteLength, documents };
  } finally {
    rmSync(part, { force: true });
  }
}

/** The worker's own entry point: resolve the logical database from the pooled client and
 *  snapshot it. Separate from the function above so the injection seam stays a seam. */
export function snapshotStore(source: StoreName, destDir: string, at: Date): Promise<Snapshot> {
  return snapshotDatabase(source, store(source), destDir, at);
}
