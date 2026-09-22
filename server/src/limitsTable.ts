/**
 * Split out of `matchsvc.ts` (2026-09-22, CLAUDE.md's 500-line convention, form 1) — the
 * KEY-to-BUDGET table: which per-IP budget each limited route spends, and the one place this
 * process's nine limiters are built.
 *
 * Here rather than in `routes/limits.ts`, which every limited route imports, because this
 * file imports those same route modules back for their budget constants — one file holding
 * both would be a cycle. The division turns out to be the useful one anyway:
 * `routes/limits.ts` is what a ROUTE needs (the names, its own `Pick` of them, and
 * `spendBudget`), and this is what the ASSEMBLY needs. Nothing under `routes/` imports it.
 */
import {
  CHANGE_PASSWORD_RATE_LIMIT,
  LOGIN_RATE_LIMIT,
  PORTAL_RATE_LIMIT,
  REGISTER_RATE_LIMIT,
} from './routes/auth';
import { CREATE_RATE_LIMIT, JOIN_RATE_LIMIT } from './routes/party';
import { FIND_RATE_LIMIT } from './routes/match';
import { ORDER_RATE_LIMIT } from './routes/store';
import { RATE_LIMIT } from './routes/telemetry';
import { limiterFor } from './rateLimit';
import type { Limiters } from './routes/limits';

/**
 * Every per-IP budget this process keeps. One limiter — one COUNTER — per name, never per
 * mechanism: the numbers are argued beside the routes that spend them, and
 * `routes/limits.ts` argues why two budgets may not share a counter.
 *
 * This replaced a running list of individually-wired limiters inside the assembly ("a SECOND
 * limiter, with its own budget", "a THIRD, for `/party/join`") on 2026-09-22, in the pass
 * that gave the other six routes the budget that list had made too expensive to add.
 * `Limiters` requires every key, so the next budget is a compile error here until it is
 * wired, rather than a route that silently has none.
 *
 * A function, rather than an object literal inside `createMatchsvcServer`, for one reason: it
 * is the only place the key-to-constant map exists, and a map nothing can read is a map
 * nothing can check. `test/limits.test.ts` reads each limiter's capacity back out and
 * compares it to the constant that key names — which is how `partyJoin:
 * limiterFor(CREATE_RATE_LIMIT)`, or two keys handed the same instance, becomes a failing
 * test instead of a budget that quietly means something other than its doc comment. Both of
 * those mutants survived the whole HTTP suite before that file existed.
 *
 * `overrides` is merged LAST and by key, so a test names the one budget it drives and
 * inherits the shipped value for every other.
 */
export function createLimiters(overrides: Partial<Limiters> = {}): Limiters {
  return {
    telemetry: limiterFor(RATE_LIMIT),
    register: limiterFor(REGISTER_RATE_LIMIT),
    login: limiterFor(LOGIN_RATE_LIMIT),
    portalLogin: limiterFor(PORTAL_RATE_LIMIT),
    changePassword: limiterFor(CHANGE_PASSWORD_RATE_LIMIT),
    partyCreate: limiterFor(CREATE_RATE_LIMIT),
    partyJoin: limiterFor(JOIN_RATE_LIMIT),
    find: limiterFor(FIND_RATE_LIMIT),
    storeOrder: limiterFor(ORDER_RATE_LIMIT),
    ...overrides,
  };
}
