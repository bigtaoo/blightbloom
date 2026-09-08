/**
 * The `/store/*` route group (ROADMAP 8.8's second half, design/19-server-platform.md §4/§9)
 * — matchsvc's proxy in front of the billing plane, and the one place the two authentication
 * namespaces of design/19 §3 meet without touching.
 *
 * WHY IT EXISTS. 8.8 shipped the client half: `client/src/net/billing.ts` calls
 * `GET /store/skus`, `POST /store/order` and `GET /store/order/:id` under the player's own
 * bearer session, against `run.matchBaseUrl` — this process. billsvc answers a DIFFERENT
 * protocol on a different port: `/skus`, `/order/create`, `/order/:id`, behind the internal
 * key, with `accountId` read from the request body. Three mismatches, and none of them is
 * the client's to fix: that file is a landed contract with a defensive parser written around
 * these exact response shapes, so the adaptation belongs here.
 *
 *   client (player bearer)          this proxy                 billsvc (internal key)
 *   ─────────────────────           ──────────                 ──────────────────────
 *   GET  /store/skus        →  verify session, forward   →     GET  /skus
 *   POST /store/order       →  verify session, forward   →     POST /order/create
 *        { sku, platform }        + accountId FROM THE              { accountId, sku, platform }
 *                                   SESSION
 *   GET  /store/order/:id   →  verify session, forward,  →     GET  /order/:id
 *                                then NARROW by accountId
 *
 * THE BOUNDARY, IN BOTH DIRECTIONS (§3). An internal route never accepts a player token, and
 * a player route never trusts an accountId the client names. The second half is why
 * `postOrder` below builds its outbound body from three fields rather than forwarding the
 * one it received: an `accountId` in the client's JSON is not overridden, not rejected and
 * not logged — it is never read, so there is no code path along which it could reach
 * `BillingService.createOrder`. Same reasoning as `billsvc/server.ts` not reading `amount`.
 *
 * WHY `getOrder` NARROWS, AND WHY IT ANSWERS 404. billsvc's `GET /order/:id` does not check
 * who owns the order, which is correct for an internal route — its only caller was trusted.
 * Behind a proxy that any logged-in player can reach, that same route turns an order id into
 * a read of somebody else's purchase: their SKU, their price, their platform, their state.
 * So the order is compared against the session's accountId here, and a mismatch answers the
 * SAME 404 a nonexistent id does — telling the two apart would confirm that an id someone
 * guessed belongs to a real account, which is the fact the check exists to withhold.
 *
 * WHY `/store/skus` REQUIRES A SESSION even though billsvc's `/skus` is public. Decided, not
 * defaulted. The catalogue is public information and holding it behind a key buys nothing on
 * the internal port — but this port is the open internet. Three reasons, in order: the client
 * never calls it without a session anyway (`StorePurchase.loadCatalog` refuses with
 * `not-logged-in`, and `net/billing.ts` always sends the header), so requiring one costs no
 * behaviour; one rule across all three routes means nobody has to remember which is the
 * exception; and unauthenticated it is a free unmetered amplifier from anywhere onto the
 * billing plane. The cost is real and named: a store that wants to show prices BEFORE login
 * would have to relax this, and that is a product decision rather than something to leave
 * open by accident.
 *
 * EVERY OUTBOUND CALL GOES THROUGH `internalFetch` (8.1's D2), never a bare `fetch` — an
 * undrained body wedges undici's keep-alive pool, and these are player-facing requests that
 * arrive in bursts. `collectBody`/`internalFetchJson` exist because a proxy, unlike the
 * ladder report and the delivery pump, needs the peer's bytes and not just its status.
 *
 * NOTHING HERE RETRIES. `retry` is opt-in in `internalFetch` and stays absent on all three
 * routes: `POST /order/create` is not idempotent (a retry books a second order), and the two
 * GETs are already retried by a human or by `StorePurchase.poll`, which budgets ~90 s of
 * polling and treats a thrown poll as one lost attempt rather than a failed purchase. A
 * retry ladder inside a request the player is waiting on would only add latency.
 */
import type { ServerResponse } from 'node:http';
import type { AuthService } from '../AuthService';
import { billingPlaneUrl, INTERNAL_CALLER_MATCHSVC, sharedInternalKey } from '../config';
import { internalFetchJson } from '../internalFetch';
import { readJson, send, type RouteHandler } from './http';
import { requireAuth } from './auth';

/** `GET /store/order/:id`. Matched in `matchsvc.ts`, re-matched here for the id. */
export const STORE_ORDER_PATH = /^\/store\/order\/([^/]+)$/;

/** How this process reaches the billing plane. Every field has a `config.ts` default. */
export interface BillingPlaneConfig {
  /** Base URL, e.g. `http://localhost:8789`. The billsvc path is appended. */
  url: string;
  /** The `x-internal-key` presented outbound. `undefined` sends no header, and billsvc
   * refuses with a logged reason — the fail-closed production branch, made visible. */
  internalKey?: string;
  /** The advisory `x-internal-caller` billsvc records in its audit line. */
  caller: string;
  /** Per-attempt timeout. A player is waiting, so this is deliberately not the 5 s default. */
  timeoutMs?: number;
  /** Injected by tests, which stand up no billsvc. */
  fetchImpl?: typeof fetch;
}

export interface StoreRouteDeps {
  auth: AuthService;
  /**
   * Overrides merged over the `config.ts`-derived defaults. OPTIONAL, and the default is not
   * "no key" — it is `sharedInternalKey()`, the same registry `routes/internalEntitlements.ts`
   * falls back to. The seam exists so a test can point the proxy at a stub billsvc without
   * touching `process.env`, exactly as `BillsvcServerOptions.pump` does in the other direction.
   */
  billing?: Partial<BillingPlaneConfig>;
}

/**
 * 3 s, not `internalFetch`'s 5 s default. The delivery pump's caller is a background sweep
 * that can afford to wait; this one is a player holding a screen open, and a billing plane
 * that has not answered in three seconds is not about to.
 */
export const STORE_TIMEOUT_MS = 3_000;

function planeConfig(deps: StoreRouteDeps): BillingPlaneConfig {
  return {
    url: billingPlaneUrl(),
    internalKey: sharedInternalKey(),
    caller: INTERNAL_CALLER_MATCHSVC,
    timeoutMs: STORE_TIMEOUT_MS,
    ...deps.billing,
  };
}

/** The peer's `{ error }`, when it sent a usable one. Anything else gets `fallback` — a
 *  proxy must not put an HTML error page's first line into a player-facing message. */
function peerError(json: unknown, fallback: string): string {
  const error = (json as { error?: unknown } | null)?.error;
  return typeof error === 'string' && error.length > 0 ? error : fallback;
}

type Forwarded =
  /** billsvc answered 2xx with a JSON body. */
  | { ok: true; json: unknown }
  /** Something went wrong and `res` has ALREADY been answered. */
  | { ok: false };

/**
 * One call to the billing plane, with the whole failure policy in one place because every
 * one of these answers is a decision rather than a relay:
 *
 *  - **A transport failure or a 5xx → 502.** The billing plane is down, restarting or wedged.
 *    Not a 500: the control plane itself is fine, and an operator reading matchsvc's log for
 *    500s should not find billsvc's outages in it. Not the peer's own status either, since a
 *    5xx relayed verbatim reads as "matchsvc broke".
 *  - **A 401/403 from billsvc → 502, and an ERROR in the log.** This is the one mapping that
 *    is not obvious and the one that matters most. billsvc refusing our internal key is OUR
 *    misconfiguration (an unset `BB_INTERNAL_KEY` in production, or two processes given
 *    different ones) — relaying it would hand the client a 401, which `net/billing.ts` throws
 *    and every caller reads as "your session is bad", so a deployment mistake would present
 *    to every player as a login problem and to no operator as anything at all.
 *  - **Any other 4xx → relayed verbatim, with billsvc's own message.** An unknown SKU, an
 *    unknown platform, an order id that does not exist: these are answers about the request,
 *    they are the same answer on a retry, and the client is written to show them.
 *  - **A 2xx whose body is not JSON → 502.** Nothing usable arrived, so saying 200 with an
 *    empty envelope would make `net/billing.ts` report "no usable order" for what is really
 *    a broken hop.
 */
async function forward(
  res: ServerResponse,
  deps: StoreRouteDeps,
  route: string,
  path: string,
  init: { method: 'GET' | 'POST'; json?: unknown },
): Promise<Forwarded> {
  const plane = planeConfig(deps);
  const { result, json } = await internalFetchJson(`${plane.url}${path}`, {
    method: init.method,
    json: init.json,
    internalKey: plane.internalKey,
    caller: plane.caller,
    timeoutMs: plane.timeoutMs,
    fetchImpl: plane.fetchImpl,
  });

  if (!result.ok) {
    const status = result.status ?? 0;
    if (status === 401 || status === 403) {
      console.error(
        `[blightbloom] store: billsvc REFUSED the control plane's internal key on ${route} (${status}). ` +
          'Check BB_INTERNAL_KEY is set to the same value on matchsvc and billsvc — no purchase can ' +
          'complete until it is.',
      );
      return unavailable(res);
    }
    // A 4xx that is not an auth refusal is billsvc answering the request. Relay it.
    if (status >= 400 && status < 500) {
      send(res, status, { error: peerError(json, 'store request refused') });
      return { ok: false };
    }
    console.warn(
      `[blightbloom] store: ${route} could not reach the billing plane — ${result.failure}` +
        `${result.status ? ` ${result.status}` : ''}${result.error ? ` (${result.error})` : ''}`,
    );
    return unavailable(res);
  }

  // A 2xx with nothing parseable behind it. `internalFetchJson` already swallowed the parse
  // error, so this is the only place it becomes visible.
  if (json === null || typeof json !== 'object') {
    console.warn(`[blightbloom] store: ${route} got a ${result.status} from the billing plane with no usable JSON body`);
    return unavailable(res);
  }
  return { ok: true, json };
}

/** The one player-facing sentence for every "the billing plane did not answer" case. It says
 *  nothing about which hop failed or why: that belongs in the log, not in a response any
 *  unauthenticated party can provoke. */
function unavailable(res: ServerResponse): Forwarded {
  send(res, 502, { error: 'store temporarily unavailable' });
  return { ok: false };
}

/**
 * A floating proxy promise, made safe. `internalFetchJson` is documented never to reject, so
 * the only way into this handler is `send` itself failing on a socket that has gone away —
 * and an unhandled rejection there would take the whole control plane down with it, taking
 * matchmaking for everyone else along with one dead store request. It logs and does not try
 * to answer: whatever it would answer through is the thing that just failed.
 */
function guard(route: string, work: Promise<unknown>): void {
  void work.catch((e: unknown) => {
    console.error(`[blightbloom] store: ${route} failed after the response was decided — ${(e as Error).message}`);
  });
}

/** `GET /store/skus` → billsvc `GET /skus`. The catalogue, at the server's prices. */
export const getSkus: RouteHandler<StoreRouteDeps> = (req, res, _url, deps) => {
  const session = requireAuth(req, deps.auth);
  if (!session) return send(res, 401, { error: 'invalid or expired session' });
  guard('GET /store/skus', relaySkus(res, deps));
};

async function relaySkus(res: ServerResponse, deps: StoreRouteDeps): Promise<void> {
  const forwarded = await forward(res, deps, 'GET /store/skus', '/skus', { method: 'GET' });
  // Relayed verbatim rather than re-shaped: `parseSku` on the other end drops what it cannot
  // use row by row, so a catalogue this proxy does not understand still lists the rows it does.
  if (forwarded.ok) send(res, 200, forwarded.json);
}

/**
 * `POST /store/order` → billsvc `POST /order/create`.
 *
 * Body in: `{ sku, platform }` (`net/billing.ts` sends exactly that, and says why an
 * `amount` is not among them). Body out: those two plus the accountId of the verified
 * session — see this file's header on why the client's own claim is never read.
 */
export const postOrder: RouteHandler<StoreRouteDeps> = (req, res, _url, deps) => {
  const session = requireAuth(req, deps.auth);
  if (!session) return send(res, 401, { error: 'invalid or expired session' });
  readJson(req, (body) => {
    const b = (body ?? {}) as { sku?: unknown; platform?: unknown };
    // `sku`/`platform` are forwarded UNVALIDATED, on purpose. billsvc owns the catalogue and
    // the platform enum, it already answers 400 for anything outside them, and a second copy
    // of either check here would be one that drifts.
    guard(
      'POST /store/order',
      relayOrder(res, deps, { accountId: session.accountId, sku: b.sku, platform: b.platform }),
    );
  });
};

async function relayOrder(res: ServerResponse, deps: StoreRouteDeps, json: unknown): Promise<void> {
  const forwarded = await forward(res, deps, 'POST /store/order', '/order/create', { method: 'POST', json });
  if (forwarded.ok) send(res, 200, forwarded.json);
}

/**
 * `GET /store/order/:id` → billsvc `GET /order/:id`, narrowed to the session's own account.
 * The poll `StorePurchase` runs while a payment is in flight.
 */
export const getOrder: RouteHandler<StoreRouteDeps> = (req, res, url, deps) => {
  const session = requireAuth(req, deps.auth);
  if (!session) return send(res, 401, { error: 'invalid or expired session' });
  const match = STORE_ORDER_PATH.exec(url.pathname);
  // Unreachable through `matchsvc.ts`, which tests the same pattern before dispatching — but
  // this handler owns its `/:id`, so it re-matches rather than trusting a caller to have.
  if (!match) return send(res, 404, { error: 'not found' });
  guard('GET /store/order/:id', relayOrderLookup(res, deps, decodeURIComponent(match[1]!), session.accountId));
};

async function relayOrderLookup(
  res: ServerResponse,
  deps: StoreRouteDeps,
  orderId: string,
  accountId: string,
): Promise<void> {
  const path = `/order/${encodeURIComponent(orderId)}`;
  const forwarded = await forward(res, deps, 'GET /store/order/:id', path, { method: 'GET' });
  if (!forwarded.ok) return;

  const order = (forwarded.json as { order?: unknown }).order;
  const owner = order && typeof order === 'object' ? (order as { accountId?: unknown }).accountId : undefined;
  // FAILS CLOSED on anything that is not this account's order — including a response shape
  // that carries no `accountId` at all. An ownership check that cannot find an owner has not
  // passed, and a billsvc that stopped sending the field must break this route loudly rather
  // than quietly start serving every order to everyone.
  if (typeof owner !== 'string' || owner !== accountId) {
    return send(res, 404, { error: 'not found' });
  }
  // Forwarded verbatim, `accountId` included: it is the caller's own, and re-shaping the
  // payload here would be a third copy of the order schema to keep in step with billsvc and
  // `net/billing.ts`.
  send(res, 200, forwarded.json);
}
