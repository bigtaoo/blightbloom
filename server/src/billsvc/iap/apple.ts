/**
 * Apple App Store receipt verification — SHAPE ONLY (design/19-server-platform.md §5/§9).
 *
 * No Apple merchant credential exists anywhere in this project, so this adapter cannot be
 * verified past the dev stub and MUST NOT pretend otherwise. It therefore has exactly two
 * outcomes, both failures, and both fail closed: no shared secret configured, or a secret
 * configured but the App Store round trip not implemented. Nothing is ever granted from
 * here. Filling it in is a bounded edit — the credential read and the result mapping are
 * already where they belong.
 *
 * What the real implementation is: POST the base64 receipt plus `password: <sharedSecret>`
 * to `verifyReceipt` (production first, retrying against sandbox only on status 21007),
 * then map the newest `in_app` entry's `product_id` onto `product` and its
 * `original_transaction_id` onto `platformTxnId`. The production-first-then-sandbox order
 * is not optional: doing it the other way round accepts sandbox receipts in production.
 */
import { listingUnavailable, missingCredentials, type IapVerifyResult, type PlatformOrderListing } from './types';

export interface AppleCredentials {
  /** App Store Connect shared secret (`BB_APPLE_SHARED_SECRET`). */
  sharedSecret?: string;
}

export async function verifyAppleReceipt(receipt: string, creds: AppleCredentials): Promise<IapVerifyResult> {
  if (!creds.sharedSecret) return missingCredentials('apple', 'App Store shared secret');
  if (!receipt) return { ok: false, reason: 'apple: empty receipt' };
  return {
    ok: false,
    reason: 'apple: App Store verifyReceipt round trip not implemented — no credential exists to test it against',
  };
}

/**
 * The reconciliation half (design/19 §7, ROADMAP 8.5) — SHAPE ONLY, same two outcomes and
 * the same fail-closed posture as `verifyAppleReceipt` above, and for the same reason: no
 * App Store Connect credential exists in this project, so this adapter must not be able to
 * report "nothing to reconcile" when what it means is "I could not ask".
 *
 * What the real implementation is: App Store Server API
 * `GET /inApps/v1/transactions/{originalTransactionId}` is per-transaction and therefore the
 * wrong call; the list call is `GET /inApps/v1/notifications/history` (POST, paged by
 * `paginationToken`, bounded by `startDate`/`endDate` in ms) filtered to
 * `notificationType: 'ONE_TIME_CHARGE'`, with each entry's signed payload decoded to recover
 * `transactionId`, `productId` and `price`. It is signed with an ES256 JWT built from the
 * issuer id, key id and .p8 private key — three credentials this project has none of. The
 * guard below checks the shared secret instead, because it is the only Apple credential this
 * project has an env var for at all; whoever implements this replaces the guard along with
 * the call.
 */
export async function listAppleOrders(
  _sinceMs: number,
  _untilMs: number,
  creds: AppleCredentials,
): Promise<PlatformOrderListing> {
  if (!creds.sharedSecret) return listingUnavailable('apple', 'App Store shared secret not configured');
  return {
    ok: false,
    reason:
      'apple: App Store Server API notification-history round trip not implemented — no credential exists to test it against',
  };
}
