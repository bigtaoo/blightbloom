/**
 * The three read-only views (design/21 §3.2).
 *
 * Every case here seeds REAL collections on the suite's own mongod, with the indexes and
 * validators this repo's own installers create, and queries through the same handles
 * `openAdminDbs` hands the page. The reason is not thoroughness for its own sake — it is
 * that two of the three sections are only interesting on data a live box may not produce
 * for weeks (a cohort cell that is unknown rather than zero, a search term containing a
 * regex metacharacter), and a fixture assembled by hand would let this file agree with
 * itself while disagreeing with the collections.
 *
 * The retention fixture in particular is produced by `persistRollup` — the shipped writer,
 * run once per simulated day — rather than by inserting `dailyRollup` documents directly. A
 * grid test whose documents were written by the test is a test of the test.
 *
 * ## What the port changed here, beyond `await`
 *
 * The handles are no longer read-only, and nothing in this file can make them so: B1 is an
 * Atlas role now and `adminsvc.dbs.test.ts` is where what is left of it is proven. So these
 * cases seed through the same handle they read through, which the old ones could not. The
 * property that survives is the one they were actually about — that the READS are right —
 * and the property that does not is stated where it went.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Db } from 'mongodb';
import { ensureAccountsIndexes, type AccountDoc } from '../src/db';
import { billingStore, ensureBillingIndexes } from '../src/billingDb';
import { dailyActiveOf, dailyRollupOf, ensureAnalyticsIndexes, eventsOf } from '../src/analytics/db';
import { addDays, persistRollup } from '../src/analytics/rollup';
import { escapeRegex, searchPlayers, PLAYER_PAGE_SIZE, MAX_QUERY_LENGTH } from '../src/adminsvc/views/players';
import { commerceSnapshot, RAW_PREVIEW_CHARS } from '../src/adminsvc/views/commerce';
import { cohortGrid, hostFromLabels, offsetFromLabels } from '../src/adminsvc/views/retention';
import { openTestMongo, type MongoTestContext } from './mongoHarness';

let ctx: MongoTestContext;

beforeEach(async () => {
  ctx = await openTestMongo();
});
afterEach(async () => {
  await ctx.dispose();
});

// ───────────────────────────────── players ─────────────────────────────────

interface SeededAccount {
  id: string;
  username: string;
  display?: string;
  provider?: string;
  createdAt: number;
  rating?: number;
  skus?: string[];
}

async function seedAccounts(accounts: readonly SeededAccount[]): Promise<Db> {
  const db = ctx.db('accounts');
  await ensureAccountsIndexes(db);
  for (const a of accounts) {
    // `displayName` is OMITTED for a local account rather than set to null — `db.ts`'s rule,
    // and the reason `searchPlayers` maps absence to `null` at its own boundary instead of
    // letting the two spellings reach the page.
    const doc: AccountDoc = {
      _id: a.id,
      username: a.username,
      passwordHash: 'hash',
      provider: a.provider ?? 'local',
      createdAt: a.createdAt,
      ...(a.display === undefined ? {} : { displayName: a.display }),
    };
    await db.collection<AccountDoc>('accounts').insertOne(doc);
    if (a.rating !== undefined) await db.collection('ratings').insertOne({ _id: a.id, rating: a.rating } as never);
    for (const sku of a.skus ?? []) {
      await db.collection('entitlements').insertOne({
        accountId: a.id,
        sku,
        source: 'grant',
        grantedAt: a.createdAt,
      } as never);
    }
  }
  return db;
}

describe('searchPlayers', () => {
  const roster: SeededAccount[] = [
    { id: 'a1', username: 'zoe', createdAt: 3000, rating: 1180, skus: ['blueprint:cannon', 'character:scout'] },
    { id: 'a2', username: 'cg:11223', display: 'Zoë from the portal', provider: 'cg', createdAt: 2000 },
    { id: 'a3', username: 'quiet_one', createdAt: 1000, rating: 1000 },
  ];

  it('lists the newest accounts first for an empty query, with no analytics database', async () => {
    const db = await seedAccounts(roster);
    const result = await searchPlayers(db, null, '');
    expect(result.rows.map((r) => r.id)).toEqual(['a1', 'a2', 'a3']);
    expect(result.matched).toBe(3);
    expect(result.truncated).toBe(false);
    expect(result.term).toBe('');
    // Every last-active cell is blank when there is no analytics handle — the column's only
    // source. The section renders that as `n/a` rather than `—`, which is the page's job.
    expect(result.rows.every((r) => r.lastActiveDay === null)).toBe(true);
  });

  it('reports absent rating and absent entitlements as absent, not as zero and not as empty strings', async () => {
    const db = await seedAccounts(roster);
    const rows = (await searchPlayers(db, null, '')).rows;
    const portal = rows.find((r) => r.id === 'a2')!;
    // A rating of 0 would read as "lost every match"; `null` reads as "has not played",
    // which is what a missing `ratings` document means (`rating.ts` writes one on settlement).
    expect(portal.rating).toBeNull();
    expect(portal.entitlements).toEqual([]);
    expect(portal.displayName).toBe('Zoë from the portal');
    expect(portal.provider).toBe('cg');
    // ...and the contrast, so the null above is not just "this query returns nulls".
    const local = rows.find((r) => r.id === 'a1')!;
    expect(local.rating).toBe(1180);
    expect(local.displayName).toBeNull();
    expect(local.entitlements).toEqual(['blueprint:cannon', 'character:scout']);
  });

  it('matches on username OR display name', async () => {
    const db = await seedAccounts(roster);
    expect((await searchPlayers(db, null, 'zoe')).rows.map((r) => r.id)).toEqual(['a1']);
    // The portal account's LOGIN handle is `cg:11223`; `Zoë` only appears in its display
    // name, which is the half a username-only search would miss — and the half an operator
    // has, because it is the only name the platform shows them.
    expect((await searchPlayers(db, null, 'Zoë')).rows.map((r) => r.id)).toEqual(['a2']);
    expect((await searchPlayers(db, null, 'cg:')).rows.map((r) => r.id)).toEqual(['a2']);
  });

  it('matches case-insensitively, the way the LIKE it replaces did', async () => {
    // `$options: 'i'`, NOT the `accounts_username_ci` collation — `$regex` does not honour a
    // query collation, so asking for one would produce a search that is case-sensitive in a
    // way nothing on the page could explain. Pinned because it is a behaviour the port could
    // have lost silently: every seeded username here is already lower case, so only a search
    // in the other case notices.
    const db = await seedAccounts(roster);
    expect((await searchPlayers(db, null, 'ZOE')).rows.map((r) => r.id)).toEqual(['a1']);
    expect((await searchPlayers(db, null, 'Quiet_One')).rows.map((r) => r.id)).toEqual(['a3']);
  });

  it('treats a regex metacharacter as a literal, not as "match everything"', async () => {
    // The hole that replaced the LIKE wildcard, and it is a bigger one. Without
    // `escapeRegex`, a search for `.` returns every account with at least one character, and
    // a search for `.*` returns the whole collection. Both look like a typo rather than a
    // query, which is exactly why nobody would notice.
    const db = await seedAccounts([
      ...roster,
      { id: 'a4', username: 'per.cent', createdAt: 4000 },
      { id: 'a5', username: 'literal100pct', display: '100% done', createdAt: 5000 },
    ]);
    expect((await searchPlayers(db, null, '%')).rows.map((r) => r.id)).toEqual(['a5']);
    expect((await searchPlayers(db, null, '.')).rows.map((r) => r.id)).toEqual(['a4']);
    expect((await searchPlayers(db, null, '.*')).rows).toEqual([]);
    // ...and the counts agree with the rows, so the escape is applied to BOTH queries — a
    // count that forgot it would report 5 under a 1-row table and the page would say
    // "1 shown of 5 matching", which is a lie in the direction nobody checks.
    expect((await searchPlayers(db, null, '%')).matched).toBe(1);
    expect((await searchPlayers(db, null, '.')).matched).toBe(1);
    expect((await searchPlayers(db, null, '')).matched).toBe(5);
  });

  it('escapes the escape character itself, and the quantifiers a ReDoS is built from', async () => {
    expect(escapeRegex('a.b*c+d?e^f$g{h}i(j)k|l[m]n\\o')).toBe(
      'a\\.b\\*c\\+d\\?e\\^f\\$g\\{h\\}i\\(j\\)k\\|l\\[m\\]n\\\\o',
    );
    const db = await seedAccounts([{ id: 'b1', username: 'back\\slash', createdAt: 1 }]);
    expect((await searchPlayers(db, null, 'back\\slash')).rows.map((r) => r.id)).toEqual(['b1']);
  });

  it('REFUSES a query operator posing as a search term', async () => {
    // The injection shape SQL did not have. `{ username: { $ne: null } }` matches every
    // account and needs no quote to escape out of, so bound parameters — the thing that
    // closed the SQL hole — are no defence at all. `searchPlayers`'s `typeof` guard is what
    // refuses it, and it is the same guard `AuthService.login` carries for the same reason.
    //
    // Nothing can reach this through the console today, because `URL.searchParams` yields
    // strings. That is a property of the CALLER, and this pins the one the function itself
    // holds.
    const db = await seedAccounts(roster);
    const evil = await searchPlayers(db, null, { $ne: null } as never);
    // Treated as an empty term, which lists everything — the same answer an operator gets by
    // opening the page, and not a leak. What matters is that it is the EMPTY-term path and
    // not an operator handed to the driver.
    expect(evil.term).toBe('');
    expect(evil.rows.map((r) => r.id)).toEqual(['a1', 'a2', 'a3']);
  });

  it('reports truncation with the FULL match count behind it', async () => {
    // "50 shown" that looks like the whole answer is the bug; `matched` is what lets the
    // page say "of 120".
    const many = Array.from({ length: 60 }, (_, i) => ({
      id: `m${String(i).padStart(2, '0')}`,
      username: `player${i}`,
      createdAt: 1000 + i,
    }));
    const db = await seedAccounts(many);
    const result = await searchPlayers(db, null, '');
    expect(result.rows).toHaveLength(PLAYER_PAGE_SIZE);
    expect(result.matched).toBe(60);
    expect(result.truncated).toBe(true);
    // ...and not truncated when the page holds everything, which is the control.
    expect((await searchPlayers(db, null, 'player7')).truncated).toBe(false);
  });

  it('breaks a same-millisecond tie by id, so the page does not reshuffle on reload', async () => {
    // `{ createdAt: -1, _id: 1 }`, which was `ORDER BY a.created_at DESC, a.id ASC`. Three
    // accounts created in one millisecond is what a seeded box and a settled multi-account
    // test both produce, and an unstable order is a page that changes for no visible reason.
    const db = await seedAccounts([
      { id: 'c', username: 'c', createdAt: 5 },
      { id: 'a', username: 'a', createdAt: 5 },
      { id: 'b', username: 'b', createdAt: 5 },
    ]);
    expect((await searchPlayers(db, null, '')).rows.map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('trims and CUTS an over-long term, and reports the term it actually used', async () => {
    const db = await seedAccounts(roster);
    const long = `${'q'.repeat(MAX_QUERY_LENGTH + 20)}zoe`;
    const result = await searchPlayers(db, null, `  ${long}  `);
    expect(result.term).toHaveLength(MAX_QUERY_LENGTH);
    // The point of returning it: the search box shows the 64 characters that were used, so
    // a paste that silently lost its tail is visible rather than mystifying.
    expect(result.term).toBe('q'.repeat(MAX_QUERY_LENGTH));
    expect(result.rows).toEqual([]);
  });

  it('joins last-active out of the analytics EVENTS collection, per account', async () => {
    // design/21 §3.2 named `daily_active` for this and it cannot answer: that collection's
    // fields are (day, install, host) and it holds no account id at all, on purpose. The
    // account link lives only on `events.accountId`, which the server attaches from the
    // bearer token.
    const accounts = await seedAccounts(roster);
    const analytics = ctx.db('analytics');
    await ensureAnalyticsIndexes(analytics);
    const event = (atMs: number, day: string, install: string, accountId: string | null) => ({
      atMs,
      day,
      name: 'session_start',
      install,
      session: `s${atMs}`,
      host: 'web',
      build: 'b',
      locale: 'en',
      accountId,
      props: {},
    });
    await eventsOf(analytics).insertMany([
      event(1, '2026-09-01', 'i1', 'a1'),
      event(2, '2026-09-05', 'i1', 'a1'),
      event(3, '2026-09-03', 'i2', 'a2'),
      // A guest event: no account at all, which is who retention is about. It must not become
      // any account's last-active day.
      event(4, '2026-09-09', 'i3', null),
    ]);

    const rows = (await searchPlayers(accounts, analytics, '')).rows;
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get('a1')!.lastActiveDay).toBe('2026-09-05'); // the NEWEST of two, not the first
    expect(byId.get('a2')!.lastActiveDay).toBe('2026-09-03');
    expect(byId.get('a3')!.lastActiveDay).toBeNull();
  });

  it('answers an empty page without reading every event ever recorded', async () => {
    // `$in: []` is a legal empty match rather than SQLite's `IN ()` syntax error, so the
    // short-circuit is no longer load-bearing for correctness in `entitlementsFor` — but it
    // still is in `lastActiveFor`, where the pipeline without it would `$group` the whole
    // events collection. Reached whenever a search matches nothing, which is most searches.
    const accounts = await seedAccounts([]);
    const analytics = ctx.db('analytics');
    await ensureAnalyticsIndexes(analytics);
    await eventsOf(analytics).insertOne({
      atMs: 1,
      day: '2026-09-01',
      name: 'session_start',
      install: 'i1',
      session: 's1',
      host: 'web',
      build: 'b',
      locale: 'en',
      accountId: 'someone-else',
      props: {},
    });
    const result = await searchPlayers(accounts, analytics, 'nobody');
    expect(result.rows).toEqual([]);
    expect(result.matched).toBe(0);
  });
});

// ───────────────────────────────── commerce ─────────────────────────────────

describe('commerceSnapshot', () => {
  async function emptyBilling(): Promise<Db> {
    const db = ctx.db('billing');
    await ensureBillingIndexes(db);
    return db;
  }

  async function seedBilling(): Promise<Db> {
    const db = await emptyBilling();
    const store = billingStore(db);
    await store.reviewQueue.insertMany([
      {
        _id: 'money-taken-nothing-granted:d1',
        kind: 'money-taken-nothing-granted',
        accountId: 'a1',
        dayKey: null,
        summary: 'paid, nothing granted',
        evidenceJson: '{"deliveryId":"d1"}',
        state: 'open',
        createdAt: 5000,
        reviewedAt: null,
        note: null,
      },
      {
        _id: 'grant-anomaly:a2:2026-09-01',
        kind: 'grant-anomaly',
        accountId: 'a2',
        dayKey: '2026-09-01',
        summary: '9 grants in one day',
        evidenceJson: '{"n":9}',
        state: 'open',
        createdAt: 1000,
        reviewedAt: null,
        note: null,
      },
      {
        _id: 'grant-anomaly:a3:2026-08-30',
        kind: 'grant-anomaly',
        accountId: 'a3',
        dayKey: '2026-08-30',
        summary: 'looked at',
        evidenceJson: '{"n":4}',
        state: 'reviewed',
        createdAt: 900,
        reviewedAt: 2000,
        note: 'legitimate event reward',
      },
    ]);
    await store.webhookEvents.insertMany([
      {
        _id: 'txn1:settled',
        platform: 'paddle',
        orderId: 'o1',
        txnId: 'txn1',
        eventType: 'transaction.completed',
        outcome: 'settled',
        detail: null,
        raw: '{"a":1}',
        firstSeenAt: 100,
        lastSeenAt: 200,
        seenCount: 2,
        divergences: 0,
      },
      {
        _id: 'txn2:rejected',
        platform: 'paddle',
        orderId: null,
        txnId: 'txn2',
        eventType: 'transaction.completed',
        outcome: 'rejected',
        detail: 'signature mismatch',
        raw: 'x'.repeat(RAW_PREVIEW_CHARS + 500),
        firstSeenAt: 300,
        lastSeenAt: 900,
        seenCount: 4,
        divergences: 3,
      },
      {
        _id: 'nokey:ignored',
        platform: 'paddle',
        orderId: null,
        txnId: null,
        eventType: 'subscription.updated',
        outcome: 'ignored',
        detail: null,
        raw: '{}',
        firstSeenAt: 50,
        lastSeenAt: 60,
        seenCount: 1,
        divergences: 0,
      },
    ]);
    return db;
  }

  it('puts OPEN findings in their own list, oldest first, and reviewed ones newest first', async () => {
    // A work list is read from the top and history from the bottom, and a single
    // time-ordered list buries two open items under three hundred reviewed ones.
    const snapshot = await commerceSnapshot(await seedBilling());
    expect(snapshot.openReviews.map((r) => r.id)).toEqual([
      'grant-anomaly:a2:2026-09-01',
      'money-taken-nothing-granted:d1',
    ]);
    expect(snapshot.openTotal).toBe(2);
    expect(snapshot.closedReviews.map((r) => r.id)).toEqual(['grant-anomaly:a3:2026-08-30']);
    expect(snapshot.closedReviews[0]!.note).toBe('legitimate event reward');
    expect(snapshot.closedReviews[0]!.reviewedAtMs).toBe(2000);
    expect(snapshot.openReviews[0]!.reviewedAtMs).toBeNull();
    expect(snapshot.openReviews[1]!.dayKey).toBeNull();
  });

  it('orders webhook documents by LAST seen, so a callback still being retried is on top', async () => {
    const snapshot = await commerceSnapshot(await seedBilling());
    expect(snapshot.webhooks.map((w) => w.id)).toEqual(['txn2:rejected', 'txn1:settled', 'nokey:ignored']);
    expect(snapshot.webhookTotal).toBe(3);
  });

  it('truncates a long raw body and SAYS it truncated', async () => {
    // The whole reason to read this field is to see exactly what arrived, so a cut that
    // looks complete is worse than no payload at all.
    const snapshot = await commerceSnapshot(await seedBilling());
    const long = snapshot.webhooks.find((w) => w.id === 'txn2:rejected')!;
    expect(long.raw).toHaveLength(RAW_PREVIEW_CHARS);
    expect(long.rawTruncated).toBe(true);
    // ...and a short one is not marked, which is the control for the flag.
    expect(snapshot.webhooks.find((w) => w.id === 'txn1:settled')!.rawTruncated).toBe(false);
  });

  it('cuts `raw` by code unit, so a multi-byte character cannot be split in half', async () => {
    // The reason the cut is a `slice` here rather than a `$substrBytes` projection: `raw` is
    // arbitrary UTF-8 a stranger chose, and a byte-wise cut lands mid-character whenever the
    // boundary falls inside one — producing a page with a replacement character in it and a
    // preview that is not what arrived. Built to land exactly on the boundary.
    const db = await emptyBilling();
    await billingStore(db).webhookEvents.insertOne({
      _id: 'multibyte',
      platform: 'paddle',
      orderId: null,
      txnId: null,
      eventType: 'unknown',
      outcome: 'ignored',
      detail: null,
      raw: `${'a'.repeat(RAW_PREVIEW_CHARS - 1)}€tail`,
      firstSeenAt: 1,
      lastSeenAt: 1,
      seenCount: 1,
      divergences: 0,
    });
    const preview = (await commerceSnapshot(db)).webhooks[0]!;
    expect(preview.raw.endsWith('€')).toBe(true);
    expect(preview.raw).not.toContain('�');
  });

  it('counts divergences over the WHOLE collection, not over the visible page', async () => {
    // `billing/collections.ts` calls a non-zero `divergences` the forgery shape: somebody
    // varying fields under a key they do not own. A count that only covered the page would
    // read zero on the day the divergent document is number 51.
    const snapshot = await commerceSnapshot(await seedBilling(), 1);
    expect(snapshot.webhooks).toHaveLength(1);
    expect(snapshot.divergentTotal).toBe(1);
    expect(snapshot.webhookTotal).toBe(3);
    // The limit applies to the review lists too, while their totals do not.
    expect(snapshot.openReviews).toHaveLength(1);
    expect(snapshot.openTotal).toBe(2);
  });

  it('carries a nullable order id, txn id and detail through as null', async () => {
    const snapshot = await commerceSnapshot(await seedBilling());
    const unkeyed = snapshot.webhooks.find((w) => w.id === 'nokey:ignored')!;
    expect(unkeyed.orderId).toBeNull();
    expect(unkeyed.txnId).toBeNull();
    expect(unkeyed.detail).toBeNull();
    expect(snapshot.webhooks.find((w) => w.id === 'txn2:rejected')!.detail).toBe('signature mismatch');
  });

  it('answers an empty database with empty lists and zero totals', async () => {
    expect(await commerceSnapshot(await emptyBilling())).toEqual({
      openReviews: [],
      closedReviews: [],
      openTotal: 0,
      webhooks: [],
      webhookTotal: 0,
      divergentTotal: 0,
    });
  });
});

// ───────────────────────────────── retention ─────────────────────────────────

describe('cohortGrid', () => {
  /**
   * A ten-day history with a real return curve, rolled up the way production does it: the
   * shipped `persistRollup` run once per simulated day, so each cohort's row fills in from
   * the left exactly as it would on the box. Nothing here writes a `dailyRollup` document by
   * hand.
   */
  async function seedAnalytics(): Promise<Db> {
    const db = ctx.db('analytics');
    await ensureAnalyticsIndexes(db);
    const day = (n: number) => addDays('2026-09-01', n);
    const active = async (d: string, install: string, host: string) => {
      // `$setOnInsert`, which is `INSERT OR IGNORE`: a returning install keeps the host it
      // FIRST arrived with (`analytics/db.ts`).
      await dailyActiveOf(db).updateOne({ day: d, install }, { $setOnInsert: { day: d, install, host } }, { upsert: true });
    };
    // 09-01: four installs. 09-02: two of them came back (D1 = 50%). 09-03: nobody at all,
    // which makes 09-02's D1 a MEASURED zero rather than an unknown. 09-08: one new install.
    for (const i of ['i1', 'i2', 'i3', 'i4']) await active(day(0), i, 'web');
    for (const i of ['i1', 'i2']) await active(day(1), i, 'web');
    await active(day(7), 'i9', 'crazygames');
    // Eleven daily runs of the real job, one per day, 09-02 through 09-12.
    for (let n = 1; n <= 11; n += 1) await persistRollup(db, day(n), 1_757_000_000_000 + n);
    return db;
  }

  it('renders a measured rate, a measured ZERO and an UNKNOWN as three different things', async () => {
    // The one rule this whole section exists for (design/21 §2.5): a cohort that has not
    // aged is not a zero. `rollup.ts` refuses to emit a gauge for it, so it arrives here as
    // a MISSING document — and a grid that rendered that as 0% would say "nobody came back"
    // for every cohort in the first week after launch.
    const grid = await cohortGrid(await seedAnalytics());
    const byDay = new Map(grid.rows.map((r) => [r.day, r]));

    const first = byDay.get('2026-09-01')!;
    expect(first.dau).toBe(4);
    expect(first.cells[1]).toEqual({ rate: 0.5, size: 4 }); // i1 and i2 of four
    expect(first.cells[2]).toEqual({ rate: 0, size: 4 }); // 09-03 had nobody: a real zero

    const second = byDay.get('2026-09-02')!;
    expect(second.dau).toBe(2);
    expect(second.cells[1]).toEqual({ rate: 0, size: 2 });

    // The newest cohort in the fixture: the job has only run three days past it, so D4–D7
    // are questions with no answer yet.
    const newest = byDay.get('2026-09-08')!;
    expect(newest.cells[1]).not.toBeNull();
    expect(newest.cells[2]).not.toBeNull();
    expect(newest.cells[3]).not.toBeNull();
    expect(newest.cells[4]).toBeNull();
    expect(newest.cells[7]).toBeNull();
  });

  it('orders cohorts newest first and offers every offset as a column', async () => {
    const grid = await cohortGrid(await seedAnalytics());
    const days = grid.rows.map((r) => r.day);
    expect([...days].sort().reverse()).toEqual(days);
    expect(grid.offsets).toEqual([1, 2, 3, 4, 5, 6, 7]);
    // Every row has a key for every offset, so the renderer never reads `undefined` and
    // never has to distinguish "no column" from "no answer".
    for (const row of grid.rows) expect(Object.keys(row.cells).map(Number).sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('includes a day that has a DAU document and no retention documents at all', async () => {
    // Every day younger than one offset is in this state, and it belongs in the grid with
    // empty cells: a missing ROW reads as "no data collected that day", which is a different
    // and wrong claim.
    const grid = await cohortGrid(await seedAnalytics());
    const bare = grid.rows.filter((r) => r.dau !== null && Object.values(r.cells).every((c) => c === null));
    expect(bare.length).toBeGreaterThan(0);
  });

  it('reports how many rollup documents the collection holds, so an empty grid is diagnosable', async () => {
    // §2.5's "the instrument must be shown to see the change", on the page: an empty grid
    // over zero documents is an empty collection, and an empty grid over a few hundred is a
    // bug in this reader. Without the number those look identical.
    const grid = await cohortGrid(await seedAnalytics());
    expect(grid.rollupRows).toBeGreaterThan(20);

    const emptyDb = ctx.db('analytics-empty' as never);
    await ensureAnalyticsIndexes(emptyDb);
    const empty = await cohortGrid(emptyDb);
    expect(empty.rows).toEqual([]);
    expect(empty.rollupRows).toBe(0);
  });

  it('IGNORES a retention document whose labels are not a d-offset', async () => {
    // The claim `offsetFromLabels` is written for: "a document written by some later metric
    // cannot land in a retention column". Reached by writing one — a `retention` document
    // labelled by host, which is what a future per-host retention metric would produce
    // before this grid knew about it. Without the guard, `offsetFromLabels` returning
    // something for it would put a rate in an arbitrary column, and the cell would look
    // exactly like a measurement.
    const db = await seedAnalytics();
    await dailyRollupOf(db).insertOne({
      day: '2026-09-01',
      metric: 'retention',
      labels: '{"host":"web"}',
      value: 0.99,
      computedAt: 1,
    });

    const grid = await cohortGrid(db);
    const first = grid.rows.find((r) => r.day === '2026-09-01')!;
    // The real D1 is untouched, and 0.99 appears in no cell at all.
    expect(first.cells[1]).toEqual({ rate: 0.5, size: 4 });
    for (const cell of Object.values(first.cells)) expect(cell?.rate).not.toBe(0.99);
  });

  it('drops a rate with NO cohort size behind it', async () => {
    // Both halves have to be present for a cell to be a measurement. `persistRollup` writes
    // the pair inside one transaction, so a rate alone means something is wrong with the
    // collection — and showing it as a number would hide exactly that.
    const db = await seedAnalytics();
    await dailyRollupOf(db).deleteMany({ metric: 'cohort_size', day: '2026-09-01' });
    const grid = await cohortGrid(db);
    const first = grid.rows.find((r) => r.day === '2026-09-01')!;
    expect(Object.values(first.cells).every((c) => c === null)).toBe(true);
    // ...and the day is still a ROW, with its DAU, rather than vanishing from the grid.
    expect(first.dau).toBe(4);
  });

  it('honours the day limit', async () => {
    const grid = await cohortGrid(await seedAnalytics(), 2);
    expect(grid.rows).toHaveLength(2);
  });

  it('takes its window from EVERY metric, not only the three it renders', async () => {
    // The `SELECT DISTINCT day … LIMIT ?` subquery this replaces took its days over the
    // whole table. Keeping that means a day that exists only because some later metric was
    // written for it still consumes one of the sixty — so the window does not silently
    // lengthen the day a metric is added. Asserted by writing a day that has ONLY such a
    // metric and checking it takes the slot rather than being skipped over.
    const db = await seedAnalytics();
    await dailyRollupOf(db).insertOne({
      day: '2026-09-30',
      metric: 'some_future_metric',
      labels: '{}',
      value: 1,
      computedAt: 1,
    });
    // Limit 1: the newest distinct day is 09-30, which renders none of the three metrics —
    // so the grid is EMPTY rather than showing the newest cohort.
    expect((await cohortGrid(db, 1)).rows).toEqual([]);
  });

  it('takes the host=all DAU total and ignores the per-host partition documents', async () => {
    // DAU by host is a PARTITION of DAU (`analytics/db.ts`'s header), so summing the
    // per-host documents here would be right today and wrong the moment one exists for a
    // host this grid does not know about. The fixture has two hosts, so a sum would show.
    const grid = await cohortGrid(await seedAnalytics());
    expect(grid.rows.find((r) => r.day === '2026-09-08')!.dau).toBe(1);
    expect(grid.rows.find((r) => r.day === '2026-09-01')!.dau).toBe(4);
  });
});

describe('the label readers', () => {
  it('parse a d offset only from a well-formed positive integer label', () => {
    // The field holds `canonicalLabels`'s output, so it is parsed rather than
    // pattern-matched: a `{ labels: /3/ }` would also match a host label containing a 3,
    // which is a miscount that looks like data.
    expect(offsetFromLabels('{"d":"3"}')).toBe(3);
    expect(offsetFromLabels('{"d":"12"}')).toBe(12);
    expect(offsetFromLabels('{"host":"web"}')).toBeNull();
    expect(offsetFromLabels('{"d":"0"}')).toBeNull();
    expect(offsetFromLabels('{"d":"-1"}')).toBeNull();
    expect(offsetFromLabels('{"d":"01"}')).toBeNull();
    expect(offsetFromLabels('{"d":3}')).toBeNull();
    expect(offsetFromLabels('not json')).toBeNull();
    expect(offsetFromLabels('null')).toBeNull();
    expect(offsetFromLabels('[1,2]')).toBeNull();
  });

  it('parse a host label, and nothing else', () => {
    expect(hostFromLabels('{"host":"web"}')).toBe('web');
    expect(hostFromLabels('{"host":"all"}')).toBe('all');
    expect(hostFromLabels('{"d":"1"}')).toBeNull();
    expect(hostFromLabels('{"host":7}')).toBeNull();
    expect(hostFromLabels('nope')).toBeNull();
    expect(hostFromLabels('null')).toBeNull();
  });
});
