/**
 * The two routes a browser may POST to without a session: `POST /client/log` (log lines, on
 * their way to the same store the four backend containers write to) and `POST /client/events`
 * (analytics, on its way to `analytics.db` — design/21 §2.3).
 *
 * These are the only routes in this directory that accept a body from anybody at all: no
 * session required, deliberately, and for the same reason twice. The errors most worth
 * having are the ones that happen INSTEAD of a login — a boot failure, a WebGL context that
 * never came back, an asset that 404s on one build target — and gating on a session would
 * collect logs from exactly the players whose client is working. Retention is the same
 * argument from the other end: a player who never logs in is precisely who "did they come
 * back?" is a question about.
 *
 * That makes it the widest trust boundary this server has, so it is built from refusals:
 *
 *  - **A bounded body**, read with an explicit limit rather than the 4 KB every other
 *    route uses (`http.ts`'s `readJsonUpTo`).
 *  - **A per-IP rate limit**, in-process, before any parsing work.
 *  - **Caps and allowlists on every client-supplied value**, in `clientLog.ts` and
 *    `analytics/ingest.ts`.
 *  - **A fixed three-name label set**, so nothing a caller sends can create a Loki stream;
 *    and, on the analytics side, a CLOSED event vocabulary, so nothing a caller sends can
 *    create a row type.
 *
 * And from one thing it does NOT do: it never lets any of that reach the player. Every
 * outcome is `200 {ok:true, accepted:N}` — a refused batch reports `accepted: 0`, not a
 * 4xx, because a 4xx teaches a client to retry and a client retrying a malformed batch
 * retries it forever. The push to Loki is `void`-ed, so a log store that is down or slow
 * cannot delay this response by a millisecond.
 *
 * The account id, when there is one, is resolved HERE from the request's bearer token and
 * never read from the body — otherwise the one field that says whose session this was
 * would be the one field anybody could write.
 *
 * ## One rate limiter, shared
 *
 * Both routes take from the same per-IP budget. A legitimate client makes two requests per
 * 30s window across the pair, against a limit of 20 per minute, so sharing costs nothing —
 * and it means the budget bounds what one address can do to this server rather than what it
 * can do to one of its endpoints.
 */
import type { IncomingMessage } from 'node:http';
import type { AuthService } from '../AuthService';
import type { Logger } from '../log';
import type { DatabaseSync } from 'node:sqlite';
import { buildLokiPayload, parseBatch, LIMITS } from '../clientLog';
import { pushToLoki } from '../lokiPush';
import { parseAnalyticsBatch } from '../analytics/ingest';
import { writeBatch } from '../analytics/store';
import { LIMITS as ANALYTICS_LIMITS } from '@dd/net/analyticsEvents';
import { readJsonUpTo, send, type RouteHandler } from './http';
import { requireAuth } from './auth';

/**
 * 200 entries x (1000-char message + fields) is ~250 KB at the absolute worst; 384 KB
 * leaves room for JSON overhead without letting one request hold a megabyte of buffer.
 */
export const CLIENT_LOG_BODY_LIMIT = 384 * 1024;

/**
 * The analytics batch is much smaller than a log batch: 100 events, each a short name, a
 * timestamp and at most three small fields. 64 KB is roughly eight times the largest
 * legitimate body, which leaves the limit doing its job without ever being reached by a
 * real client.
 */
export const CLIENT_EVENTS_BODY_LIMIT = 64 * 1024;

/** Requests per IP per window, SHARED by both routes (see the file header). A client flushes
 *  each of them every 30s, so this is ten times the legitimate rate — a limit that only a
 *  loop can reach. */
export const RATE_LIMIT = { requests: 20, windowMs: 60_000 } as const;

export interface TelemetryRouteDeps {
  auth: AuthService;
  log: Logger;
  /** The push target, resolved once at startup by `matchsvc.ts` (`lokiPushUrl()`). */
  lokiUrl: string | null;
  /**
   * Per-IP request budget. Owned by the deps bundle rather than a module singleton
   * deliberately: a singleton is shared state between every server a test file builds, so
   * one test exhausting the budget would silently change the next test's answer — the
   * classic order-dependent suite. `matchsvc.ts` constructs exactly one per process.
   */
  limiter: RateLimiter;
  /** Injected by tests to observe the push without a network, and to freeze the clock. */
  fetchImpl?: typeof fetch;
  now?: () => number;
  /**
   * The analytics database, or null when this process has none.
   *
   * Nullable rather than required, and the null arm is reachable rather than defensive: a
   * test that only exercises the log route does not need one, and — the case that matters —
   * a deployment that has not set `BB_ANALYTICS_DB_PATH` should keep serving the game while
   * quietly collecting nothing, not fail to boot. `postClientEvents` answers
   * `accepted: 0` in that state, exactly as it does for a refused batch, because from the
   * client's side those two are the same fact.
   */
  analyticsDb?: DatabaseSync | null;
}

/**
 * A fixed-window counter per client IP.
 *
 * In-process on purpose: matchsvc is one container (`docker-compose.yml`), so a shared
 * store would add a dependency to make a single process agree with itself. If a second
 * instance is ever run, this becomes per-instance — which is a weaker limit, not a broken
 * one, and is noted here rather than left to be discovered.
 *
 * The map is swept on write rather than on a timer: a timer would keep the process alive
 * (or need `unref`), and the sweep is over a map whose size is bounded by the number of
 * distinct IPs inside one 60s window.
 */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; windowStart: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** True when this request is allowed. */
  take(key: string, nowMs: number): boolean {
    for (const [k, v] of this.hits) if (nowMs - v.windowStart >= this.windowMs) this.hits.delete(k);
    const entry = this.hits.get(key);
    if (!entry || nowMs - entry.windowStart >= this.windowMs) {
      this.hits.set(key, { count: 1, windowStart: nowMs });
      return true;
    }
    entry.count += 1;
    return entry.count <= this.limit;
  }
}

/**
 * The caller's address as the rate-limit key.
 *
 * Every real request arrives through Caddy on the same host, so `socket.remoteAddress` is
 * the proxy for all of them and would make the limit global rather than per-client. Caddy
 * appends the real client to `X-Forwarded-For`, and the LAST entry is the one it added
 * itself — earlier entries are attacker-supplied and taking the first is the classic way to
 * make a per-IP limit trivially evadable. Falls back to the socket address for a direct
 * request (a health probe, a test), and to a constant when even that is absent, which
 * makes the limit stricter rather than looser.
 */
export function clientKey(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  const chain = Array.isArray(forwarded) ? forwarded.join(',') : (forwarded ?? '');
  const hops = chain
    .split(',')
    .map((h) => h.trim())
    .filter((h) => h.length > 0);
  return hops.length > 0 ? hops[hops.length - 1]! : (req.socket.remoteAddress ?? 'unknown');
}

export const postClientLog: RouteHandler<TelemetryRouteDeps> = (req, res, _url, deps) => {
  const now = deps.now ?? Date.now;
  const at = now();

  if (!deps.limiter.take(clientKey(req), at)) {
    // Still a 200. A 429 would be more honest and would also be the one answer that makes
    // a misbehaving client retry harder; the batch is dropped either way.
    return send(res, 200, { ok: true, accepted: 0 });
  }

  // Resolved before the body is read so the answer never depends on how big the body was.
  const session = requireAuth(req, deps.auth);

  readJsonUpTo(req, CLIENT_LOG_BODY_LIMIT, (body) => {
    const batch = parseBatch(body);
    if (!batch) return send(res, 200, { ok: true, accepted: 0 });

    const payload = buildLokiPayload({
      batch,
      serverNowMs: now(),
      accountId: session?.accountId,
    });

    // Never awaited — see lokiPush.ts's header. The response below is already correct
    // whether the store accepts, refuses or is not there at all.
    void pushToLoki({ url: deps.lokiUrl, log: deps.log, fetchImpl: deps.fetchImpl, now }, payload);

    send(res, 200, { ok: true, accepted: batch.entries.length });
  });
};

/**
 * `POST /client/events` — analytics (design/21 §2.3).
 *
 * Structurally the same as the route above and deliberately so: same limiter, same IP key,
 * same "every outcome is 200 with a count" contract. What differs is only where the rows
 * go, and one thing worth stating: the write is SYNCHRONOUS, unlike the Loki push, because
 * `node:sqlite` is synchronous and there is nothing to await. That makes the write part of
 * the request, so it is wrapped — a database error must answer `accepted: 0` and be logged,
 * never surface to the player and never take the process down.
 */
export const postClientEvents: RouteHandler<TelemetryRouteDeps> = (req, res, _url, deps) => {
  const now = deps.now ?? Date.now;

  if (!deps.limiter.take(clientKey(req), now())) {
    return send(res, 200, { ok: true, accepted: 0 });
  }

  const session = requireAuth(req, deps.auth);
  const db = deps.analyticsDb ?? null;

  readJsonUpTo(req, CLIENT_EVENTS_BODY_LIMIT, (body) => {
    if (db === null) return send(res, 200, { ok: true, accepted: 0 });
    const batch = parseAnalyticsBatch(body, now());
    if (!batch) return send(res, 200, { ok: true, accepted: 0 });

    try {
      const written = writeBatch(db, batch, session?.accountId ?? null);
      send(res, 200, { ok: true, accepted: written.events });
    } catch (e) {
      // A failed write is worth a line in the log store, because the alternative is a
      // dashboard that goes flat with nothing anywhere saying why.
      deps.log.warn('analytics write failed', { err: (e as Error).message });
      send(res, 200, { ok: true, accepted: 0 });
    }
  });
};

/** Exported for the deploy manifest test and for `matchsvc.ts`'s dispatch chain. */
export const CLIENT_LOG_PATH = '/client/log';
export const CLIENT_LOG_MAX_ENTRIES = LIMITS.entries;
export const CLIENT_EVENTS_PATH = '/client/events';
export const CLIENT_EVENTS_MAX_ENTRIES = ANALYTICS_LIMITS.eventsPerBatch;
