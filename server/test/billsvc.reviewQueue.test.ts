/**
 * `billsvc/reviewQueue.ts` — design/19 §7's "files rather than acts" (ROADMAP 8.5).
 *
 * The queue's whole value is that it can be re-driven without growing: the daily audit runs
 * again over the same day, the pump sweeps past a row that is already terminal, and neither
 * may produce a second entry or disturb the first. So most of this file is about what does NOT
 * happen on a second call.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Db } from 'mongodb';
import { billingStore, ensureBillingIndexes } from '../src/billingDb';
import { openTestMongo, type MongoTestContext } from './mongoHarness';
import {
  REVIEW_KINDS,
  fileReview,
  grantAnomalyId,
  markReviewed,
  moneyTakenId,
  openReviews,
  reviewById,
  reviewId,
} from '../src/billsvc/reviewQueue';

let ctx: MongoTestContext;
let db: Db;

beforeEach(async () => {
  ctx = await openTestMongo();
  db = ctx.db('billing');
  await ensureBillingIndexes(db);
});
afterEach(async () => {
  await ctx.dispose();
});

describe('the idempotency keys', () => {
  it('grantAnomalyId is (accountId, dayKey) — design/19 §7\'s named key', () => {
    expect(grantAnomalyId('acc-1', '2026-09-04')).toBe('grant-anomaly:acc-1:2026-09-04');
  });

  it('moneyTakenId is the delivery id, which is already the ledger row\'s own claim', () => {
    expect(moneyTakenId('purchase:dev:txn-9')).toBe('money-taken-nothing-granted:purchase:dev:txn-9');
  });

  it('every id is prefixed by its kind, so the table greps by producer without a join', async () => {
    for (const kind of REVIEW_KINDS) expect(reviewId(kind, 'x')).toBe(`${kind}:x`);
  });
});

describe('fileReview', () => {
  it('files an entry as open, with its evidence readable back as an object', async () => {
    const id = grantAnomalyId('acc-1', '2026-09-04');
    expect(await fileReview(db, id, {
      kind: 'grant-anomaly',
      accountId: 'acc-1',
      dayKey: '2026-09-04',
      summary: 'seven free grants',
      evidence: { count: 7, bySource: { grant: 7 } },
      ts: 1_000,
    })).toBe(true);

    const entry = (await reviewById(db, id))!;
    expect(entry.kind).toBe('grant-anomaly');
    expect(entry.state).toBe('open');
    expect(entry.dayKey).toBe('2026-09-04');
    expect(entry.createdAt).toBe(1_000);
    expect(entry.reviewedAt).toBeNull();
    expect(entry.note).toBeNull();
    expect(entry.evidence).toEqual({ count: 7, bySource: { grant: 7 } });
  });

  it('a second filing under the same key changes NOTHING and reports false', async () => {
    // The first filing is the record. `created_at` is how long this has been waiting, and a
    // re-run must not reset it — an audit an operator is afraid to re-run stops being run.
    const id = grantAnomalyId('acc-1', '2026-09-04');
    const base = { kind: 'grant-anomaly', accountId: 'acc-1', dayKey: '2026-09-04', evidence: { n: 1 } } as const;
    expect(await fileReview(db, id, { ...base, summary: 'first', ts: 1_000 })).toBe(true);
    expect(await fileReview(db, id, { ...base, summary: 'second', ts: 9_000 })).toBe(false);

    const entry = (await reviewById(db, id))!;
    expect(entry.summary).toBe('first');
    expect(entry.createdAt).toBe(1_000);
    expect(await openReviews(db)).toHaveLength(1);
  });

  it('a re-file does NOT reopen an entry a human already closed', async () => {
    // The case the `DO NOTHING` is really for: tomorrow's audit re-derives yesterday's finding,
    // and must not undo the review somebody did in between.
    const id = grantAnomalyId('acc-1', '2026-09-04');
    await fileReview(db, id, { kind: 'grant-anomaly', accountId: 'acc-1', summary: 's', evidence: {}, ts: 1_000 });
    await markReviewed(db, id, 2_000, 'campaign was misconfigured, corrected');
    await fileReview(db, id, { kind: 'grant-anomaly', accountId: 'acc-1', summary: 's', evidence: {}, ts: 3_000 });

    const entry = (await reviewById(db, id))!;
    expect(entry.state).toBe('reviewed');
    expect(entry.note).toBe('campaign was misconfigured, corrected');
    expect(await openReviews(db)).toEqual([]);
  });

  it('a delivery entry carries no day key — it is an event, not a day', async () => {
    const id = moneyTakenId('purchase:dev:t1');
    await fileReview(db, id, {
      kind: 'money-taken-nothing-granted',
      accountId: 'acc-2',
      summary: 'refused with 400',
      evidence: { status: 400 },
      ts: 5_000,
    });
    expect((await reviewById(db, id))!.dayKey).toBeNull();
  });

  it('refuses a kind the schema does not know', async () => {
    // The collection VALIDATOR is the guard, not a TypeScript type: this collection is edited
    // at a prompt, and a typo'd kind there must fail rather than land.
    await expect(
      fileReview(db, 'x', {
        kind: 'wat' as 'grant-anomaly',
        accountId: 'a',
        summary: 's',
        evidence: {},
        ts: 1,
      }),
    ).rejects.toThrow();
  });
});

describe('reading the queue', () => {
  it('openReviews is oldest first — the order it should be worked', async () => {
    await fileReview(db, 'a', { kind: 'grant-anomaly', accountId: 'a', summary: 's', evidence: {}, ts: 3_000 });
    await fileReview(db, 'b', { kind: 'grant-anomaly', accountId: 'b', summary: 's', evidence: {}, ts: 1_000 });
    await fileReview(db, 'c', { kind: 'grant-anomaly', accountId: 'c', summary: 's', evidence: {}, ts: 2_000 });
    expect((await openReviews(db)).map((e) => e.id)).toEqual(['b', 'c', 'a']);
  });

  it('openReviews honours its limit and excludes closed entries', async () => {
    for (const n of [1, 2, 3]) {
      await fileReview(db, `e-${n}`, { kind: 'grant-anomaly', accountId: 'a', summary: 's', evidence: {}, ts: n });
    }
    await markReviewed(db, 'e-2', 100);
    expect((await openReviews(db)).map((e) => e.id)).toEqual(['e-1', 'e-3']);
    expect((await openReviews(db, 1)).map((e) => e.id)).toEqual(['e-1']);
  });

  it('reviewById returns null for an id nobody filed', async () => {
    expect(await reviewById(db, 'nope')).toBeNull();
  });

  it('a hand-edited unparsable evidence column reads back as null, not as a throw', async () => {
    // This table is explicitly meant to be corrected at a `sqlite3` prompt (design/19 §8
    // declines to build an admin service), so one typo must not make the whole queue
    // unreadable. The raw text is still in the column for whoever is looking.
    await fileReview(db, 'a', { kind: 'grant-anomaly', accountId: 'a', summary: 's', evidence: { n: 1 }, ts: 1 });
    await billingStore(db).reviewQueue.updateOne({ _id: 'a' }, { $set: { evidenceJson: '{not json' } });
    expect((await reviewById(db, 'a'))!.evidence).toBeNull();
    expect(await openReviews(db)).toHaveLength(1);
  });
});

describe('markReviewed', () => {
  it('closes an open entry once, and reports who did it', async () => {
    await fileReview(db, 'a', { kind: 'grant-anomaly', accountId: 'a', summary: 's', evidence: {}, ts: 1 });
    expect(await markReviewed(db, 'a', 500, 'looked, fine')).toBe(true);
    const entry = (await reviewById(db, 'a'))!;
    expect(entry.state).toBe('reviewed');
    expect(entry.reviewedAt).toBe(500);
    expect(entry.note).toBe('looked, fine');
  });

  it('a second close changes nothing and reports false', async () => {
    await fileReview(db, 'a', { kind: 'grant-anomaly', accountId: 'a', summary: 's', evidence: {}, ts: 1 });
    await markReviewed(db, 'a', 500, 'first note');
    expect(await markReviewed(db, 'a', 900, 'second note')).toBe(false);
    const entry = (await reviewById(db, 'a'))!;
    expect(entry.reviewedAt).toBe(500);
    expect(entry.note).toBe('first note');
  });

  it('closing an id that was never filed is false, not an insert', async () => {
    expect(await markReviewed(db, 'ghost', 1)).toBe(false);
    expect(await reviewById(db, 'ghost')).toBeNull();
  });

  it('a close with no note leaves the note NULL rather than an empty string', async () => {
    await fileReview(db, 'a', { kind: 'grant-anomaly', accountId: 'a', summary: 's', evidence: {}, ts: 1 });
    await markReviewed(db, 'a', 500);
    expect((await reviewById(db, 'a'))!.note).toBeNull();
  });
});
