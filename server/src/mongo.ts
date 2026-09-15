/**
 * The cluster connection (design/16-accounts.md, design/19-server-platform.md §4).
 *
 * Replaces the four `node:sqlite` file handles this project opened until 2026-09-15 with
 * one pooled `MongoClient` against a MongoDB Atlas replica set. The FOUR-STORE SEPARATION
 * survives the move and is not decorative: `accounts`, `billing`, `analytics` and `ops`
 * are four logical DATABASES on the cluster, exactly where they were four files before,
 * because design/19 §4's "money gets its own process and its own database" is a locked
 * decision and a shared handle is how a later refactor quietly re-merges them.
 *
 * ## What the move gives up, stated plainly
 *
 * Two enforcement mechanisms this server relied on do not exist here and are NOT replaced
 * by anything in this repo:
 *
 *  - **Foreign keys.** `entitlements.account_id REFERENCES accounts(id)` made a row for a
 *    typo'd account id fail loudly at the prompt instead of becoming an orphan that
 *    silently never delivers. MongoDB has no such constraint. Every FK the old schema
 *    declared is now an application-level check at its one write path, which is strictly
 *    weaker: it binds this code, not the database, so a hand-issued document bypasses it.
 *  - **The read-only capability.** adminsvc held its three player-data handles as
 *    `readOnly: true` (SQLite-enforced) behind `:ro` bind mounts (Docker-enforced), so
 *    decision B1 — "the console cannot write player data" — was a capability the process
 *    did not hold. Here it is an Atlas ROLE on a separate database user, which lives in
 *    the cluster's configuration rather than in this repository. It is still true; it is
 *    no longer true in a way a code review can confirm. `adminsvc/dbs.ts` therefore
 *    asserts it at startup by attempting a write and requiring the refusal.
 *
 * ## One client, connected at boot
 *
 * `connectMongo()` is memoised per process and every `main.ts` awaits it before it binds a
 * port. Lazy connect-on-first-operation would move a bad URI or a firewalled cluster from
 * a boot failure to a failure on some player's first request, which is the same posture
 * `billsvc/startupGuard.ts` already refuses for its own configuration.
 */
import { MongoClient, type Db } from 'mongodb';

/** The four logical databases. Named, not free strings, so a typo cannot silently create
 *  a fifth one — MongoDB creates a database on first write and would never complain. */
export const STORES = ['accounts', 'billing', 'analytics', 'ops'] as const;
export type StoreName = (typeof STORES)[number];

let client: MongoClient | null = null;
let connecting: Promise<MongoClient> | null = null;

/**
 * `BB_MONGO_URI`, or a thrown error naming the variable.
 *
 * No default and no fallback to a localhost cluster, deliberately. Every other connection
 * string in this project has a sensible local default; this one must not, because the
 * failure mode of a wrong default here is a service that comes up healthy against an EMPTY
 * database and starts writing accounts into it. A missing variable has to be loud.
 */
export function mongoUri(): string {
  const raw = process.env.BB_MONGO_URI?.trim();
  if (!raw) throw new Error('BB_MONGO_URI is not set — no cluster to connect to (see design/16-accounts.md)');
  return raw;
}

/**
 * The database name for one logical store, with `BB_MONGO_DB_PREFIX` applied.
 *
 * The prefix exists so that one Atlas cluster can host more than one environment — the
 * free tier allows a handful of databases and a second cluster for staging is a second
 * bill. `BB_MONGO_DB_PREFIX=staging` makes the four databases `staging_accounts` … and
 * an unset prefix leaves them bare, which is what production uses.
 *
 * It is also how the test harness isolates: each test file runs under its own prefix, so
 * two files sharing one mongod cannot see each other's documents.
 */
export function dbName(store: StoreName): string {
  const prefix = process.env.BB_MONGO_DB_PREFIX?.trim();
  return prefix ? `${prefix}_${store}` : store;
}

/**
 * Connect (once per process) and hand back the pooled client.
 *
 * Concurrent callers share one in-flight connection rather than opening several: every
 * `main.ts` awaits this, and so does the first thing each service does afterwards.
 */
export function connectMongo(uri: string = mongoUri()): Promise<MongoClient> {
  if (client) return Promise.resolve(client);
  if (connecting) return connecting;
  connecting = MongoClient.connect(uri)
    .then((c) => {
      client = c;
      connecting = null;
      return c;
    })
    .catch((e: unknown) => {
      connecting = null;
      throw e;
    });
  return connecting;
}

/** The connected client, or a thrown error. For call sites that run after boot and should
 *  not each carry an `await connectMongo()` — reaching this before boot is a wiring bug,
 *  not a state to handle. */
export function requireClient(): MongoClient {
  if (!client) throw new Error('connectMongo() has not completed — a store was reached before boot');
  return client;
}

/** One logical store's `Db` handle. */
export function store(name: StoreName): Db {
  return requireClient().db(dbName(name));
}

/** Closes the pooled client. Process shutdown, and every test's teardown. */
export async function closeMongo(): Promise<void> {
  const c = client;
  client = null;
  connecting = null;
  if (c) await c.close();
}
