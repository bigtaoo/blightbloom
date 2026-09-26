/**
 * `POST /webhook/paddle` (ROADMAP 9.1/9.3, design/19-server-platform.md §9) — the first real
 * platform callback this plane handles. A plain async function from (headers, raw bytes) to a
 * reply, so every branch is testable without a socket; `server.ts` owns the route and the
 * raw read (`http.ts`'s `readRaw`), and nothing else.
 *
 * THE ORDER OF CHECKS IS THE SECURITY MODEL:
 *
 *   1. No `BB_PADDLE_WEBHOOK_SECRET` → 503, logged as an error, NOTHING recorded. Fail closed:
 *      without the secret no body can be trusted, so none is acted on. 503 rather than 4xx on
 *      purpose — Paddle re-sends a non-2xx notification, so a purchase made while the secret
 *      is being provisioned settles on a later retry instead of being lost.
 *   2. The signature, over the RAW bytes (`signature.ts`). A failure answers 401 and is
 *      logged but NOT written to `webhook_events`: an unsigned body is not a platform event,
 *      and recording it would let anyone who knows the public URL write rows into an
 *      evidence table — the same reason `server.ts` does not record an unknown platform.
 *   3. Only now is the body parsed, and from here on EVERY outcome is recorded, exactly as
 *      the generic route records every outcome (ROADMAP 8.5).
 *
 * WHICH EVENTS ACT. `transaction.completed` settles through `BillingService.settleSigned`
 * (AMENDMENT 1's relaxation: the signed body's transaction id is trusted). An
 * `adjustment.created`/`adjustment.updated` whose `status` is `approved` and whose `action`
 * is `refund` or `chargeback` revokes and files a case (`refunds.ts`); an approved
 * `chargeback_reverse` files a case and changes nothing. Every other event — the other
 * transaction lifecycle events a destination subscribed to "everything" will deliver, a
 * `pending_approval` refund, a `chargeback_warning` — is recorded and answered 200 without
 * acting, so Paddle stops re-sending it.
 *
 * THE LOG KEY IS PADDLE'S `event_id`. A retried notification carries the same event id, so it
 * lands on one row (`seenCount` climbs); two different events about one transaction never
 * collide, which a transaction-id key would make them do — and the divergence counter would
 * then read a normal lifecycle as tampering. The Paddle subject id (`txn_…`/`adj_…`) is in
 * `detail`, and `orderId` joins the row to the order as for every platform.
 */
import type { IncomingHttpHeaders } from 'node:http';
import type { Db } from 'mongodb';
import type { BillingService, SettleResult } from '../BillingService';
import type { RawBody } from '../http';
import { recordWebhookEvent, type WebhookEventType, type WebhookOutcome } from '../webhookLog';
import { paddleChargedTotal, paddleItemPriceIds, paddleOrderId } from '../iap/paddle';
import { applyRefund, type RefundResult } from './refunds';
import { PADDLE_SIGNATURE_HEADER, verifyPaddleSignature } from './signature';
import type { PaddleConfig } from './config';

export const PADDLE_WEBHOOK_PATH = '/webhook/paddle';

export interface PaddleWebhookDeps {
  db: Db;
  billing: Pick<BillingService, 'settleSigned'>;
  config: Pick<PaddleConfig, 'webhookSecret' | 'prices'>;
  now: () => number;
  /** The delivery pump's opportunistic trigger, fired after a settlement or a revocation. */
  schedule: () => void;
}

export interface PaddleWebhookReply {
  status: number;
  body: Record<string, unknown>;
}

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const minorUnits = (v: unknown): number | undefined => (typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : undefined);

export async function handlePaddleWebhook(
  deps: PaddleWebhookDeps,
  headers: IncomingHttpHeaders,
  raw: RawBody,
): Promise<PaddleWebhookReply> {
  const secret = deps.config.webhookSecret;
  if (!secret) {
    console.error(
      '[blightbloom] billsvc: Paddle webhook REFUSED — BB_PADDLE_WEBHOOK_SECRET is not configured, so no ' +
        'signature can be checked and nothing is settled. Paddle will retry.',
    );
    return { status: 503, body: { error: 'paddle webhook not configured', code: 'not-configured' } };
  }
  if (!raw.bytes) return { status: 413, body: { error: 'body too large', code: 'oversized' } };

  const check = verifyPaddleSignature({
    header: headers[PADDLE_SIGNATURE_HEADER],
    rawBody: raw.bytes,
    secret,
    nowMs: deps.now(),
  });
  if (!check.ok) {
    console.warn(`[blightbloom] billsvc: Paddle webhook refused — ${check.reason}: ${check.detail}`);
    return { status: 401, body: { error: 'invalid signature', code: check.reason } };
  }

  let event: unknown;
  try {
    event = JSON.parse(raw.text);
  } catch {
    event = null;
  }
  const eventId = isObject(event) ? str(event.event_id) : '';
  const record = (eventType: WebhookEventType, outcome: WebhookOutcome, detail: string | null, orderId?: string) =>
    recordWebhookEvent(deps.db, { platform: 'paddle', orderId, txnId: eventId, eventType, outcome, detail, raw: raw.text, ts: deps.now() });

  if (!isObject(event) || !isObject(event.data)) {
    await record('unknown', 'rejected', 'signed body is not a Paddle event object');
    return { status: 400, body: { error: 'not a Paddle event', code: 'bad-request' } };
  }
  const eventType = str(event.event_type);
  if (eventType === 'transaction.completed') return completed(deps, event.data, record);
  if (eventType === 'adjustment.created' || eventType === 'adjustment.updated') return adjustment(deps, event.data, record);
  await record('unknown', 'ignored', `paddle event '${eventType}' is not acted on`);
  return { status: 200, body: { ok: true, ignored: true, event: eventType } };
}

type Recorder = (eventType: WebhookEventType, outcome: WebhookOutcome, detail: string | null, orderId?: string) => Promise<string>;

async function completed(deps: PaddleWebhookDeps, data: Json, record: Recorder): Promise<PaddleWebhookReply> {
  const txnId = str(data.id);
  const orderId = paddleOrderId(data);
  const reject = async (detail: string, status = 400): Promise<PaddleWebhookReply> => {
    // An error, not a warning: this is a SIGNED completed transaction — money moved — that
    // did not settle. The row is the evidence; this line is for whoever watches the deploy.
    console.error(`[blightbloom] billsvc: Paddle transaction '${txnId || '(no id)'}' NOT settled — ${detail}`);
    await record('purchase', 'rejected', detail, orderId);
    return { status, body: { error: detail, code: 'rejected' } };
  };
  if (!txnId) return reject('transaction has no data.id');
  if (!orderId) return reject(`transaction '${txnId}' carries no custom_data.orderId — cannot join it to an order`);
  const priceIds = paddleItemPriceIds(data);
  if (priceIds.length === 0) return reject(`transaction '${txnId}' has no item price id`);
  const skus = new Set<string>();
  for (const priceId of priceIds) {
    const sku = deps.config.prices.skuFor(priceId);
    // FAIL CLOSED (9.2): a price nobody mapped is refused, never guessed at. Paddle retries a
    // 4xx, so fixing BB_PADDLE_PRICE_IDS lets the retry settle it.
    if (!sku) return reject(`unknown Paddle price id '${priceId}' — not mapped to any SKU (BB_PADDLE_PRICE_IDS)`);
    skus.add(sku);
  }
  if (skus.size > 1) return reject(`transaction '${txnId}' spans ${skus.size} SKUs; one order is one SKU`);
  const [sku] = [...skus] as [string];

  let result: SettleResult;
  try {
    result = await deps.billing.settleSigned({ platform: 'paddle', orderId, txnId, product: sku, charged: paddleChargedTotal(data) });
  } catch (e) {
    await record('purchase', 'rejected', `internal: ${(e as Error).message}`, orderId);
    return { status: 500, body: { error: (e as Error).message, code: 'internal' } };
  }
  if (!result.ok) return reject(`${result.code}: ${result.reason}`, result.code === 'unknown-order' ? 404 : 400);
  await record('purchase', result.delivered ? 'settled' : 'already-delivered', `paddle ${txnId}`, orderId);
  if (result.delivered) deps.schedule();
  return { status: 200, body: { ok: true, orderId: result.orderId, sku: result.sku, delivered: result.delivered, note: result.note } };
}

async function adjustment(deps: PaddleWebhookDeps, data: Json, record: Recorder): Promise<PaddleWebhookReply> {
  const adjustmentId = str(data.id);
  const txnId = str(data.transaction_id);
  const action = str(data.action);
  const status = str(data.status);
  if (!adjustmentId || !txnId) {
    await record('refund', 'rejected', 'adjustment has no data.id or data.transaction_id');
    return { status: 400, body: { error: 'adjustment has no id or transaction_id', code: 'bad-request' } };
  }
  const approved = status === 'approved';
  const revoke = approved && (action === 'refund' || action === 'chargeback');
  if (!revoke && !(approved && action === 'chargeback_reverse')) {
    await record('refund', 'ignored', `paddle adjustment '${adjustmentId}' action=${action} status=${status} — not acted on`);
    return { status: 200, body: { ok: true, ignored: true, action, status } };
  }
  const totals = isObject(data.totals) ? data.totals : {};
  let result: RefundResult;
  try {
    result = await applyRefund(deps.db, {
      platform: 'paddle',
      adjustmentId,
      txnId,
      action,
      type: str(data.type) || undefined,
      reason: str(data.reason) || undefined,
      amountCents: minorUnits(totals.total),
      currency: str(totals.currency_code) || str(data.currency_code) || undefined,
      revoke,
      ts: deps.now(),
    });
  } catch (e) {
    await record('refund', 'rejected', `internal: ${(e as Error).message}`);
    return { status: 500, body: { error: (e as Error).message, code: 'internal' } };
  }
  if (!result.ok) {
    await record('refund', 'rejected', `${result.code}: ${result.reason}`);
    return { status: 404, body: { error: result.reason, code: result.code } };
  }
  await record('refund', result.revoked ? 'revoked' : 'filed', `paddle ${action} ${adjustmentId} on ${txnId}`, result.orderId);
  if (result.revoked) deps.schedule();
  return { status: 200, body: { ok: true, orderId: result.orderId, revoked: result.revoked, filed: result.filed } };
}
