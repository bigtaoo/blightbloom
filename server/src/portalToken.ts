/**
 * CrazyGames user-token verification (design/20 "account integration") — the portal's
 * answer to "who is this player", and the only inbound identity claim this server accepts
 * that it did not mint itself.
 *
 * The portal's SDK hands the CLIENT a short-lived RS256 JWT (`user.getUserToken()`), and
 * its documentation is explicit that the client must not decode it. So this module is the
 * trust boundary: `routes/auth.ts`'s `/auth/portal` takes that token, verifies the
 * signature against CrazyGames' published RSA public key, and only then does
 * `AuthService.loginWithProvider` mint one of OUR sessions.
 *
 * Three deliberate choices, each mirroring one this repository already made:
 *
 * - **No JWT library.** `node:crypto` verifies RS256 in four lines, and `ticket.ts` set the
 *   precedent for hand-rolling the compact-JWT shape rather than taking a dependency.
 * - **`alg` is checked, never negotiated.** `ticket.ts`'s header calls the JWT algorithm
 *   negotiation a footgun and fixes its own algorithm for that reason; here the algorithm
 *   arrives in attacker-controlled bytes, so the check is explicit — anything but `RS256`
 *   is rejected before the key is touched. That closes both classic confusions (`none`,
 *   and an HS256 token signed with the public key as the HMAC secret).
 * - **Pure of env and I/O.** The key, the clock and the expected game id are passed in, the
 *   same way `ticket.ts` takes its secret — so a test needs no network and no configuration.
 *   Fetching and caching the key is `portalKeys.ts`'s job.
 */
import { createPublicKey, verify as verifySignature } from 'node:crypto';

/**
 * The claims CrazyGames documents in a user token. `userId` is the stable per-user id this
 * server keys an account on (`accounts.provider_id`); `username` is the display name the
 * platform requires a game to show (`docs.crazygames.com/requirements/multiplayer`), and it
 * is NOT a login handle — see `AuthService.loginWithProvider` for why the two are separate
 * columns.
 */
export interface PortalTokenClaims {
  userId: string;
  gameId: string;
  username: string;
  profilePictureUrl?: string;
  /** Epoch SECONDS, per the JWT spec — not this project's usual epoch-ms. */
  exp: number;
  iat?: number;
}

export interface VerifyPortalTokenOptions {
  /**
   * Reject a token minted for a different game. Optional because the id is only knowable
   * once the game is registered on the portal (`DDU_CG_GAME_ID`), and a first upload has to
   * be able to work before it is known — but a token is a bearer credential that any other
   * CrazyGames game could also obtain for the same user, so leaving this unset means
   * trusting every game on the platform to hold OUR players' tokens honestly. Set it.
   */
  gameId?: string;
  /**
   * Clock skew allowance, seconds. A token lives one hour; a small allowance keeps a
   * player whose device clock runs fast from being unable to log in at all.
   */
  leewaySec?: number;
}

const DEFAULT_LEEWAY_SEC = 60;

function decodeSegment(segment: string): unknown {
  try {
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

/**
 * Verify a portal user token. Returns its claims, or `null` for every failure — a bad
 * signature, a wrong algorithm, an expired token, a token for another game and a malformed
 * string are all indistinguishable to the caller, which is `verifyTicket`'s own posture and
 * for the same reason: the caller's only correct response to any of them is to refuse.
 */
export function verifyPortalToken(
  token: unknown,
  publicKeyPem: string,
  nowMs: number,
  opts: VerifyPortalTokenOptions = {},
): PortalTokenClaims | null {
  if (!isNonEmptyString(token)) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts as [string, string, string];
  if (!headerB64 || !payloadB64 || !sigB64) return null;

  // The algorithm check comes FIRST, before the key is even parsed: an `alg` of `none`
  // carries no signature to verify, and an `alg` of `HS256` would invite verifying an
  // HMAC computed with this public key — which is public — as if it were a signature.
  const header = decodeSegment(headerB64) as { alg?: unknown; typ?: unknown } | null;
  if (!header || header.alg !== 'RS256') return null;

  let key;
  try {
    key = createPublicKey(publicKeyPem);
  } catch {
    return null; // a corrupt/truncated key document is a refusal, never a crash
  }

  let signatureOk = false;
  try {
    signatureOk = verifySignature(
      'sha256',
      Buffer.from(`${headerB64}.${payloadB64}`, 'utf8'),
      key,
      Buffer.from(sigB64, 'base64url'),
    );
  } catch {
    return null;
  }
  if (!signatureOk) return null;

  const claims = decodeSegment(payloadB64) as Partial<PortalTokenClaims> | null;
  if (!claims || typeof claims !== 'object') return null;
  if (!isNonEmptyString(claims.userId) || !isNonEmptyString(claims.username)) return null;
  if (!isNonEmptyString(claims.gameId)) return null;
  if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp)) return null;

  const leeway = opts.leewaySec ?? DEFAULT_LEEWAY_SEC;
  if (claims.exp + leeway < Math.floor(nowMs / 1000)) return null;
  if (opts.gameId !== undefined && claims.gameId !== opts.gameId) return null;

  return {
    userId: claims.userId,
    gameId: claims.gameId,
    username: claims.username,
    profilePictureUrl: isNonEmptyString(claims.profilePictureUrl) ? claims.profilePictureUrl : undefined,
    exp: claims.exp,
    iat: typeof claims.iat === 'number' ? claims.iat : undefined,
  };
}
