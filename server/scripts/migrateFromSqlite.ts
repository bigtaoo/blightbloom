/**
 * The one-time migration of live player data off the four `node:sqlite` files and onto the
 * cluster (stage 7 of the 2026-09-15 port).
 *
 *   BB_MONGO_URI=... npx tsx scripts/migrateFromSqlite.ts --dir=/srv/blightbloom/data --dry-run
 *   BB_MONGO_URI=... npx tsx scripts/migrateFromSqlite.ts --dir=/srv/blightbloom/data
 *
 * Run it ON the box that holds the files, against the cluster that is about to serve them,
 * with every service STOPPED. The order matters and is not a suggestion: this reads a
 * snapshot, and anything written to the files after it reads them stays behind.
 *
 * ## This file is the last place SQLite appears in this repository
 *
 * All the logic is in `src/migrate/`, which is pure over an injected reader and is tested;
 * this is the SQLite reader, argument parsing, and printing. The split is the same one
 * `grantAudit.ts` and `reconcile.ts` use, and it is load-bearing here for one extra reason:
 * `src/migrate/run.ts` takes a `LegacySource` interface rather than a database, so the suite
 * exercises the whole migration — every mapping, the refusal, the counts — without a SQLite
 * dependency reaching it, and without the builtin re-entering any bundle.
 *
 * **Delete this file and `src/migrate/` once the data has moved and been verified.** Their
 * expiry is the point; see `src/migrate/tables.ts`.
 *
 * ## The four files, and the three arguments
 *
 *   --dir=<path>   where the `.db` files live. Defaults to `./data`, and each file is looked
 *                  for at the path compose gave its owning service:
 *                  `<dir>/matchsvc/accounts.db`, `<dir>/matchsvc/analytics.db`,
 *                  `<dir>/billsvc/billing.db`, `<dir>/adminsvc/ops.db`.
 *   --dry-run      read, map and count; write nothing. Run this FIRST.
 *   --force        write even though the target already holds documents this migration did
 *                  not write. That state means the cutover has happened, and forcing past it
 *                  overwrites every player's progress since with what the file still says.
 *
 * A file that is not there is not an error: an older box may never have had analytics or a
 * flag store. It is reported as zero rows, beside the tables that had some.
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { MongoClient } from 'mongodb';
import { dbName, mongoUri, STORES, type StoreName } from '../src/mongo';
import { ensureAccountsIndexes } from '../src/db';
import { ensureBillingIndexes } from '../src/billingDb';
import { ensureAnalyticsIndexes } from '../src/analytics/db';
import { ensureOpsIndexes } from '../src/flags/store';
import { formatResult, migrateAll, migrationComplete, MigrationRefused, type LegacySource } from '../src/migrate/run';

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .filter((a) => a.startsWith('--'))
    .map((a) => {
      const [k, v] = a.slice(2).split('=');
      return [k, v ?? 'true'];
    }),
);

const dir = args.dir ?? './data';
const dryRun = args['dry-run'] === 'true';
const force = args.force === 'true';

/** Where compose put each file, per owning service. */
const FILES: Record<StoreName, string> = {
  accounts: join(dir, 'matchsvc', 'accounts.db'),
  analytics: join(dir, 'matchsvc', 'analytics.db'),
  billing: join(dir, 'billsvc', 'billing.db'),
  ops: join(dir, 'adminsvc', 'ops.db'),
};

/**
 * The four handles, opened READ-ONLY.
 *
 * `readOnly: true` is not ceremony here: it is what makes this script unable to damage the
 * only copy of the data it is carrying across, and — unlike everywhere else this flag used
 * to appear — it is still enforced by SQLite, because this side of the migration never moved.
 * It also refuses a MISSING file by throwing rather than creating an empty one, which is why
 * `existsSync` decides absence instead of a `catch`.
 */
const open: Partial<Record<StoreName, DatabaseSync>> = {};
for (const store of STORES) {
  if (existsSync(FILES[store])) open[store] = new DatabaseSync(FILES[store], { readOnly: true });
  else console.log(`  (no ${FILES[store]} — that store's tables will report zero)`);
}

const source: LegacySource = {
  rows: (table, orderBy) => {
    for (const store of STORES) {
      const db = open[store];
      if (db === undefined) continue;
      const exists = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(table);
      if (exists === undefined) continue;
      return db.prepare(`SELECT * FROM ${table} ORDER BY ${orderBy}`).all() as Record<string, unknown>[];
    }
    return null;
  },
};

console.log(`migrating ${dir} -> ${mongoUri().replace(/\/\/[^@]*@/, '//***@')}${dryRun ? ' (DRY RUN)' : ''}`);
const client = await MongoClient.connect(mongoUri());
try {
  if (!dryRun) {
    // The indexes and validators first, for the reason every `main.ts` runs them at boot:
    // they are what makes a freshly created Atlas database correct, and migrating into a
    // collection with no unique index on it would load data that the index cannot then be
    // built over. A duplicate that SQLite's own constraint would have refused becomes a
    // `createIndex` failure at the next service start, on a box with no data left to fix it
    // from — so the constraint goes on before the rows, not after.
    await ensureAccountsIndexes(client.db(dbName('accounts')));
    await ensureBillingIndexes(client.db(dbName('billing')));
    await ensureAnalyticsIndexes(client.db(dbName('analytics')));
    await ensureOpsIndexes(client.db(dbName('ops')));
  }

  const result = await migrateAll(source, { db: (store) => client.db(dbName(store)) }, { dryRun, force });
  console.log(formatResult(result));

  if (dryRun) {
    console.log('\ndry run: nothing was written. Re-run without --dry-run to migrate.');
  } else if (migrationComplete(result)) {
    const moved = result.tables.reduce((n, t) => n + t.read, 0);
    console.log(`\nOK — ${moved} row(s) read, every table's collection holds at least as many.`);
    console.log('Keep the .db files until the services have run against the cluster for a day.');
  } else {
    // Non-zero, loudly: a migration that moved less than it read is the one outcome that
    // must not be discovered later, and the short tables are named because the operator's
    // next move is to look at exactly those.
    const short = result.tables.filter((t) => t.present < t.read).map((t) => t.table);
    console.error(`\nINCOMPLETE — fewer documents than rows in: ${short.join(', ')}`);
    process.exitCode = 1;
  }
} catch (e) {
  if (e instanceof MigrationRefused) {
    console.error(`\nrefused: ${e.message}`);
    process.exitCode = 2;
  } else {
    throw e;
  }
} finally {
  for (const db of Object.values(open)) db.close();
  await client.close();
}
