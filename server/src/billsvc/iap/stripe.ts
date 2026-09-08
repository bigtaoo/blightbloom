/**
 * Stripe checkout verification — SHAPE ONLY (design/19-server-platform.md §5/§9).
 * Same posture as `apple.ts`: two outcomes, both failures, nothing ever granted.
 *
 * What the real implementation is: retrieve the Checkout Session / PaymentIntent by id
 * with the secret key and accept only `payment_status === 'paid'`. Stripe additionally
 * signs its webhook body (`Stripe-Signature`, an HMAC over `t=<ts>.<body>`), which is the
 * "authenticated by the platform's own signature instead" clause in design/19 §3 — a
 * webhook signature check belongs on the route, not in this file, because it authenticates
 * the CALLER rather than the purchase.
 */
import { listingUnavailable, missingCredentials, type IapVerifyResult, type PlatformOrderListing } from './types';

export interface StripeCredentials {
  /** Secret API key (`BB_STRIPE_SECRET_KEY`). */
  secretKey?: string;
  /** Webhook signing secret (`BB_STRIPE_WEBHOOK_SECRET`). */
  webhookSecret?: string;
}

export async function verifyStripeReceipt(receipt: string, creds: StripeCredentials): Promise<IapVerifyResult> {
  if (!creds.secretKey) return missingCredentials('stripe', 'secret API key');
  if (!receipt) return { ok: false, reason: 'stripe: empty session id' };
  return {
    ok: false,
    reason: 'stripe: Checkout Session retrieval not implemented — no API key exists to test it against',
  };
}

/**
 * The reconciliation half (design/19 §7, ROADMAP 8.5) — SHAPE ONLY, same posture as
 * `verifyStripeReceipt` above. This is the one platform whose list call is genuinely a
 * single fetch, which makes it the cheapest place to prove the reconciliation logic against
 * something real the day an API key exists.
 *
 * What the real implementation is: `GET /v1/checkout/sessions?created[gte]=<s>&created[lt]=<s>`
 * (seconds, not ms), `limit=100`, paged by `starting_after`, keeping only
 * `payment_status === 'paid'` and mapping `payment_intent` onto `platformTxnId`,
 * `client_reference_id` onto `merchantOrderId` and `amount_total` onto `amountCents`.
 */
export async function listStripeOrders(
  _sinceMs: number,
  _untilMs: number,
  creds: StripeCredentials,
): Promise<PlatformOrderListing> {
  if (!creds.secretKey) return listingUnavailable('stripe', 'secret API key not configured');
  return {
    ok: false,
    reason: 'stripe: Checkout Session listing not implemented — no API key exists to test it against',
  };
}
