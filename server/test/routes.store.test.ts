/**
 * `server/src/routes/store.ts` at the unit layer — the store proxy's refusals, its failure
 * mapping and its ownership narrowing (ROADMAP 8.8, design/19-server-platform.md §3/§4).
 *
 * `store.proxy.http.test.ts` drives the same three handlers through a real matchsvc, a real
 * billsvc and the real client contract, and asserts the happy path end to end. What this file
 * adds is everything a real billing plane will not produce on demand: a refused connection, a
 * 500, a body that is not JSON, an order belonging to somebody else, and the one mapping that
 * matters most — billsvc rejecting OUR internal key must never reach a player as a 401.
 *
 * `AuthService` is faked (two accounts, one token each) and `fetchImpl` is injected, because
 * the question here is entirely about what this proxy does with an answer, not about how
 * either peer produced one. `internalFetch` itself is real: its drain/timeout/no-retry
 * behaviour is part of what these cases assert.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AuthService } from '../src/AuthService';
import { getSkus, postOrder, getOrder, STORE_ORDER_PATH, STORE_TIMEOUT_MS, type StoreRouteDeps } from '../src/routes/store';

const ADA = { accountId: 'acct-ada', username: 'ada' };
const BOB = { accountId: 'acct-bob', username: 'bob' };
const TOKENS: Record<string, { accountId: string; username: string }> = { 'tok-ada': ADA, 'tok-bob': BOB };

const PLANE = 'http://billsvc.test';

interface Recorded {
  status: number;
  body: string;
  /** Resolves when the handler has answered — every route here answers asynchronously. */
  done: Promise<void>;
}

function fakeRes(onWriteHead?: () => void): { res: ServerResponse; sent: Recorded } {
  let resolve!: () => void;
  const sent: Recorded = { status: 0, body: '', done: new Promise<void>((r) => (resolve = r)) };
  const res = {
    writeHead(status: number) {
      onWriteHead?.();
      sent.status = status;
      return res;
    },
    end(body?: string) {
      sent.body = body ?? '';
      resolve();
    },
  };
  return { res: res as unknown as ServerResponse, sent };
}

function fakeReq(headers: Record<string, string> = {}): IncomingMessage & EventEmitter {
  const req = new EventEmitter() as EventEmitter & { headers: Record<string, string> };
  req.headers = headers;
  return req as unknown as IncomingMessage & EventEmitter;
}

/** Resolves a bearer token to one of the two accounts above, and nothing else to anything —
 *  `requireAuth`'s two real outcomes, without standing up password hashing. */
function fakeAuth(): AuthService {
  return {
    verifySession: vi.fn((token: unknown) => (typeof token === 'string' ? (TOKENS[token] ?? null) : null)),
  } as unknown as AuthService;
}

/** What the injected billing plane answers, and what it was asked. */
interface Plane {
  calls: { url: string; method: string; headers: Record<string, string>; body: unknown }[];
  fetchImpl: typeof fetch;
}

type Answer = { status: number; body: string } | { throws: string };

function plane(...answers: Answer[]): Plane {
  const calls: Plane['calls'] = [];
  let i = 0;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const raw = (init?.body ?? null) as string | null;
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: raw === null ? null : (JSON.parse(raw) as unknown),
    });
    // The LAST authored answer repeats, so a case asserting "exactly one attempt" fails by
    // running out of answers rather than by silently reusing the first one.
    const answer = answers[Math.min(i++, answers.length - 1)]!;
    if ('throws' in answer) throw new Error(answer.throws);
    return new Response(answer.body, { status: answer.status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const json = (v: unknown): Answer => ({ status: 200, body: JSON.stringify(v) });

function deps(p: Plane, over: Partial<StoreRouteDeps['billing']> = {}): StoreRouteDeps {
  return { auth: fakeAuth(), billing: { url: PLANE, internalKey: 'k', fetchImpl: p.fetchImpl, ...over } };
}

const parsed = (sent: Recorded) => JSON.parse(sent.body) as Record<string, unknown>;
const bearer = (token: string) => fakeReq({ authorization: `Bearer ${token}` });

let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Drive `getSkus` to completion. */
async function skus(p: Plane, req = bearer('tok-ada')): Promise<Recorded> {
  const { res, sent } = fakeRes();
  getSkus(req, res, new URL('http://match.test/store/skus'), deps(p));
  await sent.done;
  return sent;
}

/** Drive `postOrder` to completion, feeding `body` through the real `readJson`. */
async function order(p: Plane, body: unknown, req = bearer('tok-ada')): Promise<Recorded> {
  const { res, sent } = fakeRes();
  postOrder(req, res, new URL('http://match.test/store/order'), deps(p));
  req.emit('data', Buffer.from(JSON.stringify(body)));
  req.emit('end');
  await sent.done;
  return sent;
}

/** Drive `getOrder` to completion for one order id. */
async function poll(p: Plane, id: string, req = bearer('tok-ada')): Promise<Recorded> {
  const { res, sent } = fakeRes();
  getOrder(req, res, new URL(`http://match.test/store/order/${encodeURIComponent(id)}`), deps(p));
  await sent.done;
  return sent;
}

const ORDER_OF = (accountId: string) => ({
  order: { id: 'o-1', accountId, sku: 'bp.cannon', platform: 'wechat', amountCents: 1800, currency: 'CNY', state: 'created' },
});

// ─────────────────────────────────────────────────────────────────────────────
// The bearer boundary — no route here answers without a live session
// ─────────────────────────────────────────────────────────────────────────────

describe('store proxy — the player half of the trust seam', () => {
  it('refuses all three routes with NO authorization header, and calls billsvc for none of them', async () => {
    const p = plane(json({ skus: [] }));
    const anon = fakeReq();

    const a = fakeRes();
    getSkus(anon, a.res, new URL('http://match.test/store/skus'), deps(p));
    const b = fakeRes();
    postOrder(anon, b.res, new URL('http://match.test/store/order'), deps(p));
    const c = fakeRes();
    getOrder(anon, c.res, new URL('http://match.test/store/order/o-1'), deps(p));

    for (const sent of [a.sent, b.sent, c.sent]) {
      expect(sent.status).toBe(401);
      expect(parsed(sent).error).toBe('invalid or expired session');
    }
    // The refusal happens BEFORE the hop, which is the point: an unauthenticated request must
    // not be able to make this process open a connection to the billing plane at all.
    expect(p.calls).toHaveLength(0);
  });

  it('refuses an EXPIRED (unknown) token the same way, and a token that is not Bearer-prefixed', async () => {
    const p = plane(json({ skus: [] }));
    expect((await skus(p, bearer('tok-expired'))).status).toBe(401);
    expect((await skus(p, fakeReq({ authorization: 'tok-ada' }))).status).toBe(401);
    expect(p.calls).toHaveLength(0);
  });

  it('requires a session for GET /store/skus even though billsvc serves /skus publicly', async () => {
    // A decision, not an oversight — `routes/store.ts`'s header carries the three reasons.
    // Pinned here so relaxing it is a test change rather than a quiet one.
    const p = plane(json({ skus: [{ sku: 'bp.cannon' }] }));
    expect((await skus(p, fakeReq())).status).toBe(401);
    expect((await skus(p)).status).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Identity — the accountId comes from the session and from nowhere else
// ─────────────────────────────────────────────────────────────────────────────

describe('store proxy — whose account is being charged', () => {
  it('sends the SESSION accountId to billsvc, and never the one in the request body', async () => {
    const p = plane(json({ order: { id: 'o-1' }, payment: { configured: false } }));
    // The impersonation attempt: a logged-in Ada asking to have Bob's account charged, and
    // (a second shape of the same trick) a matching-but-client-asserted accountId.
    const sent = await order(p, { sku: 'bp.cannon', platform: 'wechat', accountId: BOB.accountId });
    expect(sent.status).toBe(200);
    expect(p.calls).toHaveLength(1);
    expect(p.calls[0]!.body).toEqual({ accountId: ADA.accountId, sku: 'bp.cannon', platform: 'wechat' });
  });

  it('forwards Bob under Bob when Bob is the one holding the token', async () => {
    const p = plane(json({ order: { id: 'o-2' }, payment: { configured: false } }));
    await order(p, { sku: 'bp.cannon', platform: 'wechat' }, bearer('tok-bob'));
    expect((p.calls[0]!.body as { accountId: string }).accountId).toBe(BOB.accountId);
  });

  it('forwards sku/platform UNVALIDATED — billsvc owns the catalogue, and its 400 is relayed', async () => {
    const p = plane({ status: 400, body: JSON.stringify({ error: 'unknown sku' }) });
    const sent = await order(p, { sku: 'bp.nonexistent', platform: 'wechat' });
    expect(p.calls[0]!.body).toEqual({ accountId: ADA.accountId, sku: 'bp.nonexistent', platform: 'wechat' });
    expect(sent.status).toBe(400);
    expect(parsed(sent).error).toBe('unknown sku');
    // Non-retryable, and not retried: booking an order twice is the failure mode that matters.
    expect(p.calls).toHaveLength(1);
  });

  it('forwards a body with no sku at all rather than inventing a refusal of its own', async () => {
    const p = plane({ status: 400, body: JSON.stringify({ error: 'unknown sku' }) });
    await order(p, {});
    expect(p.calls[0]!.body).toEqual({ accountId: ADA.accountId, sku: undefined, platform: undefined });
  });

  it('still names the session account when the request body is a literal null', async () => {
    // `readJson` hands `JSON.parse('null')` straight through, so this is the one input that
    // reaches the `?? {}` fallback — and the accountId must survive it, since that is the
    // field an attacker would most like to see this route lose.
    const p = plane({ status: 400, body: JSON.stringify({ error: 'unknown sku' }) });
    await order(p, null);
    expect(p.calls[0]!.body).toEqual({ accountId: ADA.accountId, sku: undefined, platform: undefined });
  });

  it('presents the internal key and the caller name on every hop', async () => {
    const p = plane(json({ skus: [] }));
    await skus(p);
    expect(p.calls[0]!.headers['x-internal-key']).toBe('k');
    expect(p.calls[0]!.headers['x-internal-caller']).toBe('matchsvc');
    expect(p.calls[0]!.url).toBe(`${PLANE}/skus`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Ownership — the whole reason this proxy is more than a URL rewrite
// ─────────────────────────────────────────────────────────────────────────────

describe('store proxy — GET /store/order/:id is narrowed to the session', () => {
  it("answers 404 for ANOTHER account's order, even though billsvc happily returned it", async () => {
    // billsvc's `GET /order/:id` does not check ownership — correct for an internal route,
    // and the exact hole this proxy would open if it just relayed. Ada polls Bob's order.
    const p = plane(json(ORDER_OF(BOB.accountId)));
    const sent = await poll(p, 'o-1');
    expect(sent.status).toBe(404);
    // The SAME answer a nonexistent id gets — telling the two apart would confirm that a
    // guessed id names a real order.
    expect(parsed(sent).error).toBe('not found');
    // And nothing about Bob's purchase reached the wire.
    expect(sent.body).not.toContain(BOB.accountId);
    expect(sent.body).not.toContain('bp.cannon');
  });

  it("returns the order when it IS the session's own", async () => {
    const p = plane(json(ORDER_OF(ADA.accountId)));
    const sent = await poll(p, 'o-1');
    expect(sent.status).toBe(200);
    expect((parsed(sent).order as { id: string }).id).toBe('o-1');
  });

  it('fails CLOSED when the response carries no accountId to check against', async () => {
    // A billsvc that stopped sending the field must break this route loudly, not start
    // serving every order to everyone.
    for (const body of [{ order: { id: 'o-1', state: 'created' } }, { order: null }, { order: 'o-1' }, {}]) {
      const p = plane(json(body));
      expect((await poll(p, 'o-1')).status).toBe(404);
    }
  });

  it('relays billsvc\'s own 404 for an id that does not exist', async () => {
    const p = plane({ status: 404, body: JSON.stringify({ error: 'not found' }) });
    const sent = await poll(p, 'nope');
    expect(sent.status).toBe(404);
    expect(p.calls[0]!.url).toBe(`${PLANE}/order/nope`);
  });

  it('percent-encodes the id on the way out, so a crafted id cannot reach another route', async () => {
    const p = plane(json(ORDER_OF(ADA.accountId)));
    await poll(p, '../skus');
    expect(p.calls[0]!.url).toBe(`${PLANE}/order/..%2Fskus`);
  });

  it('answers 404 for a path its own pattern does not match, without asking billsvc', async () => {
    // Unreachable through `matchsvc.ts` (which tests the same pattern before dispatching),
    // and asserted anyway: the handler re-matches rather than trusting its caller to have.
    const p = plane(json(ORDER_OF(ADA.accountId)));
    const { res, sent } = fakeRes();
    getOrder(bearer('tok-ada'), res, new URL('http://match.test/store/order/a/b'), deps(p));
    await sent.done;
    expect(sent.status).toBe(404);
    expect(p.calls).toHaveLength(0);
    expect(STORE_ORDER_PATH.test('/store/order/a/b')).toBe(false);
    expect(STORE_ORDER_PATH.test('/store/order/o-1')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The failure policy
// ─────────────────────────────────────────────────────────────────────────────

describe('store proxy — when the billing plane does not answer', () => {
  it('turns a refused connection into 502 and one warning, not a 500', async () => {
    const p = plane({ throws: 'connect ECONNREFUSED 127.0.0.1:8789' });
    const sent = await skus(p);
    expect(sent.status).toBe(502);
    expect(parsed(sent).error).toBe('store temporarily unavailable');
    expect(p.calls).toHaveLength(1); // no retry ladder in a request a player is waiting on
    expect(String(warn.mock.calls[0]?.[0])).toContain('ECONNREFUSED');
  });

  it('turns a billsvc 500 into 502, once, without retrying it', async () => {
    const p = plane({ status: 500, body: JSON.stringify({ error: 'grant failed' }) });
    const sent = await order(p, { sku: 'bp.cannon', platform: 'wechat' });
    expect(sent.status).toBe(502);
    // billsvc's own message is NOT relayed on a 5xx: it describes the billing plane's
    // internals, and the player-facing sentence must not depend on them.
    expect(parsed(sent).error).toBe('store temporarily unavailable');
    expect(p.calls).toHaveLength(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('500');
  });

  it('turns a per-attempt TIMEOUT into 502, and the budget is the store one, not the 5 s default', async () => {
    const slow = (async (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as unknown as typeof fetch;
    const { res, sent } = fakeRes();
    getSkus(bearer('tok-ada'), res, new URL('http://match.test/store/skus'), {
      auth: fakeAuth(),
      billing: { url: PLANE, fetchImpl: slow, timeoutMs: 5 },
    });
    await sent.done;
    expect(sent.status).toBe(502);
    expect(String(warn.mock.calls[0]?.[0])).toContain('timeout');
    // The shipped budget is deliberately tighter than `internalFetch`'s default, because a
    // player is holding a screen open behind this call.
    expect(STORE_TIMEOUT_MS).toBe(3_000);
    expect(STORE_TIMEOUT_MS).toBeLessThan(5_000);
  });

  it('NEVER relays billsvc\'s 401 — a rejected internal key is our misconfiguration, not a bad session', async () => {
    // The mapping that matters most. A relayed 401 reads to `net/billing.ts` as an expired
    // session, so a deploy that forgot BB_INTERNAL_KEY would present to every player as a
    // login problem and to no operator as anything at all.
    for (const status of [401, 403]) {
      const p = plane({ status, body: JSON.stringify({ error: 'unauthorized' }) });
      const sent = await skus(p);
      expect(sent.status).toBe(502);
      expect(parsed(sent).error).toBe('store temporarily unavailable');
    }
    expect(error).toHaveBeenCalledTimes(2);
    expect(String(error.mock.calls[0]?.[0])).toContain('BB_INTERNAL_KEY');
  });

  it('turns a 2xx that is not JSON into 502 rather than an empty envelope', async () => {
    // A proxy or load balancer's HTML error page, answered with a 200.
    const p = plane({ status: 200, body: '<html>502 Bad Gateway</html>' });
    const sent = await skus(p);
    expect(sent.status).toBe(502);
    expect(String(warn.mock.calls[0]?.[0])).toContain('no usable JSON body');
  });

  it('treats a 2xx JSON body that is not an object (or is empty) as unusable too', async () => {
    for (const body of ['123', '"ok"', 'null', '']) {
      const p = plane({ status: 200, body });
      expect((await skus(p)).status).toBe(502);
    }
  });

  it('falls back to its own wording when a relayed 4xx carries no usable error string', async () => {
    for (const body of ['{}', '{"error":42}', 'not json at all', '']) {
      const p = plane({ status: 400, body });
      const sent = await order(p, { sku: 'x', platform: 'wechat' });
      expect(sent.status).toBe(400);
      expect(parsed(sent).error).toBe('store request refused');
    }
  });

  it('cannot take the control plane down when the response socket has already gone', async () => {
    // `internalFetchJson` never rejects, so the only way into the guard is `send` itself
    // failing — and an unhandled rejection there would kill matchmaking for everyone else
    // along with one dead store request.
    const p = plane(json({ skus: [] }));
    const { res, sent } = fakeRes(() => {
      throw new Error('write after end');
    });
    getSkus(bearer('tok-ada'), res, new URL('http://match.test/store/skus'), deps(p));
    await vi.waitFor(() => expect(error).toHaveBeenCalled());
    expect(String(error.mock.calls[0]?.[0])).toContain('write after end');
    expect(sent.status).toBe(0); // nothing was ever answered, and nothing tried to answer twice
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The defaults, so the injection seam does not leave the shipped wiring untested
// ─────────────────────────────────────────────────────────────────────────────

describe('store proxy — the uninjected configuration', () => {
  it('reads the plane URL, the shared key and the caller name from config.ts', async () => {
    // Every case above pins `billing`, which is exactly how a config default goes untested.
    // This one injects only `fetchImpl`, so the other three fields come from the real path.
    vi.stubEnv('BB_BILLSVC_URL', 'http://bill.example:9999');
    vi.stubEnv('BB_INTERNAL_KEY', 'real-key');
    const p = plane(json({ skus: [] }));
    const { res, sent } = fakeRes();
    getSkus(bearer('tok-ada'), res, new URL('http://match.test/store/skus'), {
      auth: fakeAuth(),
      billing: { fetchImpl: p.fetchImpl },
    });
    await sent.done;
    expect(sent.status).toBe(200);
    expect(p.calls[0]!.url).toBe('http://bill.example:9999/skus');
    expect(p.calls[0]!.headers['x-internal-key']).toBe('real-key');
    expect(p.calls[0]!.headers['x-internal-caller']).toBe('matchsvc');
    vi.unstubAllEnvs();
  });

  it('sends NO key at all when the registry is empty, rather than a placeholder', async () => {
    // The production fail-closed branch (`config.ts`): billsvc then refuses with a logged
    // reason, which this proxy turns into a 502 and an operator-facing error.
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('BB_INTERNAL_KEY', '');
    const p = plane({ status: 401, body: JSON.stringify({ error: 'unauthorized' }) });
    const { res, sent } = fakeRes();
    getSkus(bearer('tok-ada'), res, new URL('http://match.test/store/skus'), {
      auth: fakeAuth(),
      billing: { url: PLANE, fetchImpl: p.fetchImpl },
    });
    await sent.done;
    expect(p.calls[0]!.headers['x-internal-key']).toBeUndefined();
    expect(sent.status).toBe(502);
    vi.unstubAllEnvs();
  });
});
