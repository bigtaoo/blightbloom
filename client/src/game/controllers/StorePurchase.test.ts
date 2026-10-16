/**
 * `StorePurchase` — the real-money flow (design/19-server-platform.md §4).
 *
 * This is the file that has to be right. Every other test in the store feature is about
 * shapes and pixels; these are the arms where the wrong answer either takes money and
 * delivers nothing, or delivers something and charges twice.
 *
 * All eight branches the flow admits are driven here with no network, no clock and no page —
 * which is the whole reason `StorePurchase` takes its wire calls, its session, its platform
 * gate, its ownership refresh AND its `sleep` as injected dependencies. `sleep` in
 * particular: without it the timed-out case is a 90-second test, so it would not exist.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { setUiAudio } from '../../audio/uiSound';
import { resetSessionCacheForTests, setSession } from '../../net/session';
import { StorePurchase, type StorePurchaseApi, type StorePurchaseDeps } from './StorePurchase';
import type { StoreOrder, StoreSku } from '../../net/billing';

const SESSION = { accountId: 'acct-1', username: 'alice', token: 'tok-1' };

const SKU: StoreSku = {
  sku: 'bp.cryobolt', title: 'Blueprint — Cryobolt', amountCents: 1200, currency: 'CNY',
  grants: [{ kind: 'blueprint', id: 'cryobolt' }],
};

const order = (state: StoreOrder['state']): StoreOrder =>
  ({ id: 'ord-1', sku: SKU.sku, platform: 'dev', amountCents: 1200, currency: 'CNY', state });

/** Cue log — the outcome-decides-the-sound convention (design/11) this class carries. */
function cueLog(): string[] {
  const log: string[] = [];
  setUiAudio({
    preload: async () => {}, play: (cue) => { log.push(cue); },
    setSfxVolume: () => {}, setMusicVolume: () => {}, updateMusic: () => {}, invalidateMusic: () => {}, resume: () => {},
  });
  return log;
}
afterEach(() => setUiAudio(null));

interface Over {
  api?: Partial<StorePurchaseApi>;
  deps?: Partial<StorePurchaseDeps>;
  /** Order states the poll sees, in order. Exhausted = keeps returning the last one. */
  poll?: StoreOrder['state'][];
}

function make(over: Over = {}) {
  const seen = over.poll ?? ['settled'];
  let tick = 0;
  const api: StorePurchaseApi = {
    listSkus: vi.fn(async () => [SKU]),
    createOrder: vi.fn(async () => ({ order: order('created'), payment: { configured: true, params: {} } })),
    fetchOrder: vi.fn(async () => order(seen[Math.min(tick++, seen.length - 1)]!)),
    ...over.api,
  };
  const refreshOwnership = vi.fn(async () => {});
  const sleep = vi.fn(async () => {});
  const deps: StorePurchaseDeps = {
    baseUrl: () => 'http://mm',
    session: () => SESSION,
    platform: () => 'dev',
    api,
    refreshOwnership,
    sleep,
    pollIntervalMs: 10,
    pollTimeoutMs: 50, // → 5 attempts, so an exhausted poll is countable
    ...over.deps,
  };
  return { p: new StorePurchase(deps), api, refreshOwnership, sleep, deps };
}

describe('the refusals that happen before any money moves', () => {
  it('a GUEST is refused, and no order is booked', () => {
    // Entitlements are account-bound (design/19 §2). Booking one for a guest would recreate
    // the exact scaffold this whole pass replaced: ownership with nothing to attach it to.
    const log = cueLog();
    const t = make({ deps: { session: () => null } });
    return t.p.buy(SKU.sku).then((r) => {
      expect(r).toEqual({ ok: false, code: 'not-logged-in' });
      expect(t.api.createOrder).not.toHaveBeenCalled();
      expect(log).toEqual(['ui.denied']);
    });
  });

  it('a platform that may not sell is refused, and no order is booked', async () => {
    // The fail-closed backstop behind `Forge.storeEnabled`: even reached directly, this
    // never names a platform the gate said no to.
    const t = make({ deps: { platform: () => null } });
    expect(await t.p.buy(SKU.sku)).toEqual({ ok: false, code: 'no-platform' });
    expect(t.api.createOrder).not.toHaveBeenCalled();
  });

  it('checks the platform BEFORE the session — the harder rule wins', async () => {
    // A guest on a build that may not sell gets `no-platform`, not `not-logged-in`. The
    // difference matters because "log in first" invites them to try again.
    const t = make({ deps: { platform: () => null, session: () => null } });
    expect(await t.p.buy(SKU.sku)).toEqual({ ok: false, code: 'no-platform' });
  });
});

describe('booking the order', () => {
  it('names the SKU and the resolved platform, and nothing else', async () => {
    const t = make();
    await t.p.buy(SKU.sku);
    expect(t.api.createOrder).toHaveBeenCalledWith('http://mm', 'tok-1', SKU.sku, 'dev');
  });

  it('reads baseUrl LAZILY, so a `?mm=` override that lands late still applies', async () => {
    let base = 'http://stale';
    const t = make({ deps: { baseUrl: () => base } });
    base = 'http://real';
    await t.p.buy(SKU.sku);
    expect(t.api.createOrder).toHaveBeenCalledWith('http://real', 'tok-1', SKU.sku, 'dev');
  });

  it('a rejected order (a 400) is `order-failed`, and carries the reason for the log', async () => {
    const log = cueLog();
    const t = make({ api: { createOrder: vi.fn(async () => { throw new Error('unknown sku'); }) } });
    const r = await t.p.buy('bp.nope');
    expect(r).toEqual({ ok: false, code: 'order-failed', detail: 'unknown sku' });
    expect(t.api.fetchOrder).not.toHaveBeenCalled(); // nothing to poll for
    expect(log).toEqual(['ui.denied']);
  });
});

describe('payment.configured === false', () => {
  it('refuses explicitly, and does NOT poll an order nobody can pay', async () => {
    // `paymentParams.ts`'s own header is the argument: four of five platforms have no
    // merchant credentials, so this is the normal answer, not an error — and it must be
    // said plainly rather than silently failing or pretending to succeed.
    const log = cueLog();
    const t = make({
      api: { createOrder: vi.fn(async () => ({ order: order('created'), payment: { configured: false, params: {}, note: 'stripe: no merchant credentials configured' } })) },
    });
    const r = await t.p.buy(SKU.sku);
    expect(r).toEqual({ ok: false, code: 'not-configured', detail: 'stripe: no merchant credentials configured' });
    expect(t.api.fetchOrder).not.toHaveBeenCalled();
    expect(t.sleep).not.toHaveBeenCalled();
    expect(log).toEqual(['ui.denied']);
    expect(t.refreshOwnership).not.toHaveBeenCalled(); // and nothing was delivered
  });

  it('carries no detail when the server sent no note', async () => {
    const t = make({ api: { createOrder: vi.fn(async () => ({ order: order('created'), payment: { configured: false, params: {} } })) } });
    expect(await t.p.buy(SKU.sku)).toEqual({ ok: false, code: 'not-configured', detail: undefined });
  });
});

describe('the checkout handoff (design/22 §1.1)', () => {
  const PAID = { configured: true, params: { priceId: 'pri_1', customDataOrderId: 'ord-1', clientToken: 'test_t' } };
  const paddleOrder = { api: { createOrder: vi.fn(async () => ({ order: order('created'), payment: PAID })) } };

  it('hands the platform and the payment block to the checkout, then polls', async () => {
    const checkout = vi.fn(async () => 'completed' as const);
    const onConfirming = vi.fn();
    const t = make({ ...paddleOrder, deps: { platform: () => 'paddle', checkout } });
    expect(await t.p.buy(SKU.sku, { onConfirming })).toEqual({ ok: true, sku: SKU.sku, refreshed: true });
    expect(checkout).toHaveBeenCalledWith('paddle', PAID);
    expect(onConfirming).toHaveBeenCalledTimes(1);
    expect(t.api.fetchOrder).toHaveBeenCalled();
  });

  it('the pending state is announced BEFORE the first poll, not after', async () => {
    const seq: string[] = [];
    const t = make({
      api: { fetchOrder: vi.fn(async () => { seq.push('poll'); return order('settled'); }) },
      deps: { checkout: async () => 'completed' },
    });
    await t.p.buy(SKU.sku, { onConfirming: () => seq.push('confirming') });
    expect(seq).toEqual(['confirming', 'poll']);
  });

  it.each([
    ['closed', 'checkout-closed'],
    ['unavailable', 'checkout-unavailable'],
  ] as const)('a checkout that ends %s is %s: nothing is polled, nothing re-read, ui.denied', async (outcome, code) => {
    const log = cueLog();
    const onConfirming = vi.fn();
    const t = make({ deps: { checkout: async () => outcome } });
    expect(await t.p.buy(SKU.sku, { onConfirming })).toEqual({ ok: false, code });
    expect(t.api.fetchOrder).not.toHaveBeenCalled();
    expect(t.refreshOwnership).not.toHaveBeenCalled();
    expect(onConfirming).not.toHaveBeenCalled();
    expect(log).toEqual(['ui.denied']);
    expect(t.p.inFlight).toBe(false);
  });

  it('is never reached for an order that cannot be paid', async () => {
    const checkout = vi.fn(async () => 'completed' as const);
    const t = make({
      api: { createOrder: vi.fn(async () => ({ order: order('created'), payment: { configured: false, params: {} } })) },
      deps: { checkout },
    });
    expect((await t.p.buy(SKU.sku)).ok).toBe(false);
    expect(checkout).not.toHaveBeenCalled();
  });

  it('without a checkout (the dev stub) goes straight to the poll, still announcing it', async () => {
    const onConfirming = vi.fn();
    const t = make();
    expect((await t.p.buy(SKU.sku, { onConfirming })).ok).toBe(true);
    expect(onConfirming).toHaveBeenCalledTimes(1);
  });
});

describe('polling the order', () => {
  it('settles, then re-reads what the account owns', async () => {
    const log = cueLog();
    const t = make({ poll: ['created', 'created', 'settled'] });
    expect(await t.p.buy(SKU.sku)).toEqual({ ok: true, sku: SKU.sku, refreshed: true });
    expect(t.api.fetchOrder).toHaveBeenCalledTimes(3);
    expect(t.api.fetchOrder).toHaveBeenLastCalledWith('http://mm', 'tok-1', 'ord-1');
    expect(t.refreshOwnership).toHaveBeenCalledTimes(1);
    expect(log).toEqual(['ui.tap']);
  });

  it('waits between polls rather than spinning', async () => {
    const t = make({ poll: ['created', 'settled'] });
    await t.p.buy(SKU.sku);
    expect(t.sleep).toHaveBeenCalledTimes(2);
    expect(t.sleep).toHaveBeenCalledWith(10);
  });

  it('a FAILED order is `payment-failed`, and nothing is re-read', async () => {
    const log = cueLog();
    const t = make({ poll: ['created', 'failed'] });
    expect(await t.p.buy(SKU.sku)).toEqual({ ok: false, code: 'payment-failed' });
    expect(t.refreshOwnership).not.toHaveBeenCalled();
    expect(log).toEqual(['ui.denied']);
  });

  it('stops at the first terminal state — it does not keep polling a settled order', async () => {
    const t = make({ poll: ['settled', 'failed'] });
    expect((await t.p.buy(SKU.sku)).ok).toBe(true);
    expect(t.api.fetchOrder).toHaveBeenCalledTimes(1);
  });

  it('an order still open when the budget runs out is `timed-out`, NOT a failure', async () => {
    // The copy for this arm says "check back later" on purpose: a slow platform callback can
    // still settle it minutes from now, and the next login re-reads entitlements anyway.
    // Calling it a failure would tell someone their money is gone when it may not be.
    const log = cueLog();
    const t = make({ poll: ['created'] });
    expect(await t.p.buy(SKU.sku)).toEqual({ ok: false, code: 'timed-out' });
    expect(t.api.fetchOrder).toHaveBeenCalledTimes(5); // 50ms budget / 10ms interval
    expect(t.refreshOwnership).not.toHaveBeenCalled();
    expect(log).toEqual(['ui.denied']);
  });

  it('always polls at least once, however small the budget is', async () => {
    const t = make({ poll: ['settled'], deps: { pollIntervalMs: 1000, pollTimeoutMs: 1 } });
    expect((await t.p.buy(SKU.sku)).ok).toBe(true);
    expect(t.api.fetchOrder).toHaveBeenCalledTimes(1);
  });

  it('RETRIES a thrown poll instead of abandoning a possibly-paid order', async () => {
    // The worst available answer to one dropped request is "your purchase failed". A
    // transient error costs an attempt from the budget and nothing else.
    let call = 0;
    const t = make({
      api: {
        fetchOrder: vi.fn(async () => {
          call++;
          if (call <= 2) throw new Error('network down');
          return order('settled');
        }),
      },
    });
    expect(await t.p.buy(SKU.sku)).toEqual({ ok: true, sku: SKU.sku, refreshed: true });
    expect(t.api.fetchOrder).toHaveBeenCalledTimes(3);
  });

  it('a poll that throws for the whole budget times out rather than hanging', async () => {
    const t = make({ api: { fetchOrder: vi.fn(async () => { throw new Error('network down'); }) } });
    expect(await t.p.buy(SKU.sku)).toEqual({ ok: false, code: 'timed-out' });
    expect(t.api.fetchOrder).toHaveBeenCalledTimes(5);
  });
});

describe('delivered, but the ownership re-read failed', () => {
  it('still reports SUCCESS — the money moved and the entitlement exists', async () => {
    // The arm that would be unreachable if this class reused `syncMetaWithSession`, which
    // swallows its own errors. Reporting a failure here tells someone a purchase they paid
    // for did not happen; the honest line is "bought, it will be there next login".
    const log = cueLog();
    const t = make({ deps: { refreshOwnership: vi.fn(async () => { throw new Error('offline'); }) } });
    expect(await t.p.buy(SKU.sku)).toEqual({ ok: true, sku: SKU.sku, refreshed: false });
    expect(log).toEqual(['ui.tap']); // ...and it SOUNDS like a success, because it is one
  });

  it('the two success arms differ only in `refreshed`', async () => {
    const ok = await make().p.buy(SKU.sku);
    const stale = await make({ deps: { refreshOwnership: vi.fn(async () => { throw new Error('offline'); }) } }).p.buy(SKU.sku);
    expect(ok).toEqual({ ok: true, sku: SKU.sku, refreshed: true });
    expect(stale).toEqual({ ok: true, sku: SKU.sku, refreshed: false });
  });
});

describe('the re-entrancy guard — a payment button really does get double-tapped', () => {
  it('the SECOND of two rapid taps books nothing', async () => {
    const log = cueLog();
    const t = make({ poll: ['created', 'settled'] });
    const first = t.p.buy(SKU.sku);
    const second = t.p.buy(SKU.sku); // not awaited in between — this is the double tap
    expect(await second).toEqual({ ok: false, code: 'busy' });
    expect(await first).toEqual({ ok: true, sku: SKU.sku, refreshed: true });
    // The assertion that matters: ONE order, not two. A second order is a second charge.
    expect(t.api.createOrder).toHaveBeenCalledTimes(1);
    expect(log).toEqual(['ui.denied', 'ui.tap']); // the swallowed tap says so, and the real one lands
  });

  it('reports `inFlight` while an order is open, and clears after', async () => {
    const t = make();
    expect(t.p.inFlight).toBe(false);
    const buying = t.p.buy(SKU.sku);
    expect(t.p.inFlight).toBe(true);
    await buying;
    expect(t.p.inFlight).toBe(false);
  });

  it.each([
    ['a rejected order', { api: { createOrder: vi.fn(async () => { throw new Error('nope'); }) } } as Over],
    ['an unconfigured platform', { api: { createOrder: vi.fn(async () => ({ order: order('created'), payment: { configured: false, params: {} } })) } } as Over],
    ['a failed payment', { poll: ['failed'] } as Over],
    ['a timeout', { poll: ['created'] } as Over],
    ['a broken ownership refresh', { deps: { refreshOwnership: vi.fn(async () => { throw new Error('offline'); }) } } as Over],
  ])('clears the guard after %s, so the next press is not locked out', async (_why, over) => {
    // A guard that leaks on one arm makes the store permanently dead after one bad press,
    // and only on that arm — the shape of bug that ships.
    const t = make(over);
    await t.p.buy(SKU.sku);
    expect(t.p.inFlight).toBe(false);
    await t.p.buy(SKU.sku);
    expect((t.api.createOrder as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
  });

  it('the guard is shared with the catalogue load — one screen, one operation', async () => {
    const t = make();
    const buying = t.p.buy(SKU.sku);
    expect(await t.p.loadCatalog()).toEqual({ ok: false, code: 'busy' });
    await buying;
  });
});

describe('loadCatalog', () => {
  it('returns the server listing under the player token', async () => {
    const t = make();
    expect(await t.p.loadCatalog()).toEqual({ ok: true, skus: [SKU] });
    expect(t.api.listSkus).toHaveBeenCalledWith('http://mm', 'tok-1');
  });

  it('refuses a guest and a non-selling platform without calling out', async () => {
    const guest = make({ deps: { session: () => null } });
    expect(await guest.p.loadCatalog()).toEqual({ ok: false, code: 'not-logged-in' });
    expect(guest.api.listSkus).not.toHaveBeenCalled();

    const nowhere = make({ deps: { platform: () => null } });
    expect(await nowhere.p.loadCatalog()).toEqual({ ok: false, code: 'no-platform' });
    expect(nowhere.api.listSkus).not.toHaveBeenCalled();
  });

  it('reports a failed listing rather than an empty store', async () => {
    // "Nothing is for sale" and "we could not ask" are different sentences, and only one of
    // them tells the player to try again.
    const t = make({ api: { listSkus: vi.fn(async () => { throw new Error('502'); }) } });
    expect(await t.p.loadCatalog()).toEqual({ ok: false, code: 'list-failed', detail: '502' });
  });

  it('plays NO cue — nobody pressed anything', async () => {
    // Cues belong to a press. `show()` kicks this on its own, and a screen that chirped on
    // open would be a cue with no finger behind it.
    const log = cueLog();
    await make().p.loadCatalog();
    await make({ api: { listSkus: vi.fn(async () => { throw new Error('502'); }) } }).p.loadCatalog();
    expect(log).toEqual([]);
  });
});

describe('the defaults', () => {
  // The production construction path: `gameAssembly.ts` injects neither `api` nor `session`,
  // so without these two cases the default arm of each `??` is dead in the suite.
  function defaulted(platform: 'dev' | null) {
    return new StorePurchase({
      baseUrl: () => 'http://mm',
      platform: () => platform,
      refreshOwnership: () => Promise.resolve(),
      sleep: () => Promise.resolve(),
    });
  }

  it('reads the REAL session when none is injected', async () => {
    // No `session` dep, so this goes through `net/session.ts`. Under vitest there is no
    // localStorage, so the store reads as logged out — which is the assertion: the default
    // is the real reader, and a logged-out real reader refuses rather than throwing.
    resetSessionCacheForTests();
    expect(await defaulted('dev').buy(SKU.sku)).toEqual({ ok: false, code: 'not-logged-in' });

    // ...and the control, so the case above cannot pass by the reader being broken: with a
    // session set, the same construction gets past the guard and tries to reach the network.
    setSession({ ...SESSION });
    await expect(defaulted('dev').buy(SKU.sku)).resolves.toMatchObject({ ok: false, code: 'order-failed' });
    setSession(null);
    resetSessionCacheForTests();
  });

  it('refuses on a non-selling platform before touching any default at all', async () => {
    expect(defaulted(null).inFlight).toBe(false);
    expect(await defaulted(null).buy(SKU.sku)).toEqual({ ok: false, code: 'no-platform' });
  });
});
