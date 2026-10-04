/**
 * matchsvc's process entry point (`main` in `src/matchsvc.ts`) and the flag-poll arming it
 * does. `matchsvc.http.test.ts` and its siblings call `createMatchsvcServer` and bind their own
 * port, so the boot sequence — connect, install the schema, decide on analytics, listen, log,
 * arm the flag poll — was never run by any test until this file.
 *
 * Like `billsvc.main.test.ts`, this drives `src/mongo.ts`'s PROCESS-WIDE client, because
 * connecting once at boot is the behaviour under test: `BB_MONGO_URI` points at the mongod the
 * suite already runs, `BB_MONGO_DB_PREFIX` is a name nobody else computes, and the memoised
 * client is closed in `afterEach`.
 */
import { describe, it, expect, vi, beforeEach, afterEach, inject } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { MongoClient } from 'mongodb';
import { main, createMatchsvcServer, startFlagPolling } from '../src/matchsvc';
import { closeMongo } from '../src/mongo';
import { createFlagClient } from '../src/flags/client';
import { createLogger } from '../src/log';
import { freshAccounts } from './mongoHarness';

const servers: Server[] = [];
let prefix: string;
let counter = 0;

/** Binds on port 0 so the suite never collides with a real 8788 or with itself. */
async function boot(): Promise<{ server: Server; baseUrl: string }> {
  const server = await main(0, '127.0.0.1');
  servers.push(server);
  if (!server.listening) await new Promise<void>((resolve) => server.once('listening', resolve));
  return { server, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

/** The databases this case left on the shared mongod, read through a client of its own. */
async function databases(): Promise<string[]> {
  const c = await MongoClient.connect(inject('mongoUri'));
  try {
    const { databases: all } = await c.db().admin().listDatabases();
    return all.map((d) => d.name).filter((n) => n.startsWith(`${prefix}_`));
  } finally {
    await c.close();
  }
}

beforeEach(() => {
  prefix = `msmain${process.pid}x${++counter}`;
  vi.stubEnv('BB_MONGO_URI', inject('mongoUri'));
  vi.stubEnv('BB_MONGO_DB_PREFIX', prefix);
  // No flag store and no analytics unless a case opts in: the shipped default posture.
  vi.stubEnv('BB_ADMINSVC_URL', '');
  vi.stubEnv('BB_ANALYTICS_ENABLED', '');
});

afterEach(async () => {
  while (servers.length) {
    const server = servers.pop()!;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await closeMongo();
  const cleaner = await MongoClient.connect(inject('mongoUri'));
  try {
    for (const store of ['accounts', 'analytics']) await cleaner.db(`${prefix}_${store}`).dropDatabase();
  } finally {
    await cleaner.close();
  }
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('main — the boot sequence', () => {
  it('connects, installs the accounts schema and serves, logging where /find will send players', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { baseUrl } = await boot();

    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, service: 'daydayup-matchsvc' });

    // The schema went into the PREFIXED database, i.e. through `mongo.ts`'s `store()` — the
    // unique username index is what makes two registrations of one name impossible.
    const c = await MongoClient.connect(inject('mongoUri'));
    try {
      const names = (await c.db(`${prefix}_accounts`).collection('accounts').indexes()).map((i) => i.name);
      expect(names).toContain('accounts_username_ci');
    } finally {
      await c.close();
    }

    // The listen banner names the bound address and the gameserver target, so an operator
    // learns from the boot log whether /find has anywhere to send a player.
    const lines = log.mock.calls.map((c) => c.join(' '));
    const banner = lines.find((l) => l.includes('control plane listening'));
    expect(banner).toBeDefined();
    expect(banner).toContain('http://127.0.0.1:0');
    expect(banner).toMatch(/gameserver=/);
    // And the heartbeat's immediate first beat, which is what `main` arms after the banner.
    expect(lines.some((l) => l.includes('heartbeat'))).toBe(true);
  });

  it('opens no analytics database unless BB_ANALYTICS_ENABLED says to', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { baseUrl } = await boot();
    // A store write so the accounts database exists for the control below.
    await fetch(`${baseUrl}/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'ada', password: 'hunter22' }),
    });
    const dbs = await databases();
    expect(dbs).toContain(`${prefix}_accounts`);
    // "Collect nothing" also means "create nothing": an operator can tell the two apart.
    expect(dbs).not.toContain(`${prefix}_analytics`);
  });

  it('installs the analytics schema at boot when BB_ANALYTICS_ENABLED=1', async () => {
    vi.stubEnv('BB_ANALYTICS_ENABLED', '1');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await boot();
    // Indexes are installed before the listener, not on first write — the cohort table's
    // exactly-once claim IS its unique index, so it must exist before the first event.
    expect(await databases()).toContain(`${prefix}_analytics`);
  });

  it('rejects before binding a port when no cluster is configured', async () => {
    vi.stubEnv('BB_MONGO_URI', '');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(main(0, '127.0.0.1')).rejects.toThrow(/BB_MONGO_URI is not set/);
    // A boot failure, not a listening process that 500s on a player's first request.
    expect(log.mock.calls.flat().join(' ')).not.toContain('control plane listening');
    expect(await databases()).toEqual([]);
  });
});

describe('startFlagPolling', () => {
  it('starts the flag client belonging to the server it is given, once', async () => {
    // A real client with nothing to poll, so `start` is the shipped one and only observed.
    const flags = createFlagClient({ baseUrl: null, key: undefined, caller: 'test', log: createLogger('test') });
    const start = vi.spyOn(flags, 'start');
    const server = createMatchsvcServer({ store: await freshAccounts(), secret: 's', flags });
    try {
      expect(start).not.toHaveBeenCalled(); // the builder never arms it — `main` does
      expect(startFlagPolling(server)).toBe(flags);
      expect(start).toHaveBeenCalledTimes(1);
    } finally {
      server.close();
    }
  });

  it('answers undefined for a server this module did not build', async () => {
    const { createServer } = await import('node:http');
    expect(startFlagPolling(createServer())).toBeUndefined();
  });
});
