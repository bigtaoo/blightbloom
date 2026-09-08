/**
 * Match tickets (ROADMAP 3.3, design/06) — the tamper-proof handshake the matchmaking
 * control plane issues and the gameserver verifies. A ticket is the signed statement
 * "this client may take seat `owner` in room `roomId`, which runs `seed`/`playerCount`,
 * until `exp`". It closes the spoofing hole the raw-param handshake left open (a client
 * could claim any seat/seed): the gameserver now derives those values from a VERIFIED
 * ticket instead of trusting query params.
 *
 * Stateless HMAC-SHA256 — the matchsvc and the gameserver share only a secret, never a
 * store (mirrors funny's matchsvc "signs these params"). Format: `b64url(json).b64url(sig)`,
 * the compact JWT-shape without the algorithm-negotiation footguns (the algorithm is fixed).
 *
 * Pure of any env/global: the secret and the clock are passed in, so it is unit-testable
 * without configuration and either side (svc/server) wires its own secret.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { MatchMode } from '@dd/engine';

export type { MatchMode };

/** The signed seat grant. `exp` is an absolute epoch-ms deadline (verify rejects past it).
 * `teamId` (design/05/15's PvP squad follow-up) groups seats into a squad — every
 * seat gets one, always: a solo/FFA seat is simply the sole member of its own team
 * (`Matchmaker`'s `teamIdForOwner` collapses to `owner` whenever squads don't apply),
 * so this is never optional the way `mode` is. `accountId` (design/16-accounts.md) is
 * the logged-in player's real account id, threaded from `POST /find` through to the
 * gameserver so a settled PvP match's ladder report can credit the real account instead
 * of `ladderReport.ts`'s `seat:{roomId}:{seatIdx}` scaffold. Absent for guests/bots —
 * every pre-account caller is unaffected. */
export interface TicketPayload {
  roomId: string;
  owner: number;
  seed: number;
  playerCount: number;
  teamId: number;
  exp: number;
  mode?: MatchMode;
  accountId?: string;
  /**
   * The display name to show other players for this seat (design/20 — a game portal
   * requires the platform's own username be shown in-game).
   *
   * It rides in the SIGNED ticket rather than in the client's `join` message for the same
   * reason `owner`/`seed` do: a value the client declares is a value the client chooses. A
   * name is the one field here that other players SEE, so a self-declared one is an
   * impersonation primitive — matchsvc reads it from the bearer session it just verified
   * (`routes/match.ts`) and signs it, and the gameserver only ever trusts what it can
   * verify. Absent for guests and bots, which is most seats.
   */
  name?: string;
}

const b64urlEncode = (s: string): string =>
  Buffer.from(s, 'utf8').toString('base64url');
const b64urlDecode = (s: string): string =>
  Buffer.from(s, 'base64url').toString('utf8');

const sign = (body: string, secret: string): string =>
  createHmac('sha256', secret).update(body).digest('base64url');

/** Sign a payload into a `body.sig` token. The caller sets `exp` (svc uses now + TTL). */
export function signTicket(payload: TicketPayload, secret: string): string {
  const body = b64urlEncode(JSON.stringify(payload));
  return `${body}.${sign(body, secret)}`;
}

/**
 * Verify a token against `secret` at `nowMs`. Returns the payload only if the signature
 * matches (constant-time) AND it has not expired; otherwise `null` — a bad signature,
 * a tampered body, a malformed token, and an expired-but-valid ticket are indistinguishable
 * to the caller (all "reject and close"), which is the posture we want.
 *
 * `ignoreExpiry` (matchsvc's `/resume` reissue endpoint only, ROADMAP reconnect) skips
 * the `exp` check while still requiring a valid signature — proof the caller once
 * legitimately held this exact seat grant, even though a match runs far longer than a
 * ticket's short TTL. Every other caller (the gameserver handshake) always leaves this
 * off, so a stale ticket still can't open a fresh connection.
 */
export function verifyTicket(
  token: string,
  secret: string,
  nowMs: number,
  opts: { ignoreExpiry?: boolean } = {},
): TicketPayload | null {
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  const expected = sign(body, secret);
  // timingSafeEqual throws on length mismatch — guard first so a wrong-length sig is a
  // plain reject, not an exception.
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let payload: TicketPayload;
  try {
    payload = JSON.parse(b64urlDecode(body)) as TicketPayload;
  } catch {
    return null;
  }
  // `JSON.parse('null')` succeeds and yields `null`, which the try above cannot catch — so
  // without this line the very next property read THROWS, out of a function whose documented
  // contract (see this doc comment's "all reject and close") is that every malformed token
  // returns null. Both call sites are request handlers: the gameserver's `connection`
  // listener and matchsvc's `/resume`. Found 2026-09-03 by the shape sweep in
  // `ticket.test.ts`; a signed `null` body needs the real secret, so this is an issuer bug
  // rather than a forgery, but the crash would be the whole process either way.
  if (payload === null || typeof payload !== 'object') return null;
  if (
    typeof payload.roomId !== 'string' ||
    !Number.isInteger(payload.owner) ||
    !Number.isInteger(payload.seed) ||
    !Number.isInteger(payload.playerCount) ||
    !Number.isInteger(payload.teamId) ||
    typeof payload.exp !== 'number' ||
    (payload.mode !== undefined && payload.mode !== 'coop' && payload.mode !== 'pvp') ||
    (payload.accountId !== undefined && typeof payload.accountId !== 'string')
  ) {
    return null;
  }
  if (!opts.ignoreExpiry && nowMs > payload.exp) return null; // expired
  return payload;
}
