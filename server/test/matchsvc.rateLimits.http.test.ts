/**
 * The five budgets added on 2026-09-22 in one pass, over real HTTP: `/party/create`,
 * `/auth/login`, `/auth/portal`, `/auth/change-password`, `/find` and `/store/order`.
 *
 * Why one file for six routes. They are one decision, not six — `/party/join` and
 * `/auth/register` had a per-IP budget and every other route that mints state or spends real
 * CPU did not, which was an accident of whichever route someone had last worried about rather
 * than a policy. The cases that matter here are mostly the ones that pin WHICH call is
 * charged, and those read as a set.
 *
 * Each route's own budget lives with its route (`CREATE_RATE_LIMIT`, `LOGIN_RATE_LIMIT`,
 * `PORTAL_RATE_LIMIT`, `CHANGE_PASSWORD_RATE_LIMIT`, `FIND_RATE_LIMIT`, `ORDER_RATE_LIMIT`),
 * and every one of them is tens to hundreds of requests per ten minutes — which no test can
 * exhaust at a sane runtime. So this file injects tight limiters through
 * `MatchsvcServerOptions.limits` and the last describe pins the shipped constants, exactly
 * as `matchsvc.joinLimit.http.test.ts` and `matchsvc.registerLimit.http.test.ts` do.
 *
 * THE CASES THAT CARRY THE FILE are the three "is charged" ones. A budget that only counted
 * the calls that SUCCEEDED would pass a 429 case, pass an isolation case, and leave every
 * attack it exists for completely unbounded — credential stuffing is almost entirely failed
 * logins, an enumeration walk is almost entirely usernames that do not exist, and a flood
 * onto the order proxy is not required to hold a session at all.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { EventEmitter } from 'node:events';
import { createMatchsvcServer } from '../src/matchsvc';
import { RateLimiter } from '../src/rateLimit';
import { CREATE_RATE_LIMIT, postCreate } from '../src/routes/party';
import { CODE_DRAW_ATTEMPTS, DEFAULT_TTL_MS } from '../src/PartyService';
import {
  CHANGE_PASSWORD_RATE_LIMIT,
  LOGIN_RATE_LIMIT,
  PORTAL_RATE_LIMIT,
  postChangePassword,
  postLogin,
  postPortalLogin,
} from '../src/routes/auth';
import { FIND_RATE_LIMIT, postFind } from '../src/routes/match';
import { ORDER_RATE_LIMIT, postOrder } from '../src/routes/store';
import type { Limiters } from '../src/routes/limits';
import { CLIENT_LOG_PATH } from '../src/routes/telemetry';
import { freshAccounts } from './mongoHarness';

let baseUrl: string;
let close: () => Promise<void>;

/**
 * One server for the whole file, with every new budget set to two per five minutes: small
 * enough to exhaust, with a window the wall clock cannot elapse mid-run.
 *
 * `portal.keys` answers `null` so `/auth/portal` refuses deterministically and makes no
 * outbound request — the real key store would reach CrazyGames' CDN. What that route's cases
 * are about is whether the budget is spent BEFORE the verification it cannot do, so a route
 * that always 503s is the honest fixture rather than a compromise.
 *
 * `spawnBot` is a no-op for a reason that cost a red coverage run to find. The `/find` cases
 * leave real waiters in the matchmaker, and bot backfill is **five** seconds (`Matchmaker`'s
 * `DEFAULT_BOT_FILL_MS`), evaluated on each POLL rather than on a timer. So a poll loop that
 * takes longer than five seconds — which is nothing on an idle box and entirely possible
 * under `npm run coverage`, where three workspaces instrument back to back — forms a room
 * with bots, and the real `spawnBotClient` then opens a WebSocket per bot seat to a
 * gameserver that is not running. A test that reaches the network because the machine was
 * slow is a test that fails for a reason it is not about.
 */
async function start(): Promise<{ url: string; stop: () => Promise<void> }> {
  const tight = () => new RateLimiter(2, 5 * 60_000);
  const server: Server = createMatchsvcServer({
    store: await freshAccounts(),
    secret: 'test-secret',
    portal: { keys: { key: () => Promise.resolve(null) } },
    spawnBot: () => {},
    limits: {
      partyCreate: tight(),
      login: tight(),
      portalLogin: tight(),
      changePassword: tight(),
      find: tight(),
      storeOrder: tight(),
    },
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

beforeAll(async () => {
  const s = await start();
  baseUrl = s.url;
  close = s.stop;
});

afterAll(async () => {
  await close();
});

/** Each case picks its own `from` address, because the budget is per address and the cases
 *  would otherwise spend each other's. `clientKey` reads the LAST x-forwarded-for hop. */
async function post(path: string, from: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': from, ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /party/create — the supply side of the room code
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /party/create — the per-IP budget', () => {
  it('serves the budget, then refuses with 429', async () => {
    expect((await post('/party/create', '198.51.100.1', { playerId: 'c1a' })).status).toBe(200);
    expect((await post('/party/create', '198.51.100.1', { playerId: 'c1b' })).status).toBe(200);
    const refused = await post('/party/create', '198.51.100.1', { playerId: 'c1c' });
    expect(refused.status).toBe(429);
    expect(refused.body.error).toContain('too many parties');
    // And no party came back with it — the refusal is a refusal, not a slower success.
    expect(refused.body.code).toBeUndefined();
  });

  it('is per address', async () => {
    await post('/party/create', '198.51.100.2', { playerId: 'c2a' });
    await post('/party/create', '198.51.100.2', { playerId: 'c2b' });
    expect((await post('/party/create', '198.51.100.2', { playerId: 'c2c' })).status).toBe(429);
    expect((await post('/party/create', '198.51.100.3', { playerId: 'c2d' })).status).toBe(200);
  });

  it('charges a create that never names a player — the 400 is spent too', async () => {
    // `CREATE_RATE_LIMIT` defends the SUPPLY of room codes, and the flood that exhausts it
    // has no obligation to send a well-formed body. A budget spent after validation would be
    // spendable only by traffic that was trying to behave.
    expect((await post('/party/create', '198.51.100.4', {})).status).toBe(400);
    expect((await post('/party/create', '198.51.100.4', {})).status).toBe(400);
    expect((await post('/party/create', '198.51.100.4', { playerId: 'c4' })).status).toBe(429);
  });

  it('does not spend /party/join\'s budget, and join does not spend its', async () => {
    // The obvious mistake in a pass that adds a budget to a route next door is to hand both
    // handlers the same limiter. Then a squad's leader creating a lobby costs its members
    // their join attempts, and neither number means what its doc comment says. Asserted in
    // both directions because one shared counter fails only one of them at a time.
    const party = await post('/party/create', '198.51.100.5', { playerId: 'c5' });
    await post('/party/create', '198.51.100.5', { playerId: 'c5b' });
    expect((await post('/party/create', '198.51.100.5', { playerId: 'c5c' })).status).toBe(429);

    // Join's own budget is the shipped 120 here (only `partyCreate` was overridden), so these
    // are answered on their merits rather than refused.
    const joined = await post('/party/join', '198.51.100.5', { playerId: 'j5', code: party.body.code });
    expect(joined.status).toBe(200);
    expect((await post('/party/join', '198.51.100.5', { playerId: 'j5b', code: party.body.code })).status).toBe(200);
    expect((await post('/party/join', '198.51.100.5', { playerId: 'j5c', code: party.body.code })).status).not.toBe(429);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /auth/login — the half the per-username lockout cannot see
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /auth/login — the per-IP budget', () => {
  it('serves the budget, then refuses with 429', async () => {
    const reg = await post('/auth/register', '198.51.100.10', { username: 'ratelimit1', password: 'hunter22' });
    expect(reg.status).toBe(200);
    expect((await post('/auth/login', '198.51.100.10', { username: 'ratelimit1', password: 'hunter22' })).status).toBe(200);
    expect((await post('/auth/login', '198.51.100.10', { username: 'ratelimit1', password: 'hunter22' })).status).toBe(200);
    const refused = await post('/auth/login', '198.51.100.10', { username: 'ratelimit1', password: 'hunter22' });
    expect(refused.status).toBe(429);
    expect(refused.body.error).toContain('too many login attempts');
    // A refused login hands back no session, which is the one thing that would make the
    // budget worse than useless.
    expect(refused.body.token).toBeUndefined();
  });

  it('charges a WRONG password — the case the whole budget exists for', async () => {
    // Credential stuffing is almost entirely failed logins. A budget charged only on the
    // logins that SUCCEEDED would pass every other case in this describe and leave the attack
    // it was added for completely unbounded.
    //
    // Note the addresses: `AuthService`'s per-username lockout is five failures against ONE
    // name, and this case never reaches it (two attempts), which is exactly the gap being
    // covered — the lockout is per name and the attack is per list.
    await post('/auth/register', '198.51.100.11', { username: 'ratelimit2', password: 'hunter22' });
    expect((await post('/auth/login', '198.51.100.12', { username: 'ratelimit2', password: 'wrongwrong' })).status).toBe(401);
    expect((await post('/auth/login', '198.51.100.12', { username: 'ratelimit2', password: 'wrongwrong' })).status).toBe(401);
    expect((await post('/auth/login', '198.51.100.12', { username: 'ratelimit2', password: 'hunter22' })).status).toBe(429);
  });

  it('charges a username that does not exist — the enumeration walk is the list-building half', async () => {
    // A name that is not there returns before any hashing, so a caller who is not refused can
    // read "does this account exist" off the response, cheaply, forever. That walk is how the
    // list for the case above gets built, and it is the one a budget keyed on "the account
    // existed" would never see.
    expect((await post('/auth/login', '198.51.100.13', { username: 'nobodyhome1', password: 'hunter22' })).status).toBe(401);
    expect((await post('/auth/login', '198.51.100.13', { username: 'nobodyhome2', password: 'hunter22' })).status).toBe(401);
    expect((await post('/auth/login', '198.51.100.13', { username: 'nobodyhome3', password: 'hunter22' })).status).toBe(429);
  });

  it('does not spend the registration budget, nor the telemetry one', async () => {
    // Three counters, three questions. A shared one would make a player who mistyped their
    // password unable to create an account, and would make either route's ceiling depend on
    // how busy the other happens to be.
    await post('/auth/login', '198.51.100.14', { username: 'nobodyhome4', password: 'hunter22' });
    await post('/auth/login', '198.51.100.14', { username: 'nobodyhome5', password: 'hunter22' });
    expect((await post('/auth/login', '198.51.100.14', { username: 'nobodyhome6', password: 'hunter22' })).status).toBe(429);

    const reg = await post('/auth/register', '198.51.100.14', { username: 'ratelimit3', password: 'hunter22' });
    expect(reg.status).toBe(200);
    const log = await post(CLIENT_LOG_PATH, '198.51.100.14', { entries: [] });
    expect(log.status).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /auth/portal and POST /auth/change-password
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /auth/portal — the per-IP budget', () => {
  it('charges a call this server cannot even verify', async () => {
    // The fixture has no verification key, so every call here refuses with 503 — and the
    // budget is still spent, which is the ordering the route needs. The work a portal login
    // costs (a public-key verification, and an account minted on first sight) happens AFTER
    // this point, so a limiter taken later is one that has already paid for the request it is
    // about to refuse.
    expect((await post('/auth/portal', '198.51.100.20', { token: 'whatever' })).status).toBe(503);
    expect((await post('/auth/portal', '198.51.100.20', { token: 'whatever' })).status).toBe(503);
    const refused = await post('/auth/portal', '198.51.100.20', { token: 'whatever' });
    expect(refused.status).toBe(429);
    expect(refused.body.error).toContain('too many portal logins');
  });

  it('is its own counter, separate from password login', async () => {
    await post('/auth/portal', '198.51.100.21', { token: 'a' });
    await post('/auth/portal', '198.51.100.21', { token: 'b' });
    expect((await post('/auth/portal', '198.51.100.21', { token: 'c' })).status).toBe(429);
    // A portal player and a password player behind one NAT must not spend each other's
    // budget — on a portal build every boot POSTs /auth/portal, which would otherwise make
    // the login form unusable for everyone sharing that address.
    expect((await post('/auth/login', '198.51.100.21', { username: 'nobodyhome7', password: 'hunter22' })).status).toBe(401);
  });
});

describe('POST /auth/change-password — the per-IP budget', () => {
  it('charges an invalid token, before the two hashes behind it', async () => {
    // Session-gated, so this is not reachable by an anonymous flood — but a session costs one
    // registration, and the route is the most expensive single request in the process (two
    // scrypt hashes). The budget is spent before the session check for the same reason every
    // other one here is: the check itself is work a caller can ask for.
    const body = { token: 'not-a-real-token', oldPassword: 'hunter22', newPassword: 'hunter333' };
    expect((await post('/auth/change-password', '198.51.100.30', body)).status).toBe(401);
    expect((await post('/auth/change-password', '198.51.100.30', body)).status).toBe(401);
    const refused = await post('/auth/change-password', '198.51.100.30', body);
    expect(refused.status).toBe(429);
    expect(refused.body.error).toContain('too many password changes');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /find, and the poll that is deliberately not budgeted
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /find — the per-IP budget', () => {
  it('serves the budget, then refuses with 429', async () => {
    expect((await post('/find', '198.51.100.40', { playerCount: 2 })).status).not.toBe(429);
    expect((await post('/find', '198.51.100.40', { playerCount: 2 })).status).not.toBe(429);
    const refused = await post('/find', '198.51.100.40', { playerCount: 2 });
    expect(refused.status).toBe(429);
    expect(refused.body.error).toContain('too many matchmaking requests');
    expect(refused.body.queueId).toBeUndefined();
  });

  it('charges a /find the matchmaker refuses outright', async () => {
    // `playerCount: 99` is past `MAX_PLAYERS`, so the enqueue throws and the route answers
    // 400. It is charged anyway: a caller flooding this route is not obliged to send a
    // playable request, and a budget spent after the enqueue would be spendable only by the
    // requests that were going to work.
    expect((await post('/find', '198.51.100.41', { playerCount: 99 })).status).toBe(400);
    expect((await post('/find', '198.51.100.41', { playerCount: 99 })).status).toBe(400);
    expect((await post('/find', '198.51.100.41', { playerCount: 2 })).status).toBe(429);
  });

  it('leaves GET /find/:queueId unbudgeted — an absence, asserted', async () => {
    // The real client polls this every 500ms for up to ninety seconds, so any budget low
    // enough to inconvenience an attacker refuses four players in one living room first. The
    // absence is the decision (`FIND_RATE_LIMIT`'s note says so), and an absence is what no
    // suite asserts by accident: adding a limiter here would break nothing else in this tree.
    const queued = await post('/find', '198.51.100.42', { playerCount: 4 });
    const queueId = queued.body.queueId as string;
    expect(queueId).toBeTruthy();
    // Well past every budget in this file, on the address that has already spent its /find
    // budget down to nothing.
    await post('/find', '198.51.100.42', { playerCount: 4 });
    expect((await post('/find', '198.51.100.42', { playerCount: 4 })).status).toBe(429);
    for (let i = 0; i < 20; i++) {
      const res = await fetch(`${baseUrl}/find/${encodeURIComponent(queueId)}`, {
        headers: { 'x-forwarded-for': '198.51.100.42' },
      });
      // Twenty polls past a spent POST budget on the same address, none of them refused.
      //
      // The assertion is `not 429` rather than `queued` deliberately: a waiter TTLs out of
      // the matchmaker after thirty seconds, so under a loaded run (the coverage pass runs
      // three workspaces back to back) a late poll can legitimately answer `expired`, and a
      // test that called that a failure would be measuring the machine. What this case is
      // about is the RATE, and `queued` is still pinned on the first poll below.
      expect(res.status).not.toBe(429);
      const body = (await res.json()) as { status?: string };
      if (i === 0) expect(body.status).toBe('queued');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /store/order — the budget in front of another service's database
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /store/order — the per-IP budget', () => {
  it('charges a call with no session at all, before the session check', async () => {
    // The route's own header argues that requiring a session is what keeps this proxy from
    // being a free unmetered amplifier onto the billing plane. That bounds WHO, and a session
    // costs one registration; nothing bounded HOW OFTEN. Charging before `requireAuth` is what
    // makes the anonymous flood — the one that never intended to hold a session — cost
    // something, and the 401s below prove the order.
    const body = { sku: 'bp.cannon', platform: 'wechat' };
    expect((await post('/store/order', '198.51.100.50', body)).status).toBe(401);
    expect((await post('/store/order', '198.51.100.50', body)).status).toBe(401);
    const refused = await post('/store/order', '198.51.100.50', body);
    expect(refused.status).toBe(429);
    expect(refused.body.error).toContain('too many orders');
  });

  it('leaves GET /store/skus unbudgeted', async () => {
    // A read, answered from billsvc's memory, and never a write into anyone's database. It
    // keeps its session gate and nothing else — the same call this file makes for the find
    // poll, and the reason `ORDER_RATE_LIMIT` is named for the spender rather than the group.
    await post('/store/order', '198.51.100.51', { sku: 'bp.cannon', platform: 'wechat' });
    await post('/store/order', '198.51.100.51', { sku: 'bp.cannon', platform: 'wechat' });
    expect((await post('/store/order', '198.51.100.51', { sku: 'x', platform: 'wechat' })).status).toBe(429);
    const skus = await fetch(`${baseUrl}/store/skus`, { headers: { 'x-forwarded-for': '198.51.100.51' } });
    // 401 rather than 429: still refused, on the session grounds it has always been refused
    // on, by a route that never reached a limiter. The distinction is the whole assertion.
    expect(skus.status).toBe(401);
    await skus.json();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The shipped numbers
// ─────────────────────────────────────────────────────────────────────────────

describe('the shipped budgets', () => {
  it('are the numbers their route files argue', () => {
    // Pinned, because every case above runs against an injected two-per-five-minutes. A
    // constant nobody asserts is a constant a refactor can round off.
    expect(CREATE_RATE_LIMIT).toEqual({ requests: 60, windowMs: 10 * 60_000 });
    expect(LOGIN_RATE_LIMIT).toEqual({ requests: 60, windowMs: 10 * 60_000 });
    expect(PORTAL_RATE_LIMIT).toEqual({ requests: 120, windowMs: 10 * 60_000 });
    expect(CHANGE_PASSWORD_RATE_LIMIT).toEqual({ requests: 20, windowMs: 10 * 60_000 });
    expect(FIND_RATE_LIMIT).toEqual({ requests: 120, windowMs: 10 * 60_000 });
    expect(ORDER_RATE_LIMIT).toEqual({ requests: 30, windowMs: 10 * 60_000 });
  });

  it('bound the live party set to the budget itself, because the window IS the party TTL', () => {
    // The property `CREATE_RATE_LIMIT` is argued from: a party TTLs out after ten idle minutes
    // and the budget window is ten minutes, so the budget is ALSO the ceiling on how many live
    // parties one address can hold at once.
    //
    // Asserted against `PartyService`'s own symbol, not against `10 * 60_000` written here a
    // second time. The claim is that two constants AGREE, and a test that restates the literal
    // agrees with itself while the doc comment quietly stops being true — which is the defect
    // volume 82 paid for with the room-code shape living in two places.
    expect(CREATE_RATE_LIMIT.windowMs).toBe(DEFAULT_TTL_MS);

    // And the budget has to stay far below the point where minting starts colliding: at
    // `CODE_DRAW_ATTEMPTS` draws the 503 is unreachable until the keyspace is nearly full
    // (~100k live parties), so one address's ceiling belongs orders of magnitude under that.
    expect(CODE_DRAW_ATTEMPTS).toBe(100);
    expect(CREATE_RATE_LIMIT.requests).toBeLessThan(1_000);
  });

  it('are what a server built without an override uses', async () => {
    // The injection above must not be the only wiring these routes have ever had. A default
    // server serves well past this file's tiny budget from one address, which is only true if
    // it built its own limiters from the constants.
    const server = createMatchsvcServer({ store: await freshAccounts(), secret: 'test-secret' });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${port}`;
    try {
      for (let i = 0; i < 5; i++) {
        const res = await fetch(`${url}/party/create`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.60' },
          body: JSON.stringify({ playerId: `dflt${i}` }),
        });
        expect(res.status).toBe(200);
        await res.json();
      }
      for (let i = 0; i < 5; i++) {
        const res = await fetch(`${url}/auth/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.60' },
          body: JSON.stringify({ username: `nosuch${i}`, password: 'hunter22' }),
        });
        expect(res.status).toBe(401);
        await res.json();
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
/**
 * THE THREE QUESTIONS REAL HTTP CANNOT ANSWER, asked of all six routes from one table.
 *
 * Each row names the route, a well-formed body for it, and the single unit of WORK that sits
 * behind its budget — `parties.create`, `auth.login`, the portal key fetch, `matchmaker
 * .enqueue`, the session lookup. That spy is what makes the questions answerable:
 *
 * 1. **Does it refuse before reading the body?** `fetch` always finishes sending its body, so
 *    a handler that read the body first and limited afterwards answers 429 over the wire in
 *    exactly the same way. A request whose body never ends is what tells them apart — and the
 *    ordering is the property, not decoration: a flood's next request arrives while this one
 *    is still parked on its body, so a budget taken afterwards is one the flood has walked
 *    past.
 * 2. **Does a refused call actually not happen?** A 429 on the wire says nothing about
 *    whether the work behind it ran. Dropping the `return` after a spent budget still answers
 *    429 — the first `writeHead` wins on a real response — while minting the party, booking
 *    the order or queueing the player anyway. That mutant survived every other case in this
 *    tree, HTTP and handler-level alike, until this table asked the spy.
 * 3. **Does the window elapse?** A budget that never recovers refuses a player forever after
 *    one bad minute, and every "serves then refuses" case in this file passes for it. It is
 *    also the only case that exercises the injected `nowMs` these routes take — a handler
 *    frozen at `0` is indistinguishable from a correct one without a clock to advance.
 *
 * `matchsvc.joinLimit.http.test.ts` and `matchsvc.registerLimit.http.test.ts` ask (1) and (3)
 * of their own routes, one case each. This is the same pair plus (2) for the six that landed
 * together, written as a table because the assertions are identical and the point is that
 * none of them is the exception.
 */
describe('the six budgeted handlers, from one table', () => {
  interface Responder {
    sent: { status?: number };
    res: ServerResponse;
    /** Resolves when the handler has answered — `send` ends the response on every path. */
    answered: Promise<void>;
  }

  function responder(): Responder {
    const sent: { status?: number } = {};
    let resolve!: () => void;
    const answered = new Promise<void>((r) => {
      resolve = r;
    });
    const res = {
      writeHead(status: number) {
        sent.status = status;
        return this;
      },
      end() {
        resolve();
      },
    } as unknown as ServerResponse;
    return { sent, res, answered };
  }

  function request(from: string, headers: Record<string, string> = {}): IncomingMessage {
    return Object.assign(new EventEmitter(), {
      headers: { 'x-forwarded-for': from, ...headers },
      method: 'POST',
    }) as unknown as IncomingMessage;
  }

  const silentLog = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} } as never;

  interface Row {
    name: string;
    /** The budget key this route spends, as `Limiters` names it. */
    key: keyof Limiters;
    /** A body this route accepts. */
    body: unknown;
    headers?: Record<string, string>;
    /** The status when the budget SERVES the call and `work` answers it. */
    served: number;
    /** The one call behind the budget — a spy, so "did not happen" is assertable. */
    work: () => ReturnType<typeof vi.fn>;
    run: (
      req: IncomingMessage,
      res: ServerResponse,
      budget: { limits: Partial<Limiters>; nowMs?: () => number },
      work: ReturnType<typeof vi.fn>,
    ) => void | Promise<void>;
  }

  const ROWS: Row[] = [
    {
      name: 'POST /party/create',
      key: 'partyCreate',
      body: { playerId: 'p' },
      served: 200,
      work: () => vi.fn(() => ({ partyId: 'p1', code: '123456', leaderId: 'p', members: ['p'], matching: false })),
      run: (req, res, budget, work) =>
        postCreate(req, res, new URL('http://match.test/party/create'), {
          parties: { create: work } as never,
          log: silentLog,
          ...budget,
        } as never),
    },
    {
      name: 'POST /auth/login',
      key: 'login',
      body: { username: 'alice', password: 'hunter22' },
      served: 200,
      work: () => vi.fn(() => Promise.resolve({ accountId: 'a', username: 'alice', token: 't' })),
      run: (req, res, budget, work) =>
        postLogin(req, res, new URL('http://match.test/auth/login'), {
          auth: { login: work } as never,
          ...budget,
        } as never),
    },
    {
      name: 'POST /auth/portal',
      key: 'portalLogin',
      body: { token: 'portal-token' },
      // 503: the fixture has no verification key, which is the deterministic refusal this
      // file already uses for the portal — what is being asked here is whether the WORK (the
      // key fetch, and the verify and account mint behind it) was reached at all.
      served: 503,
      work: () => vi.fn(() => Promise.resolve(null)),
      run: (req, res, budget, work) =>
        postPortalLogin(req, res, new URL('http://match.test/auth/portal'), {
          auth: {} as never,
          portal: { keys: { key: work } } as never,
          ...budget,
        } as never),
    },
    {
      name: 'POST /auth/change-password',
      key: 'changePassword',
      body: { token: 'tok', oldPassword: 'hunter22', newPassword: 'hunter333' },
      served: 401,
      work: () => vi.fn(() => Promise.resolve(null)),
      run: (req, res, budget, work) =>
        postChangePassword(req, res, new URL('http://match.test/auth/change-password'), {
          auth: { verifySession: work } as never,
          ...budget,
        } as never),
    },
    {
      name: 'POST /find',
      key: 'find',
      body: { playerCount: 2 },
      served: 200,
      work: () => vi.fn(() => ({ queueId: 'q1', ticket: null })),
      run: (req, res, budget, work) =>
        postFind(req, res, new URL('http://match.test/find'), {
          matchmaker: { enqueue: work } as never,
          pickGameserver: () => ({ wsUrl: 'ws://gs.test' }),
          secret: 'x',
          ...budget,
        } as never),
    },
    {
      name: 'POST /store/order',
      key: 'storeOrder',
      body: { sku: 'bp.cannon', platform: 'wechat' },
      // A bearer header, or `requireAuth` refuses without ever consulting the session store —
      // and the session lookup IS this route's work, so an unreachable spy would make the
      // "did not happen" assertion vacuous.
      headers: { authorization: 'Bearer tok' },
      served: 401,
      work: () => vi.fn(() => Promise.resolve(null)),
      run: (req, res, budget, work) =>
        postOrder(req, res, new URL('http://match.test/store/order'), {
          auth: { verifySession: work } as never,
          ...budget,
        } as never),
    },
  ];

  /** One request. `stall` never ends the body; otherwise it is emitted a tick later, which is
   *  after every reader in `routes/http.ts` has attached its listeners. */
  async function drive(
    row: Row,
    opts: { from: string; limiter: RateLimiter; nowMs?: () => number; stall?: boolean },
  ): Promise<{ status?: number; work: ReturnType<typeof vi.fn> }> {
    const { sent, res, answered } = responder();
    const work = row.work();
    const req = request(opts.from, row.headers);
    const done = row.run(req, res, { limits: { [row.key]: opts.limiter }, nowMs: opts.nowMs }, work);
    if (!opts.stall) {
      await Promise.resolve();
      req.emit('data', Buffer.from(JSON.stringify(row.body)));
      req.emit('end');
    }
    await done;
    await answered;
    return { status: sent.status, work };
  }

  /** One request per window, already spent by an earlier caller from the same address.
   *  (`new RateLimiter(0, …)` would NOT do: its first `take` in a window returns true
   *  whatever the limit is.) */
  function spent(from: string): RateLimiter {
    const limiter = new RateLimiter(1, 60_000);
    expect(limiter.take(from, Date.now())).toBe(true);
    return limiter;
  }

  for (const [i, row] of ROWS.entries()) {
    const from = `203.0.113.${100 + i}`;

    it(`${row.name} refuses before it reads anything`, async () => {
      // No 'data'/'end' is ever emitted. A handler that read the body first would never
      // answer, and the case would time out rather than quietly pass.
      const { status, work } = await drive(row, { from, limiter: spent(from), stall: true });
      expect(status).toBe(429);
      expect(work).not.toHaveBeenCalled();
    });

    it(`${row.name} does no work when it refuses`, async () => {
      // The body is complete this time, so the only thing stopping the route is the budget.
      const { status, work } = await drive(row, { from: `${from}:2`, limiter: spent(`${from}:2`) });
      expect(status).toBe(429);
      expect(work).not.toHaveBeenCalled();
    });

    it(`${row.name} lets the same caller through once the window elapses`, async () => {
      // One per minute, one caller, a clock this test owns. Without the third call a budget
      // frozen at `nowMs: () => 0` — or one that never resets — passes every other case in
      // this file while refusing a real player for as long as the process lives.
      let now = 1_000_000;
      const limiter = new RateLimiter(1, 60_000);
      const call = () => drive(row, { from: `${from}:3`, limiter, nowMs: () => now });

      const first = await call();
      expect(first.status).toBe(row.served);
      expect(first.work).toHaveBeenCalled();

      const refused = await call();
      expect(refused.status).toBe(429);

      now += 60_001;
      const after = await call();
      expect(after.status).toBe(row.served);
      expect(after.work).toHaveBeenCalled();
    });
  }
});
