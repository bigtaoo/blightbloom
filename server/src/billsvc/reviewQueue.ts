/**
 * The review queue (design/19-server-platform.md §7, ROADMAP 8.5) — the one place this
 * server tells a human that something needs looking at. Free functions over the billing
 * `Db`, CLAUDE.md's first split form.
 *
 * FILES RATHER THAN ACTS. design/19 §7 states the principle for the daily grant audit and
 * points at where it already holds: `design/15-pvp-arena.md`'s checkpoint quorum, which runs
 * no consensus check at all below a quorum of real seats and severs a seat only on a
 * CONSECUTIVE run of mismatches, never on one stray report. The same rule, applied to money:
 *
 *     WITH NO EVIDENCE, SKIP — NEVER CONVICT.
 *
 * Concretely, and these are constraints on the whole module rather than commentary: nothing
 * here revokes an entitlement, nothing here changes an order, nothing here is reachable from
 * a request handler that could be driven by a player, and a finding is a document a person
 * reads — not an action taken on their behalf. `EntitlementService.revoke` exists and is
 * deliberately called by nothing in this server.
 *
 * TWO PRODUCERS, ONE COLLECTION, and they share it because they are the same question — "a
 * human has to look at this account":
 *
 *   'grant-anomaly'                too many non-`purchase` entitlement grants for one account
 *                                  in one UTC day (`grantAudit.ts`).
 *   'money-taken-nothing-granted'  a settled purchase the control plane refused outright, or
 *                                  one whose outbox document can never be read
 *                                  (`deliveryPump.ts`). The only class in Phase 8 where money
 *                                  moved and the player got nothing, and before this it
 *                                  existed ONLY as a `console.error` — which has no owner, no
 *                                  second reader and no memory across a restart.
 *
 * IDEMPOTENCY IS THE PRODUCER'S KEY, NOT A GENERATED ID. `reviewId` below mints it and it is
 * the document's `_id`; the write is an upsert whose payload is entirely `$setOnInsert`. An
 * audit re-run over the same day must not file a second copy — an audit an operator is afraid
 * to re-run stops being run — and a delivery that is already terminal must not re-file every
 * time a sweep passes it.
 *
 * `kind` and `state` are enforced by the collection VALIDATOR (`billing/schema.ts`), not by
 * the TypeScript unions below: this collection is corrected by hand at a prompt, and a typo'd
 * kind there has to fail rather than land.
 */
import type { ClientSession, Db } from 'mongodb';
import { billingStore, type ReviewDoc } from '../billing/collections';

export const REVIEW_KINDS = ['grant-anomaly', 'money-taken-nothing-granted'] as const;
export type ReviewKind = (typeof REVIEW_KINDS)[number];

export type ReviewState = 'open' | 'reviewed';

export interface ReviewEntry {
  id: string;
  kind: ReviewKind;
  accountId: string;
  /** `YYYY-MM-DD` (UTC) for the daily audit; `null` for a delivery, which is an event. */
  dayKey: string | null;
  summary: string;
  /** Parsed `evidenceJson`. `null` when the stored text does not parse — see `toEntry`. */
  evidence: unknown;
  state: ReviewState;
  createdAt: number;
  reviewedAt: number | null;
  note: string | null;
}

export interface FileReviewInput {
  kind: ReviewKind;
  accountId: string;
  dayKey?: string | null;
  summary: string;
  /** Anything JSON-serialisable. Stored as text; this collection is read at a prompt. */
  evidence: unknown;
  ts: number;
}

/**
 * The idempotency key. Shaped `<kind>:<subject>` so the collection sorts and greps by kind,
 * and so a human reading an id can tell which producer wrote it without a join.
 *
 * The daily audit's subject is `(accountId, dayKey)` — design/19 §7's stated key — and the
 * delivery's is the delivery id, which is already the ledger document's own claimed id
 * (`billing/collections.ts`), so it inherits the strongest key in the plane rather than
 * minting a weaker one.
 */
export function reviewId(kind: ReviewKind, subject: string): string {
  return `${kind}:${subject}`;
}

/** `grant-anomaly:<accountId>:<dayKey>`. */
export function grantAnomalyId(accountId: string, dayKey: string): string {
  return reviewId('grant-anomaly', `${accountId}:${dayKey}`);
}

/** `money-taken-nothing-granted:<deliveryId>`. */
export function moneyTakenId(deliveryId: string): string {
  return reviewId('money-taken-nothing-granted', deliveryId);
}

/**
 * File one finding, keyed by `id`. Returns `true` when a document actually landed and
 * `false` when this exact finding was already on the queue.
 *
 * An upsert whose whole payload is `$setOnInsert`, read back through `upsertedCount` — never
 * a find followed by an insert. design/19 §4's AMENDMENT 2 forbids the look-before-write
 * shape everywhere in this plane for one reason: it answers the question before holding the
 * lock that would make the answer true, so two concurrent producers both see nothing and
 * both write. `upsertedCount === 1` is the same claim `ON CONFLICT DO NOTHING` +
 * `changes()` was, and `test/mongo.semantics.test.ts` pins it under 8 simultaneous
 * claimants.
 *
 * `$setOnInsert` rather than a full upsert, and the difference matters: the FIRST filing is
 * the record. Re-running the audit must not move `createdAt` (which is how long this has
 * been waiting), must not reset a `reviewed` entry back to `open`, and must not overwrite
 * the note a human wrote on it.
 */
export async function fileReview(
  db: Db,
  id: string,
  input: FileReviewInput,
  session?: ClientSession,
): Promise<boolean> {
  const res = await billingStore(db).reviewQueue.updateOne(
    { _id: id },
    {
      $setOnInsert: {
        kind: input.kind,
        accountId: input.accountId,
        dayKey: input.dayKey ?? null,
        summary: input.summary,
        evidenceJson: JSON.stringify(input.evidence),
        state: 'open',
        createdAt: input.ts,
        reviewedAt: null,
        note: null,
      },
    },
    { upsert: true, session },
  );
  return res.upsertedCount === 1;
}

function toEntry(d: ReviewDoc): ReviewEntry {
  let evidence: unknown = null;
  try {
    evidence = JSON.parse(d.evidenceJson);
  } catch {
    // A hand-edited document. `null` rather than a throw: this collection is explicitly
    // meant to be corrected at a prompt (design/19 §8 declines to build an admin service),
    // so a typo in one document must not make the whole queue unreadable. The raw text is
    // still in the field for whoever is looking.
    evidence = null;
  }
  return {
    id: d._id,
    kind: d.kind as ReviewKind,
    accountId: d.accountId,
    dayKey: d.dayKey,
    summary: d.summary,
    evidence,
    state: d.state as ReviewState,
    createdAt: d.createdAt,
    reviewedAt: d.reviewedAt,
    note: d.note,
  };
}

/** Everything still waiting, oldest first — the queue, in the order it should be worked. */
export async function openReviews(db: Db, limit = 200): Promise<ReviewEntry[]> {
  const docs = await billingStore(db)
    .reviewQueue.find({ state: 'open' })
    .sort({ createdAt: 1, _id: 1 })
    .limit(limit)
    .toArray();
  return docs.map(toEntry);
}

/** One entry by id. */
export async function reviewById(db: Db, id: string): Promise<ReviewEntry | null> {
  const doc = await billingStore(db).reviewQueue.findOne({ _id: id });
  return doc ? toEntry(doc) : null;
}

/**
 * Close one entry. Guarded on `state: 'open'` for the same reason every other terminal write
 * in this plane is: a second close must not rewrite the first one's timestamp or note.
 * Returns whether this call is the one that closed it.
 */
export async function markReviewed(db: Db, id: string, ts: number, note?: string): Promise<boolean> {
  const res = await billingStore(db).reviewQueue.updateOne(
    { _id: id, state: 'open' },
    { $set: { state: 'reviewed', reviewedAt: ts, note: note ?? null } },
  );
  return res.modifiedCount === 1;
}
