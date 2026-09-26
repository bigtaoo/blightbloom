/**
 * Paddle's configuration, read from the environment in ONE place (ROADMAP 9.1/9.2/9.4) so
 * the webhook, the order lister and `createOrder`'s payment block cannot disagree about
 * which price ids exist or whether a secret is set. Pure: it takes a `BillingEnv` record,
 * never `process.env` directly.
 *
 * The four variables, none of which has a value anywhere in this repository — the owner
 * provisions them through the separate secrets store (design/19 §9, "What is reusable"):
 *
 *   BB_PADDLE_WEBHOOK_SECRET  the notification destination's secret key. Per DESTINATION, so
 *                             funny's cannot be reused. Unset = every Paddle webhook is
 *                             refused with a 503 (Paddle retries, so nothing is lost while it
 *                             is being provisioned).
 *   BB_PADDLE_API_KEY         server API key, used only by the reconciliation lister. Unset =
 *                             Paddle is reported NOT reconciled, never "clean".
 *   BB_PADDLE_ENVIRONMENT     `sandbox` selects sandbox-api.paddle.com; anything else, unset
 *                             included, means the live API. A sandbox key against the live
 *                             host is refused by Paddle, which is the loud direction.
 *   BB_PADDLE_PRICE_IDS       `sku=pri_...,sku=pri_...`. Overrides the static `paddlePriceId`
 *                             in `skus.ts` per environment — sandbox and live price ids differ,
 *                             which is why the env is the primary source and the catalogue
 *                             field only a default.
 *
 * AN EMPTY STRING IS UNSET (design/19 §9's fourth funny trap): a `.env` line reading
 * `BB_PADDLE_WEBHOOK_SECRET=` must not produce an HMAC keyed with `''` that an attacker can
 * compute as easily as we can.
 */
import type { BillingEnv } from '../iap/factory';
import { findSku, listSkus } from '../skus';

export const PADDLE_LIVE_API = 'https://api.paddle.com';
export const PADDLE_SANDBOX_API = 'https://sandbox-api.paddle.com';

/** sku ↔ Paddle price id, both directions. Built once per process. */
export interface PaddlePriceTable {
  priceFor(sku: string): string | undefined;
  skuFor(priceId: string): string | undefined;
  /** Every mapped pair, catalogue order — for the boot log line. */
  entries(): ReadonlyArray<readonly [sku: string, priceId: string]>;
}

export interface PaddleConfig {
  webhookSecret?: string;
  apiKey?: string;
  apiBase: string;
  prices: PaddlePriceTable;
  /** Entries of `BB_PADDLE_PRICE_IDS` that were refused, one operator-readable line each. */
  priceErrors: string[];
}

const PRICE_ID = /^pri_[a-z0-9]+$/i;

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Build the table: static catalogue defaults first, then the env's pairs over them. A pair
 * naming an unknown SKU, a malformed price id, or a price id already mapped to a DIFFERENT
 * SKU is refused and reported — the last one matters most, because one price resolving to
 * two SKUs would let a cheap purchase settle an expensive order.
 */
export function buildPaddlePriceTable(raw: string | undefined): { prices: PaddlePriceTable; errors: string[] } {
  const bySku = new Map<string, string>();
  for (const def of listSkus()) if (def.paddlePriceId) bySku.set(def.sku, def.paddlePriceId);
  const errors: string[] = [];
  for (const entry of (raw ?? '').split(',')) {
    const pair = entry.trim();
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const sku = eq > 0 ? pair.slice(0, eq).trim() : '';
    const priceId = eq > 0 ? pair.slice(eq + 1).trim() : '';
    if (!findSku(sku)) {
      errors.push(`BB_PADDLE_PRICE_IDS: '${pair}' does not name a sold SKU`);
    } else if (!PRICE_ID.test(priceId)) {
      errors.push(`BB_PADDLE_PRICE_IDS: '${pair}' is not <sku>=pri_<id>`);
    } else {
      bySku.set(sku, priceId);
    }
  }
  const byPrice = new Map<string, string>();
  for (const [sku, priceId] of [...bySku]) {
    const holder = byPrice.get(priceId);
    if (holder !== undefined) {
      errors.push(`paddle: price '${priceId}' is mapped to both '${holder}' and '${sku}' — dropped from both`);
      bySku.delete(sku);
      bySku.delete(holder);
      continue;
    }
    byPrice.set(priceId, sku);
  }
  for (const [priceId, sku] of [...byPrice]) if (!bySku.has(sku)) byPrice.delete(priceId);
  const ordered = listSkus()
    .filter((d) => bySku.has(d.sku))
    .map((d) => [d.sku, bySku.get(d.sku)!] as const);
  return {
    prices: {
      priceFor: (sku) => bySku.get(sku),
      skuFor: (priceId) => byPrice.get(priceId),
      entries: () => ordered,
    },
    errors,
  };
}

export function readPaddleConfig(env: BillingEnv): PaddleConfig {
  const { prices, errors } = buildPaddlePriceTable(env.BB_PADDLE_PRICE_IDS);
  return {
    webhookSecret: nonEmpty(env.BB_PADDLE_WEBHOOK_SECRET),
    apiKey: nonEmpty(env.BB_PADDLE_API_KEY),
    apiBase: nonEmpty(env.BB_PADDLE_ENVIRONMENT) === 'sandbox' ? PADDLE_SANDBOX_API : PADDLE_LIVE_API,
    prices,
    priceErrors: errors,
  };
}
