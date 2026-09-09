/**
 * adminsvc's assembly shell (design/21 §3, decisions B1–B3): builds the dependency bundle,
 * owns the dispatch chain, and logs every request.
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
 * ## Why the log line wraps the response and not just the request
 *
 * §3.3 asks for "every request logged — with the operator and the path". A line written
 * before the handler runs cannot say what happened, and a rejected login and an accepted
 * one are the two entries that matter most. So the status is captured off `res` on `finish`,
 * which is the one hook that fires for every path out of a handler including the ones that
 * end inside a body callback.
 */
import { createServer, type Server } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { createLogger, type Logger } from '../log';
import { RateLimiter } from '../rateLimit';
import { requestTarget } from './http';
import { openOpsDb } from '../flags/store';
import { createInternalVerifier, type InternalVerifier } from '../internalAuth';
import { internalKeys } from '../config';
import * as flagRoutes from './flagRoutes';
import type { FlagRouteDeps } from './flagRoutes';
import { openAdminDbs, type AdminDbPaths, type AdminDbs } from './dbs';
import { AdminSessionStore } from './session';
import { ADMIN_SESSION_TTL_MS, assertAdminStartupSafety, adminCookieSecure, type AdminEnv } from './credentials';
import * as routes from './routes';
import { LOGIN_RATE_LIMIT } from './routes';

export interface AdminsvcServerOptions {
  /** Where the three READ-ONLY databases live. Defaults to each owner's own default path,
   *  and to `BB_ANALYTICS_DB_PATH` for the analytics one (which has no default anywhere). */
  paths?: AdminDbPaths;
  /**
   * Where `ops.db` lives (design/21 §4), or `null` for "this deployment has no flag store".
   *
   * `undefined` means "read `BB_OPS_DB_PATH`, and treat it as absent when unset" — the same
   * opt-in shape analytics has on matchsvc, and for the same reason: a flag store that
   * appeared by default would be a writable database nobody decided to create, in the one
   * process whose whole argument is what it cannot write. When there is none, the flags tab
   * says so and `/internal/flags` answers 503, which every polling service reads as "keep
   * the compiled-in defaults".
   */
  opsDbPath?: string | null;
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
  /** Held so a caller that shuts this down closes the SQLite handles too. On Windows an
   *  unclosed connection keeps a lock on the file, which is how the test suite finds this. */
  dbs: AdminDbs;
  /** The flag store, or `null`. Separate from `dbs` deliberately: that bundle is the three
   *  READ-ONLY handles and its whole meaning is that nothing in it can be written. Putting a
   *  writable database in it would make B1's sentence stop being about a type. */
  opsDb: DatabaseSync | null;
}

/**
 * Builds the console. THROWS `AdminStartupError` before opening or binding anything when
 * the environment carries no usable credential — the same fail-closed ordering
 * `billsvc/main.ts` uses, and for a sharper reason: there is no safe default for the
 * password on a login page that is on the public internet.
 */
export function createAdminsvcServer(opts: AdminsvcServerOptions = {}): AdminsvcServer {
  const env = opts.env ?? process.env;
  const credential = assertAdminStartupSafety(env);
  const log = opts.log ?? createLogger('adminsvc');
  const dbs = openAdminDbs(opts.paths ?? {}, log);
  const opsPath = opts.opsDbPath !== undefined ? opts.opsDbPath : opsDbPathFromEnv();
  const opsDb = opsPath === null ? null : openOpsDb(opsPath);

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
  });

  // Closing the socket closes the databases. Not a `finally` anywhere in the handlers: the
  // three handles are opened once for the life of the process and shared by every request,
  // which is what a `readOnly` SQLite handle is for.
  server.on('close', () => {
    dbs.close();
    opsDb?.close();
  });

  return { server, dbs, opsDb };
}

/**
 * `BB_OPS_DB_PATH`, or `null` when unset or empty.
 *
 * The same empty-string-is-unset rule every other database path in this project applies,
 * and design/19 §9's already-paid-for lesson: a compose file with a trailing
 * `BB_OPS_DB_PATH:` and no value produces `""`, which beats a `??` fallback. Here that
 * would be `openOpsDb('')` — a path SQLite reads as a temporary database, so a flag set by
 * an operator would appear to work and vanish on the next restart.
 */
export function opsDbPathFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.BB_OPS_DB_PATH?.trim();
  return raw !== undefined && raw.length > 0 ? raw : null;
}
