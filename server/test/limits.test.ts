/**
 * The budget TABLE, and the helper every route spends through — `limitsTable.ts`'s
 * `createLimiters` read back key by key, and `routes/limits.ts`'s `spendBudget`.
 *
 * Every other rate-limit test in this tree drives a ROUTE and asks whether it refuses. That
 * leaves one class of defect invisible, and it is the class a nine-key table invites: the
 * wiring. A key handed the wrong constant (`partyJoin: limiterFor(CREATE_RATE_LIMIT)`) or two
 * keys handed the SAME instance both keep every route refusing, on a budget that is simply
 * not the one its doc comment argues — and an HTTP test cannot see it, because the file that
 * would notice has overridden that very key to something it can exhaust.
 *
 * Both mutants were run and both SURVIVED the HTTP suite before this file existed
 * (2026-09-22). What makes them visible is reading a limiter's capacity back out: `take` with
 * a frozen clock never elapses the window, so counting the `true`s is the limit.
 */
import { describe, it, expect } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createLimiters } from '../src/limitsTable';
import { RateLimiter, type Budget } from '../src/rateLimit';
import { spendBudget, type Limiters } from '../src/routes/limits';
import { CREATE_RATE_LIMIT, JOIN_RATE_LIMIT } from '../src/routes/party';
import { CHANGE_PASSWORD_RATE_LIMIT, LOGIN_RATE_LIMIT, PORTAL_RATE_LIMIT, REGISTER_RATE_LIMIT } from '../src/routes/auth';
import { FIND_RATE_LIMIT } from '../src/routes/match';
import { ORDER_RATE_LIMIT } from '../src/routes/store';
import { RATE_LIMIT } from '../src/routes/telemetry';

/** How many requests this limiter serves one key inside one window. The clock is frozen, so
 *  the window never elapses and the count terminates at the limit. */
function capacityOf(limiter: RateLimiter, key = 'probe'): number {
  let served = 0;
  while (limiter.take(key, 0)) served += 1;
  return served;
}

/** The map this file exists to check, written out a SECOND time rather than imported from the
 *  assembly. A test that read the same object the code builds would agree with any wiring. */
const EXPECTED: Record<keyof Limiters, Budget> = {
  telemetry: RATE_LIMIT,
  register: REGISTER_RATE_LIMIT,
  login: LOGIN_RATE_LIMIT,
  portalLogin: PORTAL_RATE_LIMIT,
  changePassword: CHANGE_PASSWORD_RATE_LIMIT,
  partyCreate: CREATE_RATE_LIMIT,
  partyJoin: JOIN_RATE_LIMIT,
  find: FIND_RATE_LIMIT,
  storeOrder: ORDER_RATE_LIMIT,
};

describe('createLimiters — the key-to-budget map', () => {
  it('gives every key the budget its own route argues', () => {
    const limits = createLimiters();
    for (const [name, budget] of Object.entries(EXPECTED) as [keyof Limiters, Budget][]) {
      expect(`${name}: ${capacityOf(limits[name])}`).toBe(`${name}: ${budget.requests}`);
    }
  });

  it('gives every key its OWN counter — nine instances, not one reused', () => {
    // The mistake this catches is a one-character one in the assembly, and it is the mistake
    // `routes/limits.ts` spends a paragraph on: a shared counter makes each route's ceiling
    // depend on how busy the others are, so a chatty client's log batches could spend the
    // budget a player's join needs.
    const limits = createLimiters();
    expect(new Set(Object.values(limits)).size).toBe(Object.keys(EXPECTED).length);

    // Distinct objects is the shape; this is the behaviour. Exhausting one key must leave
    // every other key's first request served.
    const spent = createLimiters();
    while (spent.partyCreate.take('10.0.0.1', 0)) {
      /* drain */
    }
    for (const name of Object.keys(EXPECTED) as (keyof Limiters)[]) {
      if (name === 'partyCreate') continue;
      expect(`${name}: ${spent[name].take('10.0.0.1', 0)}`).toBe(`${name}: true`);
    }
  });

  it('keys each counter by caller, so one address cannot spend another\'s', () => {
    const limits = createLimiters();
    while (limits.partyCreate.take('10.0.0.1', 0)) {
      /* drain one address */
    }
    expect(limits.partyCreate.take('10.0.0.2', 0)).toBe(true);
  });

  it('an override replaces exactly one key and inherits the rest', () => {
    // What `MatchsvcServerOptions.limits` is for: a test names the one budget it drives.
    // Inheriting the rest is the half that matters — an override that reset the other eight
    // to nothing would make every HTTP suite in this tree pass against no limits at all.
    const limits = createLimiters({ login: new RateLimiter(2, 60_000) });
    expect(capacityOf(limits.login)).toBe(2);
    expect(capacityOf(limits.register)).toBe(REGISTER_RATE_LIMIT.requests);
    expect(capacityOf(limits.partyCreate)).toBe(CREATE_RATE_LIMIT.requests);
  });
});
/**
 * `spendBudget` itself — the helper all nine routes spend through.
 *
 * Its refusing half is exercised by every rate-limit case in this tree. Its ALLOWING half is
 * the one nothing could see: a version that wrote a header (or anything else) to the response
 * on the way through would leave every test green, because each route then goes on to write
 * its own answer over the top, and only a real `ServerResponse` in production would notice
 * that the headers had already been sent. That mutant survived the whole suite, so the
 * contract is pinned here instead: on the allowed path the response is NOT TOUCHED.
 */
describe('spendBudget', () => {
  function fakeRes() {
    const calls: string[] = [];
    const res = {
      writeHead: (s: number) => {
        calls.push(`writeHead(${s})`);
        return res;
      },
      setHeader: (k: string) => calls.push(`setHeader(${k})`),
      end: (body?: string) => calls.push(`end(${body ?? ''})`),
    } as unknown as ServerResponse;
    return { res, calls };
  }

  const req = (from: string) => ({ headers: { 'x-forwarded-for': from } }) as unknown as IncomingMessage;

  it('returns true and leaves the response completely alone while the budget holds', () => {
    const { res, calls } = fakeRes();
    const limiter = new RateLimiter(2, 60_000);
    expect(spendBudget(limiter, req('10.0.0.1'), res, 0, 'nope')).toBe(true);
    expect(spendBudget(limiter, req('10.0.0.1'), res, 0, 'nope')).toBe(true);
    expect(calls).toEqual([]);
  });

  it('returns false and sends the 429 ITSELF once the budget is gone', () => {
    // The helper answers rather than reporting, so a route's budget line cannot fall through
    // to a request that is never answered at all — the shape `routes/http.ts` warns about.
    const { res, calls } = fakeRes();
    const limiter = new RateLimiter(1, 60_000);
    spendBudget(limiter, req('10.0.0.2'), res, 0, 'nope');
    expect(spendBudget(limiter, req('10.0.0.2'), res, 0, 'too many somethings')).toBe(false);
    expect(calls[0]).toBe('writeHead(429)');
    expect(calls.join(' ')).toContain('too many somethings');
  });

  it('keys on the caller, not on the route', () => {
    // `clientKey`'s rule has its own unit tests; what this pins is that the helper uses it at
    // all. A version keyed on a constant would refuse the second caller on this line.
    const limiter = new RateLimiter(1, 60_000);
    const a = fakeRes();
    const b = fakeRes();
    expect(spendBudget(limiter, req('10.0.0.3'), a.res, 0, 'nope')).toBe(true);
    expect(spendBudget(limiter, req('10.0.0.4'), b.res, 0, 'nope')).toBe(true);
    expect(spendBudget(limiter, req('10.0.0.3'), a.res, 0, 'nope')).toBe(false);
  });
});
