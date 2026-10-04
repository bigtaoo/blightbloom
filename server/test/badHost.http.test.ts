/**
 * A request whose `Host` header cannot be parsed, sent to each of the four services.
 *
 * Every service builds its routing URL from the client's own Host header, and `new URL`
 * throws on one it cannot parse. Until 2026-10-04 that throw was a 500 and an ERROR line on
 * matchsvc and an UNCAUGHT EXCEPTION on the other three — billsvc and adminsvc parse it
 * outside any error boundary, and the gameserver inside the socket's `connection` event —
 * which with no process-wide handler ends the process. `src/requestUrl.ts` has the account,
 * including why production's proxy kept it out of reach from outside.
 *
 * The property pinned here is the same for all four: a 400, nothing logged at ERROR (the
 * client sent a bad request; nothing on the server failed), and the process still serving.
 * Sent over a raw socket, because `fetch` will not put an invalid Host on the wire.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { connect, type AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createMatchsvcServer } from '../src/matchsvc';
import { createBillsvcServer } from '../src/billsvc/server';
import { ALLOW_WRITABLE_VAR, createAdminsvcServer } from '../src/adminsvc/server';
import { createGameserver } from '../src/index';
import { freshAccounts, openTestMongo, type MongoTestContext } from './mongoHarness';

/** Hosts `new URL` rejects: a space, an unclosed IPv6 bracket, a port past 65535. */
const BAD_HOSTS = ['a b', '[', 'x:99999'];

const CLOSE = 'Connection: close\r\n';
const WS_UPGRADE =
  'Connection: Upgrade\r\nUpgrade: websocket\r\n' +
  'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n';

/**
 * Sends one GET with the given Host and returns its status line. A listener that threw never
 * answers, so the read gives up after a second and says so rather than hanging the case.
 */
function statusLine(server: Server, path: string, host: string, headers: string): Promise<string> {
  const { port } = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    let raw = '';
    const socket = connect(port, '127.0.0.1', () => socket.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\n${headers}\r\n`));
    const timer = setTimeout(() => {
      socket.destroy();
      resolve('(no response)');
    }, 1000);
    socket.on('data', (chunk) => {
      raw += chunk;
      // The status line is all a case reads, and an upgraded socket never closes by itself.
      if (raw.includes('\r\n')) {
        clearTimeout(timer);
        socket.destroy();
        resolve(raw.split('\r\n')[0]!);
      }
    });
    socket.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

const servers: Server[] = [];
let ctx: MongoTestContext;

async function listen(server: Server): Promise<Server> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

/** The shared assertion: 400 for every bad host, the control host still served, no ERROR. */
async function expectBadHostRefused(server: Server, path: string, ok: string, headers = CLOSE): Promise<void> {
  for (const host of BAD_HOSTS) {
    expect(await statusLine(server, path, host, headers), `Host: ${host}`).toBe('HTTP/1.1 400 Bad Request');
  }
  // Control, and the proof the process is still here: the same request with a sane host.
  expect(await statusLine(server, path, 'localhost', headers)).toBe(ok);
  expect(vi.mocked(console.error)).not.toHaveBeenCalled();
}

beforeEach(async () => {
  ctx = await openTestMongo();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(async () => {
  while (servers.length) {
    const server = servers.pop()!;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await ctx.dispose();
  vi.restoreAllMocks();
});

describe('a Host header that does not parse', () => {
  it('matchsvc answers 400', async () => {
    const server = await listen(createMatchsvcServer({ store: await freshAccounts(), secret: 's' }));
    await expectBadHostRefused(server, '/health', 'HTTP/1.1 200 OK');
  });

  it('billsvc answers 400', async () => {
    const { server } = createBillsvcServer({ db: ctx.db('billing'), env: { BB_BILLING_DEV_STUB: '1' } });
    await expectBadHostRefused(await listen(server), '/health', 'HTTP/1.1 200 OK');
  });

  it('adminsvc answers 400', async () => {
    const { server } = await createAdminsvcServer({
      env: { BB_ADMIN_PASSWORD: 'p'.repeat(32), NODE_ENV: 'test', [ALLOW_WRITABLE_VAR]: '1' },
      dbs: { analyticsEnabled: false, open: (name) => ctx.db(name) },
    });
    await expectBadHostRefused(await listen(server), '/admin/health', 'HTTP/1.1 200 OK');
  });

  it('the gameserver refuses the WebSocket handshake with 400', async () => {
    const { server, wss, manager } = createGameserver({ ticketSecret: { secret: 's', isDev: false } });
    try {
      // Refused at the handshake, rather than upgraded and then closed: there is no ticket to
      // read from a URL that cannot be built.
      await expectBadHostRefused(await listen(server), '/ws', 'HTTP/1.1 101 Switching Protocols', WS_UPGRADE);
    } finally {
      manager.destroyAll();
      wss.close();
    }
  });
});
