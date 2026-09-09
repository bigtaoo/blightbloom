/**
 * adminsvc's transport primitives — the same role `routes/http.ts` plays for matchsvc, and
 * a deliberately separate file rather than an import of it, for two reasons that are both
 * about what this process must NOT inherit.
 *
 * **No CORS block.** `routes/http.ts` sends `access-control-allow-origin: *` on every
 * response, which is right for a game client on another origin and wrong here: the console
 * is served from the same origin as its own data (design/21 §3.4), so there is no
 * cross-origin caller to allow, and `SameSite=Strict` on the session cookie plus no CORS
 * headers at all means a page on another origin cannot read a single byte of this one. An
 * `access-control-allow-origin: *` here would undo that in one header.
 *
 * **HTML, not JSON.** Every response but `/admin/health` is a server-rendered page. That is
 * §3.4's "a page that cannot go stale against its own API" taken literally — there is no
 * API. It also removes a whole category of thing to secure: no JSON endpoints to
 * authenticate separately, no fetch credentials story, and the page works with scripting
 * off.
 *
 * ## The body reader
 *
 * One form is POSTed to this server (the login) and one field pair comes back, so the
 * reader is `application/x-www-form-urlencoded` and bounded at {@link LOGIN_BODY_LIMIT}.
 * Overflow behaviour follows `routes/http.ts`'s: the tail past the limit is dropped, so
 * what gets parsed is a truncated body, which yields a login attempt that fails. The safe
 * direction — and the reason no handler here has to defend against a half-read form.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * A username and a password and nothing else. 4 KB is roughly forty times the largest
 * legitimate body; a login form is not a place that needs room to grow.
 */
export const LOGIN_BODY_LIMIT = 4096;

/** Sent on every response. */
const BASE_HEADERS: Record<string, string> = {
  // The page has no inline event handlers, no external script, no external stylesheet and
  // no image: everything it needs is in the document. So the policy that describes it is
  // also the strictest one available, and it is worth setting even though there is no
  // untrusted content the escaping in `page/layout.ts` fails to cover — defence in depth
  // where the depth costs one header.
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  // The console must never be framed: a clickjacked logout is trivial and a framed console
  // is a way to read one operator's screen from another origin's page.
  'x-frame-options': 'DENY',
  // An operator's browser cache and any proxy in between are both places a page listing
  // account rows should not persist.
  'cache-control': 'no-store',
};

/**
 * The request's method and parsed URL, as one value.
 *
 * A free function rather than four lines inside the server's request handler, because
 * `IncomingMessage` types both `url` and `method` as possibly `undefined`. Node always sets
 * them for a real request, so those two fallbacks are unreachable through a socket — and a
 * fallback that no test can reach is a dead branch that a coverage gate cannot tell apart
 * from an untested one. Here the contract is exercised directly: the type admits
 * `undefined`, so a case passes `undefined`.
 *
 * `path` comes off `URL`, so it is normalised and carries NO query string. That is
 * deliberate and it is what the audit line logs: a search term on this console is a
 * player's username, and a log store is not where it belongs.
 */
export function requestTarget(req: Pick<IncomingMessage, 'url' | 'method' | 'headers'>): {
  url: URL;
  path: string;
  method: string;
} {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  return { url, path: url.pathname, method: req.method ?? 'GET' };
}

export function sendHtml(res: ServerResponse, status: number, html: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, { ...BASE_HEADERS, ...extra, 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { ...BASE_HEADERS, 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/**
 * A `303 See Other` back to a path on this server.
 *
 * 303 rather than 302, and it matters for the one case this is used for: after a POST, a
 * 303 tells the browser to follow up with a GET. A 302 leaves that to the browser's
 * discretion and the historical answer was to repeat the POST — which here would re-submit
 * the login form on every back-navigation.
 *
 * `location` is only ever a constant from this module's callers, never a request value, so
 * there is no open-redirect surface to guard: an attacker-chosen `Location` is the classic
 * hole in a login flow and the way to not have it is to not read one.
 */
export function redirect(res: ServerResponse, location: string, extra: Record<string, string> = {}): void {
  res.writeHead(303, { ...BASE_HEADERS, ...extra, location });
  res.end();
}

/**
 * Reads a bounded `application/x-www-form-urlencoded` body.
 *
 * `URLSearchParams` does the decoding, which means a malformed percent-escape cannot throw
 * out of here — it is lenient by specification, and the alternative (`decodeURIComponent`
 * per field) throws on `%zz` and would turn a corrupted form into a 500.
 */
export function readForm(req: IncomingMessage, done: (form: URLSearchParams) => void): void {
  const chunks: Buffer[] = [];
  let size = 0;
  req.on('data', (c: Buffer) => {
    size += c.length;
    if (size > LOGIN_BODY_LIMIT) return; // ignore the overflow tail
    chunks.push(c);
  });
  req.on('end', () => done(new URLSearchParams(Buffer.concat(chunks).toString('utf8'))));
  req.on('error', () => done(new URLSearchParams()));
}
