/**
 * The credential-reading dispatch (design/19-server-platform.md §5): one factory that
 * closes over an environment and returns a `ReceiptVerifier`. Borrowed shape — funny's
 * `commercial/src/iap/` is a per-platform set of independent functions behind one
 * factory, which is CLAUDE.md's preferred split form and survived four platforms there.
 *
 * FAIL CLOSED, FIRST OF TWO DEFENCES. This file enforces:
 *
 *   1. Under `NODE_ENV=production` the dev stub is off, FULL STOP — `BB_BILLING_DEV_STUB`
 *      is not consulted at all, so a mis-set env var on a production box cannot switch it
 *      back on.
 *   2. Missing credentials mean VERIFICATION FAILS. There is no fallback to the stub, in
 *      any environment. A platform with nothing configured returns a failure (never a
 *      throw, so one unconfigured platform cannot 500 the webhook route for the others),
 *      and a failure grants nothing.
 *
 * The second defence is `../startupGuard.ts`, which refuses to START the process with the
 * dev flag set in production. design/19: "One of those checks is the design; two is the
 * design surviving a deploy." The two deliberately share no code — see that file's note.
 */
import { listAppleOrders, verifyAppleReceipt } from './apple';
import { listGoogleOrders, verifyGoogleReceipt } from './google';
import { listWechatOrders, verifyWechatReceipt } from './wechat';
import { listStripeOrders, verifyStripeReceipt } from './stripe';
import { DevStubOrderBook, isDevStubReceipt, verifyDevStubReceipt } from './devStub';
import type {
  IapPlatform,
  IapVerifyResult,
  PlatformOrderLister,
  PlatformOrderListing,
  ReceiptVerifier,
} from './types';

/** Only the variables this layer reads — a plain record so tests need no `process.env`. */
export type BillingEnv = Readonly<Record<string, string | undefined>>;

/** True for the one value that means "this is a production deployment". */
export function isProductionEnv(env: BillingEnv): boolean {
  return env.NODE_ENV === 'production';
}

/**
 * Whether the `product:<sku>` stub may resolve receipts.
 *
 * The production check comes FIRST and returns without reading the flag, which is the
 * whole point: the ordering is what makes a mis-set `BB_BILLING_DEV_STUB=1` on a
 * production box inert rather than catastrophic.
 */
export function devStubEnabled(env: BillingEnv): boolean {
  if (isProductionEnv(env)) return false;
  const flag = env.BB_BILLING_DEV_STUB;
  return flag === '1' || flag === 'true';
}

export function createReceiptVerifier(env: BillingEnv = process.env): ReceiptVerifier {
  const stub = devStubEnabled(env);
  const { apple, google, wechat, stripe } = readCredentials(env);

  return async (platform: IapPlatform, receipt: string): Promise<IapVerifyResult> => {
    // A `product:` receipt resolves locally on ANY platform while the stub is enabled —
    // that is what lets `/webhook/apple` be driven end to end with no Apple account. When
    // the stub is off, the same receipt falls through to the real adapter and fails there,
    // which is the correct answer and NOT a fallback in the other direction.
    if (stub && isDevStubReceipt(receipt)) return verifyDevStubReceipt(receipt);

    switch (platform) {
      case 'apple':
        return verifyAppleReceipt(receipt, apple);
      case 'google':
        return verifyGoogleReceipt(receipt, google);
      case 'wechat':
        return verifyWechatReceipt(receipt, wechat);
      case 'stripe':
        return verifyStripeReceipt(receipt, stripe);
      case 'dev':
        // Reached only when the stub is disabled, or when the receipt is malformed for it.
        return stub
          ? verifyDevStubReceipt(receipt)
          : { ok: false, reason: 'dev: the dev stub is disabled in this environment' };
    }
  };
}

/**
 * Credentials, read once. Split out of `createReceiptVerifier` so the listing dispatch below
 * reads the SAME variables from the SAME environment — two independently-written credential
 * reads is how a platform ends up verifiable but not reconcilable, or the reverse.
 */
function readCredentials(env: BillingEnv) {
  return {
    apple: { sharedSecret: env.BB_APPLE_SHARED_SECRET },
    google: {
      serviceAccountJson: env.BB_GOOGLE_SERVICE_ACCOUNT_JSON,
      packageName: env.BB_GOOGLE_PACKAGE_NAME,
    },
    wechat: { mchId: env.BB_WECHAT_MCH_ID, apiV3Key: env.BB_WECHAT_API_V3_KEY },
    stripe: { secretKey: env.BB_STRIPE_SECRET_KEY, webhookSecret: env.BB_STRIPE_WEBHOOK_SECRET },
  };
}

/**
 * The reconciliation port's dispatch (design/19 §7, ROADMAP 8.5) — the same shape as
 * `createReceiptVerifier` and, deliberately, the same fail-closed rules:
 *
 *   1. Under `NODE_ENV=production` the dev platform is off, full stop, because
 *      `devStubEnabled` says so before `BB_BILLING_DEV_STUB` is read.
 *   2. A platform with no credentials REFUSES rather than returning an empty list. That is
 *      the rule with teeth here: an empty list is not a neutral answer to "what did you
 *      charge" — it would make every local order look like one the platform never saw, or,
 *      read the other way, print a clean reconciliation for a check that never ran.
 *      `reconcile.ts` keeps those refusals as a first-class `unreconciled` field for exactly
 *      that reason.
 *
 * `book` is the dev platform's own order list. Passing `undefined` is not the same as passing
 * an empty book: no book means the dev platform REFUSES too, because "nobody configured a
 * platform to compare against" and "the platform charged nothing" are different facts and
 * only one of them is evidence.
 */
export function createPlatformOrderLister(env: BillingEnv = process.env, book?: DevStubOrderBook): PlatformOrderLister {
  const stub = devStubEnabled(env);
  const creds = readCredentials(env);

  return async (platform: IapPlatform, sinceMs: number, untilMs: number): Promise<PlatformOrderListing> => {
    switch (platform) {
      case 'apple':
        return listAppleOrders(sinceMs, untilMs, creds.apple);
      case 'google':
        return listGoogleOrders(sinceMs, untilMs, creds.google);
      case 'wechat':
        return listWechatOrders(sinceMs, untilMs, creds.wechat);
      case 'stripe':
        return listStripeOrders(sinceMs, untilMs, creds.stripe);
      case 'dev':
        if (!stub) return { ok: false, reason: 'dev: the dev stub is disabled in this environment' };
        if (!book) return { ok: false, reason: 'dev: no order book configured — nothing to reconcile against' };
        return book.list(sinceMs, untilMs);
    }
  };
}

/**
 * Both adapters over one environment and one dev order book. The seam `server.ts` and the
 * reconciliation script take, so a process cannot end up with a verifier that resolves dev
 * receipts and a lister that refuses to list them.
 */
export interface BillingAdapters {
  verify: ReceiptVerifier;
  listOrders: PlatformOrderLister;
  /** `undefined` whenever the dev stub is disabled — including in production, always. */
  devOrderBook?: DevStubOrderBook;
}

export function createBillingAdapters(env: BillingEnv = process.env): BillingAdapters {
  const book = devStubEnabled(env) ? new DevStubOrderBook() : undefined;
  return {
    verify: createReceiptVerifier(env),
    listOrders: createPlatformOrderLister(env, book),
    devOrderBook: book,
  };
}
