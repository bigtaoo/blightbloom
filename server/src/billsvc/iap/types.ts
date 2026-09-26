/**
 * IAP verification contract (design/19-server-platform.md §5). Split: this file is the
 * shared types only, one sibling file per platform holds that platform's verification,
 * and `factory.ts` holds the credential-reading dispatch — CLAUDE.md's preferred
 * "independent function modules" form, and the shape funny's `commercial/src/iap/`
 * carried across four platforms.
 *
 * WHERE funny's ASSUMPTION INVERTS. funny sells a currency, so its verify result is
 * coins-first with a non-coin product as a secondary branch. `design/14-meta-forging.md`
 * locks bounded direct purchase with no gacha and NO wallet, so that secondary branch is
 * the only branch here and the coin fields do not exist at all. There is deliberately no
 * `coins`, no balance and no wallet anywhere in this type — a field like that is how an
 * economy gets imported by accident (design/19 §8).
 */

/**
 * Platforms the dispatch knows. `'dev'` is the local stub, never a real merchant. `'paddle'`
 * (ROADMAP 9.1) is PUSH-only: it has no client-held receipt, so it never settles through
 * `ReceiptVerifier` — its signed webhook has a route of its own (`paddle/webhook.ts`).
 */
export type IapPlatform = 'apple' | 'google' | 'wechat' | 'stripe' | 'paddle' | 'dev';

const PLATFORMS: readonly string[] = ['apple', 'google', 'wechat', 'stripe', 'paddle', 'dev'];

/** Narrows an arbitrary path/body string to a known platform, or `undefined`. */
export function asIapPlatform(value: unknown): IapPlatform | undefined {
  return typeof value === 'string' && PLATFORMS.includes(value) ? (value as IapPlatform) : undefined;
}

export interface IapVerifyOk {
  ok: true;
  /**
   * The SKU id this receipt resolved to. Persisted onto the `receipts` row, and compared
   * against the order's own SKU before anything is delivered: without it a receipt bought
   * for one SKU can be replayed to claim another (design/19 §4).
   */
  product: string;
  /**
   * What the platform says it charged, in minor units. ADVISORY ONLY — the amount an
   * order is booked at comes from the server-side SKU table, never from a receipt and
   * never from a request body (design/19 §4). Kept because a mismatch is a real signal
   * for §7's reconciliation, not because anything charges off it.
   */
  amountCents?: number;
  /** The platform's own transaction id, when the receipt itself carries one. */
  platformTxnId?: string;
}

export interface IapVerifyFail {
  ok: false;
  /** Operator-facing, logged; never surfaced verbatim to a client. */
  reason: string;
}

export type IapVerifyResult = IapVerifyOk | IapVerifyFail;

/**
 * Async because a real adapter is an HTTPS call to the platform. Every caller must
 * verify BEFORE opening the settlement transaction — `BillingService` does, and the
 * reason is that holding SQLite's `BEGIN IMMEDIATE` write lock across a network round
 * trip would serialise every settlement behind the slowest platform response.
 */
export type ReceiptVerifier = (platform: IapPlatform, receipt: string) => Promise<IapVerifyResult>;

/** A credential read that came back empty — the fail-closed answer, not a throw. */
export function missingCredentials(platform: IapPlatform, what: string): IapVerifyFail {
  return { ok: false, reason: `${platform}: ${what} not configured — cannot verify, nothing granted` };
}

// ─────────────────────────────────────────────────────────────────────────────
// The reconciliation port (design/19 §7, ROADMAP 8.5)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ONE ORDER AS THE PLATFORM SEES IT. The other side of design/19 §4's one remaining tear:
 * `orders`/`receipts`/`ledger` are one SQLite file and cannot tear against each other, but
 * they can and do tear against the PLATFORM, because a payment that succeeded on Apple's
 * side and never produced a callback here leaves no local row at all. Reconciliation is the
 * only thing that can see that, and this is the shape it needs to see it in.
 *
 * Deliberately NOT `IapVerifyOk`. A verification answers "is this receipt real and what is
 * it for"; a listing answers "what did you charge, when". They overlap on `product` and
 * `amountCents` and diverge on everything else, and folding them into one type would make
 * every field on it optional.
 */
export interface PlatformOrder {
  /** The platform's own transaction id. THE join key against `orders.platform_txn_id`. */
  platformTxnId: string;
  /**
   * The merchant order id the platform echoes back (out_trade_no / applicationUsername),
   * when it carries one. Advisory: reconciliation joins on `platformTxnId`, and uses this
   * only to make a difference readable. Some platforms do not return it on a list call.
   */
  merchantOrderId?: string;
  /** The SKU the platform believes was bought. Compared against the local order's. */
  product: string;
  /**
   * Minor units, as the platform records them. OPTIONAL, and the option is load-bearing: a
   * platform that does not report an amount on a list call must produce NO amount finding,
   * rather than one comparing against a zero nobody sent.
   */
  amountCents?: number;
  currency?: string;
  /** ms epoch, as the platform records it. */
  settledAt: number;
}

/**
 * A listing, or an honest refusal. The `ok: false` arm is not decoration: no merchant
 * account exists anywhere in this project (design/19 §9), so it is the arm four of the five
 * adapters always take — and a reconciliation that treated "could not ask" as "nothing to
 * report" would print a clean bill of health for a check that never ran.
 */
export type PlatformOrderListing =
  | { ok: true; orders: readonly PlatformOrder[] }
  | { ok: false; reason: string };

/**
 * "List this platform's orders settled in `[sinceMs, untilMs)`."
 *
 * Async and injected for the same reason `ReceiptVerifier` is: a real implementation is an
 * HTTPS round trip, and the reconciliation logic that consumes it must be drivable with no
 * network at all. Half-open interval on purpose — two consecutive daily windows must not
 * both claim an order settled exactly on the boundary.
 */
export type PlatformOrderLister = (
  platform: IapPlatform,
  sinceMs: number,
  untilMs: number,
) => Promise<PlatformOrderListing>;

/** The listing-side mirror of `missingCredentials`. Same fail-closed posture, same shape. */
export function listingUnavailable(platform: IapPlatform, what: string): PlatformOrderListing {
  return { ok: false, reason: `${platform}: ${what} — cannot list orders, NOT reconciled` };
}
