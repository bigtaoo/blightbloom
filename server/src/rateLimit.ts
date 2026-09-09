/**
 * The per-IP request budget, and how the caller's address is derived from a proxied
 * request. Split out of `routes/telemetry.ts` (2026-09-09, design/21 §3.3) with no
 * behaviour change — the file it came from re-exports both names, so every existing
 * importer and every existing test is untouched.
 *
 * The split happened because a SECOND process needs the same limiter: adminsvc rate-limits
 * its login (design/21 §3.3, "reusing the per-IP limiter the telemetry route already
 * owns"), and reaching for it through `routes/telemetry.ts` would have pulled matchsvc's
 * whole route layer — the Loki push, the analytics ingest, the client-log parser — into the
 * admin console's bundle for one class. What is reused is the MECHANISM; each caller picks
 * its own budget, because "twenty telemetry batches a minute" and "ten login attempts in
 * five minutes" are different questions with the same shape.
 *
 * Pure of `node:http` beyond a type import, and free of module-scope state: an instance is
 * constructed by whoever owns a process, never a singleton. That is deliberate and it is
 * about tests rather than tidiness — a module-level limiter is shared state between every
 * server a test file builds, so one case exhausting the budget silently changes the next
 * case's answer. The classic order-dependent suite.
 */
import type { IncomingMessage } from 'node:http';

/**
 * A fixed-window counter per client IP.
 *
 * In-process on purpose: each of these services is one container
 * (`docker-compose.yml`), so a shared store would add a dependency to make a single process
 * agree with itself. If a second instance is ever run, this becomes per-instance — which is
 * a weaker limit, not a broken one, and is noted here rather than left to be discovered.
 *
 * The map is swept on write rather than on a timer: a timer would keep the process alive
 * (or need `unref`), and the sweep is over a map whose size is bounded by the number of
 * distinct IPs inside one window.
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
