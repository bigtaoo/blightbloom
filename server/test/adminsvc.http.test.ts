/**
 * The console over a real socket (design/21 §3.3, §3.4): the login flow, the cookie's
 * attributes as they actually leave the process, the rate limit, the health probe's refusal
 * of a proxied request, and the dispatch chain's 404.
 *
 * Driven through `fetch` against a bound port rather than by calling handlers, because half
 * of what is asserted here only exists as an HTTP artefact: a `Set-Cookie` attribute list, a
 * 303's `Location`, a response header block. A handler-level test can check the arguments
 * passed to `writeHead` and would pass against a server that never sent them.
 *
 * `redirect: 'manual'` everywhere. Node's fetch follows a 303 by default, which would turn
 * every login assertion into an assertion about the page that comes after it.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { openDb } from '../src/db';
import { openBillingDb } from '../src/billingDb';
import { openAnalyticsDb } from '../src/analytics/db';
import { createAdminsvcServer, type AdminsvcServer } from '../src/adminsvc/server';
import { AdminStartupError } from '../src/adminsvc/credentials';
import { ADMIN_COOKIE } from '../src/adminsvc/session';
import { LOGIN_RATE_LIMIT } from '../src/adminsvc/routes';

const PASSWORD = 'p'.repeat(32);
const ENV = { BB_ADMIN_PASSWORD: PASSWORD, NODE_ENV: 'test' } as const;

const dirs: string[] = [];
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

function scratchDatabases(): { accounts: string; billing: string; analytics: string; ops: string } {
  const dir = mkdtempSync(join(tmpdir(), 'bb-adminsvc-http-'));
  dirs.push(dir);
  const paths = {
    accounts: join(dir, 'accounts.db'),
    billing: join(dir, 'billing.db'),
    analytics: join(dir, 'analytics.db'),
    // Deliberately NOT created here. `openOpsDb` is the one writable opener in this process
    // and it creates its own file, so a case that wants a flag store passes this path and a
    // case that does not simply omits `opsDbPath`.
    ops: join(dir, 'ops.db'),
  };
  const accounts = openDb(paths.accounts);
  accounts
    .prepare('INSERT INTO accounts (id, username, password_hash, provider, created_at) VALUES (?,?,?,?,?)')
    .run('a1', 'zoe', 'hash', 'local', 1_757_000_000_000);
  accounts.close();

  const billing = openBillingDb(paths.billing);
  billing
    .prepare(
      `INSERT INTO webhook_events (id, platform, order_id, txn_id, event_type, outcome, detail, raw,
        first_seen_at, last_seen_at, seen_count, divergences) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    // The stored-XSS shape, in the column that really does hold bytes an outsider chose.
    .run('t1:done', 'paddle', 'o1', 't1', 'transaction.completed', 'settled', null, '<script>alert(1)</script>', 1, 2, 1, 0);
  billing.close();

  openAnalyticsDb(paths.analytics).close();
  return paths;
}

async function startConsole(
  opts: Parameters<typeof createAdminsvcServer>[0] = {},
): Promise<Console> {
  const handle = createAdminsvcServer({ env: { ...ENV }, log: silent, ...opts });
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

let paths: { accounts: string; billing: string; analytics: string; ops: string };

beforeEach(() => {
  paths = scratchDatabases();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  while (handles.length) {
    const handle = handles.pop()!;
    handle.server.closeAllConnections();
    // `close` fires the 'close' handler, which closes the three SQLite handles — required
    // before the rmSync below, since Windows locks an open database file.
    await new Promise<void>((resolve) => handle.server.close(() => resolve()));
  }
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('the login', () => {
  it('serves the login form, not the console, to a caller with no session', async () => {
    const { base } = await startConsole({ paths });
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
    const { base } = await startConsole({ paths });
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
    const { base } = await startConsole({
      paths,
      env: { ...ENV, BB_ADMIN_INSECURE_COOKIE: '1' },
    });
    expect((await signIn(base)).res.headers.get('set-cookie')).not.toContain('Secure');
  });

  it('refuses a wrong password and a wrong user with the SAME message and no cookie', async () => {
    // The message must not say which half was wrong: a login that distinguishes them is a
    // username oracle, and the operator name is the half an attacker can enumerate.
    const { base } = await startConsole({ paths });
    const wrongPassword = await signIn(base, 'admin', 'nope');
    const wrongUser = await signIn(base, 'root', PASSWORD);
    expect(wrongPassword.res.status).toBe(401);
    expect(wrongUser.res.status).toBe(401);
    expect(wrongPassword.res.headers.get('set-cookie')).toBeNull();
    expect(await wrongPassword.res.text()).toBe(await wrongUser.res.text());
  });

  it('refuses an empty form and a body that is not a form at all', async () => {
    const { base } = await startConsole({ paths });
    for (const body of ['', 'garbage', '{"user":"admin","password":"' + PASSWORD + '"}']) {
      const res = await fetch(`${base}/admin/login`, { method: 'POST', body, redirect: 'manual' });
      expect(res.status, body.slice(0, 20)).toBe(401);
    }
  });

  it('refuses an over-long body rather than parsing its start', async () => {
    // The reader drops the overflow tail, so what gets parsed is a truncated form. Asserted
    // because the OPPOSITE arrangement — parse the prefix, ignore the rest — would let a
    // 10 MB body through on the strength of its first 4 KB.
    const { base } = await startConsole({ paths });
    const res = await fetch(`${base}/admin/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ user: 'admin', password: PASSWORD, pad: 'z'.repeat(20_000) }).toString(),
      redirect: 'manual',
    });
    expect(res.status).toBe(401);
  });

  it('rate limits after the budget and says so, without leaking which half was wrong', async () => {
    const { base } = await startConsole({ paths });
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

  it('lets the budget recover after the window', async () => {
    // The control for the case above: without it, a limiter that refused everything forever
    // would pass. The clock is injected rather than waited on.
    let now = 1_757_000_000_000;
    const { base } = await startConsole({ paths, now: () => now });
    for (let i = 0; i < LOGIN_RATE_LIMIT.requests + 1; i += 1) await signIn(base, 'admin', 'wrong');
    expect((await signIn(base)).res.status).toBe(429);
    now += LOGIN_RATE_LIMIT.windowMs;
    expect((await signIn(base)).res.status).toBe(303);
  });
});

describe('the console, signed in', () => {
  it('renders the players tab by default, and the account row', async () => {
    const { base } = await startConsole({ paths });
    const { cookie } = await signIn(base);
    const html = await (await fetch(`${base}/admin/`, { headers: { cookie } })).text();
    expect(html).toContain('zoe');
    expect(html).toContain('Sign out');
    expect(html).toContain('cannot write player data');
  });

  it('searches, and takes the term from the query string', async () => {
    const { base } = await startConsole({ paths });
    const { cookie } = await signIn(base);
    expect(await (await fetch(`${base}/admin/?q=zoe`, { headers: { cookie } })).text()).toContain('zoe');
    const miss = await (await fetch(`${base}/admin/?q=nobody`, { headers: { cookie } })).text();
    expect(miss).toContain('No accounts match');
    expect(miss).not.toContain('>zoe<');
  });

  it('serves the commerce tab, with the raw callback body ESCAPED', async () => {
    // The end-to-end version of the escaping rule: a `<script>` that arrived at the billing
    // plane's webhook endpoint, read out of SQLite, rendered into the operator's browser.
    // Every link in that chain is real here.
    const { base } = await startConsole({ paths });
    const { cookie } = await signIn(base);
    const html = await (await fetch(`${base}/admin/?tab=commerce`, { headers: { cookie } })).text();
    expect(html).toContain('transaction.completed');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('serves the retention tab, saying the table is empty rather than showing zeros', async () => {
    const { base } = await startConsole({ paths });
    const { cookie } = await signIn(base);
    const html = await (await fetch(`${base}/admin/?tab=retention`, { headers: { cookie } })).text();
    expect(html).toContain('0 rollup row(s)');
    expect(html).toContain('No rollup rows for any day');
  });

  it('falls back to the players tab for an unknown tab name', async () => {
    const { base } = await startConsole({ paths });
    const { cookie } = await signIn(base);
    const res = await fetch(`${base}/admin/?tab=../../etc/passwd`, { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('zoe');
  });

  it('answers /admin without the trailing slash', async () => {
    // Caddy's `handle /admin*` matches both and a person types the bare one; answering only
    // `/admin/` means a typed address bar 404s, which reads as "the console is down".
    const { base } = await startConsole({ paths });
    const { cookie } = await signIn(base);
    expect((await fetch(`${base}/admin`, { headers: { cookie } })).status).toBe(200);
  });

  it('sends no-store, nosniff, DENY and a default-src none CSP on the page', async () => {
    const { base } = await startConsole({ paths });
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
    const { base } = await startConsole({ paths });
    const { cookie } = await signIn(base);
    const out = await fetch(`${base}/admin/logout`, { method: 'POST', headers: { cookie }, redirect: 'manual' });
    expect(out.status).toBe(303);
    expect(out.headers.get('set-cookie')).toContain('Max-Age=0');
    const after = await (await fetch(`${base}/admin/`, { headers: { cookie } })).text();
    expect(after).toContain('action="/admin/login"');
    expect(after).not.toContain('zoe');
  });

  it('logs out an unauthenticated caller without complaint', async () => {
    const { base } = await startConsole({ paths });
    const res = await fetch(`${base}/admin/logout`, { method: 'POST', redirect: 'manual' });
    expect(res.status).toBe(303);
  });

  it('refuses a session past its TTL', async () => {
    let now = 1_757_000_000_000;
    const { base } = await startConsole({ paths, now: () => now, sessionTtlMs: 60_000 });
    const { cookie } = await signIn(base);
    expect(await (await fetch(`${base}/admin/`, { headers: { cookie } })).text()).toContain('zoe');
    now += 60_000;
    expect(await (await fetch(`${base}/admin/`, { headers: { cookie } })).text()).toContain('action="/admin/login"');
  });

  it('refuses a forged cookie of the right SHAPE', async () => {
    // The shape check in `readCookie` only decides what reaches the session map as a key.
    // The map is what refuses this, and a 64-hex string is exactly what an attacker would
    // try after reading `session.ts`.
    const { base } = await startConsole({ paths });
    const forged = `${ADMIN_COOKIE}=${'a'.repeat(64)}`;
    expect(await (await fetch(`${base}/admin/`, { headers: { cookie: forged } })).text()).toContain(
      'action="/admin/login"',
    );
  });
});

describe('the per-section unavailable states', () => {
  it('reports the missing database per tab, and keeps the tabs that work', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bb-adminsvc-http-none-'));
    dirs.push(dir);
    const { base } = await startConsole({
      paths: { accounts: paths.accounts, billing: join(dir, 'nope.db'), analytics: null },
    });
    const { cookie } = await signIn(base);

    const commerce = await (await fetch(`${base}/admin/?tab=commerce`, { headers: { cookie } })).text();
    expect(commerce).toContain('Unavailable');

    const retention = await (await fetch(`${base}/admin/?tab=retention`, { headers: { cookie } })).text();
    expect(retention).toContain('BB_ANALYTICS_DB_PATH');

    // ...while the players tab still answers, with a NOTE rather than an unavailable card:
    // the analytics handle feeds one column of it, and a deployment that collects nothing
    // must still be able to look an account up.
    const players = await (await fetch(`${base}/admin/`, { headers: { cookie } })).text();
    expect(players).toContain('zoe');
    expect(players).toContain('Last-active column is blank');
    expect(players).toContain('n/a');
  });

  it('reports the players tab unavailable when the ACCOUNTS database is missing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bb-adminsvc-http-noacct-'));
    dirs.push(dir);
    const { base } = await startConsole({
      paths: { accounts: join(dir, 'nope.db'), billing: paths.billing, analytics: paths.analytics },
    });
    const { cookie } = await signIn(base);
    const html = await (await fetch(`${base}/admin/`, { headers: { cookie } })).text();
    expect(html).toContain('Unavailable');
    // The console still came up, which is the point: a process that refused to start could
    // not be used to find out why the file is not there.
    expect(html).toContain('Sign out');
  });
});

describe('/admin/health', () => {
  it('answers a direct request with all four handle states', async () => {
    const { base } = await startConsole({ paths });
    const res = await fetch(`${base}/admin/health`);
    expect(res.status).toBe(200);
    // Four, not three: `ops` is the flag store (design/21 §4) and the only WRITABLE handle
    // this process opens. Reported beside the read-only three so one line answers both
    // halves of "what can this console see, and what can it change". False here because no
    // `opsDbPath` was given, which is a deployment with no remote switch.
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
    const { base } = await startConsole({ paths });
    const res = await fetch(`${base}/admin/health`, { headers: { 'x-forwarded-for': '203.0.113.7' } });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not found' });
  });

  it('needs no session, so a broken login cannot make the container unhealthy', async () => {
    const { base } = await startConsole({ paths });
    expect((await fetch(`${base}/admin/health`)).status).toBe(200);
  });

  it('counts live sessions', async () => {
    const { base } = await startConsole({ paths });
    await signIn(base);
    expect(((await (await fetch(`${base}/admin/health`)).json()) as { sessions: number }).sessions).toBe(1);
  });
});

describe('the dispatch chain', () => {
  it('404s every path it does not name, as HTML', async () => {
    const { base } = await startConsole({ paths });
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
    const { base } = await startConsole({ paths });
    expect((await fetch(`${base}/admin/`, { method: 'POST', redirect: 'manual' })).status).toBe(404);
    expect((await fetch(`${base}/admin/login`, { redirect: 'manual' })).status).toBe(404);
    expect((await fetch(`${base}/admin/health`, { method: 'POST' })).status).toBe(404);
  });

  it('has no OPTIONS handler, because there is no cross-origin caller to preflight', async () => {
    const { base } = await startConsole({ paths });
    expect((await fetch(`${base}/admin/`, { method: 'OPTIONS' })).status).toBe(404);
  });
});

describe('createAdminsvcServer', () => {
  it('THROWS before opening a database or binding a port when there is no credential', () => {
    // The ordering is the property: a process that came up and threw afterwards would have
    // bound a public port first. Nothing to close here, which is how it is observable.
    expect(() => createAdminsvcServer({ env: {}, log: silent })).toThrow(AdminStartupError);
  });

  it('falls back to process.env and its own logger when neither is passed', async () => {
    // The defaults `main` relies on. Every other case in this file injects both, so without
    // this one `opts.env ?? process.env` and `opts.log ?? createLogger('adminsvc')` are two
    // branches that only the real process takes — and a wrong default there is a console
    // that reads the wrong database or logs under the wrong tag, neither of which any test
    // would see.
    vi.stubEnv('BB_ADMIN_PASSWORD', PASSWORD);
    vi.stubEnv('BB_DB_PATH', paths.accounts);
    vi.stubEnv('BB_BILLING_DB_PATH', paths.billing);
    vi.stubEnv('BB_ANALYTICS_DB_PATH', paths.analytics);
    vi.stubEnv('BB_OPS_DB_PATH', paths.ops);
    const handle = createAdminsvcServer();
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
    const { base } = await startConsole({ paths, log });
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
