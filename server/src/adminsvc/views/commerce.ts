/**
 * The commerce view (design/21 §3.2, second section) — `review_queue` and `webhook_events`,
 * the two tables billsvc has been writing since 2026-09-05 with nothing to read them
 * through.
 *
 * This section is the one that adds no collection and no schema: it is a window over rows
 * that already exist. `billingDb.ts`'s own header says what each is for and why it is
 * shaped for a human with SQL (design/19 §7 ruled out an admin service; this document
 * supersedes that, and §8 records why). What was missing was not the data, it was the fact
 * that reading it required somebody to be at a `sqlite3` prompt on the box at the moment
 * they wanted to know.
 *
 * ## Open items first, and never a total ordering by time
 *
 * `review_queue` is a work list, so `state='open'` rows come first and the closed ones are
 * a separate query rather than sorted below them. A single time-ordered list buries the two
 * open items under three hundred reviewed ones the day this table has any history at all,
 * and "the queue looks empty" then means "the queue is long".
 *
 * ## `raw` is truncated here, deliberately
 *
 * `webhook_events.raw` holds the original callback bytes verbatim, and that is the column
 * the table exists for — but it is also an untrusted blob of arbitrary size that a platform
 * (or anybody who can reach the webhook endpoint) chose. It is cut to
 * {@link RAW_PREVIEW_CHARS} for the list, and the cut is REPORTED (`rawTruncated`) rather
 * than silent, because a truncated payload that looks complete is worse than no payload:
 * the whole reason to read this column is to see exactly what arrived. The full bytes stay
 * one `sqlite3` query away, which is the right place for them — B2 keeps the deep-dive
 * tools on the box.
 *
 * Nothing in this file escapes anything for HTML. That is `page/layout.ts`'s `esc` and it does it in
 * one place, on every value, on the way out — a view module that pre-escaped some strings
 * would make "is this value safe?" a question with a different answer per field.
 */
import type { DatabaseSync } from 'node:sqlite';

/** Rows per query. The commerce tables are small by construction (one row per callback,
 *  one per finding) and this is a page, not an export. */
export const COMMERCE_PAGE_SIZE = 50;

/** How much of `webhook_events.raw` the list carries. Enough to see the event type, the
 *  ids and the amount in a real Paddle payload; far short of what a hostile one could be. */
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
   *  forgery shape `billingDb.ts` calls out, so the page shows it as a flag, not a number
   *  in a row of numbers. */
  divergences: number;
}

export interface CommerceSnapshot {
  openReviews: ReviewRow[];
  closedReviews: ReviewRow[];
  /** Total open items, before the page limit — so "3 shown" can say "of 40". */
  openTotal: number;
  webhooks: WebhookRow[];
  webhookTotal: number;
  /** Webhook rows with `divergences > 0`, counted over the WHOLE table rather than over
   *  the page. This is the one number here worth being unable to miss, and a count that
   *  only covered the visible page would read as zero on the day the divergent row is
   *  row 51. */
  divergentTotal: number;
}

const REVIEW_COLUMNS = `id, kind, account_id, day_key, summary, evidence_json, state, created_at, reviewed_at, note`;

interface RawReview {
  id: string;
  kind: string;
  account_id: string;
  day_key: string | null;
  summary: string;
  evidence_json: string;
  state: string;
  created_at: number;
  reviewed_at: number | null;
  note: string | null;
}

function toReview(r: RawReview): ReviewRow {
  return {
    id: String(r.id),
    kind: String(r.kind),
    accountId: String(r.account_id),
    dayKey: r.day_key === null ? null : String(r.day_key),
    summary: String(r.summary),
    evidenceJson: String(r.evidence_json),
    state: String(r.state),
    createdAtMs: Number(r.created_at),
    reviewedAtMs: r.reviewed_at === null ? null : Number(r.reviewed_at),
    note: r.note === null ? null : String(r.note),
  };
}

/** Open review-queue items, oldest first — a work list is read from the top and the oldest
 *  unlooked-at finding is the one that has been ignored longest. */
export function openReviews(billing: DatabaseSync, limit = COMMERCE_PAGE_SIZE): ReviewRow[] {
  const rows = billing
    .prepare(`SELECT ${REVIEW_COLUMNS} FROM review_queue WHERE state = 'open' ORDER BY created_at ASC LIMIT ?`)
    .all(limit) as unknown as RawReview[];
  return rows.map(toReview);
}

/** Reviewed items, newest first — history is read from the bottom. */
export function closedReviews(billing: DatabaseSync, limit = COMMERCE_PAGE_SIZE): ReviewRow[] {
  const rows = billing
    .prepare(`SELECT ${REVIEW_COLUMNS} FROM review_queue WHERE state <> 'open' ORDER BY created_at DESC LIMIT ?`)
    .all(limit) as unknown as RawReview[];
  return rows.map(toReview);
}

/** Webhook events, most recently seen first. `last_seen_at` rather than `first_seen_at`:
 *  the row is UPSERTed on redelivery, so a callback the platform is still retrying right
 *  now is the one worth being at the top. */
export function recentWebhooks(billing: DatabaseSync, limit = COMMERCE_PAGE_SIZE): WebhookRow[] {
  const rows = billing
    .prepare(
      `SELECT id, platform, order_id, txn_id, event_type, outcome, detail, raw,
              first_seen_at, last_seen_at, seen_count, divergences
       FROM webhook_events ORDER BY last_seen_at DESC LIMIT ?`,
    )
    .all(limit) as {
    id: string;
    platform: string;
    order_id: string | null;
    txn_id: string | null;
    event_type: string;
    outcome: string;
    detail: string | null;
    raw: string;
    first_seen_at: number;
    last_seen_at: number;
    seen_count: number;
    divergences: number;
  }[];
  return rows.map((r) => {
    const raw = String(r.raw);
    return {
      id: String(r.id),
      platform: String(r.platform),
      orderId: r.order_id === null ? null : String(r.order_id),
      txnId: r.txn_id === null ? null : String(r.txn_id),
      eventType: String(r.event_type),
      outcome: String(r.outcome),
      detail: r.detail === null ? null : String(r.detail),
      raw: raw.slice(0, RAW_PREVIEW_CHARS),
      rawTruncated: raw.length > RAW_PREVIEW_CHARS,
      firstSeenAtMs: Number(r.first_seen_at),
      lastSeenAtMs: Number(r.last_seen_at),
      seenCount: Number(r.seen_count),
      divergences: Number(r.divergences),
    };
  });
}

function count(billing: DatabaseSync, sql: string): number {
  return Number((billing.prepare(sql).get() as { n: number }).n);
}

/** Everything the commerce section renders, in one call. */
export function commerceSnapshot(billing: DatabaseSync, limit = COMMERCE_PAGE_SIZE): CommerceSnapshot {
  return {
    openReviews: openReviews(billing, limit),
    closedReviews: closedReviews(billing, limit),
    openTotal: count(billing, `SELECT COUNT(*) AS n FROM review_queue WHERE state = 'open'`),
    webhooks: recentWebhooks(billing, limit),
    webhookTotal: count(billing, `SELECT COUNT(*) AS n FROM webhook_events`),
    divergentTotal: count(billing, `SELECT COUNT(*) AS n FROM webhook_events WHERE divergences > 0`),
  };
}
