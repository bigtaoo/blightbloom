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
 * How many requests, over what window. The shape every named budget in this server is
 * written in, so a route's ceiling reads as two labelled numbers rather than as two
 * positional constructor arguments at the far end of the assembly.
 *
 * The TYPE lives here, with the mechanism; the NUMBERS never do. Each budget is declared in
 * the file that owns the route it defends, because the argument for a number is an argument
 * about that route's traffic and its false positives — `routes/party.ts` on what a refused
 * join costs a player, `routes/auth.ts` on what a registration costs this process — and a
 * central table of numbers is a table of numbers with their reasons somewhere else.
 */
export interface Budget {
  readonly requests: number;
  readonly windowMs: number;
}

/** A limiter for one budget. Its OWN counter, always — see `routes/limits.ts` for why two
 *  budgets may never share one. */
export function limiterFor(budget: Budget): RateLimiter {
  return new RateLimiter(budget.requests, budget.windowMs);
}

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
 *
 * "Even that is absent" covers a missing SOCKET and not only a missing address (fixed
 * 2026-09-22). `req.socket.remoteAddress` threw a `TypeError` on a request object without
 * one, which is the opposite of the documented fallback: a limiter that throws does not
 * refuse the caller, it takes the whole request down with a 500 from the error boundary —
 * so the one request shape nobody had thought about would have been the one shape a budget
 * could not bound. Node always sets `socket` on a real request, and nulls it once the
 * connection is destroyed, which is exactly the aborted-mid-flight case that reaches a
 * handler with nothing to read an address from.
 */
export function clientKey(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  const chain = Array.isArray(forwarded) ? forwarded.join(',') : (forwarded ?? '');
  const hops = chain
    .split(',')
    .map((h) => h.trim())
    .filter((h) => h.length > 0);
  return hops.length > 0 ? hops[hops.length - 1]! : (req.socket?.remoteAddress ?? 'unknown');
}
