/**
 * The console over a real socket (design/21 §3.3, §3.4): the login flow, the cookie's
 * attributes as they actually leave the process, the rate limit, the health probe's refusal
 * of a proxied request, the dispatch chain's 404, and — since the MongoDB port — the error
 * boundary that keeps a cluster failure from killing the process.
 *
 * Driven through `fetch` against a bound port rather than by calling handlers, because half
 * of what is asserted here only exists as an HTTP artefact: a `Set-Cookie` attribute list, a
 * 303's `Location`, a response header block. A handler-level test can check the arguments
 * passed to `writeHead` and would pass against a server that never sent them.
 *
 * `redirect: 'manual'` everywhere. Node's fetch follows a 303 by default, which would turn
 * every login assertion into an assertion about the page that comes after it.
 *
 * ## Every console here runs with BB_ADMIN_ALLOW_WRITABLE, and that is not a shortcut
 *
 * The suite's mongod has no roles, so the boot-time write probe finds every database
 * writable and `createAdminsvcServer` would refuse to start. The hatch is what this file
 * needs to be about the CONSOLE rather than about the probe — and the probe is not left
 * unproven by that: `adminsvc.dbs.test.ts` covers both of its arms, including that the
 * refusal is the default and that this variable is the only thing that lifts it.
 */
import { describe, it, expect, afterEach, beforeEach, inject, vi } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { accountsStore, ensureAccountsIndexes } from '../src/db';
import { IntegrityStore } from '../src/integrity';
import { billingStore, ensureBillingIndexes } from '../src/billingDb';
import { ensureAnalyticsIndexes } from '../src/analytics/db';
import {
  ALLOW_WRITABLE_VAR,
  createAdminsvcServer,
  reportRequestFailure,
  type AdminsvcServer,
} from '../src/adminsvc/server';
import type { AdminDbName } from '../src/adminsvc/dbs';
import { AdminStartupError } from '../src/adminsvc/credentials';
import { ADMIN_COOKIE } from '../src/adminsvc/session';
import { LOGIN_RATE_LIMIT } from '../src/adminsvc/routes';
import { closeMongo } from '../src/mongo';
import { openTestMongo, type MongoTestContext } from './mongoHarness';

const PASSWORD = 'p'.repeat(32);
const ENV = { BB_ADMIN_PASSWORD: PASSWORD, NODE_ENV: 'test', [ALLOW_WRITABLE_VAR]: '1' } as const;

const handles: AdminsvcServer[] = [];
type TestLogger = Parameters<typeof createAdminsvcServer>[0] extends { log?: infer L } ? L : never;

/** A logger that swallows everything, so a rate-limit or rejected-login case does not print
 *  a WARN per assertion. `sink` is overridden per test where a line is what is asserted. */
function testLogger(over: Partial<Record<'error' | 'warn' | 'info' | 'debug', unknown>> = {}): TestLogger {
  const base = {
    error: () => {},
    warn: () => {},
    info: () => {},
    debug: () => {},
    child: () => base,
    ...over,
  };
  return base as TestLogger;
}

const silent = testLogger();

interface Console {
  base: string;
  handle: AdminsvcServer;
}

let ctx: MongoTestContext;

/**
 * The four stores this context owns, with their indexes installed and one document in each
 * of the two the page renders.
 *
 * `open` is what `createAdminsvcServer` is handed instead of the process-wide client, so
 * every console in this file reads databases nobody else can compute the name of.
 */
async function seedStores(): Promise<void> {
  const accounts = ctx.db('accounts');
  await ensureAccountsIndexes(accounts);
  await accounts.collection('accounts').insertOne({
    _id: 'a1',
    username: 'zoe',
    passwordHash: 'hash',
    provider: 'local',
    createdAt: 1_757_000_000_000,
  } as never);

  const billing = ctx.db('billing');
  await ensureBillingIndexes(billing);
  await billingStore(billing).webhookEvents.insertOne({
    _id: 't1:done',
    platform: 'paddle',
    orderId: 'o1',
    txnId: 't1',
    eventType: 'transaction.completed',
    outcome: 'settled',
    detail: null,
    // The stored-XSS shape, in the one field that really does hold bytes an outsider chose.
    raw: '<script>alert(1)</script>',
    firstSeenAt: 1,
    lastSeenAt: 2,
    seenCount: 1,
    divergences: 0,
  });

  await ensureAnalyticsIndexes(ctx.db('analytics'));
}

const openHere = (name: AdminDbName) => ctx.db(name);

async function startConsole(opts: Parameters<typeof createAdminsvcServer>[0] = {}): Promise<Console> {
  const handle = await createAdminsvcServer({
    env: { ...ENV },
    log: silent,
    dbs: { analyticsEnabled: true, open: openHere },
    ...opts,
  });
  handles.push(handle);
  await new Promise<void>((resolve) => handle.server.listen(0, '127.0.0.1', resolve));
  const { port } = handle.server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, handle };
}

/** Logs in and returns the `Cookie` header value a browser would then send. */
async function signIn(base: string, user = 'admin', password = PASSWORD): Promise<{ res: Response; cookie: string }> {
  const res = await fetch(`${base}/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ user, password }).toString(),
    redirect: 'manual',
  });
  const setCookie = res.headers.get('set-cookie') ?? '';
  return { res, cookie: setCookie.split(';')[0] ?? '' };
}

beforeEach(async () => {
  ctx = await openTestMongo();
  await seedStores();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  while (handles.length) {
    const handle = handles.pop()!;
    handle.server.closeAllConnections();
    await new Promise<void>((resolve) => handle.server.close(() => resolve()));
  }
  await ctx.dispose();
  // One case builds a console through the process-wide client; nothing may inherit it.
  await closeMongo();
});

describe('the login', () => {
  it('serves the login form, not the console, to a caller with no session', async () => {
    const { base } = await startConsole();
    const res = await fetch(`${base}/admin/`);
    const html = await res.text();
    // A 200, deliberately: a 401 makes some browsers show their own basic-auth prompt, and
    // a redirect to a login URL is one more path to get the auth check right on.
    expect(res.status).toBe(200);
    expect(html).toContain('action="/admin/login"');
    // The thing that must NOT be there. Every section is behind this check, so the negative
    // is the assertion that matters.
    expect(html).not.toContain('zoe');
    expect(html).not.toContain('Sign out');
  });

  it('accepts the right credential, sets the cookie, and redirects with 303', async () => {
    const { base } = await startConsole();
    const { res } = await signIn(base);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/admin/');
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(new RegExp(`^${ADMIN_COOKIE}=[0-9a-f]{64};`));
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('Path=/admin');
  });

  it('drops Secure ONLY for the dev flag below production', async () => {
    const { base } = await startConsole({ env: { ...ENV, BB_ADMIN_INSECURE_COOKIE: '1' } });
    expect((await signIn(base)).res.headers.get('set-cookie')).not.toContain('Secure');
  });

  it('refuses a wrong password and a wrong user with the SAME message and no cookie', async () => {
    // The message must not say which half was wrong: a login that distinguishes them is a
    // username oracle, and the operator name is the half an attacker can enumerate.
    const { base } = await startConsole();
    const wrongPassword = await signIn(base, 'admin', 'nope');
    const wrongUser = await signIn(base, 'root', PASSWORD);
    expect(wrongPassword.res.status).toBe(401);
    expect(wrongUser.res.status).toBe(401);
    expect(wrongPassword.res.headers.get('set-cookie')).toBeNull();
    expect(await wrongPassword.res.text()).toBe(await wrongUser.res.text());
  });

  it('refuses an empty form and a body that is not a form at all', async () => {
    const { base } = await startConsole();
    for (const body of ['', 'garbage', '{"user":"admin","password":"' + PASSWORD + '"}']) {
      const res = await fetch(`${base}/admin/login`, { method: 'POST', body, redirect: 'manual' });
      expect(res.status, body.slice(0, 20)).toBe(401);
    }
  });

  it('refuses an over-long body rather than parsing its start', async () => {
    // The reader drops the overflow tail, so what gets parsed is a truncated form. Asserted
    // because the OPPOSITE arrangement — parse the prefix, ignore the rest — would let a
    // 10 MB body through on the strength of its first 4 KB.
    const { base } = await startConsole();
    const res = await fetch(`${base}/admin/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ user: 'admin', password: PASSWORD, pad: 'z'.repeat(20_000) }).toString(),
      redirect: 'manual',
    });
    expect(res.status).toBe(401);
  });

  it('rate limits after the budget and says so, without leaking which half was wrong', async () => {
    const { base } = await startConsole();
    for (let i = 0; i < LOGIN_RATE_LIMIT.requests; i += 1) {
      expect((await signIn(base, 'admin', 'wrong')).res.status).toBe(401);
    }
    const limited = await signIn(base, 'admin', 'wrong');
    expect(limited.res.status).toBe(429);
    expect(await limited.res.text()).toContain('Too many attempts');
    // ...and the CORRECT credential is refused too while the window holds. A limiter that
    // let the real password through would be a limiter an attacker never reaches.
    expect((await signIn(base)).res.status).toBe(429);
  });

  it('spends the budget BEFORE awaiting the body', async () => {
    // Free when the read was a callback; load-bearing now that the handler awaits. A limiter
    // taken after the `await` is a limiter a flood walks around: every request parks on its
    // body, and none of them has spent anything yet when the next one arrives.
    //
    // Asserted by sending the whole budget CONCURRENTLY, which is the shape that would
    // distinguish the two orderings — with the take after the await, all of them would reach
    // the credential comparison and answer 401.
    const { base } = await startConsole();
    const flood = await Promise.all(
      Array.from({ length: LOGIN_RATE_LIMIT.requests + 5 }, () => signIn(base, 'admin', 'wrong')),
    );
    expect(flood.filter((r) => r.res.status === 429).length).toBe(5);
  });

  it('lets the budget recover after the window', async () => {
    // The control for the case above: without it, a limiter that refused everything forever
    // would pass. The clock is injected rather than waited on.
    let now = 1_757_000_000_000;
    const { base } = await startConsole({ now: () => now });
    for (let i = 0; i < LOGIN_RATE_LIMIT.requests + 1; i += 1) await signIn(base, 'admin', 'wrong');
    expect((await signIn(base)).res.status).toBe(429);
    now += LOGIN_RATE_LIMIT.windowMs;
    expect((await signIn(base)).res.status).toBe(303);
  });
});

describe('the console, signed in', () => {
  it('renders the players tab by default, and the account row', async () => {
    const { base } = await startConsole();
    const { cookie } = await signIn(base);
    const html = await (await fetch(`${base}/admin/`, { headers: { cookie } })).text();
    expect(html).toContain('zoe');
    expect(html).toContain('Sign out');
    expect(html).toContain('cannot write player data');
  });

  it('searches, and takes the term from the query string', async () => {
    const { base } = await startConsole();
    const { cookie } = await signIn(base);
    expect(await (await fetch(`${base}/admin/?q=zoe`, { headers: { cookie } })).text()).toContain('zoe');
    const miss = await (await fetch(`${base}/admin/?q=nobody`, { headers: { cookie } })).text();
    expect(miss).toContain('No accounts match');
    expect(miss).not.toContain('>zoe<');
  });

  it('serves the commerce tab, with the raw callback body ESCAPED', async () => {
    // The end-to-end version of the escaping rule: a `<script>` that arrived at the billing
    // plane's webhook endpoint, read back out of the cluster, rendered into the operator's
    // browser. Every link in that chain is real here.
    const { base } = await startConsole();
    const { cookie } = await signIn(base);
    const html = await (await fetch(`${base}/admin/?tab=commerce`, { headers: { cookie } })).text();
    expect(html).toContain('transaction.completed');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('serves the retention tab, saying the collection is empty rather than showing zeros', async () => {
    const { base } = await startConsole();
    const { cookie } = await signIn(base);
    const html = await (await fetch(`${base}/admin/?tab=retention`, { headers: { cookie } })).text();
    expect(html).toContain('0 rollup row(s)');
    expect(html).toContain('No rollup rows for any day');
  });

  it('serves the integrity tab from the accounts database', async () => {
    // design/15, 2026-09-26. Seeded through the real store so the document shape is the one
    // matchsvc writes, not a hand-rolled copy of it.
    await new IntegrityStore(accountsStore(ctx.db('accounts')), () => 1_757_000_000_000).recordOnce({
      roomId: 'room-seen',
      verdict: 'dissent',
      playerCount: 4,
      seed: 5,
      engineVersion: 75,
      settleFrame: 900,
      suspects: [{ seat: 1, accountId: 'a1', dissented: true, kicked: false }],
      absent: [],
      seatAccounts: { 1: 'a1' },
      logDropped: true,
    });
    const { base } = await startConsole();
    const { cookie } = await signIn(base);
    const html = await (await fetch(`${base}/admin/?tab=integrity`, { headers: { cookie } })).text();
    expect(html).toContain('room-seen');
    expect(html).toContain('zoe'); // the suspect resolved to its username
    expect(html).toContain('dissented');
  });

  it('falls back to the players tab for an unknown tab name', async () => {
    const { base } = await startConsole();
    const { cookie } = await signIn(base);
    const res = await fetch(`${base}/admin/?tab=../../etc/passwd`, { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('zoe');
  });

  it('answers /admin without the trailing slash', async () => {
    // Caddy's `handle /admin*` matches both and a person types the bare one; answering only
    // `/admin/` means a typed address bar 404s, which reads as "the console is down".
    const { base } = await startConsole();
    const { cookie } = await signIn(base);
    expect((await fetch(`${base}/admin`, { headers: { cookie } })).status).toBe(200);
  });

  it('sends no-store, nosniff, DENY and a default-src none CSP on the page', async () => {
    const { base } = await startConsole();
    const { cookie } = await signIn(base);
    const res = await fetch(`${base}/admin/`, { headers: { cookie } });
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    // And NO CORS header at all: the console is same-origin with its own data, so an
    // `access-control-allow-origin: *` here would let a page on another origin read every
    // account row out of it. matchsvc's shared block sends exactly that, which is why this
    // process has its own `http.ts`.
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('logs out, clearing the cookie AND revoking the session', async () => {
    // Either alone is a logout that is not one. This asserts the server-side half by
    // re-presenting the same cookie afterwards — a test that only checked `Set-Cookie`
    // would pass against a server that never revoked anything.
    const { base } = await startConsole();
    const { cookie } = await signIn(base);
    const out = await fetch(`${base}/admin/logout`, { method: 'POST', headers: { cookie }, redirect: 'manual' });
    expect(out.status).toBe(303);
    expect(out.headers.get('set-cookie')).toContain('Max-Age=0');
    const after = await (await fetch(`${base}/admin/`, { headers: { cookie } })).text();
    expect(after).toContain('action="/admin/login"');
    expect(after).not.toContain('zoe');
  });

  it('logs out an unauthenticated caller without complaint', async () => {
    const { base } = await startConsole();
    const res = await fetch(`${base}/admin/logout`, { method: 'POST', redirect: 'manual' });
    expect(res.status).toBe(303);
  });

  it('refuses a session past its TTL', async () => {
    let now = 1_757_000_000_000;
    const { base } = await startConsole({ now: () => now, sessionTtlMs: 60_000 });
    const { cookie } = await signIn(base);
    expect(await (await fetch(`${base}/admin/`, { headers: { cookie } })).text()).toContain('zoe');
    now += 60_000;
    expect(await (await fetch(`${base}/admin/`, { headers: { cookie } })).text()).toContain('action="/admin/login"');
  });

  it('refuses a forged cookie of the right SHAPE', async () => {
    // The shape check in `readCookie` only decides what reaches the session map as a key.
    // The map is what refuses this, and a 64-hex string is exactly what an attacker would
    // try after reading `session.ts`.
    const { base } = await startConsole();
    const forged = `${ADMIN_COOKIE}=${'a'.repeat(64)}`;
    expect(await (await fetch(`${base}/admin/`, { headers: { cookie: forged } })).text()).toContain(
      'action="/admin/login"',
    );
  });
});

describe('the error boundary', () => {
  /**
   * A console whose cluster goes away UNDER it, which is the failure the boundary exists for.
   *
   * The client belongs to a second context that is disposed after the console is built, so
   * every read through those handles rejects with the driver's own "client is closed". That
   * is a real rejection from the real driver on a real request — not a stub — and before the
   * boundary existed it was an unhandled rejection, which Node answers by killing the
   * process. One operator's page load would have logged every other operator out.
   */
  async function consoleOnADeadClient(): Promise<{ base: string; lines: { msg: string }[] }> {
    const doomed = await openTestMongo();
    const lines: { msg: string }[] = [];
    const log = testLogger({ error: (msg: string) => lines.push({ msg }) });
    const { base } = await startConsole({ log, dbs: { analyticsEnabled: true, open: (n) => doomed.db(n) } });
    await signIn(base); // while it still works, so the failing request is an authenticated one
    await doomed.dispose();
    return { base, lines };
  }

  it('answers 500 instead of dying when a read fails mid-request', async () => {
    const { base, lines } = await consoleOnADeadClient();
    // Signing in reads no database, so it still works — which is what makes the 500 below
    // attributable to the page's own read rather than to a console that stopped answering.
    const { cookie } = await signIn(base);
    const res = await fetch(`${base}/admin/?tab=commerce`, { headers: { cookie } });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal error' });
    expect(lines.map((l) => l.msg)).toContain('request failed');
  });

  it('is still serving afterwards — the process did not go with the request', async () => {
    // The half that matters. A 500 that was the last thing the process ever said is not a
    // boundary, it is a slightly politer crash.
    const { base } = await consoleOnADeadClient();
    const fresh = await signIn(base);
    await fetch(`${base}/admin/?tab=commerce`, { headers: { cookie: fresh.cookie } });
    expect((await fetch(`${base}/admin/health`)).status).toBe(200);
  });
});

describe('reportRequestFailure — the boundary\'s two answers', () => {
  /**
   * A real `ServerResponse` over a real socket, so `headersSent` is the server's own flag
   * rather than a property a stub set. The two arms are genuinely different answers and only
   * one of them is reachable through a route — every handler in this process builds its whole
   * body before it sends — which is why the function is exported and driven directly.
   */
  async function drive(sendFirst: boolean): Promise<{ status: number; body: string }> {
    const lines: string[] = [];
    const log = testLogger({ error: (msg: string) => lines.push(msg) });
    const server = createServer((_req, res) => {
      if (sendFirst) {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.write('<p>half a page');
      }
      reportRequestFailure(res, log, { method: 'GET', path: '/admin/' }, new Error('pool timed out'));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    let status = 0;
    let body = '';
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      status = res.status;
      body = await res.text();
    } catch {
      // A destroyed socket mid-body is a fetch error, which is the point of that arm.
      status = -1;
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    // The log line is not optional: a boundary that answered correctly and recorded nothing
    // would leave an operator with a 500 and no reason for it anywhere.
    expect(lines).toContain('request failed');
    return { status, body };
  }

  it('answers 500 when nothing has been written yet', async () => {
    const { status, body } = await drive(false);
    expect(status).toBe(500);
    expect(JSON.parse(body)).toEqual({ error: 'internal error' });
  });

  it('DESTROYS the connection when a page is already half-written', async () => {
    // A 500 cannot be sent after a 200 and half a body — the browser would render the
    // fragment and never learn it was a fragment. Destroying the socket is what makes the
    // truncation visible as a transport error instead.
    const { status } = await drive(true);
    expect(status).toBe(-1);
  });
});

describe('the per-section unavailable states', () => {
  it('reports analytics as switched off per tab, and keeps the tabs that work', async () => {
    const { base } = await startConsole({ dbs: { analyticsEnabled: false, open: openHere } });
    const { cookie } = await signIn(base);

    const retention = await (await fetch(`${base}/admin/?tab=retention`, { headers: { cookie } })).text();
    expect(retention).toContain('BB_ANALYTICS_ENABLED');

    // ...while the players tab still answers, with a NOTE rather than an unavailable card:
    // the analytics handle feeds one column of it, and a deployment that collects nothing
    // must still be able to look an account up.
    const players = await (await fetch(`${base}/admin/`, { headers: { cookie } })).text();
    expect(players).toContain('zoe');
    expect(players).toContain('Last-active column is blank');
    expect(players).toContain('n/a');

    // ...and commerce is untouched, because it never needed that handle.
    expect(await (await fetch(`${base}/admin/?tab=commerce`, { headers: { cookie } })).text()).toContain(
      'transaction.completed',
    );
  });

  it('comes up with EVERY tab unavailable when the cluster cannot be reached', async () => {
    // The state three independent missing files used to produce one at a time. There is one
    // connection now, so there is one failure and it takes all three — and the console still
    // starts, which is the point: a process that refused to boot here could not be used to
    // find out why it cannot reach the cluster.
    vi.stubEnv('BB_MONGO_URI', 'mongodb://127.0.0.1:1/?serverSelectionTimeoutMS=200&connectTimeoutMS=200');
    const { base } = await startConsole({ dbs: { analyticsEnabled: true } });
    const { cookie } = await signIn(base);
    for (const tab of ['', '?tab=commerce', '?tab=retention', '?tab=integrity']) {
      expect((await (await fetch(`${base}/admin/${tab}`, { headers: { cookie } })).text()), tab).toContain(
        'Unavailable',
      );
    }
    // Signed in, and the shell is there. The console came up.
    expect(await (await fetch(`${base}/admin/`, { headers: { cookie } })).text()).toContain('Sign out');
  });
});

describe('/admin/health', () => {
  it('answers a direct request with all four handle states', async () => {
    const { base } = await startConsole();
    const res = await fetch(`${base}/admin/health`);
    expect(res.status).toBe(200);
    // Four, not three: `ops` is the flag store (design/21 §4) and the only WRITABLE handle
    // this process opens. Reported beside the read-only three so one line answers both
    // halves of "what can this console see, and what can it change". False here because
    // `opsFlags` was not switched on, which is a deployment with no remote switch.
    expect(await res.json()).toEqual({
      ok: true,
      service: 'blightbloom-adminsvc',
      databases: { accounts: true, billing: true, analytics: true, ops: false },
      sessions: 0,
    });
  });

  it('404s a request that came through the proxy', async () => {
    // Caddy proxies `/admin*` here wholesale, so this route would otherwise be a public
    // readout of whether billing is up and how many operators are signed in. Same rule
    // matchsvc applies to `/metrics`, and a plain 404 rather than a 403 — a 403 confirms
    // the route exists.
    const { base } = await startConsole();
    const res = await fetch(`${base}/admin/health`, { headers: { 'x-forwarded-for': '203.0.113.7' } });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not found' });
  });

  it('needs no session, so a broken login cannot make the container unhealthy', async () => {
    const { base } = await startConsole();
    expect((await fetch(`${base}/admin/health`)).status).toBe(200);
  });

  it('counts live sessions', async () => {
    const { base } = await startConsole();
    await signIn(base);
    expect(((await (await fetch(`${base}/admin/health`)).json()) as { sessions: number }).sessions).toBe(1);
  });
});

describe('the dispatch chain', () => {
  it('404s every path it does not name, as HTML', async () => {
    const { base } = await startConsole();
    const { cookie } = await signIn(base);
    for (const path of ['/', '/health', '/metrics', '/admin/api/players', '/admin/../etc/passwd']) {
      const res = await fetch(`${base}${path}`, { headers: { cookie }, redirect: 'manual' });
      expect(res.status, path).toBe(404);
      expect(res.headers.get('content-type'), path).toContain('text/html');
    }
  });

  it('404s the right METHOD on the right path', async () => {
    // Five exact (method, path) pairs and then 404 — an allowlist, not a router. The reason
    // is design/21 §3.1: a route on a wholesale-proxied server is public the moment it
    // exists, and inverting that default was the whole point of a fifth process.
    const { base } = await startConsole();
    expect((await fetch(`${base}/admin/`, { method: 'POST', redirect: 'manual' })).status).toBe(404);
    expect((await fetch(`${base}/admin/login`, { redirect: 'manual' })).status).toBe(404);
    expect((await fetch(`${base}/admin/health`, { method: 'POST' })).status).toBe(404);
  });

  it('has no OPTIONS handler, because there is no cross-origin caller to preflight', async () => {
    const { base } = await startConsole();
    expect((await fetch(`${base}/admin/`, { method: 'OPTIONS' })).status).toBe(404);
  });
});

describe('createAdminsvcServer', () => {
  it('REJECTS before opening a database or binding a port when there is no credential', async () => {
    // The ordering is the property, and it is worth more since the builder became async: a
    // process that connected first and threw afterwards would have opened a cluster
    // connection on a box that has no business running this service. `opened` is what makes
    // the ordering observable rather than inferred.
    let opened = 0;
    await expect(
      createAdminsvcServer({
        env: {},
        log: silent,
        dbs: {
          open: (name) => {
            opened += 1;
            return ctx.db(name);
          },
        },
      }),
    ).rejects.toThrow(AdminStartupError);
    expect(opened).toBe(0);
  });

  it('falls back to process.env, its own logger and the process-wide client', async () => {
    // The defaults `main` relies on. Every other case in this file injects all three, so
    // without this one `opts.env ?? process.env`, `opts.log ?? createLogger('adminsvc')` and
    // the `connectMongo()` path are branches only the real process takes — and a wrong
    // default there is a console that reads the wrong DATABASE, which no other test would
    // see. The prefix is what keeps it off every other file's data.
    vi.stubEnv('BB_ADMIN_PASSWORD', PASSWORD);
    vi.stubEnv(ALLOW_WRITABLE_VAR, '1');
    vi.stubEnv('BB_MONGO_URI', inject('mongoUri'));
    vi.stubEnv('BB_MONGO_DB_PREFIX', `httpfallback${process.pid}`);
    vi.stubEnv('BB_ANALYTICS_ENABLED', '1');
    vi.stubEnv('BB_OPS_FLAGS_ENABLED', '1');
    const handle = await createAdminsvcServer();
    handles.push(handle);
    await new Promise<void>((resolve) => handle.server.listen(0, '127.0.0.1', resolve));
    const { port } = handle.server.address() as AddressInfo;
    const body = (await (await fetch(`http://127.0.0.1:${port}/admin/health`)).json()) as {
      databases: Record<string, boolean>;
    };
    expect(body.databases).toEqual({ accounts: true, billing: true, analytics: true, ops: true });
  });

  it('logs every request with the path, the status and whether a session arrived', async () => {
    // §3.3's audit line. `session` is read BEFORE the handler runs, so the pair of lines
    // around a sign-in reads correctly: the login itself arrives without one.
    const lines: { msg: string; fields?: Record<string, unknown> }[] = [];
    const log = testLogger({ info: (msg: string, fields?: Record<string, unknown>) => lines.push({ msg, fields }) });
    const { base } = await startConsole({ log });
    const { cookie } = await signIn(base);
    await fetch(`${base}/admin/?tab=commerce`, { headers: { cookie } });

    const requests = lines.filter((l) => l.msg === 'request');
    expect(requests.length).toBeGreaterThanOrEqual(2);
    const login = requests.find((l) => l.fields?.path === '/admin/login')!;
    expect(login.fields).toMatchObject({ method: 'POST', status: 303, session: false });
    // ...and NO `operator` on it, because the login arrived without a session. Stamping the
    // configured operator name on every line reads as "this person made this request", which
    // is the wrong claim for a health probe, a stray asset request or a rejected login — and
    // an audit trail is the one place that distinction has to survive.
    expect(login.fields).not.toHaveProperty('operator');
    const page = requests.find((l) => l.fields?.path === '/admin/' && l.fields?.session === true)!;
    expect(page.fields).toMatchObject({ method: 'GET', status: 200, operator: 'admin' });
    // The QUERY STRING is not in the line. A search term is a player's username, and a log
    // store is not where it belongs.
    for (const line of requests) expect(String(line.fields?.path)).not.toContain('?');
  });
});
