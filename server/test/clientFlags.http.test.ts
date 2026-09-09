/**
 * `GET /client/flags` over a real socket (design/21 §9's client delivery path).
 *
 * The route is four lines, and every property worth having is a property of the request
 * rather than of those lines — which is why this file exists at all instead of a unit test
 * over `getClientFlags`:
 *
 *  - It is reachable **unauthenticated**, from a request carrying no bearer, no cookie and
 *    no internal key. That is the whole point of the route and also the thing that has to be
 *    deliberate, so it is asserted rather than assumed.
 *  - It is reachable **through the proxy** — with `x-forwarded-for` set — which is the exact
 *    opposite of `/metrics` in the same dispatch chain. A copy-paste of `/metrics`' guard
 *    into this handler would produce a route that works from a test and 404s for every real
 *    player, and nothing else in the suite would notice.
 *  - It carries **only the public flags**. A private name in the body is a leak, and the
 *    assertion for it has to be an exact key set: every subset check — `toMatchObject`, a
 *    per-name loop — is blind to an extra field, and an extra field is the failure.
 *  - It answers from the flag client's **current** values, so a poll landing after the
 *    server was built changes the next response. Same distinction `flags.http.test.ts`
 *    draws for the matchmaker: a value read at construction is a differently-spelled deploy.
 */
import { describe, it, expect, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createMatchsvcServer } from '../src/matchsvc';
import { defaultFlags, type FlagName, type FlagValue, type FlagValues } from '../src/flags/defs';
import type { FlagClient } from '../src/flags/client';
import { PUBLIC_FLAGS_PATH, PUBLIC_FLAG_NAMES, parsePublicFlags } from '@dd/net/publicFlags';

const servers: Server[] = [];

afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

/**
 * A flag client whose values a test can change after the server holds it — the shape
 * `createMatchsvcServer` already accepts, so nothing here is a mock of the route's own
 * dependency. `all()` is the only method the route uses; the rest satisfy the interface.
 */
function mutableFlags(initial: FlagValues = defaultFlags()): FlagClient & { set(name: FlagName, v: FlagValue): void } {
  let values = { ...initial };
  return {
    get: <K extends FlagName>(name: K) => values[name],
    all: () => ({ ...values }),
    poll: async () => false,
    start: () => {},
    stop: () => {},
    healthy: () => true,
    set(name, v) {
      values = { ...values, [name]: v };
    },
  };
}

async function start(flags?: FlagClient): Promise<string> {
  const server = createMatchsvcServer({ dbPath: ':memory:', secret: 'test-secret', flags });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('GET /client/flags', () => {
  it('answers an unauthenticated request with the shipped defaults', async () => {
    const base = await start();
    const res = await fetch(`${base}${PUBLIC_FLAGS_PATH}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      flags: { 'ads.rewardedOfferEnabled': true, 'ui.maintenanceBanner': '' },
    });
  });

  it('carries the public flags and NOTHING else', async () => {
    // An EXACT key set, not a per-name presence loop. A private flag added to the response
    // would satisfy every "is this name here" assertion, and it is the one failure mode of
    // an unauthenticated route.
    const base = await start();
    const body = (await (await fetch(`${base}${PUBLIC_FLAGS_PATH}`)).json()) as { flags: Record<string, unknown> };
    expect(Object.keys(body.flags).sort()).toEqual([...PUBLIC_FLAG_NAMES].sort());
    expect(body.flags).not.toHaveProperty('match.queueTimeoutMs');
    expect(body.flags).not.toHaveProperty('match.pvpBotBackfillDelayMs');
  });

  it('reflects a value the flag client acquired AFTER the server was built', async () => {
    // The difference between a flag and a deploy. A handler that captured `flags.all()` at
    // construction would pass every other case in this file.
    const flags = mutableFlags();
    const base = await start(flags);
    expect(((await (await fetch(`${base}${PUBLIC_FLAGS_PATH}`)).json()) as { flags: Record<string, unknown> }).flags['ui.maintenanceBanner']).toBe('');

    flags.set('ui.maintenanceBanner', 'Back at 14:00 UTC');
    flags.set('ads.rewardedOfferEnabled', false);
    const after = await (await fetch(`${base}${PUBLIC_FLAGS_PATH}`)).json();
    expect(after).toEqual({
      flags: { 'ads.rewardedOfferEnabled': false, 'ui.maintenanceBanner': 'Back at 14:00 UTC' },
    });
  });

  it('answers a PROXIED request, unlike /metrics beside it', async () => {
    // Caddy stamps `x-forwarded-for` on everything it forwards, and matchsvc is the one
    // service it proxies wholesale — so for `/metrics` the header's presence is what "came
    // from outside" means and the answer is a 404. Here outside is every player. The
    // `/metrics` control is in the same case deliberately: it is what makes this an
    // assertion about a DIFFERENCE rather than about one route answering 200.
    const base = await start();
    const proxied = { 'x-forwarded-for': '203.0.113.7' };
    const flags = await fetch(`${base}${PUBLIC_FLAGS_PATH}`, { headers: proxied });
    expect(flags.status).toBe(200);
    const metrics = await fetch(`${base}/metrics`, { headers: proxied });
    expect(metrics.status).toBe(404);
  });

  it('is a CORS-able GET with no credentials and no store', async () => {
    // The client is on `b.gamestao.com` and matchsvc on `bb.gamestao.com`, so every fetch
    // here is cross-origin. And `no-store`, because a browser or an intermediary holding a
    // cached copy turns "I turned the banner on and it did not appear" into a real report
    // with no bug behind it.
    const base = await start();
    const res = await fetch(`${base}${PUBLIC_FLAGS_PATH}`);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  it('refuses a POST to the same path — it is a read and only a read', async () => {
    // Falls through to the 404 handler, which is the correct answer: a route that accepted
    // a POST would be a public write to the flag plane, and design/21 B1's claim is that
    // only adminsvc can write anything at all.
    const base = await start();
    expect((await fetch(`${base}${PUBLIC_FLAGS_PATH}`, { method: 'POST' })).status).toBe(404);
  });

  it('is parsed by the SHIPPED client parser, off the real socket', async () => {
    // The round trip that matters, with nothing hand-assembled: the real dispatch chain,
    // the real projection, the real JSON, and the parser the browser actually runs. An
    // envelope change on either side lands here rather than in production, where the
    // symptom would be every client silently on its defaults.
    const flags = mutableFlags();
    flags.set('ui.maintenanceBanner', 'scheduled restart 03:00 UTC');
    const base = await start(flags);
    const res = await fetch(`${base}${PUBLIC_FLAGS_PATH}`);
    expect(parsePublicFlags(await res.json())).toEqual({
      'ads.rewardedOfferEnabled': true,
      'ui.maintenanceBanner': 'scheduled restart 03:00 UTC',
    });
  });
});
