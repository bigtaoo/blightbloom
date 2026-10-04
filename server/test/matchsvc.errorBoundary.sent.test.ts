/**
 * The one arm of matchsvc's request ERROR BOUNDARY that no real route can reach: a failure
 * AFTER the response has started. `failRequest` checks `res.headersSent` and destroys the
 * connection rather than writing a 500, because a status line cannot follow one already on the
 * wire — writing it anyway throws ERR_HTTP_HEADERS_SENT from inside the code whose whole job
 * is to handle failures.
 *
 * Every shipped handler answers LAST (`routes/telemetry.ts` even resolves its write before
 * replying), so this file swaps `dispatch` for a stand-in that starts a response and then
 * rejects. Everything else — the server, the boundary, the logger — is the shipped code.
 * The sibling `matchsvc.errorBoundary.http.test.ts` covers the arms real routes reach.
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
  server = createMatchsvcServer({ store: await freshAccounts(), secret: 'sent-test-secret' });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.restoreAllMocks();
});

describe('a failure after the response has started', () => {
  it('cuts the connection instead of writing a second status line', async () => {
    const res = await fetch(`${baseUrl}/half-sent`);
    // The 200 was already on the wire and stays the status the client saw…
    expect(res.status).toBe(200);
    // …but the body never completes: the connection is destroyed, so the client sees a
    // truncated response rather than a 200 that looks whole. That is the only honest ending.
    await expect(res.text()).rejects.toThrow();
    expect(vi.mocked(console.error).mock.calls.flat().join(' ')).toMatch(/cluster lost mid-response/);
  });

  it('leaves the process serving the next request', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, service: 'daydayup-matchsvc' });
  });
});
