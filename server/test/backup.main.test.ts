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
import { healthExitCode, loadOrExit, main } from '../src/backup/main';
import { writeStatus } from '../src/backup/runner';
import { readBackupConfig } from '../src/backup/config';

const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ddu-backup-main-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function env(destDir: string): NodeJS.ProcessEnv {
  return { DDU_DB_PATH: '/sources/matchsvc/accounts.db', DDU_BACKUP_DIR: destDir, DDU_BACKUP_INTERVAL_HOURS: '24' };
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
