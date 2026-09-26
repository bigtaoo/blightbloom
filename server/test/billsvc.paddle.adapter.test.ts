/**
 * Paddle's configuration, its payment block, and its reconciliation lister (ROADMAP 9.2).
 * No database and no network: the lister runs against a fake `fetch` that answers the shape
 * Paddle's API reference documents for `GET /transactions`.
 */
import { describe, it, expect } from 'vitest';
import { buildPaddlePriceTable, readPaddleConfig, PADDLE_LIVE_API, PADDLE_SANDBOX_API } from '../src/billsvc/paddle/config';
import {
  listPaddleOrders,
  paddleChargedTotal,
  paddleItemPriceIds,
  paddleListUrl,
  paddleOrderId,
  PADDLE_MAX_PAGES,
  UNMAPPED_PRICE_PREFIX,
  verifyPaddleReceipt,
} from '../src/billsvc/iap/paddle';
import { createPlatformOrderLister, createReceiptVerifier } from '../src/billsvc/iap/factory';
import { paymentParamsFor } from '../src/billsvc/paymentParams';
import { asIapPlatform } from '../src/billsvc/iap/types';

const CANNON = 'pri_01j9cannon';
const SEEKER = 'pri_01j9seeker';

describe('the price table (BB_PADDLE_PRICE_IDS)', () => {
  it('maps both directions and keeps catalogue order', () => {
    const { prices, errors } = buildPaddlePriceTable(` bp.seeker=${SEEKER} , bp.cannon=${CANNON},`);
    expect(errors).toEqual([]);
    expect(prices.priceFor('bp.cannon')).toBe(CANNON);
    expect(prices.skuFor(SEEKER)).toBe('bp.seeker');
    expect(prices.entries()).toEqual([
      ['bp.cannon', CANNON],
      ['bp.seeker', SEEKER],
    ]);
  });

  it('is EMPTY when unset — no SKU carries a static price id today', () => {
    const { prices, errors } = buildPaddlePriceTable(undefined);
    expect(errors).toEqual([]);
    expect(prices.entries()).toEqual([]);
    expect(prices.priceFor('bp.cannon')).toBeUndefined();
  });

  it('refuses unknown SKUs, malformed pairs and malformed price ids, keeping the rest', () => {
    const { prices, errors } = buildPaddlePriceTable(`bp.nope=${CANNON},bp.cannon,bp.seeker=price_1,=pri_x,bp.carom=pri_01ok`);
    expect(prices.entries()).toEqual([['bp.carom', 'pri_01ok']]);
    expect(errors).toHaveLength(4);
    expect(errors[0]).toContain('does not name a sold SKU');
    expect(errors[2]).toContain('is not <sku>=pri_<id>');
  });

  it('one price id mapped to two SKUs is dropped from BOTH — a cheap price must not settle a dear order', () => {
    const { prices, errors } = buildPaddlePriceTable(`bp.cannon=${CANNON},char.skirmisher=${CANNON},bp.leech=${CANNON},bp.seeker=${SEEKER}`);
    expect(prices.skuFor(CANNON)).toBeUndefined();
    expect(prices.priceFor('bp.cannon')).toBeUndefined();
    expect(prices.priceFor('char.skirmisher')).toBeUndefined();
    expect(prices.priceFor('bp.leech')).toBeUndefined();
    expect(prices.priceFor('bp.seeker')).toBe(SEEKER);
    expect(errors.filter((e) => e.includes('mapped to both'))).toHaveLength(2);
  });
});

describe('readPaddleConfig', () => {
  it('treats an EMPTY secret or key as unset', () => {
    const cfg = readPaddleConfig({ BB_PADDLE_WEBHOOK_SECRET: '', BB_PADDLE_API_KEY: '   ' });
    expect(cfg.webhookSecret).toBeUndefined();
    expect(cfg.apiKey).toBeUndefined();
    expect(cfg.apiBase).toBe(PADDLE_LIVE_API);
  });

  it('reads the secret, key, sandbox host and price errors', () => {
    const cfg = readPaddleConfig({
      BB_PADDLE_WEBHOOK_SECRET: ' s ',
      BB_PADDLE_API_KEY: 'k',
      BB_PADDLE_ENVIRONMENT: 'sandbox',
      BB_PADDLE_PRICE_IDS: 'bad',
    });
    expect(cfg).toMatchObject({ webhookSecret: 's', apiKey: 'k', apiBase: PADDLE_SANDBOX_API });
    expect(cfg.priceErrors).toHaveLength(1);
  });
});

describe('platform plumbing', () => {
  it('paddle is a known platform', () => {
    expect(asIapPlatform('paddle')).toBe('paddle');
  });

  it('the receipt verifier REFUSES paddle — it settles only through its signed webhook', async () => {
    expect(await verifyPaddleReceipt()).toMatchObject({ ok: false });
    const res = await createReceiptVerifier({})('paddle', 'txn_01');
    expect(res.ok === false && res.reason).toContain('push-only');
  });

  it('the payment block needs a price id, and carries the order id for custom_data', () => {
    const order = { id: 'o-1', sku: 'bp.cannon', amountCents: 1800, currency: 'CNY' };
    const bare = paymentParamsFor('paddle', order, false);
    expect(bare.configured).toBe(false);
    expect(bare.note).toContain('priceId');
    expect(paymentParamsFor('paddle', order, false, CANNON)).toMatchObject({
      configured: true,
      params: { priceId: CANNON, customDataOrderId: 'o-1' },
    });
  });

  it('the lister dispatch refuses paddle without an API key', async () => {
    const res = await createPlatformOrderLister({})('paddle', 0, 1);
    expect(res.ok === false && res.reason).toContain('BB_PADDLE_API_KEY');
  });
});

describe('transaction field readers', () => {
  it('read the flat price_id, skip junk items, and default missing fields', () => {
    expect(paddleItemPriceIds({ items: [{ price_id: 'pri_a' }, null, 'x', { price: {} }, { price: { id: 'pri_b' } }] })).toEqual(['pri_a', 'pri_b']);
    expect(paddleItemPriceIds({})).toEqual([]);
    expect(paddleChargedTotal({})).toEqual({ amountCents: undefined, currency: undefined });
    expect(paddleChargedTotal({ currency_code: 'EUR', details: { totals: { grand_total: '1.5' } } })).toEqual({ amountCents: undefined, currency: 'EUR' });
    expect(paddleOrderId({ custom_data: null })).toBeUndefined();
    expect(paddleOrderId({ custom_data: { orderId: '' } })).toBeUndefined();
    expect(paddleOrderId({ custom_data: { orderId: 'o' } })).toBe('o');
  });
});

// ─────────────────────────────── the lister ───────────────────────────────

const PRICES = buildPaddlePriceTable(`bp.cannon=${CANNON}`).prices;
const CFG = { apiKey: 'pdl_live_apikey_test', apiBase: PADDLE_SANDBOX_API, prices: PRICES };

function txn(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    status: 'completed',
    billed_at: '2026-09-25T12:00:00Z',
    custom_data: { orderId: `order-${id}` },
    items: [{ price: { id: CANNON }, quantity: 1 }],
    details: { totals: { grand_total: '296', currency_code: 'USD' } },
    ...over,
  };
}

/** Answers pages in order; records each request's url and headers. */
function fakeFetch(pages: (Response | (() => Response))[], seen: { url: string; auth: string }[] = []): typeof fetch {
  let i = 0;
  return (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), auth: (init?.headers as Record<string, string>).authorization });
    const page = pages[Math.min(i++, pages.length - 1)]!;
    return typeof page === 'function' ? page() : page.clone();
  }) as unknown as typeof fetch;
}

const page = (data: unknown, next?: string) =>
  new Response(JSON.stringify({ data, meta: { pagination: { per_page: 30, next: next ?? 'https://x/unused', has_more: next !== undefined, estimated_total: 2 } } }), { status: 200 });

describe('listPaddleOrders (GET /transactions)', () => {
  it('asks for completed transactions billed in the half-open window, bearer-authenticated', async () => {
    const seen: { url: string; auth: string }[] = [];
    const res = await listPaddleOrders(Date.UTC(2026, 8, 25), Date.UTC(2026, 8, 26), CFG, fakeFetch([page([txn('txn_1')])], seen));
    expect(res.ok).toBe(true);
    const url = new URL(seen[0]!.url);
    expect(url.origin + url.pathname).toBe(`${PADDLE_SANDBOX_API}/transactions`);
    expect(url.searchParams.get('status')).toBe('completed');
    expect(url.searchParams.get('billed_at[GTE]')).toBe('2026-09-25T00:00:00.000Z');
    expect(url.searchParams.get('billed_at[LT]')).toBe('2026-09-26T00:00:00.000Z');
    expect(url.searchParams.get('per_page')).toBe('30');
    expect(seen[0]!.auth).toBe('Bearer pdl_live_apikey_test');
    expect(paddleListUrl('https://h', 0, 1)).toContain('order_by=billed_at%5BASC%5D');
  });

  it('maps a transaction onto the reconciliation shape, and follows pagination', async () => {
    const seen: { url: string; auth: string }[] = [];
    const res = await listPaddleOrders(0, 1, CFG, fakeFetch([page([txn('txn_1')], 'https://next/page2'), page([txn('txn_2', { custom_data: null })])], seen));
    expect(seen.map((s) => s.url)[1]).toBe('https://next/page2');
    expect(res).toEqual({
      ok: true,
      orders: [
        { platformTxnId: 'txn_1', merchantOrderId: 'order-txn_1', product: 'bp.cannon', amountCents: 296, currency: 'USD', settledAt: Date.parse('2026-09-25T12:00:00Z') },
        { platformTxnId: 'txn_2', merchantOrderId: undefined, product: 'bp.cannon', amountCents: 296, currency: 'USD', settledAt: Date.parse('2026-09-25T12:00:00Z') },
      ],
    });
  });

  it('an unmapped price surfaces as a named product rather than vanishing', async () => {
    const res = await listPaddleOrders(0, 1, CFG, fakeFetch([page([txn('t', { items: [{ price: { id: 'pri_other' } }] }), txn('u', { items: [] })])]));
    expect(res.ok && res.orders.map((o) => o.product)).toEqual([`${UNMAPPED_PRICE_PREFIX}pri_other`, `${UNMAPPED_PRICE_PREFIX}(none)`]);
  });

  it('a has_more with no next url stops rather than looping', async () => {
    const res = await listPaddleOrders(0, 1, CFG, fakeFetch([new Response(JSON.stringify({ data: [], meta: { pagination: { has_more: true } } }))]));
    expect(res).toEqual({ ok: true, orders: [] });
  });

  it.each([
    ['no API key', { ...CFG, apiKey: undefined }, [page([])], 'BB_PADDLE_API_KEY'],
    ['a non-2xx', CFG, [new Response('{}', { status: 403 })], 'answered 403'],
    ['a body that is not JSON', CFG, [new Response('<html>', { status: 200 })], 'not JSON'],
    ['no data array', CFG, [new Response('{"data":{}}', { status: 200 })], 'no data array'],
    ['a transaction that is not an object', CFG, [page([7])], 'not an object'],
    ['a transaction with no id', CFG, [page([txn('')])], 'no id'],
    ['an unreadable billed_at', CFG, [page([txn('t', { billed_at: null })])], 'billed_at'],
  ])('REFUSES the whole listing on %s — never a partial "clean" answer', async (_l, cfg, pages, reason) => {
    const res = await listPaddleOrders(0, 1, cfg, fakeFetch(pages));
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.reason).toContain(reason);
    expect(res.ok === false && res.reason).toContain('NOT reconciled');
  });

  it('refuses a window that needs more than the page bound', async () => {
    const endless = () => page([], 'https://next/again');
    const res = await listPaddleOrders(0, 1, CFG, fakeFetch([endless]));
    expect(res.ok === false && res.reason).toContain(`more than ${PADDLE_MAX_PAGES} pages`);
  });
});
