/**
 * The worker's entry point: the two modes one bundle serves, and the refusal that must
 * exit non-zero rather than idle.
 *
 * `runForever` is deliberately not driven here — a loop that never returns belongs to
 * `deploy.bundle.test.ts`, which runs the real artifact as a real process and kills it.
 * What lives only in this file is the argv/exit-code surface compose depends on.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FAILURE_RETRY_FLOOR_MS, healthExitCode, loadOrExit, main, retryDelayMs, runForever } from '../src/backup/main';
import { readStatus, writeStatus, type CycleIo } from '../src/backup/runner';
import { readBackupConfig } from '../src/backup/config';

const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bb-backup-main-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function env(destDir: string): NodeJS.ProcessEnv {
  return { BB_DB_PATH: '/sources/matchsvc/accounts.db', BB_BACKUP_DIR: destDir, BB_BACKUP_INTERVAL_HOURS: '24' };
}

describe('healthExitCode', () => {
  it('is 1 before the first cycle has published anything', () => {
    const dir = tmp();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(healthExitCode(readBackupConfig(env(dir)), new Date())).toBe(1);
    expect(err.mock.calls[0]?.[0]).toContain('no status.json yet');
  });

  it('is 0 after a good, recent cycle', () => {
    const dir = tmp();
    writeStatus(dir, { at: new Date('2026-09-07T01:00:00Z').toISOString(), ok: true, sources: [] });
    expect(healthExitCode(readBackupConfig(env(dir)), new Date('2026-09-07T02:00:00Z'))).toBe(0);
  });

  it('is 1 on a stale cycle, and SAYS it is stale rather than just failing', () => {
    // The message is the whole diagnostic an operator gets out of `docker inspect`, so the
    // two failure kinds have to read differently: "stale" means the loop stopped, "had
    // failures" means it ran and could not read a database.
    const dir = tmp();
    writeStatus(dir, { at: new Date('2026-09-01T01:00:00Z').toISOString(), ok: true, sources: [] });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(healthExitCode(readBackupConfig(env(dir)), new Date('2026-09-07T01:00:00Z'))).toBe(1);
    expect(err.mock.calls[0]?.[0]).toContain('is stale');
  });

  it('is 1 on a recent cycle that FAILED, and says so differently', () => {
    const dir = tmp();
    writeStatus(dir, {
      at: new Date('2026-09-07T01:00:00Z').toISOString(),
      ok: false,
      sources: [{ source: '/sources/matchsvc/accounts.db', ok: false, error: 'unreadable' }],
    });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(healthExitCode(readBackupConfig(env(dir)), new Date('2026-09-07T01:05:00Z'))).toBe(1);
    expect(err.mock.calls[0]?.[0]).toContain('had failures');
  });
});

describe('loadOrExit', () => {
  it('returns the config when the environment is usable', () => {
    const dir = tmp();
    expect(loadOrExit(env(dir)).destDir).toBe(dir);
  });

  it('exits 2 with a message when there is nothing to back up', () => {
    // Not a throw: this is a process boundary, and the contract compose sees is the exit
    // code. `unless-stopped` then restart-loops it visibly instead of running a no-op.
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit called');
    }) as never);

    expect(() => loadOrExit({})).toThrow('exit called');
    expect(exit).toHaveBeenCalledWith(2);
    expect(err.mock.calls[0]?.[0]).toContain('no databases to back up');
  });

  it('rethrows anything that is NOT a configuration refusal', () => {
    // A programming error must not be converted into a tidy exit code — that is how a real
    // bug becomes "the backup container keeps restarting, probably config".
    const boom = new TypeError('env is not iterable');
    expect(() =>
      loadOrExit(
        new Proxy({} as NodeJS.ProcessEnv, {
          get() {
            throw boom;
          },
        }),
      ),
    ).toThrow(boom);
  });
});

describe('retryDelayMs', () => {
  const DAY = 24 * 3_600_000;

  it('retries a failed cycle in a minute, not in a day', () => {
    // The whole point. A failed cycle used to sleep the full interval, so the FIRST
    // cycle's success was a 24-hour commitment — and that first cycle races the services
    // that create the databases it reads. On 2026-09-09 it lost that race by 0.6s against
    // matchsvc creating `analytics.db`, and the container was unhealthy for a day over a
    // file that existed a second later. A day is not a retry, it is a resignation.
    expect(retryDelayMs(1, DAY)).toBe(FAILURE_RETRY_FLOOR_MS);
    expect(retryDelayMs(1, DAY)).toBeLessThan(DAY);
  });

  it('doubles, so a permanently broken source does not log once a minute forever', () => {
    expect(retryDelayMs(2, DAY)).toBe(FAILURE_RETRY_FLOOR_MS * 2);
    expect(retryDelayMs(3, DAY)).toBe(FAILURE_RETRY_FLOOR_MS * 4);
  });

  it('never waits longer than the interval it stands in for', () => {
    // A retry slower than the normal schedule would be a backoff that has made things
    // worse than not retrying. The cap is also what stops `2 ** n` from becoming Infinity
    // in the delay — asserted at a failure count no real worker reaches, because the
    // arithmetic is what is being pinned, not the scenario.
    expect(retryDelayMs(99, DAY)).toBe(DAY);
    expect(retryDelayMs(2000, DAY)).toBe(DAY);
    expect(Number.isFinite(retryDelayMs(2000, DAY))).toBe(true);
    // ...including when the configured interval is SHORTER than the retry floor, which is
    // the one case where the floor itself would be the slower schedule.
    expect(retryDelayMs(1, 10_000)).toBe(10_000);
  });

  it('a cycle that did not fail waits the full interval', () => {
    // Guards the arm the loop takes on success by a different route than `runForever`'s
    // own ternary, so a `failures` counter that never resets is still caught here.
    expect(retryDelayMs(0, DAY)).toBe(DAY);
  });
});

describe('runForever pacing', () => {
  /**
   * Drive the loop for a bounded number of waits by BEING the thing it waits on, then
   * throw to leave it. Returns every delay it asked for, in order.
   *
   * `retryDelayMs` is pinned on its own above, and that is not enough: a revert of the
   * loop back to a flat `sleep(cfg.intervalMs)` leaves every one of those cases passing
   * while restoring the exact bug. The delay the loop actually takes is the assertion.
   */
  async function delaysOf(cfg: ReturnType<typeof readBackupConfig>, io: CycleIo, waits: number): Promise<number[]> {
    const seen: number[] = [];
    const stop = new Error('enough');
    await expect(
      runForever(cfg, {
        io,
        sleep: (ms: number) => {
          seen.push(ms);
          return seen.length >= waits ? Promise.reject(stop) : Promise.resolve();
        },
      }),
    ).rejects.toBe(stop);
    return seen;
  }

  /** A source that fails the first `failFor` cycles and succeeds after — the cold-start
   *  race's actual shape: the file does not exist yet, then it does. */
  function flakyIo(failFor: number, log: string[] = []): CycleIo {
    let n = 0;
    return {
      snapshot: (source, destDir, at) => {
        if (n++ < failFor) throw new Error('unable to open database file');
        return { source, file: `${destDir}/accounts-${at.toISOString()}.db.gz`, bytes: 10, rawBytes: 100 };
      },
      list: () => [],
      remove: () => {},
      log: (line) => log.push(line),
    };
  }

  it('a first cycle that lost the cold-start race retries in a minute and then recovers', async () => {
    const dir = tmp();
    const cfg = readBackupConfig(env(dir));
    const delays = await delaysOf(cfg, flakyIo(1), 2);

    // First wait is the RETRY floor, not the 24h interval: this is the deploy-breaking
    // case, where matchsvc created `analytics.db` 0.6s after the worker looked for it.
    expect(delays[0]).toBe(FAILURE_RETRY_FLOOR_MS);
    // ...and the retry succeeded, so the loop is back on its normal schedule AND the
    // failure counter reset — a counter that kept climbing would show up as a delay of
    // 2x the floor here.
    expect(delays[1]).toBe(cfg.intervalMs);
    // The status file the healthcheck reads now reports the recovery, which is the thing
    // `ci-deploy.sh` polls. Without this the loop could pace correctly and still leave a
    // red container.
    expect(readStatus(dir)?.ok).toBe(true);
  });

  it('a source that stays broken backs off instead of retrying every minute forever', async () => {
    const dir = tmp();
    const cfg = readBackupConfig(env(dir));
    const log: string[] = [];
    const delays = await delaysOf(cfg, flakyIo(Number.POSITIVE_INFINITY, log), 3);

    expect(delays).toEqual([FAILURE_RETRY_FLOOR_MS, FAILURE_RETRY_FLOOR_MS * 2, FAILURE_RETRY_FLOOR_MS * 4]);
    // Still failing, still red — backing off is not the same as giving up, and the
    // container must not go green just because the loop got quieter.
    expect(readStatus(dir)?.ok).toBe(false);
    expect(log.every((l) => l.startsWith('backup FAILED'))).toBe(true);
  });
});

describe('main', () => {
  it('--health runs the health mode and exits with its code, without a cycle', async () => {
    const dir = tmp();
    writeStatus(dir, { at: new Date().toISOString(), ok: true, sources: [] });
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit called');
    }) as never);

    await expect(main(['--health'], env(dir))).rejects.toThrow('exit called');
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('--health exits 1 when unhealthy, which is what turns the container red', async () => {
    const dir = tmp();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit called');
    }) as never);

    await expect(main(['--health'], env(dir))).rejects.toThrow('exit called');
    expect(exit).toHaveBeenCalledWith(1);
  });
});
