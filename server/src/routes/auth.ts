/**
 * Split of `matchsvc.ts` (P0, 2026-09-04, prep for ROADMAP Phase 8) — the `/auth/*` route
 * group (design/16-accounts.md): register, login, logout, session lookup, password change.
 * Also owns `requireAuth`, the `Authorization: Bearer <token>` reader, because that header
 * is the account layer's trust boundary and every other group that needs it (currently
 * `routes/account.ts`) is a sibling that may import it from here.
 */
import type { IncomingMessage } from 'node:http';
import type { AuthService } from '../AuthService';
import type { PortalKeyStore } from '../portalKeys';
import { verifyPortalToken } from '../portalToken';
import type { Budget } from '../rateLimit';
import { spendBudget, type BudgetDeps } from './limits';
import { readJsonBody, send, type RouteHandler } from './http';

/** The provider name written to `accounts.provider` for a CrazyGames identity, and the
 *  prefix of the derived login handle. One constant so the row, the handle and any future
 *  lookup cannot drift apart. */
export const PROVIDER_CRAZYGAMES = 'cg';

/**
 * The per-IP budget for ACCOUNT CREATION (2026-09-17). Thirty in ten minutes.
 *
 * `/auth/register` was the FIRST route in this server found to be both unbounded and
 * expensive: every call mints a row and pays a full scrypt hash for it, and nothing anywhere
 * — not here, not in Caddy — put a ceiling on how many a single caller could ask for. The two
 * halves of that were fixed together: `AuthService`'s hash moved off the event loop, and this
 * bounds the flood that made the blocking matter.
 *
 * "The one route" is what this paragraph said until 2026-09-22, and it was wrong in a way
 * worth leaving visible: {@link LOGIN_RATE_LIMIT} below pays the same hash on every attempt
 * against an account that exists, and five more routes in this process were minting state for
 * a caller who had proved nothing. What made register the one that got looked at was that its
 * cost was VISIBLE — the hash was on the event loop, so a burst froze everything.
 *
 * Deliberately far looser than adminsvc's ten-in-five-minutes login budget, and for the
 * opposite reason. There the legitimate rate is one a day and a false positive inconveniences
 * an operator who can wait; here a false positive is a real player who cannot make an
 * account, and a carrier-grade NAT can put a whole city behind one address. Thirty accounts
 * per ten minutes is far above anything a human does and low enough to keep a single source's
 * hashing cost near a tenth of a second per minute.
 *
 * It bounds ONE caller, which is the honest description: a spread-out flood from many
 * addresses walks around any per-IP limit, and this file is not the place that would answer
 * that.
 */
export const REGISTER_RATE_LIMIT: Budget = { requests: 30, windowMs: 10 * 60_000 };

/**
 * The per-IP budget for LOGIN (2026-09-22). Sixty in ten minutes.
 *
 * `AuthService.login` has had a per-USERNAME lockout since 2026-08-03 — five consecutive
 * failures and that name is refused for fifteen minutes, without a password check, so the
 * lockout cannot itself be used to test a guess. That is the defence against guessing one
 * account's password and this budget does not replace it. It replaces nothing; it covers the
 * three things a per-username counter structurally cannot see:
 *
 * - **Credential stuffing.** One guess each against ten thousand usernames never reaches any
 *   single name's fifth failure. The lockout is per name, and the attack is per list.
 * - **The hash.** A login against an account that EXISTS pays a full scrypt (~50-100ms of
 *   deliberate CPU on the threadpool) before it can fail. Unbounded, that turns one cheap
 *   request into the most expensive work this process does, five times per username on a
 *   list as long as the attacker likes.
 * - **Enumeration.** A username that does not exist returns before any hashing, so the
 *   response time answers "does this name exist" — and unbounded, that is a dictionary walk
 *   over the whole `accounts` collection, which is the list the first two items need.
 *
 * Twice {@link REGISTER_RATE_LIMIT}, because logging in is the more frequent legitimate act:
 * a player registers once and logs in again on every new device, every cleared browser and
 * every expired 30-day session. A human logs in once, or three times with a typo; sixty
 * leaves room for a household, a LAN party and a small NAT, and still costs a stuffing run
 * everything. Half of `routes/party.ts`'s `JOIN_RATE_LIMIT` because a refused login is at
 * least an action the player chose to take, where a refused join is a player locked out of a
 * squad they were invited into.
 */
export const LOGIN_RATE_LIMIT: Budget = { requests: 60, windowMs: 10 * 60_000 };

/**
 * The per-IP budget for PORTAL LOGIN (2026-09-22). A hundred and twenty in ten minutes.
 *
 * Forgery is not what this defends: `postPortalLogin` verifies an RS256 signature against
 * CrazyGames' key and refuses anything else, so a caller who is not the portal gets a 401 and
 * nothing more. What was unbounded is the VERIFY — a public-key operation, on the event loop,
 * on a string any caller may POST — and, behind it, the one account-creation path
 * {@link REGISTER_RATE_LIMIT} never covered: `loginWithProvider` registers an identity on
 * first sight, so a portal token is a route to a new row that `/auth/register`'s budget does
 * not watch.
 *
 * The loosest budget in this file, and the reason is that no human decides to spend it. The
 * client calls this at BOOT, once per page load, for every player on a portal build — an
 * audience that arrives through a handful of carrier NATs. And a refusal here is SILENT:
 * `platform/crazygames/portalAuth.ts` treats every throw as "stay a guest", so the false
 * positive is a player quietly demoted to a guest seat with no message and no way to ask why.
 * An invisible false positive is an argument for headroom, not for precision.
 */
export const PORTAL_RATE_LIMIT: Budget = { requests: 120, windowMs: 10 * 60_000 };

/**
 * The per-IP budget for PASSWORD CHANGE (2026-09-22). Twenty in ten minutes.
 *
 * The one limited route here that a session already gates, so it is not reachable by an
 * anonymous flood — but a session costs one registration, and this is the most expensive
 * single request in the process: TWO scrypt hashes, one to verify the old password and one to
 * store the new one, where every other authenticated route is an indexed read.
 *
 * Twenty is far above anything a human does with a password and keeps one address's hashing
 * cost near the same tenth of a second per minute {@link REGISTER_RATE_LIMIT} was sized for.
 * It is the tightest number in this file because it is the only one whose false positive is a
 * player who can already play, already logged in, being told to try again in a few minutes.
 */
export const CHANGE_PASSWORD_RATE_LIMIT: Budget = { requests: 20, windowMs: 10 * 60_000 };

export interface PortalAuthDeps {
  /** Where the verification key comes from. Injected so a test needs no network. */
  keys: PortalKeyStore;
  /** The expected `gameId` claim, or `undefined` to skip that check — see `config.portalGameId`. */
  gameId?: string;
  nowMs?: () => number;
}

export interface AuthRouteDeps {
  auth: AuthService;
  /** Absent only where the caller built this server without portal support (older tests,
   *  and any embedder that has no portal build) — `/auth/portal` then answers 503 rather
   *  than pretending to verify. `matchsvc.ts` always supplies it. */
  portal?: PortalAuthDeps;
}

/**
 * The four limited handlers' own deps. Each names ONE key of `Limiters`, and `BudgetDeps`
 * hands it a `Pick` of exactly that key — so `getMe` and `postLogout` still cannot see a
 * limiter, and `postLogin` cannot spend registration's. `routes/limits.ts` argues why the
 * budgets live in one bundle and why they are nonetheless four separate counters.
 *
 * Required rather than optional because an absent limiter can only mean "no limit", and a
 * working way to be exempt is an invitation to use it — the same reasoning the coverage
 * gate's no-exemption rule is written down with.
 */
export interface RegisterRouteDeps extends AuthRouteDeps, BudgetDeps<'register'> {}
export interface LoginRouteDeps extends AuthRouteDeps, BudgetDeps<'login'> {}
export interface PortalRouteDeps extends AuthRouteDeps, BudgetDeps<'portalLogin'> {}
export interface ChangePasswordRouteDeps extends AuthRouteDeps, BudgetDeps<'changePassword'> {}

/** Parses `Authorization: Bearer <token>` and resolves it to a live session, or `null`. */
export function requireAuth(
  req: IncomingMessage,
  auth: AuthService,
): Promise<{ accountId: string; username: string } | null> {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return Promise.resolve(null);
  return auth.verifySession(header.slice('Bearer '.length));
}

export const postRegister: RouteHandler<RegisterRouteDeps> = async (req, res, _url, deps) => {
  // The budget is spent BEFORE the body is awaited, exactly as adminsvc's login does it and
  // for the reason written there: a flood's next request arrives while this one is parked on
  // its body, so a limiter taken afterwards is a limiter the flood has already walked past.
  if (!spendBudget(deps.limits.register, req, res, (deps.nowMs ?? Date.now)(), 'too many accounts created from this address — try again later')) {
    return;
  }
  const body = await readJsonBody(req);
  const { username, password } = (body as { username?: unknown; password?: unknown }) ?? {};
  const result = await deps.auth.register(username, password);
  send(res, 'error' in result ? 400 : 200, result);
};

export const postLogin: RouteHandler<LoginRouteDeps> = async (req, res, _url, deps) => {
  // Before the body, like every budget in this server (`spendBudget` says why). Which charges
  // a SUCCESSFUL login too — and here that is the honest shape rather than a cost, because
  // the attack this bounds is indistinguishable from a successful login until the password is
  // checked, and checking the password is the expensive half ({@link LOGIN_RATE_LIMIT}).
  if (!spendBudget(deps.limits.login, req, res, (deps.nowMs ?? Date.now)(), 'too many login attempts from this address — try again later')) {
    return;
  }
  const body = await readJsonBody(req);
  const { username, password } = (body as { username?: unknown; password?: unknown }) ?? {};
  const result = await deps.auth.login(username, password);
  send(res, 'error' in result ? 401 : 200, result);
};

export const postLogout: RouteHandler<AuthRouteDeps> = async (req, res, _url, deps) => {
  const body = await readJsonBody(req);
  const token = (body as { token?: unknown })?.token;
  if (typeof token === 'string') await deps.auth.logout(token);
  send(res, 200, { ok: true });
};

export const getMe: RouteHandler<AuthRouteDeps> = async (req, res, _url, deps) => {
  const session = await requireAuth(req, deps.auth);
  if (!session) return send(res, 401, { error: 'invalid or expired session' });
  send(res, 200, session);
};

/**
 * `POST /auth/portal { token }` → the same `{accountId, username, token}` every other login
 * route returns, so nothing downstream (`net/session.ts`, `/account/meta`, the match ticket)
 * knows this session was minted differently.
 *
 * This is the route the CrazyGames requirement "new logged in CrazyGames users are
 * automatically registered & logged in within your game" is satisfied by — the client calls
 * it at boot with `SDK.user.getUserToken()` and the player never sees a form. It is also the
 * only route in this server that accepts an identity claim signed by someone else, so the
 * order here matters and is worth reading as an order: verify the signature, THEN mint.
 *
 * `token` is the PORTAL's token (RS256, one hour, minted by CrazyGames) and the `token` in
 * the response is OURS (opaque, 30 days, `sessions` table). They are never interchangeable
 * and only one of them is ever a bearer credential for this server.
 */
export const postPortalLogin: RouteHandler<PortalRouteDeps> = async (req, res, _url, deps) => {
  // Before the body, and before the signature check, which is the ordering the budget exists
  // for: verifying is the work, so a limiter taken after it has already paid for the request
  // it is about to refuse ({@link PORTAL_RATE_LIMIT}).
  if (!spendBudget(deps.limits.portalLogin, req, res, (deps.nowMs ?? Date.now)(), 'too many portal logins from this address — try again later')) {
    return;
  }
  // Was a `void (async () => { ... })()` inside `readJson`'s callback — a detached promise
  // whose rejection reached nothing. It is a plain `await` now, so a failure here becomes
  // matchsvc's 500 instead of an unhandled rejection.
  const body = await readJsonBody(req);
  const portal = deps.portal;
  if (!portal) return send(res, 503, { error: 'portal login is not configured on this server' });
  const token = (body as { token?: unknown })?.token;
  const pem = await portal.keys.key();
  // No key means we cannot verify, and cannot verify means refuse. 503 rather than 401
  // because the failure is ours, not the player's — an adblock-style silent guest
  // fallback on the client is the right response to it, and a 401 would tell the client
  // the player's token was bad.
  if (!pem) return send(res, 503, { error: 'portal verification key unavailable' });
  const claims = verifyPortalToken(token, pem, (portal.nowMs ?? Date.now)(), { gameId: portal.gameId });
  if (!claims) return send(res, 401, { error: 'invalid portal token' });
  const result = await deps.auth.loginWithProvider({
    provider: PROVIDER_CRAZYGAMES,
    providerId: claims.userId,
    displayName: claims.username,
  });
  send(res, 200, result);
};

export const postChangePassword: RouteHandler<ChangePasswordRouteDeps> = async (req, res, _url, deps) => {
  // Session-gated below, budgeted here, and in that order on purpose: the session check is a
  // database read the caller can make us do for free, while the budget is the thing that
  // stops the two scrypt hashes behind it ({@link CHANGE_PASSWORD_RATE_LIMIT}).
  if (!spendBudget(deps.limits.changePassword, req, res, (deps.nowMs ?? Date.now)(), 'too many password changes from this address — try again later')) {
    return;
  }
  const body = await readJsonBody(req);
  const { token, oldPassword, newPassword } =
    (body as { token?: unknown; oldPassword?: unknown; newPassword?: unknown }) ?? {};
  const session = await deps.auth.verifySession(token);
  if (!session) return send(res, 401, { error: 'invalid or expired session' });
  // The caller's own token is handed down so a successful change revokes this account's
  // OTHER sessions and not this one — see `AuthService.changePassword`. `verifySession`
  // just proved it is a live token for this account, so it is safe to spare; nothing else
  // in the request is.
  const result = await deps.auth.changePassword(session.accountId, oldPassword, newPassword, token as string);
  send(res, 'error' in result ? 400 : 200, result);
};
