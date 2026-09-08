/**
 * Daily reconciliation (design/19 §7, ROADMAP 8.5) — `billsvc/reconcile.ts`, its port
 * (`iap/types.ts`, `iap/factory.ts`) and the dev platform's authored order book.
 *
 * WHAT THIS SUITE IS CAREFUL ABOUT. This project has no merchant account on any real platform,
 * so there is a standing temptation to write a reconciliation test that passes because nothing
 * was compared. Three cases exist specifically to make that impossible:
 *
 *   'a platform that cannot be asked lands in unreconciled, not in a clean report' — the
 *   difference between "nothing wrong" and "did not look", which is the whole honesty problem.
 *
 *   'complete is false whenever ANY platform refused' — asserted separately from
 *   `differenceCount`, because a caller reading only the count is the misreading.
 *
 *   'the dev platform refuses when the stub is off' and '...when no book is configured' — the
 *   two ways the one platform that CAN answer stops being able to, both of which must refuse
 *   rather than return an empty list.
 *
 * The local side is driven through the real `BillingService` wherever a settled order is
 * needed, so `localSettledOrders` is reading rows `settle` actually wrote rather than rows this
 * file invented.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { openBillingDb } from '../src/billingDb';
import { BillingService } from '../src/billsvc/BillingService';
import { createPlatformOrderLister, createBillingAdapters, createReceiptVerifier } from '../src/billsvc/iap/factory';
import { DevStubOrderBook } from '../src/billsvc/iap/devStub';
import type { PlatformOrder, PlatformOrderLister } from '../src/billsvc/iap/types';
import {
  DAY_MS,
  RECONCILED_PLATFORMS,
  dailyWindow,
  diffOrders,
  formatReconcileReport,
  localSettledOrders,
  parsePlatformList,
  reconcileWindow,
  type LocalSettledOrder,
} from '../src/billsvc/reconcile';

const SKU = 'bp.cannon';
const SKU_PRICE = 1800;
const DEV_ENV = { BB_BILLING_DEV_STUB: '1' };

let db: DatabaseSync;
let clock = 1_000;
let ids = 0;

beforeEach(() => {
  db = openBillingDb(':memory:');
  clock = 1_000;
  ids = 0;
});
afterEach(() => {
  db.close();
});

function service(): BillingService {
  return new BillingService({
    db,
    verify: createReceiptVerifier(DEV_ENV),
    nowMs: () => clock,
    newOrderId: () => `o-${++ids}`,
  });
}

/** Book an order and settle it through the real path, returning the order id. */
async function settled(txnId: string, at: number, sku = SKU): Promise<string> {
  const svc = service();
  clock = at;
  const created = svc.createOrder({ accountId: 'acc-1', sku, platform: 'dev' });
  if (!created.ok) throw new Error(created.error);
  const res = await svc.settle({ platform: 'dev', orderId: created.order.id, receipt: `product:${sku}`, txnId });
  if (!res.ok) throw new Error(res.reason);
  return created.order.id;
}

function local(over: Partial<LocalSettledOrder> = {}): LocalSettledOrder {
  return {
    orderId: 'o-1',
    accountId: 'acc-1',
    sku: SKU,
    platform: 'dev',
    amountCents: SKU_PRICE,
    currency: 'CNY',
    platformTxnId: 'txn-1',
    settledAt: 5_000,
    ...over,
  };
}

function remote(over: Partial<PlatformOrder> = {}): PlatformOrder {
  return { platformTxnId: 'txn-1', product: SKU, amountCents: SKU_PRICE, currency: 'CNY', settledAt: 5_000, ...over };
}

describe('diffOrders — the three difference classes', () => {
  it('reports nothing when both sides agree', () => {
    const report = diffOrders('dev', [local()], [remote()]);
    expect(report.differences).toEqual([]);
    expect(report.matched).toBe(1);
    expect(report.localCount).toBe(1);
    expect(report.platformCount).toBe(1);
  });

  it('local-not-on-platform: a settled order the platform does not list', () => {
    const report = diffOrders('dev', [local({ platformTxnId: 'txn-only-here' })], []);
    expect(report.matched).toBe(0);
    expect(report.differences).toHaveLength(1);
    expect(report.differences[0]!.kind).toBe('local-not-on-platform');
    expect(report.differences[0]!.orderId).toBe('o-1');
    expect(report.differences[0]!.accountId).toBe('acc-1');
    expect(report.differences[0]!.detail).toContain('txn-only-here');
  });

  it('platform-not-local: the platform charged and this server has nothing — the loudest class', () => {
    // THE tear design/19 §4 leaves open. Nothing inside the billing file can notice it, which
    // is the entire reason this comparison exists.
    const report = diffOrders('dev', [], [remote({ platformTxnId: 'txn-lost', merchantOrderId: 'o-99' })]);
    expect(report.differences).toHaveLength(1);
    const d = report.differences[0]!;
    expect(d.kind).toBe('platform-not-local');
    expect(d.platformTxnId).toBe('txn-lost');
    // The merchant order the PLATFORM named, carried through so a human has something to grep.
    expect(d.orderId).toBe('o-99');
    // Never guessed: the platform does not know this server's account ids, and the order may
    // not exist here at all — which is the finding.
    expect(d.accountId).toBeNull();
    expect(d.detail).toContain('may have paid and received nothing');
  });

  it('platform-not-local survives a platform that reports no merchant order id', () => {
    const report = diffOrders('dev', [], [{ platformTxnId: 'txn-x', product: SKU, settledAt: 1 }]);
    expect(report.differences[0]!.orderId).toBeNull();
    expect(report.differences[0]!.detail).not.toContain('undefined');
  });

  it('sku-mismatch: same transaction, different product', () => {
    const report = diffOrders('dev', [local()], [remote({ product: 'bp.seeker' })]);
    expect(report.matched).toBe(1); // it MATCHED, and then disagreed
    expect(report.differences.map((d) => d.kind)).toEqual(['sku-mismatch']);
    expect(report.differences[0]!.detail).toContain('bp.seeker');
  });

  it('amount-mismatch: same transaction, different money', () => {
    const report = diffOrders('dev', [local()], [remote({ amountCents: 1 })]);
    expect(report.differences.map((d) => d.kind)).toEqual(['amount-mismatch']);
    expect(report.differences[0]!.detail).toContain('1800');
    expect(report.differences[0]!.detail).toContain(' 1 ');
  });

  it('reports BOTH when the amount and the SKU disagree at once', () => {
    // Two findings rather than one combined "mismatch": they mean different things to whoever
    // reads them, and a SKU disagreement with a matching price is a different incident from a
    // price disagreement on the right SKU.
    const report = diffOrders('dev', [local()], [remote({ product: 'bp.seeker', amountCents: 1 })]);
    expect(report.differences.map((d) => d.kind).sort()).toEqual(['amount-mismatch', 'sku-mismatch']);
  });

  it('reports NO amount finding when the platform did not report an amount', () => {
    // The load-bearing optional. WeChat's bill does not carry one on every row, and a
    // comparison against a missing value would turn every such row into a difference — a
    // reconciliation that always fires is one nobody reads. Silence is not agreement, but it
    // is also not evidence.
    const report = diffOrders('dev', [local()], [{ platformTxnId: 'txn-1', product: SKU, settledAt: 5_000 }]);
    expect(report.differences).toEqual([]);
    expect(report.matched).toBe(1);
  });

  it('reports an amount mismatch even when the platform names no currency', () => {
    // `amountCents` and `currency` are independently optional. A platform that reports the
    // money but not the unit still gets its money compared — the detail line just has nothing
    // to put after the number, and must not print 'undefined' there.
    const report = diffOrders('dev', [local()], [{ platformTxnId: 'txn-1', product: SKU, amountCents: 1, settledAt: 5_000 }]);
    expect(report.differences.map((d) => d.kind)).toEqual(['amount-mismatch']);
    expect(report.differences[0]!.detail).not.toContain('undefined');
    expect(report.differences[0]!.detail).toMatch(/platform 1$/);
  });

  it('an amount of ZERO is compared, not skipped', () => {
    // `!== undefined` rather than a truthiness check: a platform reporting 0 for an order this
    // server booked at 1800 is exactly the difference worth catching, and `if (remote.amount)`
    // would drop it.
    const report = diffOrders('dev', [local()], [remote({ amountCents: 0 })]);
    expect(report.differences.map((d) => d.kind)).toEqual(['amount-mismatch']);
  });

  it('handles both directions at once without double-counting the matched rows', () => {
    const report = diffOrders(
      'dev',
      [local({ orderId: 'o-a', platformTxnId: 'txn-a' }), local({ orderId: 'o-b', platformTxnId: 'txn-b' })],
      [remote({ platformTxnId: 'txn-b' }), remote({ platformTxnId: 'txn-c' })],
    );
    expect(report.matched).toBe(1);
    expect(report.differences.map((d) => `${d.kind}:${d.platformTxnId}`).sort()).toEqual([
      'local-not-on-platform:txn-a',
      'platform-not-local:txn-c',
    ]);
  });
});

describe('localSettledOrders', () => {
  it('reads what `settle` actually wrote, and only settled rows', async () => {
    const orderId = await settled('txn-real', 5_000);
    // An order that was created and never settled must not appear: it has no platform txn id,
    // so it cannot be joined, and reporting it would make every abandoned checkout a finding.
    service().createOrder({ accountId: 'acc-1', sku: SKU, platform: 'dev' });

    const rows = localSettledOrders(db, 'dev', 0, 10_000);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.orderId).toBe(orderId);
    expect(rows[0]!.platformTxnId).toBe('txn-real');
    expect(rows[0]!.amountCents).toBe(SKU_PRICE);
    expect(rows[0]!.settledAt).toBe(5_000);
  });

  it('windows on SETTLED_AT and is half-open', async () => {
    await settled('txn-in', 5_000);
    // Exactly on `until` is EXCLUDED, exactly on `since` is INCLUDED — so two consecutive daily
    // windows never both claim one order, and never both miss it.
    expect(localSettledOrders(db, 'dev', 5_000, 5_001)).toHaveLength(1);
    expect(localSettledOrders(db, 'dev', 4_000, 5_000)).toHaveLength(0);
    expect(localSettledOrders(db, 'dev', 5_001, 9_000)).toHaveLength(0);
  });

  it('filters by platform', async () => {
    await settled('txn-dev', 5_000);
    expect(localSettledOrders(db, 'stripe', 0, 10_000)).toEqual([]);
  });

  it('skips a hand-edited settled row whose platform_txn_id is NULL', async () => {
    // The join key. A NULL sneaking through — the sqlite3-prompt posture design/19 §8 plans
    // for — would otherwise be compared against every platform row at once.
    await settled('txn-real', 5_000);
    db.exec(`UPDATE orders SET platform_txn_id = NULL`);
    expect(localSettledOrders(db, 'dev', 0, 10_000)).toEqual([]);
  });
});

describe('reconcileWindow — and what it refuses to claim', () => {
  const alwaysEmpty: PlatformOrderLister = async () => ({ ok: true, orders: [] });

  it('a platform that cannot be asked lands in unreconciled, NOT in a clean report', async () => {
    const listOrders: PlatformOrderLister = async (platform) =>
      platform === 'dev' ? { ok: true, orders: [] } : { ok: false, reason: `${platform}: no credential` };
    const report = await reconcileWindow({ db, listOrders }, 0, DAY_MS);

    expect(report.platforms.map((p) => p.platform)).toEqual(['dev']);
    expect(report.unreconciled.map((u) => u.platform)).toEqual(['apple', 'google', 'wechat', 'stripe']);
    expect(report.complete).toBe(false);
    // The trap this whole module is shaped around: zero differences AND not reconciled.
    expect(report.differenceCount).toBe(0);
  });

  it('complete is true only when EVERY platform asked for actually answered', async () => {
    const report = await reconcileWindow({ db, listOrders: alwaysEmpty }, 0, DAY_MS);
    expect(report.complete).toBe(true);
    expect(report.unreconciled).toEqual([]);
    expect(report.platforms).toHaveLength(RECONCILED_PLATFORMS.length);
  });

  it('a port that THROWS is one unreconciled platform, not an abandoned run', async () => {
    // A real adapter is an HTTPS call; one platform's DNS failure must not lose the other four.
    // Same reasoning as `BillingService.settle`'s try around the verifier.
    const listOrders: PlatformOrderLister = async (platform) => {
      if (platform === 'wechat') throw new Error('getaddrinfo ENOTFOUND');
      return { ok: true, orders: [] };
    };
    const report = await reconcileWindow({ db, listOrders }, 0, DAY_MS);
    expect(report.platforms).toHaveLength(4);
    expect(report.unreconciled).toHaveLength(1);
    expect(report.unreconciled[0]!.reason).toContain('ENOTFOUND');
    expect(report.complete).toBe(false);
  });

  it('honours an explicit platform list', async () => {
    const asked: string[] = [];
    const listOrders: PlatformOrderLister = async (platform) => {
      asked.push(platform);
      return { ok: true, orders: [] };
    };
    await reconcileWindow({ db, listOrders, platforms: ['dev'] }, 0, DAY_MS);
    expect(asked).toEqual(['dev']);
  });

  it('finds a real difference end to end, through settle and the dev order book', async () => {
    await settled('txn-known', 5_000);
    // A different SKU, because the dev receipt IS `product:<sku>` and the receipt row's own
    // primary key is claimed too (design/19 §4 AMENDMENT 1) — two orders redeeming one stub
    // receipt is a replay, not a second settlement.
    await settled('txn-vanished', 6_000, 'bp.seeker');
    const book = new DevStubOrderBook();
    book.record(remote({ platformTxnId: 'txn-known', settledAt: 5_000 }));
    book.record(remote({ platformTxnId: 'txn-never-seen-here', settledAt: 7_000 }));

    const report = await reconcileWindow(
      { db, listOrders: createPlatformOrderLister(DEV_ENV, book), platforms: ['dev'] },
      0,
      DAY_MS,
    );
    expect(report.complete).toBe(true);
    expect(report.differenceCount).toBe(2);
    expect(report.platforms[0]!.matched).toBe(1);
    expect(report.platforms[0]!.differences.map((d) => `${d.kind}:${d.platformTxnId}`).sort()).toEqual([
      'local-not-on-platform:txn-vanished',
      'platform-not-local:txn-never-seen-here',
    ]);
  });
});

describe('the dev platform port', () => {
  it('refuses when the dev stub is OFF', async () => {
    // Not an empty list. "The stub is disabled" and "the platform charged nothing" are
    // different facts and only one of them is evidence.
    const lister = createPlatformOrderLister({}, new DevStubOrderBook());
    const res = await lister('dev', 0, DAY_MS);
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.reason).toContain('disabled');
  });

  it('refuses in production even with the flag set and a book present', async () => {
    const lister = createPlatformOrderLister(
      { NODE_ENV: 'production', BB_BILLING_DEV_STUB: '1' },
      new DevStubOrderBook(),
    );
    expect((await lister('dev', 0, DAY_MS)).ok).toBe(false);
  });

  it('refuses when the stub is on but NO book is configured', async () => {
    const res = await createPlatformOrderLister(DEV_ENV)('dev', 0, DAY_MS);
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.reason).toContain('no order book');
  });

  it('answers with an EMPTY list when a book is configured and holds nothing', async () => {
    // The one case that is genuinely "asked, and there was nothing" — and it must be
    // distinguishable from all three refusals above.
    const res = await createPlatformOrderLister(DEV_ENV, new DevStubOrderBook())('dev', 0, DAY_MS);
    expect(res).toEqual({ ok: true, orders: [] });
  });

  it('all four real platforms refuse, with or without credentials', async () => {
    // design/19 §9: no merchant account exists, so an adapter that reported `ok` would be
    // lying. Both arms — the missing credential and the unimplemented round trip.
    const bare = createPlatformOrderLister({});
    const configured = createPlatformOrderLister({
      BB_APPLE_SHARED_SECRET: 's',
      BB_GOOGLE_SERVICE_ACCOUNT_JSON: '{}',
      BB_GOOGLE_PACKAGE_NAME: 'p',
      BB_WECHAT_MCH_ID: 'm',
      BB_WECHAT_API_V3_KEY: 'k',
      BB_STRIPE_SECRET_KEY: 'sk',
    });
    for (const platform of ['apple', 'google', 'wechat', 'stripe'] as const) {
      const missing = await bare(platform, 0, DAY_MS);
      expect(missing.ok, platform).toBe(false);
      expect(missing.ok === false && missing.reason).toContain('not configured');
      const present = await configured(platform, 0, DAY_MS);
      expect(present.ok, platform).toBe(false);
      expect(present.ok === false && present.reason).toContain('not implemented');
    }
  });

  it('google refuses on a missing package name even with the service account present', async () => {
    const res = await createPlatformOrderLister({ BB_GOOGLE_SERVICE_ACCOUNT_JSON: '{}' })('google', 0, DAY_MS);
    expect(res.ok === false && res.reason).toContain('package name');
  });

  it('wechat refuses on a missing APIv3 key even with the merchant id present', async () => {
    const res = await createPlatformOrderLister({ BB_WECHAT_MCH_ID: 'm' })('wechat', 0, DAY_MS);
    expect(res.ok === false && res.reason).toContain('APIv3 key');
  });

  it('createBillingAdapters gives the verifier and the lister the SAME book', async () => {
    const adapters = createBillingAdapters(DEV_ENV);
    expect(adapters.devOrderBook).toBeDefined();
    adapters.devOrderBook!.record(remote({ settledAt: 10 }));
    const listing = await adapters.listOrders('dev', 0, 100);
    expect(listing.ok && listing.orders).toHaveLength(1);
    // And the verifier from the same call still resolves stub receipts.
    expect(await adapters.verify('dev', `product:${SKU}`)).toEqual({ ok: true, product: SKU });
  });

  it('createBillingAdapters builds NO book when the stub is off', () => {
    expect(createBillingAdapters({}).devOrderBook).toBeUndefined();
    expect(createBillingAdapters({ NODE_ENV: 'production', BB_BILLING_DEV_STUB: '1' }).devOrderBook).toBeUndefined();
  });
});

describe('DevStubOrderBook', () => {
  it('windows half-open, matching the port contract', () => {
    const book = new DevStubOrderBook();
    book.record(remote({ platformTxnId: 'a', settledAt: 100 }));
    book.record(remote({ platformTxnId: 'b', settledAt: 200 }));
    const listing = book.list(100, 200);
    expect(listing.ok && listing.orders.map((o) => o.platformTxnId)).toEqual(['a']);
  });

  it('replaces rather than duplicates an entry with the same transaction id', () => {
    const book = new DevStubOrderBook();
    book.record(remote({ platformTxnId: 'a', amountCents: 1 }));
    book.record(remote({ platformTxnId: 'a', amountCents: 2 }));
    expect(book.size).toBe(1);
    const listing = book.list(0, DAY_MS);
    expect(listing.ok && listing.orders[0]!.amountCents).toBe(2);
  });

  it('forget stages "the platform never saw this one", and reports whether it did anything', () => {
    const book = new DevStubOrderBook();
    book.record(remote({ platformTxnId: 'a' }));
    expect(book.forget('a')).toBe(true);
    expect(book.forget('a')).toBe(false);
    expect(book.size).toBe(0);
  });

  it('clear empties it', () => {
    const book = new DevStubOrderBook();
    book.record(remote());
    book.clear();
    expect(book.size).toBe(0);
  });

  it('sorts by settledAt then transaction id, so a report is deterministic', () => {
    // Enough entries sharing a timestamp that the tie-break is exercised in BOTH directions —
    // with two, `Array.prototype.sort` may only ever ask the comparator one way round, and the
    // other arm would go untested while the assertion still passed.
    const book = new DevStubOrderBook();
    for (const id of ['z', 'a', 'q', 'b']) book.record(remote({ platformTxnId: id, settledAt: 5 }));
    book.record(remote({ platformTxnId: 'm', settledAt: 1 }));
    const listing = book.list(0, DAY_MS);
    expect(listing.ok && listing.orders.map((o) => o.platformTxnId)).toEqual(['m', 'a', 'b', 'q', 'z']);
  });

  describe('fromJson', () => {
    it('reads an array of orders, keeping the optional fields optional', () => {
      const book = DevStubOrderBook.fromJson(
        JSON.stringify([
          { platformTxnId: 't1', product: SKU, settledAt: 5, amountCents: 1800, currency: 'CNY', merchantOrderId: 'o1' },
          { platformTxnId: 't2', product: SKU, settledAt: 6 },
        ]),
      );
      const listing = book.list(0, DAY_MS);
      expect(listing.ok && listing.orders).toEqual([
        { platformTxnId: 't1', product: SKU, settledAt: 5, amountCents: 1800, currency: 'CNY', merchantOrderId: 'o1' },
        { platformTxnId: 't2', product: SKU, settledAt: 6 },
      ]);
      // The optional fields are ABSENT, not `undefined`-valued: `diffOrders` branches on
      // `!== undefined`, and a key present with an undefined value would read the same but
      // survive a JSON round trip differently.
      expect(listing.ok && Object.keys(listing.orders[1]!)).toEqual(['platformTxnId', 'product', 'settledAt']);
    });

    it('THROWS on a malformed entry rather than skipping it', () => {
      // Skipping would turn a typo in the harness input into a `local-not-on-platform`
      // finding — inventing evidence, which is the same failure as inventing a clean report.
      expect(() => DevStubOrderBook.fromJson('{}')).toThrow(/array/);
      expect(() => DevStubOrderBook.fromJson('[3]')).toThrow(/entry 0 is not an object/);
      expect(() => DevStubOrderBook.fromJson('[null]')).toThrow(/entry 0 is not an object/);
      expect(() => DevStubOrderBook.fromJson('[[]]')).toThrow(/entry 0 is not an object/);
      expect(() => DevStubOrderBook.fromJson('[{"product":"x","settledAt":1}]')).toThrow(/platformTxnId required/);
      expect(() => DevStubOrderBook.fromJson('[{"platformTxnId":"","product":"x","settledAt":1}]')).toThrow(
        /platformTxnId required/,
      );
      expect(() => DevStubOrderBook.fromJson('[{"platformTxnId":"t","settledAt":1}]')).toThrow(/product required/);
      expect(() => DevStubOrderBook.fromJson('[{"platformTxnId":"t","product":"x"}]')).toThrow(/settledAt required/);
      expect(() => DevStubOrderBook.fromJson('[{"platformTxnId":"t","product":"x","settledAt":"soon"}]')).toThrow(
        /settledAt required/,
      );
      expect(() =>
        DevStubOrderBook.fromJson('[{"platformTxnId":"t","product":"x","settledAt":1,"amountCents":"lots"}]'),
      ).toThrow(/amountCents must be a number/);
      expect(() =>
        DevStubOrderBook.fromJson('[{"platformTxnId":"t","product":"x","settledAt":1,"currency":9}]'),
      ).toThrow(/currency must be a string/);
      expect(() =>
        DevStubOrderBook.fromJson('[{"platformTxnId":"t","product":"x","settledAt":1,"merchantOrderId":9}]'),
      ).toThrow(/merchantOrderId must be a string/);
    });

    it('names the INDEX of the bad entry', () => {
      expect(() =>
        DevStubOrderBook.fromJson('[{"platformTxnId":"t","product":"x","settledAt":1},{"product":"y"}]'),
      ).toThrow(/entry 1/);
    });
  });
});

describe('windows, formatting and argument parsing', () => {
  it('dailyWindow ends at the last UTC midnight and excludes today', () => {
    // A partial day would report every payment still in flight as a difference, every run.
    const noon = Date.parse('2026-09-05T12:34:56.000Z');
    const { sinceMs, untilMs } = dailyWindow(noon);
    expect(new Date(untilMs).toISOString()).toBe('2026-09-05T00:00:00.000Z');
    expect(new Date(sinceMs).toISOString()).toBe('2026-09-04T00:00:00.000Z');
    expect(noon).toBeGreaterThan(untilMs);
  });

  it('dailyWindow widens backwards for a multi-day backfill', () => {
    const { sinceMs, untilMs } = dailyWindow(Date.parse('2026-09-05T12:00:00.000Z'), 7);
    expect(untilMs - sinceMs).toBe(7 * DAY_MS);
    expect(new Date(sinceMs).toISOString()).toBe('2026-08-29T00:00:00.000Z');
  });

  it('exactly midnight is already a whole day, not a partial one', () => {
    const { untilMs } = dailyWindow(Date.parse('2026-09-05T00:00:00.000Z'));
    expect(new Date(untilMs).toISOString()).toBe('2026-09-05T00:00:00.000Z');
  });

  it('formatReconcileReport says COMPLETE or INCOMPLETE before it says how many', async () => {
    const clean = await reconcileWindow({ db, listOrders: async () => ({ ok: true, orders: [] }) }, 0, DAY_MS);
    expect(formatReconcileReport(clean)[0]).toContain('COMPLETE, 0 difference(s)');

    const refused = await reconcileWindow({ db, listOrders: async () => ({ ok: false, reason: 'nope' }) }, 0, DAY_MS);
    const lines = formatReconcileReport(refused);
    // The first line is the one a human skims, and "0 differences" from a run that asked
    // nothing is the misreading this whole module is shaped to prevent.
    expect(lines[0]).toContain('INCOMPLETE');
    expect(lines[0]).toContain('5 platform(s) could not be asked');
    expect(lines.filter((l) => l.includes('not reconciled'))).toHaveLength(5);
  });

  it('formatReconcileReport lists each difference under its platform', () => {
    const report = {
      sinceMs: 0,
      untilMs: DAY_MS,
      platforms: [diffOrders('dev', [local()], [remote({ product: 'bp.seeker' })])],
      unreconciled: [],
      complete: true,
      differenceCount: 1,
    };
    const lines = formatReconcileReport(report);
    expect(lines[1]).toContain('dev: 1 local, 1 platform, 1 matched');
    expect(lines[2]).toContain('[sku-mismatch]');
  });

  it('parsePlatformList narrows, trims, and REFUSES a typo', () => {
    expect(parsePlatformList(undefined)).toBeUndefined();
    expect(parsePlatformList('')).toBeUndefined();
    expect(parsePlatformList(' , ')).toBeUndefined();
    expect(parsePlatformList('dev, stripe')).toEqual(['dev', 'stripe']);
    // Refused rather than skipped: a typo'd `--platforms=strip` that silently reconciled
    // nothing would print a COMPLETE report over an empty set.
    expect(() => parsePlatformList('dev,strip')).toThrow(/unknown platform 'strip'/);
  });
});
