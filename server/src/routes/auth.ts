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
import { RateLimiter, clientKey } from '../rateLimit';
import { readJsonBody, send, type RouteHandler } from './http';

/** The provider name written to `accounts.provider` for a CrazyGames identity, and the
 *  prefix of the derived login handle. One constant so the row, the handle and any future
 *  lookup cannot drift apart. */
export const PROVIDER_CRAZYGAMES = 'cg';

/**
 * The per-IP budget for ACCOUNT CREATION (2026-09-17). Thirty in ten minutes.
 *
 * `/auth/register` was the one route in this server that was both unbounded and expensive:
 * every call mints a row and pays a full scrypt hash for it, and nothing anywhere — not
 * here, not in Caddy — put a ceiling on how many a single caller could ask for. The two
 * halves of that were fixed together: `AuthService`'s hash moved off the event loop, and
 * this bounds the flood that made the blocking matter.
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
export const REGISTER_RATE_LIMIT = { requests: 30, windowMs: 10 * 60_000 } as const;

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
 * `postRegister`'s own deps — the only handler in this group that rate-limits, so the
 * limiter is declared here rather than on `AuthRouteDeps`. That follows the rule
 * `matchsvc.ts` states over its shared bundle: a handler declares, and can only reach, the
 * few dependencies it names. The bundle satisfies both interfaces; `/auth/me` still cannot
 * see a limiter.
 */
export interface RegisterRouteDeps extends AuthRouteDeps {
  /**
   * The account-creation budget ({@link REGISTER_RATE_LIMIT}). Its OWN instance, never the
   * telemetry limiter from the same bundle: sharing one counter would let a chatty client's
   * log batches spend the budget its registration needs, and would make either route's limit
   * depend on how talkative the other one happens to be.
   *
   * Required rather than optional because an absent limiter can only mean "no limit", and a
   * working way to be exempt is an invitation to use it — the same reasoning the coverage
   * gate's no-exemption rule is written down with.
   */
  authLimiter: RateLimiter;
  /** Injected so a test can drive the window without sleeping. Defaults to the wall clock. */
  nowMs?: () => number;
}

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
  if (!deps.authLimiter.take(clientKey(req), (deps.nowMs ?? Date.now)())) {
    return send(res, 429, { error: 'too many accounts created from this address — try again later' });
  }
  const body = await readJsonBody(req);
  const { username, password } = (body as { username?: unknown; password?: unknown }) ?? {};
  const result = await deps.auth.register(username, password);
  send(res, 'error' in result ? 400 : 200, result);
};

export const postLogin: RouteHandler<AuthRouteDeps> = async (req, res, _url, deps) => {
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
export const postPortalLogin: RouteHandler<AuthRouteDeps> = async (req, res, _url, deps) => {
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

export const postChangePassword: RouteHandler<AuthRouteDeps> = async (req, res, _url, deps) => {
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
