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
import { readJson, send, type RouteHandler } from './http';

/** The provider name written to `accounts.provider` for a CrazyGames identity, and the
 *  prefix of the derived login handle. One constant so the row, the handle and any future
 *  lookup cannot drift apart. */
export const PROVIDER_CRAZYGAMES = 'cg';

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

/** Parses `Authorization: Bearer <token>` and resolves it to a live session, or `null`. */
export function requireAuth(req: IncomingMessage, auth: AuthService): { accountId: string; username: string } | null {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return null;
  return auth.verifySession(header.slice('Bearer '.length));
}

export const postRegister: RouteHandler<AuthRouteDeps> = (req, res, _url, deps) => {
  readJson(req, (body) => {
    const { username, password } = (body as { username?: unknown; password?: unknown }) ?? {};
    const result = deps.auth.register(username, password);
    send(res, 'error' in result ? 400 : 200, result);
  });
};

export const postLogin: RouteHandler<AuthRouteDeps> = (req, res, _url, deps) => {
  readJson(req, (body) => {
    const { username, password } = (body as { username?: unknown; password?: unknown }) ?? {};
    const result = deps.auth.login(username, password);
    send(res, 'error' in result ? 401 : 200, result);
  });
};

export const postLogout: RouteHandler<AuthRouteDeps> = (req, res, _url, deps) => {
  readJson(req, (body) => {
    const token = (body as { token?: unknown })?.token;
    if (typeof token === 'string') deps.auth.logout(token);
    send(res, 200, { ok: true });
  });
};

export const getMe: RouteHandler<AuthRouteDeps> = (req, res, _url, deps) => {
  const session = requireAuth(req, deps.auth);
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
export const postPortalLogin: RouteHandler<AuthRouteDeps> = (req, res, _url, deps) => {
  readJson(req, (body) => {
    void (async () => {
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
      const result = deps.auth.loginWithProvider({
        provider: PROVIDER_CRAZYGAMES,
        providerId: claims.userId,
        displayName: claims.username,
      });
      send(res, 200, result);
    })();
  });
};

export const postChangePassword: RouteHandler<AuthRouteDeps> = (req, res, _url, deps) => {
  readJson(req, (body) => {
    const { token, oldPassword, newPassword } =
      (body as { token?: unknown; oldPassword?: unknown; newPassword?: unknown }) ?? {};
    const session = deps.auth.verifySession(token);
    if (!session) return send(res, 401, { error: 'invalid or expired session' });
    const result = deps.auth.changePassword(session.accountId, oldPassword, newPassword);
    send(res, 'error' in result ? 400 : 200, result);
  });
};
