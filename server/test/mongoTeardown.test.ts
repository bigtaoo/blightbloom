/**
 * Pins the teardown order and the orphan sweep in `mongoTeardown.ts`.
 *
 * Infrastructure whose failure mode is invisible: a teardown that leaks a 0.5 GB dbPath, or
 * reds a green run, says nothing in the test output. The fix is a specific ORDER plus one
 * non-obvious flag (`doCleanup: false`) whose absence throws deep inside
 * mongodb-memory-server — both the kind of thing a later "simplification" removes on sight.
 *
 * NOT covered, deliberately: the graceful-shutdown round trip itself (connect, send
 * `shutdown`, wait for the child). That needs a real mongod, which `mongoGlobalSetup.ts`
 * exercises at the end of every run, and a slow or failed shutdown prints a `::warning::`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { closeSync, existsSync, mkdtempSync, mkdirSync, openSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  sweepOrphanedDbPaths,
  teardownMongo,
  waitForExit,
  type MongoServerLike,
  type StoppableMongo,
} from './mongoTeardown';

/** A stand-in for mongod's ChildProcess: only `exitCode`/`signalCode` and `exit` are used. */
function fakeProc(opts: { exited: boolean }): ChildProcess & { emitExit(): void } {
  const emitter = new EventEmitter() as unknown as ChildProcess & { emitExit(): void };
  Object.assign(emitter, {
    exitCode: opts.exited ? 0 : null,
    signalCode: null,
    emitExit(): void {
      Object.assign(emitter, { exitCode: 0 });
      emitter.emit('exit', 0, null);
    },
  });
  return emitter;
}

describe('waitForExit', () => {
  it('resolves true at once for a process that has already exited', async () => {
    // Budget 0: had this waited on the timer at all, it would have resolved false.
    await expect(waitForExit(fakeProc({ exited: true }), 0)).resolves.toBe(true);
  });

  it('resolves true when the process exits within the budget', async () => {
    const proc = fakeProc({ exited: false });
    const pending = waitForExit(proc, 5_000);
    proc.emitExit();
    await expect(pending).resolves.toBe(true);
  });

  it('resolves false when the budget runs out, and leaves no listener behind', async () => {
    const proc = fakeProc({ exited: false });
    await expect(waitForExit(proc, 10)).resolves.toBe(false);
    expect(proc.listenerCount('exit')).toBe(0);
  });
});

describe('teardownMongo', () => {
  let warnings: string[] = [];
  const dirs: string[] = [];

  /** A dbPath with something in it, so a removal that silently did nothing would not pass. */
  function tmpDbPath(): string {
    const dir = mkdtempSync(join(tmpdir(), 'dd-teardown-selftest-'));
    mkdirSync(join(dir, 'journal'));
    writeFileSync(join(dir, 'journal', 'WiredTigerLog.0000000001'), 'x', 'utf8');
    dirs.push(dir);
    return dir;
  }

  function server(tmpDir?: string): MongoServerLike {
    return {
      instanceInfo: {
        ip: '127.0.0.1',
        port: 27099,
        ...(tmpDir === undefined ? {} : { tmpDir }),
        // Already exited, so teardownMongo skips the shutdown round trip, the one part that
        // needs a real mongod.
        instance: { mongodProcess: fakeProc({ exited: true }) },
      },
    };
  }

  beforeEach(() => {
    warnings = [];
    vi.spyOn(console, 'log').mockImplementation((msg: unknown) => {
      warnings.push(String(msg));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('stops with doCleanup:false and removes every dbPath itself', async () => {
    const a = tmpDbPath();
    const b = tmpDbPath();
    const stop = vi.fn().mockResolvedValue(true);

    await teardownMongo({ servers: [server(a), server(b)], stop });

    // `doCleanup: false` is load-bearing: MMS's own cleanup() asserts that mongodProcess is
    // undefined, which it never is once WE shut mongod down instead of letting MMS kill it.
    expect(stop).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledWith({ doCleanup: false, force: false });
    // ...which is exactly why removing the dbPath has to happen here rather than in stop().
    expect(existsSync(a)).toBe(false);
    expect(existsSync(b)).toBe(false);
    expect(warnings).toEqual([]);
  });

  it('captures the dbPaths before stop(), which empties `servers` on the replica-set path', async () => {
    const dir = tmpDbPath();
    const servers = [server(dir)];
    const mongo: StoppableMongo = {
      servers,
      stop: vi.fn().mockImplementation(async () => {
        servers.length = 0;
        return true;
      }),
    };

    await teardownMongo(mongo);

    expect(existsSync(dir)).toBe(false);
  });

  it('reports a stop() that returns false (the silent path) and still removes the dbPath', async () => {
    const dir = tmpDbPath();

    await teardownMongo({ servers: [server(dir)], stop: vi.fn().mockResolvedValue(false) });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('::warning::server test teardown:');
    expect(warnings[0]).toContain('stop() reported failure');
    expect(existsSync(dir)).toBe(false);
  });

  it('reports a stop() that throws and still removes the dbPath', async () => {
    const dir = tmpDbPath();
    const stop = vi
      .fn()
      .mockRejectedValue(new Error('Cannot cleanup because "instance.mongodProcess" is still defined'));

    await teardownMongo({ servers: [server(dir)], stop });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('stop() threw');
    expect(warnings[0]).toContain('instance.mongodProcess');
    expect(existsSync(dir)).toBe(false);
  });

  it('names a directory it could not remove instead of throwing out of teardown', async () => {
    // A NUL byte makes rmSync reject the path outright, standing in for the real condition
    // (Windows still holding WiredTiger files), which cannot be reproduced on demand.
    await teardownMongo({ servers: [server('bad\u0000path')], stop: vi.fn().mockResolvedValue(true) });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('could not remove');
  });

  it('survives a server that never produced instanceInfo (mongod failed to start)', async () => {
    const stop = vi.fn().mockResolvedValue(true);

    await teardownMongo({ servers: [{}], stop });

    expect(stop).toHaveBeenCalledOnce();
    expect(warnings).toEqual([]);
  });
});

describe('sweepOrphanedDbPaths', () => {
  // A private stand-in for %TEMP%, so this suite can never touch a real run's dbPath,
  // including the one this very run's globalSetup is using.
  let root = '';
  /** Past the 10-minute grace period, without having to backdate mtimes. */
  const later = (): number => Date.now() + 11 * 60_000;

  function dbPath(name: string): string {
    const dir = join(root, name);
    mkdirSync(join(dir, 'journal'), { recursive: true });
    writeFileSync(join(dir, 'journal', 'WiredTigerLog.0000000001'), 'x', 'utf8');
    return dir;
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dd-sweep-selftest-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('removes an unheld mongo-mem-* dir past the grace period, and reports it', () => {
    const orphan = dbPath('mongo-mem-AbC123');

    expect(sweepOrphanedDbPaths({ dir: root, now: later(), platform: 'win32' })).toEqual([orphan]);
    expect(readdirSync(root)).toEqual([]);
  });

  it('leaves a young dir alone even when nothing holds it, since a concurrent run may be starting', () => {
    dbPath('mongo-mem-young1');

    expect(sweepOrphanedDbPaths({ dir: root, now: Date.now(), platform: 'win32' })).toEqual([]);
    expect(readdirSync(root)).toEqual(['mongo-mem-young1']);
  });

  it('only touches mongo-mem-* directories', () => {
    dbPath('some-other-tool-dir');
    writeFileSync(join(root, 'mongo-mem-not-a-dir'), 'x', 'utf8');

    expect(sweepOrphanedDbPaths({ dir: root, now: later(), platform: 'win32' })).toEqual([]);
    expect(readdirSync(root).sort()).toEqual(['mongo-mem-not-a-dir', 'some-other-tool-dir']);
  });

  it('does nothing off Windows, where a rename succeeds under a live mongod', () => {
    dbPath('mongo-mem-linux1');

    expect(sweepOrphanedDbPaths({ dir: root, now: later(), platform: 'linux' })).toEqual([]);
    expect(readdirSync(root)).toEqual(['mongo-mem-linux1']);
  });

  it('returns nothing instead of throwing when the directory does not exist', () => {
    expect(sweepOrphanedDbPaths({ dir: join(root, 'missing'), now: later(), platform: 'win32' })).toEqual([]);
  });

  // The safety property itself: a dir with an open handle in it is in use and must survive.
  // Only Windows refuses that rename (EPERM), which is why the sweep is Windows-only.
  it.runIf(process.platform === 'win32')('skips a dir that still has an open file in it (a live mongod)', () => {
    const live = dbPath('mongo-mem-live01');
    const orphan = dbPath('mongo-mem-dead01');
    const fd = openSync(join(live, 'mongod.lock'), 'w');
    try {
      expect(sweepOrphanedDbPaths({ dir: root, now: later(), platform: 'win32' })).toEqual([orphan]);
      expect(readdirSync(root)).toEqual(['mongo-mem-live01']);
      expect(readdirSync(join(live, 'journal'))).toEqual(['WiredTigerLog.0000000001']);
    } finally {
      closeSync(fd);
    }
  });
});
