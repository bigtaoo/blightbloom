/**
 * The snapshot itself, against REAL `node:sqlite` files in a real temp directory — the
 * same reason `billingDb.test.ts` uses real files rather than `:memory:`: the properties
 * worth testing here (a consistent copy, a read-only source handle, an atomic publish)
 * are properties of the file layer, and a fake would restate the belief instead of
 * checking it.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SNAPSHOT_RE, snapshotDatabase, snapshotName, sourceStem } from '../src/backup/snapshot';

const dirs: string[] = [];

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `ddu-${prefix}-`));
  dirs.push(dir);
  return dir;
}

/** A real database with `rows` accounts in it. */
function seed(file: string, rows: number): void {
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE accounts (id TEXT PRIMARY KEY)');
  const insert = db.prepare('INSERT INTO accounts VALUES (?)');
  for (let i = 0; i < rows; i += 1) insert.run(`a${i}`);
  db.close();
}

function countRows(file: string): number {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return (db.prepare('SELECT count(*) AS c FROM accounts').get() as { c: number }).c;
  } finally {
    db.close();
  }
}

/** Expand a `.db.gz` next to itself and return the path. */
function expand(gz: string): string {
  const out = `${gz}.restored.db`;
  writeFileSync(out, gunzipSync(readFileSync(gz)));
  return out;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('snapshotName / sourceStem', () => {
  it('names a snapshot after its source and the cycle time, filesystem-safely', () => {
    const name = snapshotName('/sources/matchsvc/accounts.db', new Date('2026-09-07T14:30:05.123Z'));
    expect(name).toBe('accounts-2026-09-07T14-30-05Z.db.gz');
    // No colons: illegal on some filesystems, awkward in every shell.
    expect(name).not.toContain(':');
  });

  it('produces names that sort chronologically as plain strings', () => {
    // `prune.ts` relies on this exactly — it sorts the stamp field lexicographically.
    const early = snapshotName('/d/a.db', new Date('2026-09-07T09-00-00Z'.replace(/-(\d\d)-(\d\d)Z/, ':$1:$2Z')));
    const late = snapshotName('/d/a.db', new Date('2026-09-07T10:00:00Z'));
    expect([late, early].sort()).toEqual([early, late]);
  });

  it('every name it writes is matched by the pattern the pruner recognises', () => {
    const name = snapshotName('/sources/billsvc/billing.db', new Date('2026-01-02T03:04:05Z'));
    const m = SNAPSHOT_RE.exec(name);
    expect(m?.[1]).toBe('billing');
    expect(m?.[2]).toBe('2026-01-02T03-04-05Z');
  });

  it('stems a path with no extension and one with several', () => {
    expect(sourceStem('/data/accounts.db')).toBe('accounts');
    expect(sourceStem('/data/accounts')).toBe('accounts');
    expect(sourceStem('/data/accounts.old.db')).toBe('accounts.old');
  });
});

describe('snapshotDatabase', () => {
  it('writes a gzipped copy whose rows are the source’s rows', () => {
    const src = tmp('src');
    const dest = tmp('dest');
    const source = join(src, 'accounts.db');
    seed(source, 7);

    const snap = snapshotDatabase(source, dest, new Date('2026-09-07T01:00:00Z'));

    expect(snap.file).toBe(join(dest, 'accounts-2026-09-07T01-00-00Z.db.gz'));
    expect(snap.bytes).toBeGreaterThan(0);
    expect(snap.rawBytes).toBeGreaterThan(snap.bytes); // SQLite pages compress
    expect(countRows(expand(snap.file))).toBe(7);
  });

  it('leaves the source WRITABLE and unmodified — it holds a read-only handle', () => {
    // The property that makes it safe to run beside a live service. If this ever regresses
    // to a read-write open, an exclusive lock on Windows is how it would show up.
    const src = tmp('src');
    const dest = tmp('dest');
    const source = join(src, 'accounts.db');
    seed(source, 2);
    const before = readFileSync(source);

    snapshotDatabase(source, dest, new Date('2026-09-07T01:00:00Z'));

    expect(readFileSync(source).equals(before)).toBe(true);
    const db = new DatabaseSync(source);
    db.prepare('INSERT INTO accounts VALUES (?)').run('written-after');
    db.close();
    expect(countRows(source)).toBe(3);
  });

  it('captures a POINT IN TIME: later writes are not in an earlier snapshot', () => {
    const src = tmp('src');
    const dest = tmp('dest');
    const source = join(src, 'accounts.db');
    seed(source, 1);

    const first = snapshotDatabase(source, dest, new Date('2026-09-07T01:00:00Z'));
    const db = new DatabaseSync(source);
    db.prepare('INSERT INTO accounts VALUES (?)').run('later');
    db.close();
    const second = snapshotDatabase(source, dest, new Date('2026-09-07T02:00:00Z'));

    expect(countRows(expand(first.file))).toBe(1);
    expect(countRows(expand(second.file))).toBe(2);
  });

  it('leaves no temp files behind, so the directory is only snapshots', () => {
    const src = tmp('src');
    const dest = tmp('dest');
    const source = join(src, 'accounts.db');
    seed(source, 3);

    snapshotDatabase(source, dest, new Date('2026-09-07T01:00:00Z'));

    expect(readdirSync(dest)).toEqual(['accounts-2026-09-07T01-00-00Z.db.gz']);
  });

  it('throws on a source that is not a database, and publishes nothing', () => {
    // The failure `runner.ts` catches per-source. What matters is that the directory is
    // left with no file that LOOKS like a backup of this source.
    const src = tmp('src');
    const dest = tmp('dest');
    const source = join(src, 'accounts.db');
    writeFileSync(source, 'this is not a database');

    expect(() => snapshotDatabase(source, dest, new Date('2026-09-07T01:00:00Z'))).toThrow();
    expect(readdirSync(dest).filter((f) => f.endsWith('.db.gz'))).toEqual([]);
  });

  it('throws on a missing source rather than writing an empty archive', () => {
    const dest = tmp('dest');
    expect(() => snapshotDatabase(join(tmp('src'), 'nope.db'), dest, new Date())).toThrow();
    expect(readdirSync(dest)).toEqual([]);
  });

  it('overwrites a leftover .tmp from a killed run instead of failing forever', () => {
    // `VACUUM INTO` refuses an existing destination, so a process killed mid-cycle would
    // otherwise poison that exact timestamp — and with a fixed cycle time, every retry.
    const src = tmp('src');
    const dest = tmp('dest');
    const source = join(src, 'accounts.db');
    seed(source, 1);
    const at = new Date('2026-09-07T01:00:00Z');
    writeFileSync(join(dest, `${snapshotName(source, at)}.tmp`), 'junk from a killed run');

    const snap = snapshotDatabase(source, dest, at);

    expect(existsSync(snap.file)).toBe(true);
    expect(statSync(snap.file).size).toBe(snap.bytes);
  });
});
