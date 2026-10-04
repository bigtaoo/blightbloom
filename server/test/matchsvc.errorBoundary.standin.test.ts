/**
 * The two arms of matchsvc's request ERROR BOUNDARY that no real route can reach, driven with
 * a stand-in `dispatch`. Everything else — the server, the boundary, the logger — is the
 * shipped code. The sibling `matchsvc.errorBoundary.http.test.ts` covers the arms real routes
 * reach.
 *
 * - A SYNCHRONOUS throw out of `dispatch`. Its one real trigger was a Host header `new URL`
 *   rejects, which `dispatch` answers with a 400 since 2026-10-04 (`badHost.http.test.ts`).
 *   The try/catch stays: any future synchronous bug in the chain lands there.
 * - A failure AFTER the response has started. `failRequest` checks `res.headersSent` and
 *   destroys the connection rather than writing a 500, because a status line cannot follow one
 *   already on the wire — writing it anyway throws ERR_HTTP_HEADERS_SENT from inside the code
 *   whose whole job is to handle failures. Every shipped handler answers LAST
 *   (`routes/telemetry.ts` even resolves its write before replying).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { freshAccounts } from './mongoHarness';

vi.mock('../src/matchsvcDispatch', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/matchsvcDispatch')>();
  return {
    ...real,
    dispatch: (...args: Parameters<typeof real.dispatch>) => {
      const [req, res] = args;
      if (req.url === '/sync-throw') throw new Error('bug in the route chain');
      if (req.url !== '/half-sent') return real.dispatch(...args);
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.write('partial');
      return Promise.reject(new Error('cluster lost mid-response'));
    },
  };
});

const { createMatchsvcServer } = await import('../src/matchsvc');

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  server = createMatchsvcServer({ store: await freshAccounts(), secret: 'standin-test-secret' });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.restoreAllMocks();
});

const errorLog = () => vi.mocked(console.error).mock.calls.flat().join(' ');

describe('a synchronous throw out of dispatch', () => {
  it('answers 500 and logs it, rather than throwing out of the request listener', async () => {
    const res = await fetch(`${baseUrl}/sync-throw`);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal error' });
    expect(errorLog()).toMatch(/bug in the route chain/);
  });
});

describe('a failure after the response has started', () => {
  it('cuts the connection instead of writing a second status line', async () => {
    const res = await fetch(`${baseUrl}/half-sent`);
    // The 200 was already on the wire and stays the status the client saw…
    expect(res.status).toBe(200);
    // …but the body never completes: the connection is destroyed, so the client sees a
    // truncated response rather than a 200 that looks whole. That is the only honest ending.
    await expect(res.text()).rejects.toThrow();
    expect(errorLog()).toMatch(/cluster lost mid-response/);
  });
});

describe('after either', () => {
  it('the process is still serving', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, service: 'daydayup-matchsvc' });
  });
});
