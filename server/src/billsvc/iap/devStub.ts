/**
 * The local dev stub (design/19-server-platform.md §5). A receipt of the form
 * `product:<sku>` resolves here with no network call and no merchant account, which is
 * what makes order creation, idempotency, delivery and reconciliation drivable end to end
 * in tests and locally. design/19 states it plainly: this is a LONG-LIVED ASSET, not
 * scaffolding, and it is the only reason the rest of this package can be tested at all
 * given that no Apple/Google/WeChat/Stripe credential exists anywhere in this project.
 *
 * It is also the single most dangerous file here, so it holds no policy: whether the stub
 * may run is decided by `factory.ts` (and, a second time, by `startupGuard.ts`). This file
 * only knows how to parse the prefix.
 */
import type { IapVerifyResult, PlatformOrder, PlatformOrderListing } from './types';

export const DEV_RECEIPT_PREFIX = 'product:';

/** True when `receipt` is addressed to the stub at all. Cheap, and says nothing about policy. */
export function isDevStubReceipt(receipt: string): boolean {
  return receipt.startsWith(DEV_RECEIPT_PREFIX);
}

/** Builds the stub receipt for a SKU — what `paymentParams.ts` hands a dev client. */
export function devStubReceiptFor(sku: string): string {
  return `${DEV_RECEIPT_PREFIX}${sku}`;
}

/**
 * Resolves a `product:<sku>` receipt. Rejects an empty SKU rather than resolving to `''`,
 * which would otherwise sail through as a product that matches no order and produce a
 * confusing mismatch rejection two layers up instead of a clear one here.
 */
export function verifyDevStubReceipt(receipt: string): IapVerifyResult {
  if (!isDevStubReceipt(receipt)) {
    return { ok: false, reason: `dev: receipt is not a "${DEV_RECEIPT_PREFIX}<sku>" stub receipt` };
  }
  const product = receipt.slice(DEV_RECEIPT_PREFIX.length).trim();
  if (!product) return { ok: false, reason: 'dev: stub receipt names no SKU' };
  return { ok: true, product };
}

// ─────────────────────────────────────────────────────────────────────────────
// The dev platform's OWN ORDER BOOK (design/19 §7's reconciliation, ROADMAP 8.5)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What the dev "platform" believes it charged.
 *
 * THE HONEST SCOPE PROBLEM, STATED. Reconciliation compares the local `orders` table against
 * the platform's own order list, and this project has no merchant account on any of the four
 * real platforms (design/19 §9) — so there is no platform list to pull, and there will not be
 * one until a product decision is made. design/19 §5 already answered the same problem for
 * verification: the dev stub is what makes an unverifiable chain testable end to end, and it
 * is a long-lived asset rather than scaffolding. This is that answer applied to the
 * reconciliation port.
 *
 * IT IS AUTHORED, NOT DERIVED, AND THAT IS THE WHOLE POINT. Nothing in this class reads
 * billsvc's tables. A dev platform whose order list were computed from local `orders` could
 * only ever report zero differences — it would be a reconciliation that passes by
 * construction, which is worse than no reconciliation because it looks like evidence. A
 * harness (or a test) puts orders in here, and the three difference classes are then all
 * producible: an order the platform never saw, a payment that never reached this server, and
 * a row whose amount or SKU disagrees.
 *
 * ONE BOOK PER `createBillingAdapters` CALL, never a module-level singleton: two tests, or a
 * process and a test in the same worker, must not be able to see each other's platform.
 */
export class DevStubOrderBook {
  private readonly orders: PlatformOrder[] = [];

  /**
   * Build a book from JSON — an array of `PlatformOrder` objects. This is how the daily
   * reconciliation script gets a dev platform to compare against at all: the book is
   * per-process and in-memory, so a script that runs in its own process cannot see the
   * server's, and "authored, not derived" means there is nowhere else for the data to come
   * from. `BB_BILLING_DEV_ORDERS` names the file.
   *
   * THROWS on anything malformed rather than skipping it. A reconciliation whose platform
   * side silently dropped the rows it could not read would report them as
   * `local-not-on-platform` — inventing findings out of a typo in the harness input, which is
   * the same failure as inventing a clean report out of a port that refused.
   */
  static fromJson(text: string): DevStubOrderBook {
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) throw new Error('dev order book must be a JSON array of orders');
    const book = new DevStubOrderBook();
    parsed.forEach((entry, i) => book.record(asPlatformOrder(entry, i)));
    return book;
  }

  /**
   * Record what the dev platform charged. Replaces an existing entry with the same
   * `platformTxnId` rather than appending a second — a platform's order list is keyed by its
   * own transaction id, and a duplicate there would be a bug in the platform, not a case
   * reconciliation should have to model.
   */
  record(order: PlatformOrder): void {
    const at = this.orders.findIndex((o) => o.platformTxnId === order.platformTxnId);
    if (at >= 0) this.orders[at] = order;
    else this.orders.push(order);
  }

  /** Forget a transaction — how a harness stages "the platform never saw this one". */
  forget(platformTxnId: string): boolean {
    const at = this.orders.findIndex((o) => o.platformTxnId === platformTxnId);
    if (at < 0) return false;
    this.orders.splice(at, 1);
    return true;
  }

  clear(): void {
    this.orders.length = 0;
  }

  get size(): number {
    return this.orders.length;
  }

  /**
   * The window is HALF-OPEN, `[sinceMs, untilMs)`, matching `PlatformOrderLister`'s contract:
   * two consecutive daily windows must not both claim an order settled exactly on the
   * boundary, or every such order would report as a difference in one of the two runs.
   */
  list(sinceMs: number, untilMs: number): PlatformOrderListing {
    return {
      ok: true,
      orders: this.orders
        .filter((o) => o.settledAt >= sinceMs && o.settledAt < untilMs)
        .sort((a, b) => a.settledAt - b.settledAt || (a.platformTxnId < b.platformTxnId ? -1 : 1)),
    };
  }
}

/** Validate one entry of `DevStubOrderBook.fromJson`'s array. Throws, naming the index. */
function asPlatformOrder(entry: unknown, index: number): PlatformOrder {
  const at = `dev order book entry ${index}`;
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new Error(`${at} is not an object`);
  const e = entry as Record<string, unknown>;
  if (typeof e.platformTxnId !== 'string' || e.platformTxnId === '') throw new Error(`${at}: platformTxnId required`);
  if (typeof e.product !== 'string' || e.product === '') throw new Error(`${at}: product required`);
  if (typeof e.settledAt !== 'number' || !Number.isFinite(e.settledAt)) throw new Error(`${at}: settledAt required`);
  if (e.amountCents !== undefined && typeof e.amountCents !== 'number') throw new Error(`${at}: amountCents must be a number`);
  if (e.currency !== undefined && typeof e.currency !== 'string') throw new Error(`${at}: currency must be a string`);
  if (e.merchantOrderId !== undefined && typeof e.merchantOrderId !== 'string') {
    throw new Error(`${at}: merchantOrderId must be a string`);
  }
  return {
    platformTxnId: e.platformTxnId,
    product: e.product,
    settledAt: e.settledAt,
    ...(e.amountCents === undefined ? {} : { amountCents: e.amountCents as number }),
    ...(e.currency === undefined ? {} : { currency: e.currency as string }),
    ...(e.merchantOrderId === undefined ? {} : { merchantOrderId: e.merchantOrderId as string }),
  };
}
