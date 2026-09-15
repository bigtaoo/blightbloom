/**
 * Per-test-file isolation on the one shared mongod (`mongoGlobalSetup.ts`).
 *
 * ## No global state, on purpose
 *
 * This harness does NOT go through `src/mongo.ts`'s memoised client or its
 * `BB_MONGO_DB_PREFIX`. Both are process-global, and a vitest worker runs many test files
 * in one process: the second file to call `openTestMongo` would move the prefix out from
 * under the first, and the first to dispose would close the client the rest are using.
 * Neither failure is deterministic, which is the worst kind to own in a suite that gates
 * merges.
 *
 * So a context owns its own `MongoClient` and names its databases explicitly. Connecting
 * to a mongod on loopback costs single-digit milliseconds, which buys the property that
 * matters: nothing a test does here can be observed by, or broken by, another file.
 *
 * ## Injection, not globals, in the code under test too
 *
 * The stores take a `Db` the way they used to take a `DatabaseSync` — `new RatingStore(db)`,
 * `writeBatch(db, …)`, `setFlag(db, …)`. `src/mongo.ts`'s `store()` exists for the four
 * `main.ts` entry points and for nothing else, so tests never need it and never reach for
 * a process-wide handle to get a database.
 */
import { inject } from 'vitest';
import { MongoClient, type Db } from 'mongodb';
import type { StoreName } from '../src/mongo';
import { accountsStore, ensureAccountsIndexes, type AccountsStore } from '../src/db';

let counter = 0;

export interface MongoTestContext {
  /** One logical store's `Db`, isolated to this context. Inject it into the code under test. */
  db: (name: StoreName) => Db;
  /** Drops every database this context touched and closes its client. */
  dispose: () => Promise<void>;
}

/** Connects to the shared mongod under a name nobody else can compute. Pair with
 *  `await ctx.dispose()` in the matching teardown. */
export async function openTestMongo(): Promise<MongoTestContext> {
  const prefix = `t${process.pid}x${++counter}`;
  const client = await MongoClient.connect(inject('mongoUri'));
  const touched = new Set<string>();
  return {
    db: (name) => {
      const full = `${prefix}_${name}`;
      touched.add(full);
      return client.db(full);
    },
    dispose: async () => {
      for (const name of touched) await client.db(name).dropDatabase();
      await client.close();
    },
  };
}

/** An isolated control plane with its indexes and validators already installed. */
export interface AccountsTestContext {
  store: AccountsStore;
  db: Db;
  dispose: () => Promise<void>;
}

/**
 * The shortcut nearly every control-plane test wants: a throwaway `accounts` database with
 * `ensureAccountsIndexes` already run.
 *
 * Running it here rather than leaving it to each test is deliberate. The old suite got its
 * constraints for free — `openDb(':memory:')` executed the whole `CREATE TABLE` schema, so
 * a test could not accidentally run against a database with no UNIQUE on it. Indexes are a
 * separate call now, and a test that skipped it would pass while asserting nothing about
 * the constraint it names. Making it part of "open a store" restores the old property.
 */
export async function openTestAccounts(): Promise<AccountsTestContext> {
  const ctx = await openTestMongo();
  const db = ctx.db('accounts');
  await ensureAccountsIndexes(db);
  return { store: accountsStore(db), db, dispose: ctx.dispose };
}

/**
 * One client per worker process, shared by `freshAccounts()` and closed by `mongoSetup.ts`
 * after each test file. Lazily created, so a file that never touches the cluster never
 * connects to it.
 */
let sharedClient: MongoClient | undefined;

/**
 * A fresh, isolated control plane with NO teardown for the caller to remember.
 *
 * The HTTP suites build a matchsvc server in `beforeAll` and only ever needed a scratch
 * database to hand it; making each of them own a context, thread it through, and dispose it
 * would be a dozen copies of the same bookkeeping and a dozen chances to forget the
 * `afterAll`. Two properties make the bookkeeping unnecessary here:
 *
 *  - the database name carries a counter nobody else can compute, so nothing leaks BETWEEN
 *    tests even though nothing is dropped;
 *  - `mongoGlobalSetup.ts` destroys the entire mongod when the run ends, so nothing leaks
 *    AFTER it either.
 *
 * What still has to be closed is the SOCKET, because an open client keeps the worker alive
 * and vitest would hang rather than fail — `mongoSetup.ts` does that in a file-scoped
 * `afterAll`. Tests that want to assert on a dropped database, or to see the `Db` itself,
 * use `openTestAccounts` instead.
 */
export async function freshAccounts(): Promise<AccountsStore> {
  sharedClient ??= await MongoClient.connect(inject('mongoUri'));
  const db = sharedClient.db(`f${process.pid}x${++counter}_accounts`);
  await ensureAccountsIndexes(db);
  return accountsStore(db);
}

/** Closes the shared client. Called by `mongoSetup.ts`, not by tests. */
export async function closeSharedTestClient(): Promise<void> {
  const c = sharedClient;
  sharedClient = undefined;
  if (c) await c.close();
}
