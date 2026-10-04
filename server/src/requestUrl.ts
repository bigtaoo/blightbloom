/**
 * The URL a service routes a request on, or `null` when the request does not name one.
 *
 * Every service here builds it the same way — the request target resolved against the
 * client's own `Host` header — and that header is whatever the client sent. `new URL` THROWS
 * on a host it cannot parse (`a b`, `[`, a port past 65535), and until 2026-10-04 each service
 * called it bare: matchsvc's error boundary turned the throw into a 500 and an ERROR log line,
 * while billsvc and adminsvc have no boundary around their request listener and the
 * gameserver parsed it inside the socket's `connection` event — in all three an uncaught
 * exception, which with no process-wide handler takes the process down.
 *
 * Production's Caddy only routes a request whose host matches the site block, so none of that
 * was reachable from outside. It still was from anything that reaches a port directly, and a
 * service's correctness should not rest on the proxy in front of it. `URL.parse` returns
 * `null` instead of throwing, and each caller answers that with a 400 — the client's request
 * is what is wrong, so it is neither a 500 nor worth an error line.
 */
import type { IncomingMessage } from 'node:http';

export function requestUrl(req: Pick<IncomingMessage, 'url' | 'headers'>, scheme: 'http' | 'ws' = 'http'): URL | null {
  return URL.parse(req.url ?? '/', `${scheme}://${req.headers.host}`);
}
