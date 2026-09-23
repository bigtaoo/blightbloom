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
 *   POST /find             { playerCount, mode?, partyId? } -> { queueId, match? } | 429  routes/match
 *   GET  /find/:id                                       -> { status: 'queued'|'matched'|'expired', match? }
 *   POST /resume            { token }                     -> { match } | 401 (ROADMAP reconnect)
 *   POST /rating/report     { accountIds, places, teamIds? } -> { changes: [{accountId,before,after}] }
 *   GET  /rating/:accountId                               -> { accountId, rating }    routes/rating
 *   POST /party/create      { playerId }                 -> PartyInfo | 429            routes/party
 *   POST /party/join        { playerId, code }           -> PartyInfo | 404 | 429
 *   POST /party/leave       { partyId, playerId }        -> PartyInfo | null
 *   POST /party/start       { partyId, playerId }        -> PartyInfo | 404 (leader only)
 *   GET  /party/:id                                       -> PartyInfo | 404
 *   POST /auth/register     { username, password }        -> { accountId, username, token } | 400 | 429
 *   POST /auth/login        { username, password }        -> { accountId, username, token } | 401 | 429
 *   POST /auth/logout       { token }                      -> { ok: true }             routes/auth
 *   POST /auth/portal       { token }  (a CrazyGames user token) -> { accountId, username, token } | 401/503 | 429
 *   GET  /auth/me           (Bearer token)                 -> { accountId, username } | 401
 *   POST /auth/change-password { token, oldPassword, newPassword } -> { ok: true } | 400/401 | 429
 *   GET  /account/meta      (Bearer token, x-guest-id) -> { data: MetaState | null, entitlements, guestMerged } | 401
 *   POST /account/meta      (Bearer token) { data }        -> { ok: true } | 400/401    routes/account
 *   POST /account/guest-merge (Bearer token) { guestId }   -> { claimed } | 400/401
 *   GET  /store/skus        (Bearer token)  -> { skus } | 401/502                       routes/store
 *   POST /store/order       (Bearer token) { sku, platform } -> { order, payment } | 400/401/502 | 429
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
import { createServer, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { Db } from 'mongodb';
import { Matchmaker } from './Matchmaker';
import { RatingStore } from './rating';
import { PartyService } from './PartyService';
import { signTicket, type TicketPayload } from './ticket';
import {
  ticketSecret,
  teamIdForOwner,
  portalGameId,
  adminPlaneUrl,
  sharedInternalKey,
  INTERNAL_CALLER_MATCHSVC,
} from './config';
import { createFlagClient, type FlagClient } from './flags/client';
import { GameRegistry } from './GameRegistry';
import { spawnBotClient } from './BotClient';
import { accountsStore, ensureAccountsIndexes, type AccountsStore } from './db';
import { connectMongo, store as mongoStore } from './mongo';
import { analyticsEnabledFromEnv, ensureAnalyticsIndexes } from './analytics/db';
import { startRollupJob, type RollupJob } from './analytics/job';
import { AuthService } from './AuthService';
import { createPortalKeyStore } from './portalKeys';
import { send } from './routes/http';
import { dispatch, type DispatchContext } from './matchsvcDispatch';
import { createLogger, type Logger } from './log';
import { startHeartbeat } from './heartbeat';
import { lokiPushUrl } from './lokiPush';
import * as partyRoutes from './routes/party';
import { type PortalAuthDeps } from './routes/auth';
import { createLimiters } from './limitsTable';
import type { Limiters } from './routes/limits';
import type { BillingPlaneConfig } from './routes/store';

const PORT = Number(process.env.MATCH_PORT ?? 8788);
const HOST = process.env.HOST ?? '0.0.0.0';

export interface MatchsvcServerOptions {
  /**
   * Feature flags (design/21 §4), or one built from the environment when omitted.
   *
   * The fail-safe direction is already the default: a client with no `BB_ADMINSVC_URL`
   * polls nothing and answers every `get` from `defaultFlags()`, which is the shipped
   * behaviour. A test that wants a pinned value passes its own client; a test that does not
   * care passes nothing and gets the compiled-in defaults.
   */
  flags?: FlagClient;
  /**
   * The control plane's collections (design/16-accounts.md). INJECTED rather than opened
   * here, which is what keeps this builder synchronous: connecting to the cluster is
   * asynchronous, and making the builder async would ripple into every test that constructs
   * a server. `main` connects once and hands the result in; a test passes a throwaway
   * database from `test/mongoHarness.ts`.
   */
  store: AccountsStore;
  /** Ticket-signing secret override — tests can pin a fixed value; defaults to `ticketSecret()`. */
  secret?: string;
  /**
   * Per-budget limiter overrides, merged over the shipped set below. Injected for the same
   * reason `matchmaker` above is: every shipped budget is tens to hundreds of requests per
   * ten minutes, which no test can exhaust at a sane runtime, so each 429 arm would otherwise
   * be unreachable from the HTTP layer.
   *
   * ONE option rather than the `authLimiter`/`joinLimiter` pair it replaces (2026-09-22).
   * Those two arrived a fortnight apart and each cost an option here, a field on the bundle,
   * a field on the route group's deps and a paragraph saying it is not the other one — a
   * per-route tax on the cheapest thing this server has, and the reason five routes that
   * wanted a budget never got one. `routes/limits.ts` has the full argument.
   *
   * `Partial`, and merged by key, so a test names the one budget it drives and inherits the
   * shipped value for everything else. An absent key is never "no limit": {@link Limiters}
   * requires every key, so the merge below always produces a complete set.
   */
  limits?: Partial<Limiters>;
  /**
   * The `analytics` database (design/21 §2.4), or `null`/absent for "collect nothing".
   *
   * A `Db` rather than the `analyticsDbPath` this took until the MongoDB port, because
   * there is no file to open any more: the handle comes from the process-wide pooled client
   * (`mongo.ts`'s `store('analytics')`), which only exists after `connectMongo()` has been
   * awaited at boot. Whoever supplies it must also have awaited `ensureAnalyticsIndexes` —
   * the cohort table's exactly-once claim IS its unique index.
   *
   * Absent still means OFF, and that asymmetry with `dbPath` is deliberate and unchanged.
   * Identity has to persist wherever this process runs; analytics is optional, and nothing
   * should be collected by accident in the one subsystem with a privacy policy attached.
   */
  analyticsDb?: Db | null;
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
export function createMatchsvcServer(opts: MatchsvcServerOptions): Server {
  const secret = opts.secret ?? ticketSecret().secret;
  // Seeds only need to differ per room (the engine derives all determinism from seed +
  // inputs); a counter off the start time avoids Math.random and cross-restart collision.
  let seedCounter = Date.now() & 0x7fffffff;
  const spawnBot = opts.spawnBot ?? spawnBotClient;
  const registry = opts.registry ?? new GameRegistry();
  // Hoisted above the matchmaker (it used to sit further down) because the flag client
  // needs it and the matchmaker needs the flag client.
  const log = opts.log ?? createLogger('matchsvc');
  // Feature flags (design/21 §4). Built before the matchmaker because two of its timings
  // are flags. `start()` is deliberately NOT called here: it arms an interval, and a
  // builder that arms one cannot be called by a test without leaving it running — the same
  // rule `billsvc/main.ts` follows for the delivery pump. `main` starts it.
  const flags = opts.flags ?? defaultFlagClient(log);
  const matchmaker = new Matchmaker({
    // The three live timings (design/21 §4). SUPPLIERS, not numbers: a value captured at
    // construction would only take effect on the next restart, i.e. it would not be a flag.
    // Spread BEFORE `opts.matchmaker` so a test that pins any of them still wins — this is
    // the deployment's default, not an override.
    queueTtlMs: () => flags.get('match.queueTimeoutMs'),
    pvpBotFillMs: () => flags.get('match.pvpBotBackfillDelayMs'),
    coopBotFillMs: () => flags.get('match.coopBotBackfillDelayMs'),
    ...opts.matchmaker,
    nowMs: () => Date.now(),
    nextSeed: () => (seedCounter = (seedCounter + 1) & 0x7fffffff),
    newRoomId: () => randomUUID(),
    sign: (payload) => signTicket(payload, secret),
    // Practice-bot backfill (design/15 follow-up; extended to co-op 2026-09-17): a queue
    // that's sat too long forms anyway with bots filling the empty seats. A bot redeems its
    // own freshly-signed ticket and opens the SAME ticket-authenticated gameserver socket a
    // real player would (BotClient.ts) — matchsvc is the trusted issuer, so it can mint one
    // directly without a round trip through its own /find queue.
    //
    // Nothing here branches on `mode`, and that is the point: the ticket a co-op ally seat
    // gets is the same grant shape a PvP practice bot's is, and the bot learns which brain
    // to run from the `match_start` the gameserver sends it — not from anything minted
    // here, which is the only version of this that cannot disagree with the real clients in
    // the same room (design/06 anti-drift).
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
  const store = opts.store;
  const ratings = new RatingStore(store);
  const parties = new PartyService({
    nowMs: () => Date.now(),
    newPartyId: () => randomUUID(),
    newCode: partyRoutes.randomCode,
  });
  const auth = new AuthService(store);
  // Portal login (design/20 "account integration"). The key store is constructed eagerly but
  // fetches lazily — nothing leaves this process until the first `/auth/portal` call, so a
  // deployment that never serves a portal build makes no outbound request at all.
  const portal = opts.portal ?? { keys: createPortalKeyStore(), gameId: portalGameId() };

  // One bundle satisfying each route group's own narrow `*RouteDeps` interface. The groups
  // share no state, so this is a wiring convenience, not a shared context object — a
  // handler still declares (and can only reach) the few dependencies it names.
  // Resolved ONCE, at construction. Reading the env per request would let a running
  // process silently change where a player's logs go, and would hide the single startup
  // warning that is the only signal an operator gets when it is unset (lokiPush.ts).
  const lokiUrl = opts.lokiUrl !== undefined ? opts.lokiUrl : lokiPushUrl();
  const limits = createLimiters(opts.limits);

  // Analytics (design/21 §2.4). Injected rather than opened here since the MongoDB port —
  // see `MatchsvcServerOptions.analyticsDb`. Until this process's own boot path awaits
  // `connectMongo()`, an absent option means this deployment collects nothing.
  const analyticsDb = opts.analyticsDb ?? null;
  // The job kicks off one cycle here, so a restarted process serves real gauges as soon as
  // the cluster answers. Its interval is `unref`ed, and it is stopped on the server's own
  // close event — which is what keeps a test file that builds a dozen servers from leaving
  // a dozen timers.
  const rollup: RollupJob | null = analyticsDb === null ? null : startRollupJob({ db: analyticsDb, log });

  const deps = {
    matchmaker,
    pickGameserver,
    secret,
    ratings,
    parties,
    auth,
    store,
    portal,
    billing: opts.billing,
    log,
    lokiUrl,
    limits,
    analyticsDb,
    flags,
    fetchImpl: opts.fetchImpl,
  };

  const ctx: DispatchContext = { deps, matchmaker, registry, rollup };

  /**
   * The ERROR BOUNDARY, and it is new with the MongoDB port rather than tidiness.
   *
   * Until 2026-09-15 every handler was synchronous over a local SQLite file: a throw was a
   * programming bug, it was rare, and there was no boundary here at all. Handlers now await a
   * network database, so a transient failure — a failover, a pool timeout, a dropped
   * connection to Atlas — arrives as a REJECTED PROMISE on an ordinary request. With no
   * boundary Node treats that as an unhandled rejection and takes the whole process down,
   * turning a blip that should have been one 500 into an outage for every player connected to
   * this service.
   *
   * `headersSent` is checked because a handler that already started a response cannot be given
   * a status code; there the connection is simply destroyed, which is the only honest ending.
   */
  const server = createServer((req, res) => {
    let result: void | Promise<void>;
    try {
      result = dispatch(req, res, ctx);
    } catch (e) {
      return failRequest(res, e);
    }
    if (result) void result.catch((e: unknown) => failRequest(res, e));
  });

  function failRequest(res: ServerResponse, e: unknown): void {
    log.error('matchsvc: request failed', { error: e instanceof Error ? e.message : String(e) });
    if (res.headersSent) {
      res.destroy();
      return;
    }
    send(res, 500, { error: 'internal error' });
  }

  // Stopping both background things here rather than exposing them: the builder's return
  // type is a plain `Server` and every caller already knows how to close one. The flag
  // client's interval is `unref`ed anyway, so this is tidiness for a test rather than a
  // process that would otherwise hang — but a poll firing against a closed server is a
  // pointless request and a confusing log line.
  if (rollup) server.on('close', () => rollup.stop());
  server.on('close', () => flags.stop());
  // Hung off the server so `main` can arm it without the builder's signature changing, and
  // so nothing else can reach it — `startFlagPolling` below is the only caller.
  FLAG_CLIENTS.set(server, flags);

  return server;
}

/**
 * The flag client this process uses when nothing was injected.
 *
 * `adminPlaneUrl()` returns `null` when `BB_ADMINSVC_URL` is unset, and that is the state of
 * every deployment that has not opted into a flag store — the client then polls nothing and
 * answers every `get` from `defaultFlags()`. Fail-safe by configuration as well as by
 * failure (`flags/client.ts`'s header).
 */
function defaultFlagClient(log: Logger): FlagClient {
  return createFlagClient({
    baseUrl: adminPlaneUrl(),
    key: sharedInternalKey(),
    caller: INTERNAL_CALLER_MATCHSVC,
    log,
  });
}

/**
 * The flag client belonging to a built server, so `main` can start its poll loop without
 * `createMatchsvcServer` returning something other than a `Server`.
 *
 * A `WeakMap` rather than a module-level variable: a test file builds a dozen servers, and
 * one shared slot would mean the eleventh test's `start()` armed the twelfth's client. Weak
 * so a closed server's entry goes away with it.
 */
const FLAG_CLIENTS = new WeakMap<Server, FlagClient>();

/** Arms the flag poll for a built server. Called by `main` only — see the comment on
 *  `FLAG_CLIENTS`, and `flags/client.ts` on why `start` is not part of the builder. */
export function startFlagPolling(server: Server): FlagClient | undefined {
  const client = FLAG_CLIENTS.get(server);
  client?.start();
  return client;
}


/**
 * matchsvc's own gauges live in `matchsvcMetrics.ts` since 2026-09-09 (Phase C's flag
 * wiring pushed this file past the 500-line convention) and are re-exported here unchanged,
 * so `metrics.test.ts` and `deploy.dashboardMetrics.test.ts` keep the import they have.
 */
export { matchsvcMetrics } from './matchsvcMetrics';

/**
 * The data-plane half of the startup banner. Extracted from `main` because it is the one
 * branch there — a matchsvc with no gameserver behind it starts fine and refuses every
 * `/find`, and the log line is the only place an operator learns that before a player
 * does. `main` itself stays a straight-line listen/log, which is why it needs no test.
 */
export function startupTarget(registry: GameRegistry): string {
  return registry.pick()?.wsUrl ?? '(no gameserver — /find will answer 503)';
}

async function main(): Promise<void> {
  const log = createLogger('matchsvc');
  const registry = new GameRegistry();
  // Connect BEFORE binding a port. A bad URI, a firewalled cluster or a wrong password is a
  // boot failure here rather than a 500 on some player's first request — the same posture
  // `billsvc/startupGuard.ts` takes toward its own configuration. `ensureAccountsIndexes` is
  // idempotent and runs on every boot, which is what keeps a freshly created Atlas database
  // correct without a separate migration step.
  await connectMongo();
  const accountsDb = mongoStore('accounts');
  await ensureAccountsIndexes(accountsDb);
  // Analytics is the one store this process opens conditionally — see
  // `analyticsEnabledFromEnv`. `null` is "collect nothing", and it is the default.
  // `ensureAnalyticsIndexes` runs only on the opted-in path, so a deployment that collects
  // nothing also creates nothing: an operator looking at the cluster can tell the two apart.
  let analyticsDb: Db | null = null;
  if (analyticsEnabledFromEnv()) {
    analyticsDb = mongoStore('analytics');
    await ensureAnalyticsIndexes(analyticsDb);
  }
  const server = createMatchsvcServer({ registry, log, store: accountsStore(accountsDb), analyticsDb });
  server.listen(PORT, HOST, () => {
    log.info('control plane listening', { addr: `http://${HOST}:${PORT}`, gameserver: startupTarget(registry) });
    // Arms the flag poll, and does one immediate cycle — so a restarted process is on the
    // operator's current values rather than on its defaults for the first minute.
    startFlagPolling(server);
    // Beats once immediately, then every 5 minutes — see heartbeat.ts for why an idle log
    // store and a broken one are otherwise the same picture.
    startHeartbeat({ log });
  });
}

// Only auto-start when run directly (`node --import tsx/esm src/matchsvc.ts`), not when
// imported by a test — the ESM equivalent of `require.main === module`, needed now that
// `createMatchsvcServer` is a real importable export (design/16-accounts.md).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  // `main` awaits the cluster now, so its rejection has to be handled here or it becomes an
  // unhandled rejection with no log line at all — which is precisely the boot failure an
  // operator most needs to read.
  main().catch((e: unknown) => {
    console.error(`[blightbloom] matchsvc: failed to start — ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  });
}
