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
import { connect } from 'node:net';
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

describe('a request that fails before any handler runs', () => {
  it('answers a malformed Host header with 500 and stays up — the SYNCHRONOUS arm', async () => {
    // `dispatch` builds the request URL from the Host header before choosing a route, and
    // `new URL` throws on a host it cannot parse. That throw is synchronous, so it is the
    // boundary's try/catch that answers, not the promise arm the store failures above reach.
    // Sent over a raw socket because fetch will not send a Host header it considers invalid.
    const status = await new Promise<string>((resolve, reject) => {
      const { port } = new URL(baseUrl);
      const socket = connect(Number(port), '127.0.0.1', () =>
        socket.write('GET /health HTTP/1.1\r\nHost: a b\r\nConnection: close\r\n\r\n'),
      );
      let raw = '';
      socket.on('data', (chunk) => (raw += chunk));
      socket.on('close', () => resolve(raw.split('\r\n')[0]!));
      socket.on('error', reject);
    });
    expect(status).toBe('HTTP/1.1 500 Internal Server Error');
    expect(vi.mocked(console.error).mock.calls.flat().join(' ')).toMatch(/Invalid URL/);
    // Control: the same route with a well-formed host is fine, and the process is still here.
    expect((await fetch(`${baseUrl}/health`)).status).toBe(200);
  });
});

describe('a rejection that is not an Error', () => {
  it('still answers 500 and logs the value itself', async () => {
    // A driver or a stray `throw 'x'` can reject with a bare value; the log line must carry it
    // rather than `undefined`, which is what reading `.message` off a string would give.
    const real = store.accounts.findOne.bind(store.accounts);
    store.accounts.findOne = () => Promise.reject('socket hang up');
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
    expect(vi.mocked(console.error).mock.calls.flat().join(' ')).toMatch(/error="socket hang up"/);
  });
});

// The arm for a failure AFTER a response has started (`headersSent` → destroy) has no real
// route that reaches it — every handler answers last — so it is driven with a stand-in
// dispatch in `matchsvc.errorBoundary.sent.test.ts`.
