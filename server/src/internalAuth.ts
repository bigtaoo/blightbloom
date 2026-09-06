/**
 * The INBOUND half of the internal trust seam (design/19 §3, ROADMAP 8.1) — how a route
 * that only another one of our own processes may call proves the caller is one.
 *
 * This is deliberately a THIRD credential namespace, distinct from both of the two that
 * already exist, and the distinction is structural rather than a check:
 *
 *   player session   `Authorization: Bearer <token>` → `AuthService` (design/16-accounts.md)
 *   seat grant       `?ticket=` → `ticket.ts`'s HMAC (ROADMAP 3.3)
 *   internal call    `x-internal-key` → this file
 *
 * Nothing here reads `authorization`, and nothing in `AuthService`/`ticket.ts` reads
 * `x-internal-key`, so an internal route cannot accept a player token even by mistake:
 * there is no code path that would look at one. A player who presents a perfectly valid
 * session token as `x-internal-key` is rejected as `unknown-key`, exactly like a random
 * string. (`routes/http.ts`'s `access-control-allow-headers` also does not list
 * `x-internal-key`, so a cross-origin browser request carrying one fails its own CORS
 * preflight before it is ever sent — the open CORS block on these routes cannot be turned
 * into a way in.)
 *
 * Borrowed from funny's `shared/src/internalAuth`, cut down: its per-caller key registry
 * (one independently-rotatable key per calling service) is the right end state but is not
 * worth the operational surface at three processes. What is kept is the SHAPE — a verifier
 * built from a registry that today holds exactly one entry — so growing a second caller
 * later is a config change rather than a rewrite of every call site.
 *
 * Pure of env, http and globals, the same way `ticket.ts` is: the registry is passed in and
 * the input is a plain header bag, so every branch below is unit-testable with no server.
 * `config.ts` owns where the key comes from; `routes/rating.ts` owns what a rejection does.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

/** The header carrying the shared secret. Never advertised to browsers — see file header. */
export const INTERNAL_KEY_HEADER = 'x-internal-key';
/**
 * ADVISORY only: what the caller says it is, used for audit lines and nothing else. It is
 * never used to pick which key to compare against — that would let an unauthenticated
 * attacker choose the secret they are checked against, and would make a forgeable header
 * load-bearing. The authoritative caller identity is the registry entry whose key matched.
 */
export const INTERNAL_CALLER_HEADER = 'x-internal-caller';

/** One entry of the key registry: a calling process and the secret it presents. */
export interface InternalCaller {
  caller: string;
  key: string;
}

export type InternalAuthFailure =
  /** No key is configured at all — fail closed (see `config.ts`'s production branch). */
  | 'no-keys-configured'
  /** The header is absent, empty, or not a single string value. */
  | 'missing-key'
  /** A key was presented and matched no registry entry. */
  | 'unknown-key';

export type InternalAuthResult =
  | { ok: true; caller: string; claimedCaller?: string }
  | { ok: false; reason: InternalAuthFailure; claimedCaller?: string };

export interface InternalVerifier {
  verify(headers: IncomingHttpHeaders): InternalAuthResult;
}

/**
 * Node types a header value as `string | string[] | undefined` — duplicates of an ordinary
 * header arrive already comma-joined into one string, so the array case is not reachable
 * over real HTTP, but a value that is not a single string is treated as absent rather than
 * coerced. `String(['a','b'])` would otherwise silently compare against `"a,b"`.
 */
function headerValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  const raw = headers[name];
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

const sha256 = (s: string): Buffer => createHash('sha256').update(s, 'utf8').digest();

/**
 * Constant-time key comparison that also tolerates a LENGTH mismatch. `timingSafeEqual`
 * throws when its two buffers differ in length, so the usual guard is an early
 * `a.length !== b.length` return — which is correct for `ticket.ts` (an HMAC is always the
 * same length) but wrong here, where the secret is operator-chosen: that guard turns the
 * length of the real key into something an attacker can measure one byte at a time.
 * Hashing both sides first makes every comparison 32 bytes against 32 bytes, so the
 * function neither throws nor leaks the length.
 */
function keyMatches(presented: string, expected: string): boolean {
  return timingSafeEqual(sha256(presented), sha256(expected));
}

/**
 * Build a verifier over a key registry. An EMPTY registry is a legitimate, deliberate
 * state — `config.ts` returns one when a production process has no key configured — and it
 * rejects everything, which is the fail-closed posture. It is never "allow all".
 */
export function createInternalVerifier(registry: readonly InternalCaller[]): InternalVerifier {
  const entries = [...registry];
  return {
    verify(headers: IncomingHttpHeaders): InternalAuthResult {
      const claimedCaller = headerValue(headers, INTERNAL_CALLER_HEADER);
      if (entries.length === 0) return { ok: false, reason: 'no-keys-configured', claimedCaller };

      const presented = headerValue(headers, INTERNAL_KEY_HEADER);
      if (presented === undefined) return { ok: false, reason: 'missing-key', claimedCaller };

      // No early `break`: the loop does the same work whichever entry matches, so the time
      // taken does not say which caller's key was presented. With one entry this is free;
      // it matters the day the registry has several.
      let matched: string | undefined;
      for (const entry of entries) {
        if (keyMatches(presented, entry.key)) matched = entry.caller;
      }
      if (matched === undefined) return { ok: false, reason: 'unknown-key', claimedCaller };
      return { ok: true, caller: matched, claimedCaller };
    },
  };
}

/**
 * Sanitize an untrusted header value for a log line: control characters (a newline above
 * all) removed and the result truncated, so a rejected caller cannot inject a fake log
 * record into the audit trail it is about to appear in. Exported for its own test, and since
 * 2026-09-05 also for `routes/rating.ts`, whose settlement-failure line names the body's
 * `reportKey` — every place an untrusted string reaches a console call goes through here.
 */
export function sanitizeAuditValue(value: string, maxLength = 64): string {
  // Control characters, DEL included: a newline in this value is how a fake log line gets in.
  const stripped = value.replace(/[\u0000-\u001f\u007f]/g, '');
  return stripped.length > maxLength ? `${stripped.slice(0, maxLength)}...` : stripped;
}

/**
 * The one-line audit record for a REJECTED internal call. Pure (returns the string rather
 * than logging it) so the caller decides where it goes and a test can assert its content
 * without a console spy. Names the failure reason and the caller's own advisory claim —
 * which is exactly the value that must never be trusted, hence `sanitizeAuditValue`.
 */
export function describeInternalAuthFailure(
  result: Extract<InternalAuthResult, { ok: false }>,
  route: string,
): string {
  const who = result.claimedCaller === undefined ? 'unidentified' : `claimed "${sanitizeAuditValue(result.claimedCaller)}"`;
  return `[blightbloom] internal auth REJECTED ${route}: ${result.reason} (caller ${who})`;
}
