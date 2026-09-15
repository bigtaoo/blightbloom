/**
 * adminsvc's assembly shell (design/21 §3, decisions B1–B3): builds the dependency bundle,
 * proves B1 before it serves anything, owns the dispatch chain, and logs every request.
 *
 * Same shape as `matchsvc.ts` and `billsvc/server.ts` — a `createXServer` that binds no
 * port, so a test can drive the whole console over a real socket without a process. `main.ts`
 * is the only thing that calls `listen`.
 *
 * ## The dispatch chain is an allowlist, not a router
 *
 * Five exact paths, then 404. There is no prefix match, no path parameter and no static
 * file server, which is the point: matchsvc's `/metrics` had to explicitly refuse proxied
 * requests because a route added to a wholesale-proxied server is public the moment it
 * exists (design/21 §3.1). Inverting that default was the reason for a fifth process, and
 * an allowlist is what keeps the inversion true — a future route here is public only if
 * somebody adds a line to this chain.
 *
 * ## Every handler is async now, so every handler needs a boundary
 *
 * The chain used to run handlers that could only throw for a programming reason: the reads
 * behind them were synchronous statements against a local file. They are network round
 * trips now, so a failover, a pool timeout or a dropped connection arrives as a REJECTED
 * PROMISE on an ordinary request — and Node answers an unhandled rejection by killing the
 * process. The boundary below turns that into one 500 with the reason logged, and destroys
 * the connection instead when headers are already on the wire. It is the same boundary
 * `matchsvc.ts` grew for the same reason on the same day, and for a console it matters in a
 * sharper way: the process that dies is the one an operator opened BECAUSE something was
 * already wrong.
 *
 * ## Why the log line wraps the response and not just the request
 *
 * §3.3 asks for "every request logged — with the operator and the path". A line written
 * before the handler runs cannot say what happened, and a rejected login and an accepted
 * one are the two entries that matter most. So the status is captured off `res` on `finish`,
 * which is the one hook that fires for every path out of a handler including the ones that
 * end inside a body read.
 */
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { Db } from 'mongodb';
import { createLogger, type Logger } from '../log';
import { RateLimiter } from '../rateLimit';
import { requestTarget, sendJson } from './http';
import { ensureOpsIndexes } from '../flags/store';
import { analyticsEnabledFromEnv } from '../analytics/db';
import { store } from '../mongo';
import { createInternalVerifier, type InternalVerifier } from '../internalAuth';
import { internalKeys } from '../config';
import * as flagRoutes from './flagRoutes';
import type { FlagRouteDeps } from './flagRoutes';
import { openAdminDbs, openedDbs, probeWriteAccess, type AdminDbOptions, type AdminDbs } from './dbs';
import { AdminSessionStore } from './session';
import {
  ADMIN_SESSION_TTL_MS,
  AdminStartupError,
  assertAdminStartupSafety,
  adminCookieSecure,
  type AdminEnv,
} from './credentials';
import * as routes from './routes';
import { LOGIN_RATE_LIMIT } from './routes';

export interface AdminsvcServerOptions {
  /**
   * How the three READ-ONLY databases are obtained. Defaults to the process-wide client from
   * `mongo.ts`; a test injects `open` instead.
   *
   * `analyticsEnabled` defaults to `analytics/db.ts`'s reader rather than to `false`, so the
   * console and the collector answer the same question from the same variable. A console
   * that decided this for itself would show an empty retention tab on a deployment that is
   * collecting, or a "not configured" card on one that is — and both read as a bug in the
   * data rather than a disagreement between two processes.
   */
  dbs?: AdminDbOptions;
  /**
   * Whether this deployment has a flag store (design/21 §4), or `undefined` to read
   * `BB_OPS_FLAGS_ENABLED` from `env`.
   *
   * The opt-in shape analytics has on matchsvc, for the same reason: a flag store that
   * appeared by default would be a writable database nobody decided to create, in the one
   * process whose whole argument is what it cannot write. When there is none, the flags tab
   * says so and `/internal/flags` answers 503, which every polling service reads as "keep
   * the compiled-in defaults".
   */
  opsFlags?: boolean;
  /**
   * The `ops` database itself, injected by tests. Ignored unless `opsFlags` is on.
   *
   * NOT nullable, deliberately. A `Db | null` here would make "the switch is on and the
   * handle is null" representable, which production cannot produce — `store('ops')` always
   * resolves — so the guard it needed would be a branch only a test could reach, and a
   * branch only a test can reach is one a coverage gate cannot tell apart from an untested
   * one. "This deployment has no flag store" is `opsFlags: false`, which is one state with
   * one spelling.
   */
  opsDb?: Db;
  /** Read once; `main` passes `process.env`. A test passes a literal so it never mutates
   *  the ambient environment — the same `StartupEnv` shape billsvc uses. */
  env?: AdminEnv;
  log?: Logger;
  now?: () => number;
  /** Session lifetime override, so a test can expire one without waiting eight hours. */
  sessionTtlMs?: number;
  /** Internal-key verifier override for `GET /internal/flags`. Defaults to one built from
   *  `config.ts`'s registry — see where it is constructed below. */
  verifier?: InternalVerifier;
}

export interface AdminsvcServer {
  server: Server;
  /**
   * The three player-data handles, held for the health route and for a test that wants to
   * read what the console can see.
   *
   * No `close()` on it any more, and that absence is the migration in one line: these were
   * three SQLite connections this process owned and had to release (on Windows an unclosed
   * one keeps a lock on the file, which is how the suite used to find a leak). They are now
   * three `Db` views onto ONE pooled client owned by `mongo.ts` for the life of the
   * process, and closing it belongs to whoever opened it — `closeMongo()`, not a socket's
   * close event.
   */
  dbs: AdminDbs;
  /** The flag store, or `null`. Separate from `dbs` deliberately: that bundle is the three
   *  READ-ONLY handles and its whole meaning is that nothing in it can be written. Putting a
   *  writable database in it would make B1's sentence stop being about a type. */
  opsDb: Db | null;
  /**
   * What the write probe actually found: `true` when every player-data database refused the
   * write, `false` when at least one accepted it and `BB_ADMIN_ALLOW_WRITABLE` permitted the
   * boot anyway.
   *
   * Reported rather than assumed, and that is the difference the port made. This used to be
   * the literal `true` in `main.ts`'s startup line, which was honest because the handles
   * carried a mode flag. Now it is a measurement, and a deployment running without B1 says
   * so on every boot instead of looking identical to one that holds it.
   */
  readOnly: boolean;
}

/**
 * Raised when the console's own credential turns out to be able to WRITE player data.
 *
 * An `AdminStartupError` subclass so `main.ts`'s `runMain` already turns it into exit 1 and
 * a readable line — the same treatment a missing password gets, because it is the same kind
 * of fact: a configuration that makes this process something other than what design/21 says
 * it is.
 */
export class AdminWritableError extends AdminStartupError {
  constructor(message: string) {
    super(message);
    this.name = 'AdminWritableError';
  }
}

/**
 * The escape hatch, and the reason it is spelled out loudly rather than defaulted.
 *
 * A local mongod has no roles, so every developer machine and the whole test suite would
 * fail the probe. The alternative to a hatch is skipping the probe when it is inconvenient,
 * which is the version that silently never runs in production either. So: the probe ALWAYS
 * runs, always logs its answer, and refuses to boot on a writable credential unless this
 * variable says the operator knows. On a real box it is a one-line grep, and the startup log
 * says `readOnly: false` every time the process starts.
 */
export const ALLOW_WRITABLE_VAR = 'BB_ADMIN_ALLOW_WRITABLE';

/**
 * Runs the write probe against every opened player-data database and enforces B1.
 *
 * Exported for its own test, and separate from `createAdminsvcServer` because what it
 * decides is worth reading on its own: whether this process is the thing design/21 decision
 * B1 describes. A `refused` answer from EVERY database is the only pass — one writable
 * handle out of three is a console that can write player data, which is not a lesser version
 * of the property, it is the absence of it.
 *
 * Returns whether B1 holds. It THROWS when it does not and nothing said that was expected,
 * so the `false` return is reachable only through the escape hatch — which is exactly the
 * state worth carrying into the startup log rather than discarding.
 */
export async function assertReadOnlyAccess(dbs: AdminDbs, env: AdminEnv, log: Logger): Promise<boolean> {
  const writable: string[] = [];
  for (const { name, db } of openedDbs(dbs)) {
    const probe = await probeWriteAccess(db);
    if (probe.refused) log.info('write probe refused', { db: name, err: probe.reason });
    else writable.push(name);
  }
  if (writable.length === 0) return true;

  const allowed = env.BB_ADMIN_ALLOW_WRITABLE?.trim();
  if (allowed === '1' || allowed === 'true') {
    log.warn('write probe ACCEPTED — decision B1 does not hold on this deployment', {
      dbs: writable.join(','),
      allowedBy: ALLOW_WRITABLE_VAR,
    });
    return false;
  }
  throw new AdminWritableError(
    `this console's cluster credential can WRITE ${writable.join(', ')}. design/21 decision B1 ` +
      `is that the console cannot write player data, and since the MongoDB port the only thing ` +
      `enforcing it is the Atlas role on this service's database user. Give that user \`read\` on ` +
      `the player-data databases and nothing else, or set ${ALLOW_WRITABLE_VAR}=1 to run without ` +
      `B1 (a local mongod has no roles, which is the only case that should need it)`,
  );
}

/**
 * Builds the console. THROWS `AdminStartupError` before opening or binding anything when
 * the environment carries no usable credential, and `AdminWritableError` after opening when
 * the credential turns out to be writable — the same fail-closed ordering `billsvc/main.ts`
 * uses, and for a sharper reason: there is no safe default for the password on a login page
 * that is on the public internet, and no safe way to run a console that can write the data
 * it was built to only read.
 */
export async function createAdminsvcServer(opts: AdminsvcServerOptions = {}): Promise<AdminsvcServer> {
  const env = opts.env ?? process.env;
  const credential = assertAdminStartupSafety(env);
  const log = opts.log ?? createLogger('adminsvc');
  const dbs = await openAdminDbs(
    { analyticsEnabled: analyticsEnabledFromEnv(env as NodeJS.ProcessEnv), ...opts.dbs },
    log,
  );
  const readOnly = await assertReadOnlyAccess(dbs, env, log);

  const opsFlags = opts.opsFlags ?? opsFlagsEnabledFromEnv(env);
  let opsDb: Db | null = null;
  if (opsFlags) {
    opsDb = opts.opsDb ?? store('ops');
    // Idempotent, on every boot, which is what replaces a migration step. Skipped entirely
    // when there is no flag store, so a deployment that has not opted in creates nothing:
    // an operator looking at the cluster can tell "switched off" from "switched on and
    // never used".
    await ensureOpsIndexes(opsDb);
  }

  const deps: FlagRouteDeps = {
    dbs,
    opsDb,
    credential,
    sessions: new AdminSessionStore(opts.sessionTtlMs ?? ADMIN_SESSION_TTL_MS),
    limiter: new RateLimiter(LOGIN_RATE_LIMIT.requests, LOGIN_RATE_LIMIT.windowMs),
    log,
    cookieSecure: adminCookieSecure(env),
    now: opts.now,
    // Built from `config.ts`'s registry, which under `NODE_ENV=production` with no
    // `BB_INTERNAL_KEY` set is EMPTY and therefore rejects every call (design/19 §5). The
    // default here is fail-closed, never "no auth".
    verifier: opts.verifier ?? createInternalVerifier(internalKeys().registry),
  };

  const server = createServer((req, res) => {
    const { url, path, method } = requestTarget(req);

    // The audit line (§3.3). `authed` is read here, before the handler can change it, so a
    // login's line says "arrived without a session" — which is what makes the pair of lines
    // around a sign-in readable. The path comes from `URL`, so it is already normalised and
    // carries no query string: a search term is a player's username and has no business in
    // a log store.
    const had = routes.authed(req, deps);
    res.on('finish', () => {
      // `operator` ONLY when a session actually arrived. Stamping the configured operator
      // name on every line reads as "this person made this request", which for an
      // unauthenticated one — a health probe, a stray `/favicon.ico`, a rejected login — is
      // exactly the wrong claim to leave in an audit trail. Found by reading the real log of
      // a live session rather than the test that produced it.
      const fields = { method, path, status: res.statusCode, session: had };
      log.info('request', had ? { ...fields, operator: credential.user } : fields);
    });

    // Every arm below returns a promise or `undefined`; `Promise.resolve` normalises the
    // two so one `.catch` covers the whole chain. See the file header — without it a
    // transient cluster failure on any page load is a dead console.
    Promise.resolve(dispatch(req, res, url, path, method, deps)).catch((e: unknown) => {
      reportRequestFailure(res, log, { method, path }, e);
    });
  });

  return { server, dbs, opsDb, readOnly };
}

/**
 * What the boundary does with a failure, as its own exported function.
 *
 * Extracted from the `.catch` above rather than left inline because its two arms are
 * genuinely different answers and only one of them is reachable through a route: every
 * handler in this process builds its whole body before it sends, so `headersSent` is false
 * for all of them. A branch no test can reach is one a coverage gate cannot tell apart from
 * an untested one — and deleting it instead would be wrong, because the day somebody adds a
 * handler that streams is the day a 500 written after a partial page becomes a browser
 * rendering half a document plus a JSON error.
 */
export function reportRequestFailure(
  res: ServerResponse,
  log: Logger,
  where: { method: string; path: string },
  e: unknown,
): void {
  log.error('request failed', { ...where, error: e instanceof Error ? e.message : String(e) });
  if (res.headersSent) {
    // A page that is half-written cannot become a 500; destroying the socket is what tells
    // the browser the body it has is not the whole one.
    res.destroy();
    return;
  }
  sendJson(res, 500, { error: 'internal error' });
}

/**
 * The chain itself, lifted out of the `createServer` callback so the boundary above has
 * exactly one expression to wrap.
 *
 * Not exported: the dispatch order is `createAdminsvcServer`'s business and a caller that
 * could invoke it directly could invoke it without the audit line or the boundary, which
 * are the two things every request here is supposed to have.
 */
function dispatch(
  req: Parameters<typeof routes.getPage>[0],
  res: Parameters<typeof routes.getPage>[1],
  url: URL,
  path: string,
  method: string,
  deps: FlagRouteDeps,
): void | Promise<void> {
  if (method === 'GET' && path === routes.ADMIN_HEALTH_PATH) return routes.getHealth(req, res, url, deps);
  // `/admin` and `/admin/` are the same page. Caddy's `handle /admin*` matches both and a
  // person types the first one; answering only the second means the bare path 404s from a
  // typed address bar, which reads as "the console is down".
  if (method === 'GET' && (path === routes.ADMIN_ROOT || path === routes.ADMIN_ROOT_BARE)) {
    return routes.getPage(req, res, url, deps);
  }
  if (method === 'POST' && path === routes.ADMIN_LOGIN_PATH) return routes.postLogin(req, res, url, deps);
  if (method === 'POST' && path === routes.ADMIN_LOGOUT_PATH) return routes.postLogout(req, res, url, deps);

  // Phase C (design/21 §4). One internal-key route that services poll, and the two
  // operator-session write paths — the only writes in this process, all three in their own
  // file so that "what can this console change" has a file for an answer.
  if (method === 'GET' && path === flagRoutes.INTERNAL_FLAGS_PATH) {
    return flagRoutes.getInternalFlags(req, res, url, deps);
  }
  if (method === 'POST' && path === flagRoutes.FLAGS_SET_PATH) return flagRoutes.postFlagSet(req, res, url, deps);
  if (method === 'POST' && path === flagRoutes.FLAGS_CLEAR_PATH) {
    return flagRoutes.postFlagClear(req, res, url, deps);
  }

  routes.notFound(res);
}

/**
 * Whether this deployment has a flag store — `BB_OPS_FLAGS_ENABLED` set to `1` or `true`,
 * and nothing else.
 *
 * Replaces `opsDbPathFromEnv`, and the replacement is not a rename. The old variable was a
 * PATH, and its absence was the switch: unset meant there was no file to open, so there was
 * no flag store, so `/internal/flags` answered 503 and every service kept its compiled-in
 * defaults. design/19 §9's already-paid-for lesson lived here too — a compose file with a
 * trailing `BB_OPS_DB_PATH:` and no value produced `""`, which beat a `??` fallback and
 * made `openOpsDb('')` a temporary database where an operator's flag appeared to save and
 * vanished on restart.
 *
 * On a cluster `store('ops')` always resolves, so absence stops meaning anything and the
 * switch has to be said out loud or it is gone. Off for both unset and empty, so the
 * trailing-colon compose line still means "no flag store" rather than "one nobody chose".
 */
export function opsFlagsEnabledFromEnv(env: AdminEnv = process.env): boolean {
  const raw = env.BB_OPS_FLAGS_ENABLED?.trim().toLowerCase();
  return raw === '1' || raw === 'true';
}
