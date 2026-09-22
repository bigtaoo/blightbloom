/**
 * Split of `matchsvc.ts` (P0, 2026-09-04, prep for ROADMAP Phase 8) — the `/party/*` route
 * group (design/05/15's PvP squad follow-up): pure pre-match grouping over `PartyService`,
 * plus the room-code generator `matchsvc.ts` constructs that service with — six digits since
 * 2026-09-21 ({@link randomCode}; the shape itself is `@dd/game/match/roomCode`, shared with
 * the client).
 *
 * Two routes here spend a per-IP budget, and they defend different things: {@link
 * JOIN_RATE_LIMIT} bounds how fast a caller may GUESS at codes (the gap {@link randomCode}
 * used to describe and leave open), and {@link CREATE_RATE_LIMIT} bounds how many it may
 * MINT. Both landed on 2026-09-22, a few hours apart, and the second one is there because
 * the first one's own note — "minting a code is not guessing one" — answered the discovery
 * question correctly and never asked the supply question.
 *
 * A `playerId` is whatever opaque string the client sends; once a player is logged in
 * (design/16-accounts.md) the client sends its real `accountId` as `playerId` here, but
 * nothing in this group verifies it — the account layer only gates `/auth/*` and
 * `/account/*` themselves.
 */
import { randomInt } from 'node:crypto';
import { CodeSpaceExhausted, type PartyService } from '../PartyService';
// Through `../config`, not `@dd/game/...` directly — the same indirection `PartyService.ts`
// uses for `SQUAD_SIZE`, so the list of things this server borrows from the client's pure
// layer is readable in one place.
import { ROOM_CODE_DIGITS, ROOM_CODE_LENGTH, isRoomCode, normalizeRoomCode } from '../config';
import type { Logger } from '../log';
import type { Budget } from '../rateLimit';
import { spendBudget, type BudgetDeps } from './limits';
import { readJson, send, type RouteHandler } from './http';

export interface PartyRouteDeps {
  parties: PartyService;
  /** Where `/party/create`'s one unexpected-failure path writes its line. Same shape the
   *  telemetry group already takes, and it costs the assembly nothing: `matchsvc.ts` builds
   *  one `deps` bundle whose type is the intersection of every group's, and a `log` is
   *  already in it. */
  log: Logger;
}

/**
 * The per-IP budget for CODE ENTRY (2026-09-22). A hundred and twenty in ten minutes.
 *
 * This closes the gap {@link randomCode}'s last paragraph used to describe and leave open: at
 * a 10^6 keyspace, a caller who can POST `/party/join` without a ceiling can walk the whole
 * space, and what a walk buys is a seat in a stranger's squad.
 *
 * What a per-IP budget can change is the RATE, and that is the whole argument for this number.
 * Unbounded, one caller at a modest 50 requests a second draws ~4.3M codes a day — several
 * times the entire space — and so lands in essentially every party that is live while it runs.
 * At 120 per ten minutes the same caller draws 17,280 a day, one pass over 10^6 takes about
 * two months, and the expected number of live parties it stumbles into falls by the same three
 * orders of magnitude. The walk does not become impossible; it becomes slower than the thing
 * it walks toward, since a party TTLs out after 10 idle minutes and its code goes with it.
 *
 * Four times looser than `routes/auth.ts`'s `REGISTER_RATE_LIMIT`, and deliberately, because
 * the false positives are not comparable. A refused registration is a player who waits; a
 * refused join is a player who cannot get into the squad their friend is sitting in, having
 * done nothing wrong — and a carrier-grade NAT can put a city's worth of mobile subscribers
 * behind one address. A human enters one code, or three with a typo; 120 leaves room for
 * dozens of humans in the same window and still costs a bulk walk everything.
 *
 * It bounds ONE caller, which is the honest description — a flood spread over many addresses
 * walks around any per-IP limit, and this file is not the place that would answer that.
 */
export const JOIN_RATE_LIMIT: Budget = { requests: 120, windowMs: 10 * 60_000 };

/**
 * The per-IP budget for CODE MINTING (2026-09-22, hours after {@link JOIN_RATE_LIMIT}).
 * Sixty in ten minutes.
 *
 * This route was left unbounded the same morning, with a test asserting the absence and this
 * reason beside it: *minting a code is not guessing one, and a collision is already a
 * non-event*. Both halves of that are still true, and both are about DISCOVERY — whether a
 * caller can reach a party that is not theirs. Nothing there asked the other question, which
 * is what a caller can do to the SUPPLY, and the answer was: everything.
 *
 * Every call mints a party that occupies one of 10^6 codes and one entry in an in-process
 * `Map`, for ten idle minutes, on behalf of a caller who has proved nothing. So the resource
 * is not "codes drawn", it is *codes held at once*, and the steady state of an unbounded
 * caller is its request rate times the TTL: at 50 requests a second, thirty thousand live
 * parties ten minutes in, and at a few hundred a second the keyspace itself starts to fill —
 * which is `PartyService`'s `CODE_DRAW_ATTEMPTS` throwing `CodeSpaceExhausted`, i.e. a 503 on
 * the create button, for everybody, from one address.
 *
 * Because the window here is exactly the party TTL, the budget IS that steady state: sixty
 * per ten minutes means at most sixty live parties per address, which is the bound worth
 * stating and the reason not to widen the window instead of the count.
 *
 * Half of {@link JOIN_RATE_LIMIT} rather than equal to it, and derived rather than rounded:
 * a squad has one creator and up to `MAX_PARTY_SIZE - 1` joiners, so legitimate creates run
 * at roughly a third of legitimate joins, and half leaves the two the same headroom over what
 * real traffic does. The false positive is the same shape as the join one — a player who
 * cannot get a squad together, having done nothing wrong, possibly behind a carrier-grade NAT
 * with a city on it — which is why neither number is tight.
 */
export const CREATE_RATE_LIMIT: Budget = { requests: 60, windowMs: 10 * 60_000 };

/**
 * The two limited handlers' own deps. `BudgetDeps<K>` hands each one a `Pick` of the single
 * budget it spends, which is what keeps `/party/leave` unable to see a limiter at all and
 * `postJoin` unable to spend `postCreate`'s — see `routes/limits.ts` for why the set is one
 * bundle and why the two counters are still separate.
 *
 * Required rather than optional, both of them, because an absent limiter can only mean "no
 * limit", and a working way to be exempt is an invitation to use it — the same reasoning the
 * coverage gate's no-exemption rule is written down with.
 */
export interface JoinRouteDeps extends PartyRouteDeps, BudgetDeps<'partyJoin'> {}
export interface CreateRouteDeps extends PartyRouteDeps, BudgetDeps<'partyCreate'> {}

/**
 * A fresh room code: {@link ROOM_CODE_LENGTH} digits drawn from {@link ROOM_CODE_DIGITS}.
 *
 * The SHAPE is not defined here — it lives in `@dd/game/match/roomCode`, shared with the
 * client field that accepts codes, because two copies of the number cannot be held in
 * agreement by any test on either side. What lives here is the DRAW, which is the server's
 * business alone.
 *
 * Uniqueness is deliberately not this function's job either, but `PartyService.create`'s,
 * which draws from here until it gets an unused code. Keeping the two apart is what lets a
 * test force a collision with a two-line fake.
 *
 * `randomInt` rather than the obvious `Math.floor(Math.random() * n)`: that expression was
 * uniform for the old 32-glyph alphabet only because 32 is a power of two, and it is not for
 * 10 — the same shape written with `%` is measurably biased, and `randomInt` rejects the
 * uneven tail itself. It also retires the question of whether one code is predictable from
 * another, which is worth not having at a 1M keyspace.
 *
 * On that keyspace, since this is the file that spends it: six digits is 10^6, down from the
 * old 32^5 (~33.5M). A COLLISION stays a non-event — a party TTLs out after 10 idle minutes,
 * so the live set sits orders of magnitude below 1M, and `create` redraws anyway (boundedly).
 * GUESSING is the half that got materially easier, and since 2026-09-22 it is bounded rather
 * than merely written down: `/party/join` spends a per-IP budget ({@link JOIN_RATE_LIMIT})
 * before it will look a code up at all. What a walk buys is still only a seat in a stranger's
 * squad, and a per-IP ceiling still only slows ONE caller — but it slows that caller below the
 * 10-minute TTL of the thing being walked toward, which is the difference that matters.
 *
 * The keyspace has a second cost that is not about guessing at all, and it is bounded by
 * {@link CREATE_RATE_LIMIT} rather than by anything in here: 1M codes against a live set is a
 * safe ratio only while the live set stays small, and the live set is whatever the CREATE
 * route was allowed to mint.
 */
export function randomCode(): string {
  let s = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) s += String(randomInt(ROOM_CODE_DIGITS));
  return s;
}

/** `GET /party/:partyId` — checked after the `POST /party/*` routes it would shadow. */
export const PARTY_LOOKUP_PATH = /^\/party\/([^/]+)$/;

export const postCreate: RouteHandler<CreateRouteDeps> = (req, res, _url, deps) => {
  // Spent BEFORE the body is read, for the reason `spendBudget` gives: a flood's next request
  // arrives while this one is parked on its body. Which charges a SUCCESSFUL create too, and
  // here that is not merely acceptable but the point — a create that succeeds is exactly the
  // call that took a code out of the pool, so the thing being counted is the thing being
  // defended. (`postJoin` below pays the same ordering for a weaker reason.)
  if (!spendBudget(deps.limits.partyCreate, req, res, (deps.nowMs ?? Date.now)(), 'too many parties created from this address — try again later')) {
    return;
  }
  readJson(req, (body) => {
    const playerId = (body as { playerId?: unknown })?.playerId;
    if (typeof playerId !== 'string' || !playerId) return send(res, 400, { error: 'playerId required' });
    try {
      send(res, 200, deps.parties.create(playerId));
    } catch (e) {
      // Caught HERE rather than left to `matchsvc.ts`'s error boundary, and that is not a
      // stylistic choice: `readJson` invokes this callback from inside a `.then()`, so a
      // throw escaping it becomes an unhandled rejection the boundary never sees
      // (`routes/http.ts` says so in its own header) and the request answers NOTHING — a
      // client left hanging until its own timeout. Which is also why neither arm re-throws.
      //
      // `CodeSpaceExhausted` is a condition, not a fault: the caller sent nothing wrong and
      // the next request very likely succeeds, so 503. Anything else is a bug, so 500 with a
      // line in the log rather than a silent one.
      if (e instanceof CodeSpaceExhausted) return send(res, 503, { error: 'no room code available' });
      deps.log.error('party create failed', { error: (e as Error).message });
      send(res, 500, { error: 'party create failed' });
    }
  });
};

export const postJoin: RouteHandler<JoinRouteDeps> = (req, res, _url, deps) => {
  // Spent BEFORE the body is read, exactly as `/auth/register` does it and for the reason
  // written there: a flood's next request arrives while this one is still parked on its body,
  // so a limiter taken afterwards is one the flood has already walked past.
  //
  // Which means a SUCCESSFUL join is charged too, where a budget aimed purely at guessing
  // would charge only the misses. Charging only the misses needs `RateLimiter` to answer "is
  // this key exhausted" WITHOUT spending from it — a new method on a class the telemetry,
  // auth and adminsvc routes all share — because otherwise an exhausted walker still has its
  // probe answered before it is refused, which is the one thing the budget exists to stop.
  // {@link JOIN_RATE_LIMIT} is set wide enough that a player's own joins never approach it,
  // which is the cheaper way to buy the same property.
  if (!spendBudget(deps.limits.partyJoin, req, res, (deps.nowMs ?? Date.now)(), 'too many join attempts from this address — try again later')) {
    return;
  }
  readJson(req, (body) => {
    const { playerId, code } = (body as { playerId?: unknown; code?: unknown }) ?? {};
    if (typeof playerId !== 'string' || !playerId || typeof code !== 'string' || !code) {
      return send(res, 400, { error: 'playerId and code required' });
    }
    // Normalized, then held to the shared shape. Both come from `@dd/game/match/roomCode`,
    // which documents why the trim is a trim and not a repair. The refusal is a 400 rather
    // than the 404 an unknown code gets, because "that is not a room code" and "no room has
    // that code" are different answers — and it keeps a caller from feeding arbitrary
    // strings into the lookup map.
    const normalized = normalizeRoomCode(code);
    if (!isRoomCode(normalized)) return send(res, 400, { error: 'invalid code' });
    const info = deps.parties.join(normalized, playerId);
    if (!info) return send(res, 404, { error: 'party not found or full' });
    send(res, 200, info);
  });
};

export const postLeave: RouteHandler<PartyRouteDeps> = (req, res, _url, deps) => {
  readJson(req, (body) => {
    const { partyId, playerId } = (body as { partyId?: unknown; playerId?: unknown }) ?? {};
    if (typeof partyId !== 'string' || typeof playerId !== 'string') {
      return send(res, 400, { error: 'partyId and playerId required' });
    }
    send(res, 200, deps.parties.leave(partyId, playerId));
  });
};

export const postStart: RouteHandler<PartyRouteDeps> = (req, res, _url, deps) => {
  readJson(req, (body) => {
    const { partyId, playerId } = (body as { partyId?: unknown; playerId?: unknown }) ?? {};
    if (typeof partyId !== 'string' || typeof playerId !== 'string') {
      return send(res, 400, { error: 'partyId and playerId required' });
    }
    const info = deps.parties.startMatching(partyId, playerId);
    if (!info) return send(res, 404, { error: 'party not found or not leader' });
    send(res, 200, info);
  });
};

export const getParty: RouteHandler<PartyRouteDeps> = (_req, res, url, deps) => {
  const info = deps.parties.get(decodeURIComponent(url.pathname.match(PARTY_LOOKUP_PATH)![1]!));
  if (!info) return send(res, 404, { error: 'party not found' });
  send(res, 200, info);
};
