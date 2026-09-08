/**
 * Username/password accounts (design/16-accounts.md) — the first real identity layer
 * this project has ever had (see `PartyService.ts`/`rating.ts`'s own notes on the
 * previous total absence of one). Pure class over an injected `DatabaseSync` (same
 * dependency-injection shape as `PartyService`/`Matchmaker`), so tests run against a
 * `:memory:` DB with no disk I/O.
 *
 * Sessions are opaque bearer tokens stored server-side (not JWT) — revocable via a
 * plain `DELETE`, matching this codebase's existing preference for a few extra bytes
 * over a new dependency (`ticket.ts` uses raw HMAC rather than a JWT library too).
 *
 * `accounts.provider`/`provider_id` (default `'local'`/`NULL`) were reserved for
 * third-party login and, since 2026-09-08, are used: `loginWithProvider` is the
 * federated half of this class, and CrazyGames is its first caller (design/20 "account
 * integration", `routes/auth.ts`'s `/auth/portal`). What that reservation predicted
 * held — a new provider is a `provider != 'local'` row plus a route — with one thing it
 * did not predict, which is why `accounts.display_name` exists: a federated identity
 * arrives with a name chosen under someone else's rules, and it cannot be forced through
 * ours (see `loginWithProvider`).
 */
import type { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { isBlockedUsername } from './usernameFilter';

const SESSION_TTL_MS = 30 * 24 * 60 * 60_000; // 30 days
const SCRYPT_KEYLEN = 64;
const MIN_USERNAME = 3;
const MAX_USERNAME = 20;
const MIN_PASSWORD = 8;
// A provider's display name is truncated, never rejected (see `loginWithProvider`) — this is
// the one bound we do impose on it, so a name arriving pathologically long cannot become a
// row nothing can render. Wider than MAX_USERNAME because it is not our namespace to size.
const MAX_DISPLAY_NAME = 40;
// Login brute-force lockout: after this many consecutive failures for a username,
// further attempts are rejected outright (no password check at all, so a lockout
// can't itself be used to brute-force-verify a guessed password) until the window
// elapses. Keyed by username, not IP — this server has no request-IP plumbing
// today and a per-username lock still stops the actual attack (repeatedly guessing
// one account's password), matching `changePassword`'s own account-scoped threat
// model.
const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_LOCKOUT_MS = 15 * 60_000;

export interface AuthServiceDeps {
  nowMs?: () => number;
  newAccountId?: () => string;
  newToken?: () => string;
}

export interface AuthSuccess {
  accountId: string;
  username: string;
  token: string;
}
export interface AuthFailure {
  error: string;
}
export type AuthResult = AuthSuccess | AuthFailure;

/**
 * The `password_hash` of an account that has no password, because it authenticates through
 * a provider instead. `password_hash` is `NOT NULL`, so a federated row needs SOME value,
 * and the value must be one no password can ever verify against.
 *
 * It is checked EXPLICITLY (`verifyPassword`'s first line) rather than relied upon to fail
 * the ordinary comparison. It would in fact fail it — there is no `:` to split on, so the
 * hash half comes back `undefined` — but "no password matches this row" would then be a
 * property of the storage FORMAT, three lines away from anything that says so, and the day
 * that format changes the failure mode is silent password-free login. `login` additionally
 * refuses any row whose provider is not `local`, so this is the second of two independent
 * guards rather than the only one.
 */
const NO_PASSWORD = '!';

function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifyPassword(password: string, stored: string): boolean {
  if (stored === NO_PASSWORD) return false; // see NO_PASSWORD — a federated row, never loginable by password
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function validateUsername(username: unknown): string | null {
  if (typeof username !== 'string' || username.length < MIN_USERNAME || username.length > MAX_USERNAME) {
    return `username must be ${MIN_USERNAME}-${MAX_USERNAME} characters`;
  }
  if (!/^[a-zA-Z0-9_]+$/.test(username)) return 'username may only contain letters, digits, and underscore';
  if (isBlockedUsername(username)) return 'username not allowed';
  return null;
}

function validatePassword(password: unknown): string | null {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
    return `password must be at least ${MIN_PASSWORD} characters`;
  }
  return null;
}

export class AuthService {
  private readonly nowMs: () => number;
  private readonly newAccountId: () => string;
  private readonly newToken: () => string;
  // In-memory only (matches this project's existing convention — Matchmaker/RatingStore's
  // own cache fallback are in-memory too): a lockout resetting on server restart is an
  // acceptable tradeoff for a brute-force throttle, and keeps this independent of the DB
  // schema (a failed-login count is not account state worth persisting).
  private readonly loginAttempts = new Map<string, { count: number; lockedUntil: number }>();

  constructor(
    private readonly db: DatabaseSync,
    deps: AuthServiceDeps = {},
  ) {
    this.nowMs = deps.nowMs ?? (() => Date.now());
    this.newAccountId = deps.newAccountId ?? (() => randomUUID());
    this.newToken = deps.newToken ?? (() => randomBytes(32).toString('hex'));
  }

  register(username: unknown, password: unknown): AuthResult {
    const usernameError = validateUsername(username);
    if (usernameError) return { error: usernameError };
    const passwordError = validatePassword(password);
    if (passwordError) return { error: passwordError };
    const name = username as string;

    // COLLATE NOCASE: usernames are case-insensitively unique — 'Alice' and 'alice'
    // being two distinct accounts is a real impersonation/confusion footgun, not a
    // useful feature. Applied consistently with login's own lookup below.
    const existing = this.db.prepare('SELECT id FROM accounts WHERE username = ? COLLATE NOCASE').get(name);
    if (existing) return { error: 'username already taken' };

    const accountId = this.newAccountId();
    this.db
      .prepare('INSERT INTO accounts (id, username, password_hash, provider, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(accountId, name, hashPassword(password as string), 'local', this.nowMs());

    return this.issueSession(accountId, name);
  }

  login(username: unknown, password: unknown): AuthResult {
    if (typeof username !== 'string' || typeof password !== 'string') return { error: 'invalid username or password' };
    // COLLATE NOCASE means 'Alice'/'alice' are one account for login purposes, so the
    // lockout key must fold case the same way or the two spellings would get separate
    // attempt budgets — normalized once here, reused for every read/write below.
    const key = username.toLowerCase();
    const now = this.nowMs();
    const attempt = this.loginAttempts.get(key);
    if (attempt && attempt.lockedUntil > now) {
      return { error: 'too many failed login attempts — try again later' };
    }

    // `provider` is selected and checked below rather than filtered in the WHERE clause on
    // purpose: a federated account must be indistinguishable, from the outside, from a
    // username that does not exist — filtering it out here and letting the generic "invalid
    // username or password" answer cover it is what makes the two identical. `displayName`
    // COALESCEs to `username` for a local row, which is every row this path can reach.
    const row = this.db
      .prepare(
        `SELECT id, username, password_hash, provider, COALESCE(display_name, username) AS displayName
         FROM accounts WHERE username = ? COLLATE NOCASE`,
      )
      .get(username) as
      | { id: string; username: string; password_hash: string; provider: string; displayName: string }
      | undefined;
    if (!row || row.provider !== 'local' || !verifyPassword(password, row.password_hash)) {
      // Reaching here means any prior lockout already expired (a still-active one
      // returned above), so the streak simply continues from wherever it left off.
      const count = (attempt?.count ?? 0) + 1;
      const lockedUntil = count >= MAX_LOGIN_ATTEMPTS ? now + LOGIN_LOCKOUT_MS : 0;
      this.loginAttempts.set(key, { count, lockedUntil });
      return { error: 'invalid username or password' };
    }

    this.loginAttempts.delete(key);
    return this.issueSession(row.id, row.displayName);
  }

  /**
   * Log in (registering on first sight) an identity a PROVIDER vouched for — CrazyGames
   * today, via `routes/auth.ts`'s `/auth/portal` once `portalToken.ts` has verified the
   * signature. There is no password anywhere in this path and no way to add one: the
   * provider is the only credential, which is precisely why the token must be verified
   * before this is called.
   *
   * Two things are NOT reused from `register`, and both are the point of this method
   * existing rather than a flag on that one:
   *
   * - **The provider's name is not validated.** `validateUsername`'s 3–20 characters,
   *   `[a-zA-Z0-9_]` and profanity blacklist are the rules for a name a player CHOOSES here.
   *   A CrazyGames username was chosen under CrazyGames' rules, and applying ours to it
   *   would mean a player whose name is 2 characters, has a dash in it, or trips our
   *   substring blacklist could never log in at all — an unfixable dead end for them, in
   *   exchange for a moderation rule the platform already applies at its own registration.
   *   It is stored in `display_name`, never as a handle.
   * - **The handle is derived, not chosen.** `{provider}:{providerId}` is unique by
   *   construction and contains a `:`, which `validateUsername` forbids — so it can never
   *   collide with, or be impersonated by, a local account. That is what lets a portal
   *   player named `Alice` coexist with a local account named `Alice` (the project owner's
   *   decision, 2026-09-08: the same human on two platforms is two accounts, deliberately,
   *   because linking them is the one thing that would put a portal's account rules in
   *   charge of our own).
   *
   * `UNIQUE(provider, provider_id)` (db.ts) is what makes the find-or-create safe under
   * concurrency: two simultaneous first logins race, one INSERT loses, and the loser
   * re-reads the winner's row instead of creating a second account.
   */
  loginWithProvider(opts: { provider: string; providerId: string; displayName: string }): AuthSuccess {
    const { provider, providerId } = opts;
    const displayName = opts.displayName.slice(0, MAX_DISPLAY_NAME);
    const existing = this.findProviderAccount(provider, providerId);
    if (existing) {
      // The provider is authoritative over the name, every time — a player who renames on
      // the portal must not still be shown to other players under their old name.
      if (existing.displayName !== displayName) {
        this.db.prepare('UPDATE accounts SET display_name = ? WHERE id = ?').run(displayName, existing.id);
      }
      return this.issueSession(existing.id, displayName);
    }

    const accountId = this.newAccountId();
    try {
      this.db
        .prepare(
          `INSERT INTO accounts (id, username, password_hash, provider, provider_id, created_at, display_name)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(accountId, `${provider}:${providerId}`, NO_PASSWORD, provider, providerId, this.nowMs(), displayName);
    } catch {
      // Lost the race on `accounts_provider_id` (or on `username`, which is derived from the
      // same two values). The winner's row is the account; ours was never created.
      const winner = this.findProviderAccount(provider, providerId);
      if (!winner) throw new Error('provider account insert failed');
      return this.issueSession(winner.id, winner.displayName);
    }
    return this.issueSession(accountId, displayName);
  }

  private findProviderAccount(provider: string, providerId: string): { id: string; displayName: string } | undefined {
    return this.db
      .prepare(
        `SELECT id, COALESCE(display_name, username) AS displayName
         FROM accounts WHERE provider = ? AND provider_id = ?`,
      )
      .get(provider, providerId) as { id: string; displayName: string } | undefined;
  }

  logout(token: string): void {
    this.db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  }

  /** `null` on an unknown, expired, or malformed token — the caller maps that to a 401. */
  verifySession(token: unknown): { accountId: string; username: string } | null {
    if (typeof token !== 'string' || !token) return null;
    const row = this.db
      .prepare(
        `SELECT s.account_id as accountId, s.expires_at as expiresAt,
                COALESCE(a.display_name, a.username) as username
         FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE s.token = ?`,
      )
      .get(token) as { accountId: string; expiresAt: number; username: string } | undefined;
    if (!row) return null;
    if (row.expiresAt < this.nowMs()) {
      this.db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
      return null;
    }
    return { accountId: row.accountId, username: row.username };
  }

  changePassword(accountId: string, oldPassword: unknown, newPassword: unknown): { ok: true } | AuthFailure {
    const row = this.db.prepare('SELECT password_hash FROM accounts WHERE id = ?').get(accountId) as
      | { password_hash: string }
      | undefined;
    // A federated account has no password to change, and no way to acquire one — saying so
    // is safe (the caller already proved they hold this account's session) and is the only
    // answer that is not a lie. `verifyPassword` would refuse it anyway; this is the
    // difference between refusing and refusing for a reason the caller can act on.
    if (row?.password_hash === NO_PASSWORD) {
      return { error: 'this account signs in through its platform and has no password' };
    }
    if (!row || typeof oldPassword !== 'string' || !verifyPassword(oldPassword, row.password_hash)) {
      return { error: 'invalid current password' };
    }
    const passwordError = validatePassword(newPassword);
    if (passwordError) return { error: passwordError };
    this.db.prepare('UPDATE accounts SET password_hash = ? WHERE id = ?').run(hashPassword(newPassword as string), accountId);
    return { ok: true };
  }

  private issueSession(accountId: string, username: string): AuthSuccess {
    // Opportunistic sweep, not a background timer: this project's "no process the
    // team doesn't need yet" convention (see rating.ts/AuthService's own doc notes) —
    // a login/register is exactly as frequent as new rows get added, so sweeping here
    // keeps the table from growing unbounded without a setInterval this class would
    // otherwise be the only thing owning. verifySession (the hot per-request read
    // path) deliberately does NOT sweep here — only the one expired row it already
    // looks at, to keep every authenticated request to a single indexed lookup.
    this.sweepExpiredSessions();
    const token = this.newToken();
    const expiresAt = this.nowMs() + SESSION_TTL_MS;
    this.db.prepare('INSERT INTO sessions (token, account_id, expires_at) VALUES (?, ?, ?)').run(token, accountId, expiresAt);
    return { accountId, username, token };
  }

  private sweepExpiredSessions(): void {
    this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(this.nowMs());
  }
}
