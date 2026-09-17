/**
 * Username/password accounts (design/16-accounts.md) — the first real identity layer
 * this project has ever had (see `PartyService.ts`/`rating.ts`'s own notes on the
 * previous total absence of one). Pure class over an injected `AccountsStore` (same
 * dependency-injection shape as `PartyService`/`Matchmaker`), so tests run against a
 * throwaway database on the shared mongod rather than a fake.
 *
 * Sessions are opaque bearer tokens stored server-side (not JWT) — revocable via a
 * plain delete, matching this codebase's existing preference for a few extra bytes
 * over a new dependency (`ticket.ts` uses raw HMAC rather than a JWT library too).
 *
 * ## `register` claims a name; it no longer asks for one
 *
 * Until the 2026-09-15 move to MongoDB this method read `WHERE username = ? COLLATE
 * NOCASE` and inserted if it found nothing. That was a look-before-write, and it was
 * sound only by accident: `node:sqlite` is synchronous, so nothing could interleave
 * between the two statements. The underlying `UNIQUE` was case-SENSITIVE and never
 * enforced the rule the check existed for.
 *
 * Every read here is a promise now, so the accident is gone and the race is real —
 * concurrent registrations of 'Alice' and 'alice' would both find nothing and both
 * insert. `db.ts`'s `accounts_username_ci` index carries the collation, so the DATABASE
 * enforces case-insensitive uniqueness, and this method inserts first and reads E11000
 * as "taken". That is the shape design/19 §4's AMENDMENT 2 requires of billing and
 * `rating.ts` requires of ladder settlement; registration was the one identity path
 * still doing it the other way.
 *
 * `accounts.provider`/`providerId` (default `'local'`/absent) were reserved for
 * third-party login and, since 2026-09-08, are used: `loginWithProvider` is the
 * federated half of this class, and CrazyGames is its first caller (design/20 "account
 * integration", `routes/auth.ts`'s `/auth/portal`). What that reservation predicted
 * held — a new provider is a `provider != 'local'` row plus a route — with one thing it
 * did not predict, which is why `accounts.display_name` exists: a federated identity
 * arrives with a name chosen under someone else's rules, and it cannot be forced through
 * ours (see `loginWithProvider`).
 */
import { randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { isBlockedUsername } from './usernameFilter';
import { CI_COLLATION, type AccountsStore } from './db';

/**
 * scrypt, on the THREADPOOL rather than on the event loop (2026-09-17).
 *
 * This was `scryptSync` until a test pass asked what an unthrottled `/auth/register` costs.
 * A password hash here is ~50-100ms of deliberate CPU, and the synchronous call spent every
 * millisecond of it inside the one event loop that also serves matchmaking, party and
 * ladder settlement — so a burst of registrations did not merely queue, it froze every
 * other route in the control plane for the duration. The async form does the same work on
 * libuv's threadpool: the cost is unchanged and is meant to be, but it is no longer paid by
 * a player who is only trying to find a match.
 *
 * `routes/auth.ts`'s `REGISTER_RATE_LIMIT` is the other half and neither replaces the other
 * — the limiter bounds how much of this work a caller may ask for, this bounds what that
 * work blocks while it runs.
 */
const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

/** MongoDB's duplicate-key error. The only driver error code this class interprets rather
 *  than propagates: it is how both `register` and `loginWithProvider` learn they lost a
 *  race, and it is the mechanism those two rely on instead of asking first. */
const DUPLICATE_KEY = 11000;

function isDuplicateKey(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: unknown }).code === DUPLICATE_KEY;
}

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

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, SCRYPT_KEYLEN);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (stored === NO_PASSWORD) return false; // see NO_PASSWORD — a federated row, never loginable by password
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  // A stored hash of zero length would make `timingSafeEqual` compare nothing and answer
  // `true`, so the length check is a guard rather than a formality — and it runs before the
  // comparison for that reason, not after it.
  if (expected.length === 0) return false;
  const actual = await scryptAsync(password, Buffer.from(saltHex, 'hex'), expected.length);
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
    private readonly store: AccountsStore,
    deps: AuthServiceDeps = {},
  ) {
    this.nowMs = deps.nowMs ?? (() => Date.now());
    this.newAccountId = deps.newAccountId ?? (() => randomUUID());
    this.newToken = deps.newToken ?? (() => randomBytes(32).toString('hex'));
  }

  async register(username: unknown, password: unknown): Promise<AuthResult> {
    const usernameError = validateUsername(username);
    if (usernameError) return { error: usernameError };
    const passwordError = validatePassword(password);
    if (passwordError) return { error: passwordError };
    const name = username as string;

    // Usernames are case-insensitively unique — 'Alice' and 'alice' being two distinct
    // accounts is a real impersonation/confusion footgun, not a useful feature. That rule
    // is `accounts_username_ci`'s to enforce, not this method's to check: see the class
    // header on why the old look-before-write could not survive becoming asynchronous.
    const accountId = this.newAccountId();
    try {
      await this.store.accounts.insertOne({
        _id: accountId,
        username: name,
        passwordHash: await hashPassword(password as string),
        provider: 'local',
        createdAt: this.nowMs(),
      });
    } catch (e) {
      // The name was taken — either long ago, or by a request still in flight. Both answer
      // the caller the same way, which is the point of not distinguishing them.
      if (isDuplicateKey(e)) return { error: 'username already taken' };
      throw e;
    }

    return this.issueSession(accountId, name);
  }

  async login(username: unknown, password: unknown): Promise<AuthResult> {
    if (typeof username !== 'string' || typeof password !== 'string') return { error: 'invalid username or password' };
    // The case-folding index means 'Alice'/'alice' are one account for login purposes, so the
    // lockout key must fold case the same way or the two spellings would get separate
    // attempt budgets — normalized once here, reused for every read/write below.
    const key = username.toLowerCase();
    const now = this.nowMs();
    const attempt = this.loginAttempts.get(key);
    if (attempt && attempt.lockedUntil > now) {
      return { error: 'too many failed login attempts — try again later' };
    }

    // `provider` is read and checked below rather than folded into the filter on purpose: a
    // federated account must be indistinguishable, from the outside, from a username that
    // does not exist — filtering it out here and letting the generic "invalid username or
    // password" answer cover it is what makes the two identical. `displayName` falls back to
    // `username` for a local row, which is every row this path can reach.
    //
    // CI_COLLATION is not optional decoration: without it this query silently stops folding
    // case AND stops using `accounts_username_ci`, so a player who registered as 'Alice'
    // could never log in as 'alice'. See its doc comment in db.ts.
    const row = await this.store.accounts.findOne({ username }, { collation: CI_COLLATION });
    if (!row || row.provider !== 'local' || !(await verifyPassword(password, row.passwordHash))) {
      // Reaching here means any prior lockout already expired (a still-active one
      // returned above), so the streak simply continues from wherever it left off.
      const count = (attempt?.count ?? 0) + 1;
      const lockedUntil = count >= MAX_LOGIN_ATTEMPTS ? now + LOGIN_LOCKOUT_MS : 0;
      this.loginAttempts.set(key, { count, lockedUntil });
      return { error: 'invalid username or password' };
    }

    this.loginAttempts.delete(key);
    return this.issueSession(row._id, row.displayName ?? row.username);
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
  async loginWithProvider(opts: { provider: string; providerId: string; displayName: string }): Promise<AuthSuccess> {
    const { provider, providerId } = opts;
    const displayName = opts.displayName.slice(0, MAX_DISPLAY_NAME);
    const existing = await this.findProviderAccount(provider, providerId);
    if (existing) {
      // The provider is authoritative over the name, every time — a player who renames on
      // the portal must not still be shown to other players under their old name.
      if (existing.displayName !== displayName) {
        await this.store.accounts.updateOne({ _id: existing.id }, { $set: { displayName } });
      }
      return this.issueSession(existing.id, displayName);
    }

    const accountId = this.newAccountId();
    try {
      await this.store.accounts.insertOne({
        _id: accountId,
        username: `${provider}:${providerId}`,
        passwordHash: NO_PASSWORD,
        provider,
        providerId,
        createdAt: this.nowMs(),
        displayName,
      });
    } catch (e) {
      // Lost the race on `accounts_provider_id` (or on `accounts_username_ci`, since the
      // handle is derived from the same two values). The winner's document is the account;
      // ours was never created. Anything that is NOT a lost race propagates — swallowing a
      // write error here would report a session for an account that does not exist.
      if (!isDuplicateKey(e)) throw e;
      const winner = await this.findProviderAccount(provider, providerId);
      if (!winner) throw new Error('provider account insert failed');
      return this.issueSession(winner.id, winner.displayName);
    }
    return this.issueSession(accountId, displayName);
  }

  private async findProviderAccount(
    provider: string,
    providerId: string,
  ): Promise<{ id: string; displayName: string } | undefined> {
    const row = await this.store.accounts.findOne({ provider, providerId });
    if (!row) return undefined;
    return { id: row._id, displayName: row.displayName ?? row.username };
  }

  async logout(token: string): Promise<void> {
    await this.store.sessions.deleteOne({ _id: token });
  }

  /** `null` on an unknown, expired, or malformed token — the caller maps that to a 401. */
  async verifySession(token: unknown): Promise<{ accountId: string; username: string } | null> {
    if (typeof token !== 'string' || !token) return null;
    // One round trip, not two. The SQL this replaces was a JOIN, and the note on
    // `issueSession` about keeping an authenticated request to a single indexed lookup is
    // the reason this is a `$lookup` rather than the two `findOne`s that read more easily:
    // this runs on every authenticated request. The account is looked up by `_id`, so the
    // join side is a primary-key hit.
    //
    // The name is resolved LIVE rather than copied onto the session at issue time, which is
    // what the JOIN bought: a portal player who renames must not keep appearing to others
    // under the old name for the 30 days their session lasts.
    const [row] = await this.store.sessions
      .aggregate<{ accountId: string; expiresAt: number; username?: string; displayName?: string }>([
        { $match: { _id: token } },
        { $lookup: { from: 'accounts', localField: 'accountId', foreignField: '_id', as: 'account' } },
        { $unwind: '$account' },
        {
          $project: {
            accountId: 1,
            expiresAt: 1,
            username: '$account.username',
            displayName: '$account.displayName',
          },
        },
      ])
      .toArray();
    if (!row) return null;
    if (row.expiresAt < this.nowMs()) {
      await this.store.sessions.deleteOne({ _id: token });
      return null;
    }
    return { accountId: row.accountId, username: row.displayName ?? row.username ?? '' };
  }

  /**
   * Change a local account's password, and **revoke every other session it has** (the
   * `keepToken` half, 2026-09-17).
   *
   * Until that date this method wrote a new hash and stopped there, so a session minted
   * before the change kept working for the rest of its 30 days. That is the wrong answer to
   * the reason people change a password: "somebody else is in my account" is the case this
   * screen exists for, and a password change that leaves the intruder's bearer token live
   * answers the one question it was asked with "no".
   *
   * `keepToken` is the caller's OWN session — `routes/auth.ts` has it, because
   * `/auth/change-password` carries the token in its body — and it is spared so the player
   * who just changed their password is not immediately signed out of the device they did it
   * on. Every other token for the account dies. Omitting `keepToken` revokes all of them,
   * which is the safe direction for any future caller that has no session in hand.
   *
   * The revocation runs only on the success path, after the write. A failed attempt must
   * leave sessions alone, or a wrong-password guess becomes a way to sign a player out.
   */
  async changePassword(
    accountId: string,
    oldPassword: unknown,
    newPassword: unknown,
    keepToken?: string,
  ): Promise<{ ok: true } | AuthFailure> {
    const row = await this.store.accounts.findOne({ _id: accountId }, { projection: { passwordHash: 1 } });
    // A federated account has no password to change, and no way to acquire one — saying so
    // is safe (the caller already proved they hold this account's session) and is the only
    // answer that is not a lie. `verifyPassword` would refuse it anyway; this is the
    // difference between refusing and refusing for a reason the caller can act on.
    if (row?.passwordHash === NO_PASSWORD) {
      return { error: 'this account signs in through its platform and has no password' };
    }
    if (!row || typeof oldPassword !== 'string' || !(await verifyPassword(oldPassword, row.passwordHash))) {
      return { error: 'invalid current password' };
    }
    const passwordError = validatePassword(newPassword);
    if (passwordError) return { error: passwordError };
    await this.store.accounts.updateOne(
      { _id: accountId },
      { $set: { passwordHash: await hashPassword(newPassword as string) } },
    );
    // Two filter shapes rather than one with `$ne: keepToken` in it: the driver serializes
    // an `undefined` value to `null`, so the one-shape version would quietly become
    // `_id: { $ne: null }` and mean "all of them" by accident rather than on purpose. It
    // happens to be the behaviour wanted here, which is exactly what makes it worth not
    // depending on.
    await this.store.sessions.deleteMany(
      keepToken === undefined ? { accountId } : { accountId, _id: { $ne: keepToken } },
    );
    return { ok: true };
  }

  private async issueSession(accountId: string, username: string): Promise<AuthSuccess> {
    // Opportunistic sweep, not a background timer: this project's "no process the
    // team doesn't need yet" convention (see rating.ts/AuthService's own doc notes) —
    // a login/register is exactly as frequent as new rows get added, so sweeping here
    // keeps the table from growing unbounded without a setInterval this class would
    // otherwise be the only thing owning. verifySession (the hot per-request read
    // path) deliberately does NOT sweep here — only the one expired row it already
    // looks at, to keep every authenticated request to a single indexed lookup.
    await this.sweepExpiredSessions();
    const token = this.newToken();
    const expiresAt = this.nowMs() + SESSION_TTL_MS;
    await this.store.sessions.insertOne({ _id: token, accountId, expiresAt });
    return { accountId, username, token };
  }

  private async sweepExpiredSessions(): Promise<void> {
    await this.store.sessions.deleteMany({ expiresAt: { $lt: this.nowMs() } });
  }
}
