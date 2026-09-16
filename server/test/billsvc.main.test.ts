/**
 * billsvc's process entry point. Three things live only here:
 *
 *   - `main` refuses to start under a production environment with a dev-only flag set,
 *     and refuses BEFORE it connects to anything or binds a port. design/19's second
 *     fail-closed defence is worth nothing if the process comes up first and throws after.
 *   - It is the one caller of `ensureBillingIndexes`, so it is the only place that can be
 *     asked whether the schema is in place before the first webhook can arrive.
 *   - The listen/log/shutdown sequence itself, which `matchsvc.http.test.ts`-style route
 *     tests never touch because they call `createBillsvcServer` and bind their own port.
 *
 * THE ONLY FILE THAT DRIVES `src/mongo.ts`'s PROCESS-WIDE CLIENT. Everything else injects a
 * `Db` from `mongoHarness.ts`, which deliberately owns its own connection (see that file).
 * `main` cannot: connecting once at boot and handing `store('billing')` to the builder is the
 * behaviour under test. So this file stubs `BB_MONGO_URI` at the mongod the suite already
 * runs, gives itself a `BB_MONGO_DB_PREFIX` nobody else can compute, and closes the memoised
 * client in `afterEach`.
 */
import { describe, it, expect, vi, beforeEach, afterEach, inject } from 'vitest';
import type { AddressInfo } from 'node:net';
import { MongoClient } from 'mongodb';
import { main, DEFAULT_BILL_PORT, OTHER_PLANE_PORTS } from '../src/billsvc/main';
import { billingStore } from '../src/billingDb';
import { deliveryById } from '../src/billsvc/outbox';
import { closeMongo, dbName } from '../src/mongo';
import type { BillsvcServer } from '../src/billsvc/server';
import { BillingStartupError } from '../src/billsvc/startupGuard';

const handles: BillsvcServer[] = [];
let prefix: string;
let counter = 0;

/** Binds on port 0 so the suite never collides with a real 8789 or with itself. */
async function listen(env: Record<string, string | undefined>): Promise<BillsvcServer> {
  const handle = await main(env, 0, '127.0.0.1');
  handles.push(handle);
  if (!handle.server.listening) await new Promise<void>((resolve) => handle.server.once('listening', resolve));
  return handle;
}

beforeEach(() => {
  prefix = `main${process.pid}x${++counter}`;
  vi.stubEnv('BB_MONGO_URI', inject('mongoUri'));
  vi.stubEnv('BB_MONGO_DB_PREFIX', prefix);
});

afterEach(async () => {
  while (handles.length) {
    const { server, pump } = handles.pop()!;
    // Before the client closes: `main` arms the delivery pump, and a sweep still in flight
    // would be reading through a connection that is about to go away.
    await pump.stop();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await closeMongo();
  // Drop what this case created, through a client of its own — the memoised one is closed by
  // now, and leaving databases behind would make the shared mongod grow for the whole run.
  const cleaner = await MongoClient.connect(inject('mongoUri'));
  try {
    await cleaner.db(`${prefix}_billing`).dropDatabase();
  } finally {
    await cleaner.close();
  }
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('main — the delivery pump', () => {
  it('sweeps the outbox at STARTUP, so a delivery a previous process left owed is resumed', async () => {
    // The whole reason `deliveries` is a collection rather than a variable (design/19 §4). No
    // webhook is coming a second time for a purchase that already settled, so if `main` did
    // not arm this sweep nothing ever would.
    //
    // Refused instantly, so the attempt is observable without waiting on a real timeout —
    // and a REFUSED attempt is the strongest evidence available here: it proves the sweep ran
    // and reached the network, which nothing but `start()` could have caused.
    vi.stubEnv('BB_MATCHSVC_URL', 'http://127.0.0.1:1');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Written by the "previous process", before this one exists.
    const seeder = await MongoClient.connect(inject('mongoUri'));
    await billingStore(seeder.db(`${prefix}_billing`)).deliveries.insertOne({
      _id: 'purchase:dev:T1',
      accountId: 'a1',
      sku: 'bp.cannon',
      grantsJson: '[]',
      orderId: 'o1',
      receiptId: 'dev:r1',
      state: 'pending',
      attempts: 0,
      createdAt: 1,
    });
    await seeder.close();

    const handle = await listen({ BB_BILLING_DEV_STUB: '1' });
    await handle.pump.stop(); // awaits the sweep `start()` already kicked off

    const row = (await deliveryById(handle.db, 'purchase:dev:T1'))!;
    expect(row.attempts).toBeGreaterThanOrEqual(1);
    // Still owed, because the control plane was unreachable — a retryable failure never
    // writes a paid purchase off.
    expect(row.state).toBe('pending');
  });

  it('puts the schema in place before it binds, so the first webhook cannot precede it', async () => {
    // `ensureBillingIndexes` runs here and nowhere else in the process. An index or validator
    // that landed after the listener would be one the first callback did not have — and the
    // partial unique index on `orders.platformTxnId` is the one that must never be missing.
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const handle = await listen({ NODE_ENV: 'test' });
    const names = (await handle.db.collection('orders').indexes()).map((i) => i.name);
    expect(names).toContain('orders_platform_txn');
  });
});

describe('main — the startup refusal', () => {
  it('DEFENCE 2: rejects under production with the dev stub flag set', async () => {
    await expect(main({ NODE_ENV: 'production', BB_BILLING_DEV_STUB: '1' }, 0, '127.0.0.1')).rejects.toThrow(
      BillingStartupError,
    );
    // Nothing was opened before the refusal: no cluster connection and therefore no database.
    // A guard that fires after `connectMongo()` leaves a live billing process behind.
    const cleaner = await MongoClient.connect(inject('mongoUri'));
    try {
      const names = (await cleaner.db(`${prefix}_billing`).listCollections().toArray()).map((c) => c.name);
      expect(names).toEqual([]);
    } finally {
      await cleaner.close();
    }
  });

  it('starts under production when nothing dev-only is set', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { server } = await listen({ NODE_ENV: 'production', BB_INTERNAL_KEY: 'k' });
    expect((server.address() as AddressInfo).port).toBeGreaterThan(0);
    // TWO lines, not one: the listen banner and the heartbeat's immediate first beat
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
    const { server } = await listen({ NODE_ENV: 'test', BB_INTERNAL_KEY: 'k' });
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(await res.json()).toEqual({ ok: true, service: 'daydayup-billsvc' });
  });

  it('uses the BILLING logical database, not the accounts one', async () => {
    // The successor to "creates its database at BB_BILLING_DB_PATH, not at the account DB
    // path". The two planes are two DATABASES on one cluster now, and the failure to prevent
    // is the same one: a refactor that reaches for the wrong store name and quietly re-merges
    // the money with the accounts.
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const handle = await listen({ NODE_ENV: 'test' });
    expect(handle.db.databaseName).toBe(`${prefix}_billing`);
    expect(handle.db.databaseName).not.toBe(dbName('accounts'));
  });

  it('says so in the startup line when the dev receipt stub is live', async () => {
    // The one posture fact an operator needs on a box they were not expecting to be a dev
    // box. It used to be a bracketed "[DEV RECEIPT STUB ENABLED]" banner inside the message;
    // since the structured logger landed it is a FIELD, which is the half that matters — a
    // marker buried in prose is invisible to `| logfmt`, so "was the store real on the day of
    // that order?" had no query, only a grep of logs long since rotated.
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await listen({ NODE_ENV: 'test', BB_BILLING_DEV_STUB: '1' });
    expect(String(log.mock.calls[0]![0])).toContain('devStub=true');
  });

  it('logs the database name, so two planes pointed at one store are visible at a glance', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await listen({ NODE_ENV: 'test' });
    expect(String(log.mock.calls[0]![0])).toContain(`${prefix}_billing`);
  });

  it('closes cleanly, so a deploy does not leave the process hanging', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { server, pump } = await listen({ NODE_ENV: 'test' });
    handles.pop(); // this case owns the shutdown, so afterEach must not double-close
    await pump.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(server.listening).toBe(false);
  });

  it('reads BILL_PORT/HOST defaults when called with no arguments', () => {
    // Not bound — just that the signature's defaults exist, so `main()` from the CLI guard
    // needs no arguments. Binding 8789 in a test would fight a real dev process.
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
