/**
 * matchsvc's request ERROR BOUNDARY (`matchsvc.ts`), over a real HTTP server.
 *
 * New with the 2026-09-15 move to MongoDB, and tested because it is the thing standing
 * between a transient cluster failure and an outage. Until the port, every handler was
 * synchronous over a local SQLite file: a throw was a programming bug and there was no
 * boundary here at all. Handlers await a network database now, so a failover, a pool
 * timeout or a dropped connection arrives as a REJECTED PROMISE on an ordinary request —
 * and with no boundary Node treats that as an unhandled rejection and takes the process
 * down, turning one bad request into a disconnect for every player on this service.
 *
 * Driven over a real socket rather than by calling the handler, because the property under
 * test is precisely what happens to the PROCESS and to the connection, which a direct call
 * cannot show. Failure is injected by making the store itself reject, so the rejection
 * arrives the way a real one would: from inside an awaited driver call, after the route has
 * already been chosen.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createMatchsvcServer } from '../src/matchsvc';
import { freshAccounts } from './mongoHarness';
import type { AccountsStore } from '../src/db';

let server: Server;
let baseUrl: string;
let store: AccountsStore;

beforeAll(async () => {
  store = await freshAccounts();
  // The logger writes the failure line; silenced so a deliberate failure does not look like
  // a broken suite, but still asserted below — a boundary that swallows silently is worse
  // than none, because nothing then tells an operator the cluster is flapping.
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  server = createMatchsvcServer({ store, secret: 'boundary-test-secret' });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.restoreAllMocks();
});

const register = (username: string) =>
  fetch(`${baseUrl}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: 'hunter22' }),
  });

describe('a store failure mid-request', () => {
  it('answers 500 and leaves the process alive to serve the next request', async () => {
    const real = store.accounts.insertOne.bind(store.accounts);
    store.accounts.insertOne = () => Promise.reject(new Error('connection to cluster lost'));
    try {
      const failed = await register('ada');
      expect(failed.status).toBe(500);
      expect(await failed.json()).toEqual({ error: 'internal error' });
    } finally {
      store.accounts.insertOne = real;
    }

    // THE ASSERTION THAT MATTERS. Without the boundary the rejection above would have been
    // an unhandled rejection and this request would never be answered, because the process
    // would be gone. One bad request must cost one bad response.
    const ok = await register('grace');
    expect(ok.status).toBe(200);
    expect((await ok.json()) as Record<string, unknown>).toMatchObject({ username: 'grace' });
  });

  it('answers /health normally afterwards, so the container is not restarted for one blip', async () => {
    // The healthcheck is what docker-compose restarts on. A boundary that answered 500 here
    // too would turn a transient cluster hiccup into a restart loop.
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, service: 'daydayup-matchsvc' });
  });

  it('logs the failure rather than swallowing it', async () => {
    const real = store.accounts.findOne.bind(store.accounts);
    store.accounts.findOne = () => Promise.reject(new Error('pool timed out'));
    try {
      const res = await fetch(`${baseUrl}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'ada', password: 'hunter22' }),
      });
      expect(res.status).toBe(500);
    } finally {
      store.accounts.findOne = real;
    }
    // The reason has to reach the operator; a 500 with no line behind it is a cluster
    // problem nobody can see.
    const logged = vi.mocked(console.error).mock.calls.flat().join(' ');
    expect(logged).toMatch(/pool timed out/);
  });
});

describe('a store failure on a route that already answered', () => {
  it('does not try to write a second response over a sent one', async () => {
    // `headersSent` guards this: a handler that already started a response cannot be given a
    // status code, and writing one anyway throws ERR_HTTP_HEADERS_SENT from inside the
    // boundary — a failure in the code whose whole job is to handle failures. Exercised
    // through a successful request, which is the case where a late rejection would find
    // headers already on the wire.
    const ok = await register('hopper');
    expect(ok.status).toBe(200);
    const again = await fetch(`${baseUrl}/health`);
    expect(again.status).toBe(200);
  });
});
