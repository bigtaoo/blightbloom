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
import { defaultFlags, type FlagName, type FlagValue, type FlagValues } from '../src/flags/defs';
import type { FlagClient } from '../src/flags/client';
import { freshAccounts } from './mongoHarness';
import { wideLimits } from './limitsHarness';

const SECRET = 'queue-test-secret';

/**
 * A flag client pinned to fixed values, for the cases that must go through the FLAG rather
 * than through `MatchsvcServerOptions.matchmaker`. The distinction is the whole point of
 * these: `matchmaker: { coopBotFillMs: 1 }` overrides the wiring and would pass just as
 * happily if `createMatchsvcServer` had never wired the flag to the matchmaker at all.
 */
function pinnedFlags(over: Partial<Record<FlagName, FlagValue>> = {}): FlagClient {
  // `FlagValues` types each default as a LITERAL (`FLAG_DEFS` is `as const`), so a
  // `Partial<FlagValues>` cannot express "5_000, but 0 here" — which is the only thing this
  // helper is for. Widening to `FlagValue` and casting once is the narrow escape.
  const values = { ...defaultFlags(), ...over } as FlagValues;
  return {
    get: <K extends FlagName>(name: K) => values[name],
    all: () => ({ ...values }),
    poll: async () => false,
    start: () => {},
    stop: () => {},
    healthy: () => true,
  };
}

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

/** `post` with an `Authorization` header — for the party group's auth control, which needs to
 *  send a REAL session and watch nothing change. */
async function postAs(
  base: string,
  path: string,
  body: unknown,
  token: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** A real account + session on this server's own store — same shape
 *  `matchsvc.findIdentity.http.test.ts` uses. */
async function register(base: string, username: string): Promise<{ accountId: string; token: string }> {
  const res = await fetch(`${base}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: 'hunter22' }),
  });
  return (await res.json()) as { accountId: string; token: string };
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

  it('REFUSES a body accountId — an unauthenticated seat is never a scored one', async () => {
    // Reversed 2026-09-17 (design/16 hole 3). This case used to assert the opposite, and the
    // assertion was the bug: `accountId` is what `ladderReport.ts` credits when the match
    // settles, so honouring a body field meant any caller could move any account's rating by
    // naming it here. The identity now comes from a verified bearer session or from nowhere
    // — see `matchsvc.findIdentity.http.test.ts` for the session half.
    const ctx = await start();
    try {
      const { body } = await post(ctx.url, '/find', { playerCount: 1, accountId: 'acct-7' });
      const token = (body.match as Record<string, unknown>).token as string;
      expect(verifyTicket(token, SECRET, Date.now())?.accountId).toBeUndefined();
    } finally {
      await ctx.close();
    }
  });

  it('ignores an empty-string partyId rather than treating it as a value', async () => {
    // `accountId` is deliberately NOT in this case any more: the route does not read the
    // field at all, so an empty one and a populated one are the same non-event, and keeping
    // it here would look like a boundary that is still being enforced. `partyId` IS still
    // read from the body, and empty-vs-absent is a real distinction for it.
    const ctx = await start();
    try {
      const { body } = await post(ctx.url, '/find', { playerCount: 2, partyId: '' });
      expect(body.queueId).toBeTruthy();
      expect(body.match).toBeUndefined(); // an empty partyId formed no group of its own
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

describe('practice-bot backfill — the onBotFill block', () => {
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

  it('mints an ALLY for the empty seat of a co-op queue (design/10 front-door audit)', async () => {
    // The route that was dead until 2026-09-17: a lone player taps CO-OP — `playerCount` 2,
    // `mode` 'coop' — and used to sit until `queueTtlMs` and be told the request expired.
    //
    // Driven through the FLAG, not through `matchmaker`, and that is the only reason this
    // case exists separately from `Matchmaker.test.ts`'s own co-op block: the thing it pins
    // is one line of `createMatchsvcServer` wiring `match.coopBotBackfillDelayMs` to
    // `coopBotFillMs`. Delete that line and the matchmaker falls back to its compiled-in
    // 5 s default, and this test's 20 ms wait is nowhere near it.
    const ctx = await start({ flags: pinnedFlags({ 'match.coopBotBackfillDelayMs': 0 }) });
    try {
      const { body } = await post(ctx.url, '/find', { playerCount: 2, mode: 'coop' });
      expect(body.match).toBeUndefined(); // one player is not a room yet
      await new Promise((r) => setTimeout(r, 20));

      const polled = await get(ctx.url, `/find/${body.queueId as string}`);
      expect(polled.body.status).toBe('matched');
      const seat = polled.body.match as Record<string, unknown>;
      expect(seat.owner).toBe(0); // the human keeps seat 0

      expect(ctx.bots).toHaveLength(1);
      const ally = ctx.bots[0]!;
      expect(ally.owner).toBe(1);
      expect(ally.roomId).toBe(seat.roomId);
      expect(ally.seed).toBe(seat.seed);
      expect(ally.playerCount).toBe(2);
      // The ticket carries `mode: 'coop'`, which is what the gameserver stamps into the
      // `match_start` the ally reads its brain and its EngineConfig from (BotClient.ts).
      // A bot minted with the wrong mode joins the right room and simulates a different
      // game in it.
      const payload = verifyTicket(ally.token, SECRET, Date.now());
      expect(payload).toMatchObject({ roomId: seat.roomId, owner: 1, mode: 'coop' });
    } finally {
      await ctx.close();
    }
  });

  it('keeps the two modes on SEPARATE flags — a long PvP wait does not slow co-op down', async () => {
    // The control that the two delays are wired to two different flags rather than one
    // value read twice. This is the configuration an operator with a real PvP population
    // would set, and CO-OP's second seat must not inherit its wait.
    const ctx = await start({
      flags: pinnedFlags({ 'match.coopBotBackfillDelayMs': 0, 'match.pvpBotBackfillDelayMs': 60_000 }),
    });
    try {
      const coop = await post(ctx.url, '/find', { playerCount: 2, mode: 'coop' });
      const pvp = await post(ctx.url, '/find', { playerCount: 2, mode: 'pvp' });
      await new Promise((r) => setTimeout(r, 20));

      expect((await get(ctx.url, `/find/${coop.body.queueId as string}`)).body.status).toBe('matched');
      expect((await get(ctx.url, `/find/${pvp.body.queueId as string}`)).body.status).toBe('queued');
      expect(ctx.bots.map((b) => b.owner)).toEqual([1]); // exactly the co-op ally, no PvP bot
    } finally {
      await ctx.close();
    }
  });
});

describe('/party/*', () => {
  it('creates a party whose room code is six digits, end to end', async () => {
    const ctx = await start();
    try {
      const { status, body } = await post(ctx.url, '/party/create', { playerId: 'p1' });
      expect(status).toBe(200);
      expect(typeof body.partyId).toBe('string');
      // Asserted at the HTTP boundary and not only over `randomCode`, because the shape a
      // player sees depends on the WIRING too: `matchsvc.ts` passes `randomCode` as
      // `PartyService`'s `newCode`, and a deps bundle that forgot to (or that kept a local
      // generator) is invisible to the unit test in `routes.test.ts`. The shape used to be
      // five characters of an alphabet with no 0/O/1/I; a code is now dictatable and typable
      // in every locale this game ships, and a phone shows a keypad for it.
      expect(body.code).toMatch(/^[0-9]{6}$/);
    } finally {
      await ctx.close();
    }
  });

  it('every code minted in one process is distinct — the server, not the client, dedups', async () => {
    // A wide create budget, because 120 creates from one address is twice `CREATE_RATE_LIMIT`
    // — which is the shipped budget doing exactly its job (it exists to stop one address
    // holding parties by the hundred) and not what this case is about. The budget has its own
    // file; this one is about the generator, so it buys itself out of the way rather than
    // dropping to 60 and quietly measuring half as much.
    const ctx = await start({ limits: { partyCreate: wideLimits().partyCreate } });
    try {
      // 120 parties from ONE process, all alive at once (the idle TTL is 10 minutes and this
      // test takes milliseconds). At a 1M keyspace a genuine collision is unlikely enough
      // that a broken dedup would still pass this, which is why `PartyService.test.ts` forces
      // the collision directly — what THIS pins is that the real generator and the real
      // service are wired together at all, and that 120 concurrent creates over the real HTTP
      // path produce 120 distinct codes rather than sharing one.
      const codes = await Promise.all(
        Array.from({ length: 120 }, (_, i) =>
          post(ctx.url, '/party/create', { playerId: `p${i}` }).then((r) => r.body.code as string),
        ),
      );
      expect(new Set(codes).size).toBe(120);
      for (const code of codes) expect(code).toMatch(/^[0-9]{6}$/);
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

      // Well-formed (six digits) but unknown — 404. Drawn far from anything `randomCode`
      // would have minted in this process, since a 1-in-1M clash would make this flaky.
      const missing = await post(ctx.url, '/party/join', { playerId: 'x', code: '000000' });
      expect(missing.status).toBe(404);
    } finally {
      await ctx.close();
    }
  });

  it('400s a join missing either field', async () => {
    const ctx = await start();
    try {
      expect((await post(ctx.url, '/party/join', { playerId: 'p' })).status).toBe(400);
      expect((await post(ctx.url, '/party/join', { code: '123456' })).status).toBe(400);
      expect((await post(ctx.url, '/party/join', {})).status).toBe(400);
    } finally {
      await ctx.close();
    }
  });

  it('400s a join whose code is not six digits — a different answer from 404', async () => {
    const ctx = await start();
    try {
      // "That is not a room code" and "no room has that code" are distinct answers, and the
      // distinction is worth keeping: the 400 is the one a client can act on by fixing its
      // input, and it also means this route cannot be used to feed arbitrary strings into the
      // lookup map. The old five-character alphabetic shape is on this list on purpose — it
      // is exactly what a stale client or a bookmarked invite link would send.
      for (const code of ['ABCDE', '12345', '1234567', 'ABC123', '12 456', '', '12345 ']) {
        const res = await post(ctx.url, '/party/join', { playerId: 'p', code });
        expect(res.status).toBe(400);
      }
    } finally {
      await ctx.close();
    }
  });

  it('refuses a code sent as a JSON NUMBER — the hazard a digit-only code introduces', async () => {
    // New with the six-digit shape (2026-09-21) and worth its own case, because it is the
    // mistake the shape invites: a code that looks like an integer round-trips through one
    // in a client that forgets `String()`, and `004271` comes back as `4271`. Two different
    // wrong things then follow — a silently truncated code, and a `code` field that is not a
    // string at all — and the route has to refuse both rather than coerce.
    //
    // A 400 and not a 404: the service never stringifies the body, so `join` would be handed
    // a number and miss on a Map keyed by strings, which is a 404 that reads as "your
    // friend's code is wrong" when the bug is entirely on the sending side.
    const ctx = await start();
    try {
      const created = await post(ctx.url, '/party/create', { playerId: 'leader' });
      const asNumber = Number(created.body.code as string);
      expect((await post(ctx.url, '/party/join', { playerId: 'p', code: asNumber })).status).toBe(400);
      // And the truncation itself, spelled out: a leading-zero code passed through a number
      // is a DIFFERENT, shorter string, which the pattern refuses too.
      expect(String(Number('004271'))).toBe('4271');
      expect((await post(ctx.url, '/party/join', { playerId: 'p', code: 4271 })).status).toBe(400);
      expect((await post(ctx.url, '/party/join', { playerId: 'p', code: '4271' })).status).toBe(400);
    } finally {
      await ctx.close();
    }
  });

  it('tolerates whitespace around a pasted code rather than refusing it', async () => {
    const ctx = await start();
    try {
      // A code arriving from a chat message or a copy-paste carries a leading/trailing space
      // often enough that refusing it would read as "the code my friend sent me is wrong".
      // The trim is the route's, not the service's: `PartyService` keys its map on the exact
      // string it minted.
      const created = await post(ctx.url, '/party/create', { playerId: 'leader' });
      const joined = await post(ctx.url, '/party/join', {
        playerId: 'friend',
        code: `  ${created.body.code as string}
`,
      });
      expect(joined.status).toBe(200);
      expect(joined.body.members).toEqual(['leader', 'friend']);
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

  it('IGNORES a valid bearer token — playerId alone names a member, logged in or not', async () => {
    // The positive control for the case below, and it is not redundant with it. "Works
    // without a header" is also true of a route that reads the session WHEN one is present
    // and quietly prefers it over `playerId` — which would mean a logged-in player's seat is
    // identified differently from a guest's, for reasons nothing in the design states, and
    // that a member who logs in mid-lobby changes identity under their own party.
    //
    // So: the same `playerId` under a real session must produce the same roster entry, and a
    // `playerId` that DISAGREES with the session must still win, because this route has no
    // business resolving identity at all (that is `/find`'s job, and only for the ladder).
    const ctx = await start();
    try {
      const session = await register(ctx.url, 'ada');
      const created = await postAs(ctx.url, '/party/create', { playerId: 'declared-a' }, session.token);
      expect(created.status).toBe(200);
      expect(created.body.leaderId).toBe('declared-a');
      expect(created.body.members).toEqual(['declared-a']);
      expect(created.body.leaderId).not.toBe(session.accountId);

      // And the leader check keys off the declared id too: the session holder is NOT the
      // leader here, so starting as the account id has to be refused.
      const partyId = created.body.partyId as string;
      const byAccount = await postAs(ctx.url, '/party/start', { partyId, playerId: session.accountId }, session.token);
      expect(byAccount.status).toBe(404);
      const byDeclared = await postAs(ctx.url, '/party/start', { partyId, playerId: 'declared-a' }, session.token);
      expect(byDeclared.status).toBe(200);
    } finally {
      await ctx.close();
    }
  });

  it('runs the WHOLE squad flow with no Authorization header — a login is never required', async () => {
    // Audited and pinned 2026-09-21, because "does this need an account?" is a question
    // whose answer is a scatter of ABSENT auth checks, and an absence is exactly what no
    // test asserts by accident. It is a decision, not an oversight: design/16's "logging in
    // is never required to play", and `matchsvc.findIdentity.http.test.ts` already pins the
    // matchmaking half ("still gets a playable seat — nothing but the ladder key is
    // withheld"). This is the party half, end to end.
    //
    // `post` sends no `authorization`, which is the point of using it here: adding
    // `requireAuth` to any of these five routes, or to `/find`, has to turn this red.
    // A `playerId` is a client-declared string either way — the account layer gates
    // `/account/*` and `/store/*` and nothing else, and the worst a forged party id can do
    // is confuse a party the forger has already joined.
    const ctx = await start();
    try {
      const created = await post(ctx.url, '/party/create', { playerId: 'guest-a' });
      expect(created.status).toBe(200);
      const code = created.body.code as string;
      const partyId = created.body.partyId as string;

      expect((await post(ctx.url, '/party/join', { playerId: 'guest-b', code })).status).toBe(200);
      expect((await get(ctx.url, `/party/${partyId}`)).body.members).toEqual(['guest-a', 'guest-b']);
      expect((await post(ctx.url, '/party/start', { partyId, playerId: 'guest-a' })).status).toBe(200);

      // And the queue entry the squad's members each make off the back of that start — the
      // step that would be pointless to leave open if the lobby needed a login.
      const queued = await post(ctx.url, '/find', { playerCount: 8, mode: 'pvp', partyId });
      expect(queued.status).toBe(200);
      expect(typeof queued.body.queueId).toBe('string');

      expect((await post(ctx.url, '/party/leave', { partyId, playerId: 'guest-b' })).status).toBe(200);
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
      expect(await read.json()).toEqual({ data: null, entitlements: [], guestMerged: true }); // nothing was stored
    } finally {
      await ctx.close();
    }
  });
});
