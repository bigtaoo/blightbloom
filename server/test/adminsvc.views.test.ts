/**
 * The three read-only views (design/21 §3.2).
 *
 * Every case here seeds a REAL database with this repo's own openers, closes it, reopens it
 * the way adminsvc does (`readOnly: true`) and queries through that handle. The reason is
 * not thoroughness for its own sake — it is that two of the three sections are only
 * interesting on data a live box may not produce for weeks (a cohort cell that is unknown
 * rather than zero, a search term containing a LIKE wildcard), and a fixture assembled by
 * hand would let this file agree with itself while disagreeing with the tables.
 *
 * The retention fixture in particular is produced by `persistRollup` — the shipped writer,
 * run once per simulated day — rather than by inserting `daily_rollup` rows directly. A
 * grid test whose rows were written by the test is a test of the test.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db';
import { openBillingDb } from '../src/billingDb';
import { openAnalyticsDb, openAnalyticsDbReadOnly } from '../src/analytics/db';
import { addDays, persistRollup } from '../src/analytics/rollup';
import { openReadOnly } from '../src/adminsvc/dbs';
import { escapeLike, searchPlayers, PLAYER_PAGE_SIZE, MAX_QUERY_LENGTH } from '../src/adminsvc/views/players';
import { commerceSnapshot, RAW_PREVIEW_CHARS } from '../src/adminsvc/views/commerce';
import { cohortGrid, hostFromLabels, offsetFromLabels } from '../src/adminsvc/views/retention';

const dirs: string[] = [];
const open: DatabaseSync[] = [];

function scratch(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'bb-adminsvc-views-'));
  dirs.push(dir);
  return join(dir, name);
}

/** Reopens a path read-only the way `openAdminDbs` does, and registers it for teardown —
 *  on Windows an open SQLite handle locks the file and the scratch-dir removal EPERMs. */
function readOnly(path: string): DatabaseSync {
  const result = openReadOnly(path);
  if ('error' in result) throw new Error(result.error);
  open.push(result.db);
  return result.db;
}

/** The analytics database through its OWN read-only opener (`analytics/db.ts`), which is
 *  the function adminsvc's bundle actually calls. Registered for teardown the same way. */
function readOnlyAnalytics(path: string): DatabaseSync {
  const db = openAnalyticsDbReadOnly(path);
  open.push(db);
  return db;
}

afterEach(() => {
  while (open.length) open.pop()!.close();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

// ───────────────────────────────── players ─────────────────────────────────

interface SeededAccount {
  id: string;
  username: string;
  display?: string | null;
  provider?: string;
  createdAt: number;
  rating?: number;
  skus?: string[];
}

function seedAccounts(accounts: readonly SeededAccount[]): string {
  const path = scratch('accounts.db');
  const db = openDb(path);
  for (const a of accounts) {
    db.prepare(
      `INSERT INTO accounts (id, username, password_hash, provider, created_at, display_name)
       VALUES (?,?,?,?,?,?)`,
    ).run(a.id, a.username, 'hash', a.provider ?? 'local', a.createdAt, a.display ?? null);
    if (a.rating !== undefined) {
      db.prepare('INSERT INTO ratings (account_id, rating) VALUES (?,?)').run(a.id, a.rating);
    }
    for (const sku of a.skus ?? []) {
      db.prepare(
        `INSERT INTO entitlements (account_id, sku, source, granted_at) VALUES (?,?,?,?)`,
      ).run(a.id, sku, 'grant', a.createdAt);
    }
  }
  db.close();
  return path;
}

describe('searchPlayers', () => {
  const roster: SeededAccount[] = [
    { id: 'a1', username: 'zoe', createdAt: 3000, rating: 1180, skus: ['blueprint:cannon', 'character:scout'] },
    { id: 'a2', username: 'cg:11223', display: 'Zoë from the portal', provider: 'cg', createdAt: 2000 },
    { id: 'a3', username: 'quiet_one', createdAt: 1000, rating: 1000 },
  ];

  it('lists the newest accounts first for an empty query, with no analytics database', () => {
    const db = readOnly(seedAccounts(roster));
    const result = searchPlayers(db, null, '');
    expect(result.rows.map((r) => r.id)).toEqual(['a1', 'a2', 'a3']);
    expect(result.matched).toBe(3);
    expect(result.truncated).toBe(false);
    expect(result.term).toBe('');
    // Every last-active cell is blank when there is no analytics handle — the column's only
    // source. The section renders that as `n/a` rather than `—`, which is the page's job.
    expect(result.rows.every((r) => r.lastActiveDay === null)).toBe(true);
  });

  it('reports absent rating and absent entitlements as absent, not as zero and not as empty strings', () => {
    const db = readOnly(seedAccounts(roster));
    const rows = searchPlayers(db, null, '').rows;
    const portal = rows.find((r) => r.id === 'a2')!;
    // A rating of 0 would read as "lost every match"; `null` reads as "has not played",
    // which is what a missing `ratings` row means (`rating.ts` writes one on settlement).
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

  it('matches on username OR display name', () => {
    const db = readOnly(seedAccounts(roster));
    expect(searchPlayers(db, null, 'zoe').rows.map((r) => r.id)).toEqual(['a1']);
    // The portal account's LOGIN handle is `cg:11223`; `Zoë` only appears in its display
    // name, which is the half a username-only search would miss — and the half an operator
    // has, because it is the only name the platform shows them.
    expect(searchPlayers(db, null, 'Zoë').rows.map((r) => r.id)).toEqual(['a2']);
    expect(searchPlayers(db, null, 'cg:').rows.map((r) => r.id)).toEqual(['a2']);
  });

  it('treats a LIKE wildcard as a literal character, not as "match everything"', () => {
    // The one that would be a real hole: without `escapeLike`, a search for `%` returns the
    // whole accounts table and a search for `_` returns every one-character username. Both
    // look like a typo rather than a query, which is exactly why nobody would notice.
    const db = readOnly(
      seedAccounts([
        ...roster,
        { id: 'a4', username: 'per_cent', createdAt: 4000 },
        { id: 'a5', username: 'literal100pct', display: '100% done', createdAt: 5000 },
      ]),
    );
    expect(searchPlayers(db, null, '%').rows.map((r) => r.id)).toEqual(['a5']);
    // Two accounts really do have an underscore in their name (`per_cent`, `quiet_one`), so
    // the answer is those two and not the five the wildcard would have returned.
    expect(searchPlayers(db, null, '_').rows.map((r) => r.id)).toEqual(['a4', 'a3']);
    // ...and the counts agree with the rows, so the escape is applied to BOTH statements —
    // a count query that forgot it would report 5 under a 1-row table and the page would
    // say "1 shown of 5 matching", which is a lie in the direction nobody checks.
    expect(searchPlayers(db, null, '%').matched).toBe(1);
    expect(searchPlayers(db, null, '_').matched).toBe(2);
    expect(searchPlayers(db, null, '').matched).toBe(5);
  });

  it('escapes a backslash too, so the escape character cannot be smuggled in', () => {
    expect(escapeLike('a\\b%c_d')).toBe('a\\\\b\\%c\\_d');
    const db = readOnly(seedAccounts([{ id: 'b1', username: 'back\\slash', createdAt: 1 }]));
    expect(searchPlayers(db, null, 'back\\slash').rows.map((r) => r.id)).toEqual(['b1']);
  });

  it('reports truncation with the FULL match count behind it', () => {
    // "50 shown" that looks like the whole answer is the bug; `matched` is what lets the
    // page say "of 120".
    const many = Array.from({ length: 60 }, (_, i) => ({
      id: `m${String(i).padStart(2, '0')}`,
      username: `player${i}`,
      createdAt: 1000 + i,
    }));
    const db = readOnly(seedAccounts(many));
    const result = searchPlayers(db, null, '');
    expect(result.rows).toHaveLength(PLAYER_PAGE_SIZE);
    expect(result.matched).toBe(60);
    expect(result.truncated).toBe(true);
    // ...and not truncated when the page holds everything, which is the control.
    expect(searchPlayers(db, null, 'player7').truncated).toBe(false);
  });

  it('trims and CUTS an over-long term, and reports the term it actually used', () => {
    const db = readOnly(seedAccounts(roster));
    const long = `${'q'.repeat(MAX_QUERY_LENGTH + 20)}zoe`;
    const result = searchPlayers(db, null, `  ${long}  `);
    expect(result.term).toHaveLength(MAX_QUERY_LENGTH);
    // The point of returning it: the search box shows the 64 characters that were used, so
    // a paste that silently lost its tail is visible rather than mystifying.
    expect(result.term).toBe('q'.repeat(MAX_QUERY_LENGTH));
    expect(result.rows).toEqual([]);
  });

  it('joins last-active out of the analytics EVENTS table, per account', () => {
    // design/21 §3.2 named `daily_active` for this and it cannot answer: that table's
    // columns are (day, install, host) and it holds no account id at all, on purpose. The
    // account link lives only on `events.account_id`, which the server attaches from the
    // bearer token.
    const accountsPath = seedAccounts(roster);
    const analyticsPath = scratch('analytics.db');
    const writer = openAnalyticsDb(analyticsPath);
    const insert = writer.prepare(
      `INSERT INTO events (at_ms, day, name, install, session, host, build, locale, account_id, props)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    );
    insert.run(1, '2026-09-01', 'session_start', 'i1', 's1', 'web', 'b', 'en', 'a1', '{}');
    insert.run(2, '2026-09-05', 'session_start', 'i1', 's2', 'web', 'b', 'en', 'a1', '{}');
    insert.run(3, '2026-09-03', 'session_start', 'i2', 's3', 'web', 'b', 'en', 'a2', '{}');
    // A guest event: no account at all, which is who retention is about. It must not become
    // any account's last-active day.
    insert.run(4, '2026-09-09', 'session_start', 'i3', 's4', 'web', 'b', 'en', null, '{}');
    writer.close();

    const rows = searchPlayers(readOnly(accountsPath), readOnlyAnalytics(analyticsPath), '').rows;
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get('a1')!.lastActiveDay).toBe('2026-09-05'); // the NEWEST of two, not the first
    expect(byId.get('a2')!.lastActiveDay).toBe('2026-09-03');
    expect(byId.get('a3')!.lastActiveDay).toBeNull();
  });

  it('answers an empty page without a syntax error', () => {
    // `IN ()` is a syntax error in SQLite rather than an empty match, so both helper
    // queries short-circuit on an empty id list. Reached whenever a search matches nothing,
    // which is most searches.
    const db = readOnly(seedAccounts([]));
    const result = searchPlayers(db, null, 'nobody');
    expect(result.rows).toEqual([]);
    expect(result.matched).toBe(0);
  });
});

// ───────────────────────────────── commerce ─────────────────────────────────

describe('commerceSnapshot', () => {
  function seedBilling(): string {
    const path = scratch('billing.db');
    const db = openBillingDb(path);
    const review = db.prepare(
      `INSERT INTO review_queue (id, kind, account_id, day_key, summary, evidence_json, state, created_at, reviewed_at, note)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    );
    review.run('money-taken-nothing-granted:d1', 'money-taken-nothing-granted', 'a1', null, 'paid, nothing granted', '{"deliveryId":"d1"}', 'open', 5000, null, null);
    review.run('grant-anomaly:a2:2026-09-01', 'grant-anomaly', 'a2', '2026-09-01', '9 grants in one day', '{"n":9}', 'open', 1000, null, null);
    review.run('grant-anomaly:a3:2026-08-30', 'grant-anomaly', 'a3', '2026-08-30', 'looked at', '{"n":4}', 'reviewed', 900, 2000, 'legitimate event reward');

    const hook = db.prepare(
      `INSERT INTO webhook_events (id, platform, order_id, txn_id, event_type, outcome, detail, raw,
        first_seen_at, last_seen_at, seen_count, divergences)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    hook.run('txn1:settled', 'paddle', 'o1', 'txn1', 'transaction.completed', 'settled', null, '{"a":1}', 100, 200, 2, 0);
    hook.run('txn2:rejected', 'paddle', null, 'txn2', 'transaction.completed', 'rejected', 'signature mismatch', 'x'.repeat(RAW_PREVIEW_CHARS + 500), 300, 900, 4, 3);
    hook.run('nokey:ignored', 'paddle', null, null, 'subscription.updated', 'ignored', null, '{}', 50, 60, 1, 0);
    db.close();
    return path;
  }

  it('puts OPEN findings in their own list, oldest first, and reviewed ones newest first', () => {
    // A work list is read from the top and history from the bottom, and a single
    // time-ordered list buries two open items under three hundred reviewed ones.
    const snapshot = commerceSnapshot(readOnly(seedBilling()));
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

  it('orders webhook rows by LAST seen, so a callback still being retried is on top', () => {
    const snapshot = commerceSnapshot(readOnly(seedBilling()));
    expect(snapshot.webhooks.map((w) => w.id)).toEqual(['txn2:rejected', 'txn1:settled', 'nokey:ignored']);
    expect(snapshot.webhookTotal).toBe(3);
  });

  it('truncates a long raw body and SAYS it truncated', () => {
    // The whole reason to read this column is to see exactly what arrived, so a cut that
    // looks complete is worse than no payload at all.
    const snapshot = commerceSnapshot(readOnly(seedBilling()));
    const long = snapshot.webhooks.find((w) => w.id === 'txn2:rejected')!;
    expect(long.raw).toHaveLength(RAW_PREVIEW_CHARS);
    expect(long.rawTruncated).toBe(true);
    // ...and a short one is not marked, which is the control for the flag.
    expect(snapshot.webhooks.find((w) => w.id === 'txn1:settled')!.rawTruncated).toBe(false);
  });

  it('counts divergences over the WHOLE table, not over the visible page', () => {
    // `billingDb.ts` calls a non-zero `divergences` the forgery shape: somebody varying
    // fields under a key they do not own. A count that only covered the page would read
    // zero on the day the divergent row is row 51.
    const path = seedBilling();
    const snapshot = commerceSnapshot(readOnly(path), 1);
    expect(snapshot.webhooks).toHaveLength(1);
    expect(snapshot.divergentTotal).toBe(1);
    expect(snapshot.webhookTotal).toBe(3);
    // The limit applies to the review lists too, while their totals do not.
    expect(snapshot.openReviews).toHaveLength(1);
    expect(snapshot.openTotal).toBe(2);
  });

  it('carries a nullable order id, txn id and detail through as null', () => {
    const snapshot = commerceSnapshot(readOnly(seedBilling()));
    const unkeyed = snapshot.webhooks.find((w) => w.id === 'nokey:ignored')!;
    expect(unkeyed.orderId).toBeNull();
    expect(unkeyed.txnId).toBeNull();
    expect(unkeyed.detail).toBeNull();
    expect(snapshot.webhooks.find((w) => w.id === 'txn2:rejected')!.detail).toBe('signature mismatch');
  });

  it('answers an empty database with empty lists and zero totals', () => {
    const snapshot = commerceSnapshot(readOnly(scratchBilling()));
    expect(snapshot).toEqual({
      openReviews: [],
      closedReviews: [],
      openTotal: 0,
      webhooks: [],
      webhookTotal: 0,
      divergentTotal: 0,
    });
  });

  function scratchBilling(): string {
    const path = scratch('billing.db');
    openBillingDb(path).close();
    return path;
  }
});

// ───────────────────────────────── retention ─────────────────────────────────

describe('cohortGrid', () => {
  /**
   * A ten-day history with a real return curve, rolled up the way production does it: the
   * shipped `persistRollup` run once per simulated day, so each cohort's row fills in from
   * the left exactly as it would on the box. Nothing here writes a `daily_rollup` row by
   * hand.
   */
  function seedAnalytics(): string {
    const path = scratch('analytics.db');
    const db = openAnalyticsDb(path);
    const active = db.prepare('INSERT OR IGNORE INTO daily_active (day, install, host) VALUES (?,?,?)');
    const day = (n: number) => addDays('2026-09-01', n);
    // 09-01: four installs. 09-02: two of them came back (D1 = 50%). 09-03: nobody at all,
    // which makes 09-02's D1 a MEASURED zero rather than an unknown. 09-08: one new install.
    for (const i of ['i1', 'i2', 'i3', 'i4']) active.run(day(0), i, 'web');
    for (const i of ['i1', 'i2']) active.run(day(1), i, 'web');
    active.run(day(7), 'i9', 'crazygames');
    // Eleven daily runs of the real job, one per day, 09-02 through 09-12.
    for (let n = 1; n <= 11; n += 1) persistRollup(db, day(n), 1_757_000_000_000 + n);
    db.close();
    return path;
  }

  it('renders a measured rate, a measured ZERO and an UNKNOWN as three different things', () => {
    // The one rule this whole section exists for (design/21 §2.5): a cohort that has not
    // aged is not a zero. `rollup.ts` refuses to emit a gauge for it, so it arrives here as
    // a MISSING ROW — and a grid that rendered a missing row as 0% would say "nobody came
    // back" for every cohort in the first week after launch.
    const grid = cohortGrid(readOnlyAnalytics(seedAnalytics()));
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

  it('orders cohorts newest first and offers every offset as a column', () => {
    const grid = cohortGrid(readOnlyAnalytics(seedAnalytics()));
    const days = grid.rows.map((r) => r.day);
    expect([...days].sort().reverse()).toEqual(days);
    expect(grid.offsets).toEqual([1, 2, 3, 4, 5, 6, 7]);
    // Every row has a key for every offset, so the renderer never reads `undefined` and
    // never has to distinguish "no column" from "no answer".
    for (const row of grid.rows) expect(Object.keys(row.cells).map(Number).sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('includes a day that has a DAU row and no retention rows at all', () => {
    // Every day younger than one offset is in this state, and it belongs in the grid with
    // empty cells: a missing ROW reads as "no data collected that day", which is a different
    // and wrong claim.
    const grid = cohortGrid(readOnlyAnalytics(seedAnalytics()));
    const bare = grid.rows.filter((r) => r.dau !== null && Object.values(r.cells).every((c) => c === null));
    expect(bare.length).toBeGreaterThan(0);
  });

  it('reports how many rollup rows the table holds, so an empty grid is diagnosable', () => {
    // §2.5's "the instrument must be shown to see the change", on the page: an empty grid
    // over zero rows is an empty database, and an empty grid over a few hundred is a bug in
    // this reader. Without the number those look identical.
    const grid = cohortGrid(readOnlyAnalytics(seedAnalytics()));
    expect(grid.rollupRows).toBeGreaterThan(20);

    const emptyPath = scratch('analytics.db');
    openAnalyticsDb(emptyPath).close();
    const empty = cohortGrid(readOnlyAnalytics(emptyPath));
    expect(empty.rows).toEqual([]);
    expect(empty.rollupRows).toBe(0);
  });

  it('IGNORES a retention row whose labels are not a d-offset', () => {
    // The claim `offsetFromLabels` is written for: "a row written by some later metric
    // cannot land in a retention column". Reached by writing one — a `retention` row
    // labelled by host, which is what a future per-host retention metric would produce
    // before this grid knew about it. Without the guard, `offsetFromLabels` returning
    // something for it would put a rate in an arbitrary column, and the cell would look
    // exactly like a measurement.
    const path = seedAnalytics();
    const writer = openAnalyticsDb(path);
    writer
      .prepare('INSERT OR REPLACE INTO daily_rollup (day, metric, labels, value, computed_at) VALUES (?,?,?,?,?)')
      .run('2026-09-01', 'retention', '{"host":"web"}', 0.99, 1);
    writer.close();

    const grid = cohortGrid(readOnlyAnalytics(path));
    const first = grid.rows.find((r) => r.day === '2026-09-01')!;
    // The real D1 is untouched, and 0.99 appears in no cell at all.
    expect(first.cells[1]).toEqual({ rate: 0.5, size: 4 });
    for (const cell of Object.values(first.cells)) expect(cell?.rate).not.toBe(0.99);
  });

  it('drops a rate with NO cohort size behind it', () => {
    // Both halves have to be present for a cell to be a measurement. `persistRollup` writes
    // the pair inside one transaction, so a rate alone means something is wrong with the
    // table — and showing it as a number would hide exactly that.
    const path = seedAnalytics();
    const writer = openAnalyticsDb(path);
    writer.prepare("DELETE FROM daily_rollup WHERE metric = 'cohort_size' AND day = '2026-09-01'").run();
    writer.close();
    const grid = cohortGrid(readOnlyAnalytics(path));
    const first = grid.rows.find((r) => r.day === '2026-09-01')!;
    expect(Object.values(first.cells).every((c) => c === null)).toBe(true);
    // ...and the day is still a ROW, with its DAU, rather than vanishing from the grid.
    expect(first.dau).toBe(4);
  });

  it('honours the day limit', () => {
    const grid = cohortGrid(readOnlyAnalytics(seedAnalytics()), 2);
    expect(grid.rows).toHaveLength(2);
  });

  it('takes the host=all DAU total and ignores the per-host partition rows', () => {
    // DAU by host is a PARTITION of DAU (`analytics/db.ts`'s header), so summing the
    // per-host rows here would be right today and wrong the moment a row exists for a host
    // this grid does not know about. The fixture has two hosts, so a sum would show.
    const grid = cohortGrid(readOnlyAnalytics(seedAnalytics()));
    expect(grid.rows.find((r) => r.day === '2026-09-08')!.dau).toBe(1);
    expect(grid.rows.find((r) => r.day === '2026-09-01')!.dau).toBe(4);
  });
});

describe('the label readers', () => {
  it('parse a d offset only from a well-formed positive integer label', () => {
    // The column holds `canonicalLabels`'s output, so it is parsed rather than
    // pattern-matched: a `labels LIKE '%3%'` would also match a host label containing a 3,
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
