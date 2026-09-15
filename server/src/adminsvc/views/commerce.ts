/**
 * The commerce view (design/21 §3.2, second section) — `reviewQueue` and `webhookEvents`,
 * the two collections billsvc has been writing since 2026-09-05 with nothing to read them
 * through.
 *
 * This section is the one that adds no collection and no schema: it is a window over
 * documents that already exist. `billing/collections.ts` says what each is for and why it
 * is shaped for a human at a prompt (design/19 §7 ruled out an admin service; design/21
 * supersedes that, and §8 records why). What was missing was not the data, it was the fact
 * that reading it required somebody to be on the box at the moment they wanted to know.
 *
 * ## Open items first, and never a total ordering by time
 *
 * `reviewQueue` is a work list, so `state: 'open'` documents come first and the closed ones
 * are a separate query rather than sorted below them. A single time-ordered list buries the
 * two open items under three hundred reviewed ones the day this collection has any history
 * at all, and "the queue looks empty" then means "the queue is long".
 *
 * ## `raw` is truncated here, deliberately
 *
 * `webhookEvents.raw` holds the original callback bytes verbatim, and that is the field the
 * collection exists for — but it is also an untrusted blob of arbitrary size that a platform
 * (or anybody who can reach the webhook endpoint) chose. It is cut to
 * {@link RAW_PREVIEW_CHARS} for the list, and the cut is REPORTED (`rawTruncated`) rather
 * than silent, because a truncated payload that looks complete is worse than no payload:
 * the whole reason to read this field is to see exactly what arrived. The full bytes stay
 * one `mongosh` query away, which is the right place for them — B2 keeps the deep-dive
 * tools off the console.
 *
 * The cut happens HERE rather than in a `$substrBytes` projection, deliberately: `raw` is
 * arbitrary UTF-8 a stranger chose, and a byte-wise cut of it can split a multi-byte
 * character into an invalid sequence. `String.prototype.slice` cuts by code unit, which
 * cannot. The cost is that the whole document crosses the wire before being trimmed, on a
 * page that reads fifty of them.
 *
 * Nothing in this file escapes anything for HTML. That is `page/layout.ts`'s `esc` and it
 * does it in one place, on every value, on the way out — a view module that pre-escaped
 * some strings would make "is this value safe?" a question with a different answer per
 * field.
 */
import type { Db } from 'mongodb';
import { billingStore, type ReviewDoc } from '../../billingDb';

/** Documents per query. The commerce collections are small by construction (one document
 *  per callback, one per finding) and this is a page, not an export. */
export const COMMERCE_PAGE_SIZE = 50;

/** How much of `webhookEvents.raw` the list carries. Enough to see the event type, the ids
 *  and the amount in a real Paddle payload; far short of what a hostile one could be. */
export const RAW_PREVIEW_CHARS = 2000;

export interface ReviewRow {
  id: string;
  kind: string;
  accountId: string;
  dayKey: string | null;
  summary: string;
  evidenceJson: string;
  state: string;
  createdAtMs: number;
  reviewedAtMs: number | null;
  note: string | null;
}

export interface WebhookRow {
  id: string;
  platform: string;
  orderId: string | null;
  txnId: string | null;
  eventType: string;
  outcome: string;
  detail: string | null;
  raw: string;
  rawTruncated: boolean;
  firstSeenAtMs: number;
  lastSeenAtMs: number;
  seenCount: number;
  /** Redeliveries under this key that arrived with a DIFFERENT body. Non-zero is the
   *  forgery shape `billing/collections.ts` calls out, so the page shows it as a flag, not
   *  a number in a row of numbers. */
  divergences: number;
}

export interface CommerceSnapshot {
  openReviews: ReviewRow[];
  closedReviews: ReviewRow[];
  /** Total open items, before the page limit — so "3 shown" can say "of 40". */
  openTotal: number;
  webhooks: WebhookRow[];
  webhookTotal: number;
  /** Webhook documents with `divergences > 0`, counted over the WHOLE collection rather
   *  than over the page. This is the one number here worth being unable to miss, and a
   *  count that only covered the visible page would read as zero on the day the divergent
   *  document is number 51. */
  divergentTotal: number;
}

function toReview(d: ReviewDoc): ReviewRow {
  return {
    id: d._id,
    kind: d.kind,
    accountId: d.accountId,
    dayKey: d.dayKey,
    summary: d.summary,
    evidenceJson: d.evidenceJson,
    state: d.state,
    createdAtMs: d.createdAt,
    reviewedAtMs: d.reviewedAt,
    note: d.note,
  };
}

/** Open review-queue items, oldest first — a work list is read from the top and the oldest
 *  unlooked-at finding is the one that has been ignored longest. */
export async function openReviews(billing: Db, limit = COMMERCE_PAGE_SIZE): Promise<ReviewRow[]> {
  const docs = await billingStore(billing)
    .reviewQueue.find({ state: 'open' })
    .sort({ createdAt: 1 })
    .limit(limit)
    .toArray();
  return docs.map(toReview);
}

/** Reviewed items, newest first — history is read from the bottom. */
export async function closedReviews(billing: Db, limit = COMMERCE_PAGE_SIZE): Promise<ReviewRow[]> {
  const docs = await billingStore(billing)
    .reviewQueue.find({ state: { $ne: 'open' } })
    .sort({ createdAt: -1 })
    .limit(limit)
    .toArray();
  return docs.map(toReview);
}

/**
 * Webhook events, most recently seen first. `lastSeenAt` rather than `firstSeenAt`: the
 * document is upserted on redelivery, so a callback the platform is still retrying right
 * now is the one worth being at the top.
 */
export async function recentWebhooks(billing: Db, limit = COMMERCE_PAGE_SIZE): Promise<WebhookRow[]> {
  const docs = await billingStore(billing)
    .webhookEvents.find({})
    .sort({ lastSeenAt: -1 })
    .limit(limit)
    .toArray();
  return docs.map((d) => ({
    id: d._id,
    platform: d.platform,
    orderId: d.orderId,
    txnId: d.txnId,
    eventType: d.eventType,
    outcome: d.outcome,
    detail: d.detail,
    raw: d.raw.slice(0, RAW_PREVIEW_CHARS),
    rawTruncated: d.raw.length > RAW_PREVIEW_CHARS,
    firstSeenAtMs: d.firstSeenAt,
    lastSeenAtMs: d.lastSeenAt,
    seenCount: d.seenCount,
    divergences: d.divergences,
  }));
}

/**
 * Everything the commerce section renders, in one call.
 *
 * The six reads run CONCURRENTLY rather than in sequence. Over a local file they were six
 * synchronous statements costing microseconds; over a cluster they are six round trips, and
 * serialised that is six times the page's latency for six queries that share no state and
 * constrain each other in no way. The counts are deliberately not folded into the finds
 * with a `$facet`: the page-limited list and the unlimited total are different questions,
 * and a facet that computed both would make the "of 40" number quietly a function of the
 * page size the day somebody changes one.
 */
export async function commerceSnapshot(billing: Db, limit = COMMERCE_PAGE_SIZE): Promise<CommerceSnapshot> {
  const store = billingStore(billing);
  const [open, closed, openTotal, webhooks, webhookTotal, divergentTotal] = await Promise.all([
    openReviews(billing, limit),
    closedReviews(billing, limit),
    store.reviewQueue.countDocuments({ state: 'open' }),
    recentWebhooks(billing, limit),
    store.webhookEvents.countDocuments({}),
    store.webhookEvents.countDocuments({ divergences: { $gt: 0 } }),
  ]);
  return { openReviews: open, closedReviews: closed, openTotal, webhooks, webhookTotal, divergentTotal };
}
