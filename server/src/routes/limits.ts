/**
 * matchsvc's per-IP budgets, as ONE named set — plus the helper every limited route spends
 * one through (2026-09-22).
 *
 * ## Why a set, and not a field per route
 *
 * There were three limiters before this file, wired one at a time, and the assembly in
 * `matchsvc.ts` had grown a running commentary to match: a `limiter`, then "a SECOND
 * limiter, with its own budget", then "a THIRD, for `/party/join`". Each arrival cost an
 * option on `MatchsvcServerOptions`, a field on the shared `deps` bundle, a field on the
 * route group's own `*RouteDeps`, and a line of prose explaining that it is not one of the
 * others. Four places, for a counter.
 *
 * That is a per-route tax on the one thing this server should find CHEAP, and the cost was
 * visible in what had a budget: `/auth/register` and `/party/join` had one, while
 * `/auth/login`, `/auth/portal`, `/party/create`, `/find` and `/store/order` — every one of
 * them unauthenticated or session-cheap, and every one of them minting state or spending
 * real CPU — had none. A limit nobody adds is not a policy, it is an accident of whichever
 * route someone last worried about.
 *
 * So the set is declared once, here, and a route that wants a budget names a key. Adding the
 * next one is a key on {@link Limiters}, a constant beside the route, and one line in the
 * assembly — and the key being required rather than optional means a budget that is declared
 * and never wired does not compile.
 *
 * ## What the set deliberately does NOT do
 *
 * **It is not a shared counter.** Every key is its own {@link RateLimiter} with its own map,
 * which is the property the three hand-wired limiters were careful about and the one a
 * bundle could most easily lose. One counter across routes would make each route's ceiling
 * depend on how busy the others happen to be — a chatty client's log batches spending the
 * budget a player's join needs — and would make the numbers below unarguable, since none of
 * them would mean anything on its own.
 *
 * **It is not a context object.** A handler still declares, and can still only reach, the
 * budget it names: {@link BudgetDeps} hands it a `Pick` of one key, so `/party/leave` cannot
 * see a limiter at all and `postJoin` cannot spend `/find`'s. The intersection
 * `matchsvcDispatch.ts` derives from the handlers puts the whole set back together at the
 * ONE place that builds it, which is also the place a missing wire fails to compile.
 *
 * **It does not hold the numbers.** Each budget is a `Budget` constant exported by the route
 * file that spends it, argued where the route is. See `rateLimit.ts`'s `Budget` for why.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { clientKey, type RateLimiter } from '../rateLimit';
import { send } from './http';

/**
 * Every per-IP budget this process keeps, by name. One {@link RateLimiter} per key, never
 * shared (see the header).
 *
 * The key is the SPENDER, not the resource — `partyJoin` rather than `party` — because two
 * routes in one group can want different ceilings for opposite reasons, and `/party/create`
 * and `/party/join` are exactly that pair: one mints a code and one guesses at codes, and
 * the number that is right for the walk is not the number that is right for the lobby.
 */
export interface Limiters {
  /** `POST /client-log` + `POST /client-events` — `routes/telemetry.ts`'s `RATE_LIMIT`. */
  telemetry: RateLimiter;
  /** `POST /auth/register` — `routes/auth.ts`'s `REGISTER_RATE_LIMIT`. */
  register: RateLimiter;
  /** `POST /auth/login` — `routes/auth.ts`'s `LOGIN_RATE_LIMIT`. */
  login: RateLimiter;
  /** `POST /auth/portal` — `routes/auth.ts`'s `PORTAL_RATE_LIMIT`. */
  portalLogin: RateLimiter;
  /** `POST /auth/change-password` — `routes/auth.ts`'s `CHANGE_PASSWORD_RATE_LIMIT`. */
  changePassword: RateLimiter;
  /** `POST /party/create` — `routes/party.ts`'s `CREATE_RATE_LIMIT`. */
  partyCreate: RateLimiter;
  /** `POST /party/join` — `routes/party.ts`'s `JOIN_RATE_LIMIT`. */
  partyJoin: RateLimiter;
  /** `POST /find` — `routes/match.ts`'s `FIND_RATE_LIMIT`. */
  find: RateLimiter;
  /** `POST /store/order` — `routes/store.ts`'s `ORDER_RATE_LIMIT`. */
  storeOrder: RateLimiter;
}

/**
 * What a limited handler adds to its own `*RouteDeps`: the one budget it spends, and the
 * clock it reads.
 *
 * `Pick<Limiters, K>` rather than `Limiters` is the whole point — it is what keeps the
 * bundle from becoming a context object every handler can reach into. A handler that names
 * `'partyJoin'` cannot spend `'find'`, and the compiler says so rather than a comment.
 */
export interface BudgetDeps<K extends keyof Limiters> {
  limits: Pick<Limiters, K>;
  /** Injected so a test can drive the window without sleeping. Defaults to the wall clock. */
  nowMs?: () => number;
}

/**
 * Spend one request from `limiter` for this caller's address. `true` when the request may
 * proceed; on `false` the 429 has already been sent and the handler must return.
 *
 * ## Call it before the body is read
 *
 * Every caller in this server does, and it is the ordering rather than the limit that makes
 * a flood cheap to refuse: the next request of a flood arrives while this one is still
 * parked on its body, so a budget taken afterwards is one the flood has already walked past.
 * A handler that awaits `readJsonBody` first is rate-limited on paper and unbounded in the
 * case that matters. The cost of the ordering is that a SUCCESSFUL call is charged too —
 * see `routes/party.ts`'s `postJoin`, which is the route that pays it most visibly.
 *
 * ## The message is the caller's, the reason is the operator's
 *
 * `message` is player-facing prose and differs per route, because "too many join attempts"
 * and "too many accounts created" send a player to different next actions. Nothing on the
 * client may branch on that prose: the client reads the STATUS (`net/party.ts`'s
 * `PartyRequestError`, `net/auth.ts`'s `AuthRequestError`) precisely so a reword here is not
 * a client release.
 */
export function spendBudget(
  limiter: RateLimiter,
  req: IncomingMessage,
  res: ServerResponse,
  nowMs: number,
  message: string,
): boolean {
  if (limiter.take(clientKey(req), nowMs)) return true;
  send(res, 429, { error: message });
  return false;
}
