/**
 * `POST /auth/portal` over the real HTTP layer (design/20 "account integration") — the route
 * a CrazyGames player is silently logged in through, and the one route in this server that
 * accepts an identity claim signed by somebody else.
 *
 * Driven through `fetch` against an ephemeral port rather than by calling the handler,
 * following `matchsvc.http.test.ts`'s own reason for existing: the interesting failures of a
 * route are in its transport contract (status codes, CORS, what a browser can actually send)
 * and none of them are visible from a direct call. The session this route mints is then USED
 * — against `/auth/me` and `/account/meta` — because "a token came back" is not the claim;
 * "the token works everywhere our own tokens work" is.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { createMatchsvcServer } from '../src/matchsvc';
import type { PortalKeyStore } from '../src/portalKeys';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = publicKey.export({ type: 'pkcs1', format: 'pem' }).toString();

const b64url = (o: unknown): string => Buffer.from(JSON.stringify(o), 'utf8').toString('base64url');

const NOW_MS = 1_800_000_000_000;

function portalToken(over: Record<string, unknown> = {}): string {
  const body = `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url({
    userId: 'cg-user-1',
    gameId: 'the-game',
    username: 'PortalPlayer',
    exp: Math.floor(NOW_MS / 1000) + 3600,
    ...over,
  })}`;
  return `${body}.${createSign('sha256').update(body).sign(privateKey).toString('base64url')}`;
}

/** A key store with no network in it. `keyAvailable` is flipped by one case below to reach
 *  the "we cannot verify, so we refuse" arm, which is a 503 and deliberately not a 401. */
let keyAvailable = true;
const keys: PortalKeyStore = { key: async () => (keyAvailable ? PEM : null) };

let baseUrl: string;
let close: () => Promise<void>;

beforeAll(async () => {
  const server = createMatchsvcServer({
    dbPath: ':memory:',
    secret: 'test-secret',
    portal: { keys, gameId: 'the-game', nowMs: () => NOW_MS },
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
  close = () => new Promise<void>((resolve) => server.close(() => resolve()));
});

afterAll(async () => {
  keyAvailable = true;
  await close();
});

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}

describe('POST /auth/portal — the happy path', () => {
  it('mints one of OUR sessions from a verified portal token', async () => {
    const { status, json } = await post('/auth/portal', { token: portalToken() });
    expect(status).toBe(200);
    expect(json).toMatchObject({ username: 'PortalPlayer' });
    expect(typeof json?.accountId).toBe('string');
    expect(typeof json?.token).toBe('string');
    // The two tokens are never interchangeable, and this is the one place both exist.
    expect(json?.token).not.toBe(portalToken());
  });

  it('returns the SAME account on a second call — a returning player, not a new one', async () => {
    const first = await post('/auth/portal', { token: portalToken() });
    const second = await post('/auth/portal', { token: portalToken() });
    expect(second.json?.accountId).toBe(first.json?.accountId);
  });

  it('mints a session every other bearer route accepts', async () => {
    const { json } = await post('/auth/portal', { token: portalToken({ userId: 'cg-user-2' }) });
    const auth = { authorization: `Bearer ${json?.token as string}` };

    const me = await fetch(`${baseUrl}/auth/me`, { headers: auth });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ accountId: json?.accountId, username: 'PortalPlayer' });

    // And the Forge blob round-trips under it, which is the thing a portal player's
    // progress actually rides on (`meta/accountSync.ts`).
    const saved = await post('/account/meta', { data: { version: 1, materialBank: { scrap: 3 } } }, auth);
    expect(saved.status).toBe(200);
    const read = await fetch(`${baseUrl}/account/meta`, { headers: auth });
    expect(((await read.json()) as { data: { materialBank: unknown } }).data.materialBank).toEqual({ scrap: 3 });
  });

  it('is reachable from a browser — the preflight allows content-type', async () => {
    const res = await fetch(`${baseUrl}/auth/portal`, {
      method: 'OPTIONS',
      headers: { origin: 'https://games.crazygames.com', 'access-control-request-headers': 'content-type' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-headers')).toContain('content-type');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });
});

describe('POST /auth/portal — refusals', () => {
  it('401s a token signed by the wrong key', async () => {
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const body = `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url({
      userId: 'x',
      gameId: 'the-game',
      username: 'X',
      exp: Math.floor(NOW_MS / 1000) + 60,
    })}`;
    const forged = `${body}.${createSign('sha256').update(body).sign(other.privateKey).toString('base64url')}`;
    expect((await post('/auth/portal', { token: forged })).status).toBe(401);
  });

  it('401s a token minted for another game', async () => {
    expect((await post('/auth/portal', { token: portalToken({ gameId: 'somebody-else' }) })).status).toBe(401);
  });

  it('401s a missing, empty or non-string token', async () => {
    for (const body of [{}, { token: '' }, { token: 42 }, { token: null }]) {
      expect((await post('/auth/portal', body)).status).toBe(401);
    }
  });

  it('401s a malformed body rather than crashing the process', async () => {
    const res = await fetch(`${baseUrl}/auth/portal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json at all',
    });
    expect(res.status).toBe(401);
  });

  it('503s — NOT 401 — when the verification key is unavailable', async () => {
    // The distinction is load-bearing for the client: a 401 means "this player's token is
    // bad" and a 503 means "we could not check", and only the second one should leave the
    // player quietly playing as a guest while the SDK still thinks they are logged in.
    keyAvailable = false;
    try {
      const { status, json } = await post('/auth/portal', { token: portalToken() });
      expect(status).toBe(503);
      expect(String(json?.error)).toContain('key');
    } finally {
      keyAvailable = true;
    }
  });

  it('does not create an account for any refused token', async () => {
    // Four refusals above could each have half-registered a row. Proof they did not: a
    // fresh userId that has only ever been refused still logs in as a NEW account when it
    // finally presents a valid token.
    await post('/auth/portal', { token: portalToken({ userId: 'cg-user-9', gameId: 'wrong' }) });
    const ok = await post('/auth/portal', { token: portalToken({ userId: 'cg-user-9' }) });
    const again = await post('/auth/portal', { token: portalToken({ userId: 'cg-user-9' }) });
    expect(ok.json?.accountId).toBe(again.json?.accountId);
  });
});

describe('POST /auth/portal — the real clock', () => {
  it('works with no injected clock, which is how the deployment runs', async () => {
    // Every case above pins the clock so a fixed `exp` stays valid. The shipped wiring
    // injects none, and a default nothing exercises is a default nobody has checked.
    const server = createMatchsvcServer({ dbPath: ':memory:', secret: 'test-secret', portal: { keys, gameId: 'the-game' } });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const body = `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url({
        userId: 'cg-clock',
        gameId: 'the-game',
        username: 'Clock',
        exp: Math.floor(Date.now() / 1000) + 600,
      })}`;
      const token = `${body}.${createSign('sha256').update(body).sign(privateKey).toString('base64url')}`;
      const res = await fetch(`http://127.0.0.1:${port}/auth/portal`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ username: 'Clock' });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('POST /auth/portal — a server built without portal support', () => {
  it('503s rather than pretending to verify', async () => {
    // `createMatchsvcServer` always supplies a portal dep (defaulting to the real HTTPS key
    // store), so this arm is only reachable by calling the handler with the dependency
    // genuinely absent — which is what an embedder with no portal build would produce.
    const { postPortalLogin } = await import('../src/routes/auth');
    const res = {
      writeHead: (status: number) => {
        captured.status = status;
        return res;
      },
      end: (body: string) => {
        captured.body = body;
      },
    } as unknown as import('node:http').ServerResponse;
    const captured: { status?: number; body?: string } = {};
    const req = Object.assign(new (await import('node:stream')).Readable({ read() { this.push(null); } }), {
      headers: {},
      method: 'POST',
    }) as unknown as import('node:http').IncomingMessage;

    postPortalLogin(req, res, new URL('http://x/auth/portal'), { auth: {} as never });
    await new Promise((r) => setTimeout(r, 0));
    expect(captured.status).toBe(503);
    expect(captured.body).toContain('not configured');
  });
});
