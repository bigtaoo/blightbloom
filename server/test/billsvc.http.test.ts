/**
 * billsvc's HTTP surface, driven with real `fetch` over an ephemeral port on `:memory:`
 * SQLite — the same shape as `matchsvc.http.test.ts`, and for the same reason its header
 * gives: the thin HTTP shell is exactly where a bug hides from every pure-logic test.
 *
 * Three things only exist at this layer, so they can only be asserted here:
 *
 *   - `POST /order/create` NOT READING `amount`. The service has no parameter for it, so
 *     the only place a pass-through could be introduced is the body-parsing line.
 *   - Which routes are behind the internal key, and that the WEBHOOK deliberately is not
 *     (design/19 §3 — the platform's own signature authenticates it instead).
 *   - The end-to-end chain with no merchant account at all: create → dev "payment" →
 *     webhook → delivered. design/19 §5 calls that the reason the stub exists, and this
 *     is the test that proves it still works.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import { request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import type { DatabaseSync } from 'node:sqlite';
import { openBillingDb } from '../src/billingDb';
import { createBillsvcServer, type BillsvcServerOptions } from '../src/billsvc/server';
import { createInternalVerifier } from '../src/internalAuth';
import type { EntitlementGrantRequest } from '../src/billsvc/delivery';
import { deliveryById, pendingDeliveries } from '../src/billsvc/outbox';

const KEY = 'test-internal-key';
/** Drives the receipt-stub policy only. The internal key is pinned as a registry below. */
const DEV_ENV = { BB_BILLING_DEV_STUB: '1' };
/**
 * The internal-key registry, pinned rather than stubbed into `process.env` — which is the
 * seam `internalAuth`'s verifier exists for, and the same thing `routes/rating.ts`'s tests
 * do. One case at the bottom of this file covers the UNINJECTED default instead, so the
 * `config.ts` wiring is not left untested by the convenience.
 */
const REGISTRY = [{ caller: 'matchsvc', key: KEY }];

let baseUrl: string;
let db: DatabaseSync;
let granted: EntitlementGrantRequest[];
let close: () => Promise<void> = async () => {};

async function start(over: BillsvcServerOptions = {}): Promise<void> {
  await close();
  granted = [];
  const ownDb = openBillingDb(':memory:');
  db = ownDb;
  const { server } = createBillsvcServer({
    db: ownDb,
    env: DEV_ENV,
    internalAuth: createInternalVerifier(REGISTRY),
    deliver: {
      grant(g) {
        granted.push(g);
      },
    },
    ...over,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;

  // Idempotent, and it closes THIS server and THIS database rather than whatever the
  // module-level bindings happen to point at. Both matter: a test that restarts the
  // harness mid-case leaves `afterEach` holding a shutdown that has already run, and
  // `server.close()` on an already-closed server still fires its callback — which then
  // called `db.close()` a second time and took the worker down with an uncaught
  // ERR_INVALID_STATE rather than failing a test.
  let shutDown = false;
  close = () =>
    new Promise<void>((resolve) => {
      if (shutDown) return resolve();
      shutDown = true;
      // `closeAllConnections` first: `fetch` (undici) holds its sockets open with
      // keep-alive, and `server.close()` waits for every connection to drain — so without
      // this the callback never fires and the suite hangs instead of finishing.
      server.closeAllConnections();
      server.close(() => {
        ownDb.close();
        resolve();
      });
    });
}

type Res = { status: number; body: Record<string, never> };

async function call(
  method: 'GET' | 'POST' | 'OPTIONS',
  path: string,
  opts: { body?: unknown; key?: string | null } = {},
): Promise<Res> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const key = opts.key === undefined ? KEY : opts.key;
  if (key !== null) headers['x-internal-key'] = key;
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, never>) : ({} as Record<string, never>) };
}

const createOrder = (body: unknown) => call('POST', '/order/create', { body });

beforeEach(async () => {
  await start();
});

afterEach(async () => {
  await close();
});

// ─────────────────────────────────────────────────────────────────────────────
// Open routes
// ─────────────────────────────────────────────────────────────────────────────

describe('billsvc HTTP — open routes', () => {
  it('GET /health identifies the billing plane, not the other two', async () => {
    const { status, body } = await call('GET', '/health', { key: null });
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, service: 'daydayup-billsvc' });
  });

  it('GET /skus needs no key — a price list is public by definition', async () => {
    const { status, body } = await call('GET', '/skus', { key: null });
    expect(status).toBe(200);
    expect(Array.isArray(body.skus)).toBe(true);
    expect((body.skus as unknown as { sku: string }[]).some((s) => s.sku === 'bp.cannon')).toBe(true);
  });

  it('answers the CORS preflight', async () => {
    const res = await fetch(`${baseUrl}/order/create`, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-headers')).toContain('content-type');
  });

  it('404s an unknown path', async () => {
    expect((await call('GET', '/nope')).status).toBe(404);
  });

  it('404s a known path on the wrong method', async () => {
    expect((await call('GET', '/order/create')).status).toBe(404);
    expect((await call('POST', '/skus', { body: {} })).status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The internal-key boundary
// ─────────────────────────────────────────────────────────────────────────────

describe('billsvc HTTP — the internal-key boundary', () => {
  it('401s POST /order/create with no key', async () => {
    const { status, body } = await call('POST', '/order/create', { body: {}, key: null });
    expect(status).toBe(401);
    expect(body.error).toBe('unauthorized');
  });

  it('401s POST /order/create with a wrong key, and books nothing', async () => {
    expect((await call('POST', '/order/create', { body: { accountId: 'a1', sku: 'bp.cannon', platform: 'dev' }, key: 'wrong' })).status).toBe(401);
    expect(db.prepare('SELECT COUNT(*) AS n FROM orders').get()).toEqual({ n: 0 });
  });

  it('401s GET /order/:id with no key — an order id must not be a public read', async () => {
    const created = await createOrder({ accountId: 'a1', sku: 'bp.cannon', platform: 'dev' });
    const id = (created.body.order as unknown as { id: string }).id;
    expect((await call('GET', `/order/${id}`, { key: null })).status).toBe(401);
  });

  it('checks the key BEFORE reading the body, so an unauthorised call cannot probe validation', async () => {
    const { body } = await call('POST', '/order/create', { body: { sku: 'bp.nope' }, key: 'wrong' });
    expect(body.error).toBe('unauthorized');
  });

  it('the WEBHOOK is deliberately NOT behind the internal key (design/19 §3)', async () => {
    const created = await createOrder({ accountId: 'a1', sku: 'bp.cannon', platform: 'dev' });
    const id = (created.body.order as unknown as { id: string }).id;
    const { status, body } = await call('POST', '/webhook/dev', {
      key: null,
      body: { orderId: id, receipt: 'product:bp.cannon', txnId: 'T1' },
    });
    expect(status).toBe(200);
    expect(body.delivered).toBe(true);
  });

  it('an injected verifier replaces the default entirely', async () => {
    await start({ internalAuth: { verify: () => ({ ok: false, reason: 'unknown-key' }) } });
    expect((await call('GET', '/skus', { key: null })).status).toBe(200); // still open
    expect((await call('POST', '/order/create', { body: {} })).status).toBe(401);
  });

  it('uses the shared ROADMAP 8.1 verifier, so an EMPTY registry refuses everything', async () => {
    // Not a billsvc-local check any more: the same `internalAuth` verifier and the same
    // fail-closed posture as `routes/rating.ts`. An empty registry is what `config.ts`
    // returns for a production process with no `BB_INTERNAL_KEY`, and it must reject
    // rather than wave calls through.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await start({ internalAuth: createInternalVerifier([]) });
    expect((await call('POST', '/order/create', { body: {}, key: 'anything' })).status).toBe(401);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('no-keys-configured'))).toBe(true);
    warn.mockRestore();
  });

  it('accepts the registry key and logs nothing on success', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await start();
    expect((await createOrder({ accountId: 'a1', sku: 'bp.cannon', platform: 'dev' })).status).toBe(200);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('logs the rejection with the route and the untrusted caller claim, and leaks neither', async () => {
    // design/19 §7: the operator gets the reason, the caller gets "unauthorized".
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await start();
    const res = await fetch(`${baseUrl}/order/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-key': 'wrong', 'x-internal-caller': 'impostor' },
      body: '{}',
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
    const line = warn.mock.calls.map((c) => String(c[0])).join(' ');
    expect(line).toContain('POST /order/create');
    expect(line).toContain('impostor');
    warn.mockRestore();
  });

  it('does NOT advertise x-internal-key to browsers in its CORS preflight', async () => {
    // The mirror of matchsvc's `authorization` bug, pointed the other way: every internal
    // route is process-to-process, so a preflight never needs the header, and advertising it
    // only tells a browser client to try.
    const res = await fetch(`${baseUrl}/order/create`, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-headers')).not.toContain('x-internal-key');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /order/create
// ─────────────────────────────────────────────────────────────────────────────

describe('billsvc HTTP — POST /order/create', () => {
  it('books an order and returns the payment block', async () => {
    const { status, body } = await createOrder({ accountId: 'a1', sku: 'bp.cannon', platform: 'dev' });
    expect(status).toBe(200);
    expect(body.order).toMatchObject({ accountId: 'a1', sku: 'bp.cannon', amountCents: 1800, state: 'created' });
    expect(body.payment).toMatchObject({ configured: true });
  });

  it('DISCARDS an amount in the request body (design/19 §4)', async () => {
    const { body } = await createOrder({
      accountId: 'a1',
      sku: 'bp.cannon',
      platform: 'dev',
      amount: 1,
      amountCents: 1,
      amount_cents: 1,
      price: 1,
    });
    expect(body.order).toMatchObject({ amountCents: 1800 });
    expect(db.prepare('SELECT amount_cents FROM orders').get()).toEqual({ amount_cents: 1800 });
  });

  it('400s an unknown SKU, an unknown platform and a missing accountId', async () => {
    expect(await createOrder({ accountId: 'a1', sku: 'bp.nope', platform: 'dev' })).toMatchObject({
      status: 400,
      body: { error: 'unknown sku' },
    });
    expect(await createOrder({ accountId: 'a1', sku: 'bp.cannon', platform: 'paypal' })).toMatchObject({
      status: 400,
      body: { error: 'unknown platform' },
    });
    expect(await createOrder({ sku: 'bp.cannon', platform: 'dev' })).toMatchObject({
      status: 400,
      body: { error: 'accountId required' },
    });
  });

  it('400s an empty body and a malformed one, rather than 500ing', async () => {
    expect((await call('POST', '/order/create', { body: undefined })).status).toBe(400);
    const res = await fetch(`${baseUrl}/order/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-key': KEY },
      body: '{not json',
    });
    expect(res.status).toBe(400);
  });

  it('400s a body that is the literal JSON `null`', async () => {
    // `JSON.parse('null')` is a successful parse that yields null, so the route's `?? {}`
    // is the only thing between it and a property read on null.
    const res = await fetch(`${baseUrl}/order/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-key': KEY },
      body: 'null',
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('accountId required');
  });

  it('400s an oversized body instead of parsing a truncated prefix of it', async () => {
    const res = await fetch(`${baseUrl}/order/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-key': KEY },
      body: JSON.stringify({ accountId: 'a1', sku: 'bp.cannon', platform: 'dev', pad: 'x'.repeat(300 * 1024) }),
    });
    expect(res.status).toBe(400);
    expect(db.prepare('SELECT COUNT(*) AS n FROM orders').get()).toEqual({ n: 0 });
  });

  it('rejects an oversized body whose KEPT PREFIX is already valid JSON', async () => {
    // Found by a 2026-09-04 mutation battery: deleting `readJson`'s `overflow` flag survived
    // every other case in this file. The `fetch`-based oversized test does not catch it,
    // because a truncated prefix of one JSON object does not parse — so dropping the flag
    // still ended in a 400, by accident rather than by design.
    //
    // The hole the flag actually closes: `readJson` drops whole chunks once the cap is
    // crossed, so if a COMPLETE JSON document happens to be everything received before that
    // point, the kept bytes parse cleanly and the handler acts on a body it had already
    // decided was too large — booking a real order from an over-cap request.
    //
    // Reproducing that needs the cap to be crossed by the chunk AFTER a valid document, and
    // three details are load-bearing (each one was wrong on an earlier attempt):
    //   - `fetch` frames the body itself, so this drives `node:http` and writes by hand;
    //   - two back-to-back `write()`s coalesce into one segment, so the first write's flush
    //     callback plus a turn of the event loop is what makes the server see two chunks;
    //   - node reads the socket in 64 KB pieces, so a small document followed by a big pad
    //     still keeps ~256 KB of that pad and fails to parse. The document itself has to sit
    //     just under the cap, which is why the padding is INSIDE the JSON and sized to it.
    const CAP = 256 * 1024;
    const envelope = { accountId: 'a1', sku: 'bp.cannon', platform: 'dev', pad: '' };
    const overhead = Buffer.byteLength(JSON.stringify(envelope));
    envelope.pad = 'x'.repeat(CAP - overhead - 8); // 8 bytes of headroom under the cap
    const document = JSON.stringify(envelope);
    expect(Buffer.byteLength(document)).toBe(CAP - 8);
    expect(JSON.parse(document)).toMatchObject({ sku: 'bp.cannon' }); // the kept prefix DOES parse

    const { port } = new URL(baseUrl);
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port: Number(port),
          path: '/order/create',
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-internal-key': KEY },
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        },
      );
      req.on('error', reject);
      req.write(document, () => {
        setTimeout(() => {
          req.write('x'.repeat(64 * 1024)); // any piece of this crosses the 8-byte headroom
          req.end();
        }, 25);
      });
    });

    expect(status).toBe(400);
    expect(db.prepare('SELECT COUNT(*) AS n FROM orders').get()).toEqual({ n: 0 });
  });

  it('survives a client that disconnects mid-upload', async () => {
    // A dropped mobile connection part-way through a body is the ordinary case here, not an
    // exotic one, and what must be true is that it costs nothing: the process keeps serving
    // and the half-sent request books no order. Driven over a raw socket because both
    // `fetch` and `node:http` tidy up after themselves, and the point is an UNGRACEFUL
    // disconnect with bytes still outstanding — the request stream emits 'aborted' and
    // 'error' and never emits 'end'.
    //
    // Honest scope: this does NOT pin `readJson`'s `req.on('error')` handler. A 2026-09-04
    // mutation battery deleted that line and this case stayed green — correctly, because on
    // node v26 an unhandled request 'error' is routed internally rather than thrown. That
    // finding lives in a comment on the line itself; what is asserted below is the outcome,
    // which holds with or without it.
    const { port } = new URL(baseUrl);
    await new Promise<void>((resolve) => {
      const sock = connect(Number(port), '127.0.0.1', () => {
        const CRLF = '\r\n';
        sock.write(
          `POST /order/create HTTP/1.1${CRLF}Host: x${CRLF}` +
            `x-internal-key: ${KEY}${CRLF}` +
            `Content-Type: application/json${CRLF}Content-Length: 500${CRLF}${CRLF}`,
        );
        sock.write('{"accountId":"a1","sku":"bp.cannon"'); // deliberately incomplete
        setTimeout(() => {
          sock.destroy();
          resolve();
        }, 30);
      });
      sock.on('error', () => resolve());
    });
    // Give the aborted request a turn to be handled (or to crash the process).
    await new Promise((r) => setTimeout(r, 60));

    // The process is still serving, and the half-sent request booked nothing.
    expect((await call('GET', '/health', { key: null })).status).toBe(200);
    expect(db.prepare('SELECT COUNT(*) AS n FROM orders').get()).toEqual({ n: 0 });
  });

  it('accepts a body large enough to be a real Apple receipt', async () => {
    // matchsvc's 4 KB find-request cap would truncate this into a parse failure; a real
    // App Store receipt is a base64 blob of several kilobytes.
    const created = await createOrder({ accountId: 'a1', sku: 'bp.cannon', platform: 'apple' });
    const id = (created.body.order as unknown as { id: string }).id;
    const { status } = await call('POST', '/webhook/apple', {
      key: null,
      body: { orderId: id, receipt: `product:bp.cannon`, txnId: 'T1', raw: 'M'.repeat(40 * 1024) },
    });
    expect(status).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /order/:id
// ─────────────────────────────────────────────────────────────────────────────

describe('billsvc HTTP — GET /order/:id', () => {
  it('polls an order, and says only what the server believes', async () => {
    const created = await createOrder({ accountId: 'a1', sku: 'bp.cannon', platform: 'dev' });
    const id = (created.body.order as unknown as { id: string }).id;
    const { status, body } = await call('GET', `/order/${id}`);
    expect(status).toBe(200);
    expect(body.order).toMatchObject({ id, state: 'created', platformTxnId: null });
  });

  it('404s an unknown id', async () => {
    expect((await call('GET', '/order/nope')).status).toBe(404);
  });

  it('decodes a percent-encoded id rather than looking up the literal', async () => {
    await start({ newOrderId: () => 'order with spaces' });
    await createOrder({ accountId: 'a1', sku: 'bp.cannon', platform: 'dev' });
    const { status, body } = await call('GET', `/order/${encodeURIComponent('order with spaces')}`);
    expect(status).toBe(200);
    expect(body.order).toMatchObject({ id: 'order with spaces' });
  });

  it('polling cannot deliver anything, whatever the client claims (design/19 §4 rule 2)', async () => {
    const created = await createOrder({ accountId: 'a1', sku: 'bp.cannon', platform: 'dev' });
    const id = (created.body.order as unknown as { id: string }).id;
    for (let i = 0; i < 3; i++) await call('GET', `/order/${id}`);
    expect(granted).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM ledger').get()).toEqual({ n: 0 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /webhook/:platform — the whole chain, and its refusals
// ─────────────────────────────────────────────────────────────────────────────

describe('billsvc HTTP — the webhook', () => {
  async function book(accountId = 'a1', sku = 'bp.cannon', platform = 'dev'): Promise<string> {
    const created = await createOrder({ accountId, sku, platform });
    return (created.body.order as unknown as { id: string }).id;
  }

  it('drives create → pay → deliver end to end with NO merchant account', async () => {
    // design/19 §5: this is what the dev stub is for, and it is a long-lived asset.
    const created = await createOrder({ accountId: 'a1', sku: 'bp.cannon', platform: 'dev' });
    const params = created.body.payment as unknown as { params: Record<string, string> };

    const settled = await call('POST', '/webhook/dev', { key: null, body: params.params });
    expect(settled.status).toBe(200);
    expect(settled.body).toMatchObject({ ok: true, sku: 'bp.cannon', delivered: true });

    const polled = await call('GET', `/order/${params.params.orderId}`);
    expect(polled.body.order).toMatchObject({ state: 'settled', platformTxnId: params.params.txnId });
    expect(granted).toHaveLength(1);
  });

  it('reports a redelivery as delivered:false with a 200', async () => {
    const id = await book();
    const body = { orderId: id, receipt: 'product:bp.cannon', txnId: 'T1' };
    await call('POST', '/webhook/dev', { key: null, body });
    const second = await call('POST', '/webhook/dev', { key: null, body });
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ delivered: false, note: 'already-delivered' });
    expect(granted).toHaveLength(1);
  });

  it('404s an unknown platform in the path before reading the body', async () => {
    const { status, body } = await call('POST', '/webhook/paypal', { key: null, body: { orderId: 'x' } });
    expect(status).toBe(404);
    expect(body.error).toBe('unknown platform');
  });

  it('404s an unknown order and 400s every other rejection, with the code attached', async () => {
    expect(await call('POST', '/webhook/dev', { key: null, body: { orderId: 'nope', receipt: 'product:bp.cannon', txnId: 'T' } })).toMatchObject({
      status: 404,
      body: { code: 'unknown-order' },
    });

    const wrongSku = await book('a1', 'bp.leech');
    expect(await call('POST', '/webhook/dev', { key: null, body: { orderId: wrongSku, receipt: 'product:bp.cannon', txnId: 'T' } })).toMatchObject({
      status: 400,
      body: { code: 'product-mismatch' },
    });

    const id = await book('a2');
    expect(await call('POST', '/webhook/dev', { key: null, body: { orderId: id, receipt: '', txnId: 'T' } })).toMatchObject({
      status: 400,
      body: { code: 'bad-request' },
    });
  });

  it('400s an empty webhook body rather than 500ing', async () => {
    const { status, body } = await call('POST', '/webhook/dev', { key: null });
    expect(status).toBe(400);
    expect(body.code).toBe('bad-request');
  });

  it('400s a webhook body that is the literal JSON `null`', async () => {
    const res = await fetch(`${baseUrl}/webhook/dev`, { method: 'POST', body: 'null' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('bad-request');
  });

  it('ignores non-string body fields instead of coercing them', async () => {
    const id = await book();
    const { status, body } = await call('POST', '/webhook/dev', {
      key: null,
      body: { orderId: id, receipt: 42, txnId: { $ne: null } },
    });
    expect(status).toBe(400);
    expect(body.code).toBe('bad-request');
  });

  it("a 'failed' event closes the order, grants nothing, and does not read as a verification failure", async () => {
    const id = await book();
    const { status, body } = await call('POST', '/webhook/dev', { key: null, body: { orderId: id, event: 'failed' } });
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, state: 'failed', changed: true });
    expect(granted).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM ledger').get()).toEqual({ n: 0 });
  });

  it("a 'cancelled' event does the same", async () => {
    const id = await book();
    const { body } = await call('POST', '/webhook/dev', { key: null, body: { orderId: id, event: 'cancelled' } });
    expect(body).toMatchObject({ state: 'failed', changed: true });
  });

  it('a redelivered failure reports changed:false', async () => {
    const id = await book();
    await call('POST', '/webhook/dev', { key: null, body: { orderId: id, event: 'failed' } });
    const again = await call('POST', '/webhook/dev', { key: null, body: { orderId: id, event: 'failed' } });
    expect(again.body).toMatchObject({ ok: true, changed: false });
  });

  it('400s a failure event with no orderId, and 404s one for an unknown order', async () => {
    expect((await call('POST', '/webhook/dev', { key: null, body: { event: 'failed' } })).status).toBe(400);
    expect((await call('POST', '/webhook/dev', { key: null, body: { orderId: 'nope', event: 'failed' } })).status).toBe(404);
  });

  it('a `product:` receipt is INERT when the dev stub is off, even on /webhook/dev', async () => {
    // The fail-closed property, seen from the wire: nothing configured means nothing
    // granted, rather than the stub standing in for the missing credentials.
    await start({ env: { BB_INTERNAL_KEY: KEY } });
    const id = await book();
    const { status, body } = await call('POST', '/webhook/dev', {
      key: null,
      body: { orderId: id, receipt: 'product:bp.cannon', txnId: 'T1' },
    });
    expect(status).toBe(400);
    expect(body.code).toBe('verification-failed');
    expect(granted).toEqual([]);
  });

  it('and a real platform refuses it too, with no credentials configured', async () => {
    await start({ env: { BB_INTERNAL_KEY: KEY } });
    const id = await book('a1', 'bp.cannon', 'apple');
    const { body } = await call('POST', '/webhook/apple', {
      key: null,
      body: { orderId: id, receipt: 'MIIreal', txnId: 'T1' },
    });
    expect(body.code).toBe('verification-failed');
    expect(body.error).toContain('not configured');
  });

  it('500s rather than hanging if a settlement ever rejects', async () => {
    // `settle` is written to be total, so this cannot happen through `verify`/`deliver` —
    // it takes the injected-service seam to produce. Worth a case anyway: the failure it
    // guards is not a wrong answer but NO answer, which a platform experiences as a
    // request that hangs until its own timeout.
    const rejecting = {
      listSkus: () => [],
      getOrder: () => null,
      markFailed: () => ({ ok: false, changed: false }),
      settle: () => Promise.reject(new Error('lost the promise')),
    };
    await start({ billing: rejecting as never });
    const { status, body } = await call('POST', '/webhook/dev', {
      key: null,
      body: { orderId: 'o1', receipt: 'product:bp.cannon', txnId: 'T1' },
    });
    expect(status).toBe(500);
    expect(body).toEqual({ error: 'lost the promise', code: 'internal' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Wiring defaults
// ─────────────────────────────────────────────────────────────────────────────

describe('createBillsvcServer wiring', () => {
  it('opens its own DB from dbPath when no db is handed in', async () => {
    const { server, db: own, billing } = createBillsvcServer({
      dbPath: ':memory:',
      env: DEV_ENV,
      internalAuth: createInternalVerifier(REGISTRY),
    });
    expect(billing.listSkus().length).toBeGreaterThan(0);
    expect(own.prepare('SELECT COUNT(*) AS n FROM orders').get()).toEqual({ n: 0 });
    own.close();
    server.close();
  });

  it('reads process.env when no env is passed at all', () => {
    // vitest runs with NODE_ENV=test and no billing variables, so the default must land on
    // a stub-disabled verifier rather than throwing.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const own = openBillingDb(':memory:');
    const { server, billing } = createBillsvcServer({ db: own });
    expect(billing.createOrder({ accountId: 'a1', sku: 'bp.cannon', platform: 'dev' }).ok).toBe(true);
    server.close();
    own.close();
    warn.mockRestore();
  });

  it('builds its internal verifier from config.ts when none is injected', async () => {
    // The one case that exercises the REAL default rather than a pinned registry, so the
    // `internalKeys()` wiring cannot rot behind the convenience every other case uses.
    // Stubbed on process.env because that is where `config.ts` reads it, by design.
    vi.stubEnv('BB_INTERNAL_KEY', 'from-the-environment');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await start({ internalAuth: undefined });
    expect((await call('POST', '/order/create', { body: {}, key: 'from-the-environment' })).status).toBe(400);
    expect((await call('POST', '/order/create', { body: {}, key: 'not-the-key' })).status).toBe(401);
    vi.unstubAllEnvs();
  });

  it('builds a working verifier from the env when none is injected', async () => {
    await start({ verify: undefined });
    const created = await createOrder({ accountId: 'a1', sku: 'bp.cannon', platform: 'dev' });
    const params = (created.body.payment as unknown as { params: Record<string, string> }).params;
    expect((await call('POST', '/webhook/dev', { key: null, body: params })).body.delivered).toBe(true);
  });

  it('falls back to the OUTBOX delivery when none is injected', async () => {
    // The default this builder takes is not `BillingService`'s own `ledgerOnlyDelivery` —
    // it is `outbox.ts`'s (design/19 §4's closed loop, 2026-09-05). A settlement therefore
    // leaves a ledger row AND a durable delivery obligation, in one transaction.
    const { server, db: own, billing, pump } = createBillsvcServer({
      dbPath: ':memory:',
      env: DEV_ENV,
      internalAuth: createInternalVerifier(REGISTRY),
    });
    const created = billing.createOrder({ accountId: 'a1', sku: 'bp.cannon', platform: 'dev' });
    expect(created.ok).toBe(true);
    if (created.ok) {
      const r = await billing.settle({
        platform: 'dev',
        orderId: created.order.id,
        receipt: 'product:bp.cannon',
        txnId: 'T1',
      });
      expect(r).toMatchObject({ ok: true, delivered: true });
      expect(billing.ledgerFor('a1')).toHaveLength(1);
      // Keyed on the ledger row's own id, so the two are one fact in two tables.
      expect(deliveryById(own, 'purchase:dev:T1')).toMatchObject({
        accountId: 'a1',
        sku: 'bp.cannon',
        state: 'pending',
      });
    }
    await pump.stop();
    own.close();
    server.close();
  });

  it('leaves the outbox alone when a delivery IS injected, and every other case here does', async () => {
    // Guards the convenience the rest of this file leans on: `start()` above passes a
    // recording `deliver`, which disconnects the pump from anything to do. If that stopped
    // being true, every case in this file would be quietly making a network call.
    await start();
    const created = await createOrder({ accountId: 'a1', sku: 'bp.cannon', platform: 'dev' });
    const params = (created.body.payment as unknown as { params: Record<string, string> }).params;
    await call('POST', '/webhook/dev', { key: null, body: params });
    expect(granted).toHaveLength(1);
    expect(pendingDeliveries(db, 10)).toHaveLength(0);
  });
});
