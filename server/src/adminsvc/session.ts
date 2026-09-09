/**
 * The console's session cookie (design/21 §3.3): minting, expiry, and the two string
 * formats — `Set-Cookie` out and `Cookie` in.
 *
 * Pure of `node:http` and of `process.env`, the same way `ticket.ts` and `internalAuth.ts`
 * are: the clock is injected, the input is a plain header string. Every branch below is
 * reachable without a server.
 *
 * ## In memory, on purpose
 *
 * Sessions live in a `Map` in this process and are lost on restart, which means a deploy
 * logs the operator out. That is the right trade here and not a shortcut: persisting them
 * would need a table, and the only database this process could write it to is one of the
 * three it opens READ-ONLY (B1). A fourth, writable file would trade the console's one
 * genuinely strong property — it holds no write handle — for not having to log in again
 * after a deploy. With one operator and an 8-hour TTL, the cost is a login.
 */
import { randomBytes } from 'node:crypto';
import { ADMIN_SESSION_TTL_MS } from './credentials';

/** The cookie's name. Prefixed so it cannot collide with anything the game itself sets on
 *  the same host — the client's own session token lives in localStorage, not a cookie, but
 *  the two are served from the same origin and a shared name would be found the hard way. */
export const ADMIN_COOKIE = 'bb_admin';

/**
 * `Path=/admin`, so the cookie is not attached to a single request the GAME serves.
 *
 * This is the one cookie attribute chosen for something other than its own security: the
 * whole site is one origin behind Caddy, so a `Path=/` cookie would ride along on every
 * `POST /client/events` and every `/find` poll from every player's browser — which is both
 * pointless traffic and a credential crossing surfaces it has no business on.
 */
export const ADMIN_COOKIE_PATH = '/admin';

export interface AdminSession {
  token: string;
  /** Absolute, from the login. There is no sliding refresh — see `credentials.ts`. */
  expiresAtMs: number;
}

/**
 * The live sessions, with a sweep-on-write map exactly like `RateLimiter`'s and for the same
 * reason: a timer to expire sessions would keep the process alive or need `unref`, and the
 * map is bounded by how many times one operator can log in inside 8 hours.
 */
export class AdminSessionStore {
  private readonly sessions = new Map<string, AdminSession>();

  constructor(private readonly ttlMs: number = ADMIN_SESSION_TTL_MS) {}

  /** Mints a session. 32 bytes from `randomBytes` — the same source and width
   *  `AuthService` uses for a player session token. */
  create(nowMs: number): AdminSession {
    this.sweep(nowMs);
    const session: AdminSession = { token: randomBytes(32).toString('hex'), expiresAtMs: nowMs + this.ttlMs };
    this.sessions.set(session.token, session);
    return session;
  }

  /** True when this token names a live session. An expired token is deleted on the way to
   *  answering false, so a stolen-then-expired token cannot be resurrected by a clock that
   *  moves backwards. */
  valid(token: string | undefined, nowMs: number): boolean {
    if (token === undefined) return false;
    const session = this.sessions.get(token);
    if (session === undefined) return false;
    if (session.expiresAtMs <= nowMs) {
      this.sessions.delete(token);
      return false;
    }
    return true;
  }

  /** Logout. Idempotent — an unknown token is not an error, and answering one differently
   *  would say whether it had ever been a session. */
  revoke(token: string | undefined): void {
    if (token !== undefined) this.sessions.delete(token);
  }

  /** Live session count, for `/admin/health` and for a test that wants to see the sweep
   *  actually happen rather than infer it from a `valid()` answer. */
  size(): number {
    return this.sessions.size;
  }

  private sweep(nowMs: number): void {
    for (const [token, session] of this.sessions) {
      if (session.expiresAtMs <= nowMs) this.sessions.delete(token);
    }
  }
}

/**
 * The `Set-Cookie` value for a fresh session.
 *
 * `HttpOnly` (no script on this page or any other can read it), `SameSite=Strict` (it is
 * not attached to a cross-site request at all, which is what removes CSRF from scope for
 * every route here — there are no state-changing routes but login and logout, and neither
 * can be triggered from another origin), `Secure` unless a developer has explicitly
 * relaxed it, and `Max-Age` matching the server-side TTL so the browser forgets it at the
 * same moment the server does.
 *
 * `secure` is a parameter rather than read from the environment here, because this module
 * is the pure half — `credentials.ts`'s `adminCookieSecure` is the one place that decides.
 */
export function cookieHeader(session: AdminSession, nowMs: number, secure: boolean): string {
  const maxAgeS = Math.max(0, Math.floor((session.expiresAtMs - nowMs) / 1000));
  const attrs = [
    `${ADMIN_COOKIE}=${session.token}`,
    `Path=${ADMIN_COOKIE_PATH}`,
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAgeS}`,
  ];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

/** The `Set-Cookie` value that CLEARS the cookie. `Max-Age=0` plus an empty value, with the
 *  same `Path` — a clear whose path does not match the one that set it leaves the original
 *  cookie in place, which is the classic way a logout button does nothing. */
export function clearCookieHeader(secure: boolean): string {
  const attrs = [`${ADMIN_COOKIE}=`, `Path=${ADMIN_COOKIE_PATH}`, 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

/**
 * Reads our cookie out of a request's `Cookie` header.
 *
 * Deliberately small and deliberately strict: split on `;`, take the first `=`, match the
 * name exactly. A cookie value from a browser is percent-ish encoded in general, but this
 * one is minted here as 64 hex characters, so anything that does not look like that is not
 * a session token and there is nothing to decode. Returns `undefined` for absent,
 * malformed, empty or duplicated-with-no-value.
 */
export function readCookie(header: string | string[] | undefined): string | undefined {
  if (typeof header !== 'string') return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== ADMIN_COOKIE) continue;
    const value = part.slice(eq + 1).trim();
    if (/^[0-9a-f]{64}$/.test(value)) return value;
  }
  return undefined;
}
