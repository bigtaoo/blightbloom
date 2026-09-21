/**
 * Split of `matchsvc.ts` (P0, 2026-09-04, prep for ROADMAP Phase 8) — the `/party/*` route
 * group (design/05/15's PvP squad follow-up): pure pre-match grouping over `PartyService`,
 * plus the room-code generator `matchsvc.ts` constructs that service with — six digits since
 * 2026-09-21 ({@link randomCode}; the shape itself is `@dd/game/match/roomCode`, shared with
 * the client).
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
 * GUESSING is the half that got materially easier and is NOT defended: a caller who can POST
 * `/party/join` without a budget can walk the whole space, and nothing in this route group
 * rate-limits (`rateLimit.ts`'s `RateLimiter` is wired to `/auth/*` and the telemetry routes,
 * not here). What a walk buys is a seat in a stranger's squad — the same prize the old
 * alphabet made slow rather than impossible — so this is an existing gap widening, not a new
 * one. Worth closing with a per-IP budget the day a squad carries anything a stranger could
 * take.
 */
export function randomCode(): string {
  let s = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) s += String(randomInt(ROOM_CODE_DIGITS));
  return s;
}

/** `GET /party/:partyId` — checked after the `POST /party/*` routes it would shadow. */
export const PARTY_LOOKUP_PATH = /^\/party\/([^/]+)$/;

export const postCreate: RouteHandler<PartyRouteDeps> = (req, res, _url, deps) => {
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

export const postJoin: RouteHandler<PartyRouteDeps> = (req, res, _url, deps) => {
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
