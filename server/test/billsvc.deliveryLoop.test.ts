/**
 * The CLOSED LOOP, end to end (design/19 §4, 2026-09-05): two real processes on two
 * ephemeral ports over two separate SQLite files, a real dev-stub purchase, a real internal
 * call between them, and a real `GET /account/meta` at the far end.
 *
 * Nothing here is stubbed but the receipt, and that one is `iap/factory.ts`'s own shipped
 * dev stub rather than a test double — design/19 §5 says the stub exists precisely so this
 * chain can be driven with no merchant account, and this is the test that proves the chain
 * still reaches an entitlement.
 *
 * Every layer below has its own unit tests. This file exists for the things that only exist
 * BETWEEN them, and that a green suite on both sides would not catch:
 *
 *   - The two database FILES really are separate, and the entitlement really does cross.
 *   - billsvc's outbound key is accepted by matchsvc's inbound verifier (they are derived
 *     by different functions from one env var, and a mismatch is invisible in either half).
 *   - The billsvc SKU (`bp.cannon`) becomes the ENTITLEMENT sku (`blueprint:cannon`). Two
 *     namespaces meet here and nowhere else.
 *   - A settlement whose delivery could not be made is still a settlement — the money is
 *     recorded, the obligation is durable, and a later sweep completes it.
 *   - That obligation survives the billsvc PROCESS, which is the only reason the outbox
 *     exists and the one thing no in-process test can show.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { createMatchsvcServer } from '../src/matchsvc';
import { createBillsvcServer, type BillsvcServer } from '../src/billsvc/server';
import { openBillingDb } from '../src/billingDb';
import { deliveryById, pendingDeliveries } from '../src/billsvc/outbox';

const KEY = 'loop-internal-key';
const SKU = 'bp.cannon';
const DEV_ENV = { BB_BILLING_DEV_STUB: '1', BB_INTERNAL_KEY: KEY };

let matchsvc: Server;
let matchUrl: string;
let bill: BillsvcServer | null = null;
let token: string;
let accountId: string;
const tmpDirs: string[] = [];

beforeEach(async () => {
  // Both halves read the SAME env var through DIFFERENT functions — matchsvc's inbound
  // registry via `internalKeys()`, billsvc's outbound key via `sharedInternalKey()`. Pinning
  // the env rather than injecting a verifier is what makes that agreement part of the test.
  vi.stubEnv('BB_INTERNAL_KEY', KEY);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});

  matchsvc = createMatchsvcServer({ dbPath: ':memory:', secret: 'loop-secret' });
  await new Promise<void>((resolve) => matchsvc.listen(0, '127.0.0.1', resolve));
  matchUrl = `http://127.0.0.1:${(matchsvc.address() as AddressInfo).port}`;
  vi.stubEnv('BB_MATCHSVC_URL', matchUrl);

  const registered = await fetch(`${matchUrl}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'buyer', password: 'correct horse battery' }),
  });
  ({ accountId, token } = (await registered.json()) as { accountId: string; token: string });
});

afterEach(async () => {
  if (bill) {
    await bill.pump.stop();
    bill.db.close();
    bill = null;
  }
  await new Promise<void>((resolve) => matchsvc.close(() => resolve()));
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

/** billsvc with everything defaulted from the env — the wiring `main.ts` gets. */
function startBillsvc(over: { db?: DatabaseSync; retryOnce?: boolean } = {}): BillsvcServer {
  return createBillsvcServer({
    db: over.db ?? openBillingDb(':memory:'),
    env: DEV_ENV,
    // Only the retry LADDER is pinned, and only where a case needs a failure to be quick:
    // the URL, the key and the caller label all come from `config.ts` as they do in
    // production, which is the point of this file.
    pump: over.retryOnce ? { retry: { attempts: 1 }, sleep: async () => {} } : {},
  });
}

/** Books an order on billsvc through its internal-key-guarded route. */
async function createOrder(baseUrl: string): Promise<{ orderId: string; receipt: string }> {
  const res = await fetch(`${baseUrl}/order/create`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-key': KEY },
    body: JSON.stringify({ accountId, sku: SKU, platform: 'dev' }),
  });
  const body = (await res.json()) as {
    order: { id: string };
    payment: { params: { receipt: string } };
  };
  return { orderId: body.order.id, receipt: body.payment.params.receipt };
}

/** The platform callback. Not internal-key authenticated, by design (§3). */
async function payWebhook(baseUrl: string, orderId: string, receipt: string, txnId: string): Promise<unknown> {
  const res = await fetch(`${baseUrl}/webhook/dev`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ orderId, receipt, txnId }),
  });
  return res.json();
}

async function ownedSkus(): Promise<{ sku: string; source: string }[]> {
  const res = await fetch(`${matchUrl}/account/meta`, { headers: { authorization: `Bearer ${token}` } });
  return ((await res.json()) as { entitlements: { sku: string; source: string }[] }).entitlements;
}

async function listen(handle: BillsvcServer): Promise<string> {
  await new Promise<void>((resolve) => handle.server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(handle.server.address() as AddressInfo).port}`;
}

describe('the entitlement delivery loop', () => {
  it('carries a dev-stub purchase all the way from a webhook to GET /account/meta', async () => {
    bill = startBillsvc();
    const billUrl = await listen(bill);

    expect(await ownedSkus()).toEqual([]);

    const { orderId, receipt } = await createOrder(billUrl);
    expect(await payWebhook(billUrl, orderId, receipt, 'TXN-1')).toMatchObject({ delivered: true });

    // The webhook fires the opportunistic sweep WITHOUT awaiting it (the platform's callback
    // must not wait on the control plane), so the test waits where the webhook deliberately
    // does not.
    await bill.pump.stop();

    expect(await ownedSkus()).toEqual([
      expect.objectContaining({ sku: 'blueprint:cannon', source: 'purchase' }),
    ]);
    // The billsvc SKU and the entitlement sku are DIFFERENT namespaces, and this hop is the
    // only place they meet.
    expect(deliveryById(bill.db, 'purchase:dev:TXN-1')).toMatchObject({ sku: SKU, state: 'delivered' });
  });

  it('keeps the money and the obligation when the control plane is DOWN, and delivers later', async () => {
    bill = startBillsvc({ retryOnce: true });
    const billUrl = await listen(bill);
    const { orderId, receipt } = await createOrder(billUrl);

    // The control plane disappears between the payment and the delivery — the exact tear
    // design/19 §4 could not close with a single transaction, because the far table is in
    // another file.
    await new Promise<void>((resolve) => matchsvc.close(() => resolve()));
    expect(await payWebhook(billUrl, orderId, receipt, 'TXN-1')).toMatchObject({ delivered: true });
    await bill.pump.stop();

    // The settlement STILL committed: the money moved and the ledger says so. What is
    // outstanding is the delivery, and it is outstanding durably rather than lost.
    expect(bill.billing.ledgerFor(accountId)).toHaveLength(1);
    expect(bill.billing.getOrder(orderId)).toMatchObject({ state: 'settled' });
    expect(deliveryById(bill.db, 'purchase:dev:TXN-1')).toMatchObject({ state: 'pending' });

    // The control plane comes back on the same port, and the backstop sweep finishes the job
    // with no second webhook and nothing else re-triggering it.
    const port = Number(new URL(matchUrl).port);
    matchsvc = createMatchsvcServer({ dbPath: ':memory:', secret: 'loop-secret' });
    await new Promise<void>((resolve) => matchsvc.listen(port, '127.0.0.1', resolve));
    const again = await fetch(`${matchUrl}/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'buyer', password: 'correct horse battery' }),
    });
    ({ accountId, token } = (await again.json()) as { accountId: string; token: string });
    // A fresh account id, so re-point the pending row at it the way a real restart never
    // would need to — the ROW is what is being tested, not the account.
    bill.db.prepare('UPDATE deliveries SET account_id = ?').run(accountId);

    expect(await bill.pump.pumpOnce()).toMatchObject({ attempted: 1, delivered: 1 });
    expect(await ownedSkus()).toEqual([
      expect.objectContaining({ sku: 'blueprint:cannon', source: 'purchase' }),
    ]);
  });

  it('resumes an owed delivery after the BILLSVC PROCESS restarts — the outbox\'s whole reason', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bb-loop-'));
    tmpDirs.push(dir);
    const path = join(dir, 'billing.db');

    // First process: takes the money with the control plane unreachable, then dies.
    const firstDb = openBillingDb(path);
    const first = createBillsvcServer({
      db: firstDb,
      env: DEV_ENV,
      pump: { matchsvcUrl: 'http://127.0.0.1:1', retry: { attempts: 1 }, sleep: async () => {} },
    });
    const firstUrl = await listen(first);
    const { orderId, receipt } = await createOrder(firstUrl);
    await payWebhook(firstUrl, orderId, receipt, 'TXN-1');
    await first.pump.stop();
    expect(deliveryById(firstDb, 'purchase:dev:TXN-1')).toMatchObject({ state: 'pending' });
    await new Promise<void>((resolve) => first.server.close(() => resolve()));
    firstDb.close();

    // Second process, same file, control plane back. Nothing re-sends the webhook and the
    // platform considers the payment done, so the STARTUP sweep is the only thing that can
    // deliver this — which is exactly what `main.ts` arms.
    bill = createBillsvcServer({ db: openBillingDb(path), env: DEV_ENV });
    expect(pendingDeliveries(bill.db, 10)).toHaveLength(1);
    expect(await bill.pump.pumpOnce()).toMatchObject({ attempted: 1, delivered: 1 });

    expect(await ownedSkus()).toEqual([
      expect.objectContaining({ sku: 'blueprint:cannon', source: 'purchase' }),
    ]);
    expect(deliveryById(bill.db, 'purchase:dev:TXN-1')).toMatchObject({ state: 'delivered' });
  });

  it('delivers ONCE across a redelivered webhook and a re-run sweep', async () => {
    // At-least-once from both ends at the same time: the platform re-posts its callback
    // (billsvc's two claims absorb it) and the pump re-runs after an ack it never saw
    // (`entitlements`' UNIQUE absorbs that one). Neither guard covers the other's case.
    bill = startBillsvc();
    const billUrl = await listen(bill);
    const { orderId, receipt } = await createOrder(billUrl);

    for (let i = 0; i < 3; i++) await payWebhook(billUrl, orderId, receipt, 'TXN-1');
    await bill.pump.stop();
    // Force the row back to pending, which is precisely what a lost ack looks like from
    // billsvc's side: the grant landed, the answer did not.
    bill.db.prepare("UPDATE deliveries SET state = 'pending'").run();
    expect(await bill.pump.pumpOnce()).toMatchObject({ delivered: 1 });

    expect(await ownedSkus()).toEqual([
      expect.objectContaining({ sku: 'blueprint:cannon', source: 'purchase' }),
    ]);
    expect(bill.billing.ledgerFor(accountId)).toHaveLength(1);
  });

  it('writes a purchase off loudly when the control plane refuses it for good', async () => {
    // An account billsvc believes in and the control plane does not — a 404, which the pump
    // reads as terminal. The money is still in the ledger and the failure is named, because
    // this is the state a human has to resolve.
    bill = startBillsvc({ retryOnce: true });
    const billUrl = await listen(bill);
    const res = await fetch(`${billUrl}/order/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-key': KEY },
      body: JSON.stringify({ accountId: 'ghost-account', sku: SKU, platform: 'dev' }),
    });
    const created = (await res.json()) as { order: { id: string }; payment: { params: { receipt: string } } };
    await payWebhook(billUrl, created.order.id, created.payment.params.receipt, 'TXN-1');
    await bill.pump.stop();

    expect(deliveryById(bill.db, 'purchase:dev:TXN-1')).toMatchObject({ state: 'failed', deliveredAt: null });
    expect(bill.billing.ledgerFor('ghost-account')).toHaveLength(1);
    const errors = vi.mocked(console.error).mock.calls.map((c) => String(c[0])).join('\n');
    expect(errors).toMatch(/REFUSED delivery 'purchase:dev:TXN-1' with 404/);
    expect(errors).toMatch(/Needs a manual grant/);
  });

  it('does not deliver anything for a webhook that settles nothing', async () => {
    // The opportunistic trigger is gated on an actual delivery. A redelivered callback that
    // reports `delivered: false` must not schedule a sweep for work that does not exist —
    // and, more importantly, a REFUSED settlement must not either.
    bill = startBillsvc();
    const billUrl = await listen(bill);
    const { orderId, receipt } = await createOrder(billUrl);
    expect(await payWebhook(billUrl, orderId, receipt, 'TXN-1')).toMatchObject({ delivered: true });
    await bill.pump.stop();

    const replay = await payWebhook(billUrl, orderId, receipt, 'TXN-1');
    expect(replay).toMatchObject({ delivered: false, note: 'already-delivered' });
    await bill.pump.stop();
    expect(pendingDeliveries(bill.db, 10)).toHaveLength(0);
    expect(await ownedSkus()).toHaveLength(1);
  });
});
