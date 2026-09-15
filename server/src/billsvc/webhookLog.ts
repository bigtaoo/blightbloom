/**
 * The webhook event log (design/19-server-platform.md §7, ROADMAP 8.5). A sibling module of
 * free functions over the billing `Db` — CLAUDE.md's first split form, and
 * deliberately not a method on `BillingService`: recording what a callback SAID is a
 * different concern from deciding what it MEANS, and it has to happen for callbacks that
 * never reach `settle` at all.
 *
 * WHAT THIS FIXES. Before it, only a callback that parsed, verified and settled left a trace
 * — the `orders`/`receipts`/`ledger` rows. A failed one, a cancelled one, one naming an
 * event type nobody here knows, and one whose body is not even JSON all took a branch in
 * `server.ts` and vanished. "Why did my payment not go through" then has no evidence behind
 * it at all, which is funny's stated reason for shipping this table, and it is the only
 * evidence source for the question in this whole project.
 *
 * THE KEY IS `${txnId}:${eventType}`, AND UPSERT IS THE POINT. Platform redelivery is
 * at-least-once by contract (design/19 §4), so an append-only log of raw callbacks would
 * hold five near-identical rows for one payment and an operator would have to work out
 * which. Keyed and upserted, one payment is one row per event type, carrying how many times
 * it arrived and when it last did.
 *
 * WHEN THE BODY CARRIES NO TRANSACTION ID. That is not an edge case to shrug at — it is
 * precisely the malformed/unparsable callback whose evidence is worth the most, and the case
 * a naive `${txnId}:${eventType}` key collapses into ONE row that every unrelated bad
 * payload then overwrites. `webhookEventKey` therefore falls back twice: to the merchant
 * order id, and failing that to a hash of the raw bytes. The hash is a legitimate key rather
 * than a giving-up value, because a platform retry of an unparsable body repeats the same
 * bytes — so the redelivery still lands on its own row, which is the whole property.
 *
 * WHAT IS AND IS NOT UPDATED ON A REDELIVERY:
 *
 *   raw           KEPT as first written. A retry is supposed to repeat itself, so the first
 *                 body is the evidence; overwriting it would let a later forgery erase what
 *                 the platform originally sent.
 *   divergences   incremented when the new body DIFFERS from the stored one. That is the
 *                 forgery shape design/19 §4's AMENDMENT 1 already had to close on the
 *                 settlement path (a body varying `txnId` under one receipt), seen from the
 *                 other side, and counting it costs one expression in the UPSERT.
 *   outcome       OVERWRITTEN with the latest. The account's state reflects the last
 *                 decision, so a log whose outcome said something else would be misleading
 *                 in exactly the situation it is read in.
 *
 * HOW THAT UPSERT SURVIVED THE MONGODB PORT (2026-09-15). The SQLite version did the body
 * comparison inside the statement — `divergences = divergences + (raw <> excluded.raw)`,
 * relying on `<>` yielding 1/0 — precisely so that the webhook path never performs a
 * read-then-write. That property had to survive, because it is the one shape design/19 §4's
 * AMENDMENT 2 forbids everywhere else in this plane. The replacement is an UPDATE PIPELINE:
 * `updateOne` with an aggregation stage, which can read the stored document's own fields
 * (`$raw`, `$seenCount`) while writing them, in one atomic operation. Every expression in a
 * `$set` stage evaluates against the INPUT document, so `raw`'s own reassignment cannot
 * affect the `divergences` comparison sitting beside it, and on an upsert the pipeline runs
 * against a document that holds only `_id` — which is why each field is guarded by
 * `$ifNull` and the divergence test asks whether `$raw` is `missing` before comparing.
 */
import { createHash } from 'node:crypto';
import type { Db } from 'mongodb';
import { billingStore, type WebhookEventDoc } from '../billing/collections';

/**
 * The event types this plane recognises. `purchase` is also what an ABSENT `event` field
 * means — every platform's success callback is the one that omits it in this project's
 * shape, and `server.ts` has always treated it that way.
 *
 * `unknown` is a real member rather than a parse failure: a platform that starts sending
 * `refunded` or `chargeback` must be RECORDED and not acted on, and the row is how anyone
 * finds out it started.
 */
export type WebhookEventType = 'purchase' | 'failed' | 'cancelled' | 'unknown';

const KNOWN_EVENTS: readonly string[] = ['purchase', 'failed', 'cancelled'];

/**
 * Normalise the body's `event` field.
 *
 * Absent, empty and non-string all mean `purchase`, because that is what a success callback
 * looks like here and refusing one for lacking a field it never had would break every
 * platform at once. Anything else that is a string but not known is `unknown` — deliberately
 * NOT settled, see `server.ts`.
 */
export function webhookEventType(event: unknown): WebhookEventType {
  if (event === undefined || event === null) return 'purchase';
  if (typeof event !== 'string') return 'unknown';
  const trimmed = event.trim().toLowerCase();
  if (trimmed === '') return 'purchase';
  return KNOWN_EVENTS.includes(trimmed) ? (trimmed as WebhookEventType) : 'unknown';
}

/** What the handler did with a callback. Every value is a branch with its own test. */
export type WebhookOutcome =
  /** Settled and delivered — the happy path. */
  | 'settled'
  /** A settle that won nothing because this receipt had already been consumed by this account. */
  | 'already-delivered'
  /** An explicit failure/cancel event that closed an open order. */
  | 'marked-failed'
  /** A failure/cancel event for an order that was already closed. */
  | 'no-change'
  /** Recognised as a callback, deliberately not acted on (an unknown event type). */
  | 'ignored'
  /** Refused: a `SettleRejectionCode`, an unknown order, or a missing field. */
  | 'rejected';

export interface WebhookEventInput {
  platform: string;
  /** From the parsed body, when there was one. */
  orderId?: string | null;
  txnId?: string | null;
  eventType: WebhookEventType;
  outcome: WebhookOutcome;
  /** Rejection code / reason. `null` on a clean outcome. */
  detail?: string | null;
  /** The ORIGINAL bytes as they arrived — parsed or not. The reason this table exists. */
  raw: string;
  ts: number;
}

/** One `webhookEvents` document, narrowed to this module's unions. */
export interface WebhookEventRecord {
  id: string;
  platform: string;
  orderId: string | null;
  txnId: string | null;
  eventType: WebhookEventType;
  outcome: WebhookOutcome;
  detail: string | null;
  raw: string;
  firstSeenAt: number;
  lastSeenAt: number;
  seenCount: number;
  divergences: number;
}

function toRecord(d: WebhookEventDoc): WebhookEventRecord {
  return {
    id: d._id,
    platform: d.platform,
    orderId: d.orderId,
    txnId: d.txnId,
    eventType: d.eventType as WebhookEventType,
    outcome: d.outcome as WebhookOutcome,
    detail: d.detail,
    raw: d.raw,
    firstSeenAt: d.firstSeenAt,
    lastSeenAt: d.lastSeenAt,
    seenCount: d.seenCount,
    divergences: d.divergences,
  };
}

/** Prefix of the order-id fallback key, so an operator can tell the three key shapes apart. */
export const ORDER_KEY_PREFIX = 'order:';
/** Prefix of the raw-hash fallback key. */
export const RAW_KEY_PREFIX = 'raw:';

/**
 * `${txnId}:${eventType}` — design/19 §7's named key — with the two fallbacks the header
 * explains. Pure, and exported separately from the write so a test can pin the key shape
 * without a database.
 *
 * The hash is truncated to 16 hex characters. That is 64 bits over a per-platform,
 * per-event-type namespace of malformed callbacks; a collision there merges two rows in an
 * evidence table, which is a cost worth an id a human can read back out of a terminal.
 */
export function webhookEventKey(input: { txnId?: string | null; orderId?: string | null; raw: string; eventType: WebhookEventType }): string {
  const txn = (input.txnId ?? '').trim();
  if (txn) return `${txn}:${input.eventType}`;
  const order = (input.orderId ?? '').trim();
  if (order) return `${ORDER_KEY_PREFIX}${order}:${input.eventType}`;
  const hash = createHash('sha256').update(input.raw).digest('hex').slice(0, 16);
  return `${RAW_KEY_PREFIX}${hash}:${input.eventType}`;
}

/**
 * Record one callback. Returns the key it was written under, so a caller that wants to log
 * the id (or a test that wants to read the document back) does not have to re-derive it.
 *
 * One atomic update-pipeline upsert, never a read followed by a write — see the file header
 * for why the divergence count in particular had to stay inside the statement.
 *
 * NEVER THROWS ON A LOST RACE, because there is nothing to lose: the upsert resolves both
 * orders of arrival to the same document.
 */
export async function recordWebhookEvent(db: Db, input: WebhookEventInput): Promise<string> {
  const id = webhookEventKey({
    txnId: input.txnId,
    orderId: input.orderId,
    raw: input.raw,
    eventType: input.eventType,
  });
  await billingStore(db).webhookEvents.updateOne(
    { _id: id },
    [
      {
        $set: {
          platform: input.platform,
          orderId: emptyToNull(input.orderId),
          txnId: emptyToNull(input.txnId),
          eventType: input.eventType,
          // The LATEST decision. See the file header: the account state reflects it.
          outcome: input.outcome,
          detail: input.detail ?? null,
          // FIRST body wins. `$ifNull` is what makes this an insert-only field inside an
          // upsert that otherwise overwrites.
          raw: { $ifNull: ['$raw', input.raw] },
          firstSeenAt: { $ifNull: ['$firstSeenAt', input.ts] },
          lastSeenAt: input.ts,
          seenCount: { $add: [{ $ifNull: ['$seenCount', 0] }, 1] },
          divergences: {
            $add: [
              { $ifNull: ['$divergences', 0] },
              {
                $cond: [
                  // On the insert pass `$raw` is missing, which is not a divergence — it is
                  // the first arrival. Only a STORED body that differs counts.
                  { $and: [{ $ne: [{ $type: '$raw' }, 'missing'] }, { $ne: ['$raw', input.raw] }] },
                  1,
                  0,
                ],
              },
            ],
          },
        },
      },
    ],
    { upsert: true },
  );
  return id;
}

/** `''` and `undefined` both mean "the body did not carry one" and must not be stored apart. */
function emptyToNull(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? null : trimmed;
}

/** One event by key — the audit read, and how a test asks what was recorded. */
export async function webhookEventById(db: Db, id: string): Promise<WebhookEventRecord | null> {
  const doc = await billingStore(db).webhookEvents.findOne({ _id: id });
  return doc ? toRecord(doc) : null;
}

/**
 * Every event recorded against one merchant order, oldest first. THE support query: a player
 * says "I paid and got nothing", support has their order id, and this is the list of what
 * the platform actually told this server about it.
 *
 * A callback that named no order is not here, by construction — it could not be attributed
 * to one. `recentWebhookEvents` is what finds those.
 */
export async function webhookEventsForOrder(db: Db, orderId: string): Promise<WebhookEventRecord[]> {
  const docs = await billingStore(db)
    .webhookEvents.find({ orderId })
    .sort({ firstSeenAt: 1, _id: 1 })
    .toArray();
  return docs.map(toRecord);
}

/** The operator sweep: most recently seen first, bounded. */
export async function recentWebhookEvents(db: Db, limit: number): Promise<WebhookEventRecord[]> {
  const docs = await billingStore(db)
    .webhookEvents.find({})
    .sort({ lastSeenAt: -1, _id: 1 })
    .limit(limit)
    .toArray();
  return docs.map(toRecord);
}
