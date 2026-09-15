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
 * Why a value that is merely PRESENT is not good enough (2026-09-15).
 *
 * Every gate this deployment has between an operator and the cluster is a presence check:
 * `docker-compose.yml`'s `${BB_MONGO_URI:?}`, `ci-deploy.sh`'s `grep -q "^$var=..*"`, and
 * the `if (!raw)` below. A `.env` line holding the literal placeholder out of a runbook —
 * `BB_MONGO_URI=mongodb+srv://…` — passes all three, and so does `new MongoClient()`: the
 * driver's URI parser accepts `…` as a hostname. The first thing that objects is the SRV
 * lookup inside `connectMongo`, which surfaces as a DNS error in five containers during a
 * cutover window, naming neither the variable nor the cause. That is how this function got
 * a shape check, and it happened rather than being imagined.
 *
 * Two rules, both narrow on purpose — this rejects a placeholder, not a cluster somebody
 * configured differently from the way this project happens to:
 *
 *  - **ASCII only.** A connection string is ASCII by construction; a password that is not
 *    has to be percent-encoded before it is legal. So a non-ASCII byte is never a valid
 *    URI, and it is the signature of exactly the failures that get this far: a pasted `…`,
 *    a smart quote out of a document, a full-width character from an IME.
 *  - **A scheme this driver speaks**, and for `mongodb+srv` a host of at least three
 *    labels. The second half restates the driver's own SRV rule ("hostname, domain name,
 *    and tld") deliberately: the same refusal, moved from a connect-time DNS error to a
 *    config-time message that names the variable.
 *
 * What is NOT checked: credentials, reachability, or that the cluster is the right one. A
 * well-formed URI for the wrong cluster is a real failure mode and this cannot see it —
 * `server/deploy/README.md` §5 catches it with the Players tab instead.
 */
export function mongoUriProblem(uri: string): string | null {
  // eslint-disable-next-line no-control-regex -- the point is to name every non-ASCII byte
  if (/[^\x00-\x7F]/.test(uri)) {
    return 'contains a non-ASCII character, so it is not a connection string (a pasted placeholder or a smart quote — a real password is percent-encoded)';
  }
  const srv = uri.startsWith('mongodb+srv://');
  if (!srv && !uri.startsWith('mongodb://')) {
    return 'does not begin with mongodb:// or mongodb+srv://';
  }
  if (srv) {
    const host = uri.slice('mongodb+srv://'.length).split('@').pop()?.split(/[/?]/)[0] ?? '';
    if (host.split('.').filter(Boolean).length < 3) {
      return `mongodb+srv:// needs a host with a hostname, domain and tld (got ${JSON.stringify(host)})`;
    }
  }
  return null;
}

/**
 * `BB_MONGO_URI`, or a thrown error naming the variable.
 *
 * No default and no fallback to a localhost cluster, deliberately. Every other connection
 * string in this project has a sensible local default; this one must not, because the
 * failure mode of a wrong default here is a service that comes up healthy against an EMPTY
 * database and starts writing accounts into it. A missing variable has to be loud.
 *
 * adminsvc reads its own user through this same function — `docker-compose.yml` passes
 * `BB_ADMIN_MONGO_URI` INTO the container as `BB_MONGO_URI` — so one guard covers both
 * strings the cutover asks an operator for.
 */
export function mongoUri(): string {
  const raw = process.env.BB_MONGO_URI?.trim();
  if (!raw) throw new Error('BB_MONGO_URI is not set — no cluster to connect to (see design/16-accounts.md)');
  const problem = mongoUriProblem(raw);
  if (problem) throw new Error(`BB_MONGO_URI ${problem} (see server/deploy/README.md section 5)`);
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
