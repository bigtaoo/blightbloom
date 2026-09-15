/**
 * The daily non-`purchase` entitlement audit (design/19 §7, ROADMAP 8.5) — `src/grantAudit.ts`.
 *
 * design/19 §7 states the governing principle and points at where it already holds
 * (`design/15-pvp-arena.md`'s checkpoint quorum): WITH NO EVIDENCE, SKIP — NEVER CONVICT. Most
 * of this suite is that principle, case by case, because it is the kind of rule that is easy to
 * state in a header and lose in an `if`:
 *
 *   'exactly AT the threshold is not an anomaly' — a count equal to the largest number anyone
 *   has said is fine is a case somebody already accepted.
 *   'a purchase is skipped, not counted' — the money is the evidence.
 *   'a source the audit was not told to count is skipped' — including one a future migration
 *   adds to `db.ts`'s CHECK, which must arrive uncounted rather than silently convicting.
 *   'files, never acts' — asserted against the real `entitlements` table: the rows are still
 *   there afterwards.
 *
 * The reads run against a real `openDb(':memory:')` and a real billing database on the
 * suite's own mongod, because the two-STORE split is half of what this pass ships: the audit
 * reads the CONTROL PLANE's table and files into the BILLING plane's queue. Since 2026-09-15
 * those are two different kinds of store — the billing plane moved to MongoDB first — and this
 * file is where the seam between them is exercised.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import type { Db } from 'mongodb';
import { openDb } from '../src/db';
import { ensureBillingIndexes } from '../src/billingDb';
import { openTestMongo, type MongoTestContext } from './mongoHarness';
import { EntitlementService, type EntitlementSource } from '../src/EntitlementService';
import { openReviews, reviewById, grantAnomalyId, markReviewed } from '../src/billsvc/reviewQueue';
import {
  DEFAULT_COUNTED_SOURCES,
  DEFAULT_GRANT_THRESHOLD,
  auditGrants,
  dayKeyOf,
  dayWindow,
  fileGrantAnomalies,
  formatFinding,
  readGrantsInWindow,
  type GrantRow,
} from '../src/grantAudit';

const DAY = 86_400_000;
const D1 = Date.parse('2026-09-04T00:00:00.000Z');
const D2 = D1 + DAY;

let accounts: DatabaseSync;
let ctx: MongoTestContext;
let billing: Db;

beforeEach(async () => {
  accounts = openDb(':memory:');
  ctx = await openTestMongo();
  billing = ctx.db('billing');
  await ensureBillingIndexes(billing);
});
afterEach(async () => {
  accounts.close();
  await ctx.dispose();
});

function grant(over: Partial<GrantRow> = {}): GrantRow {
  return { accountId: 'acc-1', sku: 'blueprint:cannon', source: 'grant', grantedAt: D1 + 3_600_000, ...over };
}

/** `n` counted grants for one account on one day, each with its own SKU so none collide. */
function grants(n: number, over: Partial<GrantRow> = {}): GrantRow[] {
  return Array.from({ length: n }, (_, i) => grant({ sku: `blueprint:w${i}`, ...over }));
}

describe('dayKeyOf / dayWindow', () => {
  it('is a UTC YYYY-MM-DD', async () => {
    expect(dayKeyOf(D1)).toBe('2026-09-04');
    expect(dayKeyOf(D1 + DAY - 1)).toBe('2026-09-04');
    expect(dayKeyOf(D2)).toBe('2026-09-05');
  });

  it('is UTC and not local time, because the KEY has to be machine-independent', async () => {
    // `(accountId, dayKey)` is the review queue's idempotency key. A local-time boundary would
    // file a second row for the same grants the first time the job ran from a box in another
    // zone — which is a duplicate finding produced by nothing but where cron happened to run.
    expect(dayKeyOf(Date.parse('2026-09-04T23:30:00.000Z'))).toBe('2026-09-04');
    expect(dayKeyOf(Date.parse('2026-09-05T00:30:00.000Z'))).toBe('2026-09-05');
  });

  it('dayWindow is the half-open day, and round-trips through dayKeyOf', async () => {
    const { sinceMs, untilMs } = dayWindow('2026-09-04');
    expect(sinceMs).toBe(D1);
    expect(untilMs).toBe(D2);
    expect(dayKeyOf(sinceMs)).toBe('2026-09-04');
    expect(dayKeyOf(untilMs)).toBe('2026-09-05'); // exclusive
  });

  it('refuses a day key that is not a date', async () => {
    expect(() => dayWindow('yesterday')).toThrow(/not a YYYY-MM-DD day key/);
  });
});

describe('auditGrants — the threshold', () => {
  it('exactly AT the threshold is NOT an anomaly', async () => {
    // The decision, not an off-by-one: the threshold is the largest count anyone has said is
    // fine, so a count equal to it is a case somebody already accepted.
    expect(auditGrants(grants(DEFAULT_GRANT_THRESHOLD))).toEqual([]);
  });

  it('one over the threshold IS', async () => {
    const findings = auditGrants(grants(DEFAULT_GRANT_THRESHOLD + 1));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.count).toBe(DEFAULT_GRANT_THRESHOLD + 1);
    expect(findings[0]!.threshold).toBe(DEFAULT_GRANT_THRESHOLD);
  });

  it('respects an overridden threshold on both sides of the boundary', async () => {
    expect(auditGrants(grants(1), { threshold: 1 })).toEqual([]);
    expect(auditGrants(grants(2), { threshold: 1 })).toHaveLength(1);
  });

  it('a threshold of zero files any counted grant at all', async () => {
    // The knob's extreme, and it must still be `>`: zero counted grants is still not a finding.
    expect(auditGrants([], { threshold: 0 })).toEqual([]);
    expect(auditGrants(grants(1), { threshold: 0 })).toHaveLength(1);
  });
});

describe('auditGrants — with no evidence, skip', () => {
  it('skips `purchase`, because the money IS the evidence', async () => {
    const rows = [...grants(10, { source: 'purchase' })];
    expect(auditGrants(rows)).toEqual([]);
  });

  it('counts every source the audit WAS told to count', async () => {
    // One of each: four sources, threshold 3, so the boundary is crossed only by counting all
    // four — which pins that no default source is quietly dropped.
    const rows = DEFAULT_COUNTED_SOURCES.map((source, i) => grant({ source, sku: `blueprint:w${i}` }));
    const findings = auditGrants(rows);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.bySource).toEqual({ grant: 1, event: 1, starter: 1, drop: 1 });
  });

  it('skips a source it was not told to count, rather than convicting on it', async () => {
    // A source added to `db.ts`'s CHECK by a later migration arrives UNCOUNTED, and whoever
    // adds it decides. The alternative — "anything that is not a purchase" — silently changes
    // what this audit convicts on the day someone edits an unrelated file.
    const rows = grants(10, { source: 'refund' as EntitlementSource });
    expect(auditGrants(rows)).toEqual([]);
  });

  it('honours an explicit countedSources — the starter-pack knob', async () => {
    const rows = [...grants(5, { source: 'starter' }), ...grants(1, { source: 'grant' })];
    expect(auditGrants(rows, { countedSources: ['grant', 'event', 'drop'] })).toEqual([]);
    expect(auditGrants(rows)).toHaveLength(1);
  });

  it('finds nothing in an empty window', async () => {
    expect(auditGrants([])).toEqual([]);
  });

  it('a mixed account crosses the threshold only on its counted rows', async () => {
    const rows = [...grants(3), ...grants(20, { source: 'purchase' })];
    expect(auditGrants(rows)).toEqual([]);
  });
});

describe('auditGrants — grouping', () => {
  it('groups per account per DAY, never across days', async () => {
    // Four on Friday and four on Saturday is two findings; eight in one day is one. The
    // distinction is the whole reason the key carries a day.
    const rows = [...grants(4), ...grants(4, { grantedAt: D2 + 60_000 })];
    const findings = auditGrants(rows);
    expect(findings.map((f) => f.dayKey)).toEqual(['2026-09-04', '2026-09-05']);
    expect(findings.map((f) => f.count)).toEqual([4, 4]);
  });

  it('does not pool two accounts into one finding', async () => {
    const rows = [...grants(3), ...grants(3, { accountId: 'acc-2' })];
    expect(auditGrants(rows)).toEqual([]);
  });

  it('orders findings by day then account, so a re-run\'s log is diffable', async () => {
    const rows = [
      ...grants(4, { accountId: 'zed', grantedAt: D2 + 1 }),
      ...grants(4, { accountId: 'bob', grantedAt: D2 + 1 }),
      ...grants(4, { accountId: 'zed' }),
    ];
    expect(auditGrants(rows).map((f) => `${f.dayKey}/${f.accountId}`)).toEqual([
      '2026-09-04/zed',
      '2026-09-05/bob',
      '2026-09-05/zed',
    ]);
  });

  it('records first/last even when the rows arrive out of order', async () => {
    // The function is pure and its contract must not depend on a caller it cannot see —
    // `readGrantsInWindow` happens to sort, and that is not something this can rely on.
    const rows = [
      grant({ sku: 'a', grantedAt: D1 + 500 }),
      grant({ sku: 'b', grantedAt: D1 + 100 }),
      grant({ sku: 'c', grantedAt: D1 + 900 }),
      grant({ sku: 'd', grantedAt: D1 + 300 }),
    ];
    const f = auditGrants(rows)[0]!;
    expect(f.firstAt).toBe(D1 + 100);
    expect(f.lastAt).toBe(D1 + 900);
    // The SKUs stay in arrival order — the evidence is what happened, not a sorted set.
    expect(f.skus).toEqual(['a', 'b', 'c', 'd']);
  });

  it('a grant at the last millisecond of a day belongs to that day', async () => {
    const rows = grants(4, { grantedAt: D2 - 1 });
    expect(auditGrants(rows)[0]!.dayKey).toBe('2026-09-04');
  });
});

describe('readGrantsInWindow — against the real entitlements table', () => {
  function account(id: string): string {
    accounts
      .prepare('INSERT INTO accounts (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)')
      .run(id, `user-${id}`, 'hash', D1);
    return id;
  }

  it('reads what EntitlementService actually wrote, windowed half-open on granted_at', async () => {
    const ents = new EntitlementService(accounts);
    account('acc-1');
    ents.grant('acc-1', 'blueprint:a', 'grant', { nowMs: D1 });
    ents.grant('acc-1', 'blueprint:b', 'event', { nowMs: D2 - 1 });
    ents.grant('acc-1', 'blueprint:c', 'grant', { nowMs: D2 });

    const rows = readGrantsInWindow(accounts, D1, D2);
    expect(rows.map((r) => r.sku)).toEqual(['blueprint:a', 'blueprint:b']);
    expect(rows.map((r) => r.source)).toEqual(['grant', 'event']);
    expect(rows[0]!.accountId).toBe('acc-1');
  });

  it('reads purchases too — the SKIP is the audit\'s decision, not the query\'s', async () => {
    // Deliberate: the reader is dumb so the rule lives in one place, where the tests above can
    // see it. A query that filtered `source <> 'purchase'` would move the policy into SQL and
    // out of `countedSources`.
    const ents = new EntitlementService(accounts);
    account('acc-1');
    ents.grant('acc-1', 'blueprint:paid', 'purchase', { orderId: 'o-1', nowMs: D1 });
    expect(readGrantsInWindow(accounts, D1, D2).map((r) => r.source)).toEqual(['purchase']);
    expect(auditGrants(readGrantsInWindow(accounts, D1, D2), { threshold: 0 })).toEqual([]);
  });

  it('spans accounts and is ordered oldest first', async () => {
    const ents = new EntitlementService(accounts);
    account('acc-1');
    account('acc-2');
    ents.grant('acc-2', 'blueprint:b', 'grant', { nowMs: D1 + 200 });
    ents.grant('acc-1', 'blueprint:a', 'grant', { nowMs: D1 + 100 });
    expect(readGrantsInWindow(accounts, D1, D2).map((r) => r.accountId)).toEqual(['acc-1', 'acc-2']);
  });

  it('is empty for a window with nothing in it', async () => {
    expect(readGrantsInWindow(accounts, D1, D2)).toEqual([]);
  });
});

describe('fileGrantAnomalies — files, never acts', () => {
  it('files one review entry per finding, keyed on (account, day)', async () => {
    const findings = auditGrants([...grants(4), ...grants(4, { accountId: 'acc-2' })]);
    expect(await fileGrantAnomalies(billing, findings, 7_000)).toBe(2);

    const entry = (await reviewById(billing, grantAnomalyId('acc-1', '2026-09-04')))!;
    expect(entry.kind).toBe('grant-anomaly');
    expect(entry.state).toBe('open');
    expect(entry.dayKey).toBe('2026-09-04');
    expect(entry.createdAt).toBe(7_000);
    expect(entry.summary).toContain('4 non-purchase entitlement(s)');
    expect(entry.summary).toContain('nothing revoked');
    // The whole finding is the evidence, so a reviewer needs no second query.
    expect((entry.evidence as { count: number }).count).toBe(4);
    expect((entry.evidence as { bySource: Record<string, number> }).bySource).toEqual({ grant: 4 });
  });

  it('re-running the audit over the same day files NOTHING the second time', async () => {
    // The property that makes the job safe to re-run, and therefore the property that makes it
    // get run at all. `(accountId, dayKey)` is the key; a second pass finds it taken.
    const findings = auditGrants(grants(4));
    expect(await fileGrantAnomalies(billing, findings, 7_000)).toBe(1);
    expect(await fileGrantAnomalies(billing, findings, 9_000)).toBe(0);
    expect(await openReviews(billing)).toHaveLength(1);
    expect((await reviewById(billing, grantAnomalyId('acc-1', '2026-09-04')))!.createdAt).toBe(7_000);
  });

  it('a re-run does not reopen a finding a human already closed', async () => {
    const findings = auditGrants(grants(4));
    await fileGrantAnomalies(billing, findings, 7_000);
    await markReviewed(billing, grantAnomalyId('acc-1', '2026-09-04'), 8_000, 'campaign, expected');
    expect(await fileGrantAnomalies(billing, findings, 9_000)).toBe(0);
    expect(await openReviews(billing)).toEqual([]);
  });

  it('counts only the NEW rows when some of the batch was already filed', async () => {
    await fileGrantAnomalies(billing, auditGrants(grants(4)), 7_000);
    const both = auditGrants([...grants(4), ...grants(4, { accountId: 'acc-2' })]);
    expect(await fileGrantAnomalies(billing, both, 9_000)).toBe(1);
    expect(await openReviews(billing)).toHaveLength(2);
  });

  it('REVOKES NOTHING — the entitlements are all still there afterwards', async () => {
    // design/19 §7: "No automatic revocation." Asserted against the real table rather than
    // trusted to a comment, because it is the one property whose violation is unrecoverable.
    const ents = new EntitlementService(accounts);
    accounts
      .prepare('INSERT INTO accounts (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)')
      .run('acc-1', 'user', 'hash', D1);
    for (const n of [1, 2, 3, 4, 5]) ents.grant('acc-1', `blueprint:w${n}`, 'grant', { nowMs: D1 + n });

    const findings = auditGrants(readGrantsInWindow(accounts, D1, D2));
    expect(findings).toHaveLength(1);
    await fileGrantAnomalies(billing, findings, 7_000);

    expect(ents.list('acc-1')).toHaveLength(5);
    expect(ents.owns('acc-1', 'blueprint:w1')).toBe(true);
  });

  it('files nothing for an empty finding list', async () => {
    expect(await fileGrantAnomalies(billing, [], 1_000)).toBe(0);
    expect(await openReviews(billing)).toEqual([]);
  });
});

describe('formatFinding', () => {
  it('names the count, the day, the threshold, the source breakdown and the inaction', async () => {
    const finding = auditGrants([...grants(3), ...grants(2, { source: 'event' })])[0]!;
    const line = formatFinding(finding);
    expect(line).toContain("account 'acc-1'");
    expect(line).toContain('5 non-purchase entitlement(s)');
    expect(line).toContain('2026-09-04');
    expect(line).toContain('threshold 3');
    expect(line).toContain('event×2');
    expect(line).toContain('grant×3');
    // The last clause is the point of the whole module and belongs in the line a human reads.
    expect(line).toContain('nothing revoked');
  });

  it('orders the source breakdown deterministically', async () => {
    const rows = [...grants(1, { source: 'starter' }), ...grants(1, { source: 'drop' }), ...grants(2)];
    const line = formatFinding(auditGrants(rows, { threshold: 0 })[0]!);
    expect(line).toContain('drop×1, grant×2, starter×1');
  });
});
