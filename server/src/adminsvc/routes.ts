/**
 * The console's five request handlers (design/21 §3.3 and §3.4): the page, the login, the
 * logout, the health probe, and the 404 that is everything else.
 *
 * Free `(req, res, url, deps)` functions with `server.ts` as the assembly shell — the same
 * split form `routes/*` uses for matchsvc, for the same reason (CLAUDE.md's form 1: an
 * if/else dispatch over shared-nothing handlers).
 *
 * ## The three things that make this proportionate on the public internet
 *
 * 1. **There is no write here to reach.** Not "the handlers do not write" — `deps.dbs`
 *    holds three `readOnly` SQLite handles and nothing else (`dbs.ts`, decision B1), so
 *    the worst outcome of a total compromise of this login is disclosure. Everything below
 *    is defence in depth behind that fact.
 * 2. **A login rate limit**, per IP, ahead of the credential comparison — `rateLimit.ts`'s
 *    limiter with its own budget ({@link LOGIN_RATE_LIMIT}).
 * 3. **Every request is logged**, with the path, the outcome and whether it carried a live
 *    session. Not an audit *system* — B2 removed the writes one would audit — an audit
 *    *line*, in the store that now exists.
 *
 * ## What the login deliberately does not tell you
 *
 * A wrong username and a wrong password produce the same message, after the same work
 * (`credentialMatches` compares both halves with no short circuit). A rate-limited attempt
 * produces a DIFFERENT message, on purpose: the operator needs to know why their third try
 * bounced, and the fact that a limiter exists is not a secret worth keeping from somebody
 * who has just been limited by it.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import type { Logger } from '../log';
import type { AdminDbs } from './dbs';
import { RateLimiter, clientKey } from '../rateLimit';
import { credentialMatches, type AdminCredential } from './credentials';
import { AdminSessionStore, ADMIN_COOKIE_PATH, clearCookieHeader, cookieHeader, readCookie } from './session';
import { readForm, redirect, sendHtml, sendJson } from './http';
import { document, esc, loginPage, shell, tabFrom, unavailable } from './page/layout';
import { commerceSection, playersSection, retentionSection } from './page/sections';
import { searchPlayers } from './views/players';
import { commerceSnapshot } from './views/commerce';
import { cohortGrid } from './views/retention';
import { flagsSection, flagsUnavailable, type FlagsView } from './page/flags';
import { effectiveFlags, listOverrides } from '../flags/store';
import { FLAG_DEFS, FLAG_NAMES } from '../flags/defs';

/**
 * Login attempts per IP per window.
 *
 * Ten in five minutes: an operator who mistypes a generated password twice and pastes it
 * correctly on the third try never sees it, and an online guess against a 32-character
 * random value at 120 attempts an hour is not a threat model, it is arithmetic. Much
 * stricter than the telemetry pair's 20-per-minute because the legitimate rate here is
 * roughly one per working day rather than two per thirty seconds.
 */
export const LOGIN_RATE_LIMIT = { requests: 10, windowMs: 5 * 60_000 } as const;

/** The paths, in one place — `server.ts` dispatches on them and the deploy manifest test
 *  reads the health one. */
export const ADMIN_ROOT = '/admin/';
export const ADMIN_ROOT_BARE = '/admin';
export const ADMIN_LOGIN_PATH = '/admin/login';
export const ADMIN_LOGOUT_PATH = '/admin/logout';
export const ADMIN_HEALTH_PATH = '/admin/health';

export interface AdminRouteDeps {
  dbs: AdminDbs;
  credential: AdminCredential;
  sessions: AdminSessionStore;
  limiter: RateLimiter;
  log: Logger;
  /** Whether the session cookie carries `Secure` — resolved once at startup by `main`
   *  through `adminCookieSecure`, never re-derived per request. */
  cookieSecure: boolean;
  /** Injected by tests to freeze the clock. */
  now?: () => number;
  /**
   * `ops.db` (design/21 §4), or `null` when this deployment has no flag store.
   *
   * On the SHARED deps bundle rather than only on `flagRoutes.ts`'s own, because two
   * handlers here need it: `getPage` renders the flags tab and `getHealth` reports whether
   * the handle exists. It is the only writable database this process opens, and the only
   * one that holds nothing about a player — `flags/store.ts`'s header is where that
   * distinction is argued.
   */
  opsDb?: DatabaseSync | null;
}

const nowOf = (deps: AdminRouteDeps): number => (deps.now ?? Date.now)();

/** Whether this request carries a live console session. */
export function authed(req: IncomingMessage, deps: AdminRouteDeps): boolean {
  return deps.sessions.valid(readCookie(req.headers.cookie), nowOf(deps));
}

/**
 * `GET /admin/` — the whole console, or the login form.
 *
 * One handler for all three tabs rather than three routes: the tab is a query parameter, so
 * a bookmark keeps its search term, and there is exactly one place that decides whether the
 * caller is signed in. Three routes would be three places, and the one that forgot would
 * not look different from the outside.
 *
 * A signed-out caller gets the login page with a **200**, not a 401 or a redirect. A 401
 * would make a browser show its own basic-auth prompt in some configurations, and a
 * redirect to a login URL would be one more path to get the auth check right on.
 */
export function getPage(req: IncomingMessage, res: ServerResponse, url: URL, deps: AdminRouteDeps): void {
  if (!authed(req, deps)) return sendHtml(res, 200, loginPage(null));

  const tab = tabFrom(url.searchParams.get('tab'));
  const notes: string[] = [];
  let body: string;

  if (tab === 'commerce') {
    body =
      deps.dbs.billing === null
        ? unavailable('Commerce', deps.dbs.errors.billing)
        : commerceSection(commerceSnapshot(deps.dbs.billing));
  } else if (tab === 'retention') {
    body =
      deps.dbs.analytics === null
        ? unavailable('Retention', deps.dbs.errors.analytics)
        : retentionSection(cohortGrid(deps.dbs.analytics));
  } else if (tab === 'flags') {
    // The one tab whose database is WRITABLE, and the one whose absence is a configuration
    // state rather than a fault — see `flagsUnavailable`.
    body = (deps.opsDb ?? null) === null ? flagsUnavailable() : flagsSection(flagsView(deps.opsDb!));
  } else if (deps.dbs.accounts === null) {
    body = unavailable('Players', deps.dbs.errors.accounts);
  } else {
    // The analytics handle feeds one COLUMN of this table, so its absence is a note rather
    // than an unavailable section — a deployment that collects nothing must still be able
    // to look an account up (`dbs.ts`'s header).
    if (deps.dbs.analytics === null) notes.push(`Last-active column is blank: ${deps.dbs.errors.analytics}`);
    body = playersSection(
      searchPlayers(deps.dbs.accounts, deps.dbs.analytics, url.searchParams.get('q') ?? ''),
      deps.dbs.analytics === null,
    );
  }

  sendHtml(res, 200, shell(tab, body, notes));
}

/**
 * `POST /admin/login`.
 *
 * The limiter is taken BEFORE the body is read, so a flood costs this process a header
 * parse rather than a 4 KB buffer plus two SHA-256s — the same ordering
 * `postClientLog` uses and for the same reason.
 */
export function postLogin(req: IncomingMessage, res: ServerResponse, _url: URL, deps: AdminRouteDeps): void {
  const at = nowOf(deps);
  const key = clientKey(req);

  if (!deps.limiter.take(key, at)) {
    deps.log.warn('login rate limited', { ip: key });
    return sendHtml(res, 429, loginPage('Too many attempts. Wait a few minutes and try again.'));
  }

  readForm(req, (form) => {
    const user = form.get('user') ?? '';
    const password = form.get('password') ?? '';
    if (!credentialMatches({ user, password }, deps.credential)) {
      // The presented username is NOT logged. It is attacker-chosen text on its way to a
      // log store, and `internalAuth.ts`'s `sanitizeAuditValue` exists because that
      // combination has one known failure mode; the IP is what an operator needs here
      // anyway, and a rejected login says nothing else worth keeping.
      deps.log.warn('login rejected', { ip: key });
      return sendHtml(res, 401, loginPage('Wrong operator or password.'));
    }
    const session = deps.sessions.create(at);
    deps.log.info('login accepted', { ip: key, operator: deps.credential.user });
    redirect(res, ADMIN_ROOT, { 'set-cookie': cookieHeader(session, at, deps.cookieSecure) });
  });
}

/**
 * `POST /admin/logout`.
 *
 * Revokes server-side AND clears the cookie. Either alone is a logout that is not one: a
 * cleared cookie leaves a token that still works if it was ever copied, and a revoked
 * session with the cookie still set means the next page load looks signed in until it
 * does not.
 *
 * Not gated on being signed in. A logout is idempotent by construction (`revoke` ignores
 * an unknown token), and refusing it for an unauthenticated caller would only ever refuse
 * somebody whose session had just expired.
 */
export function postLogout(req: IncomingMessage, res: ServerResponse, _url: URL, deps: AdminRouteDeps): void {
  deps.sessions.revoke(readCookie(req.headers.cookie));
  redirect(res, ADMIN_ROOT, { 'set-cookie': clearCookieHeader(deps.cookieSecure) });
}

/**
 * `GET /admin/health` — for compose's healthcheck, and REFUSED from outside.
 *
 * Caddy proxies `/admin*` here wholesale (design/21 §3.4), so this route would otherwise be
 * a public readout of how many accounts exist and whether billing is up. The rule is the
 * one `matchsvc.ts` already applies to `/metrics`: Caddy stamps `x-forwarded-for` on
 * everything it proxies, so its presence is what "came from outside" means, and the answer
 * is a plain 404 rather than a 403 — a 403 confirms the route is there.
 *
 * What it reports is the thing a healthcheck should: which of the three databases opened.
 * The process is deliberately still `ok` when one is missing (`dbs.ts`'s header), so the
 * field is informational and the container does not restart-loop over a file billsvc has
 * not created yet.
 */
export function getHealth(req: IncomingMessage, res: ServerResponse, _url: URL, deps: AdminRouteDeps): void {
  if (req.headers['x-forwarded-for'] !== undefined) return sendJson(res, 404, { error: 'not found' });
  sendJson(res, 200, {
    ok: true,
    service: 'blightbloom-adminsvc',
    databases: {
      accounts: deps.dbs.accounts !== null,
      billing: deps.dbs.billing !== null,
      analytics: deps.dbs.analytics !== null,
      // The fourth, and the only writable one. Reported beside the other three so a single
      // line answers "what can this console see, and what can it change".
      ops: (deps.opsDb ?? null) !== null,
    },
    sessions: deps.sessions.size(),
  });
}

/** Everything else. An HTML 404 rather than a JSON one, because every other path here
 *  serves a page and a stray link should land somewhere a person can read. */
export function notFound(res: ServerResponse): void {
  sendHtml(
    res,
    404,
    document('Not found', `<main><p>Not found. <a href="${esc(ADMIN_ROOT)}">Console</a>.</p></main>`),
  );
}

/** Exported for `server.ts`'s cookie-path assertion and for the deploy manifest test. */
export const COOKIE_PATH = ADMIN_COOKIE_PATH;

/**
 * Everything the flags tab renders, read out of `ops.db` in one place.
 *
 * Here rather than in `page/flags.ts` because that module is pure by design (no database),
 * and here rather than in `flags/store.ts` because the store answers questions and does not
 * know what a page needs. Two reads: the effective set that services actually get, and the
 * override rows with their metadata — including the ones that failed validation, which are
 * the state the table has to be loud about.
 */
export function flagsView(opsDb: DatabaseSync): FlagsView {
  const { rows, invalid } = listOverrides(opsDb);
  return {
    effective: effectiveFlags(opsDb),
    overrides: rows,
    invalid,
    // Derived here rather than inside the renderer, so that module stays pure over its
    // input — see `FlagsView.undelivered`.
    undelivered: FLAG_NAMES.filter((name) => !FLAG_DEFS[name].delivered),
  };
}
