/**
 * WeChat Pay order verification — SHAPE ONLY (design/19-server-platform.md §5/§9).
 * Same posture as `apple.ts`: two outcomes, both failures, nothing ever granted.
 *
 * What the real implementation is: WeChat has no "receipt" in the App Store sense — the
 * callback carries a merchant order number (`out_trade_no`) and a WeChat transaction id
 * (`transaction_id`), and verification is a v3 `GET /pay/transactions/id/{transaction_id}`
 * signed with the merchant private key, accepting only `trade_state === 'SUCCESS'`. The
 * SKU is therefore recovered from the merchant's own order, i.e. from `orders` in this
 * package, not from anything WeChat returns.
 *
 * `design/19-server-platform.md` §9 records that which platform ships first is a product
 * decision; nothing in this file assumes it is this one.
 */
import { listingUnavailable, missingCredentials, type IapVerifyResult, type PlatformOrderListing } from './types';

export interface WechatCredentials {
  /** Merchant id (`BB_WECHAT_MCH_ID`). */
  mchId?: string;
  /** APIv3 key (`BB_WECHAT_API_V3_KEY`). */
  apiV3Key?: string;
}

export async function verifyWechatReceipt(receipt: string, creds: WechatCredentials): Promise<IapVerifyResult> {
  if (!creds.mchId) return missingCredentials('wechat', 'merchant id');
  if (!creds.apiV3Key) return missingCredentials('wechat', 'APIv3 key');
  if (!receipt) return { ok: false, reason: 'wechat: empty transaction id' };
  return {
    ok: false,
    reason: 'wechat: Pay v3 transaction query not implemented — no merchant account exists to test it against',
  };
}

/**
 * The reconciliation half (design/19 §7, ROADMAP 8.5) — SHAPE ONLY, same posture as
 * `verifyWechatReceipt` above.
 *
 * What the real implementation is: WeChat Pay has no "list transactions" endpoint at all.
 * The supported answer is the daily bill — `GET /v3/bill/tradebill?bill_date=YYYY-MM-DD&
 * bill_type=SUCCESS`, which returns a signed download URL for a gzipped CSV that is then
 * fetched and parsed. So the `[since, until)` window this signature takes has to be mapped
 * onto whole Beijing-time bill days, and a window narrower than a day cannot be answered
 * exactly. Recorded here because it is the constraint that will shape the daily job's
 * schedule, not an implementation detail.
 */
export async function listWechatOrders(
  _sinceMs: number,
  _untilMs: number,
  creds: WechatCredentials,
): Promise<PlatformOrderListing> {
  if (!creds.mchId) return listingUnavailable('wechat', 'merchant id not configured');
  if (!creds.apiV3Key) return listingUnavailable('wechat', 'APIv3 key not configured');
  return {
    ok: false,
    reason: 'wechat: Pay daily trade-bill download not implemented — no merchant account exists to test it against',
  };
}
