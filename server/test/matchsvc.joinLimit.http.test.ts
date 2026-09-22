/**
 * `POST /party/join`'s per-IP budget (design/05/15 squad follow-up, 2026-09-22) — over real
 * HTTP, plus the two things real HTTP cannot show.
 *
 * Why this route: the room code became six digits on 2026-09-21, which took the keyspace from
 * 32^5 (~33.5M) to 10^6, and `routes/party.ts`'s `randomCode` wrote the consequence down
 * rather than fixing it — a caller who can POST here without a ceiling can walk the whole
 * space, and a walk buys a seat in a stranger's squad. This file is that ceiling's test.
 *
 * The property being defended is a RATE, so the case that matters most is not the 429 itself
 * but `a wrong guess is charged`: a budget that only counted the joins that LANDED would read
 * as working here while leaving the walk completely unbounded.
 *
 * The shipped budget ({@link JOIN_RATE_LIMIT}) is 120 in ten minutes, which no test can
 * exhaust at a sane runtime — so the servers here inject `joinLimiter`, the same reason
 * `matchsvc.ts` makes `authLimiter` and the matchmaker timings injectable. What that injection
 * must not be allowed to hide is that the SHIPPED constant is what the real server uses, so
 * the last describe asserts the default wiring directly.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { EventEmitter } from 'node:events';
import { createMatchsvcServer } from '../src/matchsvc';
import { RateLimiter } from '../src/rateLimit';
import { postJoin, JOIN_RATE_LIMIT, type JoinRouteDeps } from '../src/routes/party';
import { CLIENT_LOG_PATH } from '../src/routes/telemetry';
import { freshAccounts } from './mongoHarness';

let baseUrl: string;
let close: () => Promise<void>;
let now = 1_000_000;

/** A server whose join budget is small enough to exhaust, with a window long enough that the
 *  wall clock never elapses it mid-test. The cases that need a window to PASS drive the
 *  handler directly with their own clock instead. */
async function serverWithBudget(requests: number): Promise<{ url: string; stop: () => Promise<void> }> {
  const server: Server = createMatchsvcServer({
    store: await freshAccounts(),
    secret: 'test-secret',
    limits: { partyJoin: new RateLimiter(requests, 5 * 60_000) },
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

beforeAll(async () => {
  const s = await serverWithBudget(2);
  baseUrl = s.url;
  close = s.stop;
});

afterAll(async () => {
  await close();
});

/** Each case picks its own `from` address, because the budget is per address and the cases
 *  would otherwise spend each other's. `clientKey` reads the LAST x-forwarded-for hop. */
async function join(code: string, from: string, playerId = 'joiner', url = baseUrl) {
  const res = await fetch(`${url}/party/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': from },
    body: JSON.stringify({ playerId, code }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function createParty(playerId: string, url = baseUrl) {
  const res = await fetch(`${url}/party/create`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId }),
  });
  return (await res.json()) as { partyId: string; code: string; members: string[] };
}

async function partyMembers(partyId: string, url = baseUrl) {
  const res = await fetch(`${url}/party/${encodeURIComponent(partyId)}`);
  return ((await res.json()) as { members: string[] }).members;
}

describe('POST /party/join — the per-IP budget', () => {
  it('serves the budget, then refuses with 429', async () => {
    const party = await createParty('leader1');
    expect((await join(party.code, '203.0.113.21', 'p1a')).status).toBe(200);
    expect((await join(party.code, '203.0.113.21', 'p1b')).status).toBe(200);
    const refused = await join(party.code, '203.0.113.21', 'p1c');
    expect(refused.status).toBe(429);
    expect(refused.body).toMatchObject({ error: expect.stringMatching(/too many/i) });
  });

  it('a refused request never reaches the lookup', async () => {
    // The whole point of spending the budget before the body is read: the refused call must
    // not touch `PartyService` at all. A 429 that had already seated the player would leave
    // the limit bounding the RESPONSE rather than the work — and here it would hand a walker
    // the very seat it was refused.
    const party = await createParty('leader2');
    await join(party.code, '203.0.113.22', 'p2a');
    await join(party.code, '203.0.113.22', 'p2b');
    expect((await join(party.code, '203.0.113.22', 'p2c')).status).toBe(429);
    expect(await partyMembers(party.partyId)).not.toContain('p2c');
  });

  it('is per address — another caller has their own budget', async () => {
    // Without this, a single-counter limiter would read as working while it was actually
    // rationing the whole internet between every player holding a code.
    const party = await createParty('leader3');
    expect((await join(party.code, '203.0.113.23', 'p3a')).status).toBe(200);
    expect((await join(party.code, '203.0.113.23', 'p3b')).status).toBe(200);
    expect((await join(party.code, '198.51.100.23', 'p3c')).status).toBe(200);
  });

  it('takes the LAST forwarded hop, so a caller cannot mint budget by claiming to be someone else', async () => {
    // `clientKey`'s rule: earlier entries are attacker-supplied, the last one is what our own
    // proxy appended. A limiter keyed off the first hop is trivially evadable — which, for
    // this route, would mean the budget bought nothing at all.
    const party = await createParty('leader4');
    expect((await join(party.code, 'fake-a, 203.0.113.24', 'p4a')).status).toBe(200);
    expect((await join(party.code, 'fake-b, 203.0.113.24', 'p4b')).status).toBe(200);
    expect((await join(party.code, 'fake-c, 203.0.113.24', 'p4c')).status).toBe(429);
  });
});

describe('POST /party/join — what the budget is actually for', () => {
  it('a wrong guess is charged, so walking the keyspace is bounded', async () => {
    // The case this whole file exists for. Its own server, with no party ever created on it,
    // so every well-formed code is absent BY CONSTRUCTION rather than by a 1-in-10^6 hope.
    //
    // A budget charged only on a join that LANDED would pass every case above and still leave
    // a walker completely unbounded, since a walk is almost entirely misses.
    const s = await serverWithBudget(2);
    try {
      expect((await join('100001', '203.0.113.25', 'walker', s.url)).status).toBe(404);
      expect((await join('100002', '203.0.113.25', 'walker', s.url)).status).toBe(404);
      expect((await join('100003', '203.0.113.25', 'walker', s.url)).status).toBe(429);
    } finally {
      await s.stop();
    }
  });

  it('a malformed code is charged too', async () => {
    // A 400 is the other answer a prober can cheaply generate. Charging the 404s but not the
    // 400s would leave the budget spendable only by well-formed traffic, which is exactly the
    // traffic an attacker has no obligation to send.
    const s = await serverWithBudget(2);
    try {
      expect((await join('ABCDEF', '203.0.113.26', 'walker', s.url)).status).toBe(400);
      expect((await join('12345', '203.0.113.26', 'walker', s.url)).status).toBe(400);
      expect((await join('100003', '203.0.113.26', 'walker', s.url)).status).toBe(429);
    } finally {
      await s.stop();
    }
  });
});

describe('POST /party/join — the budget is its own', () => {
  it('does not spend the telemetry or registration budgets', async () => {
    // Three limiters, on purpose (`JoinRouteDeps.joinLimiter`). One shared counter would make
    // this file's deliberately tiny join budget take `/client/log` and account creation down
    // with it — and in production would let a chatty client's log batches block a join.
    const party = await createParty('leader5');
    await join(party.code, '203.0.113.27', 'p5a');
    await join(party.code, '203.0.113.27', 'p5b');
    expect((await join(party.code, '203.0.113.27', 'p5c')).status).toBe(429);

    const log = await fetch(`${baseUrl}${CLIENT_LOG_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.27' },
      body: JSON.stringify({ lines: [] }),
    });
    expect(log.status).toBeLessThan(400);

    const register = await fetch(`${baseUrl}/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.27' },
      body: JSON.stringify({ username: 'joinlimit5', password: 'hunter22' }),
    });
    expect(register.status).toBe(200);
    await register.json();
  });

  it('leaves /party/create alone', async () => {
    // `/party/create` is not bounded by THIS budget. It had no budget at all when this case
    // was written and gained its own (`CREATE_RATE_LIMIT`, 60 in ten minutes) hours later, so
    // what the case pins did not change: wiring one limiter into both handlers is the obvious
    // mistake, and nothing else here would catch it. The creates below are answered because
    // only `partyJoin` is overridden on this server, leaving create the shipped sixty.
    // `matchsvc.rateLimits.http.test.ts` asserts the same separation from the other side.
    const party = await createParty('leader6');
    await join(party.code, '203.0.113.28', 'p6a');
    await join(party.code, '203.0.113.28', 'p6b');
    expect((await join(party.code, '203.0.113.28', 'p6c')).status).toBe(429);
    const own = await createParty('leader6b');
    expect(own.code).toHaveLength(6);
  });
});

/**
 * The ordering real HTTP cannot show: `fetch` always finishes sending its body, so a handler
 * that read the body first and limited afterwards would answer 429 over the wire in exactly
 * the same way. Driving the handler with a request whose body NEVER ends is what distinguishes
 * them — and the ordering is the control, not decoration: a flood's next request arrives while
 * this one is parked on its body, so a limiter taken afterwards is one the flood has already
 * walked past.
 */
describe('postJoin — the budget is spent before the body is read', () => {
  function responder() {
    const sent: { status?: number } = {};
    const res = {
      writeHead(status: number) {
        sent.status = status;
        return this;
      },
      end() {},
    } as unknown as ServerResponse;
    return { sent, res };
  }

  function request(from: string) {
    return Object.assign(new EventEmitter(), {
      headers: { 'x-forwarded-for': from },
      method: 'POST',
    }) as unknown as IncomingMessage;
  }

  it('answers a stalled request without waiting for its body', async () => {
    const { sent, res } = responder();
    const req = request('203.0.113.29');

    // One request per window, already spent by an earlier caller from the same address.
    // (`new RateLimiter(0, …)` would NOT do: its first `take` in a window returns true
    // whatever the limit is, which is worth knowing here and is nothing this route relies on.)
    const limiter = new RateLimiter(1, 60_000);
    expect(limiter.take('203.0.113.29', Date.now())).toBe(true);
    const deps = {
      parties: {
        join: () => {
          throw new Error('must not be reached');
        },
      },
      limits: { partyJoin: limiter },
    } as unknown as JoinRouteDeps;

    // No 'data'/'end' is ever emitted on `req`. If the handler read the body first this
    // promise would never settle and the case would time out.
    await postJoin(req, res, new URL('http://match.test/party/join'), deps);
    expect(sent.status).toBe(429);
  });

  it('the window elapsing lets the same caller through again', async () => {
    const limiter = new RateLimiter(1, 60_000);
    const deps = {
      parties: { join: () => ({ partyId: 'p', code: '123456', leaderId: 'l', members: ['l'], matching: false }) },
      limits: { partyJoin: limiter },
      nowMs: () => now,
    } as unknown as JoinRouteDeps;
    const call = async () => {
      const { sent, res } = responder();
      const req = request('203.0.113.30');
      const done = postJoin(req, res, new URL('http://match.test/party/join'), deps);
      req.emit('data', Buffer.from('{"playerId":"whoever","code":"123456"}'));
      req.emit('end');
      await done;
      return sent.status;
    };
    expect(await call()).toBe(200);
    expect(await call()).toBe(429);
    now += 60_001;
    expect(await call()).toBe(200);
  });
});

describe('JOIN_RATE_LIMIT — the shipped budget', () => {
  it('is far above any human and far below a walk', () => {
    // A number, pinned, because every case above runs against an injected one. 120 in ten
    // minutes is 17,280 draws a day, so one pass over 10^6 takes about two months — slower
    // than the 10-minute TTL of the parties being walked toward — while leaving room for
    // dozens of real players behind one carrier-grade NAT inside the same window.
    expect(JOIN_RATE_LIMIT).toEqual({ requests: 120, windowMs: 10 * 60_000 });
    const perDay = JOIN_RATE_LIMIT.requests * ((24 * 60 * 60_000) / JOIN_RATE_LIMIT.windowMs);
    expect(perDay).toBeLessThan(1_000_000 / 30); // one pass over the keyspace takes over a month
  });

  it('is what a server built without an override uses', async () => {
    // The injection above must not be the only thing this route has ever been wired to. A
    // default server serves well past this file's tiny budget from one address, which is only
    // true if it built its own limiter from the constant.
    const server = createMatchsvcServer({ store: await freshAccounts(), secret: 'test-secret' });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${port}`;
    try {
      const party = await createParty('leaderDefault', url);
      for (let i = 0; i < 5; i++) {
        expect((await join(party.code, '203.0.113.31', `dflt${i}`, url)).status).not.toBe(429);
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
