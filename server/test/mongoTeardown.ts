/**
 * Shutting the test mongod down, and removing what it leaves on disk.
 *
 * Split out of `mongoGlobalSetup.ts` so the ORDER of operations below can be unit-tested
 * without a real mongod (`mongoTeardown.test.ts`). The order is the whole fix, and it is
 * exactly the kind of thing a later "simplification" back to a bare `replSet.stop()` would
 * remove on sight.
 *
 * Why a bare `stop()` is not enough (reproduced 2026-10-06 on Windows, mongodb-memory-server
 * 11.2, mongod 7.0.14): for a replica set, MMS sends `shutdown` and then SIGINT while mongod
 * is still shutting down. A mongod that gets that SIGINT mid-shutdown may never emit `exit`,
 * MMS's `killProcess` waits out its hard-coded 10 s + 10 s, prints
 * `An Process didnt exit with signal "SIGINT" within 10 seconds, using "SIGKILL"!`, and
 * `stop()` skips its own cleanup. A fully green run (123 files, exit 0) left a 506 MB
 * `%TEMP%\mongo-mem-*` dbPath behind every time; ~18 of them (~7 GB) piled up in 30 hours.
 * The sibling project `funny` hit and fixed the same defect
 * (`server/scripts/testMongoHarness.ts` there); this is a port of that fix.
 */
import { MongoClient } from 'mongodb';
import type { ChildProcess } from 'node:child_process';
import { readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * How long we wait for mongod's own graceful shutdown. Generous on purpose: this budget is
 * ours, not a race, and blowing it only falls back to MMS's kill path — what used to happen
 * on every run.
 */
const SHUTDOWN_WAIT_MS = 120_000;

/** Warn above this: a shutdown this slow is wall clock burnt on every run, worth seeing. */
const SHUTDOWN_WARN_MS = 8_000;

/**
 * A `mongo-mem-*` dir younger than this is never swept, even when nothing holds it: MMS
 * creates the dir a moment before mongod opens anything in it, and that window may belong to
 * a concurrent run (another worktree, another repo) that is just starting up.
 */
const ORPHAN_MIN_AGE_MS = 10 * 60_000;

/**
 * The slice of MMS's API that teardown touches. Structural on purpose: `MongoMemoryReplSet`'s
 * servers satisfy it, and so does a plain object, which is what makes this testable.
 */
export interface MongoServerLike {
  instanceInfo?: {
    ip: string;
    port: number;
    tmpDir?: string;
    instance: { mongodProcess?: ChildProcess };
  };
}

export interface StoppableMongo {
  servers: readonly MongoServerLike[];
  stop(opts: { doCleanup: boolean; force: boolean }): Promise<boolean>;
}

/**
 * Shut every mongod down, then clean up after it. Never throws: teardown runs after every
 * test has reported, so a failure here must not red a run whose assertions all passed — but
 * it does print a `::warning::` naming what went wrong.
 */
export async function teardownMongo(mongo: StoppableMongo): Promise<void> {
  // Captured before stop(), which empties `servers` on the replica-set path.
  const tmpDirs = mongo.servers.map((s) => s.instanceInfo?.tmpDir).filter((d): d is string => !!d);

  for (const server of mongo.servers) await stopMongod(server);

  try {
    // `doCleanup: false` is required, not a preference: MMS's cleanup() ASSERTS that
    // `instance.mongodProcess` is undefined, which only holds when MMS did the killing itself.
    // Our mongod is already gone, MMS takes its "nothing to shutdown" branch, leaves the
    // handle set, and its cleanup would throw. What this call is still for: MMS's watchdog
    // `killerProcess` gets reaped inside it. stop() reports a mongod that outlived its own
    // deadline by returning false rather than throwing, so the boolean matters too.
    if (!(await mongo.stop({ doCleanup: false, force: false }))) {
      warn('stop() reported failure — a mongod or its killer process may still be running');
    }
  } catch (err) {
    warn(`stop() threw — ${message(err)}`);
  }

  // Removing the dbPath is ours now. Retries cover a mongod that has only just died and whose
  // WiredTiger files Windows has not released yet; MMS's own removal passes no retries at all.
  for (const dir of tmpDirs) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch (err) {
      warn(`could not remove ${dir} — ${message(err)}; a mongod may still be holding it`);
    }
  }
}

/**
 * Take one mongod down on OUR clock: send `shutdown` ourselves, send no signal at all, and
 * wait for `exit` with our own deadline. By the time MMS's `stop()` runs the pid is gone, so
 * MMS skips its SIGINT and the 10 s + 10 s race never starts.
 */
async function stopMongod(server: MongoServerLike): Promise<void> {
  const info = server.instanceInfo;
  const proc = info?.instance.mongodProcess;
  if (!info || !proc || hasExited(proc)) return;

  const started = Date.now();
  try {
    const client = await MongoClient.connect(`mongodb://${info.ip}:${info.port}/admin`, {
      serverSelectionTimeoutMS: 5_000,
      directConnection: true,
    });
    try {
      // `timeoutSecs: 1` caps the wait for a secondary to catch up; a one-node set has none.
      await client.db('admin').command({ shutdown: 1, force: true, timeoutSecs: 1 });
    } finally {
      await client.close();
    }
  } catch {
    // mongod drops the connection the moment it accepts `shutdown`, so this almost always
    // rejects with a network error — that IS the success path. The exit below decides.
  }

  if (!(await waitForExit(proc, SHUTDOWN_WAIT_MS))) {
    warn(`mongod was still alive ${SHUTDOWN_WAIT_MS / 1000}s after the shutdown command — falling back to mongodb-memory-server's kill path`);
    return;
  }
  const elapsed = Date.now() - started;
  if (elapsed >= SHUTDOWN_WARN_MS) warn(`mongod took ${(elapsed / 1000).toFixed(1)}s to shut down`);
}

function hasExited(proc: ChildProcess): boolean {
  return proc.exitCode !== null || proc.signalCode !== null;
}

/** Resolves true once `proc` has exited, false when `timeoutMs` runs out first. */
export function waitForExit(proc: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (hasExited(proc)) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const onExit = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      proc.off('exit', onExit);
      resolve(false);
    }, timeoutMs);
    proc.once('exit', onExit);
  });
}

export interface SweepOptions {
  /** Where MMS puts its dbPaths. */
  dir?: string;
  now?: number;
  platform?: NodeJS.Platform;
}

/**
 * Remove `mongo-mem-*` dbPaths that earlier, interrupted runs left behind; returns what it
 * removed.
 *
 * `teardownMongo` only runs when the run reaches its teardown. A run that dies first leaks
 * the whole dir, because MMS's `mongo_killer` watchdog kills the orphaned mongod but never
 * touches its files. The usual way to die there is a pipe, not a crash:
 * `npx vitest run 2>&1 | head` — `head` exits, vitest dies of EPIPE on its next write.
 * Stopping a background run, or ending the session that owns it, does the same.
 *
 * "Orphaned" is decided by the filesystem: on Windows a directory cannot be renamed while any
 * handle inside it is open, and a live mongod holds every file in its dbPath. So a successful
 * rename proves nobody uses the dir any more, and it moves the dir out of the way atomically,
 * so a concurrent sweep cannot race this one into a half-deleted dir. The renamed dir keeps
 * the `mongo-mem-` prefix: if the delete fails, the next sweep picks it up again.
 *
 * Windows only, on purpose: on POSIX a rename succeeds under a live mongod, so the same check
 * would delete a running suite's data. CI runs on throwaway Linux runners anyway.
 *
 * This sweeps EVERY `mongo-mem-*` in the temp dir, whichever repo leaked it — the rename check
 * is what keeps that safe.
 */
export function sweepOrphanedDbPaths({
  dir = tmpdir(),
  now = Date.now(),
  platform = process.platform,
}: SweepOptions = {}): string[] {
  if (platform !== 'win32') return [];

  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.startsWith('mongo-mem-'));
  } catch {
    return [];
  }

  const removed: string[] = [];
  for (const name of names) {
    const path = join(dir, name);
    try {
      const st = statSync(path);
      if (!st.isDirectory() || now - st.mtimeMs < ORPHAN_MIN_AGE_MS) continue;
      const claimed = `${path}.orphan-${process.pid}`;
      renameSync(path, claimed); // throws while a mongod still has it open: live, skip it
      rmSync(claimed, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      removed.push(path);
    } catch {
      // Live, already claimed by a concurrent sweep, or not deletable right now: not ours.
    }
  }
  return removed;
}

/**
 * `::warning::` is GitHub Actions' annotation syntax, so a teardown hiccup shows up on the
 * check run instead of being re-diagnosed later from a bare exit code.
 */
function warn(msg: string): void {
  console.log(`::warning::server test teardown: ${msg}`);
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
