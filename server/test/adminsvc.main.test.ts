/**
 * adminsvc's process entry point. Three things live only here:
 *
 *   - `main` binds a port and logs the three handle states, which every route test skips
 *     because it calls `createAdminsvcServer` and binds its own.
 *   - `runMain` turns a configuration refusal into exit 1 plus a readable line, and
 *     rethrows anything that is not one.
 *   - The port constants, which are an interface contract rather than a tuning knob.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { openDb } from '../src/db';
import { DEFAULT_ADMIN_PORT, OTHER_PLANE_PORTS, adminHost, adminPort, main, runMain } from '../src/adminsvc/main';
import { AdminStartupError } from '../src/adminsvc/credentials';
import type { AdminsvcServer } from '../src/adminsvc/server';

const PASSWORD = 'm'.repeat(24);
const handles: AdminsvcServer[] = [];
const dirs: string[] = [];

function scratchAccounts(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bb-adminsvc-main-'));
  dirs.push(dir);
  const path = join(dir, 'accounts.db');
  openDb(path).close();
  return path;
}

/**
 * Binds on port 0 so the suite never collides with a real 8790 or with itself.
 *
 * The three DATABASE paths are stubbed into `process.env` rather than passed as an
 * argument, and that is the seam being tested rather than a shortcut. `main` is the process
 * entry point: `createAdminsvcServer`'s `env` option carries only the CREDENTIAL (the same
 * shape billsvc's `StartupEnv` has), while the database paths are resolved by each owning
 * module's own default from the real environment. A test that handed them in directly would
 * prove nothing about the container, where they arrive exactly this way.
 */
async function listen(env: Record<string, string>): Promise<AdminsvcServer> {
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  const handle = main(process.env, 0, '127.0.0.1');
  handles.push(handle);
  await new Promise<void>((resolve) => handle.server.once('listening', resolve));
  return handle;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  while (handles.length) {
    const handle = handles.pop()!;
    handle.server.closeAllConnections();
    // The 'close' handler closes the three SQLite connections. Required before the rmSync:
    // Windows keeps a lock on an open database file and the removal fails with EPERM.
    await new Promise<void>((resolve) => handle.server.close(() => resolve()));
  }
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('main', () => {
  it('binds and serves /admin/health on the port it was given', async () => {
    const accounts = scratchAccounts();
    const handle = await listen({
      BB_ADMIN_PASSWORD: PASSWORD,
      BB_DB_PATH: accounts,
      BB_BILLING_DB_PATH: join(dirs[0]!, 'no-billing.db'),
      BB_ANALYTICS_DB_PATH: '',
      BB_OPS_DB_PATH: '',
    });
    const { port } = handle.server.address() as AddressInfo;
    const body = (await (await fetch(`http://127.0.0.1:${port}/admin/health`)).json()) as {
      service: string;
      databases: Record<string, boolean>;
    };
    expect(body.service).toBe('blightbloom-adminsvc');
    // The accounts file exists and the other two do not — the state a fresh box is in, and
    // the one `main` has to come up in rather than refuse.
    expect(body.databases).toEqual({ accounts: true, billing: false, analytics: false, ops: false });
  });

  it('returns the handle, so a caller can close the sockets AND the databases', async () => {
    // The reason `main` returns `AdminsvcServer` and not `Server`: the three SQLite
    // connections live for the process, and on Windows an unclosed one locks the file.
    const accounts = scratchAccounts();
    const handle = await listen({
      BB_ADMIN_PASSWORD: PASSWORD,
      BB_DB_PATH: accounts,
      BB_BILLING_DB_PATH: join(dirs[0]!, 'no-billing.db'),
      BB_ANALYTICS_DB_PATH: '',
      BB_OPS_DB_PATH: '',
    });
    expect(handle.dbs.accounts).not.toBeNull();
    expect(typeof handle.dbs.close).toBe('function');
    // `opsDb` is NOT inside `dbs`, on purpose: that bundle's whole meaning is that
    // nothing in it can be written (`flags/store.ts`'s header argues the distinction).
    expect(handle.opsDb).toBeNull();
  });

  it('THROWS before binding when the environment carries no credential', () => {
    // The ordering is the property. A process that bound first and threw afterwards would
    // have put a public port up with no login behind it, however briefly — and `listen` is
    // asynchronous, so "briefly" is not bounded by anything.
    expect(() => main({}, 0, '127.0.0.1')).toThrow(AdminStartupError);
  });
});

describe('runMain', () => {
  it('reports an AdminStartupError as a configuration problem and exits 1', () => {
    const lines: string[] = [];
    const codes: number[] = [];
    // `exit` returns rather than exiting, so the code path after it is observable — the real
    // `process.exit` never comes back and a test that let it run would take the runner with it.
    runMain({}, ((code: number) => {
      codes.push(code);
      return undefined as never;
    }) as (code: number) => never, (line) => lines.push(line));
    expect(codes).toEqual([1]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('adminsvc refused to start');
    expect(lines[0]).toContain('BB_ADMIN_PASSWORD');
    // The message names the FIX, not just the variable. This is the line an operator reads
    // at 2am, and "unset" without the generator command is a puzzle.
    expect(lines[0]).toContain('openssl rand -hex 16');
  });

  it('RETHROWS anything that is not a startup error', () => {
    // The arm that matters for the NEXT bug rather than this one: a `catch` that swallowed
    // everything would turn a real fault into "refused to start" and exit 1, which reads as
    // a configuration problem and sends the operator to the wrong file.
    //
    // Reached through a real failure path rather than a thrown stub. `ADMIN_PORT=99999` is
    // out of range, so `listen` throws ERR_SOCKET_BAD_PORT synchronously — a genuine
    // non-configuration fault of exactly the kind this arm exists for, and one that is only
    // reachable because `adminPort` reads the variable per call rather than at import.
    const exit = ((code: number) => {
      throw new Error(`exit(${code}) must not be reached`);
    }) as (code: number) => never;
    expect(() =>
      runMain({ BB_ADMIN_PASSWORD: PASSWORD, ADMIN_PORT: '99999', HOST: '127.0.0.1' }, exit, () => {}),
    ).toThrow(/port/i);
  });
});

describe('the ops console plane', () => {
  it('is 8790, and collides with none of the other three', () => {
    // A mutation battery on billsvc's equivalent constant changed it to a neighbour's port
    // and no test noticed, because every case binds port 0. This is the same gap, closed
    // for the fourth plane; `deploy.manifests.test.ts` also compares it to compose.
    expect(DEFAULT_ADMIN_PORT).toBe(8790);
    expect(Object.values(OTHER_PLANE_PORTS)).toEqual([8787, 8788, 8789]);
    expect(Object.values(OTHER_PLANE_PORTS)).not.toContain(DEFAULT_ADMIN_PORT);
  });
});

describe('adminPort / adminHost', () => {
  it('read per call, default to the plane port and to every interface', () => {
    expect(adminPort({})).toBe(DEFAULT_ADMIN_PORT);
    expect(adminPort({ ADMIN_PORT: '9001' })).toBe(9001);
    expect(adminHost({})).toBe('0.0.0.0');
    expect(adminHost({ HOST: '127.0.0.1' })).toBe('127.0.0.1');
  });

  it('treat an EMPTY value as unset, for both', () => {
    // design/19 section 9's lesson, which this project has already paid for once: an env var
    // set to the empty string beats a `??` fallback, and a compose file with a trailing
    // `ADMIN_PORT:` and no value produces exactly that. Here it would be `listen(0)` — a
    // random high port nothing proxies to, with a healthcheck polling 8790 forever.
    expect(adminPort({ ADMIN_PORT: '' })).toBe(DEFAULT_ADMIN_PORT);
    expect(adminPort({ ADMIN_PORT: '   ' })).toBe(DEFAULT_ADMIN_PORT);
    expect(adminHost({ HOST: '' })).toBe('0.0.0.0');
  });

  it('do NOT fall back for a non-numeric port', () => {
    // NaN on purpose. `listen(NaN)` throws immediately and names the variable; a silent
    // fallback to 8790 would listen on a port compose did not ask for, and the healthcheck
    // would agree with it by coincidence until somebody changed the value again.
    expect(adminPort({ ADMIN_PORT: 'eight-thousand' })).toBeNaN();
  });
});
