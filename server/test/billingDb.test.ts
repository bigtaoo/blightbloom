/**
 * The billing plane's own SQLite file (design/19-server-platform.md §4).
 *
 * Two of these cases are about the SEPARATION rather than about SQL: that the billing DB
 * carries none of the account DB's tables and vice versa, and that the two read different
 * environment variables. "Money gets its own database file" is a locked decision, and the
 * way it gets undone is not a rewrite — it is one `openDb` reused, or one env var pointing
 * both planes at one path.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openBillingDb, defaultBillingDbPath } from '../src/billingDb';
import { openDb, defaultDbPath } from '../src/db';

const tmpDirs: string[] = [];
function tmpPath(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'bb-billing-'));
  tmpDirs.push(dir);
  return join(dir, name);
}

afterEach(() => {
  vi.unstubAllEnvs();
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

const tableNames = (db: ReturnType<typeof openBillingDb>): string[] =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[])
    .map((r) => r.name)
    .filter((n) => !n.startsWith('sqlite_'));

describe('openBillingDb', () => {
  it('creates exactly the six tables design/19 §4 and §7 specify, and no more', () => {
    // Three when this file shipped; `deliveries` is the fourth, added 2026-09-05 when the
    // entitlement loop closed — the outbox row a settlement writes inside its own
    // transaction because `entitlements` lives in a different database FILE. `webhook_events`
    // and `review_queue` are §7's operational pair (ROADMAP 8.5): every callback rather than
    // only the ones that settled, and the one place a human is told to look.
    const db = openBillingDb(':memory:');
    expect(tableNames(db)).toEqual([
      'deliveries',
      'ledger',
      'orders',
      'receipts',
      'review_queue',
      'webhook_events',
    ]);
    db.close();
  });

  it('carries NONE of the account DB\'s tables', () => {
    // The physical isolation, asserted from the inside. A shared opener would show up here
    // as `accounts`/`sessions` appearing in the billing file.
    const billing = openBillingDb(':memory:');
    const names = tableNames(billing);
    for (const accountTable of ['accounts', 'sessions', 'ratings', 'meta_state']) {
      expect(names).not.toContain(accountTable);
    }
    billing.close();
  });

  it('and the account DB carries none of the billing tables', () => {
    const accounts = openDb(':memory:');
    const names = tableNames(accounts);
    for (const billingTable of ['orders', 'receipts', 'ledger', 'deliveries']) {
      expect(names).not.toContain(billingTable);
    }
    accounts.close();
  });

  it('is idempotent — reopening an existing file does not wipe it', () => {
    const path = tmpPath('billing.db');
    const first = openBillingDb(path);
    first.prepare("INSERT INTO ledger (id, account_id, sku, kind, ts) VALUES ('l1', 'a1', 'bp.cannon', 'purchase', 1)").run();
    first.close();

    const second = openBillingDb(path);
    expect(second.prepare('SELECT COUNT(*) AS n FROM ledger').get()).toEqual({ n: 1 });
    second.close();
  });

  it('creates the parent directory for a path that does not exist yet', () => {
    const path = join(tmpPath('unused'), 'nested', 'deeper', 'billing.db');
    const db = openBillingDb(path);
    db.close();
    expect(existsSync(path)).toBe(true);
  });

  it('does not try to mkdir for :memory:', () => {
    // `dirname(':memory:')` is '.', so an unguarded mkdirSync would quietly create nothing
    // — but the guard is what keeps that true if the default path handling changes.
    expect(() => openBillingDb(':memory:').close()).not.toThrow();
  });
});

describe('the orders schema', () => {
  it('makes two settled orders sharing one platform transaction impossible', () => {
    const db = openBillingDb(':memory:');
    const insert = (id: string, txn: string | null) =>
      db
        .prepare(
          `INSERT INTO orders (id, account_id, sku, platform, amount_cents, currency, state, platform_txn_id, created_at)
           VALUES (?, 'a1', 'bp.cannon', 'dev', 1800, 'CNY', 'settled', ?, 1)`,
        )
        .run(id, txn);
    insert('o1', 'txn-1');
    expect(() => insert('o2', 'txn-1')).toThrow();
    db.close();
  });

  it('but lets any number of UNSETTLED orders coexist, because SQLite UNIQUE ignores NULLs', () => {
    // The property the settle path depends on: an order is booked with a NULL txn id, and
    // a player with three abandoned checkout attempts must not be blocked by the second.
    const db = openBillingDb(':memory:');
    for (const id of ['o1', 'o2', 'o3']) {
      db.prepare(
        `INSERT INTO orders (id, account_id, sku, platform, amount_cents, currency, state, platform_txn_id, created_at)
         VALUES (?, 'a1', 'bp.cannon', 'dev', 1800, 'CNY', 'created', NULL, 1)`,
      ).run(id);
    }
    expect(db.prepare('SELECT COUNT(*) AS n FROM orders').get()).toEqual({ n: 3 });
    db.close();
  });
});

describe('the NOT NULL columns the §4 rules rest on', () => {
  // Found by a 2026-09-04 mutation battery: relaxing `receipts.product` to a nullable
  // column survived all 211 tests, because no test ever tried to write a row without one.
  // The column constraint is rule 5's schema-level half — `BillingService` passes the
  // verified product today, and this is what stops a future code path from quietly
  // recording a receipt that resolved to nothing and then being replayable against any SKU.
  const insertReceipt = (db: ReturnType<typeof openBillingDb>, product: string | null) =>
    db
      .prepare(
        `INSERT INTO receipts (id, account_id, platform, product, raw, verified_at)
         VALUES ('dev:r1', 'a1', 'dev', ?, 'raw', 1)`,
      )
      .run(product);

  it('refuses a receipt with no product', () => {
    const db = openBillingDb(':memory:');
    expect(() => insertReceipt(db, null)).toThrow();
    db.close();
  });

  it('accepts one that has a product, so the constraint is the only thing rejected above', () => {
    // Without this half, the case above would also pass against a broken INSERT.
    const db = openBillingDb(':memory:');
    expect(() => insertReceipt(db, 'bp.cannon')).not.toThrow();
    db.close();
  });

  it('refuses a ledger row with no sku or no kind — the audit minimum', () => {
    // `source`/`kind` is what design/19 §2/§7 leans on to tell a paid grant from a
    // hand-issued one, and a ledger row that names neither the SKU nor the kind cannot be
    // reconciled or hand-corrected, which is the whole reason the table is append-only.
    const db = openBillingDb(':memory:');
    const insert = (sku: string | null, kind: string | null) =>
      db.prepare(`INSERT INTO ledger (id, account_id, sku, kind, ts) VALUES ('l1', 'a1', ?, ?, 1)`).run(sku, kind);
    expect(() => insert(null, 'purchase')).toThrow();
    expect(() => insert('bp.cannon', null)).toThrow();
    expect(() => insert('bp.cannon', 'purchase')).not.toThrow();
    db.close();
  });

  it('refuses an order with no state, amount or currency', () => {
    const db = openBillingDb(':memory:');
    const insert = (col: string) =>
      db
        .prepare(
          `INSERT INTO orders (id, account_id, sku, platform, amount_cents, currency, state, created_at)
           VALUES ('o1', 'a1', 'bp.cannon', 'dev',
                   ${col === 'amount_cents' ? 'NULL' : '1800'},
                   ${col === 'currency' ? 'NULL' : "'CNY'"},
                   ${col === 'state' ? 'NULL' : "'created'"}, 1)`,
        )
        .run();
    for (const col of ['amount_cents', 'currency', 'state']) expect(() => insert(col), col).toThrow();
    db.close();
  });
});

describe('defaultBillingDbPath', () => {
  it('honours BB_BILLING_DB_PATH', () => {
    vi.stubEnv('BB_BILLING_DB_PATH', 'C:/tmp/whatever/bill.db');
    expect(defaultBillingDbPath()).toBe('C:/tmp/whatever/bill.db');
  });

  it('ignores an empty BB_BILLING_DB_PATH rather than opening a file named ""', () => {
    vi.stubEnv('BB_BILLING_DB_PATH', '');
    expect(defaultBillingDbPath()).toContain('billing.db');
  });

  it('falls back to a billing.db under the package data dir', () => {
    vi.stubEnv('BB_BILLING_DB_PATH', '');
    const path = defaultBillingDbPath().split('\\').join('/');
    expect(path.endsWith('/data/billing.db')).toBe(true);
  });

  it('never collides with the account DB, on either the env path or the default', () => {
    // The variable names differ on purpose: one operator setting one variable must not be
    // able to point both planes at one file.
    vi.stubEnv('BB_BILLING_DB_PATH', '');
    vi.stubEnv('BB_DB_PATH', '');
    expect(defaultBillingDbPath()).not.toBe(defaultDbPath());

    vi.stubEnv('BB_DB_PATH', 'C:/tmp/accounts.db');
    expect(defaultBillingDbPath()).not.toBe(defaultDbPath());
  });
});
