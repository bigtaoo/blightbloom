/**
 * The RETIRED billing SQLite file (`src/billing/sqliteLegacy.ts`).
 *
 * billsvc does not open this any more — it reads the MongoDB collections
 * `billingDb.test.ts` covers. What still opens it is the ops console (`adminsvc/dbs.ts`), the
 * backup runner's source list and `scripts/seedOpsDemo.ts`, none of which have had their own
 * stage of the migration yet. So the opener is live code with live callers, and these cases
 * are the ones from the pre-port `billingDb.test.ts` that are still about IT rather than about
 * the plane's schema: that the file has the six tables the console reads, that reopening one
 * does not wipe it, and that the two planes cannot be pointed at one path by one variable.
 *
 * DELETE THIS FILE with the opener, when its last caller moves.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openBillingDb, defaultBillingDbPath } from '../src/billingDb';
import { openLegacyAccountsDb } from './legacyAccountsDb';

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
  it('still creates the six tables the ops console reads', () => {
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

  it('carries NONE of the account DB\'s tables, and the account DB none of these', () => {
    // The physical isolation, asserted from both sides. A shared opener would show up here as
    // `accounts`/`sessions` appearing in the billing file.
    const billing = openBillingDb(':memory:');
    const billingNames = tableNames(billing);
    for (const accountTable of ['accounts', 'sessions', 'ratings', 'meta_state']) {
      expect(billingNames).not.toContain(accountTable);
    }
    billing.close();

    const accounts = openLegacyAccountsDb(':memory:');
    const accountNames = tableNames(accounts);
    for (const billingTable of ['orders', 'receipts', 'ledger', 'deliveries']) {
      expect(accountNames).not.toContain(billingTable);
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

  it('is its own explicit variable, not a sibling of whatever BB_DB_PATH points at', () => {
    // Was `expect(defaultBillingDbPath()).not.toBe(defaultDbPath())`, from both sides: the
    // variable names differ on purpose, so one operator setting one variable could not point
    // both planes at one file. There is no `defaultDbPath()` to compare against any more — the
    // control plane is on the cluster — so what survives is the half that is still checkable,
    // that this default is derived from BB_BILLING_DB_PATH alone and BB_DB_PATH cannot move it.
    vi.stubEnv('BB_BILLING_DB_PATH', '');
    vi.stubEnv('BB_DB_PATH', 'C:/tmp/accounts.db');
    const path = defaultBillingDbPath().split('\\').join('/');
    expect(path.endsWith('/data/billing.db')).toBe(true);
  });
});
