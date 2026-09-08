/**
 * matchsvc HTTP integration tests (design/16-accounts.md) — the ONE place in this repo
 * that drives the real `node:http` layer with real `fetch`, bound to an ephemeral port
 * over `:memory:` SQLite. Every other matchsvc-adjacent test (Matchmaker/PartyService/
 * rating/ticket/AuthService) deliberately tests pure logic only, per index.ts's own
 * "intentionally untested directly" convention for the thin HTTP shells — but that
 * convention is exactly what let design/16-accounts.md's missing-`authorization`-header
 * CORS bug slip past every other test AND a plain curl check (neither enforces browser
 * CORS preflight rules). This file exists specifically to close that class of gap: real
 * requests, real headers, a real CORS preflight assertion.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createMatchsvcServer } from '../src/matchsvc';
import { INTERNAL_KEY_HEADER } from '../src/internalAuth';
import { signTicket, verifyTicket, type TicketPayload } from '../src/ticket';

let baseUrl: string;
let close: () => Promise<void>;

/**
 * `POST /rating/report` is an INTERNAL route since ROADMAP 8.1 (design/19's D1) — the
 * gameserver is the only legitimate caller, and it presents `config.ts`'s key. With
 * `BB_INTERNAL_KEY` unset (as under test) that is the published dev fallback, spelled out
 * here rather than imported so this file states the credential it is using. The refusal
 * cases for this header live in `internalTrustSeam.test.ts`; what these cases still own is
 * the route's own request/response contract, which the key does not change.
 */
const INTERNAL: Record<string, string> = {
  [INTERNAL_KEY_HEADER]: 'dev-insecure-internal-key-do-not-use-in-prod',
};

beforeAll(async () => {
  const server = createMatchsvcServer({ dbPath: ':memory:', secret: 'test-secret' });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
  close = () => new Promise<void>((resolve) => server.close(() => resolve()));
});

afterAll(async () => {
  await close();
});

async function register(username: string, password: string) {
  const res = await fetch(`${baseUrl}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('matchsvc HTTP — /health', () => {
  it('responds 200', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });
});

describe('matchsvc HTTP — /auth/register', () => {
  it('registers a new account over the real wire', async () => {
    const { status, body } = await register('httpuser1', 'hunter22');
    expect(status).toBe(200);
    expect(body).toMatchObject({ username: 'httpuser1' });
    expect(typeof body.accountId).toBe('string');
    expect(typeof body.token).toBe('string');
  });

  it('rejects a duplicate username with 400', async () => {
    await register('httpdupe', 'hunter22');
    const { status, body } = await register('httpdupe', 'differentpw');
    expect(status).toBe(400);
    expect(body.error).toMatch(/taken/);
  });

  it('rejects a blacklisted username with 400 (design/16-accounts.md local filter)', async () => {
    const { status, body } = await register('admin', 'hunter22');
    expect(status).toBe(400);
    expect(body.error).toBe('username not allowed');
  });
});

describe('matchsvc HTTP — /auth/login', () => {
  it('logs in with the correct password', async () => {
    await register('httplogin1', 'hunter22');
    const res = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'httplogin1', password: 'hunter22' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string };
    expect(typeof body.token).toBe('string');
  });

  it('rejects the wrong password with 401', async () => {
    await register('httplogin2', 'hunter22');
    const res = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'httplogin2', password: 'wrongpass' }),
    });
    expect(res.status).toBe(401);
  });
});

describe('matchsvc HTTP — /auth/me', () => {
  it('resolves a live bearer token to the account', async () => {
    const { body } = await register('httpme1', 'hunter22');
    const res = await fetch(`${baseUrl}/auth/me`, { headers: { authorization: `Bearer ${body.token as string}` } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ username: 'httpme1' });
  });

  it('rejects a bogus token with 401', async () => {
    const res = await fetch(`${baseUrl}/auth/me`, { headers: { authorization: 'Bearer bogus-token' } });
    expect(res.status).toBe(401);
  });

  it('rejects a missing Authorization header with 401', async () => {
    const res = await fetch(`${baseUrl}/auth/me`);
    expect(res.status).toBe(401);
  });
});

describe('matchsvc HTTP — /auth/logout', () => {
  it('invalidates the session so /auth/me subsequently rejects it', async () => {
    const { body } = await register('httplogout1', 'hunter22');
    const token = body.token as string;
    const logoutRes = await fetch(`${baseUrl}/auth/logout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    expect(logoutRes.status).toBe(200);
    const meRes = await fetch(`${baseUrl}/auth/me`, { headers: { authorization: `Bearer ${token}` } });
    expect(meRes.status).toBe(401);
  });
});

describe('matchsvc HTTP — /auth/change-password', () => {
  it('changes the password; old password then fails login, new one succeeds', async () => {
    const { body } = await register('httppw1', 'hunter22');
    const token = body.token as string;
    const changeRes = await fetch(`${baseUrl}/auth/change-password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, oldPassword: 'hunter22', newPassword: 'newpassword1' }),
    });
    expect(changeRes.status).toBe(200);

    const oldLogin = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'httppw1', password: 'hunter22' }),
    });
    expect(oldLogin.status).toBe(401);

    const newLogin = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'httppw1', password: 'newpassword1' }),
    });
    expect(newLogin.status).toBe(200);
  });

  it('rejects the wrong current password with 400', async () => {
    const { body } = await register('httppw2', 'hunter22');
    const res = await fetch(`${baseUrl}/auth/change-password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: body.token, oldPassword: 'wrongpass', newPassword: 'newpassword1' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('matchsvc HTTP — /account/meta', () => {
  it('round-trips the client-authored half of MetaState through a real logged-in session', async () => {
    const { body } = await register('httpmeta1', 'hunter22');
    const token = body.token as string;
    // Materials/loadout/selection are what the client legitimately authors — they survive
    // the round trip verbatim. Ownership does NOT: see the next test.
    const data = { materialBank: { mat_fire: 3 }, loadout: ['repeater'], selectedSkin: 'juggernaut' };

    const postRes = await fetch(`${baseUrl}/account/meta`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ data }),
    });
    expect(postRes.status).toBe(200);

    const getRes = await fetch(`${baseUrl}/account/meta`, { headers: { authorization: `Bearer ${token}` } });
    expect(getRes.status).toBe(200);
    // Ownership always comes back, from the entitlements table rather than the blob —
    // empty arrays for an account that has been granted nothing.
    expect(await getRes.json()).toEqual({
      data: { ...data, unlockedBlueprints: [], ownedCharacters: [] },
      entitlements: [],
    });
  });

  it('ROADMAP 8.2: ownership a client POSTs itself is ignored, not rejected — the write still 200s and the read shows none of it', async () => {
    // The free-money hole design/19 §2 closes, through the real HTTP surface: a `curl` with
    // nothing but a valid session used to be able to hand itself every paid character, which
    // is the one meta axis that reaches PvP (design/14).
    const { body } = await register('httpmeta3', 'hunter22');
    const token = body.token as string;
    const postRes = await fetch(`${baseUrl}/account/meta`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        data: { unlockedBlueprints: ['cannon', 'emberblade'], ownedCharacters: ['paid-hero'], materialBank: { mat_ice: 1 } },
      }),
    });
    expect(postRes.status).toBe(200); // IGNORED, not rejected — no pre-existing client path breaks

    const getRes = await fetch(`${baseUrl}/account/meta`, { headers: { authorization: `Bearer ${token}` } });
    expect(await getRes.json()).toEqual({
      data: { materialBank: { mat_ice: 1 }, unlockedBlueprints: [], ownedCharacters: [] },
      entitlements: [],
    });
  });

  it('a brand-new account with no saved meta gets { data: null } and no entitlements', async () => {
    const { body } = await register('httpmeta2', 'hunter22');
    const res = await fetch(`${baseUrl}/account/meta`, { headers: { authorization: `Bearer ${body.token as string}` } });
    expect(await res.json()).toEqual({ data: null, entitlements: [] });
  });

  it('rejects GET without a session with 401', async () => {
    const res = await fetch(`${baseUrl}/account/meta`);
    expect(res.status).toBe(401);
  });

  it('rejects POST without a session with 401', async () => {
    const res = await fetch(`${baseUrl}/account/meta`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: { x: 1 } }),
    });
    expect(res.status).toBe(401);
  });
});

describe('matchsvc HTTP — /rating/report and /rating/:accountId', () => {
  it('GET on an unknown account returns the DEFAULT_RATING', async () => {
    const res = await fetch(`${baseUrl}/rating/never-seen-before`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accountId: 'never-seen-before', rating: 1000 });
  });

  it('POST applies a match and returns before/after for every account, without teamIds', async () => {
    const res = await fetch(`${baseUrl}/rating/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...INTERNAL },
      body: JSON.stringify({ accountIds: ['http-r-alice', 'http-r-bob'], places: [1, 2] }),
    });
    expect(res.status).toBe(200);
    const { changes } = (await res.json()) as { changes: { accountId: string; before: number; after: number }[] };
    expect(changes).toHaveLength(2);
    const alice = changes.find((c) => c.accountId === 'http-r-alice')!;
    expect(alice.after).toBeGreaterThan(alice.before); // 1st place gained

    const getRes = await fetch(`${baseUrl}/rating/http-r-alice`);
    const getBody = (await getRes.json()) as { rating: number };
    expect(getBody.rating).toBe(alice.after); // persisted over the real wire
  });

  it('rejects mismatched-length accountIds/places with 400', async () => {
    const res = await fetch(`${baseUrl}/rating/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...INTERNAL },
      body: JSON.stringify({ accountIds: ['http-r-x', 'http-r-y'], places: [1] }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects a teamIds array whose length disagrees with accountIds with 400', async () => {
    const res = await fetch(`${baseUrl}/rating/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...INTERNAL },
      body: JSON.stringify({ accountIds: ['http-r-x', 'http-r-y'], places: [1, 2], teamIds: [0] }),
    });
    expect(res.status).toBe(400);
  });

  it('a squad-aware POST (teamIds present) applies the identical delta to every teammate over the real wire', async () => {
    const res = await fetch(`${baseUrl}/rating/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...INTERNAL },
      body: JSON.stringify({
        accountIds: ['http-sq-a', 'http-sq-b', 'http-sq-c', 'http-sq-d'],
        places: [1, 2, 3, 4],
        teamIds: [0, 0, 1, 1],
      }),
    });
    expect(res.status).toBe(200);
    const { changes } = (await res.json()) as { changes: { accountId: string; before: number; after: number }[] };
    const delta = (id: string) => {
      const c = changes.find((x) => x.accountId === id)!;
      return c.after - c.before;
    };
    expect(delta('http-sq-a')).toBe(delta('http-sq-b')); // same squad, same delta
    expect(delta('http-sq-c')).toBe(delta('http-sq-d'));
    expect(delta('http-sq-a')).toBeGreaterThan(delta('http-sq-c')); // winning squad > losing squad
  });
});

describe('matchsvc HTTP — /resume (ROADMAP reconnect, design/06)', () => {
  const SECRET = 'test-secret'; // matches createMatchsvcServer({ secret: 'test-secret' }) above
  const EXPIRED: TicketPayload = { roomId: 'room-http', owner: 1, seed: 7, playerCount: 2, teamId: 1, exp: 1 }; // long expired

  it('reissues a fresh ticket for an expired-but-validly-signed original', async () => {
    const staleToken = signTicket(EXPIRED, SECRET);
    const res = await fetch(`${baseUrl}/resume`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: staleToken }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { match: { roomId: string; owner: number; seed: number; playerCount: number; teamId: number; token: string; wsUrl: string } };
    expect(body.match).toMatchObject({ roomId: 'room-http', owner: 1, seed: 7, playerCount: 2, teamId: 1 });
    expect(typeof body.match.wsUrl).toBe('string');

    // The reissued token itself verifies (fresh exp, no ignoreExpiry needed) and names
    // the SAME seat grant — this is the ticket the client redeems on the gameserver.
    const reverified = verifyTicket(body.match.token, SECRET, Date.now());
    expect(reverified).toMatchObject({ roomId: 'room-http', owner: 1, seed: 7, playerCount: 2, teamId: 1 });
    expect(reverified!.exp).toBeGreaterThan(Date.now());
    expect(body.match.token).not.toBe(staleToken); // a genuinely fresh signature, not an echo
  });

  it('rejects a bogus/forged token with 401', async () => {
    const res = await fetch(`${baseUrl}/resume`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'not-a-real-ticket' }),
    });
    expect(res.status).toBe(401);
  });

  it('rejects a tampered body (owner escalation) with 401 even though the ticket is otherwise well-formed', async () => {
    const token = signTicket(EXPIRED, SECRET);
    const sig = token.split('.')[1];
    const forgedBody = Buffer.from(JSON.stringify({ ...EXPIRED, owner: 0 }), 'utf8').toString('base64url');
    const res = await fetch(`${baseUrl}/resume`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: `${forgedBody}.${sig}` }),
    });
    expect(res.status).toBe(401);
  });

  it('rejects a missing token with 400', async () => {
    const res = await fetch(`${baseUrl}/resume`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

describe('matchsvc HTTP — CORS (regression: design/16-accounts.md missing-authorization-header bug)', () => {
  it('a preflight for /account/meta allows the authorization header — the exact bug a real browser caught that no other test could', async () => {
    const res = await fetch(`${baseUrl}/account/meta`, {
      method: 'OPTIONS',
      headers: {
        origin: 'http://localhost:5173',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,content-type',
      },
    });
    expect(res.status).toBe(204);
    const allowHeaders = res.headers.get('access-control-allow-headers') ?? '';
    expect(allowHeaders.toLowerCase()).toContain('authorization');
    expect(allowHeaders.toLowerCase()).toContain('content-type');
  });

  it('a preflight for /auth/me (a bearer-only GET route) also allows authorization', async () => {
    const res = await fetch(`${baseUrl}/auth/me`, {
      method: 'OPTIONS',
      headers: {
        origin: 'http://localhost:5173',
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization',
      },
    });
    expect(res.status).toBe(204);
    expect((res.headers.get('access-control-allow-headers') ?? '').toLowerCase()).toContain('authorization');
  });

  it('every response carries access-control-allow-origin: * (unauthenticated routes stay unaffected)', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });
});
