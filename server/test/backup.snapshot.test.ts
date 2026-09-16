/**
 * The snapshot itself, against a REAL database on the suite's own mongod and a real temp
 * directory — the same reason it used real SQLite files before the port: the properties
 * worth testing here (a complete copy, a lossless round trip, an atomic publish) are
 * properties of the boundary, and a fake would restate the belief instead of checking it.
 *
 * ## Two properties this file used to assert and cannot any more
 *
 * They are named rather than silently dropped, because the replacement is weaker and
 * somebody reading the suite should be able to see where the strength went:
 *
 *  - **"leaves the source WRITABLE and unmodified — it holds a read-only handle."** That was
 *    `new DatabaseSync(source, { readOnly: true })`, enforced by SQLite and observable by
 *    writing to the file afterwards. The worker holds one pooled client now and what keeps
 *    it from writing is an Atlas role, which lives in the cluster's configuration.
 *  - **"captures a POINT IN TIME: later writes are not in an earlier snapshot."** `VACUUM
 *    INTO` ran inside a read transaction, so the copy was one instant of the whole database.
 *    A cursor per collection is consistent per document and not across them. What survives
 *    is the weaker, still-true version — a snapshot taken before a write does not contain
 *    it — asserted per collection below, and `snapshot.ts` says what the full property cost.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Db } from 'mongodb';
import { ObjectId } from 'mongodb';
import { EJSON } from 'bson';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SNAPSHOT_RE,
  dumpDatabase,
  snapshotDatabase,
  snapshotName,
  sourceStem,
  verifyDump,
  type SnapshotLine,
} from '../src/backup/snapshot';
import { openTestMongo, type MongoTestContext } from './mongoHarness';
import { closeMongo, connectMongo } from '../src/mongo';
import { snapshotStore } from '../src/backup/snapshot';
import { inject, vi } from 'vitest';

const dirs: string[] = [];
let ctx: MongoTestContext;

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `bb-${prefix}-`));
  dirs.push(dir);
  return dir;
}

/** A real database with `rows` account documents in it. */
async function seed(db: Db, rows: number): Promise<void> {
  if (rows === 0) return;
  await db.collection('accounts').insertMany(
    Array.from({ length: rows }, (_, i) => ({ _id: `a${i}`, username: `u${i}` })) as never,
  );
}

/** Expand a `.ndjson.gz` and parse every line back. */
function expand(gz: string): SnapshotLine[] {
  const text = gunzipSync(readFileSync(gz)).toString('utf8');
  if (text === '') return [];
  return text
    .split('\n')
    .slice(0, -1)
    .map((line) => EJSON.parse(line) as SnapshotLine);
}

beforeEach(async () => {
  ctx = await openTestMongo();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await ctx.dispose();
  // One case goes through the process-wide client; a vitest worker runs many files in one
  // process, so it must not be left set for the next one.
  await closeMongo();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('snapshotStore', () => {
  it('resolves the logical database from the pooled client', async () => {
    // The seam the worker actually calls, and the one line of this module that no other case
    // touches: every case above injects a `Db` so it can point at its own scratch database.
    // A `store(source)` pointed at the wrong name would back up an empty database and report
    // success, which is precisely the silent no-op this worker exists to not be.
    const dest = tmp('dest');
    const prefix = `snapstore${process.pid}`;
    vi.stubEnv('BB_MONGO_URI', inject('mongoUri'));
    vi.stubEnv('BB_MONGO_DB_PREFIX', prefix);
    const client = await connectMongo();
    await client.db(`${prefix}_billing`).collection('ledger').insertOne({ _id: 'l1' } as never);

    const snap = await snapshotStore('billing', dest, new Date('2026-09-07T01:00:00Z'));

    expect(snap.source).toBe('billing');
    expect(snap.documents).toBe(1);
    expect(expand(snap.file)[0]).toMatchObject({ c: 'ledger' });
    await client.db(`${prefix}_billing`).dropDatabase();
  });
});

describe('snapshotName / sourceStem', () => {
  it('names a snapshot after its source and the cycle time, filesystem-safely', () => {
    const name = snapshotName('accounts', new Date('2026-09-07T14:30:05.123Z'));
    expect(name).toBe('accounts-2026-09-07T14-30-05Z.ndjson.gz');
    // No colons: illegal on some filesystems, awkward in every shell.
    expect(name).not.toContain(':');
  });

  it('produces names that sort chronologically as plain strings', () => {
    // `prune.ts` relies on this exactly — it sorts the stamp field lexicographically.
    const early = snapshotName('accounts', new Date('2026-09-07T09:00:00Z'));
    const late = snapshotName('accounts', new Date('2026-09-07T10:00:00Z'));
    expect([late, early].sort()).toEqual([early, late]);
  });

  it('every name it writes is matched by the pattern the pruner recognises', () => {
    const name = snapshotName('billing', new Date('2026-01-02T03:04:05Z'));
    const m = SNAPSHOT_RE.exec(name);
    expect(m?.[1]).toBe('billing');
    expect(m?.[2]).toBe('2026-01-02T03-04-05Z');
  });

  it('IGNORES the retired .db.gz names a box upgraded in place still holds', () => {
    // Load-bearing rather than tidy. Those files are the only copy of the pre-migration data
    // until the one-time migration has run and been verified — which is exactly the window
    // in which a pruner that recognised them would age them out on schedule.
    expect(SNAPSHOT_RE.test('accounts-2026-09-07T14-30-05Z.db.gz')).toBe(false);
    expect(sourceStem('accounts')).toBe('accounts');
  });
});

describe('dumpDatabase', () => {
  it('reads every collection, tagging each line with the one it came from', async () => {
    const db = ctx.db('accounts');
    await seed(db, 2);
    await db.collection('ratings').insertOne({ _id: 'a0', rating: 1200 } as never);

    const { text, documents } = await dumpDatabase(db);
    expect(documents).toBe(3);
    const lines = text.split('\n').slice(0, -1).map((l) => EJSON.parse(l) as SnapshotLine);
    expect(lines.filter((l) => l.c === 'accounts')).toHaveLength(2);
    expect(lines.filter((l) => l.c === 'ratings')).toHaveLength(1);
  });

  it('is byte-identical for an unchanged database, so a checksum answers "did anything change"', async () => {
    // Collections are taken in NAME order for this. Without it, two dumps of the same data
    // differ by collection order and every snapshot looks like a change — which makes the
    // cheapest possible integrity check useless.
    const db = ctx.db('accounts');
    await seed(db, 3);
    await db.collection('ratings').insertOne({ _id: 'a0', rating: 1200 } as never);
    expect((await dumpDatabase(db)).text).toBe((await dumpDatabase(db)).text);
  });

  it('round-trips an ObjectId as an ObjectId, not as a string', async () => {
    // The reason the format is Extended JSON and not `JSON.stringify`. `entitlements._id` is
    // an ObjectId whose creation time IS the "oldest grant first" ordering (`db.ts`), so a
    // dump that flattened it to a string would restore documents that sort differently and
    // read as a different id type — a corruption that only shows up after the restore.
    const db = ctx.db('accounts');
    const id = new ObjectId();
    await db.collection('entitlements').insertOne({ _id: id, accountId: 'a1', sku: 'x' } as never);

    const text = (await dumpDatabase(db)).text;
    // The wire form first: `$oid` is what makes this lossless, and it is the half that has to
    // survive leaving this process. A `JSON.stringify` dump would put a bare 24-character
    // string here and every assertion below would still pass on the way back in.
    expect(text).toContain('"$oid"');
    const doc = (EJSON.parse(text.trim()) as SnapshotLine).d as { _id: { toHexString(): string } };
    // ...and the parsed form is an ObjectId rather than a string. `toBeInstanceOf(ObjectId)`
    // is deliberately NOT the assertion: `mongodb` and `bson` can resolve to two copies on
    // disk, so the class identity is a fact about node_modules rather than about the dump.
    expect(typeof doc._id).not.toBe('string');
    expect(doc._id.toHexString()).toBe(id.toHexString());
  });

  it('answers an empty database with an empty dump rather than a blank line', async () => {
    const { text, documents } = await dumpDatabase(ctx.db('accounts'));
    expect(text).toBe('');
    expect(documents).toBe(0);
  });
});

describe('verifyDump', () => {
  const gz = (text: string) => gzipSync(Buffer.from(text, 'utf8'));

  it('accepts exactly what dumpDatabase writes', async () => {
    await seed(ctx.db('accounts'), 3);
    const { text, documents } = await dumpDatabase(ctx.db('accounts'));
    expect(() => verifyDump(gz(text), documents)).not.toThrow();
    // ...and the empty case, which is a real state and not an error: a fresh cluster.
    expect(() => verifyDump(gz(''), 0)).not.toThrow();
  });

  it('REFUSES a truncated file, and says it is SHORT rather than corrupt', async () => {
    // The write that got cut off. It is the failure the count check exists for, and the one
    // an operator most needs told apart from a bad document — a short file is a disk or a
    // kill, a bad line is data.
    await seed(ctx.db('accounts'), 3);
    const { text } = await dumpDatabase(ctx.db('accounts'));
    const cut = `${text.split('\n').slice(0, 2).join('\n')}\n`;
    expect(() => verifyDump(gz(cut), 3)).toThrow(/read back 2 line/);
  });

  it('REFUSES a file with a line that does not parse', () => {
    // One corrupt document in a file whose other thousands are fine. Without this check it
    // is discovered by whoever is restoring, which is the worst possible moment.
    expect(() => verifyDump(gz('{"c":"accounts","d":{}}\nnot json at all\n'), 2)).toThrow();
  });

  it('REFUSES bytes that are not gzip at all', () => {
    // A `.part` from a killed run that this cycle failed to overwrite, or a filesystem that
    // wrote nothing. The throw comes out of `gunzipSync`, and what matters is that it is a
    // throw rather than an empty dump that verifies as "0 of 0".
    expect(() => verifyDump(Buffer.from('not gzip'), 0)).toThrow();
  });
});

describe('snapshotDatabase', () => {
  it('writes a gzipped dump holding the source’s documents', async () => {
    const dest = tmp('dest');
    const db = ctx.db('accounts');
    await seed(db, 7);

    const snap = await snapshotDatabase('accounts', db, dest, new Date('2026-09-07T01:00:00Z'));

    expect(snap.file).toBe(join(dest, 'accounts-2026-09-07T01-00-00Z.ndjson.gz'));
    expect(snap.bytes).toBeGreaterThan(0);
    expect(snap.rawBytes).toBeGreaterThan(snap.bytes); // repetitive JSON compresses
    expect(snap.documents).toBe(7);
    expect(expand(snap.file)).toHaveLength(7);
  });

  it('reports the DOCUMENT COUNT, so a small file is diagnosable', async () => {
    // A 40-byte snapshot of an empty database and a 40-byte snapshot produced by a broken
    // read look identical on disk. The count is the number that tells them apart, and it is
    // what `status.json` carries into the health line.
    const dest = tmp('dest');
    const snap = await snapshotDatabase('accounts', ctx.db('accounts'), dest, new Date('2026-09-07T01:00:00Z'));
    expect(snap.documents).toBe(0);
    expect(expand(snap.file)).toEqual([]);
  });

  it('does not contain writes that happened after it', async () => {
    // What is left of "captures a POINT IN TIME" — see the file header. Weaker than the
    // SQLite version (which held across collections) and still the property that makes a
    // snapshot a snapshot rather than a rolling read.
    const dest = tmp('dest');
    const db = ctx.db('accounts');
    await seed(db, 1);

    const first = await snapshotDatabase('accounts', db, dest, new Date('2026-09-07T01:00:00Z'));
    await db.collection('accounts').insertOne({ _id: 'later', username: 'later' } as never);
    const second = await snapshotDatabase('accounts', db, dest, new Date('2026-09-07T02:00:00Z'));

    expect(expand(first.file)).toHaveLength(1);
    expect(expand(second.file)).toHaveLength(2);
  });

  it('leaves no temp files behind, so the directory is only snapshots', async () => {
    const dest = tmp('dest');
    await seed(ctx.db('accounts'), 3);
    await snapshotDatabase('accounts', ctx.db('accounts'), dest, new Date('2026-09-07T01:00:00Z'));
    expect(readdirSync(dest)).toEqual(['accounts-2026-09-07T01-00-00Z.ndjson.gz']);
  });

  it('throws when the source cannot be read, and publishes nothing', async () => {
    // The failure `runner.ts` catches per-source. What matters is that the directory is
    // left with no file that LOOKS like a backup of this source. Reached by closing the
    // client under it, which is a real driver failure rather than a thrown stub — and the
    // shape a cluster failover actually takes.
    const dest = tmp('dest');
    const doomed = await openTestMongo();
    const db = doomed.db('accounts');
    await doomed.dispose();

    await expect(snapshotDatabase('accounts', db, dest, new Date('2026-09-07T01:00:00Z'))).rejects.toThrow();
    expect(readdirSync(dest).filter((f) => f.endsWith('.ndjson.gz'))).toEqual([]);
  });

  it('overwrites a leftover .part from a killed run instead of failing forever', async () => {
    // A process killed mid-cycle would otherwise poison that exact timestamp — and with a
    // fixed cycle time, every retry of it.
    const dest = tmp('dest');
    await seed(ctx.db('accounts'), 1);
    const at = new Date('2026-09-07T01:00:00Z');
    writeFileSync(join(dest, `${snapshotName('accounts', at)}.part`), 'junk from a killed run');

    const snap = await snapshotDatabase('accounts', ctx.db('accounts'), dest, at);

    expect(existsSync(snap.file)).toBe(true);
    expect(statSync(snap.file).size).toBe(snap.bytes);
    expect(readdirSync(dest)).toEqual([snapshotName('accounts', at)]);
  });
});
