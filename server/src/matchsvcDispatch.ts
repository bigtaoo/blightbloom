/**
 * matchsvc's ROUTE TABLE, split out of `matchsvc.ts` (CLAUDE.md's 500-line convention,
 * form ① "independent function modules"): an if/else dispatch chain with no private state
 * of its own, which is the exact shape that rule names.
 *
 * It answers `void | Promise<void>` because handlers became asynchronous with the
 * 2026-09-15 move to MongoDB. `matchsvc.ts` keeps the ERROR BOUNDARY that catches the
 * returned promise — see there for why a rejected one must be caught rather than left to
 * Node, which would take the process down over a transient cluster failure.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Matchmaker } from './Matchmaker';
import type { GameRegistry } from './GameRegistry';
import type { RollupJob } from './analytics/job';
import { send } from './routes/http';
import { renderMetrics, METRICS_CONTENT_TYPE } from './metrics';
import { matchsvcMetrics } from './matchsvcMetrics';
import { getClientFlags, PUBLIC_FLAGS_PATH } from './routes/clientFlags';
import * as matchRoutes from './routes/match';
import * as ratingRoutes from './routes/rating';
import * as partyRoutes from './routes/party';
import * as authRoutes from './routes/auth';
import * as accountRoutes from './routes/account';
import * as internalEntitlementRoutes from './routes/internalEntitlements';
import * as storeRoutes from './routes/store';
import * as telemetryRoutes from './routes/telemetry';

/**
 * What the chain needs: the shared `deps` bundle every route group narrows for itself, plus
 * the three values only `/metrics` reads.
 *
 * `deps` is derived from the handlers' own parameter types rather than re-declared, so a
 * route group that adds a dependency is a compile error at the one place that builds the
 * bundle — not a second interface to keep in step with the first.
 */
export interface DispatchContext {
  deps: Parameters<typeof matchRoutes.postFind>[3] &
    Parameters<typeof ratingRoutes.postReport>[3] &
    Parameters<typeof partyRoutes.postCreate>[3] &
    // `postJoin` asks for more than its siblings (its per-IP budget), and the intersection is
    // derived rather than re-declared precisely so that widening shows up here.
    Parameters<typeof partyRoutes.postJoin>[3] &
    Parameters<typeof authRoutes.postRegister>[3] &
    Parameters<typeof accountRoutes.getMeta>[3] &
    Parameters<typeof storeRoutes.getSkus>[3] &
    Parameters<typeof telemetryRoutes.postClientLog>[3] &
    Parameters<typeof internalEntitlementRoutes.postGrant>[3] &
    Parameters<typeof getClientFlags>[1];
  matchmaker: Matchmaker;
  registry: GameRegistry;
  rollup: RollupJob | null;
}

/** Route one request. Returns the matched handler's own result, promise included. */
export function dispatch(req: IncomingMessage, res: ServerResponse, ctx: DispatchContext): void | Promise<void> {
  if (req.method === 'OPTIONS') return void send(res, 204, {});
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  const path = url.pathname;

  if (req.method === 'GET' && path === '/health') {
    return void send(res, 200, { ok: true, service: 'daydayup-matchsvc' });
  }

  // Prometheus scrapes this over the compose network. matchsvc is the ONE service Caddy
  // proxies wholesale (`reverse_proxy matchsvc:8788` — server/deploy/README.md
  // §2), so unlike gameserver's and billsvc's it would otherwise be public: a free
  // readout of how many players are queued and how many accounts exist. Caddy stamps
  // `x-forwarded-for` on everything it proxies, so its presence is what "came from
  // outside" means here, and the answer is a plain 404 rather than a 403 — a 403 confirms
  // the route exists.
  if (req.method === 'GET' && path === '/metrics') {
    if (req.headers['x-forwarded-for'] !== undefined) return void send(res, 404, { error: 'not found' });
    res.writeHead(200, { 'content-type': METRICS_CONTENT_TYPE });
    return void res.end(renderMetrics(matchsvcMetrics(ctx.matchmaker, ctx.registry, ctx.rollup)));
  }

  if (req.method === 'POST' && path === telemetryRoutes.CLIENT_LOG_PATH) {
    return telemetryRoutes.postClientLog(req, res, url, ctx.deps);
  }
  if (req.method === 'POST' && path === telemetryRoutes.CLIENT_EVENTS_PATH) {
    return telemetryRoutes.postClientEvents(req, res, url, ctx.deps);
  }
  // design/21 §9's client flag delivery path: the one PUBLIC flag readout, answered from
  // the values this process already polls. See routes/clientFlags.ts for why it is its own
  // route, and why it is neither rate-limited nor hidden from proxied requests.
  if (req.method === 'GET' && path === PUBLIC_FLAGS_PATH) return getClientFlags(res, ctx.deps);

  if (req.method === 'POST' && path === '/find') return matchRoutes.postFind(req, res, url, ctx.deps);
  if (req.method === 'GET' && matchRoutes.FIND_POLL_PATH.test(path)) {
    return matchRoutes.getFindPoll(req, res, url, ctx.deps);
  }
  if (req.method === 'POST' && path === '/resume') return matchRoutes.postResume(req, res, url, ctx.deps);

  if (req.method === 'POST' && path === '/rating/report') return ratingRoutes.postReport(req, res, url, ctx.deps);
  if (req.method === 'GET' && ratingRoutes.RATING_LOOKUP_PATH.test(path)) {
    return ratingRoutes.getRating(req, res, url, ctx.deps);
  }

  if (req.method === 'POST' && path === '/party/create') return partyRoutes.postCreate(req, res, url, ctx.deps);
  if (req.method === 'POST' && path === '/party/join') return partyRoutes.postJoin(req, res, url, ctx.deps);
  if (req.method === 'POST' && path === '/party/leave') return partyRoutes.postLeave(req, res, url, ctx.deps);
  if (req.method === 'POST' && path === '/party/start') return partyRoutes.postStart(req, res, url, ctx.deps);
  if (req.method === 'GET' && partyRoutes.PARTY_LOOKUP_PATH.test(path)) {
    return partyRoutes.getParty(req, res, url, ctx.deps);
  }

  if (req.method === 'POST' && path === '/auth/register') return authRoutes.postRegister(req, res, url, ctx.deps);
  if (req.method === 'POST' && path === '/auth/login') return authRoutes.postLogin(req, res, url, ctx.deps);
  if (req.method === 'POST' && path === '/auth/logout') return authRoutes.postLogout(req, res, url, ctx.deps);
  if (req.method === 'POST' && path === '/auth/portal') return authRoutes.postPortalLogin(req, res, url, ctx.deps);
  if (req.method === 'GET' && path === '/auth/me') return authRoutes.getMe(req, res, url, ctx.deps);
  if (req.method === 'POST' && path === '/auth/change-password') {
    return authRoutes.postChangePassword(req, res, url, ctx.deps);
  }

  if (req.method === 'GET' && path === '/account/meta') return accountRoutes.getMeta(req, res, url, ctx.deps);
  if (req.method === 'POST' && path === '/account/meta') return accountRoutes.postMeta(req, res, url, ctx.deps);
  if (req.method === 'POST' && path === '/account/guest-merge') {
    return accountRoutes.postGuestMerge(req, res, url, ctx.deps);
  }

  // The store proxy (ROADMAP 8.8). Three player-facing routes that answer nothing here —
  // every one of them verifies the bearer session and then forwards to billsvc over 8.1's
  // internal seam. The `:id` GET is last because its pattern would also match a literal
  // `/store/order/` segment the POST above owns under a different method.
  if (req.method === 'GET' && path === '/store/skus') return storeRoutes.getSkus(req, res, url, ctx.deps);
  if (req.method === 'POST' && path === '/store/order') return storeRoutes.postOrder(req, res, url, ctx.deps);
  if (req.method === 'GET' && storeRoutes.STORE_ORDER_PATH.test(path)) {
    return storeRoutes.getOrder(req, res, url, ctx.deps);
  }

  // The one route no player ever calls (design/19 §4's closed delivery loop): billsvc's
  // outbox pump POSTs a settled purchase here over ROADMAP 8.1's internal key.
  if (req.method === 'POST' && path === internalEntitlementRoutes.INTERNAL_GRANT_PATH) {
    return internalEntitlementRoutes.postGrant(req, res, url, ctx.deps);
  }

  send(res, 404, { error: 'not found' });
}
