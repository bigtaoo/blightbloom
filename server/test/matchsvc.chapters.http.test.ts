/**
 * matchsvc and PvE chapters (2026-10-06), over a real `node:http` server — the wiring half of
 * what `Matchmaker.chapters.test.ts` proves of the pure core: that `/find` reads the chapter
 * a co-op player chose (and refuses one it does not know), that a party's members are seated
 * in the chapter its host fixed at `/party/start`, and that a bot minted to fill a co-op room
 * carries that room's chapter. `chapterField.ts` has the absent/unknown policy under test.
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

const SECRET = 'chapters-test-secret';

/** The same pinned flag client `matchsvc.queue.http.test.ts` uses, for the bot-fill case. */
function pinnedFlags(over: Partial<Record<FlagName, FlagValue>> = {}): FlagClient {
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

type Res = { status: number; body: Record<string, unknown> };

async function post(base: string, path: string, body: unknown): Promise<Res> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function get(base: string, path: string): Promise<Res> {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** The chapter signed into a `/find` response's ticket. */
const chapterOf = (res: Res): unknown =>
  verifyTicket((res.body.match as { token: string }).token, SECRET, Date.now())?.chapterId;

describe('POST /find — the co-op chapter', () => {
  it('signs the chapter a co-op request names, and groups two players who named it', async () => {
    const ctx = await start();
    try {
      await post(ctx.url, '/find', { playerCount: 2, mode: 'coop', chapterId: 'frost' });
      const b = await post(ctx.url, '/find', { playerCount: 2, mode: 'coop', chapterId: 'frost' });
      expect(b.status).toBe(200);
      expect(chapterOf(b)).toBe('frost');
    } finally {
      await ctx.close();
    }
  });

  it('does not group a co-op player with one who named another chapter', async () => {
    const ctx = await start();
    try {
      await post(ctx.url, '/find', { playerCount: 2, mode: 'coop', chapterId: 'frost' });
      const b = await post(ctx.url, '/find', { playerCount: 2, mode: 'coop', chapterId: 'ember' });
      expect(b.status).toBe(200);
      expect(b.body.match).toBeUndefined();
    } finally {
      await ctx.close();
    }
  });

  it('reads a request with no chapter — every pre-chapter client — as the first chapter', async () => {
    const ctx = await start();
    try {
      await post(ctx.url, '/find', { playerCount: 2, mode: 'coop' });
      const b = await post(ctx.url, '/find', { playerCount: 2, mode: 'coop', chapterId: 'ember' });
      expect(chapterOf(b)).toBe('ember'); // the same queue, so the second arrival completed it
    } finally {
      await ctx.close();
    }
  });

  it('400s a co-op request naming a chapter this server does not know — never a silent default', async () => {
    const ctx = await start();
    try {
      for (const chapterId of ['abyss', 7, null, '']) {
        const res = await post(ctx.url, '/find', { playerCount: 1, mode: 'coop', chapterId });
        expect(res.status, JSON.stringify(chapterId)).toBe(400);
        expect(res.body.error).toBe('unknown chapter');
      }
    } finally {
      await ctx.close();
    }
  });

  it('does not read the field on a PvP request at all', async () => {
    const ctx = await start();
    try {
      const res = await post(ctx.url, '/find', { playerCount: 1, mode: 'pvp', chapterId: 'abyss' });
      expect(res.status).toBe(200);
      const payload = verifyTicket((res.body.match as { token: string }).token, SECRET, Date.now());
      expect(payload).not.toHaveProperty('chapterId');
    } finally {
      await ctx.close();
    }
  });

  it('mints the co-op ally of a frost room a frost ticket', async () => {
    const ctx = await start({ flags: pinnedFlags({ 'match.coopBotBackfillDelayMs': 0 }) });
    try {
      const { body } = await post(ctx.url, '/find', { playerCount: 2, mode: 'coop', chapterId: 'frost' });
      await new Promise((r) => setTimeout(r, 20));
      const polled = await get(ctx.url, `/find/${body.queueId as string}`);
      expect(polled.body.status).toBe('matched');
      expect(ctx.bots).toHaveLength(1);
      // Without it the gameserver refuses the bot as disagreeing with the room it was minted for.
      expect(verifyTicket(ctx.bots[0]!.token, SECRET, Date.now())).toMatchObject({ bot: true, chapterId: 'frost' });
    } finally {
      await ctx.close();
    }
  });
});

describe('a co-op party plays its host’s chapter', () => {
  async function coopParty(ctx: Ctx): Promise<string> {
    const created = await post(ctx.url, '/party/create', { playerId: 'host', mode: 'coop' });
    await post(ctx.url, '/party/join', { playerId: 'guest', code: created.body.code });
    return created.body.partyId as string;
  }

  it('fixes the chapter at START and seats every member in it, whatever the member asked for', async () => {
    const ctx = await start();
    try {
      const partyId = await coopParty(ctx);
      const started = await post(ctx.url, '/party/start', { partyId, playerId: 'host', chapterId: 'frost' });
      expect(started.status).toBe(200);
      expect(started.body.chapterId).toBe('frost');
      expect((await get(ctx.url, `/party/${partyId}`)).body.chapterId).toBe('frost');

      await post(ctx.url, '/find', { playerCount: 2, mode: 'coop', partyId, chapterId: 'frost' });
      // The guest's own client has only chapter 1 selected: the party's chapter wins.
      const guest = await post(ctx.url, '/find', { playerCount: 2, mode: 'coop', partyId, chapterId: 'ember' });
      expect(chapterOf(guest)).toBe('frost');
    } finally {
      await ctx.close();
    }
  });

  it('a START with no chapter — a pre-chapter client — is the first chapter', async () => {
    const ctx = await start();
    try {
      const partyId = await coopParty(ctx);
      const started = await post(ctx.url, '/party/start', { partyId, playerId: 'host' });
      expect(started.body.chapterId).toBe('ember');
    } finally {
      await ctx.close();
    }
  });

  it('400s a START naming an unknown chapter, and leaves the party not yet matching', async () => {
    const ctx = await start();
    try {
      const partyId = await coopParty(ctx);
      const res = await post(ctx.url, '/party/start', { partyId, playerId: 'host', chapterId: 'abyss' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('unknown chapter');
      expect((await get(ctx.url, `/party/${partyId}`)).body.matching).toBe(false);
    } finally {
      await ctx.close();
    }
  });

  it('shows no chapter on a PvP squad', async () => {
    const ctx = await start();
    try {
      const created = await post(ctx.url, '/party/create', { playerId: 'host', mode: 'pvp' });
      const started = await post(ctx.url, '/party/start', { partyId: created.body.partyId, playerId: 'host', chapterId: 'frost' });
      expect(started.status).toBe(200);
      expect(started.body).not.toHaveProperty('chapterId');
    } finally {
      await ctx.close();
    }
  });
});
