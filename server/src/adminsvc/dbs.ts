/**
 * The three read-only database handles the console reads through (design/21 decision B1).
 *
 * This file is where B1 stops being a policy and becomes a capability the process does not
 * hold: every handle is opened with `readOnly: true`, which SQLite itself enforces, so
 * `adminsvc` cannot write player data even if a route in it were wrong. That is the sentence
 * the whole phase is built to be able to say — *it is not that the console does not write,
 * it is that it cannot* — and `adminsvc.dbs.test.ts` asserts it by attempting a write
 * through each handle and requiring a throw, rather than by asserting that the option was
 * passed.
 *
 * ## Every handle is nullable, and none of the three nulls is defensive
 *
 * `node:sqlite` in `readOnly` mode does NOT create a missing file — it throws — and all
 * three files are created by OTHER processes. So "the file is not there yet" is a normal
 * state with three normal causes:
 *
 *   - `analytics.db` does not exist until `BB_ANALYTICS_DB_PATH` is set on matchsvc and a
 *     first event lands. Collection is opt-in (design/21 §2.4) and a deployment that has
 *     not switched it on is a supported deployment.
 *   - `billing.db` does not exist until billsvc has booted once.
 *   - `accounts.db` does not exist on a box where nobody has ever registered.
 *
 * A console that refuses to start because one of them is absent would be a console that
 * cannot be used to find out WHY it is absent. So each section reports its own absence and
 * the other two still answer — which is also why `openAdminDbs` never throws, and why the
 * page has an "unavailable" state per section rather than one global error.
 *
 * ## Read-only, not "read-only for now"
 *
 * There is no writable handle anywhere in `adminsvc/`, and there is no opener here that
 * could produce one: this module's only export takes paths and returns read-only handles.
 * Adding a write would mean adding an opener, which is a diff a reviewer sees.
 */
import { DatabaseSync } from 'node:sqlite';
import { defaultDbPath } from '../db';
import { defaultBillingDbPath } from '../billingDb';
import type { Logger } from '../log';

/** Which of the three a null belongs to, for the log line and for the page's per-section
 *  "unavailable" state. */
export type AdminDbName = 'accounts' | 'billing' | 'analytics';

export interface AdminDbs {
  accounts: DatabaseSync | null;
  billing: DatabaseSync | null;
  analytics: DatabaseSync | null;
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
  close(): void;
}

export interface AdminDbPaths {
  accounts?: string;
  billing?: string;
  /** No default: analytics collection is opt-in and has no fallback path anywhere in this
   *  project (see `matchsvc.ts`'s `analyticsDbPathFromEnv`), so `null` here means "this
   *  deployment collects nothing" and is reported as exactly that. */
  analytics?: string | null;
}

/**
 * Opens one handle read-only, or returns the reason it could not.
 *
 * The `catch` is over `new DatabaseSync` rather than around the whole bundle so that one
 * missing file cannot take the other two with it — see the header. `readOnly: true` is what
 * makes the returned handle safe; it is also what makes a missing file an error instead of
 * a silently created empty database, which is the more useful failure of the two.
 */
export function openReadOnly(path: string): { db: DatabaseSync } | { error: string } {
  try {
    return { db: new DatabaseSync(path, { readOnly: true }) };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

/**
 * Opens all three. Never throws: a console that cannot start is a console that cannot be
 * used to diagnose the reason it cannot start.
 *
 * `log` is optional so a test can build the bundle without a logger; when present, each
 * absent database gets one WARN line, because "the commerce tab says unavailable" and "the
 * file is not where the env var points" are the same fact and only one of them is
 * searchable.
 */
export function openAdminDbs(paths: AdminDbPaths = {}, log?: Logger): AdminDbs {
  const accountsPath = paths.accounts ?? defaultDbPath();
  const billingPath = paths.billing ?? defaultBillingDbPath();
  const analyticsPath = paths.analytics === undefined ? analyticsPathFromEnv() : paths.analytics;

  const errors: Record<AdminDbName, string> = { accounts: '', billing: '', analytics: '' };
  const opened: Partial<Record<AdminDbName, DatabaseSync>> = {};

  const attempt = (name: AdminDbName, path: string | null): void => {
    if (path === null) {
      errors[name] = 'not configured (BB_ANALYTICS_DB_PATH is unset — this deployment collects nothing)';
      return;
    }
    const result = openReadOnly(path);
    if ('error' in result) {
      errors[name] = result.error;
      log?.warn('database unavailable', { db: name, path, err: result.error });
      return;
    }
    opened[name] = result.db;
  };

  attempt('accounts', accountsPath);
  attempt('billing', billingPath);
  attempt('analytics', analyticsPath);

  return {
    accounts: opened.accounts ?? null,
    billing: opened.billing ?? null,
    analytics: opened.analytics ?? null,
    errors,
    close(): void {
      for (const db of Object.values(opened)) db.close();
    },
  };
}

/**
 * `BB_ANALYTICS_DB_PATH`, or `null` when unset or empty — the same reader, and the same
 * empty-string-is-unset rule, that `matchsvc.ts` applies to the same variable. Duplicated
 * as a two-line function rather than imported, deliberately: importing `matchsvc.ts` would
 * pull the whole control plane — `ws`, the matchmaker, every route group — into this
 * process's bundle for one string lookup.
 */
export function analyticsPathFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.BB_ANALYTICS_DB_PATH?.trim();
  return raw !== undefined && raw.length > 0 ? raw : null;
}
