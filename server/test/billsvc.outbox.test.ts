/**
 * `billsvc/outbox.ts` — the DURABLE half of design/19 §4's closed delivery loop, driven
 * through the real `BillingService` rather than by calling `grant` by hand wherever that is
 * possible. The seam's entire claim is about what happens INSIDE the settlement transaction,
 * and a test that inserts documents itself would be pinning a query rather than that claim.
 *
 * The three cases worth reading first:
 *
 *   'rolls the deliveries document back with the settlement' is the one that makes the outbox
 *   worth having. If a delivery document could survive a failed settlement, the pump would
 *   later grant an entitlement for a payment that was rolled back — strictly worse than the
 *   ledger-only default it replaced.
 *
 *   'writes ONE document across five redeliveries' is the at-least-once contract at this
 *   layer.
 *
 *   'survives the process that wrote it' is the only reason this collection exists at all,
 *   and the one property an in-process handle cannot show: the document is written by one
 *   `MongoClient`, that client is closed, and a SECOND connection to the same database finds
 *   the obligation still pending.
 */
import { describe, it, expect, beforeEach, afterEach, inject } from 'vitest';
import { MongoClient, type ClientSession, type Db } from 'mongodb';
import { billingStore, ensureBillingIndexes } from '../src/billingDb';
import { openTestMongo, type MongoTestContext } from './mongoHarness';
import { BillingService } from '../src/billsvc/BillingService';
import { createReceiptVerifier } from '../src/billsvc/iap/factory';
import type { EntitlementDelivery } from '../src/billsvc/delivery';
import {
  countAttempt,
  createOutboxDelivery,
  deliveryById,
  markDelivered,
  markFailed,
  pendingDeliveries,
} from '../src/billsvc/outbox';

const SKU = 'bp.cannon';
const STUB = createReceiptVerifier({ BB_BILLING_DEV_STUB: '1' });

let ctx: MongoTestContext;
let db: Db;
let ids = 0;
let clock = 1_000;

beforeEach(async () => {
  ctx = await openTestMongo();
  db = ctx.db('billing');
  await ensureBillingIndexes(db);
  ids = 0;
  clock = 1_000;
});

afterEach(async () => {
  await ctx.dispose();
});

function service(over: { deliver?: EntitlementDelivery; on?: Db } = {}): BillingService {
  const target = over.on ?? db;
  return new BillingService({
    db: target,
    verify: STUB,
    deliver: over.deliver ?? createOutboxDelivery(target),
    devStubOn: true,
    nowMs: () => (clock += 10),
    newOrderId: () => `o${++ids}`,
  });
}

/** Books an order and settles it through the real dev-stub receipt path. */
async function purchase(
  svc: BillingService,
  accountId: string,
  txnId: string,
  sku = SKU,
): Promise<{ orderId: string; ledgerId: string }> {
  const created = await svc.createOrder({ accountId, sku, platform: 'dev' });
  if (!created.ok) throw new Error(created.error);
  const settled = await svc.settle({ platform: 'dev', orderId: created.order.id, receipt: `product:${sku}`, txnId });
  if (!settled.ok) throw new Error(settled.reason);
  return { orderId: created.order.id, ledgerId: `purchase:dev:${txnId}` };
}

const countRows = (target: Db, collection: 'orders' | 'receipts' | 'ledger' | 'deliveries'): Promise<number> =>
  billingStore(target)[collection].countDocuments();

describe('createOutboxDelivery', () => {
  it('writes one pending row keyed on the LEDGER id, inside the settlement transaction', async () => {
    const svc = service();
    const { orderId, ledgerId } = await purchase(svc, 'a1', 'T1');

    const row = await deliveryById(db, ledgerId);
    expect(row).toMatchObject({
      id: ledgerId,
      accountId: 'a1',
      sku: SKU,
      orderId,
      receiptId: `dev:product:${SKU}`,
      state: 'pending',
      attempts: 0,
      deliveredAt: null,
    });
    // The key is SHARED with the ledger row rather than minted — which is what makes
    // "money that never reached an account" one join rather than a reconciliation script.
    const ledger = await svc.ledgerFor('a1');
    expect(ledger.map((l) => l.id)).toEqual([ledgerId]);
  });

  it('freezes the SKU catalogue grants onto the row rather than a reference to it', async () => {
    // A SKU edited between the payment and a retried delivery must deliver what was PAID
    // for. The row therefore carries the pairs, not the sku to look them up by later.
    const svc = service();
    const { ledgerId } = await purchase(svc, 'a1', 'T1');
    expect(JSON.parse((await deliveryById(db, ledgerId))!.grantsJson)).toEqual([{ kind: 'blueprint', id: 'cannon' }]);
  });

  it('rolls the deliveries document back with the settlement when the grant throws', async () => {
    // The four-collection rollback design/19 §4 rests on. A delivery document surviving a
    // failed settlement would be worse than no outbox at all: the pump would later grant an
    // entitlement for money that was never taken.
    const outbox = createOutboxDelivery(db);
    const svc = service({
      deliver: {
        async grant(request) {
          await outbox.grant(request); // the real upsert lands, inside the session...
          throw new Error('the control plane is on fire'); // ...and then the transaction dies
        },
      },
    });
    const created = await svc.createOrder({ accountId: 'a1', sku: SKU, platform: 'dev' });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const settled = await svc.settle({
      platform: 'dev',
      orderId: created.order.id,
      receipt: `product:${SKU}`,
      txnId: 'T1',
    });

    expect(settled).toMatchObject({ ok: false, code: 'delivery-failed' });
    expect(await countRows(db, 'deliveries')).toBe(0);
    expect(await countRows(db, 'receipts')).toBe(0);
    expect(await countRows(db, 'ledger')).toBe(0);
    expect(await svc.getOrder(created.order.id)).toMatchObject({ state: 'created', platformTxnId: null });
  });

  it('leaves the connection usable after that rollback, so the platform retry can succeed', async () => {
    // Half of what "rolls back" has to mean. A transaction left open (or a connection left
    // wedged) would make the retry fail for a reason unrelated to the first failure — and
    // the platform's retry is the entire recovery path for a refused settlement.
    let explode = true;
    const outbox = createOutboxDelivery(db);
    const svc = service({
      deliver: {
        async grant(request) {
          await outbox.grant(request);
          if (explode) throw new Error('transient');
        },
      },
    });
    const created = await svc.createOrder({ accountId: 'a1', sku: SKU, platform: 'dev' });
    if (!created.ok) throw new Error(created.error);
    const input = { platform: 'dev' as const, orderId: created.order.id, receipt: `product:${SKU}`, txnId: 'T1' };
    expect(await svc.settle(input)).toMatchObject({ ok: false });

    explode = false;
    expect(await svc.settle(input)).toMatchObject({ ok: true, delivered: true });
    expect(await countRows(db, 'deliveries')).toBe(1);
    expect(await deliveryById(db, 'purchase:dev:T1')).toMatchObject({ state: 'pending' });
  });

  it('writes ONE document across five redeliveries of the same callback', async () => {
    const svc = service();
    const created = await svc.createOrder({ accountId: 'a1', sku: SKU, platform: 'dev' });
    if (!created.ok) throw new Error(created.error);
    for (let i = 0; i < 5; i++) {
      await svc.settle({ platform: 'dev', orderId: created.order.id, receipt: `product:${SKU}`, txnId: 'T1' });
    }
    expect(await countRows(db, 'deliveries')).toBe(1);
  });

  it('keeps the FIRST document when `grant` is called twice with the same ledger id directly', async () => {
    // Unreachable through `settle` (the ledger claim refuses the second call two statements
    // earlier), and reachable through this seam, which is public. The answer has to be the
    // first document: it is the one the money was taken against.
    //
    // A real session is started for it rather than a stand-in, because `session` is a
    // REQUIRED field of the request — the seam's way of making "this write belongs to the
    // caller's transaction" a type error to forget. One with no transaction open behaves like
    // a plain write, which is what a direct call to this seam is.
    const outbox = createOutboxDelivery(db);
    const session: ClientSession = db.client.startSession();
    const base = {
      ledgerId: 'purchase:dev:T1',
      accountId: 'a1',
      sku: SKU,
      grants: [{ kind: 'blueprint' as const, id: 'cannon' }],
      orderId: 'o1',
      receiptId: 'dev:r1',
      ts: 5,
      session,
    };
    await outbox.grant(base);
    await outbox.grant({ ...base, accountId: 'SOMEONE-ELSE', orderId: 'o2', ts: 99 });
    await session.endSession();

    expect(await countRows(db, 'deliveries')).toBe(1);
    expect(await deliveryById(db, 'purchase:dev:T1')).toMatchObject({
      accountId: 'a1',
      orderId: 'o1',
      createdAt: 5,
    });
  });

  it('survives the process that wrote it — a pending document is still owed by the next connection', async () => {
    // The ONLY reason this collection exists. Everything else here could be done with a
    // variable; this cannot, and an in-process handle cannot show it. The obligation is
    // written through the harness's client, then a SECOND, independent `MongoClient` connects
    // to the same database — the process dying between the commit and the delivery, and
    // coming back — and finds the delivery still owed.
    const { ledgerId } = await purchase(service(), 'a1', 'T1');
    expect(await deliveryById(db, ledgerId)).toMatchObject({ state: 'pending' });

    const reborn = await MongoClient.connect(inject('mongoUri'));
    try {
      const second = reborn.db(db.databaseName);
      expect((await pendingDeliveries(second, 10)).map((r) => r.id)).toEqual([ledgerId]);
    } finally {
      await reborn.close();
    }
  });
});

describe('the outbox collection reads and writes', () => {
  const insert = (id: string, createdAt: number, state = 'pending'): Promise<unknown> =>
    billingStore(db).deliveries.insertOne({
      _id: id,
      accountId: 'a1',
      sku: 'bp.cannon',
      grantsJson: '[]',
      orderId: 'o1',
      receiptId: 'dev:r1',
      state,
      attempts: 0,
      createdAt,
    });

  it('returns pending documents oldest first, and never a settled one', async () => {
    await insert('c', 30);
    await insert('a', 10);
    await insert('b', 20);
    await insert('done', 5, 'delivered');
    await insert('dead', 1, 'failed');
    expect((await pendingDeliveries(db, 10)).map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('breaks a same-millisecond tie by id, so a batch is deterministic', async () => {
    await insert('z', 10);
    await insert('y', 10);
    expect((await pendingDeliveries(db, 10)).map((r) => r.id)).toEqual(['y', 'z']);
  });

  it('honours the batch limit', async () => {
    for (let i = 0; i < 5; i++) await insert(`d${i}`, i);
    expect((await pendingDeliveries(db, 2)).map((r) => r.id)).toEqual(['d0', 'd1']);
  });

  it('counts attempts cumulatively', async () => {
    await insert('a', 1);
    await countAttempt(db, 'a');
    await countAttempt(db, 'a');
    expect((await deliveryById(db, 'a'))!.attempts).toBe(2);
  });

  it('marks delivered with a timestamp, and marks failed WITHOUT one', async () => {
    await insert('ok', 1);
    await insert('no', 2);
    await markDelivered(db, 'ok', 777);
    await markFailed(db, 'no');
    expect(await deliveryById(db, 'ok')).toMatchObject({ state: 'delivered', deliveredAt: 777 });
    // `deliveredAt` means "when this landed". A failed delivery landed nowhere, and reusing
    // the field to mean "when we gave up" would make the audit query lie. Absent on the
    // document, `null` at the boundary.
    expect(await deliveryById(db, 'no')).toMatchObject({ state: 'failed', deliveredAt: null });
  });

  it('will not rewrite a document that is no longer pending', async () => {
    // The same claim-shape the rest of this plane uses instead of a look-before-write: two
    // pumps racing, or a pump overlapping an operator's manual fix, must not move a terminal
    // document back or restamp it.
    await insert('a', 1);
    await markDelivered(db, 'a', 100);
    await markDelivered(db, 'a', 200);
    await markFailed(db, 'a');
    expect(await deliveryById(db, 'a')).toMatchObject({ state: 'delivered', deliveredAt: 100 });
  });

  it('answers null for a delivery that does not exist', async () => {
    expect(await deliveryById(db, 'nope')).toBeNull();
  });

  it('refuses a state the pump has no branch for', async () => {
    // The collection VALIDATOR rather than a convention: `state` drives which documents are
    // retried, so a typo'd hand-fix that invented `'retry'` would make a paid delivery
    // invisible to the pump forever.
    await expect(insert('weird', 1, 'retry')).rejects.toThrow(/failed validation/);
  });
});
