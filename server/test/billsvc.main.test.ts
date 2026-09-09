/**
 * billsvc's process entry point. Two things live only here:
 *
 *   - `main` refuses to start under a production environment with a dev-only flag set,
 *     and refuses BEFORE binding a port or creating a database file. design/19's second
 *     fail-closed defence is worth nothing if the process comes up first and throws after.
 *   - The listen/log/shutdown sequence itself, which `matchsvc.http.test.ts`-style route
 *     tests never touch because they call `createBillsvcServer` and bind their own port.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { main, DEFAULT_BILL_PORT, OTHER_PLANE_PORTS } from '../src/billsvc/main';
import { openBillingDb } from '../src/billingDb';
import { deliveryById } from '../src/billsvc/outbox';
import type { BillsvcServer } from '../src/billsvc/server';
import { BillingStartupError } from '../src/billsvc/startupGuard';

const handles: BillsvcServer[] = [];
const dirs: string[] = [];

function tmpDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bb-billsvc-main-'));
  dirs.push(dir);
  return join(dir, 'billing.db');
}

/** Binds on port 0 so the suite never collides with a real 8789 or with itself. */
async function listen(env: Record<string, string | undefined>): Promise<BillsvcServer> {
  const handle = main(env, 0, '127.0.0.1');
  handles.push(handle);
  await new Promise<void>((resolve) => handle.server.once('listening', resolve));
  return handle;
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  while (handles.length) {
    const { server, db, pump } = handles.pop()!;
    // Before the connection closes: `main` arms the delivery pump, and a sweep still in
    // flight would be writing into a database that is about to go away.
    await pump.stop();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    // Must close BEFORE the rmSync below: Windows keeps a lock on an open SQLite file and
    // the directory removal fails with EPERM.
    db.close();
  }
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('main — the delivery pump', () => {
  it('sweeps the outbox at STARTUP, so a delivery a previous process left owed is resumed', async () => {
    // The whole reason `deliveries` is a table rather than a variable (design/19 §4). No
    // webhook is coming a second time for a purchase that already settled, so if `main` did
    // not arm this sweep nothing ever would.
    const dbPath = tmpDbPath();
    vi.stubEnv('BB_BILLING_DB_PATH', dbPath);
    // Refused instantly, so the attempt is observable without waiting on a real timeout —
    // and a REFUSED attempt is the strongest evidence available here: it proves the sweep
    // ran and reached the network, which nothing but `start()` could have caused.
    vi.stubEnv('BB_MATCHSVC_URL', 'http://127.0.0.1:1');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Written by the "previous process", before this one exists.
    const seeded = openBillingDb(dbPath);
    seeded
      .prepare(
        `INSERT INTO deliveries (id, account_id, sku, grants_json, order_id, receipt_id, state, attempts, created_at, delivered_at)
         VALUES ('purchase:dev:T1', 'a1', 'bp.cannon', '[]', 'o1', 'dev:r1', 'pending', 0, 1, NULL)`,
      )
      .run();
    seeded.close();

    const handle = await listen({ BB_BILLING_DEV_STUB: '1' });
    await handle.pump.stop(); // awaits the sweep `start()` already kicked off

    const row = deliveryById(handle.db, 'purchase:dev:T1')!;
    expect(row.attempts).toBeGreaterThanOrEqual(1);
    // Still owed, because the control plane was unreachable — a retryable failure never
    // writes a paid purchase off.
    expect(row.state).toBe('pending');
  });
});

describe('main — the startup refusal', () => {
  it('DEFENCE 2: throws under production with the dev stub flag set', () => {
    const dbPath = tmpDbPath();
    vi.stubEnv('BB_BILLING_DB_PATH', dbPath);
    expect(() => main({ NODE_ENV: 'production', BB_BILLING_DEV_STUB: '1' }, 0, '127.0.0.1')).toThrow(
      BillingStartupError,
    );
    // Nothing was opened before the throw: no port bound, no database file created. A
    // guard that fires after `listen()` leaves a live billing process behind.
    expect(existsSync(dbPath)).toBe(false);
  });

  it('starts under production when nothing dev-only is set', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubEnv('BB_BILLING_DB_PATH', tmpDbPath());
    const { server } = await listen({ NODE_ENV: 'production', BB_INTERNAL_KEY: 'k' });
    expect((server.address() as AddressInfo).port).toBeGreaterThan(0);
    // TWO lines now, not one: the listen banner and the heartbeat's immediate first beat
    // (src/heartbeat.ts — it beats once at start precisely so a fresh process is visible
    // without a five-minute wait). Asserted as an exact pair rather than relaxed to
    // `toHaveBeenCalled`, because "how many lines does starting up produce" is the thing
    // this assertion was protecting.
    expect(log).toHaveBeenCalledTimes(2);
    expect(String(log.mock.calls[1]![0])).toContain('heartbeat');
    expect(String(log.mock.calls[0]![0])).toContain('devStub=false');
  });
});

describe('main — the listening process', () => {
  it('serves /health on the port it was given', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubEnv('BB_BILLING_DB_PATH', tmpDbPath());
    const { server } = await listen({ NODE_ENV: 'test', BB_INTERNAL_KEY: 'k' });
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(await res.json()).toEqual({ ok: true, service: 'daydayup-billsvc' });
  });

  it('creates its database at BB_BILLING_DB_PATH, not at the account DB path', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const billingPath = tmpDbPath();
    const accountPath = join(dirs[dirs.length - 1]!, 'daydayup.db');
    vi.stubEnv('BB_BILLING_DB_PATH', billingPath);
    vi.stubEnv('BB_DB_PATH', accountPath);
    await listen({ NODE_ENV: 'test' });
    expect(existsSync(billingPath)).toBe(true);
    expect(existsSync(accountPath)).toBe(false);
  });

  it('says so in the startup line when the dev receipt stub is live', async () => {
    // The one posture fact an operator needs on a box they were not expecting to be a dev
    // box. It used to be a bracketed "[DEV RECEIPT STUB ENABLED]" banner inside the
    // message; since the structured logger landed it is a FIELD, which is the half that
    // matters — a marker buried in prose is invisible to `| logfmt`, so "was the store
    // real on the day of that order?" had no query, only a grep of logs long since rotated.
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('BB_BILLING_DB_PATH', tmpDbPath());
    await listen({ NODE_ENV: 'test', BB_BILLING_DEV_STUB: '1' });
    expect(String(log.mock.calls[0]![0])).toContain('devStub=true');
  });

  it('logs the database path, so two planes pointed at one file are visible at a glance', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const path = tmpDbPath();
    vi.stubEnv('BB_BILLING_DB_PATH', path);
    await listen({ NODE_ENV: 'test' });
    // Accepts either form on purpose. `formatFields` quotes a value that would not
    // survive `| logfmt` as one token, and this path contains backslashes on Windows and
    // none on the Linux deploy target — so a raw-string assertion would pass on the box
    // and fail on the machine it is written on, which is the wrong way round.
    const line = String(log.mock.calls[0]![0]);
    expect(line.includes(path) || line.includes(JSON.stringify(path))).toBe(true);
  });

  it('closes cleanly, so a deploy does not leave the process hanging', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubEnv('BB_BILLING_DB_PATH', tmpDbPath());
    const { server, db } = await listen({ NODE_ENV: 'test' });
    handles.pop(); // this case owns the shutdown, so afterEach must not double-close
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
    expect(server.listening).toBe(false);
  });

  it('reads BILL_PORT/HOST defaults when called with no port', () => {
    // Not bound — just that the signature's defaults exist, so `main()` from the CLI
    // guard needs no arguments. Binding 8789 in a test would fight a real dev process.
    expect(main.length).toBe(0);
  });

  it('defaults to 8789, the port design/19 assigns the billing plane', () => {
    expect(DEFAULT_BILL_PORT).toBe(8789);
  });

  it('does not default onto either of the other two planes', () => {
    // The half that matters. Three processes on one box: 8787 data plane (`index.ts`),
    // 8788 control plane (`matchsvc.ts`), 8789 billing. Defaulting onto 8788 makes billsvc
    // either refuse to bind or shadow the process it was deliberately split away from —
    // and every other case in this file binds port 0, so nothing else can see it.
    expect(DEFAULT_BILL_PORT).not.toBe(OTHER_PLANE_PORTS.dataPlane);
    expect(DEFAULT_BILL_PORT).not.toBe(OTHER_PLANE_PORTS.controlPlane);
  });
});
