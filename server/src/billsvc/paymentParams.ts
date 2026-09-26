/**
 * What `POST /order/create` returns to the client (design/19-server-platform.md §4:
 * "returns platform payment parameters and nothing else"). One dispatch, no shared state.
 *
 * The real parameter blocks are all signed with merchant credentials this project does not
 * have (§9), so every real platform returns `configured: false` plus the field names its
 * SDK expects, and the client is told plainly that it cannot start a payment. Returning a
 * plausible-looking but unsigned block instead would fail inside the platform SDK with a
 * generic error, which is a worse outcome than a clear "not configured" here.
 *
 * The `'dev'` platform is the exception, and it is the reason the whole chain is testable:
 * it returns the `product:<sku>` receipt the dev stub resolves, so a local client can go
 * create → "pay" → webhook → delivered with nothing configured at all. That branch is
 * gated on `devStubEnabled` — under `NODE_ENV=production` this function hands out no
 * receipt even for `platform: 'dev'`, because a receipt the stub will not honour is worse
 * than no receipt.
 */
import { devStubReceiptFor } from './iap/devStub';
import type { IapPlatform } from './iap/types';

export interface PaymentParams {
  /** False when this platform has no usable credentials — the client must not proceed. */
  configured: boolean;
  /** Platform-specific block. Empty when `configured` is false, except for the dev stub. */
  params: Readonly<Record<string, string>>;
  /** Operator-facing note, shown in dev tooling and logs. */
  note?: string;
}

const NOT_CONFIGURED = (platform: string, fields: readonly string[]): PaymentParams => ({
  configured: false,
  params: {},
  note:
    `${platform}: no merchant credentials configured, so no signed payment block can be produced ` +
    `(would carry: ${fields.join(', ')})`,
});

/**
 * @param devStubOn `devStubEnabled(env)` from `iap/factory.ts` — passed in rather than
 * read here so this file stays a pure dispatch and the policy lives in exactly one place.
 * @param paddlePriceId the SKU's Paddle price id (`paddle/config.ts`), when one is
 * configured. Same reasoning: resolved by the caller, so this file reads no env.
 */
export function paymentParamsFor(
  platform: IapPlatform,
  order: { id: string; sku: string; amountCents: number; currency: string },
  devStubOn: boolean,
  paddlePriceId?: string,
): PaymentParams {
  switch (platform) {
    case 'paddle':
      // Paddle.js opens an overlay checkout from a price id and `customData`; nothing here is
      // signed, so unlike the other platforms a real block CAN be produced without a
      // credential. It is still `configured: false` until the SKU has a price id — a
      // checkout for a price nobody mapped would be refused by the webhook anyway
      // (ROADMAP 9.2: an unknown price id fails closed). `orderId` rides in `customData`
      // and comes back on the signed `transaction.completed` as `custom_data.orderId`,
      // the join back to this order (design/19 §9, funny trap 2 — snake_case on the wire).
      if (!paddlePriceId) return NOT_CONFIGURED('paddle', ['priceId', 'customData.orderId']);
      return {
        configured: true,
        params: { priceId: paddlePriceId, customDataOrderId: order.id },
        note: 'paddle: open Paddle.js checkout with items [{ priceId, quantity: 1 }] and customData { orderId }',
      };
    case 'dev':
      if (!devStubOn) {
        return { configured: false, params: {}, note: 'dev: the dev stub is disabled in this environment' };
      }
      return {
        configured: true,
        params: {
          // Everything a local client needs to POST /webhook/dev itself.
          orderId: order.id,
          receipt: devStubReceiptFor(order.sku),
          txnId: `devtxn-${order.id}`,
        },
        note: 'dev stub — POST these to /webhook/dev to settle the order',
      };
    case 'apple':
      // StoreKit needs no server block at all; the client buys the product id and the
      // server only ever sees the receipt. The order id travels as applicationUsername.
      return { configured: false, params: {}, note: 'apple: StoreKit purchase is client-initiated; no server block exists to sign' };
    case 'google':
      return NOT_CONFIGURED('google', ['packageName', 'productId', 'obfuscatedAccountId']);
    case 'wechat':
      return NOT_CONFIGURED('wechat', ['appId', 'partnerId', 'prepayId', 'nonceStr', 'timeStamp', 'sign']);
    case 'stripe':
      return NOT_CONFIGURED('stripe', ['checkoutSessionId', 'publishableKey', 'clientReferenceId']);
  }
}
