/**
 * The two adapters, driven end to end against a WeChat-SHAPED runtime — the three features
 * that were switched off for want of them, switched on (design/21 §9; design/04-wechat.md
 * item 19).
 *
 * The unit files beside this one test each adapter alone. What this one is about is the
 * claims that are only true in combination, and each of them was previously false:
 *
 *  - the flag poll DELIVERS here (it was installed and inert, so every flag stayed at the
 *    value the build was compiled with);
 *  - an analytics batch leaves this host at all, labelled `wechat`;
 *  - a LOG batch leaves it labelled `wechat` too, which is a different claim and was FALSE
 *    when these adapters landed: nothing had ever declared this entry's host, so `clientLog`
 *    labelled it `web`. That case keeps the undeclared batch beside it as its control;
 *  - and the one that decided the whole thing: the install id in that batch is the one in
 *    the store, and a second visit reports the SAME one. Before the storage adapter, DAU on
 *    this host would have counted visits while labelled distinct installs.
 *
 * The shape is the same discipline `render/wechatRuntimeFake.ts` uses: the browser globals a
 * mini-game does not have are REMOVED rather than merely unused. `fetch` exists in Node, so
 * without deleting it every assertion below would pass through a road this platform does not
 * have — and each case carries its control with `fetch` gone and no shim, which is the state
 * this host was actually in.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createWeChatFetch } from './weChatFetch';
import { createWeChatIdentityStore } from './weChatStorage';
import { IDENTITY_STORAGE_KEY, getInstallId, resetIdentityCacheForTests, setIdentityStore } from '../../net/identity';
import { installPublicFlags, publicFlag, publicFlagsSnapshot, setPublicFlags } from '../../net/clientFlags';
import { PUBLIC_FLAG_DEFAULTS, PUBLIC_FLAGS_PATH } from '../../net/publicFlags';
import { installAnalytics, uninstallAnalyticsForTests } from '../../net/analyticsInstall';
import { installClientLog, resetClientLog } from '../../net/clientLogInstall';
import { resetHostKind, setHostKind } from '../../platform/hostKind';
import { CLIENT_EVENTS_PATH } from '../../net/analytics';
import type { AnalyticsBatch } from '../../net/analyticsEvents';

const BASE = 'https://bb.example.test';

interface Sent {
  url: string;
  method: string;
  header: Record<string, string>;
  body: string | undefined;
}

/** The whole shell: `wx` with storage and request, and no `fetch`/`XMLHttpRequest` at all. */
function installShell(routes: Record<string, { status?: number; body: string }>) {
  // The DEVICE shape, asserted rather than assumed. This runner has none of these, which is
  // what makes it the right host for these cases — but the trap this platform has paid for
  // twice is that **the DevTools simulator HAS a `document` and a handset does not**, so
  // browser-shaped code passes every simulator check and is a `ReferenceError` on a phone.
  // Moved to a jsdom environment these cases would quietly start proving something about a
  // browser instead, so the shape fails loudly here first.
  for (const absent of ['document', 'window', 'localStorage', 'XMLHttpRequest', 'createImageBitmap']) {
    if (typeof (globalThis as Record<string, unknown>)[absent] !== 'undefined') {
      throw new Error(`weChatNetInstall.test: this shell must not have a ${absent}`);
    }
  }
  const sent: Sent[] = [];
  const store = new Map<string, unknown>();
  const realFetch = globalThis.fetch;
  // Removed, not stubbed: a consumer falling back to the global would otherwise reach Node's
  // own `fetch` and every case here would prove nothing about this platform.
  Object.defineProperty(globalThis, 'fetch', { value: undefined, configurable: true, writable: true });
  vi.stubGlobal('wx', {
    getStorageSync: (key: string): unknown => (store.has(key) ? store.get(key) : ''),
    setStorageSync: (key: string, data: unknown): void => {
      store.set(key, data);
    },
    request: (opts: Record<string, unknown>): void => {
      const url = String(opts.url);
      sent.push({
        url,
        method: String(opts.method),
        header: (opts.header ?? {}) as Record<string, string>,
        body: opts.data as string | undefined,
      });
      const route = Object.entries(routes).find(([path]) => url.endsWith(path))?.[1];
      if (route === undefined) {
        (opts.fail as (r: unknown) => void)({ errMsg: `request:fail no route for ${url}` });
        return;
      }
      (opts.success as (r: unknown) => void)({ data: route.body, statusCode: route.status ?? 200, header: {} });
    },
  });
  return {
    sent,
    store,
    restore(): void {
      Object.defineProperty(globalThis, 'fetch', { value: realFetch, configurable: true, writable: true });
      vi.unstubAllGlobals();
    },
  };
}

/** A banner nobody would get by accident: the compiled default is the empty string, so a
 *  value arriving at all is the delivery being tested. */
const BANNER = 'Servers restart in 20 minutes';
const FLAG_BODY = JSON.stringify({ flags: { ...PUBLIC_FLAG_DEFAULTS, 'ui.maintenanceBanner': BANNER } });

let shell: ReturnType<typeof installShell>;

beforeEach(() => {
  resetIdentityCacheForTests();
  setPublicFlags(null);
});

afterEach(() => {
  resetClientLog();
  resetHostKind();
  uninstallAnalyticsForTests();
  setPublicFlags(null);
  resetIdentityCacheForTests();
  shell?.restore();
});

/** A poller with no live timer — every poll below is the one `installPublicFlags` does itself. */
function flags(fetchImpl: typeof fetch | undefined) {
  return installPublicFlags({
    baseUrl: BASE,
    fetchImpl,
    setIntervalImpl: () => 'timer',
    clearIntervalImpl: () => {},
    warn: () => {},
  });
}

describe('the flag poll on this host', () => {
  it('delivers a flag through wx.request', async () => {
    shell = installShell({ [PUBLIC_FLAGS_PATH]: { body: FLAG_BODY } });
    const poller = flags(createWeChatFetch());
    expect(await poller.first).toBe(true);
    expect(poller.healthy()).toBe(true);
    expect(publicFlag('ui.maintenanceBanner')).toBe(BANNER);
    // ...and it went to the route the server serves, not to some other url that happened to
    // answer: the poll was inert for long enough that nothing had ever exercised the path.
    expect(shell.sent.map((s) => s.url)).toEqual([`${BASE}${PUBLIC_FLAGS_PATH}`]);
    expect(shell.sent[0]!.method).toBe('GET');
    poller.stop();
  });

  it('was inert without the shim, which is the state this host was in', async () => {
    // The control for the case above. Same shell, no `fetchImpl` — so the poller reaches for
    // a global `fetch` that this platform does not have, issues nothing, and every flag
    // stays at the value the build was compiled with. An absence, never a wrong number.
    shell = installShell({ [PUBLIC_FLAGS_PATH]: { body: FLAG_BODY } });
    const poller = flags(undefined);
    expect(await poller.first).toBe(false);
    expect(poller.healthy()).toBe(false);
    expect(publicFlagsSnapshot()).toEqual(PUBLIC_FLAG_DEFAULTS);
    expect(shell.sent).toEqual([]);
    poller.stop();
  });

  it('keeps the shipped values when the route answers 404', async () => {
    // A deployment that predates the route. It reaches the client as `ok: false` through the
    // shim, which is the case `clientFlags.ts` separates from a transport failure — and the
    // only reason it can is that the shim resolves a 404 rather than rejecting it.
    shell = installShell({ [PUBLIC_FLAGS_PATH]: { status: 404, body: 'not found' } });
    const poller = flags(createWeChatFetch());
    expect(await poller.first).toBe(false);
    expect(publicFlagsSnapshot()).toEqual(PUBLIC_FLAG_DEFAULTS);
    poller.stop();
  });
});

describe('analytics on this host', () => {
  /** The batch bodies this shell actually sent to the events route. */
  const batches = (): AnalyticsBatch[] =>
    shell.sent.filter((s) => s.url.endsWith(CLIENT_EVENTS_PATH)).map((s) => JSON.parse(s.body!) as AnalyticsBatch);

  function install() {
    return installAnalytics({
      baseUrl: BASE,
      token: () => 'tok-1',
      host: 'wechat',
      build: () => null,
      locale: () => 'zh',
      fetchImpl: createWeChatFetch(),
      setIntervalImpl: () => 'timer',
      clearIntervalImpl: () => {},
      target: {},
    });
  }

  it('sends a batch, labelled wechat, keyed by the id in the store', () => {
    shell = installShell({ [CLIENT_EVENTS_PATH]: { status: 202, body: '' } });
    setIdentityStore(createWeChatIdentityStore());
    install().flush();

    expect(batches()).toHaveLength(1);
    const batch = batches()[0]!;
    expect(batch.host).toBe('wechat');
    expect(batch.build).toBe('unknown');
    expect(batch.events.map((e) => e.name)).toEqual(['session_start']);
    // The row's identity is the value in wx storage — not a per-boot id that merely looks
    // like one. This is the assertion the decision to switch analytics off was about.
    expect(batch.install).toBe(shell.store.get(IDENTITY_STORAGE_KEY));
    expect(batch.install).toBeTruthy();
    // And the bearer token rode along, so the row is attributable.
    expect(shell.sent[0]!.header.authorization).toBe('Bearer tok-1');
  });

  it('reports the same install across two visits — and a fresh one per visit before', () => {
    shell = installShell({ [CLIENT_EVENTS_PATH]: { status: 202, body: '' } });
    setIdentityStore(createWeChatIdentityStore());
    install().flush();
    const firstVisit = batches()[0]!.install;

    // A reload: the process is gone, wx storage is not.
    uninstallAnalyticsForTests();
    resetIdentityCacheForTests();
    setIdentityStore(createWeChatIdentityStore());
    install().flush();
    expect(batches()[1]!.install).toBe(firstVisit);

    // The control — the state before the storage adapter: no store installed, so the default
    // web one reads a `localStorage` this shell (and this test run) does not have, and each
    // visit mints its own id. Two visits, two "installs": DAU counting visits.
    expect(typeof localStorage).toBe('undefined');
    const ids = new Set<string>();
    for (let i = 0; i < 2; i++) {
      uninstallAnalyticsForTests();
      resetIdentityCacheForTests();
      install().flush();
      ids.add(batches().at(-1)!.install);
    }
    expect(ids.size).toBe(2);
  });

  it('reports an id the store never saw when the store arrives too late', () => {
    // The behavioural half of the source-order pin below, and the reason it is load-bearing:
    // `getInstallId()` is called ONCE, during the install. A store handed over afterwards is
    // not late by a line, it is late by a VISIT — and what the store then holds is an id no
    // row was ever keyed by, which in the data is indistinguishable from the per-visit-id bug
    // this whole pass exists to fix.
    shell = installShell({ [CLIENT_EVENTS_PATH]: { status: 202, body: '' } });
    install().flush();
    const reported = batches()[0]!.install;
    setIdentityStore(createWeChatIdentityStore());
    expect(getInstallId()).not.toBe(reported);
    expect(shell.store.get(IDENTITY_STORAGE_KEY)).not.toBe(reported);
  });

  it('drops the batch without the shim, and never throws for it', () => {
    // The other half of the fail-safe: on a shell where `createWeChatFetch()` answers
    // undefined, the sender is absent and a flush is a no-op — the same silence as a log
    // store that is down, which is the one thing analytics is never allowed to break.
    shell = installShell({ [CLIENT_EVENTS_PATH]: { status: 202, body: '' } });
    setIdentityStore(createWeChatIdentityStore());
    const analytics = installAnalytics({
      baseUrl: BASE,
      token: () => null,
      host: 'wechat',
      build: () => null,
      locale: () => 'zh',
      fetchImpl: undefined,
      setIntervalImpl: () => 'timer',
      clearIntervalImpl: () => {},
      target: {},
    });
    expect(() => analytics.flush()).not.toThrow();
    expect(shell.sent).toEqual([]);
  });
});

describe('the client log on this host', () => {
  /** The route is a literal in `clientLog.ts` rather than an exported constant. */
  const LOG_PATH = '/client/log';

  /** A logger with no live timer and no reach into the real console. `minLevel` defaults to
   *  `warn`, so the line each case logs is one that is actually SENT, not only recorded. */
  function install() {
    return installClientLog({
      baseUrl: BASE,
      token: () => 'tok-1',
      fetchImpl: createWeChatFetch(),
      setIntervalImpl: () => 'timer',
      clearIntervalImpl: () => {},
      target: {},
      consoleImpl: { error: () => {}, warn: () => {} },
    });
  }

  it('ships a batch labelled wechat — and labelled web without the declaration', async () => {
    // The third of the three installs, and the one carrying a label nothing else checks. The
    // server ALLOWLISTS this value and turns it into a Loki stream label
    // (`server/src/clientLog.ts`), so an undeclared host does not degrade: it files every
    // WeChat failure under `web` and makes `host="wechat"` a filter that never matches.
    shell = installShell({ [LOG_PATH]: { status: 200, body: '{"ok":true}' } });
    setHostKind('wechat');
    const logger = install();
    logger.log('error', 'test', 'boom');
    await logger.flush();

    expect(shell.sent.map((x) => x.url)).toEqual([`${BASE}${LOG_PATH}`]);
    expect(shell.sent[0]!.method).toBe('POST');
    expect(shell.sent[0]!.header.authorization).toBe('Bearer tok-1');
    const batch = JSON.parse(shell.sent[0]!.body!) as { host: string; ver: string; entries: unknown[] };
    expect(batch.host).toBe('wechat');
    expect(batch.ver).toBe('unknown');
    expect(batch.entries).toHaveLength(1);

    // The control, and it is the bug this pass found: `getHostKind()` defaults to `web` and
    // only a `setHostKind` call changes it, so the same batch from an entry point that never
    // declared its host is labelled `web`. Harmless while nothing this shell sent ever left
    // it; wrong the moment the shim made it ship.
    resetClientLog();
    resetHostKind();
    const undeclared = install();
    undeclared.log('error', 'test', 'boom');
    await undeclared.flush();
    expect((JSON.parse(shell.sent[1]!.body!) as { host: string }).host).toBe('web');
  });

  it('sends nothing without the shim, and never throws for it', async () => {
    // `clientLog`'s default sender calls the GLOBAL `fetch` lazily, so on this shell it is a
    // `ReferenceError` at flush time rather than an absent function — swallowed by the same
    // `catch` a network failure lands in. That is the state this host was in, and what the
    // case asserts is that it is SILENT: a logger that surfaces its own failure to a player
    // has become the bug it was installed to find.
    shell = installShell({ [LOG_PATH]: { status: 200, body: '{"ok":true}' } });
    setHostKind('wechat');
    const logger = installClientLog({
      baseUrl: BASE,
      token: () => null,
      setIntervalImpl: () => 'timer',
      clearIntervalImpl: () => {},
      target: {},
      consoleImpl: { error: () => {}, warn: () => {} },
    });
    logger.log('error', 'test', 'boom');
    await expect(logger.flush()).resolves.toBeUndefined();
    expect(shell.sent).toEqual([]);
  });
});

describe('all three, from one shell, the way boot installs them', () => {
  it('hits exactly the three routes, each with its own method', async () => {
    // What no per-feature case can see: the three installs resolve the base URL separately
    // and reach three different paths, so a shared shim wired to two of them and not the
    // third looks exactly like this test's absence. One boot, one shell, three requests.
    shell = installShell({
      '/client/flags': { body: FLAG_BODY },
      '/client/log': { status: 200, body: '{"ok":true}' },
      '/client/events': { status: 202, body: '' },
    });
    setHostKind('wechat');
    setIdentityStore(createWeChatIdentityStore());
    const wxFetch = createWeChatFetch();

    const logger = installClientLog({
      baseUrl: BASE,
      token: () => null,
      fetchImpl: wxFetch,
      setIntervalImpl: () => 'timer',
      clearIntervalImpl: () => {},
      target: {},
      consoleImpl: { error: () => {}, warn: () => {} },
    });
    const analytics = installAnalytics({
      baseUrl: BASE,
      token: () => null,
      host: 'wechat',
      build: () => null,
      locale: () => 'zh',
      fetchImpl: wxFetch,
      setIntervalImpl: () => 'timer',
      clearIntervalImpl: () => {},
      target: {},
    });
    const poller = flags(wxFetch);
    await poller.first;
    logger.log('error', 'test', 'boom');
    await logger.flush();
    analytics.flush();
    poller.stop();

    expect(shell.sent.map((x) => `${x.method} ${new URL(x.url).pathname}`).sort()).toEqual([
      'GET /client/flags',
      'POST /client/events',
      'POST /client/log',
    ]);
    // ...and the flag landed in the same boot the other two sent from, which is the
    // combination the entry point ships and no single-feature case exercises.
    expect(publicFlag('ui.maintenanceBanner')).toBe(BANNER);
  });
});

describe('the entry point wires them in the one order that works', () => {
  // Source-order assertions, the technique `render/wechatPhasedBoot.test.ts` uses for the
  // same reason: there is no way to observe a boot ordering from inside a module, and each
  // of these fails silently — as a number that looks right — rather than loudly.
  const src = readFileSync(new URL('../../main.wechat.ts', import.meta.url), 'utf8');
  const at = (needle: string): number => {
    const i = src.indexOf(needle);
    expect(i, `main.wechat.ts: no ${needle}`).toBeGreaterThan(-1);
    return i;
  };

  it('installs the identity store before analytics reads it', () => {
    // `installAnalytics` calls `getInstallId()` once, DURING the install. A store swapped in
    // afterwards would arrive one visit late and the first-ever boot would persist nothing —
    // which is indistinguishable, in the data, from the bug this all fixed.
    expect(at('setIdentityStore(createWeChatIdentityStore())')).toBeLessThan(at('installAnalytics({'));
  });

  it('declares the host before the logger reads it', () => {
    // `clientLog` labels every batch with `getHostKind()`, whose default is `web`. This entry
    // point had no `setHostKind` call at all and a comment claiming it needed none, so the
    // label was wrong for as long as the entry has existed — invisible only because nothing
    // it sent ever left the device. Same ordering rule the portal entry already states.
    expect(at("setHostKind('wechat')")).toBeLessThan(at('installClientLog({'));
  });

  it('builds the fetch shim before the three installs that take it', () => {
    const shim = at('const wxFetch = createWeChatFetch()');
    for (const call of ['installClientLog({', 'installAnalytics({', 'installPublicFlags({']) {
      expect(shim, call).toBeLessThan(at(call));
    }
  });

  it('hands the shim to all three, so none of them is left inert', () => {
    // The gap this closes has a name: two of three wired. The flag poll was installed and
    // inert for a day for exactly this reason, and nothing went red.
    for (const call of ['installClientLog({', 'installAnalytics({', 'installPublicFlags({']) {
      const start = at(call);
      const end = src.indexOf('});', start);
      expect(src.slice(start, end), call).toContain('fetchImpl: wxFetch');
    }
  });

  it('says so when the build is pointed somewhere wx.request cannot reach', () => {
    // `wx.request` refuses plain http, and a plain `npm run build:wechat` bakes in
    // `http://localhost:8788` (VITE_MATCHSVC_URL is injected by the WEB deploy workflow, and
    // this target has no CI build). Every consequence is fail-safe and silent, so the one
    // line on the console is the only thing that would ever say why the events store has no
    // `wechat` rows — asserted here because no test executes this entry point.
    expect(src).toContain("startsWith('https:')");
    expect(at('wx.request refuses plain http')).toBeGreaterThan(at('installClientLog({'));
  });

  it('flushes on hide without claiming the visit ended', () => {
    // `wx.onHide` fires on every backgrounding and is followed by `onShow`, so it answers
    // "flush what is queued" and never "the visit ended". Routing it into `session_end` would
    // multiply the row the churn funnel counts and understate every duration — a plausible
    // wrong number, which is what this host was switched off to avoid in the first place.
    const hide = at('if (typeof wx.onHide');
    const statement = src.slice(hide, src.indexOf('\n', hide));
    expect(hide).toBeGreaterThan(at('installAnalytics({'));
    expect(statement).toContain('analytics.flush()');
    // The STATEMENT, not the file: the reasoning above it names the event it does not emit.
    expect(statement).not.toContain('session_end');
    // Feature-detected, because a lifecycle API a shell turns out not to have must not be
    // the line that fails boot — the same rule the audio hooks here follow.
    expect(statement).toContain("typeof wx.onHide === 'function'");
  });
});
