/**
 * matchsvc (ROADMAP 3.3, design/06) — the matchmaking control plane's HTTP entrypoint.
 * The ONLY control-plane file that touches node:http, exactly as index.ts is the only
 * data-plane file that touches `ws`: it wraps the pure Matchmaker with a real clock, a
 * seed/roomId source, and the shared ticket signer, and exposes the poll-based find API.
 * It also owns the PvP ladder rating store (design/15, ROADMAP 4.6) — matchsvc-side
 * account bookkeeping, entirely separate from `@dd/engine`'s replicated/replay state.
 *
 * A separate process from the WS gameserver (own port, MATCH_PORT default 8788) — the
 * clean control/data split funny uses. The client calls this to get a signed seat ticket,
 * then opens the gameserver socket with it (`/ws?ticket=`). The gameserver calls back
 * into `/rating/report` once a PvP match settles with a checkpoint/hash-verified
 * placement result (design/15's "computed from checkpoint-verified match placements
 * only") — see `MatchRoomDeps.onSettled` (MatchRoom.ts) and its wiring in index.ts.
 *
 * Since the 2026-09-04 P0 split (prep for ROADMAP Phase 8, which adds routes to three of
 * these groups) this file is the ASSEMBLY SHELL only: it builds the services, owns the
 * dispatch chain below, and nothing else. Every handler is a free `(req, res, url, deps)`
 * function under `routes/`, grouped by surface — CLAUDE.md's split form 1 (independent
 * function modules), which is what a linear if/else chain over shared-nothing handlers
 * wants. Per-route documentation lives with each handler; the map is:
 *
 *   POST /find             { playerCount, mode?, partyId? } -> { queueId, match? }    routes/match
 *   GET  /find/:id                                       -> { status: 'queued'|'matched'|'expired', match? }
 *   POST /resume            { token }                     -> { match } | 401 (ROADMAP reconnect)
 *   POST /rating/report     { accountIds, places, teamIds? } -> { changes: [{accountId,before,after}] }
 *   GET  /rating/:accountId                               -> { accountId, rating }    routes/rating
 *   POST /party/create      { playerId }                 -> PartyInfo                 routes/party
 *   POST /party/join        { playerId, code }           -> PartyInfo | 404
 *   POST /party/leave       { partyId, playerId }        -> PartyInfo | null
 *   POST /party/start       { partyId, playerId }        -> PartyInfo | 404 (leader only)
 *   GET  /party/:id                                       -> PartyInfo | 404
 *   POST /auth/register     { username, password }        -> { accountId, username, token } | 400
 *   POST /auth/login        { username, password }        -> { accountId, username, token } | 401
 *   POST /auth/logout       { token }                      -> { ok: true }             routes/auth
 *   POST /auth/portal       { token }  (a CrazyGames user token) -> { accountId, username, token } | 401/503
 *   GET  /auth/me           (Bearer token)                 -> { accountId, username } | 401
 *   POST /auth/change-password { token, oldPassword, newPassword } -> { ok: true } | 400/401
 *   GET  /account/meta      (Bearer token)  -> { data: MetaState | null, entitlements } | 401
 *   POST /account/meta      (Bearer token) { data }        -> { ok: true } | 400/401    routes/account
 *   GET  /store/skus        (Bearer token)  -> { skus } | 401/502                       routes/store
 *   POST /store/order       (Bearer token) { sku, platform } -> { order, payment } | 400/401/502
 *   GET  /store/order/:id   (Bearer token)  -> { order } | 401/404/502
 *   POST /client/log        { session, host, ver, now, entries } -> { ok, accepted }  routes/telemetry
 *   GET  /metrics           (compose network only)         -> Prometheus exposition
 *   POST /internal/entitlements/grant  (x-internal-key)  -> { granted, alreadyOwned } | 401/400/404
 *                                                                                     routes/internalEntitlements
 *   GET  /health                                                                       (here)
 *
 * `/store/*` (ROADMAP 8.8, design/19 §4) is the one route group here that answers nothing of
 * its own: it is a PROXY in front of billsvc, and it exists because the two ends of the
 * purchase flow authenticate in different namespaces. A player's bearer session is verified
 * here, in this process, and what leaves for the billing plane is an internal-key call
 * carrying the accountId that session named — never one the client did. See `routes/store.ts`.
 *
 * `/auth/*` and `/account/*` (design/16-accounts.md) are this project's first real
 * account system — `AuthService` owns a SQLite-backed (`node:sqlite`) accounts/sessions
 * store; every `/account/*` route requires a live session via `Authorization: Bearer
 * <token>`, checked by `requireAuth` in `routes/auth.ts`.
 *
 * `match` = { wsUrl, roomId, owner, seed, playerCount, token } — everything the client
 * needs to open `${wsUrl}?ticket=${token}` (see client/src/net/matchmaking.ts). `wsUrl`
 * is chosen per response by `GameRegistry` (ROADMAP 8.6, design/19 §6) and never enters
 * the ticket payload — the ticket is a seat authorization and knows no topology.
 */
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Matchmaker } from './Matchmaker';
import { RatingStore } from './rating';
import { PartyService } from './PartyService';
import { signTicket, type TicketPayload } from './ticket';
import { ticketSecret, teamIdForOwner, portalGameId } from './config';
import { GameRegistry } from './GameRegistry';
import { spawnBotClient } from './BotClient';
import { openDb } from './db';
import { openAnalyticsDb } from './analytics/db';
import { startRollupJob, type RollupJob } from './analytics/job';
import { AuthService } from './AuthService';
import { createPortalKeyStore } from './portalKeys';
import { send } from './routes/http';
import { createLogger, type Logger } from './log';
import { startHeartbeat } from './heartbeat';
import { lokiPushUrl } from './lokiPush';
import { gauge, processMetrics, renderMetrics, METRICS_CONTENT_TYPE, type Metric } from './metrics';
import * as matchRoutes from './routes/match';
import * as ratingRoutes from './routes/rating';
import * as partyRoutes from './routes/party';
import * as authRoutes from './routes/auth';
import type { PortalAuthDeps } from './routes/auth';
import * as accountRoutes from './routes/account';
import * as internalEntitlementRoutes from './routes/internalEntitlements';
import * as storeRoutes from './routes/store';
import * as telemetryRoutes from './routes/telemetry';
import { RateLimiter, RATE_LIMIT } from './routes/telemetry';
import type { BillingPlaneConfig } from './routes/store';

const PORT = Number(process.env.MATCH_PORT ?? 8788);
const HOST = process.env.HOST ?? '0.0.0.0';

export interface MatchsvcServerOptions {
  /** DB path override (design/16-accounts.md) — tests pass `':memory:'` for isolation;
   * defaults to `openDb`'s own real-file default. */
  dbPath?: string;
  /** Ticket-signing secret override — tests can pin a fixed value; defaults to `ticketSecret()`. */
  secret?: string;
  /**
   * Where `analytics.db` lives (design/21 §2.4), or `null` for "collect nothing".
   *
   * Unlike `dbPath` this has **no default path**, and the asymmetry is deliberate. Identity
   * has to persist wherever this process runs, so `openDb` falls back to a real file.
   * Analytics is optional, and an implicit default would make it collect into a file that
   * the backup worker — which discovers its sources by env var (`backup/config.ts`'s
   * `SOURCE_VARS`) — does not know about. Tying both to the same explicit
   * `BB_ANALYTICS_DB_PATH` keeps "is it collected" and "is it backed up" a single condition
   * rather than two that can disagree. It also means nothing is collected by accident,
   * which is the right default for the one subsystem with a privacy policy attached.
   */
  analyticsDbPath?: string | null;
  /**
   * Matchmaker timing overrides. The only reason this exists is `pvpBotFillMs`: PvP bot
   * backfill is a 30-SECOND wait by default, so `onBotFill` below — the block that mints a
   * ticket per empty seat and is the entire PvP-with-bots path players actually hit — could
   * not be reached by any test at a sane runtime, and was at 0% until 2026-09-03.
   */
  matchmaker?: { pvpBotFillMs?: number; queueTtlMs?: number; ticketTtlMs?: number };
  /**
   * Topology override (ROADMAP 8.6, design/19 §6). Defaults to a registry holding only
   * the configured static single instance — the one branch that is reachable today,
   * since the register/heartbeat routes are deliberately unbuilt. Injected so a test can
   * drive the paths a single-instance deployment cannot produce: several healthy
   * instances, a full one, a stale one, and no instance at all.
   */
  registry?: GameRegistry;
  /**
   * Portal-login dependencies (design/20 "account integration") — the CrazyGames key store,
   * the expected game id and the clock `/auth/portal` verifies a user token against.
   * Defaults to the real HTTPS key store plus `portalGameId()`; injected so a test can mint
   * its own RSA keypair and verify against it with no network at all, which is the only way
   * that route's success path is reachable offline.
   */
  portal?: PortalAuthDeps;
  /**
   * Bot spawner seam, defaulting to the real `spawnBotClient` (which opens a socket to
   * the gameserver the registry picked). Injected so a test can assert WHAT was minted for each empty seat —
   * the seat's owner index, its team, the signature — without standing up a gameserver.
   * The interesting logic here is `teamIdForOwner`, which decides whether a bot tops up a
   * real party's understaffed squad or starts a new one, and it is invisible from outside.
   */
  spawnBot?: typeof spawnBotClient;
  /**
   * Billing-plane overrides for the `/store/*` proxy (ROADMAP 8.8), merged over the
   * `config.ts`-derived defaults. Injected so a test can point the proxy at a stub billsvc —
   * an ephemeral-port server, or a bare `fetchImpl` — without touching `process.env` and
   * without standing up a third process. The mirror of `BillsvcServerOptions.pump`, which
   * exists for the same reason in the other direction.
   */
  billing?: Partial<BillingPlaneConfig>;
  /**
   * Observability seams (design/19 §10). `log` defaults to the real console logger; a
   * test passes one with a capturing sink so it can assert on a LINE rather than on a
   * `console` spy. `lokiUrl`/`fetchImpl` let `/client/log` be driven end to end with no
   * log store in reach — which is also production's normal state for a local dev run.
   */
  log?: Logger;
  lokiUrl?: string | null;
  fetchImpl?: typeof fetch;
}

/**
 * Builds the matchsvc HTTP server WITHOUT starting it (`server.listen()` is the
 * caller's job) — the seam that makes this file testable. `main()` below is the real
 * CLI entrypoint; `server/test/matchsvc.http.test.ts` calls this directly and binds an
 * ephemeral port instead, so real HTTP requests (including a real CORS preflight) can
 * be asserted without a network stub — the exact layer that let design/16-accounts.md's
 * missing-`authorization`-header CORS bug slip past every other test.
 */
export function createMatchsvcServer(opts: MatchsvcServerOptions = {}): Server {
  const secret = opts.secret ?? ticketSecret().secret;
  // Seeds only need to differ per room (the engine derives all determinism from seed +
  // inputs); a counter off the start time avoids Math.random and cross-restart collision.
  let seedCounter = Date.now() & 0x7fffffff;
  const spawnBot = opts.spawnBot ?? spawnBotClient;
  const registry = opts.registry ?? new GameRegistry();
  const matchmaker = new Matchmaker({
    ...opts.matchmaker,
    nowMs: () => Date.now(),
    nextSeed: () => (seedCounter = (seedCounter + 1) & 0x7fffffff),
    newRoomId: () => randomUUID(),
    sign: (payload) => signTicket(payload, secret),
    // PvP practice-bot backfill (design/15 follow-up): a queue that's sat too long forms
    // anyway with bots filling the empty seats. A bot redeems its own freshly-signed
    // ticket and opens the SAME ticket-authenticated gameserver socket a real player
    // would (BotClient.ts) — matchsvc is the trusted issuer, so it can mint one directly
    // without a round trip through its own /find queue.
    onBotFill: ({ roomId, seed, playerCount, mode, botOwners }) => {
      // Picked once for the room, not once per seat: the bots of one match belong on one
      // instance, exactly as its real players do. No gameserver → no socket for a bot to
      // open, so mint nothing; the real waiters in the same room get 503 from /find and
      // requeue, and a bot ticket with nowhere to go would just expire unredeemed.
      const gs = registry.pick();
      if (!gs) return;
      for (const owner of botOwners) {
        const exp = Date.now() + 30_000; // ample time for the bot to open the socket
        // teamIdForOwner is the SAME pure function Matchmaker.grantGroup used for the
        // real seats in this room — a bot always joins the squad chunk its seat index
        // falls into, topping up a real party's understaffed squad first.
        const teamId = teamIdForOwner(owner, playerCount);
        const grant: TicketPayload = { roomId, owner, seed, playerCount, teamId, exp, mode };
        spawnBot({
          wsUrl: gs.wsUrl,
          token: signTicket(grant, secret),
          roomId,
          owner,
          seed,
          playerCount,
        });
      }
    },
  });

  // The one thing 8.6 actually changes: where the WS URL stamped onto an issued ticket
  // comes from. It used to be a module constant; it is now whatever the registry picks,
  // which may legitimately be nothing (see `GameRegistry.pick`). The route group asks for
  // the instance and does the stamping, so it can refuse BEFORE consuming a queue entry.
  const pickGameserver = () => registry.pick();
  const db = openDb(opts.dbPath);
  const ratings = new RatingStore(db);
  const parties = new PartyService({
    nowMs: () => Date.now(),
    newPartyId: () => randomUUID(),
    newCode: partyRoutes.randomCode,
  });
  const auth = new AuthService(db);
  // Portal login (design/20 "account integration"). The key store is constructed eagerly but
  // fetches lazily — nothing leaves this process until the first `/auth/portal` call, so a
  // deployment that never serves a portal build makes no outbound request at all.
  const portal = opts.portal ?? { keys: createPortalKeyStore(), gameId: portalGameId() };

  // One bundle satisfying each route group's own narrow `*RouteDeps` interface. The groups
  // share no state, so this is a wiring convenience, not a shared context object — a
  // handler still declares (and can only reach) the few dependencies it names.
  const log = opts.log ?? createLogger('matchsvc');
  // Resolved ONCE, at construction. Reading the env per request would let a running
  // process silently change where a player's logs go, and would hide the single startup
  // warning that is the only signal an operator gets when it is unset (lokiPush.ts).
  const lokiUrl = opts.lokiUrl !== undefined ? opts.lokiUrl : lokiPushUrl();
  const limiter = new RateLimiter(RATE_LIMIT.requests, RATE_LIMIT.windowMs);

  // Analytics (design/21 §2.4). Resolved once, like `lokiUrl` and for the same reason.
  const analyticsPath = opts.analyticsDbPath !== undefined ? opts.analyticsDbPath : analyticsDbPathFromEnv();
  const analyticsDb = analyticsPath === null ? null : openAnalyticsDb(analyticsPath);
  // The job runs one cycle synchronously here, so a restarted process serves real gauges at
  // once. Its interval is `unref`ed, and it is stopped on the server's own close event —
  // which is what keeps a test file that builds a dozen servers from leaving a dozen timers.
  const rollup: RollupJob | null = analyticsDb === null ? null : startRollupJob({ db: analyticsDb, log });

  const deps = {
    matchmaker,
    pickGameserver,
    secret,
    ratings,
    parties,
    auth,
    db,
    portal,
    billing: opts.billing,
    log,
    lokiUrl,
    limiter,
    analyticsDb,
    fetchImpl: opts.fetchImpl,
  };

  const server = createServer((req, res) => {
    if (req.method === 'OPTIONS') return send(res, 204, {});
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const path = url.pathname;

    if (req.method === 'GET' && path === '/health') {
      return send(res, 200, { ok: true, service: 'daydayup-matchsvc' });
    }

    // Prometheus scrapes this over the compose network. matchsvc is the ONE service Caddy
    // proxies wholesale (`reverse_proxy wnet-test-matchsvc:8788` — server/deploy/README.md
    // §2), so unlike gameserver's and billsvc's it would otherwise be public: a free
    // readout of how many players are queued and how many accounts exist. Caddy stamps
    // `x-forwarded-for` on everything it proxies, so its presence is what "came from
    // outside" means here, and the answer is a plain 404 rather than a 403 — a 403 confirms
    // the route exists.
    if (req.method === 'GET' && path === '/metrics') {
      if (req.headers['x-forwarded-for'] !== undefined) return send(res, 404, { error: 'not found' });
      res.writeHead(200, { 'content-type': METRICS_CONTENT_TYPE });
      return res.end(renderMetrics(matchsvcMetrics(matchmaker, registry, rollup)));
    }

    if (req.method === 'POST' && path === telemetryRoutes.CLIENT_LOG_PATH) {
      return telemetryRoutes.postClientLog(req, res, url, deps);
    }
    if (req.method === 'POST' && path === telemetryRoutes.CLIENT_EVENTS_PATH) {
      return telemetryRoutes.postClientEvents(req, res, url, deps);
    }

    if (req.method === 'POST' && path === '/find') return matchRoutes.postFind(req, res, url, deps);
    if (req.method === 'GET' && matchRoutes.FIND_POLL_PATH.test(path)) {
      return matchRoutes.getFindPoll(req, res, url, deps);
    }
    if (req.method === 'POST' && path === '/resume') return matchRoutes.postResume(req, res, url, deps);

    if (req.method === 'POST' && path === '/rating/report') return ratingRoutes.postReport(req, res, url, deps);
    if (req.method === 'GET' && ratingRoutes.RATING_LOOKUP_PATH.test(path)) {
      return ratingRoutes.getRating(req, res, url, deps);
    }

    if (req.method === 'POST' && path === '/party/create') return partyRoutes.postCreate(req, res, url, deps);
    if (req.method === 'POST' && path === '/party/join') return partyRoutes.postJoin(req, res, url, deps);
    if (req.method === 'POST' && path === '/party/leave') return partyRoutes.postLeave(req, res, url, deps);
    if (req.method === 'POST' && path === '/party/start') return partyRoutes.postStart(req, res, url, deps);
    if (req.method === 'GET' && partyRoutes.PARTY_LOOKUP_PATH.test(path)) {
      return partyRoutes.getParty(req, res, url, deps);
    }

    if (req.method === 'POST' && path === '/auth/register') return authRoutes.postRegister(req, res, url, deps);
    if (req.method === 'POST' && path === '/auth/login') return authRoutes.postLogin(req, res, url, deps);
    if (req.method === 'POST' && path === '/auth/logout') return authRoutes.postLogout(req, res, url, deps);
    if (req.method === 'POST' && path === '/auth/portal') return authRoutes.postPortalLogin(req, res, url, deps);
    if (req.method === 'GET' && path === '/auth/me') return authRoutes.getMe(req, res, url, deps);
    if (req.method === 'POST' && path === '/auth/change-password') {
      return authRoutes.postChangePassword(req, res, url, deps);
    }

    if (req.method === 'GET' && path === '/account/meta') return accountRoutes.getMeta(req, res, url, deps);
    if (req.method === 'POST' && path === '/account/meta') return accountRoutes.postMeta(req, res, url, deps);

    // The store proxy (ROADMAP 8.8). Three player-facing routes that answer nothing here —
    // every one of them verifies the bearer session and then forwards to billsvc over 8.1's
    // internal seam. The `:id` GET is last because its pattern would also match a literal
    // `/store/order/` segment the POST above owns under a different method.
    if (req.method === 'GET' && path === '/store/skus') return storeRoutes.getSkus(req, res, url, deps);
    if (req.method === 'POST' && path === '/store/order') return storeRoutes.postOrder(req, res, url, deps);
    if (req.method === 'GET' && storeRoutes.STORE_ORDER_PATH.test(path)) {
      return storeRoutes.getOrder(req, res, url, deps);
    }

    // The one route no player ever calls (design/19 §4's closed delivery loop): billsvc's
    // outbox pump POSTs a settled purchase here over ROADMAP 8.1's internal key.
    if (req.method === 'POST' && path === internalEntitlementRoutes.INTERNAL_GRANT_PATH) {
      return internalEntitlementRoutes.postGrant(req, res, url, deps);
    }

    send(res, 404, { error: 'not found' });
  });

  // Stopping the job here rather than exposing it: the builder's return type is a plain
  // `Server` and every caller already knows how to close one.
  if (rollup) server.on('close', () => rollup.stop());

  return server;
}

/**
 * `BB_ANALYTICS_DB_PATH`, or `null` when it is unset or empty.
 *
 * An empty value is treated as unset, which design/19 §9 records as a mistake this project
 * has already paid for once: an env var set to `""` beats a `??` fallback, and a compose
 * file with a trailing `BB_ANALYTICS_DB_PATH:` and no value produces exactly that. Here the
 * consequence would be `openAnalyticsDb('')` — a path SQLite reads as a temporary
 * database, so collection would appear to work and vanish on restart.
 */
export function analyticsDbPathFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.BB_ANALYTICS_DB_PATH?.trim();
  return raw !== undefined && raw.length > 0 ? raw : null;
}

/**
 * What only matchsvc knows. Two gauges, and both were chosen because a question exists for
 * them: "is anybody waiting and not getting matched?" (the queue depths, split by mode
 * because a co-op queue and a PvP queue fill at completely different rates) and "is there
 * anywhere to send them?" (the registry, whose empty state makes every `/find` answer 503
 * while every container stays green).
 */
export function matchsvcMetrics(
  matchmaker: Matchmaker,
  registry: GameRegistry,
  rollup?: RollupJob | null,
): Metric[] {
  return [
    ...processMetrics('matchsvc'),
    gauge('bb_matchsvc_queue_waiting', 'Players waiting in the matchmaking queue.', matchmaker.waiting(2, 'coop'), {
      mode: 'coop',
      playerCount: '2',
    }),
    gauge('bb_matchsvc_queue_waiting', 'Players waiting in the matchmaking queue.', matchmaker.waiting(2, 'pvp'), {
      mode: 'pvp',
      playerCount: '2',
    }),
    gauge(
      'bb_matchsvc_gameservers_available',
      'Gameserver instances the registry would hand a new match to. Zero means every /find answers 503.',
      registry.pick() ? 1 : 0,
    ),
    // The analytics rollup's cached gauges (design/21 §2.5). A field read, not a query —
    // see `analytics/job.ts` for why the scrape must not recompute. Absent entirely when
    // analytics is off, and absent for any retention offset that cannot be answered yet,
    // which is what makes a dashboard say "No data" instead of "0% came back".
    ...(rollup?.metrics() ?? []).map((m) => ({ ...m })),
  ];
}

/**
 * The data-plane half of the startup banner. Extracted from `main` because it is the one
 * branch there — a matchsvc with no gameserver behind it starts fine and refuses every
 * `/find`, and the log line is the only place an operator learns that before a player
 * does. `main` itself stays a straight-line listen/log, which is why it needs no test.
 */
export function startupTarget(registry: GameRegistry): string {
  return registry.pick()?.wsUrl ?? '(no gameserver — /find will answer 503)';
}

function main(): void {
  const log = createLogger('matchsvc');
  const registry = new GameRegistry();
  const server = createMatchsvcServer({ registry, log });
  server.listen(PORT, HOST, () => {
    log.info('control plane listening', { addr: `http://${HOST}:${PORT}`, gameserver: startupTarget(registry) });
    // Beats once immediately, then every 5 minutes — see heartbeat.ts for why an idle log
    // store and a broken one are otherwise the same picture.
    startHeartbeat({ log });
  });
}

// Only auto-start when run directly (`node --import tsx/esm src/matchsvc.ts`), not when
// imported by a test — the ESM equivalent of `require.main === module`, needed now that
// `createMatchsvcServer` is a real importable export (design/16-accounts.md).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
