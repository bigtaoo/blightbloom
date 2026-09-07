/**
 * One consistent copy of one live SQLite database, and the naming that makes a set of them
 * prunable and restorable by hand.
 *
 * ## Why `VACUUM INTO` and not `cp`
 *
 * `cp` of a database another process is writing captures a torn page set: the copy opens
 * fine, reports a plausible size, and fails on the one page that mattered. `VACUUM INTO`
 * runs inside a read transaction, so the destination is a byte-consistent snapshot of a
 * single point in time with no cooperation from — and no interruption of — the running
 * service. It also compacts, which is free here.
 *
 * ## Why the source handle is READ-ONLY
 *
 * Verified against `node:sqlite`: `VACUUM INTO` works through a `readOnly: true` handle
 * (it writes only the destination). So the backup worker holds no writable handle on
 * accounts.db or billing.db at all, its compose mounts are `:ro`, and "the backup job
 * corrupted the live database" is not a failure mode it has. The one case a read-only open
 * cannot serve is a database left with a hot journal by a crash, which needs a writer to
 * roll back — that fails loudly here, and the owning service repairs it on its own next
 * open.
 */
import { DatabaseSync } from 'node:sqlite';
import { gzipSync } from 'node:zlib';
import { readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

/** What one successful snapshot produced. */
export interface Snapshot {
  /** The live database this came from. */
  source: string;
  /** Absolute path of the written `.db.gz`. */
  file: string;
  /** Compressed size on disk. */
  bytes: number;
  /** Size of the uncompressed snapshot, before gzip — what a restore expands to. */
  rawBytes: number;
}

/** `accounts` out of `/data/accounts.db`. Used as the per-source prune group. */
export function sourceStem(source: string): string {
  return basename(source).replace(/\.[^.]*$/, '');
}

/**
 * `accounts-2026-09-07T14-30-00Z.db.gz`.
 *
 * The timestamp is IN THE NAME and not left to the file's mtime, because a restore, an
 * `rsync -a` or a volume move rewrites mtimes and would silently reorder the set that
 * `prune.ts` then trims. Colons are illegal on some filesystems and awkward in every
 * shell, so the ISO time's `:` become `-`; milliseconds are dropped (a cycle is hours).
 */
export function snapshotName(source: string, at: Date): string {
  const stamp = at.toISOString().replace(/\.\d+Z$/, 'Z').replace(/:/g, '-');
  return `${sourceStem(source)}-${stamp}.db.gz`;
}

/** Matches exactly what `snapshotName` writes — see `prune.ts` on why that matters. */
export const SNAPSHOT_RE = /^(.+)-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z)\.db\.gz$/;

/** A SQL string literal for a path, which on Windows contains backslashes. */
function sqlPath(path: string): string {
  return `'${path.split('\\').join('/').replace(/'/g, "''")}'`;
}

/**
 * Snapshot `source` into `destDir`, verify it, compress it, and publish it atomically.
 *
 * The order is the point. The `.gz` only appears under its final name once it has been
 * proven readable, so nothing in the directory is ever a file that merely looks like a
 * backup: an interrupted or corrupt run leaves a `.part`/`.tmp`, which `prune.ts` neither
 * counts nor deletes and a human can see.
 */
export function snapshotDatabase(source: string, destDir: string, at: Date): Snapshot {
  const name = snapshotName(source, at);
  const file = join(destDir, name);
  const tmpDb = `${file}.tmp`;
  const part = `${file}.part`;
  rmSync(tmpDb, { force: true });

  const db = new DatabaseSync(source, { readOnly: true });
  try {
    db.exec(`VACUUM INTO ${sqlPath(tmpDb)}`);
  } finally {
    db.close();
  }

  try {
    // Verify the COPY, not the source: this is the only moment the snapshot can be
    // checked while there is still time to fail the cycle rather than the restore.
    const copy = new DatabaseSync(tmpDb, { readOnly: true });
    let verdict: unknown;
    try {
      verdict = (copy.prepare('PRAGMA integrity_check').get() as Record<string, unknown> | undefined)?.integrity_check;
    } finally {
      copy.close();
    }
    if (verdict !== 'ok') {
      throw new Error(`integrity_check on the snapshot of ${source} said ${JSON.stringify(verdict)}`);
    }
    const rawBytes = statSync(tmpDb).size;
    // Sync gzip on purpose: these files are kilobytes-to-megabytes, this process does
    // nothing else, and a stream would add a failure mode (a half-written pipe) for no
    // gain at this size.
    writeFileSync(part, gzipSync(readFileSync(tmpDb)));
    renameSync(part, file);
    return { source, file, bytes: statSync(file).size, rawBytes };
  } finally {
    rmSync(tmpDb, { force: true });
    rmSync(part, { force: true });
  }
}
