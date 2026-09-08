/**
 * Split of `matchsvc.ts` (P0, 2026-09-04, prep for ROADMAP Phase 8) — the matchmaking
 * route group (ROADMAP 3.3, design/06): the poll-based find API (`POST /find`,
 * `GET /find/:queueId`) and the reconnect reissue (`POST /resume`).
 *
 * Pure wiring around the pure `Matchmaker`: the clock, the seed/roomId source and the
 * bot-fill hook all stay in `matchsvc.ts`'s `createMatchsvcServer`, which hands this group
 * only the built matchmaker, the ticket secret, and `pickGameserver` — the `GameRegistry`
 * lookup (ROADMAP 8.6, design/19 §6) that answers which gameserver this ticket should be
 * redeemed against.
 *
 * The WS URL is stamped onto the RESPONSE here, never into the ticket payload: a ticket is
 * a seat authorization and must not carry topology (design/19 §6, superseding the earlier
 * "put a gameserver id inside the ticket" sketch). `ticket.ts` is untouched by 8.6.
 */
import type { Matchmaker, MatchTicket } from '../Matchmaker';
import { signTicket, verifyTicket, type MatchMode, type TicketPayload } from '../ticket';
import { readJson, send, type RouteHandler } from './http';

export interface MatchRouteDeps {
  matchmaker: Matchmaker;
  /**
   * The gameserver a ticket issued right now should be redeemed against, or `null` when
   * there is none — every registered instance full or stale, and no static address
   * configured. Narrowed to the one field this group reads rather than typed as
   * `GameServerEntry`, so the route group does not depend on the registry's shape.
   */
  pickGameserver: () => { wsUrl: string } | null;
  /** The ticket-signing secret — `/resume` both verifies and re-signs with it. */
  secret: string;
  /**
   * The account layer, for the ONE thing `/find` reads from it: the bearer session, when
   * the caller sent one (design/20). Narrowed to the single method this group calls rather
   * than typed as `AuthService`, so the matchmaking group does not depend on that class's
   * shape — the same narrowing `pickGameserver` above already applies to the registry.
   *
   * Optional: every pre-2026-09-08 caller of `createMatchsvcServer` (and every test that
   * builds this deps bundle by hand) omits it, and a `/find` with no auth behind it behaves
   * exactly as it always did.
   */
  auth?: { verifySession(token: unknown): { accountId: string; username: string } | null };
}

/**
 * What every route here answers when `pickGameserver` comes back empty. 503 and not 500:
 * the request was well formed and the service is fine — there is simply no data plane to
 * hand the player to, which is a transient, retryable condition.
 *
 * The alternative — answering 200 with `wsUrl` absent — is the bug this shape exists to
 * make impossible. `MatchInfo.wsUrl` is non-optional on the client
 * (`client/src/net/matchmaking.ts`), so an `undefined` slipping into the match object
 * would surface not here but much later, as a socket opened on `undefined?ticket=…`.
 */
const NO_GAMESERVER = { error: 'no gameserver available' };

/** Stamps the chosen instance onto an issued ticket — the whole of the match response. */
const withUrl = (t: MatchTicket, wsUrl: string): MatchTicket & { wsUrl: string } => ({ ...t, wsUrl });

// A reconnect ticket only needs to outlive the client opening the socket with it, not
// the whole match (unlike the original match ticket, which the client redeems once
// right after `/find` resolves) — same window `onBotFill` already grants a bot ticket.
const RESUME_TICKET_TTL_MS = 30_000;

/** `GET /find/:queueId` — the poll half of the find API. */
export const FIND_POLL_PATH = /^\/find\/([^/]+)$/;

/** `Authorization: Bearer <token>` -> the token, or `undefined`. A local copy of
 *  `routes/auth.ts`'s reader rather than an import of `requireAuth`, because that function
 *  RESOLVES a session and this route must treat a missing or bad one as "a guest" rather
 *  than as a 401 — importing it would mean importing a refusal this route must not make. */
function bearerToken(header: string | undefined): string | undefined {
  return header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
}

export const postFind: RouteHandler<MatchRouteDeps> = (req, res, _url, deps) => {
  readJson(req, (body) => {
    const playerCount = Number((body as { playerCount?: unknown })?.playerCount);
    // 'pvp' opts into the battle-royale queue (design/15); anything else (absent,
    // 'coop', a typo) is the pre-existing co-op shape — never silently 400s a client
    // that predates this field.
    const rawMode = (body as { mode?: unknown })?.mode;
    const mode: MatchMode = rawMode === 'pvp' ? 'pvp' : 'coop';
    // A pre-formed party (design/05/15) — every member's client sends the SAME
    // partyId once their leader starts matching, so Matchmaker groups them into
    // one squad chunk. Absent (every pre-party caller) → plain FIFO, unaffected.
    const rawGroupId = (body as { partyId?: unknown })?.partyId;
    const groupId = typeof rawGroupId === 'string' && rawGroupId ? rawGroupId : undefined;
    // Who this seat belongs to. Two sources, and the ORDER is the point (design/20).
    //
    // An `Authorization: Bearer` header, if the caller sent one, is VERIFIED here and wins
    // outright — both the account id and the display name come from the session, and the
    // body's `accountId` is ignored rather than merged. That is what makes the name safe to
    // put in the ticket and show to other players: a client that could name itself could
    // name itself anything, and a name is the one field in a match other players SEE.
    //
    // Without a header, the body's `accountId` is used exactly as it was before — a guest's
    // local id, trusted no more than `playerCount`/`mode` already are, and carrying no name.
    // That is the pre-existing behaviour and this route's trust boundary is unchanged for
    // it: the account layer's boundary is `/auth/*`/`/account/*`, and a guest's id only ever
    // reaches `ladderReport.ts`, which falls back to its own `seat:{roomId}:{seatIdx}`
    // scaffold anyway.
    const session = deps.auth?.verifySession(bearerToken(req.headers.authorization)) ?? null;
    const rawAccountId = (body as { accountId?: unknown })?.accountId;
    const bodyAccountId = typeof rawAccountId === 'string' && rawAccountId ? rawAccountId : undefined;
    const accountId = session?.accountId ?? bodyAccountId;
    const name = session?.username;
    try {
      // Asked BEFORE enqueueing, so a control plane with no data plane behind it does not
      // burn a queue slot — and, for the arrival that completes a group, a whole formed
      // room — on a request it is about to refuse anyway.
      const gs = deps.pickGameserver();
      if (!gs) return send(res, 503, NO_GAMESERVER);
      const { queueId, ticket } = deps.matchmaker.enqueue(playerCount, mode, groupId, accountId, name);
      send(res, 200, { queueId, match: ticket ? withUrl(ticket, gs.wsUrl) : undefined });
    } catch (e) {
      send(res, 400, { error: (e as Error).message });
    }
  });
};

export const getFindPoll: RouteHandler<MatchRouteDeps> = (_req, res, url, deps) => {
  const queueId = decodeURIComponent(url.pathname.match(FIND_POLL_PATH)![1]!);
  // Again before `poll()`, and here the ordering is load-bearing rather than merely tidy:
  // `poll()` DELETES the waiter on its way to returning `matched`, so discovering the
  // absence afterwards would destroy the seat the caller has been waiting for. Refusing
  // first leaves the waiter queued, and the next poll — once an instance exists — matches.
  const gs = deps.pickGameserver();
  if (!gs) return send(res, 503, NO_GAMESERVER);
  const result = deps.matchmaker.poll(queueId);
  send(res, 200, result.status === 'matched' ? { status: 'matched', match: withUrl(result.ticket, gs.wsUrl) } : result);
};

/**
 * Reconnect (ROADMAP reconnect, design/06): mint a fresh, short-lived ticket for the
 * SAME seat grant a now-expired ticket once named, so a mid-match disconnect (which
 * by definition happens well after the original 30s ticket TTL) can redeem a new one
 * on the gameserver instead of being stuck forever. `ignoreExpiry` is the only
 * difference from the normal handshake check — the signature still has to verify,
 * so this can't mint a ticket for a seat the caller was never actually granted.
 * Whether the room itself is still alive/in-match is the gameserver's call (`resume`
 * there fails cleanly if it isn't); matchsvc has no visibility into live room state.
 */
export const postResume: RouteHandler<MatchRouteDeps> = (req, res, _url, deps) => {
  readJson(req, (body) => {
    const token = (body as { token?: unknown })?.token;
    if (typeof token !== 'string' || !token) return send(res, 400, { error: 'token required' });
    const payload = verifyTicket(token, deps.secret, Date.now(), { ignoreExpiry: true });
    if (!payload) return send(res, 401, { error: 'invalid ticket' });
    // A reconnecting client is rejoining a room that already lives on ONE instance, so
    // this pick is really "is the data plane there at all". It becomes a lookup by roomId
    // the day rooms are spread across instances — see design/19 §6.
    const gs = deps.pickGameserver();
    if (!gs) return send(res, 503, NO_GAMESERVER);
    const fresh: TicketPayload = { ...payload, exp: Date.now() + RESUME_TICKET_TTL_MS };
    const ticket: MatchTicket = {
      roomId: fresh.roomId,
      owner: fresh.owner,
      seed: fresh.seed,
      playerCount: fresh.playerCount,
      teamId: fresh.teamId,
      mode: fresh.mode ?? 'coop',
      token: signTicket(fresh, deps.secret),
    };
    send(res, 200, { match: withUrl(ticket, gs.wsUrl) });
  });
};
