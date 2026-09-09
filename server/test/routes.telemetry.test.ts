/**
 * THE INGEST ROUTE, DRIVEN OVER REAL HTTP (src/routes/telemetry.ts).
 *
 * `clientLog.test.ts` covers the pure conversion. This file covers what only a real
 * request can show: that the response never depends on the log store, that the account id
 * comes from the bearer token and not from the body, that the rate limit keys on the right
 * hop of `x-forwarded-for`, and that an over-sized body is refused rather than half-read.
 *
 * It binds an ephemeral port and speaks real HTTP for the same reason
 * `matchsvc.http.test.ts` does: the CORS/header layer is where this project's last two
 * client-facing bugs actually lived, and no handler-level test can see it.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import type { Server, IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createMatchsvcServer } from '../src/matchsvc';
import { RateLimiter, clientKey, CLIENT_LOG_BODY_LIMIT, RATE_LIMIT } from '../src/routes/telemetry';

const NOW = 1_800_000_000_000;
const servers: Server[] = [];

/**
 * In-memory, unlike the on-disk temp file the billsvc suites use. Nothing here is about
 * PERSISTENCE — the one account row exists only so a bearer token can be resolved — and
 * `createMatchsvcServer` holds its SQLite handle for the life of the process with no way to
 * close it. On Windows that keeps a lock on the file, so removing the temp directory in
 * `afterEach` throws EPERM and fails every test in the file for a reason unrelated to any
 * of them. Same choice `matchsvc.http.test.ts` already makes, for the same reason.
 */
const IN_MEMORY_DB = ':memory:';

interface Harness {
  base: string;
  pushes: unknown[];
  fetchCalls: number;
}

async function start(opts: { lokiUrl?: string | null; failPush?: boolean; slowPush?: boolean } = {}): Promise<Harness> {
  const pushes: unknown[] = [];
  const h: Harness = { base: '', pushes, fetchCalls: 0 };
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    h.fetchCalls += 1;
    pushes.push(JSON.parse(init.body as string));
    if (opts.slowPush) await new Promise((r) => setTimeout(r, 5000));
    if (opts.failPush) throw new Error('ECONNREFUSED');
    return new Response('', { status: 204 });
  }) as unknown as typeof fetch;

  const server = createMatchsvcServer({
    dbPath: IN_MEMORY_DB,
    lokiUrl: opts.lokiUrl === undefined ? 'http://loki/push' : opts.lokiUrl,
    fetchImpl,
    log: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {}, child: () => ({}) as never },
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  h.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return h;
}

const batch = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  session: 'sess-1',
  host: 'web',
  ver: 'v1',
  now: NOW,
  entries: [{ t: NOW - 500, level: 'error', msg: 'boom', tag: 'boot' }],
  ...over,
});

function post(base: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}/client/log`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  vi.restoreAllMocks();
});

describe('the answer never depends on the log store', () => {
  it('accepts a batch and reports how many entries it took', async () => {
    const h = await start();
    const res = await post(h.base, batch());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, accepted: 1 });
  });

  it('still answers 200 when the store REFUSES the push', async () => {
    const h = await start({ failPush: true });
    const res = await post(h.base, batch());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, accepted: 1 });
  });

  it('still answers 200, promptly, when the store is SLOW', async () => {
    // The push is `void`-ed, never awaited. Without that, this response waits on a log
    // store — the exact shape of "telemetry took the game down".
    const h = await start({ slowPush: true });
    const started = Date.now();
    const res = await post(h.base, batch());
    expect(res.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('answers 200 with accepted:0 for a malformed body, never a 4xx', async () => {
    // A 4xx teaches a client to retry, and a client retrying a malformed batch retries it
    // forever. Asserted for both shapes: unparseable, and parseable but unusable.
    const h = await start();
    expect(await (await post(h.base, 'not json at all')).json()).toEqual({ ok: true, accepted: 0 });
    expect(await (await post(h.base, batch({ host: 'steam' }))).json()).toEqual({ ok: true, accepted: 0 });
    expect(h.fetchCalls).toBe(0);
  });

  it('drops the batch when no store is configured, and does not fail the request', async () => {
    const h = await start({ lokiUrl: null });
    expect(await (await post(h.base, batch())).json()).toEqual({ ok: true, accepted: 1 });
    expect(h.fetchCalls).toBe(0);
  });
});

describe('what actually reaches the store', () => {
  it('pushes the converted payload, with the three fixed labels', async () => {
    const h = await start();
    await post(h.base, batch());
    await vi.waitFor(() => expect(h.pushes).toHaveLength(1));
    const payload = h.pushes[0] as { streams: Array<{ stream: Record<string, string>; values: unknown[] }> };
    expect(payload.streams[0]!.stream).toEqual({ source: 'client', level: 'error', host: 'web' });
  });

  it('IGNORES an accountId sent in the body — that field is the server\'s to write', async () => {
    // The one field that says whose session this was must not be the one field anybody can
    // set, or it says nothing at all.
    const h = await start();
    await post(h.base, batch({ accountId: 'somebody-else', acct: 'somebody-else' }));
    await vi.waitFor(() => expect(h.pushes).toHaveLength(1));
    expect(JSON.stringify(h.pushes[0])).not.toContain('somebody-else');
  });

  it('attaches the account resolved from the BEARER TOKEN when there is one', async () => {
    const h = await start();
    const reg = await fetch(`${h.base}/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'logger1', password: 'correct-horse-1' }),
    });
    const { token, accountId } = (await reg.json()) as { token: string; accountId: string };
    await post(h.base, batch(), { authorization: `Bearer ${token}` });
    await vi.waitFor(() => expect(h.pushes).toHaveLength(1));
    const line = (h.pushes[0] as { streams: Array<{ values: Array<[string, string]> }> }).streams[0]!.values[0]![1];
    expect(line).toContain(`acct=${accountId}`);
  });

  it('accepts a GUEST batch — the errors worth having happen instead of a login', async () => {
    const h = await start();
    await post(h.base, batch(), { authorization: 'Bearer not-a-real-token' });
    await vi.waitFor(() => expect(h.pushes).toHaveLength(1));
    const line = (h.pushes[0] as { streams: Array<{ values: Array<[string, string]> }> }).streams[0]!.values[0]![1];
    expect(line).not.toContain('acct=');
  });
});

describe('the body limit', () => {
  it('refuses a body past the cap instead of half-reading it', async () => {
    // The overflow tail is dropped, so what reaches JSON.parse is truncated and throws —
    // the caller sees "nothing usable", never a partially-parsed object.
    const h = await start();
    const huge = batch({
      entries: Array.from({ length: 400 }, (_, i) => ({ t: NOW, level: 'error', msg: 'y'.repeat(2000) + i })),
    });
    expect(JSON.stringify(huge).length).toBeGreaterThan(CLIENT_LOG_BODY_LIMIT);
    expect(await (await post(h.base, huge)).json()).toEqual({ ok: true, accepted: 0 });
  });

  it('accepts a full legitimate batch — the cap is above what a real client sends', async () => {
    // The other half, and the one that would otherwise be missed: a limit that also refuses
    // valid traffic is a limit that silently loses every crash report on a busy session.
    const h = await start();
    const full = batch({
      entries: Array.from({ length: 200 }, (_, i) => ({ t: NOW, level: 'warn', msg: `line ${i}`, tag: 'net' })),
    });
    expect(await (await post(h.base, full)).json()).toEqual({ ok: true, accepted: 200 });
  });
});

describe('the rate limit', () => {
  it('stops accepting past the budget, and resumes in the next window', async () => {
    const limiter = new RateLimiter(3, 1000);
    expect([limiter.take('ip', 0), limiter.take('ip', 0), limiter.take('ip', 0)]).toEqual([true, true, true]);
    expect(limiter.take('ip', 0)).toBe(false);
    expect(limiter.take('ip', 999)).toBe(false);
    expect(limiter.take('ip', 1000)).toBe(true);
  });

  it('budgets per key, so one noisy client cannot silence everybody else', async () => {
    const limiter = new RateLimiter(1, 1000);
    expect(limiter.take('a', 0)).toBe(true);
    expect(limiter.take('a', 0)).toBe(false);
    expect(limiter.take('b', 0)).toBe(true);
  });

  it('actually bites over HTTP, and answers 200 with accepted:0 when it does', async () => {
    const h = await start();
    for (let i = 0; i < RATE_LIMIT.requests; i += 1) await post(h.base, batch());
    expect(await (await post(h.base, batch())).json()).toEqual({ ok: true, accepted: 0 });
    // ...and nothing was shipped for the refused one.
    expect(h.fetchCalls).toBe(RATE_LIMIT.requests);
  });

  it('does not leak the limiter between servers', async () => {
    // A module-level limiter would make one test's traffic change the next test's answer.
    const a = await start();
    for (let i = 0; i < RATE_LIMIT.requests + 2; i += 1) await post(a.base, batch());
    const b = await start();
    expect(await (await post(b.base, batch())).json()).toEqual({ ok: true, accepted: 1 });
  });
});

describe('clientKey — which hop the limit is keyed on', () => {
  const req = (headers: Record<string, string | string[]>, remote = '10.0.0.1'): IncomingMessage =>
    ({ headers, socket: { remoteAddress: remote } }) as unknown as IncomingMessage;

  it('takes the LAST forwarded hop, the one the proxy added itself', () => {
    // Taking the first is the classic mistake: the earlier entries are attacker-supplied,
    // so a per-IP limit keyed on them is evaded by sending a different fake first hop.
    expect(clientKey(req({ 'x-forwarded-for': '1.1.1.1, 2.2.2.2, 203.0.113.9' }))).toBe('203.0.113.9');
  });

  it('handles a header sent as a repeated field, not just a comma list', () => {
    expect(clientKey(req({ 'x-forwarded-for': ['1.1.1.1', '203.0.113.9'] }))).toBe('203.0.113.9');
  });

  it('falls back to the socket for a direct request', () => {
    expect(clientKey(req({}))).toBe('10.0.0.1');
  });

  it('falls back to a CONSTANT when there is no address at all — stricter, not looser', () => {
    expect(clientKey({ headers: {}, socket: {} } as unknown as IncomingMessage)).toBe('unknown');
  });

  it('ignores an empty or whitespace-only header rather than keying on ""', () => {
    expect(clientKey(req({ 'x-forwarded-for': '  ,  ' }))).toBe('10.0.0.1');
  });
});
