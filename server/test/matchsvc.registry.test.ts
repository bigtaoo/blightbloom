/**
 * matchsvc × `GameRegistry` (ROADMAP 8.6, design/19 §6) — the wiring, over a real
 * `node:http` server on an ephemeral port.
 *
 * `GameRegistry.test.ts` proves the lookup; this file proves the three things only the
 * assembly can be wrong about, none of which any unit test of either side would notice:
 *
 *  1. **`/find`'s `wsUrl` comes from the registry, not from a constant.** The pre-8.6 code
 *     closed over `GAMESERVER_URL` and stamped it unconditionally, and every existing HTTP
 *     test asserts `/^ws:\/\//` — which a hardcoded URL satisfies forever.
 *  2. **The ticket never learns the topology.** The chosen URL travels in the response and
 *     the signed payload has no gameserver field at all, so the same seat grant redeems
 *     against whatever instance is current when it is presented (design/19 §6 supersedes
 *     the earlier "put a gameserver id inside the ticket" sketch — `ticket.ts` is untouched).
 *  3. **No instance is a refusal, not an `undefined`.** `MatchInfo.wsUrl` is non-optional on
 *     the client, so a match object issued without one would fail nowhere near here — it
 *     would surface as a socket opened on `undefined?ticket=…`. Every route answers 503,
 *     and the poll route answers it BEFORE `Matchmaker.poll` deletes the waiter.
 *
 * The registry is injected because the single-instance branch is the only one a real
 * deployment can produce today: a full, stale, or absent gameserver has no route to create
 * it through until register/heartbeat are built.
 */
import { describe, it, expect } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createMatchsvcServer, startupTarget, type MatchsvcServerOptions } from '../src/matchsvc';
import { GameRegistry, type GameServerEntry } from '../src/GameRegistry';
import { verifyTicket } from '../src/ticket';
import type { BotClientOptions } from '../src/BotClient';
import { freshAccounts } from './mongoHarness';

const SECRET = 'registry-test-secret';
/** Distinctive on purpose — a hardcoded fallback could never accidentally equal it. */
const GS_A = 'ws://gs-a.registry.test:9001/ws';
const GS_B = 'ws://gs-b.registry.test:9002/ws';

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

async function post(base: string, path: string, body: unknown) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function get(base: string, path: string) {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** A registry with no static address — the "nowhere to send this player" deployment. */
const emptyRegistry = () => new GameRegistry({ fallbackUrl: null });

/**
 * A registry whose answer depends on WHICH call it is, for the two things a real one cannot
 * express from a test: an instance disappearing between two picks inside one request, and a
 * pick made per seat rather than per room. `picks` is exposed so a test can pin the call
 * mapping it scripts against instead of assuming it.
 */
function scriptedRegistry(answer: (call: number) => string | null): GameRegistry & { picks: number } {
  const stub = {
    picks: 0,
    pick(): GameServerEntry | null {
      stub.picks += 1;
      const wsUrl = answer(stub.picks);
      return wsUrl
        ? { id: `gs${stub.picks}`, wsUrl, capacity: Infinity, load: 0, lastSeenMs: null, source: 'static' }
        : null;
    },
  };
  return stub as unknown as GameRegistry & { picks: number };
}

describe('/find takes its wsUrl from the registry', () => {
  it('returns the registered instance rather than the configured static address', async () => {
    const registry = new GameRegistry({ fallbackUrl: GS_B });
    registry.register({ id: 'a', wsUrl: GS_A, capacity: 8 });
    const ctx = await start({ registry });
    try {
      const { body } = await post(ctx.url, '/find', { playerCount: 1 });
      expect((body.match as Record<string, unknown>).wsUrl).toBe(GS_A);
    } finally {
      await ctx.close();
    }
  });

  it('returns the static address when nothing has registered (the shipping branch)', async () => {
    const ctx = await start({ registry: new GameRegistry({ fallbackUrl: GS_B }) });
    try {
      const { body } = await post(ctx.url, '/find', { playerCount: 1 });
      expect((body.match as Record<string, unknown>).wsUrl).toBe(GS_B);
    } finally {
      await ctx.close();
    }
  });

  it('follows the registry between requests instead of capturing one URL at startup', async () => {
    // The regression this catches is the whole of 8.6 reverting: a `const url = pick()` in
    // `createMatchsvcServer` would pass both cases above and fail only here.
    const registry = new GameRegistry({ fallbackUrl: null });
    registry.register({ id: 'a', wsUrl: GS_A, capacity: 8 });
    const ctx = await start({ registry });
    try {
      const first = await post(ctx.url, '/find', { playerCount: 1 });
      expect((first.body.match as Record<string, unknown>).wsUrl).toBe(GS_A);
      registry.drop('a');
      registry.register({ id: 'b', wsUrl: GS_B, capacity: 8 });
      const second = await post(ctx.url, '/find', { playerCount: 1 });
      expect((second.body.match as Record<string, unknown>).wsUrl).toBe(GS_B);
    } finally {
      await ctx.close();
    }
  });

  it('skips a full instance and lands on the static address, end to end', async () => {
    const registry = new GameRegistry({ fallbackUrl: GS_B });
    registry.register({ id: 'a', wsUrl: GS_A, capacity: 2, load: 2 });
    const ctx = await start({ registry });
    try {
      const { body } = await post(ctx.url, '/find', { playerCount: 1 });
      expect((body.match as Record<string, unknown>).wsUrl).toBe(GS_B);
    } finally {
      await ctx.close();
    }
  });
});

describe('the ticket carries no topology', () => {
  it('keeps wsUrl out of the signed payload', async () => {
    const registry = new GameRegistry({ fallbackUrl: null });
    registry.register({ id: 'a', wsUrl: GS_A, capacity: 8 });
    const ctx = await start({ registry });
    try {
      const { body } = await post(ctx.url, '/find', { playerCount: 1 });
      const match = body.match as Record<string, unknown>;
      expect(match.wsUrl).toBe(GS_A);

      const payload = verifyTicket(match.token as string, SECRET, Date.now())!;
      // Not `not.toHaveProperty('wsUrl')` alone: an id, a host or a shard index would be
      // just as much topology, so the assertion is over the payload's whole key set.
      expect(Object.keys(payload).sort()).toEqual(
        ['exp', 'mode', 'owner', 'playerCount', 'roomId', 'seed', 'teamId'].sort(),
      );
    } finally {
      await ctx.close();
    }
  });

  it('reissues a resumed seat against whatever instance is current, not the one it was issued on', async () => {
    // The payoff of rule 2 above, and the reason `ticket.ts` needed no change: a seat grant
    // signed while `a` was serving is redeemable on `b` after a failover, because the grant
    // never mentioned `a`.
    const registry = new GameRegistry({ fallbackUrl: null });
    registry.register({ id: 'a', wsUrl: GS_A, capacity: 8 });
    const ctx = await start({ registry });
    try {
      const found = await post(ctx.url, '/find', { playerCount: 1 });
      const issued = found.body.match as Record<string, unknown>;
      expect(issued.wsUrl).toBe(GS_A);

      registry.drop('a');
      registry.register({ id: 'b', wsUrl: GS_B, capacity: 8 });

      const resumed = await post(ctx.url, '/resume', { token: issued.token });
      const match = resumed.body.match as Record<string, unknown>;
      expect(match.wsUrl).toBe(GS_B);
      // Same seat, new address — if the grant itself had moved, this would be a new room.
      expect(match).toMatchObject({ roomId: issued.roomId, owner: issued.owner, seed: issued.seed });
    } finally {
      await ctx.close();
    }
  });
});

describe('no gameserver is a refusal, never an undefined wsUrl', () => {
  it('answers 503 from POST /find', async () => {
    const ctx = await start({ registry: emptyRegistry() });
    try {
      const { status, body } = await post(ctx.url, '/find', { playerCount: 1 });
      expect(status).toBe(503);
      expect(body).toEqual({ error: 'no gameserver available' });
      // The client (`net/matchmaking.ts`) rejects on `!res.ok || body.error`, so this is a
      // clean "matchmaking failed" rather than a socket opened on a missing address.
      expect(body).not.toHaveProperty('match');
    } finally {
      await ctx.close();
    }
  });

  it('answers 503 from GET /find/:queueId', async () => {
    const registry = emptyRegistry();
    const ctx = await start({ registry });
    try {
      registry.register({ id: 'a', wsUrl: GS_A, capacity: 8 });
      const { body } = await post(ctx.url, '/find', { playerCount: 4 });
      registry.drop('a');
      const polled = await get(ctx.url, `/find/${body.queueId as string}`);
      expect(polled.status).toBe(503);
      expect(polled.body).toEqual({ error: 'no gameserver available' });
    } finally {
      await ctx.close();
    }
  });

  it('answers 503 from POST /resume, and does so after the signature check', async () => {
    const registry = emptyRegistry();
    const ctx = await start({ registry });
    try {
      registry.register({ id: 'a', wsUrl: GS_A, capacity: 8 });
      const found = await post(ctx.url, '/find', { playerCount: 1 });
      const token = (found.body.match as Record<string, unknown>).token as string;
      registry.drop('a');

      const resumed = await post(ctx.url, '/resume', { token });
      expect(resumed.status).toBe(503);
      expect(resumed.body).toEqual({ error: 'no gameserver available' });
      // A forged token must still be 401 and not 503 — "we cannot serve you" must not
      // become the answer that hides "you were never granted this seat".
      const forged = await post(ctx.url, '/resume', { token: `${token}x` });
      expect(forged.status).toBe(401);
    } finally {
      await ctx.close();
    }
  });

  it('refuses the poll WITHOUT consuming the waiter it is refusing', async () => {
    // `Matchmaker.poll` deletes the waiter on its way to returning `matched`, so a 503
    // decided after the poll would destroy the seat a player has been queued for. The
    // observable difference is here: player A waits through an outage, and once an instance
    // is back and B completes the group, A's next poll matches. Had the 503 consumed A,
    // B would have queued alone and A would poll `expired`.
    const registry = emptyRegistry();
    const ctx = await start({ registry });
    try {
      registry.register({ id: 'a', wsUrl: GS_A, capacity: 8 });
      const a = await post(ctx.url, '/find', { playerCount: 2 });
      const queueId = a.body.queueId as string;
      expect(a.body.match).toBeUndefined();

      registry.drop('a');
      expect((await get(ctx.url, `/find/${queueId}`)).status).toBe(503);

      registry.register({ id: 'b', wsUrl: GS_B, capacity: 8 });
      const b = await post(ctx.url, '/find', { playerCount: 2 });
      expect(b.body.match).toBeDefined(); // B's arrival completed A's group

      const polled = await get(ctx.url, `/find/${queueId}`);
      expect(polled.status).toBe(200);
      expect(polled.body.status).toBe('matched');
      const match = polled.body.match as Record<string, unknown>;
      expect(match.wsUrl).toBe(GS_B);
      expect(match.roomId).toBe((b.body.match as Record<string, unknown>).roomId);
    } finally {
      await ctx.close();
    }
  });

  it('does not burn a formable room on a request it is about to refuse', async () => {
    // The `POST /find` counterpart: the arrival that completes a group forms the room
    // inside `enqueue`, so refusing after enqueueing would strand the players already
    // queued in a room nobody was told about. Asking first leaves them queued.
    const registry = emptyRegistry();
    const ctx = await start({ registry });
    try {
      registry.register({ id: 'a', wsUrl: GS_A, capacity: 8 });
      const first = await post(ctx.url, '/find', { playerCount: 2 });
      registry.drop('a');

      expect((await post(ctx.url, '/find', { playerCount: 2 })).status).toBe(503);

      registry.register({ id: 'b', wsUrl: GS_B, capacity: 8 });
      const third = await post(ctx.url, '/find', { playerCount: 2 });
      expect(third.body.match).toBeDefined();
      const polled = await get(ctx.url, `/find/${first.body.queueId as string}`);
      expect(polled.body.status).toBe('matched');
    } finally {
      await ctx.close();
    }
  });
});

describe('PvP bot backfill follows the registry too', () => {
  it('spawns every bot against the picked instance, not a constant', async () => {
    const registry = new GameRegistry({ fallbackUrl: GS_B });
    registry.register({ id: 'a', wsUrl: GS_A, capacity: 8 });
    const ctx = await start({ registry, matchmaker: { pvpBotFillMs: 1 } });
    try {
      const { body } = await post(ctx.url, '/find', { playerCount: 4, mode: 'pvp' });
      await new Promise((r) => setTimeout(r, 20));
      const polled = await get(ctx.url, `/find/${body.queueId as string}`);
      expect(polled.body.status).toBe('matched');
      expect(ctx.bots).toHaveLength(3);
      // One pick for the room, not one per seat: a bot on a different instance from its
      // own match is a bot that never joins.
      expect([...new Set(ctx.bots.map((b) => b.wsUrl))]).toEqual([GS_A]);
      expect((polled.body.match as Record<string, unknown>).wsUrl).toBe(GS_A);
    } finally {
      await ctx.close();
    }
  });

  it('mints no bot ticket when the instance vanishes between the route guard and the fill', async () => {
    // `onBotFill`'s own `if (!gs) return` is NOT dead code behind the route's 503, and this
    // is the window that makes it real: the route picks, then `poll()` forms the room and
    // calls back into `onBotFill`, which picks AGAIN — and an instance can go stale or
    // shut down in between. Without the guard a bot ticket is minted for a room with
    // nowhere to open a socket, and it can only expire unredeemed.
    //
    // Writing this as "empty registry, assert no bots" would assert a zero with no evidence
    // the case ever arose: with an empty registry the poll is refused before `onBotFill` can
    // run at all, so the assertion holds whether or not the guard exists.
    const registry = scriptedRegistry((call) => (call <= 2 ? GS_A : null));
    const ctx = await start({ registry, matchmaker: { pvpBotFillMs: 1 } });
    try {
      const found = await post(ctx.url, '/find', { playerCount: 4, mode: 'pvp' });
      expect(found.status).toBe(200);
      await new Promise((r) => setTimeout(r, 20));
      const polled = await get(ctx.url, `/find/${found.body.queueId as string}`);
      expect(polled.body.status).toBe('matched'); // the human still gets their seat
      expect(ctx.bots).toEqual([]); // …and nothing is minted for an address that is gone
      // Pins the call mapping this scripting depends on — 1: POST /find's guard,
      // 2: GET /find/:id's guard, 3: onBotFill's own pick. A fourth caller appearing must
      // fail here rather than silently shift which call the `null` lands on.
      expect(registry.picks).toBe(3);
    } finally {
      await ctx.close();
    }
  });

  it('picks once for the room, so every bot lands on one instance', async () => {
    // Same window, the other way round: a `pick()` moved inside the per-seat loop would
    // scatter one match's bots across instances, each opening a socket to a gameserver that
    // is not hosting their room. A registry answering differently on every call is the only
    // way to see the difference — with one instance registered, per-seat and per-room picks
    // are indistinguishable.
    const registry = scriptedRegistry((call) => `ws://gs-${call}.registry.test/ws`);
    const ctx = await start({ registry, matchmaker: { pvpBotFillMs: 1 } });
    try {
      const found = await post(ctx.url, '/find', { playerCount: 4, mode: 'pvp' });
      await new Promise((r) => setTimeout(r, 20));
      const polled = await get(ctx.url, `/find/${found.body.queueId as string}`);
      expect(polled.body.status).toBe('matched');
      expect(ctx.bots).toHaveLength(3);
      expect(new Set(ctx.bots.map((b) => b.wsUrl)).size).toBe(1);
    } finally {
      await ctx.close();
    }
  });
});

describe('the startup banner', () => {
  it('names the instance a player will actually be sent to', () => {
    const registry = new GameRegistry({ fallbackUrl: GS_B });
    registry.register({ id: 'a', wsUrl: GS_A, capacity: 8 });
    expect(startupTarget(registry)).toBe(GS_A);
  });

  it('says so when there is none, rather than logging "undefined"', () => {
    // matchsvc with no gameserver behind it starts fine and refuses every /find. This log
    // line is where an operator finds that out before a player does.
    expect(startupTarget(emptyRegistry())).toBe('(no gameserver — /find will answer 503)');
  });
});
