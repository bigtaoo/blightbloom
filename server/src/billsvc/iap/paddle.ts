/**
 * Paddle's side of the two adapter ports (ROADMAP 9.1/9.2, design/19-server-platform.md §9).
 * Sibling of `apple.ts`/`stripe.ts`, and deliberately unlike them in one respect: the ORDER
 * LISTER here is a real implementation, written against Paddle Billing's documented
 * `GET /transactions` and tested with a fake `fetch` — not a shape-only stub — because Paddle
 * is the one platform this project has decided to sell through.
 *
 * VERIFY IS A REFUSAL, BY DESIGN. Paddle is push, not pull: there is no client-held receipt
 * to verify, so `ReceiptVerifier` is the wrong port for it. A purchase settles only through
 * the SIGNED `transaction.completed` webhook (`../paddle/webhook.ts`). Anything that reaches
 * `verifyPaddleReceipt` is therefore somebody trying the generic receipt path with a Paddle
 * platform label, and the only safe answer is no.
 *
 * THE LISTER, per Paddle's API reference (read 2026-09-26):
 *
 *   GET {base}/transactions?status=completed&billed_at[GTE]=<iso>&billed_at[LT]=<iso>
 *       &order_by=billed_at[ASC]&per_page=30
 *   Authorization: Bearer <api key>
 *
 * `per_page` defaults to 30 and 30 is the maximum; pages are followed through
 * `meta.pagination.next` while `has_more` is true. The half-open `[GTE, LT)` window is the
 * port's own contract (`PlatformOrderLister`). Every field is read defensively and a
 * transaction missing its id or billing time is a REFUSAL of the whole listing rather than a
 * silently skipped row — a reconciliation that dropped the rows it could not read would print
 * a clean bill of health over exactly the rows worth looking at.
 */
import { listingUnavailable, type IapVerifyResult, type PlatformOrder, type PlatformOrderListing } from './types';
import type { PaddleConfig } from '../paddle/config';

export async function verifyPaddleReceipt(): Promise<IapVerifyResult> {
  return {
    ok: false,
    reason: 'paddle: push-only platform — a purchase settles through its signed webhook, never a receipt',
  };
}

/** Safety bound on pagination: 30 × 200 = 6000 transactions in one daily window. A window
 *  that needs more is refused rather than half-reconciled. */
export const PADDLE_MAX_PAGES = 200;

/** Prefix given to a listed transaction whose price id maps to no SKU, so it surfaces as a
 *  `sku-mismatch` / `platform-not-local` finding naming the price rather than vanishing. */
export const UNMAPPED_PRICE_PREFIX = 'paddle-price:';

interface PaddleListPage {
  data?: unknown;
  meta?: { pagination?: { next?: unknown; has_more?: unknown } };
}

/** First item's price id — `items[].price.id`, or the flat `items[].price_id` some payloads
 *  carry. Shared with the webhook so both read a transaction the same way. */
export function paddleItemPriceIds(txn: Record<string, unknown>): string[] {
  const items = Array.isArray(txn.items) ? txn.items : [];
  const out: string[] = [];
  for (const item of items) {
    if (typeof item !== 'object' || item === null) continue;
    const it = item as { price?: { id?: unknown }; price_id?: unknown };
    const id = typeof it.price?.id === 'string' ? it.price.id : it.price_id;
    if (typeof id === 'string' && id) out.push(id);
  }
  return out;
}

/** `details.totals.grand_total` (a string of minor units, per Paddle) and its currency. */
export function paddleChargedTotal(txn: Record<string, unknown>): { amountCents?: number; currency?: string } {
  const details = txn.details as { totals?: { grand_total?: unknown; currency_code?: unknown } } | undefined;
  const total = details?.totals?.grand_total;
  const amountCents = typeof total === 'string' && /^\d+$/.test(total) ? Number(total) : undefined;
  const code = details?.totals?.currency_code ?? txn.currency_code;
  return { amountCents, currency: typeof code === 'string' ? code : undefined };
}

/** `custom_data.orderId` — billsvc's own order id, which the checkout carries round trip. */
export function paddleOrderId(txn: Record<string, unknown>): string | undefined {
  const custom = txn.custom_data as { orderId?: unknown } | null | undefined;
  return typeof custom?.orderId === 'string' && custom.orderId ? custom.orderId : undefined;
}

function toPlatformOrder(raw: unknown, prices: PaddleConfig['prices']): PlatformOrder | string {
  if (typeof raw !== 'object' || raw === null) return 'a transaction that is not an object';
  const txn = raw as Record<string, unknown>;
  if (typeof txn.id !== 'string' || !txn.id) return 'a transaction with no id';
  const billedAt = typeof txn.billed_at === 'string' ? Date.parse(txn.billed_at) : NaN;
  if (Number.isNaN(billedAt)) return `transaction '${txn.id}' has no readable billed_at`;
  const priceId = paddleItemPriceIds(txn)[0] ?? '(none)';
  const { amountCents, currency } = paddleChargedTotal(txn);
  return {
    platformTxnId: txn.id,
    merchantOrderId: paddleOrderId(txn),
    product: prices.skuFor(priceId) ?? `${UNMAPPED_PRICE_PREFIX}${priceId}`,
    amountCents,
    currency,
    settledAt: billedAt,
  };
}

export function paddleListUrl(apiBase: string, sinceMs: number, untilMs: number): string {
  const q = new URLSearchParams({
    status: 'completed',
    'billed_at[GTE]': new Date(sinceMs).toISOString(),
    'billed_at[LT]': new Date(untilMs).toISOString(),
    order_by: 'billed_at[ASC]',
    per_page: '30',
  });
  return `${apiBase}/transactions?${q.toString()}`;
}

export async function listPaddleOrders(
  sinceMs: number,
  untilMs: number,
  cfg: Pick<PaddleConfig, 'apiKey' | 'apiBase' | 'prices'>,
  fetchImpl: typeof fetch = fetch,
): Promise<PlatformOrderListing> {
  if (!cfg.apiKey) return listingUnavailable('paddle', 'API key (BB_PADDLE_API_KEY) not configured');
  const orders: PlatformOrder[] = [];
  let url: string | null = paddleListUrl(cfg.apiBase, sinceMs, untilMs);
  for (let page = 0; url !== null; page += 1) {
    if (page >= PADDLE_MAX_PAGES) return listingUnavailable('paddle', `more than ${PADDLE_MAX_PAGES} pages in one window`);
    const res = await fetchImpl(url, { headers: { authorization: `Bearer ${cfg.apiKey}`, accept: 'application/json' } });
    if (!res.ok) return listingUnavailable('paddle', `GET /transactions answered ${res.status}`);
    let body: PaddleListPage;
    try {
      body = (await res.json()) as PaddleListPage;
    } catch {
      return listingUnavailable('paddle', 'GET /transactions answered a body that is not JSON');
    }
    if (!Array.isArray(body.data)) return listingUnavailable('paddle', 'GET /transactions answered no data array');
    for (const raw of body.data) {
      const order = toPlatformOrder(raw, cfg.prices);
      if (typeof order === 'string') return listingUnavailable('paddle', `unreadable listing: ${order}`);
      orders.push(order);
    }
    const next = body.meta?.pagination?.next;
    url = body.meta?.pagination?.has_more === true && typeof next === 'string' && next ? next : null;
  }
  return { ok: true, orders };
}
