/**
 * `POST /auth/register`'s per-IP budget (design/16-accounts.md, 2026-09-17) — over real
 * HTTP, plus the one thing real HTTP cannot show.
 *
 * Why this route and not the others: register was the only one in this server that was both
 * UNBOUNDED and EXPENSIVE. Every call mints a row and pays a full scrypt hash for it, and
 * nothing — not this process, not Caddy — capped how many a single caller could ask for.
 * `/auth/login` was never in the same position: it already refuses after five failures per
 * username, and a login against a name that does not exist never reaches the hash at all.
 *
 * The shipped budget ({@link REGISTER_RATE_LIMIT}) is thirty in ten minutes, which no test
 * can exhaust at a sane runtime — so the server here is built with `authLimiter` injected,
 * the same reason `matchmaker` timings are injectable. What that injection must not be
 * allowed to hide is that the SHIPPED constant is the one the real server uses, so the last
 * case asserts the default wiring directly.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createMatchsvcServer } from '../src/matchsvc';
import { RateLimiter } from '../src/rateLimit';
import { postRegister, REGISTER_RATE_LIMIT, type RegisterRouteDeps } from '../src/routes/auth';
import { CLIENT_LOG_PATH } from '../src/routes/telemetry';
import { freshAccounts } from './mongoHarness';

let baseUrl: string;
let close: () => Promise<void>;
let now = 1_000_000;

beforeAll(async () => {
  const server = createMatchsvcServer({
    store: await freshAccounts(),
    secret: 'test-secret',
    // Two per five minutes: small enough to exhaust in a test, and driven by this file's own
    // clock so the window can elapse without anything sleeping.
    authLimiter: new RateLimiter(2, 5 * 60_000),
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
  close = () => new Promise<void>((resolve) => server.close(() => resolve()));
});

afterAll(async () => {
  await close();
});

/** Each case picks its own `from` address, because the budget is per address and the cases
 *  would otherwise spend each other's. `clientKey` reads the LAST x-forwarded-for hop. */
async function register(username: string, from: string) {
  const res = await fetch(`${baseUrl}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': from },
    body: JSON.stringify({ username, password: 'hunter22' }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function login(username: string) {
  const res = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: 'hunter22' }),
  });
  return res.status;
}

describe('POST /auth/register — the per-IP budget', () => {
  it('serves the budget, then refuses with 429', async () => {
    expect((await register('limit1a', '203.0.113.1')).status).toBe(200);
    expect((await register('limit1b', '203.0.113.1')).status).toBe(200);
    const refused = await register('limit1c', '203.0.113.1');
    expect(refused.status).toBe(429);
    expect(refused.body).toMatchObject({ error: expect.stringMatching(/too many/i) });
  });

  it('a refused request creates no account', async () => {
    // The whole point of spending the budget before the body is read: the refused call must
    // not reach `AuthService` at all. A 429 that had already inserted the row would leave the
    // limit bounding the RESPONSE and not the work.
    expect(await login('limit1c')).toBe(401);
  });

  it('is per address — another caller has their own budget', async () => {
    // Without this, a single-counter limiter would read as working while it was actually
    // rationing the whole internet between them.
    expect((await register('limit2a', '203.0.113.2')).status).toBe(200);
    expect((await register('limit2b', '203.0.113.2')).status).toBe(200);
    expect((await register('limit2c', '198.51.100.7')).status).toBe(200);
  });

  it('takes the LAST forwarded hop, so a caller cannot mint budget by claiming to be someone else', async () => {
    // `clientKey`'s rule: earlier entries are attacker-supplied, the last one is what our own
    // proxy appended. A limiter keyed off the first hop is trivially evadable, which is the
    // failure this case exists to exclude.
    expect((await register('limit3a', 'fake-a, 203.0.113.3')).status).toBe(200);
    expect((await register('limit3b', 'fake-b, 203.0.113.3')).status).toBe(200);
    expect((await register('limit3c', 'fake-c, 203.0.113.3')).status).toBe(429);
  });
});

describe('POST /auth/register — the budget is its own', () => {
  it('does not spend the telemetry route\'s budget', async () => {
    // Two limiters, on purpose (`RegisterRouteDeps.authLimiter`). One shared counter would
    // make a chatty client's log batches able to block its own registration, and this file's
    // deliberately tiny auth budget would take `/client/log` down with it.
    await register('limit4a', '203.0.113.4');
    await register('limit4b', '203.0.113.4');
    expect((await register('limit4c', '203.0.113.4')).status).toBe(429);
    const log = await fetch(`${baseUrl}${CLIENT_LOG_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.4' },
      body: JSON.stringify({ lines: [] }),
    });
    expect(log.status).toBeLessThan(400);
  });
});

/**
 * The ordering real HTTP cannot show: `fetch` always finishes sending its body, so a handler
 * that read the body first and limited afterwards would answer 429 over the wire exactly the
 * same way. Driving the handler with a request whose body NEVER ends is what distinguishes
 * them — and the ordering is the control, not decoration: a flood's next request arrives
 * while this one is parked on its body, so a limiter taken afterwards is one the flood has
 * already walked past.
 */
describe('postRegister — the budget is spent before the body is read', () => {
  it('answers a stalled request without waiting for its body', async () => {
    const sent: { status?: number } = {};
    const res = {
      writeHead(status: number) {
        sent.status = status;
        return this;
      },
      end() {},
    } as unknown as ServerResponse;
    const req = Object.assign(new EventEmitter(), {
      headers: { 'x-forwarded-for': '203.0.113.9' },
      method: 'POST',
    }) as unknown as IncomingMessage;

    // One request per window, already spent by an earlier caller from the same address.
    // (`new RateLimiter(0, …)` would NOT do: its first `take` in a window returns true
    // whatever the limit is, which is worth knowing here and is nothing this route relies on.)
    const limiter = new RateLimiter(1, 60_000);
    expect(limiter.take('203.0.113.9', Date.now())).toBe(true);
    const deps = {
      auth: {
        register: () => {
          throw new Error('must not be reached');
        },
      },
      authLimiter: limiter,
    } as unknown as RegisterRouteDeps;

    // No 'data'/'end' is ever emitted on `req`. If the handler awaited the body first this
    // promise would never settle and the case would time out.
    await postRegister(req, res, new URL('http://match.test/auth/register'), deps);
    expect(sent.status).toBe(429);
  });

  it('the window elapsing lets the same caller through again', async () => {
    const limiter = new RateLimiter(1, 60_000);
    const deps = {
      auth: { register: () => Promise.resolve({ accountId: 'a', username: 'u', token: 't' }) },
      authLimiter: limiter,
      nowMs: () => now,
    } as unknown as RegisterRouteDeps;
    const call = async () => {
      const sent: { status?: number } = {};
      const res = {
        writeHead(status: number) {
          sent.status = status;
          return this;
        },
        end() {},
      } as unknown as ServerResponse;
      const req = Object.assign(new EventEmitter(), {
        headers: { 'x-forwarded-for': '203.0.113.10' },
        method: 'POST',
      }) as unknown as IncomingMessage;
      const done = postRegister(req, res, new URL('http://match.test/auth/register'), deps);
      req.emit('data', Buffer.from('{"username":"whoever","password":"hunter22"}'));
      req.emit('end');
      await done;
      return sent.status;
    };
    expect(await call()).toBe(200);
    expect(await call()).toBe(429);
    now += 60_001;
    expect(await call()).toBe(200);
  });
});

describe('REGISTER_RATE_LIMIT — the shipped budget', () => {
  it('is far above any human and far below a flood', () => {
    // A number, pinned, because every case above runs against an injected one. Thirty in ten
    // minutes: a person registers once, and a single source's hashing cost stays near a tenth
    // of a second per minute.
    expect(REGISTER_RATE_LIMIT).toEqual({ requests: 30, windowMs: 10 * 60_000 });
  });

  it('is what a server built without an override uses', async () => {
    // The injection above must not be the only thing this route has ever been wired to. A
    // default server serves well past this file's tiny budget from one address, which is only
    // true if it built its own limiter from the constant.
    const server = createMatchsvcServer({ store: await freshAccounts(), secret: 'test-secret' });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    try {
      for (let i = 0; i < 5; i++) {
        const res = await fetch(`http://127.0.0.1:${port}/auth/register`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.11' },
          body: JSON.stringify({ username: `default${i}`, password: 'hunter22' }),
        });
        expect(res.status).toBe(200);
        await res.json();
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
