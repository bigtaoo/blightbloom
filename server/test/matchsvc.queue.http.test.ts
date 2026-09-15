/**
 * matchsvc's QUEUE and PARTY HTTP surface, over a real `node:http` server on an ephemeral
 * port — the half `matchsvc.http.test.ts` (accounts, ratings, CORS) does not touch.
 *
 * Why a second file rather than more cases in the first: everything here needs its own
 * server instance with its own `matchmaker` timing, because bot backfill is a 30-second wait
 * in production and has to be shortened per test. The accounts file deliberately shares one
 * long-lived server across its whole suite, and mixing the two shapes in one file makes the
 * shared-instance cases order-dependent on the ones that build their own.
 *
 * What this closes (measured 2026-09-03, before): `matchsvc.ts` was at 64.07% lines / 66.13%
 * branches, and the misses were not obscure corners — `POST /find`, `GET /find/:queueId`,
 * every one of the five `/party/*` endpoints, the `randomCode` join-code generator and the
 * whole `onBotFill` block had NO coverage at any layer. The pure cores under them
 * (`Matchmaker`, `PartyService`) were thoroughly unit-tested the entire time, which is
 * exactly what made the gap invisible: the logic was proven and the wiring to it was not,
 * so a swapped argument or a dropped field in the HTTP shell would have shipped green.
 */
import { describe, it, expect } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createMatchsvcServer, type MatchsvcServerOptions } from '../src/matchsvc';
import { verifyTicket } from '../src/ticket';
import type { BotClientOptions } from '../src/BotClient';
import { freshAccounts } from './mongoHarness';

const SECRET = 'queue-test-secret';

interface Ctx {
  url: string;
  bots: BotClientOptions[];
  close: () => Promise<void>;
}

async function start(opts: Partial<Omit<MatchsvcServerOptions, 'store' | 'secret'>> = {}): Promise<Ctx> {
  const bots: BotClientOptions[] = [];
  const server: Server = createMatchsvcServer({
    store: await freshAccounts(),
    secret: SECRET,
    spawnBot: (o) => void bots.push(o),
    ...opts,
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    bots,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function post(
  base: string,
  path: string,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function get(
  base: string,
  path: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('POST /find', () => {
  it('matches a solo co-op request inline and returns a redeemable ticket', async () => {
    const ctx = await start();
    try {
      const { status, body } = await post(ctx.url, '/find', { playerCount: 1 });
      expect(status).toBe(200);
      expect(typeof body.queueId).toBe('string');

      const match = body.match as Record<string, unknown>;
      // `withUrl` is what turns a Matchmaker ticket into something a client can act on —
      // a ticket with no wsUrl leaves the browser with nowhere to connect, and every unit
      // test of Matchmaker passes without it.
      expect(match.wsUrl).toMatch(/^ws:\/\//);
      expect(match).toMatchObject({ owner: 0, playerCount: 1, mode: 'coop' });

      const payload = verifyTicket(match.token as string, SECRET, Date.now());
      expect(payload).toMatchObject({ roomId: match.roomId, owner: 0, seed: match.seed });
    } finally {
      await ctx.close();
    }
  });

  it('queues a request that cannot form a room yet, with no ticket', async () => {
    const ctx = await start();
    try {
      const { body } = await post(ctx.url, '/find', { playerCount: 2 });
      expect(typeof body.queueId).toBe('string');
      expect(body.match).toBeUndefined();
    } finally {
      await ctx.close();
    }
  });

  it("reads mode 'pvp', and treats anything else as co-op rather than 400ing", async () => {
    // The stated contract in the handler's own comment: a client that predates the `mode`
    // field must never be rejected. A typo therefore has to land on 'coop', not on an error.
    const ctx = await start();
    try {
      const pvp = await post(ctx.url, '/find', { playerCount: 1, mode: 'pvp' });
      expect((pvp.body.match as Record<string, unknown>).mode).toBe('pvp');

      for (const mode of ['coop', 'PVP', 'typo', undefined]) {
        const res = await post(ctx.url, '/find', { playerCount: 1, mode });
        expect(res.status).toBe(200);
        expect((res.body.match as Record<string, unknown>).mode).toBe('coop');
      }
    } finally {
      await ctx.close();
    }
  });

  it('400s an out-of-range playerCount, quoting the error rather than crashing', async () => {
    const ctx = await start();
    try {
      for (const playerCount of [0, -1, 99, 'four', undefined]) {
        const { status, body } = await post(ctx.url, '/find', { playerCount });
        expect(status, `playerCount=${String(playerCount)}`).toBe(400);
        expect(typeof body.error).toBe('string');
      }
    } finally {
      await ctx.close();
    }
  });

  it('groups two callers who send the same partyId into ONE room', async () => {
    const ctx = await start();
    try {
      const a = await post(ctx.url, '/find', { playerCount: 2, partyId: 'party-1' });
      const b = await post(ctx.url, '/find', { playerCount: 2, partyId: 'party-1' });
      const ticket = b.body.match as Record<string, unknown>;
      expect(ticket).toBeTruthy();
      // The second arrival completes the room and gets its ticket inline; the first has to
      // poll for the same roomId. An ignored partyId would still produce a room here — the
      // assertion that matters is that BOTH seats belong to it.
      const polled = await get(ctx.url, `/find/${a.body.queueId as string}`);
      expect(polled.body.status).toBe('matched');
      expect((polled.body.match as Record<string, unknown>).roomId).toBe(ticket.roomId);
    } finally {
      await ctx.close();
    }
  });

  it('accepts an accountId and carries it into the signed ticket', async () => {
    // The ladder reads this back off the seat (design/16). A dropped accountId is silent:
    // the match plays normally and the rating report falls back to its seat: scaffold.
    const ctx = await start();
    try {
      const { body } = await post(ctx.url, '/find', { playerCount: 1, accountId: 'acct-7' });
      const token = (body.match as Record<string, unknown>).token as string;
      expect(verifyTicket(token, SECRET, Date.now())?.accountId).toBe('acct-7');
    } finally {
      await ctx.close();
    }
  });

  it('ignores an empty-string partyId/accountId rather than treating it as a value', async () => {
    const ctx = await start();
    try {
      const { body } = await post(ctx.url, '/find', {
        playerCount: 1,
        partyId: '',
        accountId: '',
      });
      expect(verifyTicket((body.match as Record<string, unknown>).token as string, SECRET, Date.now())
        ?.accountId).toBeUndefined();
    } finally {
      await ctx.close();
    }
  });
});

describe('GET /find/:queueId', () => {
  it('reports a still-waiting request as queued', async () => {
    const ctx = await start();
    try {
      const { body } = await post(ctx.url, '/find', { playerCount: 4 });
      const polled = await get(ctx.url, `/find/${body.queueId as string}`);
      expect(polled.status).toBe(200);
      expect(polled.body).toEqual({ status: 'queued' });
    } finally {
      await ctx.close();
    }
  });

  it('adds wsUrl to a matched poll result, exactly as POST /find does', async () => {
    const ctx = await start();
    try {
      const a = await post(ctx.url, '/find', { playerCount: 2 });
      await post(ctx.url, '/find', { playerCount: 2 });
      const polled = await get(ctx.url, `/find/${a.body.queueId as string}`);
      expect(polled.body.status).toBe('matched');
      expect((polled.body.match as Record<string, unknown>).wsUrl).toMatch(/^ws:\/\//);
    } finally {
      await ctx.close();
    }
  });

  it('reports an unknown queue id as expired instead of 404ing or throwing', async () => {
    const ctx = await start();
    try {
      // A client polling across a matchsvc restart hits this. `expired` is what its retry
      // logic understands; a 404 body would be parsed as a poll result and read as garbage.
      const polled = await get(ctx.url, '/find/no-such-queue');
      expect(polled.status).toBe(200);
      expect(polled.body).toEqual({ status: 'expired' });
    } finally {
      await ctx.close();
    }
  });
});

describe('PvP bot backfill — the onBotFill block', () => {
  it('mints one correctly-signed ticket per EMPTY seat when a pvp queue fills with bots', async () => {
    // 30 s in production, 1 ms here. One real player asks for a 4-seat pvp match, nobody
    // else arrives, and the room forms anyway with three bots.
    const ctx = await start({ matchmaker: { pvpBotFillMs: 1 } });
    try {
      const { body } = await post(ctx.url, '/find', { playerCount: 4, mode: 'pvp' });
      expect(body.match).toBeUndefined(); // one player is not a room yet
      await new Promise((r) => setTimeout(r, 20));

      const polled = await get(ctx.url, `/find/${body.queueId as string}`);
      expect(polled.body.status).toBe('matched');
      const seat = polled.body.match as Record<string, unknown>;

      expect(ctx.bots).toHaveLength(3);
      // Seats 1..3 — the real player kept seat 0, and a bot per remaining seat is the whole
      // contract. A duplicated or missing owner index means two bots share a seat or one
      // never fills, and the match stalls waiting for a player that will never connect.
      expect(ctx.bots.map((b) => b.owner).sort()).toEqual([1, 2, 3]);
      for (const bot of ctx.bots) {
        expect(bot.roomId).toBe(seat.roomId);
        expect(bot.seed).toBe(seat.seed);
        expect(bot.playerCount).toBe(4);
        expect(bot.wsUrl).toMatch(/^ws:\/\//);
        // Each bot's token has to verify against the SAME secret the gameserver checks, for
        // its OWN seat — a bot handed the wrong owner is refused at the handshake, silently.
        const payload = verifyTicket(bot.token, SECRET, Date.now());
        expect(payload).toMatchObject({ roomId: seat.roomId, owner: bot.owner, mode: 'pvp' });
        expect(typeof payload!.teamId).toBe('number');
      }
    } finally {
      await ctx.close();
    }
  });

  it('never bot-fills a CO-OP queue — that mode expires instead', async () => {
    // The control for the case above. Without it, `expect(bots).toHaveLength(3)` would pass
    // just as happily if bot-fill fired for every mode.
    const ctx = await start({ matchmaker: { pvpBotFillMs: 1, queueTtlMs: 1 } });
    try {
      const { body } = await post(ctx.url, '/find', { playerCount: 4, mode: 'coop' });
      await new Promise((r) => setTimeout(r, 20));
      const polled = await get(ctx.url, `/find/${body.queueId as string}`);
      expect(polled.body.status).toBe('expired');
      expect(ctx.bots).toEqual([]);
    } finally {
      await ctx.close();
    }
  });
});

describe('/party/*', () => {
  it('creates a party with a human-typeable code from the unambiguous alphabet', async () => {
    const ctx = await start();
    try {
      const { status, body } = await post(ctx.url, '/party/create', { playerId: 'p1' });
      expect(status).toBe(200);
      expect(typeof body.partyId).toBe('string');
      // `randomCode`'s whole point: a player reads this to a friend out loud, so 0/O and 1/I
      // are excluded. A regression to a plain base36 generator is invisible until someone
      // mistypes a code, which no automated signal ever reports.
      expect(body.code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{5}$/);
    } finally {
      await ctx.close();
    }
  });

  it('400s a create with no playerId', async () => {
    const ctx = await start();
    try {
      expect((await post(ctx.url, '/party/create', {})).status).toBe(400);
      expect((await post(ctx.url, '/party/create', { playerId: '' })).status).toBe(400);
      expect((await post(ctx.url, '/party/create', { playerId: 7 })).status).toBe(400);
    } finally {
      await ctx.close();
    }
  });

  it('joins by code, and 404s an unknown one', async () => {
    const ctx = await start();
    try {
      const created = await post(ctx.url, '/party/create', { playerId: 'leader' });
      const joined = await post(ctx.url, '/party/join', {
        playerId: 'friend',
        code: created.body.code,
      });
      expect(joined.status).toBe(200);
      expect(joined.body.partyId).toBe(created.body.partyId);
      expect(joined.body.members).toEqual(['leader', 'friend']);

      const missing = await post(ctx.url, '/party/join', { playerId: 'x', code: 'ZZZZZ' });
      expect(missing.status).toBe(404);
    } finally {
      await ctx.close();
    }
  });

  it('400s a join missing either field', async () => {
    const ctx = await start();
    try {
      expect((await post(ctx.url, '/party/join', { playerId: 'p' })).status).toBe(400);
      expect((await post(ctx.url, '/party/join', { code: 'ABCDE' })).status).toBe(400);
      expect((await post(ctx.url, '/party/join', {})).status).toBe(400);
    } finally {
      await ctx.close();
    }
  });

  it('reads a party back by id, and 404s an unknown id', async () => {
    const ctx = await start();
    try {
      const created = await post(ctx.url, '/party/create', { playerId: 'leader' });
      const read = await get(ctx.url, `/party/${created.body.partyId as string}`);
      expect(read.status).toBe(200);
      expect(read.body.members).toEqual(['leader']);
      expect((await get(ctx.url, '/party/nope')).status).toBe(404);
    } finally {
      await ctx.close();
    }
  });

  it('leaves a party', async () => {
    const ctx = await start();
    try {
      const created = await post(ctx.url, '/party/create', { playerId: 'leader' });
      await post(ctx.url, '/party/join', { playerId: 'friend', code: created.body.code });
      const left = await post(ctx.url, '/party/leave', {
        partyId: created.body.partyId,
        playerId: 'friend',
      });
      expect(left.status).toBe(200);
      const read = await get(ctx.url, `/party/${created.body.partyId as string}`);
      expect(read.body.members).toEqual(['leader']);
    } finally {
      await ctx.close();
    }
  });

  it('400s a leave with a non-string field', async () => {
    const ctx = await start();
    try {
      expect((await post(ctx.url, '/party/leave', { partyId: 'x' })).status).toBe(400);
      expect((await post(ctx.url, '/party/leave', { playerId: 'x' })).status).toBe(400);
    } finally {
      await ctx.close();
    }
  });

  it('starts matching as the leader, and 404s for anyone else', async () => {
    const ctx = await start();
    try {
      const created = await post(ctx.url, '/party/create', { playerId: 'leader' });
      await post(ctx.url, '/party/join', { playerId: 'friend', code: created.body.code });

      // The permission decision is the point: a non-leader starting the squad's match is the
      // difference between a party feature and a griefing tool, and 404 is the shell's way of
      // saying "not found OR not leader" without leaking which.
      const byFriend = await post(ctx.url, '/party/start', {
        partyId: created.body.partyId,
        playerId: 'friend',
      });
      expect(byFriend.status).toBe(404);

      const byLeader = await post(ctx.url, '/party/start', {
        partyId: created.body.partyId,
        playerId: 'leader',
      });
      expect(byLeader.status).toBe(200);
      expect(byLeader.body.matching).toBe(true);
    } finally {
      await ctx.close();
    }
  });

  it('400s a start with a non-string field', async () => {
    const ctx = await start();
    try {
      expect((await post(ctx.url, '/party/start', { partyId: 'x' })).status).toBe(400);
      expect((await post(ctx.url, '/party/start', { playerId: 'x' })).status).toBe(400);
    } finally {
      await ctx.close();
    }
  });
});

describe('the request body reader', () => {
  it('treats a malformed JSON body as an empty object rather than 500ing', async () => {
    const ctx = await start();
    try {
      const res = await fetch(`${ctx.url}/party/create`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{ not json at all',
      });
      // `readJson`'s catch hands the handler `{}`, which fails its own validation — a 400,
      // not a crashed request. A `JSON.parse` that threw out of the 'end' listener would be
      // an uncaught exception and take the whole process down.
      expect(res.status).toBe(400);
      expect((await res.json()) as Record<string, unknown>).toMatchObject({
        error: 'playerId required',
      });
    } finally {
      await ctx.close();
    }
  });

  it('drops the tail of an oversized body instead of buffering it', async () => {
    const ctx = await start();
    try {
      const res = await fetch(`${ctx.url}/party/create`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ playerId: 'p1', pad: 'x'.repeat(8192) }),
      });
      // The 4 KB cap is a memory guard on an unauthenticated endpoint. The truncated body no
      // longer parses, so this lands on the same `{}` path as the malformed case above —
      // what must NOT happen is the server accepting an arbitrarily large payload.
      expect(res.status).toBe(400);
    } finally {
      await ctx.close();
    }
  });

  it('404s an unknown route', async () => {
    const ctx = await start();
    try {
      expect((await get(ctx.url, '/nope')).status).toBe(404);
      expect((await post(ctx.url, '/nope', {})).status).toBe(404);
    } finally {
      await ctx.close();
    }
  });
});

describe('a literal null JSON body', () => {
  // `JSON.parse('null')` is valid and yields `null`, so every handler that destructures its
  // body needs the `?? {}` fallback — without it the destructure throws inside the request
  // callback, which is an uncaught exception rather than a 400. These were the last
  // uncovered arms in this file. A client sends this by posting `null`, which is exactly
  // what a `JSON.stringify(undefined)`-shaped bug on the client produces.
  // The third column is any credential the route needs before it will even look at the
  // body. `/rating/report` became an internal route in ROADMAP 8.1, and without its key it
  // would answer 401 without ever reaching the `?? {}` fallback this sweep is about — a
  // green case that had stopped testing anything.
  it.each([
    ['/party/join', 400, {}],
    ['/party/leave', 400, {}],
    ['/party/start', 400, {}],
    ['/rating/report', 400, { 'x-internal-key': 'dev-insecure-internal-key-do-not-use-in-prod' }],
    ['/auth/register', 400, {}],
    ['/auth/login', 401, {}],
    ['/auth/change-password', 401, {}],
  ])('%s answers %i instead of throwing', async (path, expected, credential) => {
    const ctx = await start();
    try {
      const res = await fetch(`${ctx.url}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(credential as Record<string, string>) },
        body: 'null',
      });
      expect(res.status).toBe(expected);
      expect(typeof ((await res.json()) as { error?: unknown }).error).toBe('string');
    } finally {
      await ctx.close();
    }
  });

  it('/find answers 400 for a null body', async () => {
    const ctx = await start();
    try {
      const res = await fetch(`${ctx.url}/find`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'null',
      });
      expect(res.status).toBe(400);
    } finally {
      await ctx.close();
    }
  });
});

describe('/auth/change-password and /account/meta guards', () => {
  it('401s a change-password whose token is not a live session', async () => {
    const ctx = await start();
    try {
      const res = await post(ctx.url, '/auth/change-password', {
        token: 'not-a-session',
        oldPassword: 'hunter22',
        newPassword: 'hunter33',
      });
      expect(res.status).toBe(401);
    } finally {
      await ctx.close();
    }
  });

  it('400s a meta write with no data field, without writing a row', async () => {
    // `data === undefined` is the difference between "store this" and "store the JSON text
    // 'undefined'", which would come back as an unparseable blob on the next read.
    const ctx = await start();
    try {
      const reg = await post(ctx.url, '/auth/register', { username: 'metauser', password: 'hunter22' });
      const token = reg.body.token as string;
      const write = await fetch(`${ctx.url}/account/meta`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({}),
      });
      expect(write.status).toBe(400);

      const read = await fetch(`${ctx.url}/account/meta`, {
        headers: { authorization: `Bearer ${token}` },
      });
      // `entitlements` rides alongside `data` since ROADMAP 8.2 (design/19 §2); empty here
      // because a brand-new account owns nothing the server minted.
      expect(await read.json()).toEqual({ data: null, entitlements: [] }); // nothing was stored
    } finally {
      await ctx.close();
    }
  });
});
