/**
 * The browser wiring — `analyticsInstall.ts`.
 *
 * The reason this file exists rather than being folded into `analytics.test.ts`: every
 * property below is about the REQUEST, and every one of them fails in a way that leaves the
 * game working perfectly and the data missing.
 *
 *   - **`keepalive: true` and `credentials: 'omit'`.** Two independent CORS/unload
 *     constraints of this specific deployment. Drop either and the exit flush stops
 *     landing, which costs `session_end` — half the churn funnel — while nothing goes red.
 *   - **The token is read per FLUSH.** Captured once at install time, a player who logs in
 *     mid-visit stays anonymous for the rest of it. funny measured the same class of bug:
 *     2,848 exit events, not one attributable.
 *   - **`pagehide`, and not `visibilitychange`.** A backgrounded tab is the normal case on
 *     mobile; flushing there would send a batch every time a phone call arrives.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installAnalytics, uninstallAnalyticsForTests } from './analyticsInstall';
import { flushAnalytics, track } from './analytics';
import { resetIdentityCacheForTests } from './identity';

interface Captured {
  url: string;
  init: RequestInit;
}

function harness(over: Partial<Parameters<typeof installAnalytics>[0]> = {}) {
  const calls: Captured[] = [];
  const listeners = new Map<string, () => void>();
  const timers: { fn: () => void; ms: number }[] = [];
  let cleared = 0;

  const analytics = installAnalytics({
    baseUrl: 'https://bb.example.test',
    token: () => null,
    host: 'web',
    build: () => '1.0.0',
    locale: () => 'en',
    session: 'v-fixed',
    fetchImpl: ((url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve(new Response('{}'));
    }) as unknown as typeof fetch,
    target: {
      addEventListener: (type, fn) => void listeners.set(type, fn),
      removeEventListener: (type) => void listeners.delete(type),
    },
    setIntervalImpl: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    clearIntervalImpl: () => void (cleared += 1),
    ...over,
  });

  const body = (i = 0): Record<string, unknown> => JSON.parse(String(calls[i]!.init.body));
  return { analytics, calls, listeners, timers, body, cleared: () => cleared };
}

beforeEach(() => {
  uninstallAnalyticsForTests();
  resetIdentityCacheForTests();
});
afterEach(() => {
  uninstallAnalyticsForTests();
});

describe('installAnalytics — the request', () => {
  it('POSTs to the client-events route on the given origin', () => {
    const h = harness();
    h.analytics.track('session_start');
    h.analytics.flush();
    expect(h.calls[0]!.url).toBe('https://bb.example.test/client/events');
    expect(h.calls[0]!.init.method).toBe('POST');
  });

  it('tolerates a base URL with a trailing slash', () => {
    const h = harness({ baseUrl: 'https://bb.example.test/' });
    h.analytics.track('session_start');
    h.analytics.flush();
    expect(h.calls[0]!.url).toBe('https://bb.example.test/client/events');
  });

  it('sets keepalive, so a flush started as the page goes away still lands', () => {
    const h = harness();
    h.analytics.track('session_end', { duration_s: 12 });
    h.analytics.flush();
    expect(h.calls[0]!.init.keepalive).toBe(true);
  });

  it("omits credentials, which a wildcard allow-origin makes mandatory", () => {
    const h = harness();
    h.analytics.track('session_start');
    h.analytics.flush();
    expect(h.calls[0]!.init.credentials).toBe('omit');
  });

  it('sends the batch as JSON with the envelope the server expects', () => {
    const h = harness();
    h.analytics.track('run_end', { outcome: 'loss', floor: 4 });
    h.analytics.flush();
    const b = h.body();
    expect(b).toMatchObject({ session: 'v-fixed', host: 'web', build: '1.0.0', locale: 'en' });
    expect(typeof b.install).toBe('string');
    expect(typeof b.sentAt).toBe('number');
    // `session_start` is emitted by the install itself, so a tracked event is the second.
    expect((b.events as { name: string }[]).map((e) => e.name)).toEqual(['session_start', 'run_end']);
  });

  it('normalizes a null build to "unknown" rather than sending null', () => {
    // Three real cases produce null: a dev build (the manifest plugin is apply:'build'), the
    // WeChat mini-game (whose config never runs the plugin), and the portal build (served
    // from a sub-path where the absolute manifest URL 404s). The server would default it
    // anyway, but sending `null` for a declared string field is how a schema starts lying.
    const h = harness({ build: () => null });
    h.analytics.track('session_start');
    h.analytics.flush();
    expect(h.body().build).toBe('unknown');
  });

  it('never puts an account id in the body — the server attaches it', () => {
    const h = harness({ token: () => 'tok-1' });
    h.analytics.track('session_start');
    h.analytics.flush();
    const b = h.body();
    expect(b.account).toBeUndefined();
    expect(b.accountId).toBeUndefined();
    expect(b.user_id).toBeUndefined();
  });
});

describe('installAnalytics — the bearer token', () => {
  it('sends no authorization header for a guest', () => {
    const h = harness({ token: () => null });
    h.analytics.track('session_start');
    h.analytics.flush();
    expect((h.calls[0]!.init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it('reads the token at FLUSH time, so a mid-visit login becomes attributable', () => {
    let token: string | null = null;
    const h = harness({ token: () => token });
    h.analytics.track('session_start');
    h.analytics.flush();
    token = 'tok-after-login';
    h.analytics.track('run_start', { character: 'c' });
    h.analytics.flush();
    expect((h.calls[0]!.init.headers as Record<string, string>).authorization).toBeUndefined();
    expect((h.calls[1]!.init.headers as Record<string, string>).authorization).toBe('Bearer tok-after-login');
  });

  it('stops sending the token after a logout', () => {
    let token: string | null = 'tok';
    const h = harness({ token: () => token });
    h.analytics.track('session_start');
    h.analytics.flush();
    token = null;
    h.analytics.track('store_purchase', { sku: 'blueprint:rifle' });
    h.analytics.flush();
    expect((h.calls[1]!.init.headers as Record<string, string>).authorization).toBeUndefined();
  });
});

describe('installAnalytics — the visit', () => {
  it('emits session_start exactly once, from the install itself', () => {
    // Emitted here rather than from a call site so that "one per visit" is structural. Two
    // entry points calling `track('session_start')` would make it a convention a third
    // entry point can forget — and a forgotten one costs the cohort row, i.e. all retention
    // for that host.
    const h = harness();
    h.analytics.flush();
    expect((h.body().events as { name: string }[]).map((e) => e.name)).toEqual(['session_start']);
  });

  it('emits session_end on pagehide, BEFORE the flush that carries it', () => {
    // Order is the whole point: pushed after the flush it would sit in a queue that has no
    // later flush, which for the last batch of a visit means it is never sent at all. funny
    // shipped the equivalent bug and lost every exit event.
    const h = harness();
    h.listeners.get('pagehide')!();
    expect(h.calls).toHaveLength(1);
    const names = (h.body().events as { name: string }[]).map((e) => e.name);
    expect(names).toEqual(['session_start', 'session_end']);
  });

  it('reports the visit duration in whole seconds', () => {
    let t = 1_000_000;
    const h = harness({ now: () => t });
    t += 95_400; // 95.4s
    h.listeners.get('pagehide')!();
    const end = (h.body().events as { name: string; props?: { duration_s: number } }[]).find(
      (e) => e.name === 'session_end',
    );
    expect(end?.props?.duration_s).toBe(95);
  });

  it('never reports a negative duration, however the clock moves', () => {
    // A device clock can step backwards mid-visit (an NTP correction, a manual change). The
    // vocabulary's bound would drop a negative value server-side, which loses the event
    // rather than the precision.
    let t = 1_000_000;
    const h = harness({ now: () => t });
    t -= 60_000;
    h.listeners.get('pagehide')!();
    const end = (h.body().events as { name: string; props?: { duration_s: number } }[]).find(
      (e) => e.name === 'session_end',
    );
    expect(end?.props?.duration_s).toBe(0);
  });
});

describe('installAnalytics — lifecycle', () => {
  it('flushes on pagehide', () => {
    const h = harness();
    h.analytics.track('store_purchase', { sku: 'blueprint:rifle' });
    expect(h.calls).toHaveLength(0);
    h.listeners.get('pagehide')!();
    expect(h.calls).toHaveLength(1);
  });

  it('does not subscribe to visibilitychange', () => {
    const h = harness();
    expect(h.listeners.has('visibilitychange')).toBe(false);
  });

  it('flushes on its timer', () => {
    const h = harness({ flushIntervalMs: 1_000 });
    h.analytics.track('session_start');
    expect(h.timers[0]!.ms).toBe(1_000);
    h.timers[0]!.fn();
    expect(h.calls).toHaveLength(1);
  });

  it('installs once — a second call returns the first handle', () => {
    const first = harness();
    const second = installAnalytics({
      baseUrl: 'https://other.test',
      token: () => null,
      host: 'wechat',
      build: () => '2',
      locale: () => 'zh',
    });
    expect(second).toBe(first.analytics);
    first.analytics.track('session_start');
    first.analytics.flush();
    // Still the ORIGINAL sender, not the second call's defaults.
    expect(first.calls[0]!.url).toBe('https://bb.example.test/client/events');
  });

  it('clears its timer and listener on uninstall', () => {
    const h = harness();
    uninstallAnalyticsForTests();
    expect(h.cleared()).toBe(1);
    expect(h.listeners.has('pagehide')).toBe(false);
  });

  it('installs the module handle, so a call site can just call track()', () => {
    const h = harness();
    track('screen_view', { screen: 'lobby' });
    flushAnalytics();
    expect((h.body().events as { name: string }[]).map((e) => e.name)).toEqual(['session_start', 'screen_view']);
  });

  it('survives a fetch that rejects, and swallows the rejection', async () => {
    // Not just "does not throw": an UNHANDLED rejection is a global error event, which the
    // client logger installed one line earlier would then report as a client error — so a
    // log store that is down would generate the errors it is failing to collect.
    const unhandled: unknown[] = [];
    const onUnhandled = (e: PromiseRejectionEvent | unknown): void => void unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    try {
      const h = harness({
        fetchImpl: (() => Promise.reject(new Error('offline'))) as unknown as typeof fetch,
      });
      h.analytics.track('store_purchase', { sku: 'blueprint:rifle' });
      expect(() => h.analytics.flush()).not.toThrow();
      await new Promise((r) => setImmediate(r));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('installs with nothing but the required options', () => {
    // Every `??` default at once: the real clock, the ambient `fetch`, `globalThis` as the
    // listener target (which in Node has no addEventListener, so the optional chain is the
    // path taken), a real `setInterval`, the 30s interval, and a generated session id.
    // Worth a case of its own because a shipped entry point passes exactly this, and a
    // broken default would only show up there.
    const a = installAnalytics({
      baseUrl: 'https://defaults.test',
      token: () => null,
      host: 'web',
      build: () => '1.0.0',
      locale: () => 'en',
    });
    expect(a.pending()).toBe(1); // the install's own session_start
    a.track('store_purchase', { sku: 'blueprint:rifle' });
    expect(a.pending()).toBe(2);
    expect(() => a.flush()).not.toThrow();
    expect(a.pending()).toBe(0);
    uninstallAnalyticsForTests(); // clears the REAL timer this installed
  });

  it('generates a distinct session id per install', () => {
    const bodies: Record<string, unknown>[] = [];
    const make = () => {
      uninstallAnalyticsForTests();
      const calls: Captured[] = [];
      const a = installAnalytics({
        baseUrl: 'https://x.test',
        token: () => null,
        host: 'web',
        build: () => '1',
        locale: () => 'en',
        fetchImpl: ((url: string, init: RequestInit) => {
          calls.push({ url, init });
          return Promise.resolve(new Response('{}'));
        }) as unknown as typeof fetch,
        target: { addEventListener: () => undefined, removeEventListener: () => undefined },
        setIntervalImpl: () => 1,
        clearIntervalImpl: () => undefined,
      });
      a.track('session_start');
      a.flush();
      bodies.push(JSON.parse(String(calls[0]!.init.body)));
    };
    make();
    make();
    expect(bodies[0]!.session).toBeTruthy();
    expect(bodies[0]!.session).not.toBe(bodies[1]!.session);
  });

  it('still produces a session id where crypto.randomUUID does not exist', () => {
    // A real host: an older WeChat WebView. The id is never a security boundary — it groups
    // one visit's events — so a non-cryptographic fallback is correct, but it has to EXIST:
    // a throw here would happen during boot, before anything is on screen.
    vi.stubGlobal('crypto', {});
    try {
      const calls: Captured[] = [];
      const a = installAnalytics({
        baseUrl: 'https://x.test',
        token: () => null,
        host: 'wechat',
        build: () => '1',
        locale: () => 'zh',
        fetchImpl: ((url: string, init: RequestInit) => {
          calls.push({ url, init });
          return Promise.resolve(new Response('{}'));
        }) as unknown as typeof fetch,
        target: { addEventListener: () => undefined, removeEventListener: () => undefined },
        setIntervalImpl: () => 1,
        clearIntervalImpl: () => undefined,
      });
      a.track('session_start');
      a.flush();
      const body = JSON.parse(String(calls[0]!.init.body)) as { session: string; install: string };
      expect(body.session).toMatch(/^v-/);
      // The install id falls back the same way, through identity.ts's own generator.
      expect(body.install).toMatch(/^p-/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('is inert when the environment has no fetch at all', () => {
    // The WeChat shell and a Node test both reach this. It must queue and drop, not throw.
    const spy = vi.fn();
    const a = installAnalytics({
      baseUrl: 'https://x.test',
      token: () => null,
      host: 'wechat',
      build: () => '1',
      locale: () => 'zh',
      fetchImpl: undefined as unknown as typeof fetch,
      target: { addEventListener: spy, removeEventListener: spy },
      setIntervalImpl: () => 1,
      clearIntervalImpl: () => undefined,
    });
    a.track('session_start');
    expect(() => a.flush()).not.toThrow();
    expect(a.pending()).toBe(0);
  });
});
