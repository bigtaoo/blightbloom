/**
 * The three player-data handles the console reads through (design/21 decision B1), and the
 * startup probe that is now the only thing standing behind B1's sentence.
 *
 * ## What B1 used to be, and what it is now
 *
 * Until 2026-09-15 this file was where B1 stopped being a policy and became a capability
 * the process did not hold: every handle was `new DatabaseSync(path, { readOnly: true })`,
 * which SQLite itself enforced, behind `:ro` bind mounts, which Docker enforced. The
 * console could not write player data even if a route in it were wrong, and
 * `adminsvc.dbs.test.ts` asserted it by attempting a write through each handle and
 * requiring a throw.
 *
 * Both mechanisms are gone. One pooled `MongoClient` cannot hold half a handle, and there
 * are no files to mount read-only. What replaces them is an Atlas ROLE on this service's
 * own database user (`read` on the three player-data databases, nothing else) — which is
 * still an enforcement the process does not hold, but it lives in the cluster's
 * configuration rather than in this repository, where no code review can see it.
 *
 * So this module asserts it instead: {@link probeWriteAccess} attempts a real write to a
 * scratch collection on each database at boot and REQUIRES the server to refuse. A console
 * whose credential turns out to be writable refuses to start (`server.ts`), rather than
 * running for six months with B1 quietly false. That is a weaker guarantee than the file
 * mode was — it is a check at one instant rather than a capability — and the difference is
 * why it is stated here at length instead of in a line of prose.
 *
 * ## Every handle is still nullable, but for one reason instead of three
 *
 * The three nulls used to be three normal states of a filesystem: `accounts.db` absent on a
 * box where nobody had registered, `billing.db` absent until billsvc had booted once,
 * `analytics.db` absent unless collection was switched on. Two of those cannot happen on a
 * cluster — a database that has never been written simply answers every query with nothing,
 * which is the correct answer and not an error.
 *
 * What remains:
 *
 *   - **the connection failed.** All three go null together with the same reason, because
 *     there is one connection. A console that refused to start here would be a console that
 *     cannot be used to find out WHY it cannot reach the cluster, so `openAdminDbs` still
 *     never throws and the page still has a per-section "unavailable" state.
 *   - **analytics is switched off.** Collection is opt-in (design/21 §2.4,
 *     `matchsvc.ts`'s `analyticsEnabledFromEnv`), and a deployment that has not switched it
 *     on is a supported deployment whose retention tab should say exactly that rather than
 *     show an empty grid that reads as "nobody came back".
 */
import type { Db } from 'mongodb';
import { connectMongo, store } from '../mongo';
import type { Logger } from '../log';

/** Which of the three a null belongs to, for the log line and for the page's per-section
 *  "unavailable" state. */
export type AdminDbName = 'accounts' | 'billing' | 'analytics';

export interface AdminDbs {
  accounts: Db | null;
  billing: Db | null;
  analytics: Db | null;
  /**
   * Why a null is null, per name — the string an operator needs, and the reason this is not
   * just three nullable fields.
   *
   * TOTAL rather than partial, with `''` for a handle that opened. A `Partial` record reads
   * more precisely and costs a `?? ''` at every call site, which is a branch that cannot be
   * taken (a null handle always records a reason) and therefore an untestable one. One
   * empty string is cheaper than three dead fallbacks.
   */
  errors: Record<AdminDbName, string>;
}

export interface AdminDbOptions {
  /**
   * Whether this deployment collects analytics — `matchsvc.ts`'s `analyticsEnabledFromEnv`
   * answer, passed in rather than re-read, so the console and the collector cannot disagree
   * about a deployment's state because one of them read a different variable.
   */
  analyticsEnabled?: boolean;
  /** Injected by tests: the three databases to read, instead of `mongo.ts`'s process-wide
   *  `store()`. Nothing in production passes this — see `test/mongoHarness.ts` on why the
   *  suite never reaches for a process-global handle. */
  open?: (name: AdminDbName) => Db;
}

/**
 * The scratch collection {@link probeWriteAccess} writes to.
 *
 * Underscore-prefixed and named for what it is, because on a cluster whose credential is
 * NOT correctly scoped this collection will actually be created, and an operator reading
 * the database list deserves to find out why from its name.
 */
export const WRITE_PROBE_COLLECTION = '_adminWriteProbe';

/**
 * The one document the probe writes, under a FIXED id.
 *
 * Fixed rather than generated, and upserted rather than inserted-then-deleted, which is what
 * keeps this function free of a cleanup step. The first version inserted a document and
 * removed it again, and the removal needed a `catch` that swallowed its own failure — because
 * a delete that threw would have escaped into the outer catch and reported a credential that
 * had just been proven WRITABLE as read-only, the one wrong answer this function must never
 * give. That catch was also a branch nothing could reach: a server that accepts the insert
 * accepts the delete.
 *
 * An idempotent upsert removes the step and the branch together, and leaves something more
 * useful behind than nothing: a correctly-scoped cluster never has this document at all, and
 * one that does carries the timestamp of the last boot at which decision B1 was observed to
 * be false.
 */
export const WRITE_PROBE_ID = 'lastAcceptedWrite';

/** What one database's write probe found. `refused` is the state B1 requires. */
export type WriteProbe = { refused: true; reason: string } | { refused: false };

/**
 * Attempts one real write and reports whether the server refused it.
 *
 * A real write, not a permissions lookup: `db.command({ connectionStatus: 1 })` would report
 * the roles the credential CLAIMS, which is a different question from what this connection
 * is allowed to do — a question whose answer can be right while the thing it predicts is
 * wrong. The probe asks the server to perform the operation B1 forbids, and B1 holds only if
 * it says no.
 *
 * An upsert under {@link WRITE_PROBE_ID} rather than an insert, so running it a thousand
 * times leaves one document rather than a thousand. See there for what that replaced.
 */
export async function probeWriteAccess(db: Db, nowMs: number = Date.now()): Promise<WriteProbe> {
  try {
    await db
      .collection(WRITE_PROBE_COLLECTION)
      .updateOne({ _id: WRITE_PROBE_ID as never }, { $set: { at: nowMs } }, { upsert: true });
    return { refused: false };
  } catch (e) {
    return { refused: true, reason: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Opens all three. Never throws: a console that cannot start is a console that cannot be
 * used to diagnose the reason it cannot start.
 *
 * `log` is optional so a test can build the bundle without a logger; when present, each
 * absent database gets one WARN line, because "the commerce tab says unavailable" and "the
 * cluster is unreachable" are the same fact and only one of them is searchable.
 */
export async function openAdminDbs(opts: AdminDbOptions = {}, log?: Logger): Promise<AdminDbs> {
  const errors: Record<AdminDbName, string> = { accounts: '', billing: '', analytics: '' };
  const analyticsEnabled = opts.analyticsEnabled ?? false;

  let open = opts.open;
  if (open === undefined) {
    try {
      await connectMongo();
      open = (name) => store(name);
    } catch (e) {
      // One connection, so one reason, recorded against all three. The message is the
      // driver's own — a bad URI, a firewalled cluster and a wrong password produce three
      // different ones, and which of them it is is the whole content of this page state.
      const reason = e instanceof Error ? e.message : String(e);
      for (const name of ['accounts', 'billing', 'analytics'] as const) errors[name] = reason;
      log?.warn('cluster unavailable', { err: reason });
      return { accounts: null, billing: null, analytics: null, errors };
    }
  }

  if (!analyticsEnabled) {
    errors.analytics = 'not configured (BB_ANALYTICS_ENABLED is unset — this deployment collects nothing)';
  }

  return {
    accounts: open('accounts'),
    billing: open('billing'),
    analytics: analyticsEnabled ? open('analytics') : null,
    errors,
  };
}

/** The databases actually opened, for the caller that has to probe each of them. */
export function openedDbs(dbs: AdminDbs): { name: AdminDbName; db: Db }[] {
  const out: { name: AdminDbName; db: Db }[] = [];
  for (const name of ['accounts', 'billing', 'analytics'] as const) {
    const db = dbs[name];
    if (db !== null) out.push({ name, db });
  }
  return out;
}
