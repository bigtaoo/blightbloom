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
import type { Budget } from '../rateLimit';
import { signTicket, verifyTicket, type MatchMode, type TicketPayload } from '../ticket';
import { spendBudget, type BudgetDeps } from './limits';
import { readJsonBody, send, type RouteHandler } from './http';

/**
 * The per-IP budget for ENTERING THE QUEUE (2026-09-22). A hundred and twenty in ten minutes.
 *
 * `POST /find` is the cheapest request in this server that reaches furthest. It writes a
 * waiter into `Matchmaker`, and a waiter is not inert: when enough of the same shape are
 * present the matchmaker FORMS A ROOM out of them, on a real gameserver, with bots filling
 * whatever seats are left. So an unbounded caller does not merely grow a map that TTLs out
 * after thirty seconds — it manufactures matches on the data plane at whatever rate it likes,
 * and any real player who queues during that window is grouped into one of them.
 *
 * The queue TTL is what makes 120 enough. A waiter is gone thirty seconds after it arrives,
 * so what a budget has to bound is the arrival RATE rather than any accumulated total: twelve
 * a minute per address, against a legitimate rate of one per matchmaking attempt (a squad of
 * four is four, once, because each member POSTs for itself) followed by minutes of actually
 * playing. A player who queues, cancels and requeues every five seconds for a solid minute is
 * still inside it.
 *
 * `GET /find/:queueId` is deliberately left unbudgeted, and it is the clearest case in this
 * server for leaving one alone: the real client polls it every 500ms for up to ninety seconds
 * — around 180 requests per attempt, per player — so any ceiling low enough to inconvenience
 * an attacker refuses the four players in one living room first. It writes nothing, it needs
 * a `queueId` the caller cannot guess, and what it costs is one map lookup.
 */
export const FIND_RATE_LIMIT: Budget = { requests: 120, windowMs: 10 * 60_000 };

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
   * Optional, and what "omitted" means changed on 2026-09-17: with no auth layer wired there
   * is no session to resolve, so EVERY seat is a guest and every match is keyed by
   * `ladderReport.ts`'s per-match scaffold. That is the safe direction to fail — a deps
   * bundle that forgot the account layer now records no rating rather than recording it
   * against whatever the caller claimed.
   */
  auth?: { verifySession(token: unknown): Promise<{ accountId: string; username: string } | null> };
  /**
   * The party lookup, for the two things `/find` needs to know about a `partyId`
   * (2026-09-26, co-op room codes): how many members it has, so `Matchmaker` waits for all of
   * them before seating anyone, and which mode it was made for. Narrowed to `get` for the
   * same reason as `auth`. Optional: without it a `partyId` is a bare grouping tag, which is
   * what it was before this existed — every member counted as present on arrival.
   */
  parties?: { get(partyId: string): { members: readonly string[]; mode: MatchMode } | null };
}

/**
 * `postFind`'s own deps — the one handler in this group with a budget ({@link
 * FIND_RATE_LIMIT}). `getFindPoll` and `postResume` take plain {@link MatchRouteDeps} and so
 * cannot reach a limiter at all, which is the statement this split exists to make.
 */
export interface FindRouteDeps extends MatchRouteDeps, BudgetDeps<'find'> {}

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

export const postFind: RouteHandler<FindRouteDeps> = async (req, res, _url, deps) => {
  {
    // Before the body, like every budget in this server — `routes/limits.ts`'s `spendBudget`
    // has the reason, and it applies here with one extra edge: the enqueue that follows can
    // form a room synchronously, so the request this refuses is one that would have reached
    // the data plane, not merely this process.
    if (!spendBudget(deps.limits.find, req, res, (deps.nowMs ?? Date.now)(), 'too many matchmaking requests from this address — try again later')) {
      return;
    }
    const body = await readJsonBody(req);
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
    // The party itself, when the id names a live one. An unknown or expired id is NOT refused
    // — it degrades to a grouping tag with nobody to wait for, which is exactly what a party
    // that dissolved between START and this request should do: let the member play.
    const party = groupId ? (deps.parties?.get(groupId) ?? null) : null;
    // A party queues for the mode it was MADE for. A squad asking for a co-op room (or the
    // reverse) is a client bug, and seating it would put friends in a room shaped for the
    // other game — refused rather than quietly re-moded, so the bug surfaces.
    if (party && party.mode !== mode) return send(res, 400, { error: 'party is for a different mode' });
    // Who this seat belongs to. ONE source, and that is the whole point (design/16 hole 3,
    // closed 2026-09-17; design/20 for the name).
    //
    // An `Authorization: Bearer` header is VERIFIED here, and both the account id and the
    // display name come from the session it resolves. Without a header this is a GUEST seat:
    // `accountId` and `name` are both `undefined`, and `ladderReport.ts`'s
    // `seat:{roomId}:{seatIdx}` scaffold keys the match — a throwaway identity per match,
    // which is the correct answer rather than a missing feature.
    //
    // The body's `accountId` used to be read here as a fallback and is now IGNORED
    // ENTIRELY — it is not even parsed. That fallback was this route's trust boundary
    // failing open: until the same pass the client sent no bearer at ALL, so EVERY `/find`
    // took the caller's word for who it was, and anyone could POST a stranger's real
    // accountId and move their ladder rating. Which is also why the fix is not "verify the guest id":
    // a guest's id is client-declared by construction, so a key built from one can never be
    // unforgeable, and a rating that cannot be attributed must not be recorded.
    // `design/15-pvp-arena.md` "Who a rating belongs to" has the full argument, including why a
    // guest's rating could never have been merged into an account afterwards.
    //
    // The player loses nothing else by staying a guest: every PvP match is still playable,
    // still winnable, and still shows its result. Only the durable RANK needs a name that
    // cannot be borrowed, and the results screen says so (`RunOutcome.winArena`).
    const session = (await deps.auth?.verifySession(bearerToken(req.headers.authorization))) ?? null;
    const accountId = session?.accountId;
    const name = session?.username;
    try {
      // Asked BEFORE enqueueing, so a control plane with no data plane behind it does not
      // burn a queue slot — and, for the arrival that completes a group, a whole formed
      // room — on a request it is about to refuse anyway.
      const gs = deps.pickGameserver();
      if (!gs) return send(res, 503, NO_GAMESERVER);
      const { queueId, ticket, botFillInMs } = deps.matchmaker.enqueue(
        playerCount, mode, groupId, accountId, name, party?.members.length,
      );
      send(res, 200, { queueId, match: ticket ? withUrl(ticket, gs.wsUrl) : undefined, botFillInMs });
    } catch (e) {
      send(res, 400, { error: (e as Error).message });
    }
  }
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
export const postResume: RouteHandler<MatchRouteDeps> = async (req, res, _url, deps) => {
  {
    const body = await readJsonBody(req);
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
  }
};
