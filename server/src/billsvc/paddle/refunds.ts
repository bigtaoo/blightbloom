/**
 * Refunds and chargebacks (ROADMAP 9.3). Free functions over the billing `Db`, CLAUDE.md's
 * first split form.
 *
 * THE OWNER'S DECISION, 2026-09-26: a platform-approved refund or chargeback REVOKES the
 * entitlement it paid for AND files the case into the 8.5 review queue with its money
 * joined. Existing ladder/PvP history is NOT changed — nothing here, or anywhere the
 * revocation reaches, touches a match record, a rating or a replay. The one thing a
 * revocation changes is ownership going forward.
 *
 * WHY THIS IS NOT "CONVICTING WITHOUT EVIDENCE". `reviewQueue.ts`'s principle is "with no
 * evidence, skip — never convict", and it still holds: an approved refund IS the evidence.
 * Paddle has already given the money back when it sends one (a refund reaches `approved`
 * only after Paddle's own approval; a chargeback is created `approved`), so revoking is
 * bookkeeping, not a judgement. Everything short of that — `pending_approval`, `rejected`,
 * a `chargeback_warning` — is recorded by the route and acted on by nobody.
 *
 * IDEMPOTENT THREE WAYS, all of them claims rather than look-before-write:
 *
 *   1. The ledger gets an APPEND-ONLY `reversal:<platform>:<txn>` document — "a reversal is
 *      a new row" is the refund rule design/19 §9 has carried since Phase 8, and this is the
 *      first code to write one. Winning that claim is what decides whether THIS event queues
 *      the revocation: a transaction can be revoked once, however many adjustments land on it.
 *   2. The revocation itself is an OUTBOX row (`deliveries`, `action: 'revoke'`) keyed on the
 *      same reversal id, drained by `deliveryPump.ts` to the control plane's revoke route —
 *      a revocation must survive a crash exactly as a grant does, and it must never be an
 *      HTTP call made from inside this transaction.
 *   3. The review case is keyed per ADJUSTMENT (`refundReviewId`), so Paddle's retries of one
 *      event file one case, while a second partial refund on the same purchase files its own.
 *
 * All three writes are one transaction, so a crash cannot leave a revocation nobody was told
 * about, or a case describing a revocation that was never queued.
 */
import type { Db } from 'mongodb';
import { billingStore } from '../../billing/collections';
import { findSku } from '../skus';
import { fileReview, refundReviewId } from '../reviewQueue';
import type { IapPlatform } from '../iap/types';

export interface RefundInput {
  platform: IapPlatform;
  /** The platform's adjustment id (`adj_...`). The review case's key. */
  adjustmentId: string;
  /** The ORIGINAL transaction the adjustment is against — the join to the local order. */
  txnId: string;
  /** `refund` | `chargeback` | `chargeback_reverse` — carried into the case verbatim. */
  action: string;
  /** `full` | `partial`, as the platform says. Evidence only. */
  type?: string;
  reason?: string;
  /** What the platform gave back, minor units, and its currency. Evidence only. */
  amountCents?: number;
  currency?: string;
  /**
   * `true` for an approved refund/chargeback. `false` files the case and changes nothing —
   * used for a REVERSED chargeback, where the money came back to us: re-granting what was
   * revoked is left to a human rather than automated, because the decision to re-grant is a
   * support call, not bookkeeping.
   */
  revoke: boolean;
  ts: number;
}

export type RefundResult =
  | { ok: true; orderId: string; accountId: string; revoked: boolean; filed: boolean }
  | { ok: false; code: 'unknown-transaction'; reason: string };

/** `reversal:<platform>:<txn>` — the ledger document AND the revocation outbox row. */
export function reversalId(platform: IapPlatform, txnId: string): string {
  return `reversal:${platform}:${txnId}`;
}

export async function applyRefund(db: Db, input: RefundInput): Promise<RefundResult> {
  const store = billingStore(db);
  const order = await store.orders.findOne({ platform: input.platform, platformTxnId: input.txnId, state: 'settled' });
  if (!order) {
    // Answered as a refusal (the route turns it into a 404), so the platform RETRIES: Paddle
    // does not promise delivery order, and an adjustment can overtake the
    // `transaction.completed` it refers to. Once the purchase settles, the retry lands.
    return {
      ok: false,
      code: 'unknown-transaction',
      reason: `no settled ${input.platform} order for transaction '${input.txnId}'`,
    };
  }

  // Inputs to the transaction, fixed BEFORE it opens — `withTransaction` may re-run its body.
  const receiptId = `${input.platform}:${input.txnId}`;
  const revId = reversalId(input.platform, input.txnId);
  // The grants FROZEN at settlement, not the catalogue's current idea of the SKU: revoke what
  // was delivered. The catalogue is the fallback only for a deployment that took
  // `ledgerOnlyDelivery` and so wrote no outbox row. An empty list is still queued — the
  // control plane refuses it, and that refusal files a `revocation-failed` case for a human.
  const delivery = await store.deliveries.findOne({ _id: `purchase:${input.platform}:${input.txnId}` });
  const grantsJson = delivery?.grantsJson ?? JSON.stringify(findSku(order.sku)?.grants ?? []);

  let revoked = false;
  let filed = false;
  const session = db.client.startSession();
  try {
    await session.withTransaction(async () => {
      revoked = false;
      if (input.revoke) {
        const claim = await store.ledger.updateOne(
          { _id: revId },
          { $setOnInsert: { accountId: order.accountId, sku: order.sku, orderId: order._id, receiptId, kind: 'reversal', ts: input.ts } },
          { upsert: true, session },
        );
        if (claim.upsertedCount === 1) {
          revoked = true;
          await store.deliveries.updateOne(
            { _id: revId },
            {
              $setOnInsert: {
                accountId: order.accountId,
                sku: order.sku,
                grantsJson,
                orderId: order._id,
                receiptId,
                state: 'pending',
                attempts: 0,
                createdAt: input.ts,
                action: 'revoke',
              },
            },
            { upsert: true, session },
          );
        }
      }
      const money = input.amountCents === undefined ? 'an unstated amount' : `${input.amountCents} ${input.currency ?? '(no currency)'}`;
      const outcome = !input.revoke
        ? 'nothing revoked or re-granted automatically — a human decides'
        : revoked
          ? 'entitlement revocation queued'
          : 'revocation already queued by an earlier adjustment on this transaction';
      filed = await fileReview(
        db,
        refundReviewId(input.platform, input.adjustmentId),
        {
          kind: 'refund',
          accountId: order.accountId,
          dayKey: null,
          summary:
            `${input.platform} ${input.action}${input.type ? ` (${input.type})` : ''} of ${money} on order ` +
            `'${order._id}' ('${order.sku}') — ${outcome}. Ladder/PvP history is not changed.`,
          evidence: {
            order: {
              id: order._id,
              accountId: order.accountId,
              sku: order.sku,
              listAmountCents: order.amountCents,
              listCurrency: order.currency,
              chargedAmountCents: order.chargedAmountCents ?? null,
              chargedCurrency: order.chargedCurrency ?? null,
              platformTxnId: input.txnId,
              settledAt: order.settledAt ?? null,
            },
            adjustment: {
              id: input.adjustmentId,
              action: input.action,
              type: input.type ?? null,
              reason: input.reason ?? null,
              amountCents: input.amountCents ?? null,
              currency: input.currency ?? null,
            },
            revocation: revoked ? { deliveryId: revId, grantsJson } : null,
          },
          ts: input.ts,
        },
        session,
      );
    });
  } finally {
    await session.endSession();
  }
  return { ok: true, orderId: order._id, accountId: order.accountId, revoked, filed };
}
