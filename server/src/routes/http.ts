/**
 * Split of `matchsvc.ts` (P0, 2026-09-04, prep for ROADMAP Phase 8) — the transport
 * primitives every route group in this directory shares: the CORS header block, the JSON
 * responder, the bounded JSON body reader, and the one shape a route handler has.
 *
 * This file owns no service and no route. It deliberately sits BELOW `routes/*` and below
 * the `matchsvc.ts` shell, so a handler may import it while nothing here imports a handler
 * back — CLAUDE.md's rule that a split-out sibling never imports the assembly shell (which
 * is what a `send` left behind in `matchsvc.ts` would have forced).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * The uniform shape of a matchsvc route handler: the request, the response, the already
 * parsed URL (a handler owning a `/:param` route re-matches its own pattern out of this
 * rather than taking a positional capture), and its group's typed dependency bundle.
 *
 * Handlers are free functions, not methods — the whole point of the split. `matchsvc.ts`
 * keeps the dispatch chain that decides which one runs.
 */
export type RouteHandler<D> = (req: IncomingMessage, res: ServerResponse, url: URL, deps: D) => void;

export const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  // 'authorization' (design/16-accounts.md) — every /auth/me and /account/* call sends
  // a bearer token; omitting it here makes the browser's CORS preflight reject the
  // real request before it's even sent (fails as a bare "Failed to fetch", no server
  // log at all — caught live via claude-in-chrome, not by any unit test, since node's
  // fetch/undici and curl don't enforce browser CORS preflight rules).
  'access-control-allow-headers': 'content-type, authorization',
  /**
   * How long a browser may reuse this preflight result. Found live, 2026-09-09: every
   * `POST /client/events` in a real session was preceded by its own `OPTIONS`, because
   * without this header the result is not cached at all.
   *
   * It matters for one request in particular and it is the one that cannot be retried. The
   * telemetry routes flush on `pagehide`, which is why they use `fetch(keepalive)` — but
   * `keepalive` protects the request the page has already STARTED, and an uncached preflight
   * makes the exit flush two sequential round trips with an unloading document behind them.
   * A cached preflight makes it one. That is precisely the `session_end` half of the churn
   * funnel, and `funny` lost every one of those events to the same class of mistake.
   *
   * 600s rather than longer: browsers cap it anyway (Chrome at 2h) and a shorter window
   * costs one preflight every ten minutes while keeping a changed CORS policy from being
   * remembered for a day. Every route shares the block, so the login and store routes get
   * the same saving.
   */
  'access-control-max-age': '600',
};

export function send(res: ServerResponse, status: number, body: unknown): void {
  const json = status === 204 ? '' : JSON.stringify(body);
  res.writeHead(status, { ...CORS, 'content-type': 'application/json' });
  res.end(json);
}

/**
 * The size every route but one is bounded by. A `/find`, a login, a store order and a
 * settlement report are all a few hundred bytes; nothing legitimate approaches this.
 */
export const DEFAULT_BODY_LIMIT = 4096;

/** Read a JSON request body (bounded), then invoke `done`. Malformed/oversized → {}. */
export function readJson(req: IncomingMessage, done: (body: unknown) => void): void {
  readJsonUpTo(req, DEFAULT_BODY_LIMIT, done);
}

/**
 * `readJson` with the limit named at the call site — for the one route whose legitimate
 * body is not small: `/client/log` ships a batch of up to 200 browser log lines
 * (`clientLog.ts`'s `LIMITS`), which does not fit in 4 KB and must not be silently halved
 * into a parse failure.
 *
 * Overflow behaviour is the same as it has always been and is worth being explicit about:
 * the tail past `limit` is DROPPED, so what reaches `JSON.parse` is truncated JSON, which
 * throws, which yields `{}`. A caller therefore sees "nothing usable" rather than a
 * half-read object — the safe direction, and the reason no route here has to defend
 * against a partially-parsed body.
 */
export function readJsonUpTo(req: IncomingMessage, limit: number, done: (body: unknown) => void): void {
  const chunks: Buffer[] = [];
  let size = 0;
  req.on('data', (c: Buffer) => {
    size += c.length;
    if (size > limit) return; // ignore the overflow tail
    chunks.push(c);
  });
  req.on('end', () => {
    try {
      done(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
    } catch {
      done({});
    }
  });
  req.on('error', () => done({}));
}
