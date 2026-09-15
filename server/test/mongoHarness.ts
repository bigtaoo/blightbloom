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
