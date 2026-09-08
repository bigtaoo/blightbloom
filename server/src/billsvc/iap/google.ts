/**
 * Google Play purchase verification — SHAPE ONLY (design/19-server-platform.md §5/§9).
 * Same posture as `apple.ts`: two outcomes, both failures, nothing ever granted.
 *
 * What the real implementation is: a service-account JWT exchanged for an access token,
 * then `GET androidpublisher/v3/applications/{pkg}/purchases/products/{sku}/tokens/{token}`,
 * accepting only `purchaseState === 0`. Google's receipt is a JSON envelope carrying both
 * `productId` and `purchaseToken`, so unlike Apple the SKU is readable before the call —
 * which is a trap, not a shortcut: the envelope is client-supplied, so `product` must come
 * from the API response, never from the envelope the client sent.
 */
import { listingUnavailable, missingCredentials, type IapVerifyResult, type PlatformOrderListing } from './types';

export interface GoogleCredentials {
  /** Service-account JSON (`BB_GOOGLE_SERVICE_ACCOUNT_JSON`). */
  serviceAccountJson?: string;
  /** Android package name (`BB_GOOGLE_PACKAGE_NAME`). */
  packageName?: string;
}

export async function verifyGoogleReceipt(receipt: string, creds: GoogleCredentials): Promise<IapVerifyResult> {
  if (!creds.serviceAccountJson) return missingCredentials('google', 'Play service-account JSON');
  if (!creds.packageName) return missingCredentials('google', 'Android package name');
  if (!receipt) return { ok: false, reason: 'google: empty receipt' };
  return {
    ok: false,
    reason: 'google: Play Developer API round trip not implemented — no credential exists to test it against',
  };
}

/**
 * The reconciliation half (design/19 §7, ROADMAP 8.5) — SHAPE ONLY, same posture as
 * `verifyGoogleReceipt` above: it must fail rather than report an empty platform side.
 *
 * What the real implementation is: `GET androidpublisher/v3/applications/{pkg}/purchases/
 * voidedpurchases` covers refunds only, so the order list comes from Play's Real-time
 * Developer Notifications drained out of a Pub/Sub subscription and replayed over the
 * window, or from the Play Console financial report CSVs on Cloud Storage. Neither is a
 * plain REST call, which is worth recording here rather than discovering later: whoever
 * fills this in is buying a Pub/Sub dependency, not writing one fetch.
 */
export async function listGoogleOrders(
  _sinceMs: number,
  _untilMs: number,
  creds: GoogleCredentials,
): Promise<PlatformOrderListing> {
  if (!creds.serviceAccountJson) return listingUnavailable('google', 'Play service-account JSON not configured');
  if (!creds.packageName) return listingUnavailable('google', 'Android package name not configured');
  return {
    ok: false,
    reason: 'google: Play order listing not implemented — no credential exists to test it against',
  };
}
