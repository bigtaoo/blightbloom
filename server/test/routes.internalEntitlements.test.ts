/**
 * `POST /internal/entitlements/grant` (`routes/internalEntitlements.ts`) — the RECEIVING
 * end of design/19 §4's closed delivery loop, driven with real `fetch` against a real
 * matchsvc on an ephemeral port, over a `:memory:` account DB.
 *
 * Why this layer and not a direct call into `EntitlementService`: everything interesting
 * here IS the HTTP shell. Which status code a refusal carries is not cosmetic — billsvc's
 * pump reads any 4xx as "write this purchase off and shout" and any 5xx as "try again
 * later", so a validation branch that answered 500 would retry forever and one that
 * answered 400 for a transient failure would discard money. The internal-key guard and the
 * body validation only exist at this layer too.
 *
 * The case worth reading first is 'is idempotent across a lost ack'. That single property
 * is what makes at-least-once delivery safe, and therefore what makes the outbox the right
 * shape instead of a two-phase commit.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createMatchsvcServer } from '../src/matchsvc';
import { openDb } from '../src/db';
import { EntitlementService } from '../src/EntitlementService';
import { createInternalVerifier, INTERNAL_KEY_HEADER } from '../src/internalAuth';
import { postGrant, INTERNAL_GRANT_PATH } from '../src/routes/internalEntitlements';
import { GRANT_PATH } from '../src/billsvc/deliveryPump';

const KEY = 'test-internal-key';
/**
 * `matchsvc.ts` builds ONE untyped `deps` bundle for every route group and wires no
 * verifier into it, so unlike `billsvc.http.test.ts` there is no `internalAuth` seam to pin
 * here — the key has to come from where `config.ts` reads it. That is a feature for this
 * file: every case below goes through the real env-derived registry, which is the wiring
 * that actually ships. The one case that cannot be driven through a real server (a failing
 * database) calls the handler directly and pins this registry instead.
 */
const REGISTRY = [{ caller: 'billsvc', key: KEY }];

let server: Server;
let baseUrl: string;
let accountId: string;

beforeEach(async () => {
  vi.stubEnv('BB_INTERNAL_KEY', KEY);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  server = createMatchsvcServer({ dbPath: ':memory:', secret: 'test-secret' });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // A real account, because `entitlements.account_id` is a real foreign key. Registered
  // through the real route so nothing here depends on the accounts schema by hand.
  const registered = await fetch(`${baseUrl}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'buyer', password: 'correct horse battery' }),
  });
  accountId = ((await registered.json()) as { accountId: string }).accountId;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** Reaches into the SAME in-memory DB the server opened — matchsvc's own db is private, so
 *  this asks the server for the account's entitlements through its own read route instead. */
async function ownedSkus(token?: string): Promise<{ sku: string; source: string }[]> {
  const res = await fetch(`${baseUrl}/account/meta`, { headers: { authorization: `Bearer ${token}` } });
  return ((await res.json()) as { entitlements: { sku: string; source: string }[] }).entitlements;
}

async function grant(
  body: unknown,
  over: { key?: string | null } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const key = over.key === undefined ? KEY : over.key;
  if (key !== null) headers[INTERNAL_KEY_HEADER] = key;
  const res = await fetch(`${baseUrl}${INTERNAL_GRANT_PATH}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

function validBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    deliveryId: 'purchase:dev:T1',
    accountId,
    sku: 'bp.cannon',
    orderId: 'o1',
    grants: [{ kind: 'blueprint', id: 'cannon' }],
    ts: 1,
    ...over,
  };
}

/**
 * Drives `postGrant` directly over a database this file owns, with the internal-key check
 * satisfied by `REGISTRY`. Two cases need it: one asserts a COLUMN matchsvc's private
 * connection does not expose, and one needs a database that refuses the write — a branch no
 * real server can be made to take from outside. Synchronous because `readJson`'s events are
 * driven by hand here, which is also what makes the assertions immediate.
 */
function callGrant(
  db: Pick<ReturnType<typeof openDb>, 'prepare' | 'exec'>,
  body: unknown,
): { status: number; body: Record<string, unknown> } {
  const handlers: Record<string, ((c?: Buffer) => void)[]> = {};
  const req = {
    headers: { [INTERNAL_KEY_HEADER]: KEY },
    on(event: string, handler: (c?: Buffer) => void) {
      (handlers[event] ??= []).push(handler);
    },
  } as unknown as Parameters<typeof postGrant>[0];

  let status = 0;
  let payload = '';
  const res = {
    writeHead(code: number) {
      status = code;
    },
    end(chunk: string) {
      payload = chunk;
    },
  } as unknown as Parameters<typeof postGrant>[1];

  postGrant(req, res, new URL(`http://x${INTERNAL_GRANT_PATH}`), {
    db: db as ReturnType<typeof openDb>,
    internalAuth: createInternalVerifier(REGISTRY),
  });
  handlers.data?.forEach((h) => h(Buffer.from(JSON.stringify(body))));
  handlers.end?.forEach((h) => h());
  return { status, body: (payload ? JSON.parse(payload) : {}) as Record<string, unknown> };
}

describe('POST /internal/entitlements/grant', () => {
  it('agrees with the pump about where it lives', () => {
    // Two files name this path — the dispatch chain and the caller — and a rename that
    // touched one would produce a 404 the pump would read as a TERMINAL refusal and write a
    // paid purchase off with. Cheap to pin; expensive to discover in production.
    expect(INTERNAL_GRANT_PATH).toBe(GRANT_PATH);
  });

  it('writes the entitlement with source=purchase and the billsvc order id', async () => {
    const res = await grant(validBody());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, granted: ['blueprint:cannon'], alreadyOwned: [] });

    const login = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'buyer', password: 'correct horse battery' }),
    });
    const { token } = (await login.json()) as { token: string };
    // Through the route a logged-in client actually reads, so this is the whole loop's
    // visible end: a purchase settled in billsvc turns up in `GET /account/meta`.
    expect(await ownedSkus(token)).toEqual([
      expect.objectContaining({ sku: 'blueprint:cannon', source: 'purchase' }),
    ]);
  });

  it('is idempotent across a lost ack — a redelivery grants nothing twice and still answers 200', async () => {
    // THE property the whole outbox design rests on. The pump cannot tell "the control plane
    // never saw it" from "the control plane answered and the answer was lost", so it retries;
    // `entitlements`' UNIQUE(account_id, sku) is what makes that safe, and this is where that
    // guarantee is actually observed rather than asserted in a comment.
    const first = await grant(validBody());
    const second = await grant(validBody());
    const third = await grant(validBody({ deliveryId: 'purchase:dev:T1', orderId: 'a-different-order' }));

    expect(first.body).toMatchObject({ granted: ['blueprint:cannon'], alreadyOwned: [] });
    // 200 both times: the pump must be able to mark its row delivered off the SECOND answer,
    // and the two arrays are what let an operator tell the cases apart in the log.
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ granted: [], alreadyOwned: ['blueprint:cannon'] });
    expect(third.status).toBe(200);
  });

  it('does not let a redelivery rewrite the order the first grant recorded', () => {
    // `EntitlementService.grant`'s own rule, from the route's side: the FIRST grant's
    // `order_id` is the audit record of the payment, and a retry that overwrote it would
    // break design/19 §7's reconciliation against the platform. Driven against the handler
    // over an owned database, because the property is a COLUMN and `matchsvc.ts` keeps its
    // connection private (`/account/meta` deliberately does not expose `orderId`).
    const own = openDb(':memory:');
    own.prepare("INSERT INTO accounts (id, username, password_hash, created_at) VALUES ('acc', 'u', 'h', 1)").run();
    const rows = new EntitlementService(own);

    expect(callGrant(own, { ...validBody({ accountId: 'acc' }), orderId: 'the-real-order' }).status).toBe(200);
    const second = callGrant(own, { ...validBody({ accountId: 'acc' }), orderId: 'a-later-mistake' });

    expect(second).toMatchObject({ status: 200, body: { granted: [], alreadyOwned: ['blueprint:cannon'] } });
    expect(rows.list('acc')).toEqual([
      expect.objectContaining({ sku: 'blueprint:cannon', source: 'purchase', orderId: 'the-real-order' }),
    ]);
    own.close();
  });

  it('grants every pair of a multi-grant SKU', async () => {
    const res = await grant(
      validBody({
        grants: [
          { kind: 'blueprint', id: 'cannon' },
          { kind: 'character', id: 'ranger' },
        ],
      }),
    );
    expect(res.body).toMatchObject({ granted: ['blueprint:cannon', 'character:ranger'] });
  });

  // ── the guard ─────────────────────────────────────────────────────────────────────────

  it('is behind the internal key, and says nothing about why', async () => {
    expect((await grant(validBody(), { key: null })).status).toBe(401);
    expect((await grant(validBody(), { key: 'not-the-key' })).status).toBe(401);
    // A player's own session token is not a credential here — a different namespace, with no
    // code path that would even look at `authorization` (`internalAuth.ts`).
    const res = await fetch(`${baseUrl}${INTERNAL_GRANT_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer whatever' },
      body: JSON.stringify(validBody()),
    });
    expect(res.status).toBe(401);
  });

  it('refuses before reading the body, so an unauthorized call cannot write anything', async () => {
    await grant(validBody(), { key: 'not-the-key' });
    const login = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'buyer', password: 'correct horse battery' }),
    });
    const { token } = (await login.json()) as { token: string };
    expect(await ownedSkus(token)).toEqual([]);
  });

  // ── the refusals, and their status codes ──────────────────────────────────────────────

  it('refuses a missing accountId or orderId with 400 — both are CHECK-mandated', async () => {
    expect((await grant(validBody({ accountId: undefined }))).status).toBe(400);
    expect((await grant(validBody({ orderId: undefined }))).status).toBe(400);
    // Whitespace is not an order id. `db.ts`'s CHECK only sees NULL, so an all-spaces string
    // would satisfy the constraint and be unauditable anyway.
    expect((await grant(validBody({ orderId: '   ' }))).status).toBe(400);
    expect((await grant(validBody({ accountId: 42 }))).status).toBe(400);
  });

  it('refuses an EMPTY grant list rather than reporting a successful delivery of nothing', async () => {
    // A 200 here would let the pump mark the row delivered and erase the only evidence that
    // a player paid for something and got nothing.
    const res = await grant(validBody({ grants: [] }));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/non-empty array/);
  });

  it('refuses a grant list that is not a list', async () => {
    expect((await grant(validBody({ grants: undefined }))).status).toBe(400);
    expect((await grant(validBody({ grants: { kind: 'blueprint', id: 'cannon' } }))).status).toBe(400);
  });

  it('refuses an unknown grant kind rather than skipping it', async () => {
    // Skipping would deliver a PARTIAL purchase and report success — the shape that loses
    // half of a two-item SKU silently the day one exists.
    const res = await grant(validBody({ grants: [{ kind: 'wallet', id: '500' }] }));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/blueprint\|character/);
  });

  it('refuses a grant with no id, a non-string id, or nothing at all where an object should be', async () => {
    expect((await grant(validBody({ grants: [{ kind: 'blueprint' }] }))).status).toBe(400);
    expect((await grant(validBody({ grants: [{ kind: 'blueprint', id: '' }] }))).status).toBe(400);
    expect((await grant(validBody({ grants: [{ kind: 'blueprint', id: 7 }] }))).status).toBe(400);
    expect((await grant(validBody({ grants: [null] }))).status).toBe(400);
    expect((await grant(validBody({ grants: ['blueprint:cannon'] }))).status).toBe(400);
  });

  it('refuses the whole call when only ONE of several grants is bad', async () => {
    const res = await grant(
      validBody({ grants: [{ kind: 'blueprint', id: 'cannon' }, { kind: 'nonsense', id: 'x' }] }),
    );
    expect(res.status).toBe(400);
    // Nothing was written: the refusal happens before the transaction opens, so the account
    // does not end up owning half of a purchase that was rejected.
    const login = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'buyer', password: 'correct horse battery' }),
    });
    const { token } = (await login.json()) as { token: string };
    expect(await ownedSkus(token)).toEqual([]);
  });

  it('answers 404 for an account that does not exist — CHECKED, not caught', async () => {
    // The foreign key would throw, and telling "no such account" (permanent) apart from "the
    // write failed" (transient) by parsing a driver's error string is what the rest of this
    // plane refuses to do. 404 is a 4xx, so the pump stops and shouts rather than retrying a
    // grant that can never land.
    const res = await grant(validBody({ accountId: 'no-such-account' }));
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/no account 'no-such-account'/);
  });

  it('answers 5xx (not 4xx) when the write itself fails, so the purchase is retried', () => {
    // The one branch a real matchsvc cannot be made to take from outside, and the DIRECTION
    // of it is the whole point: a 400 here would let the pump write a recoverable failure
    // off as a lost purchase, which is the exact outcome the outbox exists to prevent.
    const failing = {
      prepare: (sql: string) => {
        if (sql.startsWith('SELECT 1 AS one FROM accounts')) return { get: () => ({ one: 1 }) };
        return {
          run: () => {
            throw new Error('database is locked');
          },
        };
      },
      exec: () => {},
    } as unknown as ReturnType<typeof openDb>;

    expect(callGrant(failing, validBody()).status).toBe(500);
    expect(vi.mocked(console.error).mock.calls[0]![0]).toMatch(/database is locked/);
  });

  it('survives a body that is literally `null`', async () => {
    // `readJson` answers `{}` for a body it cannot parse — but `null` PARSES, so the handler
    // receives it verbatim. Without the guard the first property read throws inside an
    // `end` handler, which is an uncaughtException with no response ever sent.
    const res = await fetch(`${baseUrl}${INTERNAL_GRANT_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [INTERNAL_KEY_HEADER]: KEY },
      body: 'null',
    });
    expect(res.status).toBe(400);
  });

  it('logs `(none)` for a delivery that named no id, rather than `undefined`', async () => {
    // `deliveryId` is advisory (the receiver keys idempotency on its own UNIQUE), so a body
    // without one still delivers — and the audit line has to say so in a way an operator can
    // grep for.
    await grant(validBody({ deliveryId: undefined }));
    const logged = vi.mocked(console.log).mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toMatch(/delivery '\(none\)' for account/);
  });

  it('logs the delivery it accepted, naming the account and the order', async () => {
    // design/19 §7: log every event, not just the failures. This is the line an operator
    // greps when a player says a purchase never arrived.
    await grant(validBody());
    const logged = vi.mocked(console.log).mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toMatch(/delivery 'purchase:dev:T1' for account '.*' order 'o1'/);
    expect(logged).toMatch(/granted \[blueprint:cannon\]/);
  });
});
