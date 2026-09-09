/**
 * The client's flag store and its poll (design/21 §9's delivery path).
 *
 * ## What has to be true here, and why each one has a case
 *
 * The store is a module-level global read by a results screen and a menu, so the failure
 * modes are not "the parse is wrong" — that is `publicFlags.test.ts` — they are about what
 * the store holds after something goes wrong:
 *
 *  - **Every failure leaves the previous values.** Unreachable, a 404 from a deployment
 *    older than the route, a 500 with an HTML body, a `fetch` that throws, a body missing a
 *    name. Each is its own case with a successful poll as the control, the way
 *    `server/test/flags.client.test.ts` walks the same list for the services. A store that
 *    reset to defaults on failure would turn a five-second blip into a banner disappearing.
 *  - **A stale response cannot win.** Two fetches can overlap, and without the generation
 *    counter the slower/older one lands last and reverts a flag for a whole interval. This
 *    is the case that needs constructing rather than observing, so it is constructed.
 *  - **The warning is a TRANSITION, not a cycle.** A dev client with no server behind it
 *    must be silent — its very first poll fails and there is nothing to warn about yet —
 *    while a live client that loses the route says so once.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  PUBLIC_FLAG_POLL_INTERVAL_MS,
  installPublicFlags,
  publicFlag,
  publicFlagPoller,
  publicFlagsSnapshot,
  setPublicFlags,
  setPublicFlagsListener,
} from './clientFlags';
import { PUBLIC_FLAG_DEFAULTS, type PublicFlags } from './publicFlags';

const BODY = (over: Partial<PublicFlags> = {}): unknown => ({
  flags: { ...PUBLIC_FLAG_DEFAULTS, ...over },
});

/** A `fetch` returning a scripted sequence of responses, one per call. Per-call rather than
 *  one canned answer, because most of what is asserted below is a TRANSITION between two
 *  outcomes and a single-answer stub cannot express one. */
function scripted(...answers: Array<() => Promise<Response> | Response>): typeof fetch & { calls: string[] } {
  let i = 0;
  const impl = ((url: string) => {
    impl.calls.push(String(url));
    const answer = answers[Math.min(i++, answers.length - 1)]!;
    return Promise.resolve(answer());
  }) as unknown as typeof fetch & { calls: string[] };
  impl.calls = [];
  return impl;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A poller with no timer at all: the interval is handed a no-op, so nothing this file does
 *  can leave a live 5-minute timer behind, and every poll below is an explicit `refresh()`
 *  (bar the immediate one `installPublicFlags` does itself). */
function install(fetchImpl: typeof fetch, warn?: (m: string) => void) {
  return installPublicFlags({
    baseUrl: 'https://bb.example.test/',
    fetchImpl,
    setIntervalImpl: () => 'timer',
    clearIntervalImpl: () => {},
    warn,
  });
}

beforeEach(() => {
  setPublicFlags(null);
  setPublicFlagsListener(null);
});

afterEach(() => {
  publicFlagPoller()?.stop();
  setPublicFlags(null);
  setPublicFlagsListener(null);
});

describe('the store', () => {
  it('starts at the shipped defaults', () => {
    expect(publicFlagsSnapshot()).toEqual(PUBLIC_FLAG_DEFAULTS);
    expect(publicFlag('ads.rewardedOfferEnabled')).toBe(true);
    expect(publicFlag('ui.maintenanceBanner')).toBe('');
  });

  it('reports whether a write CHANGED anything, and notifies only then', () => {
    const seen: string[] = [];
    setPublicFlagsListener(() => seen.push(publicFlag('ui.maintenanceBanner')));

    expect(setPublicFlags({ ...PUBLIC_FLAG_DEFAULTS, 'ui.maintenanceBanner': 'down' })).toBe(true);
    expect(seen).toEqual(['down']);
    // The same values again: no change, so no notification. Without this the five-minute
    // poll would re-run a screen's banner refresh every five minutes for nothing.
    expect(setPublicFlags({ ...PUBLIC_FLAG_DEFAULTS, 'ui.maintenanceBanner': 'down' })).toBe(false);
    expect(seen).toEqual(['down']);
    expect(setPublicFlags(null)).toBe(true);
    expect(seen).toEqual(['down', '']);
  });

  it('resets to a FRESH copy of the defaults, not to the exported object', () => {
    // Handing out the module's own constant would let one mutation outlive the failure that
    // produced it, and "falls back to what this build shipped with" would stop being true
    // after the first one.
    setPublicFlags(null);
    const snapshot = publicFlagsSnapshot();
    snapshot['ui.maintenanceBanner'] = 'mutated';
    expect(PUBLIC_FLAG_DEFAULTS['ui.maintenanceBanner']).toBe('');
    expect(publicFlag('ui.maintenanceBanner')).toBe('');
  });

  it('copies what it is GIVEN too, so a caller\'s later mutation cannot reach in', () => {
    const mine: PublicFlags = { ...PUBLIC_FLAG_DEFAULTS, 'ui.maintenanceBanner': 'one' };
    setPublicFlags(mine);
    mine['ui.maintenanceBanner'] = 'two';
    expect(publicFlag('ui.maintenanceBanner')).toBe('one');
  });
});

describe('installPublicFlags', () => {
  it('fetches the route under the given base URL, once, at install time', async () => {
    const f = scripted(() => json(BODY({ 'ui.maintenanceBanner': 'hello' })));
    const poller = install(f);
    // The BOOT poll — installing is what issues it, and nothing else has run yet. A client
    // whose first values arrived five minutes in would show an ad offer nobody checked.
    expect(await poller.first).toBe(true);
    // A trailing slash on the base URL must not produce a double slash — the same
    // normalisation `installAnalytics` does, and worth asserting because
    // `resolveMatchBaseUrl` can legitimately return either shape.
    expect(f.calls).toEqual(['https://bb.example.test/client/flags']);
    expect(publicFlag('ui.maintenanceBanner')).toBe('hello');
    expect(poller.healthy()).toBe(true);
  });

  it('returns the SAME poller on a second call, without a second fetch loop', async () => {
    // Every entry point calls this, and two entries can legitimately be loaded in one test
    // file — the same rule `installAnalytics`/`installClientLog` follow.
    const f = scripted(() => json(BODY()));
    const first = install(f);
    const second = install(scripted(() => json(BODY({ 'ui.maintenanceBanner': 'from the second' }))));
    expect(second).toBe(first);
    await first.first;
    // The second call's fetch was never used — the value is the first poller's, and the
    // second script's banner never appears.
    expect(publicFlag('ui.maintenanceBanner')).toBe('');
  });

  it('arms an interval at five minutes by default', () => {
    // Not sixty seconds: the cost of a client poll scales with PLAYERS, and an operator
    // putting up a maintenance notice is working in tens of minutes.
    const setIntervalImpl = vi.fn((_fn: () => void, _ms: number) => 'timer');
    installPublicFlags({ baseUrl: 'https://bb.example.test', fetchImpl: scripted(() => json(BODY())), setIntervalImpl, clearIntervalImpl: () => {} });
    expect(setIntervalImpl).toHaveBeenCalledTimes(1);
    expect(setIntervalImpl.mock.calls[0]![1]).toBe(PUBLIC_FLAG_POLL_INTERVAL_MS);
    expect(PUBLIC_FLAG_POLL_INTERVAL_MS).toBe(300_000);
  });

  it('clears the interval and un-installs itself on stop', () => {
    const clearIntervalImpl = vi.fn();
    const poller = installPublicFlags({ baseUrl: 'https://bb.example.test', fetchImpl: scripted(() => json(BODY())), setIntervalImpl: () => 'timer', clearIntervalImpl });
    expect(publicFlagPoller()).toBe(poller);
    poller.stop();
    expect(clearIntervalImpl).toHaveBeenCalledWith('timer');
    // The slot is released, so a later `install` builds a new one rather than handing back a
    // stopped poller — which is what makes this file's `afterEach` actually reset the module.
    expect(publicFlagPoller()).toBeNull();
  });

  it('does nothing at all when the host has no fetch', async () => {
    // A host with no `fetch` and no adapter for one. The WeChat shell was exactly this until
    // `platform/wechat/weChatFetch.ts` landed (2026-09-09) — see
    // `platform/wechat/weChatNetInstall.test.ts`, which drives delivery through that shim and
    // keeps this same inert case as its control. Either way the values stay as compiled in:
    // the same fail-safe state as an unreachable server, rather than a wrong number.
    const poller = installPublicFlags({
      baseUrl: 'https://bb.example.test',
      fetchImpl: undefined as unknown as typeof fetch,
      setIntervalImpl: () => 'timer',
      clearIntervalImpl: () => {},
    });
    // In this environment the global `fetch` exists, so the poller would otherwise use it.
    // Stubbing the global to undefined is what makes the WeChat case reachable at all.
    const real = globalThis.fetch;
    try {
      poller.stop();
      Object.defineProperty(globalThis, 'fetch', { value: undefined, configurable: true, writable: true });
      const inert = installPublicFlags({ baseUrl: 'https://bb.example.test', setIntervalImpl: () => 'timer', clearIntervalImpl: () => {} });
      expect(await inert.first).toBe(false);
      expect(await inert.refresh()).toBe(false);
      expect(inert.healthy()).toBe(false);
      expect(publicFlagsSnapshot()).toEqual(PUBLIC_FLAG_DEFAULTS);
    } finally {
      Object.defineProperty(globalThis, 'fetch', { value: real, configurable: true, writable: true });
    }
  });
});

describe('the production defaults, which every case above injects over', () => {
  // The gap class this closes has a name: a default every test overrides. Each of the three
  // seams below (`setInterval`, `clearInterval`, `console.warn`) exists so a test can drive
  // the poll without waiting five minutes — and injecting one in every case means the arm
  // that SHIPS is the arm nothing runs. `intervalMs` stays overridable here because the
  // alternative is a test that takes five minutes; the timer functions themselves are real.

  it('uses the real setInterval and clearInterval when none is injected', async () => {
    const f = scripted(
      () => json(BODY()),
      () => json(BODY({ 'ui.maintenanceBanner': 'from the real timer' })),
    );
    const poller = installPublicFlags({ baseUrl: 'https://bb.example.test', fetchImpl: f, intervalMs: 15 });
    await poller.first;
    expect(publicFlag('ui.maintenanceBanner')).toBe('');

    // The real interval fires and the real poll runs — not a hand-called `refresh()`.
    await vi.waitFor(() => expect(publicFlag('ui.maintenanceBanner')).toBe('from the real timer'), { timeout: 2000 });
    const afterFirstFire = f.calls.length;

    // And the real `clearInterval` actually stops it: no further fetch after `stop()`.
    poller.stop();
    await new Promise((r) => setTimeout(r, 60));
    expect(f.calls.length).toBe(afterFirstFire);
  });

  it('warns through console.warn when no warn is injected', async () => {
    // The default reaches the browser console, which `installClientLog` has wrapped by the
    // time this runs — so this arm is what puts a client's flag outage into the same log
    // store the services' own warning goes to. A test that always injects `warn` would
    // leave that path unrun.
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const poller = installPublicFlags({
        baseUrl: 'https://bb.example.test',
        fetchImpl: scripted(() => json(BODY()), () => Promise.reject(new Error('down'))),
        setIntervalImpl: () => 'timer',
        clearIntervalImpl: () => {},
      });
      await poller.first;          // healthy, so there is a transition to make
      await poller.refresh();      // the transition
      expect(spy).toHaveBeenCalledTimes(1);
      expect(String(spy.mock.calls[0]![0])).toContain('/client/flags');
    } finally {
      spy.mockRestore();
    }
  });

  it('is a no-op when stopped twice', async () => {
    // Reachable, and reached in real teardown: an entry point's shutdown and a test's
    // `afterEach` can both call it. `clearTimer` is a caller-supplied function, so handing
    // it a null handle is not something to find out about in production.
    const clearIntervalImpl = vi.fn();
    const poller = installPublicFlags({
      baseUrl: 'https://bb.example.test',
      fetchImpl: scripted(() => json(BODY())),
      setIntervalImpl: () => 'timer',
      clearIntervalImpl,
    });
    await poller.first;
    poller.stop();
    poller.stop();
    expect(clearIntervalImpl).toHaveBeenCalledTimes(1);
  });
});

describe('every way a poll can fail leaves the previous values', () => {
  /** The list, with a successful poll as the CONTROL — without which "the values did not
   *  change" is satisfied by a stub that never ran at all. */
  const FAILURES: Array<[string, () => Promise<Response> | Response]> = [
    ['a fetch that throws', () => Promise.reject(new Error('network down'))],
    ['a 404 from a deployment older than the route', () => new Response('not found', { status: 404 })],
    ['a 503 with an HTML body', () => new Response('<html>502 Bad Gateway</html>', { status: 503 })],
    ['a 200 whose body is not JSON', () => new Response('<html>hi</html>', { status: 200 })],
    ['a 200 with an empty body', () => new Response('', { status: 200 })],
    ['a body missing one name', () => json({ flags: { 'ads.rewardedOfferEnabled': false } })],
    ['a body with a banner over its cap', () => json(BODY({ 'ui.maintenanceBanner': 'x'.repeat(141) }))],
    ['a body with a wrongly-typed value', () => json({ flags: { ...PUBLIC_FLAG_DEFAULTS, 'ads.rewardedOfferEnabled': 'false' } })],
  ];

  for (const [label, answer] of FAILURES) {
    it(`keeps the last good values through ${label}`, async () => {
      const f = scripted(() => json(BODY({ 'ui.maintenanceBanner': 'set by an operator', 'ads.rewardedOfferEnabled': false })), answer);
      const poller = install(f, () => {});
      // The control: the boot poll succeeds, so there is something to lose.
      expect(await poller.first).toBe(true);
      expect(publicFlag('ui.maintenanceBanner')).toBe('set by an operator');
      expect(poller.healthy()).toBe(true);

      expect(await poller.refresh()).toBe(false);
      expect(publicFlag('ui.maintenanceBanner')).toBe('set by an operator');
      expect(publicFlag('ads.rewardedOfferEnabled')).toBe(false);
      expect(poller.healthy()).toBe(false);
    });
  }

  it('recovers on the next successful poll', async () => {
    const f = scripted(
      () => Promise.reject(new Error('down')),
      () => json(BODY({ 'ui.maintenanceBanner': 'back' })),
    );
    const poller = install(f, () => {});
    expect(await poller.first).toBe(false);
    expect(poller.healthy()).toBe(false);
    expect(await poller.refresh()).toBe(true);
    expect(poller.healthy()).toBe(true);
    expect(publicFlag('ui.maintenanceBanner')).toBe('back');
  });
});

describe('the warning line', () => {
  it('says nothing when the FIRST poll fails', async () => {
    // A dev client with no server behind it, and every offline player. Warning here would
    // put a line in the log store on every boot of every local client, which is how a log
    // store stops being read.
    const warn = vi.fn();
    const poller = install(scripted(() => Promise.reject(new Error('down'))), warn);
    await poller.first;
    await poller.refresh();
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns ONCE on the transition out of healthy, not once per cycle', async () => {
    const warn = vi.fn();
    const f = scripted(
      () => json(BODY()),
      () => Promise.reject(new Error('down')),
      () => Promise.reject(new Error('still down')),
    );
    const poller = install(f, warn);
    await poller.first;      // healthy
    await poller.refresh();  // transition — one line
    await poller.refresh();  // still down — silent
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('/client/flags');
    // The line has to say what the consequence IS, not just that a fetch failed: the values
    // in use are the ones this build shipped with.
    expect(warn.mock.calls[0]![0]).toMatch(/shipped/);
  });
});

describe('an overlapping poll cannot apply out of order', () => {
  it('drops a response that arrives after a NEWER fetch was issued', async () => {
    // Constructed rather than observed: a stalled fetch plus the next interval's. Without
    // the generation counter the older answer lands last and reverts the flag for a whole
    // five-minute window — a state nobody set, that resolves itself, and that no log line
    // would explain.
    let releaseFirst: (r: Response) => void = () => {};
    const first = new Promise<Response>((resolve) => {
      releaseFirst = resolve;
    });
    const f = scripted(
      () => json(BODY()),
      () => first,
      () => json(BODY({ 'ui.maintenanceBanner': 'the newer answer' })),
    );
    const poller = install(f, () => {});
    await poller.first;

    const slow = poller.refresh();
    const fresh = await poller.refresh();
    expect(fresh).toBe(true);
    expect(publicFlag('ui.maintenanceBanner')).toBe('the newer answer');

    // Now let the stale one land. It is a perfectly valid response, just an older one.
    releaseFirst(json(BODY({ 'ui.maintenanceBanner': 'the older answer' })) as Response);
    expect(await slow).toBe(false);
    expect(publicFlag('ui.maintenanceBanner')).toBe('the newer answer');
  });
});
