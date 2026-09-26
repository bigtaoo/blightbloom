/**
 * Split of `BillingService.ts` (2026-09-26, ROADMAP 9.1): the order/ledger VIEW types and the
 * document → view mappers. Free functions, CLAUDE.md's first split form; `BillingService.ts`
 * re-exports the types so no caller's import changes.
 */
import type { LedgerDoc, OrderDoc } from '../billing/collections';
import type { IapPlatform } from './iap/types';

export type OrderState = 'created' | 'settled' | 'failed';

export interface OrderView {
  id: string;
  accountId: string;
  sku: string;
  platform: IapPlatform;
  amountCents: number;
  currency: string;
  state: OrderState;
  platformTxnId: string | null;
  createdAt: number;
  settledAt: number | null;
}

export interface LedgerView {
  id: string;
  accountId: string;
  sku: string;
  orderId: string | null;
  receiptId: string | null;
  kind: string;
  ts: number;
}


/** The charged amount/currency as order fields, omitting whichever the platform did not say —
 *  ABSENT rather than null, like every optional order field (`billing/collections.ts`). */
export function chargedFields(charged?: { amountCents?: number; currency?: string }): Partial<OrderDoc> {
  const out: Partial<OrderDoc> = {};
  if (charged?.amountCents !== undefined) out.chargedAmountCents = charged.amountCents;
  if (charged?.currency !== undefined) out.chargedCurrency = charged.currency;
  return out;
}

export function toOrderView(doc: OrderDoc): OrderView {
  return {
    id: doc._id,
    accountId: doc.accountId,
    sku: doc.sku,
    platform: doc.platform as IapPlatform,
    amountCents: doc.amountCents,
    currency: doc.currency,
    state: doc.state as OrderState,
    platformTxnId: doc.platformTxnId ?? null,
    createdAt: doc.createdAt,
    settledAt: doc.settledAt ?? null,
  };
}

export function toLedgerView(doc: LedgerDoc): LedgerView {
  return {
    id: doc._id,
    accountId: doc.accountId,
    sku: doc.sku,
    orderId: doc.orderId ?? null,
    receiptId: doc.receiptId ?? null,
    kind: doc.kind,
    ts: doc.ts,
  };
}
