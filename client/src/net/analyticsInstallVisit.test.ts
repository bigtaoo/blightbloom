/**
 * The visit half of `analyticsInstall.ts` (design/21 §2.9): what `session_start` says about the
 * visit, the hand-off from the inline beacon, and the visible-time reports. Beside
 * `analyticsInstall.test.ts` rather than in it because that file is about the REQUEST and this
 * one is about the payload.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  ACTIVE_REPORT_STEP_S,
  browserVisit,
  installAnalytics,
  uninstallAnalyticsForTests,
  type AnalyticsInstallOptions,
  type VisibilitySource,
} from './analyticsInstall';
import { resetIdentityCacheForTests } from './identity';

type Event = { name: string; props?: Record<string, unknown> };

function fakeDoc(hidden = false) {
  const listeners = new Set<() => void>();
  const doc: VisibilitySource & { set: (h: boolean) => void; count: () => number } = {
    hidden,
    addEventListener: (_t, fn) => void listeners.add(fn),
    removeEventListener: (_t, fn) => void listeners.delete(fn),
    set(h) {
      doc.hidden = h;
      for (const fn of listeners) fn();
    },
    count: () => listeners.size,
  };
  return doc;
}

function harness(over: Partial<AnalyticsInstallOptions> = {}) {
  const bodies: { session: string; events: Event[] }[] = [];
  const listeners = new Map<string, () => void>();
  let tick: () => void = () => undefined;
  let t = 100_000;
  const analytics = installAnalytics({
    baseUrl: 'https://bb.example.test',
    token: () => null,
    host: 'web',
    build: () => '1.0.0',
    locale: () => 'en',
    now: () => t,
    visit: {},
    pageOpen: null,
    doc: null,
    fetchImpl: ((_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return Promise.resolve(new Response('{}'));
    }) as unknown as typeof fetch,
    target: {
      addEventListener: (type, fn) => void listeners.set(type, fn),
      removeEventListener: (type) => void listeners.delete(type),
    },
    setIntervalImpl: (fn) => {
      tick = fn;
      return 1;
    },
    clearIntervalImpl: () => undefined,
    ...over,
  });
  const events = (): Event[] => {
    analytics.flush();
    return bodies.flatMap((b) => b.events);
  };
  return {
    analytics,
    bodies,
    events,
    advance: (ms: number) => void (t += ms),
    tick: () => tick(),
    pagehide: () => listeners.get('pagehide')?.(),
  };
}

beforeEach(() => {
  uninstallAnalyticsForTests();
  resetIdentityCacheForTests();
  delete (globalThis as { __bbOpen?: unknown }).__bbOpen;
});
afterEach(() => {
  uninstallAnalyticsForTests();
  delete (globalThis as { __bbOpen?: unknown }).__bbOpen;
});

describe('session_start — the visit', () => {
  it('carries the passed source and device split, dropping undefined fields', () => {
    const h = harness({ visit: { source: 'reddit', device: 'phone', os: 'ios', browser: undefined } });
    expect(h.events()[0]!.props).toEqual({ storage: expect.any(String), source: 'reddit', device: 'phone', os: 'ios' });
  });

  it('reuses the beacon\'s session and measures boot_ms from its clock', () => {
    const h = harness({ pageOpen: { session: 'v-beacon', at: 100_000 - 4321.4 } });
    expect(h.events()[0]!.props?.boot_ms).toBe(4321);
    expect(h.bodies[0]!.session).toBe('v-beacon');
  });

  it('never reports a negative boot time', () => {
    const h = harness({ pageOpen: { session: 'v', at: 200_000 } });
    expect(h.events()[0]!.props?.boot_ms).toBe(0);
  });

  it('reads the hand-off from globalThis.__bbOpen by default, and only in its own shape', () => {
    (globalThis as { __bbOpen?: unknown }).__bbOpen = { session: 'v-global', at: 99_000 };
    let h = harness({ pageOpen: undefined });
    h.events();
    expect(h.bodies[0]!.session).toBe('v-global');
    expect(h.events()[0]!.props?.boot_ms).toBe(1000);

    for (const bad of [null, 'x', { session: '', at: 1 }, { session: 'v', at: Number.NaN }, { session: 1, at: 1 }]) {
      uninstallAnalyticsForTests();
      (globalThis as { __bbOpen?: unknown }).__bbOpen = bad;
      h = harness({ pageOpen: undefined });
      expect(h.events()[0]!.props, JSON.stringify(bad)).not.toHaveProperty('boot_ms');
      expect(h.bodies[0]!.session).not.toBe('v');
    }
  });

  it('an injected session still wins over the beacon\'s', () => {
    const h = harness({ session: 'v-test', pageOpen: { session: 'v-beacon', at: 0 } });
    h.events();
    expect(h.bodies[0]!.session).toBe('v-test');
  });

  it('reads the browser globals when no visit is passed', () => {
    const h = harness({ visit: undefined });
    const props = h.events()[0]!.props ?? {};
    // Whatever the runner's own navigator says, the split is all-or-nothing and enum-valued.
    if ('device' in props) expect(Object.keys(props)).toEqual(expect.arrayContaining(['device', 'os', 'browser']));
    expect(props).not.toHaveProperty('boot_ms');
  });
});

describe('browserVisit', () => {
  it('splits the user agent and tags the source', () => {
    expect(
      browserVisit({
        navigator: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) Version/17.5 Mobile/15E148 Safari/604.1', maxTouchPoints: 5 },
        location: { search: '?src=discord', hostname: 'b.gamestao.com' },
        document: { referrer: 'https://www.reddit.com/' },
      }),
    ).toEqual({ device: 'phone', os: 'ios', browser: 'safari', source: 'discord' });
  });

  it('degrades to fewer props, never a throw, without the globals', () => {
    expect(browserVisit({})).toEqual({});
    expect(browserVisit({ navigator: {}, document: { referrer: 'https://poki.com/' } })).toEqual({ source: 'ref:poki.com' });
    expect(browserVisit({ navigator: { userAgent: 'curl/8' } })).toEqual({ device: 'desktop', os: 'other', browser: 'other' });
  });
});

describe('visible time', () => {
  const active = (es: Event[]): unknown[] => es.filter((e) => e.name === 'active_time').map((e) => e.props?.active_s);

  it('reports active_time on the timer only once a further minute has accrued', () => {
    const h = harness({ doc: fakeDoc() });
    h.advance(59_000);
    h.tick();
    expect(active(h.events())).toEqual([]);
    h.advance(1000);
    h.tick();
    h.advance(30_000);
    h.tick();
    h.advance(30_000);
    h.tick();
    expect(active(h.events())).toEqual([60, 120]);
    expect(ACTIVE_REPORT_STEP_S).toBe(60);
  });

  it('stops counting while hidden, and queues what accrued when the page hides', () => {
    const doc = fakeDoc();
    const h = harness({ doc });
    h.advance(5_000);
    doc.set(true);
    h.advance(600_000); // ten minutes in another tab
    doc.set(false);
    h.advance(2_000);
    h.pagehide();
    const es = h.events();
    expect(active(es)).toEqual([5]);
    const end = es.find((e) => e.name === 'session_end');
    expect(end?.props).toEqual({ duration_s: 607, active_s: 7 });
  });

  it('sends nothing on a hide with under a second accrued', () => {
    const doc = fakeDoc();
    const h = harness({ doc });
    h.advance(400);
    doc.set(true);
    expect(active(h.events())).toEqual([]);
  });

  it('starts from zero on a page loaded hidden', () => {
    const h = harness({ doc: fakeDoc(true) });
    h.advance(90_000);
    h.tick();
    h.pagehide();
    expect(active(h.events())).toEqual([]);
    expect(h.events().find((e) => e.name === 'session_end')?.props?.active_s).toBe(0);
  });

  it('counts a visit with no document as visible throughout', () => {
    const h = harness({ doc: null });
    h.advance(61_000);
    h.tick();
    expect(active(h.events())).toEqual([61]);
  });

  it('uses globalThis.document by default, and unhooks it on uninstall', () => {
    const doc = fakeDoc();
    const g = globalThis as { document?: unknown };
    const had = Object.prototype.hasOwnProperty.call(g, 'document');
    const prev = g.document;
    g.document = doc;
    try {
      harness({ doc: undefined });
      expect(doc.count()).toBe(1);
      uninstallAnalyticsForTests();
      expect(doc.count()).toBe(0);
    } finally {
      if (had) g.document = prev;
      else delete g.document;
    }
  });
});
