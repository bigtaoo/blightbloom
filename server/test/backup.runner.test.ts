/**
 * A cycle, the status file, and the health verdict — the three things that decide whether a
 * broken backup is VISIBLE.
 *
 * The cycle is driven through its injected `CycleIo` (scripted per call, so "the second
 * source still ran after the first one threw" is assertable rather than inferred), while
 * the status file and the health rule are exercised against a real directory, because a
 * half-written or absent file is exactly the case they exist to survive.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BackupConfig } from '../src/backup/config';
import {
  HEALTH_SLACK_MS,
  isHealthy,
  readStatus,
  runCycle,
  writeStatus,
  STATUS_FILE,
  type CycleIo,
  type CycleResult,
} from '../src/backup/runner';
import type { Snapshot } from '../src/backup/snapshot';

const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bb-backup-run-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const HOUR = 3_600_000;

function cfg(over: Partial<BackupConfig> = {}): BackupConfig {
  return {
    sources: ['/sources/matchsvc/accounts.db', '/sources/billsvc/billing.db'],
    destDir: tmp(),
    intervalMs: 24 * HOUR,
    keep: 3,
    ...over,
  };
}

/**
 * A scripted io. `snapshots` maps a source to either the Snapshot it produces or an Error
 * it throws — per source rather than per call, since one cycle touches each once.
 */
function scriptedIo(opts: {
  snapshots?: Record<string, Snapshot | Error>;
  listing?: string[];
} = {}): CycleIo & { removed: string[]; log: (line: string) => void; lines: string[] } {
  const removed: string[] = [];
  const lines: string[] = [];
  return {
    removed,
    lines,
    snapshot: (source, destDir, at) => {
      const scripted = opts.snapshots?.[source];
      if (scripted instanceof Error) throw scripted;
      return (
        scripted ?? {
          source,
          file: join(destDir, `${source.split('/').pop()!.replace('.db', '')}-${at.toISOString()}.db.gz`),
          bytes: 100,
          rawBytes: 1000,
        }
      );
    },
    list: () => opts.listing ?? [],
    remove: (file) => void removed.push(file),
    log: (line) => void lines.push(line),
  };
}

describe('runCycle', () => {
  it('snapshots every source and reports ok', () => {
    const c = cfg();
    const io = scriptedIo();
    const result = runCycle(c, new Date('2026-09-07T01:00:00Z'), io);

    expect(result.ok).toBe(true);
    expect(result.at).toBe('2026-09-07T01:00:00.000Z');
    expect(result.sources.map((s) => s.source)).toEqual(c.sources);
    for (const s of result.sources) expect(s.ok).toBe(true);
    expect(io.lines.every((l) => l.startsWith('backup ok'))).toBe(true);
  });

  it('creates the destination directory rather than failing on a fresh volume', () => {
    const c = cfg({ destDir: join(tmp(), 'nested', 'backups') });
    expect(runCycle(c, new Date(), scriptedIo()).ok).toBe(true);
    expect(readdirSync(c.destDir)).toEqual([]);
  });

  it('keeps going after ONE source fails, and reports the cycle as not ok', () => {
    // The reason a cycle catches per source: with two databases, an unreadable accounts.db
    // must not cost billing.db its backup — and the day that matters is the day one of them
    // is broken.
    const c = cfg();
    const io = scriptedIo({ snapshots: { [c.sources[0]!]: new Error('disk on fire') } });

    const result = runCycle(c, new Date('2026-09-07T01:00:00Z'), io);

    expect(result.ok).toBe(false);
    expect(result.sources[0]).toMatchObject({ ok: false, error: 'disk on fire' });
    expect(result.sources[1]).toMatchObject({ ok: true });
    expect(io.lines[0]).toContain('backup FAILED');
    expect(io.lines[1]).toContain('backup ok');
  });

  it('never throws out of a cycle, so the loop cannot die on a bad source', () => {
    const c = cfg();
    const io = scriptedIo({
      snapshots: { [c.sources[0]!]: new Error('a'), [c.sources[1]!]: new Error('b') },
    });
    expect(() => runCycle(c, new Date(), io)).not.toThrow();
    expect(runCycle(c, new Date(), io).ok).toBe(false);
  });

  it('prunes only the source it just snapshotted, and only past `keep`', () => {
    const c = cfg({ keep: 1, sources: ['/s/accounts.db'] });
    const io = scriptedIo({
      listing: [
        'accounts-2026-09-05T01-00-00Z.db.gz',
        'accounts-2026-09-06T01-00-00Z.db.gz',
        'accounts-2026-09-07T01-00-00Z.db.gz',
        'billing-2026-09-01T01-00-00Z.db.gz', // another source's set, not this cycle's business
        'status.json',
      ],
    });

    const result = runCycle(c, new Date('2026-09-07T01:00:00Z'), io);

    expect(io.removed).toEqual([
      join(c.destDir, 'accounts-2026-09-05T01-00-00Z.db.gz'),
      join(c.destDir, 'accounts-2026-09-06T01-00-00Z.db.gz'),
    ]);
    expect(result.sources[0]!.pruned).toHaveLength(2);
  });

  it('does NOT prune a source whose snapshot just failed', () => {
    // The difference between a retention policy and a countdown to having nothing: a
    // source failing for two weeks would otherwise age its last good snapshots out on
    // schedule and leave the directory empty.
    const c = cfg({ keep: 1, sources: ['/s/accounts.db'] });
    const io = scriptedIo({
      snapshots: { '/s/accounts.db': new Error('unreadable') },
      listing: ['accounts-2026-09-05T01-00-00Z.db.gz', 'accounts-2026-09-06T01-00-00Z.db.gz'],
    });

    runCycle(c, new Date('2026-09-07T01:00:00Z'), io);

    expect(io.removed).toEqual([]);
  });
});

describe('writeStatus / readStatus', () => {
  const result: CycleResult = {
    at: '2026-09-07T01:00:00.000Z',
    ok: true,
    sources: [{ source: '/s/accounts.db', ok: true, file: 'accounts-2026-09-07T01-00-00Z.db.gz', bytes: 10 }],
  };

  it('round-trips a cycle result', () => {
    const dir = tmp();
    writeStatus(dir, result);
    expect(readStatus(dir)).toEqual(result);
  });

  it('publishes atomically — no `.part` is left where the reader looks', () => {
    const dir = tmp();
    writeStatus(dir, result);
    expect(readdirSync(dir)).toEqual([STATUS_FILE]);
  });

  it('is human-readable, because a restore starts by reading it', () => {
    const dir = tmp();
    writeStatus(dir, result);
    const text = readFileSync(join(dir, STATUS_FILE), 'utf8');
    expect(text).toContain('\n  "ok": true');
    expect(text.endsWith('\n')).toBe(true);
  });

  it('reads back null for absent, malformed and wrong-shaped files', () => {
    const dir = tmp();
    expect(readStatus(dir)).toBeNull();
    writeFileSync(join(dir, STATUS_FILE), '{ this is not json');
    expect(readStatus(dir)).toBeNull();
    writeFileSync(join(dir, STATUS_FILE), '"a string"');
    expect(readStatus(dir)).toBeNull();
    writeFileSync(join(dir, STATUS_FILE), '{"at":"2026-09-07T01:00:00.000Z","ok":true}');
    expect(readStatus(dir), 'sources missing').toBeNull();
  });
});

describe('isHealthy', () => {
  const at = '2026-09-07T01:00:00.000Z';
  const ok: CycleResult = { at, ok: true, sources: [] };
  const now = (offsetMs: number) => new Date(Date.parse(at) + offsetMs);

  it('is healthy right after a good cycle', () => {
    expect(isHealthy(ok, now(0), 24 * HOUR)).toBe(true);
  });

  it('stays healthy for the interval plus its slack', () => {
    expect(isHealthy(ok, now(24 * HOUR + HEALTH_SLACK_MS - 1), 24 * HOUR)).toBe(true);
  });

  it('goes UNHEALTHY once the last cycle is older than that', () => {
    // The case worth having: a worker whose loop died after one good cycle would otherwise
    // report green forever off a stale success.
    expect(isHealthy(ok, now(24 * HOUR + HEALTH_SLACK_MS + 1), 24 * HOUR)).toBe(false);
  });

  it('is unhealthy with no status at all', () => {
    expect(isHealthy(null, now(0), 24 * HOUR)).toBe(false);
  });

  it('is unhealthy when the cycle itself reported a failure, however recent', () => {
    expect(isHealthy({ at, ok: false, sources: [] }, now(0), 24 * HOUR)).toBe(false);
  });

  it('is unhealthy on an unparseable timestamp', () => {
    expect(isHealthy({ at: 'yesterday', ok: true, sources: [] }, now(0), 24 * HOUR)).toBe(false);
  });

  it('tolerates a status from the FUTURE instead of flapping the container', () => {
    // A clock correction on the host is not something a backup worker can fix, and
    // restarting it would not help.
    expect(isHealthy(ok, now(-5 * HOUR), 24 * HOUR)).toBe(true);
  });

  it('scales with the configured interval, not a hardcoded day', () => {
    const hourly = HOUR;
    expect(isHealthy(ok, now(hourly + HEALTH_SLACK_MS + 1), hourly)).toBe(false);
    expect(isHealthy(ok, now(hourly + HEALTH_SLACK_MS + 1), 24 * HOUR)).toBe(true);
  });
});
