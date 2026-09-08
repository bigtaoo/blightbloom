/**
 * The store hop end to end (ROADMAP 8.8, design/19-server-platform.md §4): the REAL client
 * contract → a REAL matchsvc → a REAL billsvc, over real HTTP on two ephemeral ports, with
 * the internal key and the bearer session both doing their actual jobs.
 *
 * `routes.store.test.ts` covers the refusals and the failure mapping at the unit layer. Three
 * things only exist here, and none of them can be asserted anywhere else:
 *
 *  - **The protocol mismatch is actually bridged.** The client calls `/store/skus`,
 *    `/store/order` and `/store/order/:id`; billsvc serves `/skus`, `/order/create` and
 *    `/order/:id`. Nothing but a live pair proves the rewrite lines up — and the caller here
 *    is `client/src/net/billing.ts` itself, imported through the `@dd/net/*` alias, so the
 *    contract being tested is the shipped one rather than a restatement of it.
 *  - **The CORS preflight allows `authorization`.** design/16-accounts.md records dropping
 *    that header as a bug only a real browser found: node's fetch does not enforce preflight,
 *    so the header block has to be asserted on a real `OPTIONS` response.
 *  - **The whole purchase**, with no merchant account anywhere: create through the proxy, pay
 *    through the dev stub's webhook, and poll through the proxy until it says `settled`.
 *
 * The delivery pump is stubbed to a 200. Draining the outbox into the control plane is 8.7's
 * loop and has its own tests; leaving it live here would have billsvc dialling a port this
 * file did not open.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createMatchsvcServer } from '../src/matchsvc';
import { createBillsvcServer } from '../src/billsvc/server';
import { INTERNAL_KEY_HEADER } from '../src/internalAuth';
import { listStoreSkus, createStoreOrder, fetchStoreOrder, formatSkuPrice } from '@dd/net/billing';

const KEY = 'e2e-internal-key';

let matchBase: string;
let billBase: string;
let matchsvc: Server;
let billsvc: Server;
let ada: string;
let bob: string;

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function shutdown(server: Server): Promise<void> {
  return new Promise<void>((resolve) => {
    // undici keeps its sockets alive, so `close()` alone never fires its callback here.
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

/** Register an account on matchsvc and return its bearer token. */
async function register(username: string): Promise<string> {
  const res = await fetch(`${matchBase}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: 'correct horse battery' }),
  });
  const body = (await res.json()) as { token?: string; error?: string };
  if (!body.token) throw new Error(`register failed: ${body.error}`);
  return body.token;
}

beforeAll(async () => {
  // Pinned rather than left to the dev fallback, so this file asserts that the two processes
  // AGREE on a key rather than that they share a published default.
  vi.stubEnv('BB_INTERNAL_KEY', KEY);

  ({ server: billsvc } = createBillsvcServer({
    dbPath: ':memory:',
    env: { BB_BILLING_DEV_STUB: '1' },
    pump: { fetchImpl: (async () => new Response('{"ok":true}', { status: 200 })) as unknown as typeof fetch },
  }));
  billBase = await listen(billsvc);

  matchsvc = createMatchsvcServer({ dbPath: ':memory:', billing: { url: billBase } });
  matchBase = await listen(matchsvc);

  ada = await register('ada');
  bob = await register('bob');
});

afterAll(async () => {
  await shutdown(matchsvc);
  await shutdown(billsvc);
  vi.unstubAllEnvs();
});

describe('store proxy over real HTTP — the client contract reaches the billing plane', () => {
  it('GET /store/skus serves billsvc\'s catalogue at billsvc\'s prices', async () => {
    const skus = await listStoreSkus(matchBase, ada);
    expect(skus.length).toBeGreaterThan(0);
    const cannon = skus.find((s) => s.sku === 'bp.cannon');
    expect(cannon).toBeDefined();
    // The price is the SERVER's — `net/billing.ts`'s one rule. 1800 minor units is what
    // `billsvc/skus.ts` authored, arriving through two processes unchanged.
    expect(cannon!.amountCents).toBe(1800);
    expect(cannon!.currency).toBe('CNY');
    expect(cannon!.grants).toEqual([{ kind: 'blueprint', id: 'cannon' }]);
    expect(formatSkuPrice(cannon!.amountCents, cannon!.currency)).toContain('18');
  });

  it('the same route refuses an anonymous caller before it opens a connection', async () => {
    const res = await fetch(`${matchBase}/store/skus`);
    expect(res.status).toBe(401);
    // And billsvc, whose own /skus is public, is still reachable directly from inside the
    // deployment — the proxy adds the session requirement, it does not move it.
    expect((await fetch(`${billBase}/skus`)).status).toBe(200);
  });

  it('POST /store/order books the order against the SESSION account, not the body', async () => {
    // The impersonation attempt, made with a raw fetch because `net/billing.ts` deliberately
    // offers no way to send an accountId at all.
    const res = await fetch(`${matchBase}/store/order`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${bob}` },
      body: JSON.stringify({ sku: 'bp.cannon', platform: 'dev', accountId: 'acct-somebody-else', amountCents: 1 }),
    });
    expect(res.status).toBe(200);
    const { order } = (await res.json()) as { order: { id: string; amountCents: number } };

    // Read the row back from the billing plane itself: the accountId it stored is the one
    // matchsvc resolved from Bob's token, and the price is still the catalogue's.
    const direct = await fetch(`${billBase}/order/${order.id}`, { headers: { [INTERNAL_KEY_HEADER]: KEY } });
    const stored = (await direct.json()) as { order: { accountId: string; amountCents: number } };
    expect(stored.order.accountId).not.toBe('acct-somebody-else');
    expect(stored.order.amountCents).toBe(1800);

    // Ada holds a different session, so the same id is simply not there for her.
    await expect(fetchStoreOrder(matchBase, ada, order.id)).rejects.toThrow('not found');
    // And it is there for Bob.
    await expect(fetchStoreOrder(matchBase, bob, order.id)).resolves.toMatchObject({ id: order.id, state: 'created' });
  });

  it('relays billsvc\'s refusal of an unknown sku, with billsvc\'s own wording', async () => {
    await expect(createStoreOrder(matchBase, ada, 'bp.does-not-exist', 'dev')).rejects.toThrow('unknown sku');
    await expect(createStoreOrder(matchBase, ada, 'bp.cannon', 'nintendo')).rejects.toThrow('unknown platform');
  });

  it('runs a whole purchase with no merchant account: create → dev webhook → settled', async () => {
    const { order, payment } = await createStoreOrder(matchBase, ada, 'bp.cannon', 'dev');
    expect(order.state).toBe('created');
    expect(order.amountCents).toBe(1800);
    // The dev stub is the only `configured` platform in this project (design/19 §9).
    expect(payment.configured).toBe(true);
    expect(payment.params.receipt).toBe('product:bp.cannon');

    expect((await fetchStoreOrder(matchBase, ada, order.id)).state).toBe('created');

    // "Payment": the platform callback, which is the ONLY thing that can settle an order —
    // posted to billsvc directly, because that is where a real platform would post it.
    const hook = await fetch(`${billBase}/webhook/dev`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ orderId: order.id, receipt: payment.params.receipt, txnId: `txn-${order.id}` }),
    });
    expect(hook.status).toBe(200);

    // And the client's own poll, through the proxy, sees it.
    const settled = await fetchStoreOrder(matchBase, ada, order.id);
    expect(settled.state).toBe('settled');
    expect(settled.sku).toBe('bp.cannon');
    // Still narrowed after settlement — the ownership check is on the route, not on the state.
    await expect(fetchStoreOrder(matchBase, bob, order.id)).rejects.toThrow('not found');
  });

  it('a preflight for POST /store/order allows the authorization header', async () => {
    // The design/16 bug, on the newest route group: without `authorization` in the allow list
    // a browser rejects the real request before sending it, and node's fetch never notices.
    const res = await fetch(`${matchBase}/store/order`, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://b.gamestao.com',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,content-type',
      },
    });
    expect(res.status).toBe(204);
    const allow = (res.headers.get('access-control-allow-headers') ?? '').toLowerCase();
    expect(allow).toContain('authorization');
    expect(allow).toContain('content-type');
    // The INTERNAL key is not advertised to browsers on this port either — a player's client
    // has no business presenting one, and listing it would invite the attempt.
    expect(allow).not.toContain('x-internal-key');
  });

  it('answers 502, not 500 and not 200, once the billing plane is gone', async () => {
    // Last, because it takes billsvc down for good.
    await shutdown(billsvc);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await fetch(`${matchBase}/store/skus`, { headers: { authorization: `Bearer ${ada}` } });
    expect(res.status).toBe(502);
    expect((await res.json()) as { error: string }).toEqual({ error: 'store temporarily unavailable' });
    // The control plane itself is untouched — matchmaking does not go down with the store.
    expect((await fetch(`${matchBase}/health`)).status).toBe(200);
    warn.mockRestore();
  });
});
