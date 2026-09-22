/**
 * Budgets for tests that are not about budgets.
 *
 * Nine routes spend a per-IP budget since 2026-09-22 (`src/routes/limits.ts`), and
 * `BudgetDeps` makes the limiter REQUIRED rather than optional — an absent one can only mean
 * "no limit", and a working way to be exempt is an invitation to use it. The cost lands on
 * every test that drives one of those handlers directly while testing something else
 * entirely: it has to supply a limiter it does not care about.
 *
 * {@link wideLimits} is that limiter, once, at a million requests a minute — a number no test
 * can reach by accident and no caller would reach on purpose. A test that IS about a budget
 * never uses this: it passes its own tight limiter, either through
 * `MatchsvcServerOptions.limits` (`matchsvc.joinLimit.http.test.ts`) or straight into the
 * handler's deps.
 *
 * It returns a FRESH set per call on purpose. A shared module-level set would be shared state
 * between every test that touches it — the order-dependent suite `rateLimit.ts`'s own header
 * warns about — and the one property of that failure is that it appears as a test failing
 * only when the whole file runs.
 */
import { RateLimiter } from '../src/rateLimit';
import type { Limiters } from '../src/routes/limits';

/** A budget no test can exhaust: a million requests per minute, per key. */
export function wideLimits(): Limiters {
  const wide = () => new RateLimiter(1_000_000, 60_000);
  return {
    telemetry: wide(),
    register: wide(),
    login: wide(),
    portalLogin: wide(),
    changePassword: wide(),
    partyCreate: wide(),
    partyJoin: wide(),
    find: wide(),
    storeOrder: wide(),
  };
}
