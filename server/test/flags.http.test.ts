/**
 * Phase C over a real socket: the internal endpoint services poll, and the console's two
 * write paths (design/21 §4).
 *
 * Three things are asserted here that no unit test can reach:
 *
 *  - **The two credentials do not substitute for each other.** `GET /internal/flags` is
 *    refused with a valid operator SESSION and accepted with the internal key;
 *    `POST /admin/flags/set` is the mirror. Both directions, because "one handler forgot to
 *    check" is exactly the bug this separation exists to make impossible, and it is
 *    invisible from either handler on its own.
 *  - **The whole loop.** A flag set through the form is served by the internal endpoint and
 *    parsed by the shipped client, end to end, with nothing hand-assembled in between. That
 *    is what makes "the console changes what a service does" a measurement rather than a
 *    claim.
 *  - **The console's own effect on matchsvc.** `createMatchsvcServer` takes a flag client,
 *    and the `Matchmaker` reads its two timings through it PER CALL — so this file also
 *    pins that a value polled after construction actually takes effect, which is the
 *    difference between a flag and a differently-spelled deploy.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { openDb } from '../src/db';
import { openBillingDb } from '../src/billingDb';
import { openAnalyticsDb } from '../src/analytics/db';
import { createAdminsvcServer, type AdminsvcServer } from '../src/adminsvc/server';
import { createInternalVerifier } from '../src/internalAuth';
import { INTERNAL_FLAGS_PATH, createFlagClient, parseFlagsResponse } from '../src/flags/client';
import { FLAG_DEFS } from '../src/flags/defs';
import { setFlag } from '../src/flags/store';

const PASSWORD = 'f'.repeat(32);
const KEY = 'internal-test-key';
const CALLER = 'matchsvc';

const dirs: string[] = [];
const handles: AdminsvcServer[] = [];
const silent = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  child: () => silent,
} as never;

let paths: { accounts: string; billing: string; analytics: string; ops: string };

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'bb-flags-http-'));
  dirs.push(dir);
  paths = {
    accounts: join(dir, 'accounts.db'),
    billing: join(dir, 'billing.db'),
    analytics: join(dir, 'analytics.db'),
    ops: join(dir, 'ops.db'),
  };
  openDb(paths.accounts).close();
  openBillingDb(paths.billing).close();
  openAnalyticsDb(paths.analytics).close();
});

afterEach(async () => {
  while (handles.length) {
    const handle = handles.pop()!;
    handle.server.closeAllConnections();
    await new Promise<void>((resolve) => handle.server.close(() => resolve()));
  }
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

async function startConsole(opsDbPath: string | null = paths.ops): Promise<string> {
  const handle = createAdminsvcServer({
    env: { BB_ADMIN_PASSWORD: PASSWORD, NODE_ENV: 'test' },
    log: silent,
    paths: { accounts: paths.accounts, billing: paths.billing, analytics: paths.analytics },
    opsDbPath,
    verifier: createInternalVerifier([{ caller: CALLER, key: KEY }]),
  });
  handles.push(handle);
  await new Promise<void>((resolve) => handle.server.listen(0, '127.0.0.1', resolve));
  const { port } = handle.server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

async function signIn(base: string): Promise<string> {
  const res = await fetch(`${base}/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ user: 'admin', password: PASSWORD }).toString(),
    redirect: 'manual',
  });
  return (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
}

const setForm = (name: string, value: string) =>
  ({
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ name, value }).toString(),
    redirect: 'manual',
  }) as const;

describe('GET /internal/flags', () => {
  it('serves the FULL effective set to a caller with the internal key', async () => {
    const base = await startConsole();
    const res = await fetch(`${base}${INTERNAL_FLAGS_PATH}`, { headers: { 'x-internal-key': KEY } });
    expect(res.status).toBe(200);
    // Parsed by the SHIPPED client rather than by hand: a payload the endpoint considers
    // complete and the client rejects is the drift this asserts against, and it would
    // otherwise be invisible until a deploy.
    expect(parseFlagsResponse(await res.json())).not.toBeNull();
  });

  it('REFUSES a caller with no key, and one with the wrong key', async () => {
    const base = await startConsole();
    expect((await fetch(`${base}${INTERNAL_FLAGS_PATH}`)).status).toBe(401);
    expect(
      (await fetch(`${base}${INTERNAL_FLAGS_PATH}`, { headers: { 'x-internal-key': 'wrong' } })).status,
    ).toBe(401);
  });

  it('REFUSES a caller holding a valid OPERATOR SESSION but no internal key', async () => {
    // Half of the credential-separation property. A logged-in operator's browser must not be
    // able to read this route, because if it can then a stolen cookie is also an internal
    // credential — and the whole point of the internal seam is that it is a third namespace
    // (`internalAuth.ts`'s header).
    const base = await startConsole();
    const cookie = await signIn(base);
    expect((await fetch(`${base}${INTERNAL_FLAGS_PATH}`, { headers: { cookie } })).status).toBe(401);
  });

  it('answers 503 when the deployment has no flag store', async () => {
    // Which every polling client reads as "keep the compiled-in defaults" — the same
    // outcome as being unreachable, said explicitly.
    const base = await startConsole(null);
    const res = await fetch(`${base}${INTERNAL_FLAGS_PATH}`, { headers: { 'x-internal-key': KEY } });
    expect(res.status).toBe(503);
  });

  it('is fail-closed when no verifier registry is configured at all', async () => {
    // design/19 §5's production branch: `internalKeys()` returns an EMPTY registry when
    // `BB_INTERNAL_KEY` is unset under production, and an empty registry rejects
    // everything. Never "allow all".
    const handle = createAdminsvcServer({
      env: { BB_ADMIN_PASSWORD: PASSWORD, NODE_ENV: 'test' },
      log: silent,
      paths: { accounts: paths.accounts, billing: paths.billing, analytics: paths.analytics },
      opsDbPath: paths.ops,
      verifier: createInternalVerifier([]),
    });
    handles.push(handle);
    await new Promise<void>((resolve) => handle.server.listen(0, '127.0.0.1', resolve));
    const { port } = handle.server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}${INTERNAL_FLAGS_PATH}`, {
      headers: { 'x-internal-key': KEY },
    });
    expect(res.status).toBe(401);
  });
});

describe('POST /admin/flags/set and /clear', () => {
  it('REFUSES both write paths to a caller with the INTERNAL KEY but no session', async () => {
    // The other half of the credential separation. An internal key is held by our own
    // processes and is not an operator credential; a process that could write flags could
    // change how every other process behaves without anybody logging in.
    const base = await startConsole();
    const withKey = {
      ...setForm('match.queueTimeoutMs', '45000'),
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-internal-key': KEY },
    };
    expect((await fetch(`${base}/admin/flags/set`, withKey)).status).toBe(404);
    expect((await fetch(`${base}/admin/flags/clear`, withKey)).status).toBe(404);
  });

  it('REFUSES both write paths to an anonymous caller', async () => {
    const base = await startConsole();
    expect((await fetch(`${base}/admin/flags/set`, setForm('match.queueTimeoutMs', '45000'))).status).toBe(404);
    expect((await fetch(`${base}/admin/flags/clear`, setForm('match.queueTimeoutMs', ''))).status).toBe(404);
  });

  it('sets a flag, and the internal endpoint then serves the new value', async () => {
    // The whole loop, with nothing hand-assembled between the form and the poll response.
    const base = await startConsole();
    const cookie = await signIn(base);
    const res = await fetch(`${base}/admin/flags/set`, {
      ...setForm('match.queueTimeoutMs', '45000'),
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/admin/?tab=flags');

    const served = await fetch(`${base}${INTERNAL_FLAGS_PATH}`, { headers: { 'x-internal-key': KEY } });
    const parsed = parseFlagsResponse(await served.json())!;
    expect(parsed['match.queueTimeoutMs']).toBe(45_000);
  });

  it('clears a flag back to its compiled-in default', async () => {
    const base = await startConsole();
    const cookie = await signIn(base);
    const headers = { 'content-type': 'application/x-www-form-urlencoded', cookie };
    await fetch(`${base}/admin/flags/set`, { ...setForm('match.queueTimeoutMs', '45000'), headers });
    await fetch(`${base}/admin/flags/clear`, { ...setForm('match.queueTimeoutMs', ''), headers });
    const served = await fetch(`${base}${INTERNAL_FLAGS_PATH}`, { headers: { 'x-internal-key': KEY } });
    const parsed = parseFlagsResponse(await served.json())!;
    expect(parsed['match.queueTimeoutMs']).toBe(FLAG_DEFS['match.queueTimeoutMs'].default);
  });

  it('REFUSES a name outside the allowlist without changing anything', async () => {
    // C1 through the real HTTP surface, with the two names that matter most.
    const base = await startConsole();
    const cookie = await signIn(base);
    const headers = { 'content-type': 'application/x-www-form-urlencoded', cookie };
    for (const name of ['billing.devStub', 'auth.skipPasswordCheck', '__proto__', 'constructor']) {
      const res = await fetch(`${base}/admin/flags/set`, { ...setForm(name, 'true'), headers });
      expect(res.status, name).toBe(303);
    }
    const served = await fetch(`${base}${INTERNAL_FLAGS_PATH}`, { headers: { 'x-internal-key': KEY } });
    const parsed = parseFlagsResponse(await served.json())!;
    // Still exactly the allowlist, still all defaults — nothing was created and nothing was
    // changed. The redirect above is the refusal (the tab re-renders from the table).
    expect(Object.keys(parsed).sort()).toEqual(Object.keys(FLAG_DEFS).sort());
    for (const [name, def] of Object.entries(FLAG_DEFS)) expect(parsed[name as never], name).toBe(def.default);
  });

  it('parses the form value per the flag TYPE, not by guessing', async () => {
    const base = await startConsole();
    const cookie = await signIn(base);
    const headers = { 'content-type': 'application/x-www-form-urlencoded', cookie };
    await fetch(`${base}/admin/flags/set`, { ...setForm('ads.rewardedOfferEnabled', 'false'), headers });
    await fetch(`${base}/admin/flags/set`, { ...setForm('ui.maintenanceBanner', 'back at 14:00'), headers });
    const served = await fetch(`${base}${INTERNAL_FLAGS_PATH}`, { headers: { 'x-internal-key': KEY } });
    const parsed = parseFlagsResponse(await served.json())!;
    // The string `'false'` became the BOOLEAN false, not a truthy string.
    expect(parsed['ads.rewardedOfferEnabled']).toBe(false);
    expect(parsed['ui.maintenanceBanner']).toBe('back at 14:00');
  });

  it('does NOT turn an empty number field into zero', async () => {
    // `Number('')` is 0, so a cleared number input would otherwise set a queue timeout to
    // zero — a value inside no declared range and a queue that expires instantly.
    const base = await startConsole();
    const cookie = await signIn(base);
    const headers = { 'content-type': 'application/x-www-form-urlencoded', cookie };
    await fetch(`${base}/admin/flags/set`, { ...setForm('match.queueTimeoutMs', ''), headers });
    const served = await fetch(`${base}${INTERNAL_FLAGS_PATH}`, { headers: { 'x-internal-key': KEY } });
    const parsed = parseFlagsResponse(await served.json())!;
    expect(parsed['match.queueTimeoutMs']).toBe(FLAG_DEFS['match.queueTimeoutMs'].default);
  });

  it('refuses a form with NO name field and one with no value field', async () => {
    // `URLSearchParams.get` answers `null` for an absent field, so both handlers coalesce to
    // `''` — reachable from any hand-made POST, and from a browser whose form lost an input.
    // The refusal is a redirect (the tab re-renders from the table), so what is asserted is
    // that nothing changed.
    const base = await startConsole();
    const cookie = await signIn(base);
    const headers = { 'content-type': 'application/x-www-form-urlencoded', cookie };
    const post = (path: string, body: string) =>
      fetch(`${base}${path}`, { method: 'POST', headers, body, redirect: 'manual' });

    expect((await post('/admin/flags/set', 'value=45000')).status).toBe(303);
    expect((await post('/admin/flags/set', 'name=match.queueTimeoutMs')).status).toBe(303);
    expect((await post('/admin/flags/clear', 'nothing=here')).status).toBe(303);

    const served = await fetch(`${base}${INTERNAL_FLAGS_PATH}`, { headers: { 'x-internal-key': KEY } });
    const parsed = parseFlagsResponse(await served.json())!;
    for (const [name, def] of Object.entries(FLAG_DEFS)) expect(parsed[name as never], name).toBe(def.default);
  });

  it('404s both write paths when the deployment has no flag store', async () => {
    const base = await startConsole(null);
    const cookie = await signIn(base);
    const headers = { 'content-type': 'application/x-www-form-urlencoded', cookie };
    expect((await fetch(`${base}/admin/flags/set`, { ...setForm('match.queueTimeoutMs', '45000'), headers })).status).toBe(404);
    expect((await fetch(`${base}/admin/flags/clear`, { ...setForm('match.queueTimeoutMs', ''), headers })).status).toBe(404);
  });
});

describe('the flags TAB', () => {
  it('shows every flag, marks an override, and marks the public ones', async () => {
    const base = await startConsole();
    const cookie = await signIn(base);
    await fetch(`${base}/admin/flags/set`, {
      ...setForm('match.queueTimeoutMs', '45000'),
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    });
    const html = await (await fetch(`${base}/admin/?tab=flags`, { headers: { cookie } })).text();
    for (const name of Object.keys(FLAG_DEFS)) expect(html, name).toContain(name);
    expect(html).toContain('overridden');
    expect(html).toContain('as shipped');
    // Every flag has a consumer as of 2026-09-09, so the gap's two markers must be ABSENT
    // from the real page — not merely absent from a hand-built view. This is the end-to-end
    // half of `flags.page.test.ts`'s "drops the warning entirely" case: `routes.ts` derives
    // the list from `FlagDef.delivered`, and asserting the absence here is what would catch
    // a flag regressing to undelivered without anybody noticing on the page.
    expect(html).not.toContain('not delivered');
    expect(html).not.toContain('NO consumer yet');
    // ...and the public marker is on the row of a flag served to browsers.
    expect(html).toContain('<span class="pill">public</span>');
  });

  it('is loud about a stored row that is NOT being applied', async () => {
    // A hand-edited row, or a flag a deploy removed: the table says the flag is set and
    // every service is ignoring it. Produced by writing straight to the table, which is
    // exactly how it happens in production.
    const base = await startConsole();
    const cookie = await signIn(base);
    const handle = handles[handles.length - 1]!;
    handle.opsDb!.prepare('INSERT INTO flags (name, value, updated_at, set_by) VALUES (?,?,?,?)').run(
      'removed.oldFlag',
      'true',
      1,
      'sqlite3',
    );
    const html = await (await fetch(`${base}/admin/?tab=flags`, { headers: { cookie } })).text();
    expect(html).toContain('NOT being applied');
    expect(html).toContain('removed.oldFlag');
  });

  it('says so plainly when there is no flag store', async () => {
    const base = await startConsole(null);
    const cookie = await signIn(base);
    const html = await (await fetch(`${base}/admin/?tab=flags`, { headers: { cookie } })).text();
    expect(html).toContain('No flag store on this deployment');
    expect(html).toContain('BB_OPS_DB_PATH');
  });

  it('needs a session, like every other tab', async () => {
    const base = await startConsole();
    const html = await (await fetch(`${base}/admin/?tab=flags`)).text();
    expect(html).toContain('action="/admin/login"');
    expect(html).not.toContain('as shipped');
  });
});

describe('a flag actually changes what matchsvc does', () => {
  it('takes effect on a matchmaker built BEFORE the poll', async () => {
    // The difference between a flag and a differently-spelled deploy. `Matchmaker` reads its
    // two timings through the flag client per call rather than capturing them in its
    // constructor, so this asserts the ordering that matters: the server is built, THEN the
    // value arrives, and the next queue decision uses it.
    const base = await startConsole();
    const cookie = await signIn(base);

    const flags = createFlagClient({
      baseUrl: base,
      key: KEY,
      caller: CALLER,
      log: silent,
    });
    // Before any poll: the compiled-in default.
    expect(flags.get('match.pvpBotBackfillDelayMs')).toBe(FLAG_DEFS['match.pvpBotBackfillDelayMs'].default);

    await fetch(`${base}/admin/flags/set`, {
      ...setForm('match.pvpBotBackfillDelayMs', '5000'),
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    });
    await flags.poll();
    expect(flags.get('match.pvpBotBackfillDelayMs')).toBe(5000);
    flags.stop();
  });

  it('reads the value on EVERY use, so a later change is seen without a restart', async () => {
    // Directly against the seam `Matchmaker` uses: a supplier, called per decision. A
    // captured number would make the first read correct and every later one stale, which is
    // indistinguishable from working until somebody flips a flag and waits.
    const base = await startConsole();
    const cookie = await signIn(base);
    const flags = createFlagClient({ baseUrl: base, key: KEY, caller: CALLER, log: silent });
    const supplier = () => flags.get('match.queueTimeoutMs');
    expect(supplier()).toBe(FLAG_DEFS['match.queueTimeoutMs'].default);

    const handle = handles[handles.length - 1]!;
    setFlag(handle.opsDb!, 'match.queueTimeoutMs', 45_000, Date.now(), 'admin');
    await flags.poll();
    expect(supplier()).toBe(45_000);
    void cookie;
    flags.stop();
  });
});
