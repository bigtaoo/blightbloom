/**
 * gameserver HTTP+WS integration tests (design/06, ROADMAP 3.3) — mirrors
 * `matchsvc.http.test.ts`'s real-HTTP-on-ephemeral-port style, now that `createGameserver`
 * (src/index.ts) is a real importable factory instead of `main()` running unconditionally
 * at module scope. Drives the real `node:http` + `ws` layers: a real `/health` fetch, a
 * real WebSocket handshake (both the ticket-mandatory and the dev-fallback legacy
 * raw-param path), and a real end-to-end `match_start` once a playerCount:1 room fills.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { WebSocket, type WebSocketServer } from 'ws';
import { createGameserver } from '../src/index';
import { createMatchsvcServer } from '../src/matchsvc';
import { signTicket, type TicketPayload } from '../src/ticket';
import type { RoomManager } from '../src/RoomManager';

const SECRET = 'test-gameserver-secret';

function start(opts: Parameters<typeof createGameserver>[0] = {}): {
  wsBase: string;
  httpBase: string;
  server: Server;
  wss: WebSocketServer;
  manager: RoomManager;
  close: () => Promise<void>;
} {
  const { server, wss, manager } = createGameserver(opts);
  return {
    server,
    wss,
    manager,
    get wsBase() {
      const { port } = server.address() as AddressInfo;
      return `ws://127.0.0.1:${port}/ws`;
    },
    get httpBase() {
      const { port } = server.address() as AddressInfo;
      return `http://127.0.0.1:${port}`;
    },
    close: () =>
      new Promise<void>((resolve) => {
        manager.destroyAll();
        wss.close();
        server.close(() => resolve());
      }),
  };
}

async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.listen(0, resolve));
}

describe('gameserver HTTP — /health', () => {
  it('responds 200 over a real request', async () => {
    const ctx = start({ ticketSecret: { secret: SECRET, isDev: false } });
    await listen(ctx.server);
    try {
      const res = await fetch(`${ctx.httpBase}/health`);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, service: 'daydayup-gameserver' });
    } finally {
      await ctx.close();
    }
  });

  it('a non-upgrade request to any other path gets 426', async () => {
    const ctx = start({ ticketSecret: { secret: SECRET, isDev: false } });
    await listen(ctx.server);
    try {
      const res = await fetch(`${ctx.httpBase}/whatever`);
      expect(res.status).toBe(426);
    } finally {
      await ctx.close();
    }
  });
});

describe('gameserver WS — ticket-mandatory handshake (a real secret configured)', () => {
  it('rejects a connection with no ticket with close code 4401', async () => {
    const ctx = start({ ticketSecret: { secret: SECRET, isDev: false } });
    await listen(ctx.server);
    try {
      const ws = new WebSocket(`${ctx.wsBase}?roomId=r1&owner=0&seed=1&count=1`); // legacy params, ignored
      const code = await new Promise<number>((resolve) => ws.once('close', (c) => resolve(c)));
      expect(code).toBe(4401);
    } finally {
      await ctx.close();
    }
  });

  it('rejects a bogus/forged ticket with close code 4401', async () => {
    const ctx = start({ ticketSecret: { secret: SECRET, isDev: false } });
    await listen(ctx.server);
    try {
      const ws = new WebSocket(`${ctx.wsBase}?ticket=not-a-real-ticket`);
      const code = await new Promise<number>((resolve) => ws.once('close', (c) => resolve(c)));
      expect(code).toBe(4401);
    } finally {
      await ctx.close();
    }
  });

  it('accepts a validly-signed ticket and completes a playerCount:1 room end-to-end (real match_start over the wire)', async () => {
    const ctx = start({ ticketSecret: { secret: SECRET, isDev: false } });
    await listen(ctx.server);
    try {
      const payload: TicketPayload = {
        roomId: 'room-http-1',
        owner: 0,
        seed: 42,
        playerCount: 1,
        teamId: 0,
        exp: Date.now() + 30_000,
      };
      const token = signTicket(payload, SECRET);
      const ws = new WebSocket(`${ctx.wsBase}?ticket=${token}`);
      const firstMsg = await new Promise<Record<string, unknown>>((resolve, reject) => {
        ws.once('message', (data) => resolve(JSON.parse(data.toString('utf8'))));
        ws.once('close', (code) => reject(new Error(`closed early: ${code}`)));
      });
      // A solo playerCount:1 room fills immediately on join — the metronome starts and
      // the very first message over the wire is match_start.
      expect(firstMsg).toMatchObject({ type: 'match_start' });
      ws.close();
    } finally {
      await ctx.close();
    }
  });
});

describe('gameserver WS — dev fallback (no secret configured)', () => {
  it('accepts the legacy raw-param handshake and completes a playerCount:1 room', async () => {
    const ctx = start({ ticketSecret: { secret: 'unused-in-dev', isDev: true } });
    await listen(ctx.server);
    try {
      const ws = new WebSocket(`${ctx.wsBase}?roomId=room-http-dev&owner=0&seed=7&count=1`);
      const firstMsg = await new Promise<Record<string, unknown>>((resolve, reject) => {
        ws.once('message', (data) => resolve(JSON.parse(data.toString('utf8'))));
        ws.once('close', (code) => reject(new Error(`closed early: ${code}`)));
      });
      expect(firstMsg).toMatchObject({ type: 'match_start' });
      ws.close();
    } finally {
      await ctx.close();
    }
  });

  it('rejects a malformed legacy handshake (missing roomId) with close code 4401', async () => {
    const ctx = start({ ticketSecret: { secret: 'unused-in-dev', isDev: true } });
    await listen(ctx.server);
    try {
      const ws = new WebSocket(`${ctx.wsBase}?owner=0&seed=7&count=1`); // no roomId
      const code = await new Promise<number>((resolve) => ws.once('close', (c) => resolve(c)));
      expect(code).toBe(4401);
    } finally {
      await ctx.close();
    }
  });
});

// design/15, decided 2026-09-26: both halves of the ticket handshake refuse to BUILD in
// production without the secret, rather than coming up on the dev one. `config.test.ts`
// pins `ticketSecret()` itself; these pin that the two builders really call it at build time,
// which is what turns the throw into a refusal to start.
describe('production without BB_TICKET_SECRET refuses to start', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('createGameserver throws when no secret is configured or injected', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('BB_TICKET_SECRET', '');
    expect(() => createGameserver()).toThrow(/refusing to start/);
  });

  it('createMatchsvcServer throws when no secret is configured or injected', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('BB_TICKET_SECRET', '');
    // No store: the throw has to come before anything touches one.
    expect(() => createMatchsvcServer({} as Parameters<typeof createMatchsvcServer>[0])).toThrow(/refusing to start/);
  });
});
