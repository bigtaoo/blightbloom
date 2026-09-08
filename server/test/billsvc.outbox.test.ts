/**
 * `billsvc/outbox.ts` — the DURABLE half of design/19 §4's closed delivery loop, driven
 * through the real `BillingService` rather than by calling `grant` by hand wherever that is
 * possible. The seam's entire claim is about what happens INSIDE the settlement transaction,
 * and a test that inserts rows itself would be pinning SQL rather than that claim.
 *
 * The three cases worth reading first:
 *
 *   'rolls the deliveries row back with the settlement' is the one that makes the outbox
 *   worth having. If a delivery row could survive a failed settlement, the pump would later
 *   grant an entitlement for a payment that was rolled back — strictly worse than the
 *   ledger-only default it replaced.
 *
 *   'writes ONE row across five redeliveries' is the at-least-once contract at this layer.
 *
 *   'survives the process that wrote it' is the only reason this table exists at all, and
 *   the one property `:memory:` cannot show: the row is written by one connection to a real
 *   file, that connection is closed, and a second one finds the obligation still pending.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openBillingDb } from '../src/billingDb';
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

let db: DatabaseSync;
let ids = 0;
let clock = 1_000;
const tmpDirs: string[] = [];

beforeEach(() => {
  db = openBillingDb(':memory:');
  ids = 0;
  clock = 1_000;
});

afterEach(() => {
  db.close();
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function service(over: { deliver?: EntitlementDelivery; on?: DatabaseSync } = {}): BillingService {
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
  const created = svc.createOrder({ accountId, sku, platform: 'dev' });
  if (!created.ok) throw new Error(created.error);
  const settled = await svc.settle({ platform: 'dev', orderId: created.order.id, receipt: `product:${sku}`, txnId });
  if (!settled.ok) throw new Error(settled.reason);
  return { orderId: created.order.id, ledgerId: `purchase:dev:${txnId}` };
}

const countRows = (target: DatabaseSync, table: string): number =>
  (target.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

describe('createOutboxDelivery', () => {
  it('writes one pending row keyed on the LEDGER id, inside the settlement transaction', async () => {
    const svc = service();
    const { orderId, ledgerId } = await purchase(svc, 'a1', 'T1');

    const row = deliveryById(db, ledgerId);
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
    const ledger = svc.ledgerFor('a1');
    expect(ledger.map((l) => l.id)).toEqual([ledgerId]);
  });

  it('freezes the SKU catalogue grants onto the row rather than a reference to it', async () => {
    // A SKU edited between the payment and a retried delivery must deliver what was PAID
    // for. The row therefore carries the pairs, not the sku to look them up by later.
    const svc = service();
    const { ledgerId } = await purchase(svc, 'a1', 'T1');
    expect(JSON.parse(deliveryById(db, ledgerId)!.grantsJson)).toEqual([{ kind: 'blueprint', id: 'cannon' }]);
  });

  it('rolls the deliveries row back with the settlement when the grant throws', async () => {
    // The four-table rollback design/19 §4 rests on, now that there are four tables. A
    // delivery row surviving a failed settlement would be worse than no outbox at all: the
    // pump would later grant an entitlement for money that was never taken.
    const outbox = createOutboxDelivery(db);
    const svc = service({
      deliver: {
        grant(request) {
          outbox.grant(request); // the real insert lands...
          throw new Error('the control plane is on fire'); // ...and then the transaction dies
        },
      },
    });
    const created = svc.createOrder({ accountId: 'a1', sku: SKU, platform: 'dev' });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const settled = await svc.settle({
      platform: 'dev',
      orderId: created.order.id,
      receipt: `product:${SKU}`,
      txnId: 'T1',
    });

    expect(settled).toMatchObject({ ok: false, code: 'delivery-failed' });
    expect(countRows(db, 'deliveries')).toBe(0);
    expect(countRows(db, 'receipts')).toBe(0);
    expect(countRows(db, 'ledger')).toBe(0);
    expect(svc.getOrder(created.order.id)).toMatchObject({ state: 'created', platformTxnId: null });
  });

  it('leaves the connection usable after that rollback, so the platform retry can succeed', async () => {
    // Half of what "rolls back" has to mean. A transaction left open (or a connection left
    // wedged) would make the retry fail for a reason unrelated to the first failure — and
    // the platform's retry is the entire recovery path for a refused settlement.
    let explode = true;
    const outbox = createOutboxDelivery(db);
    const svc = service({
      deliver: {
        grant(request) {
          outbox.grant(request);
          if (explode) throw new Error('transient');
        },
      },
    });
    const created = svc.createOrder({ accountId: 'a1', sku: SKU, platform: 'dev' });
    if (!created.ok) throw new Error(created.error);
    const input = { platform: 'dev' as const, orderId: created.order.id, receipt: `product:${SKU}`, txnId: 'T1' };
    expect(await svc.settle(input)).toMatchObject({ ok: false });

    explode = false;
    expect(await svc.settle(input)).toMatchObject({ ok: true, delivered: true });
    expect(countRows(db, 'deliveries')).toBe(1);
    expect(deliveryById(db, 'purchase:dev:T1')).toMatchObject({ state: 'pending' });
  });

  it('writes ONE row across five redeliveries of the same callback', async () => {
    const svc = service();
    const created = svc.createOrder({ accountId: 'a1', sku: SKU, platform: 'dev' });
    if (!created.ok) throw new Error(created.error);
    for (let i = 0; i < 5; i++) {
      await svc.settle({ platform: 'dev', orderId: created.order.id, receipt: `product:${SKU}`, txnId: 'T1' });
    }
    expect(countRows(db, 'deliveries')).toBe(1);
  });

  it('keeps the FIRST row when `grant` is called twice with the same ledger id directly', () => {
    // Unreachable through `settle` (the ledger claim refuses the second call two statements
    // earlier), and reachable through this seam, which is public. The answer has to be the
    // first row: it is the one the money was taken against.
    const outbox = createOutboxDelivery(db);
    const base = {
      ledgerId: 'purchase:dev:T1',
      accountId: 'a1',
      sku: SKU,
      grants: [{ kind: 'blueprint' as const, id: 'cannon' }],
      orderId: 'o1',
      receiptId: 'dev:r1',
      ts: 5,
    };
    outbox.grant(base);
    outbox.grant({ ...base, accountId: 'SOMEONE-ELSE', orderId: 'o2', ts: 99 });

    expect(countRows(db, 'deliveries')).toBe(1);
    expect(deliveryById(db, 'purchase:dev:T1')).toMatchObject({ accountId: 'a1', orderId: 'o1', createdAt: 5 });
  });

  it('survives the process that wrote it — a pending row is still owed by the next connection', async () => {
    // The ONLY reason this table exists. Everything else here could be done with a variable;
    // this cannot, and `:memory:` cannot show it.
    const dir = mkdtempSync(join(tmpdir(), 'bb-outbox-'));
    tmpDirs.push(dir);
    const path = join(dir, 'billing.db');

    const first = openBillingDb(path);
    const { ledgerId } = await purchase(service({ on: first }), 'a1', 'T1');
    expect(deliveryById(first, ledgerId)).toMatchObject({ state: 'pending' });
    first.close(); // the process dies between the COMMIT and the delivery

    const second = openBillingDb(path);
    expect(pendingDeliveries(second, 10).map((r) => r.id)).toEqual([ledgerId]);
    second.close();
  });
});

describe('the outbox table reads and writes', () => {
  const insert = (id: string, createdAt: number, state = 'pending'): void => {
    db.prepare(
      `INSERT INTO deliveries (id, account_id, sku, grants_json, order_id, receipt_id, state, attempts, created_at, delivered_at)
       VALUES (?, 'a1', 'bp.cannon', '[]', 'o1', 'dev:r1', ?, 0, ?, NULL)`,
    ).run(id, state, createdAt);
  };

  it('returns pending rows oldest first, and never a settled one', () => {
    insert('c', 30);
    insert('a', 10);
    insert('b', 20);
    insert('done', 5, 'delivered');
    insert('dead', 1, 'failed');
    expect(pendingDeliveries(db, 10).map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('breaks a same-millisecond tie by id, so a batch is deterministic', () => {
    insert('z', 10);
    insert('y', 10);
    expect(pendingDeliveries(db, 10).map((r) => r.id)).toEqual(['y', 'z']);
  });

  it('honours the batch limit', () => {
    for (let i = 0; i < 5; i++) insert(`d${i}`, i);
    expect(pendingDeliveries(db, 2).map((r) => r.id)).toEqual(['d0', 'd1']);
  });

  it('counts attempts cumulatively', () => {
    insert('a', 1);
    countAttempt(db, 'a');
    countAttempt(db, 'a');
    expect(deliveryById(db, 'a')!.attempts).toBe(2);
  });

  it('marks delivered with a timestamp, and marks failed WITHOUT one', () => {
    insert('ok', 1);
    insert('no', 2);
    markDelivered(db, 'ok', 777);
    markFailed(db, 'no');
    expect(deliveryById(db, 'ok')).toMatchObject({ state: 'delivered', deliveredAt: 777 });
    // `delivered_at` means "when this landed". A failed row landed nowhere, and reusing the
    // column to mean "when we gave up" would make the audit query lie.
    expect(deliveryById(db, 'no')).toMatchObject({ state: 'failed', deliveredAt: null });
  });

  it('will not rewrite a row that is no longer pending', () => {
    // The same claim-shape the rest of this plane uses instead of a look-before-write: two
    // pumps racing, or a pump overlapping an operator's manual fix, must not move a terminal
    // row back or restamp it.
    insert('a', 1);
    markDelivered(db, 'a', 100);
    markDelivered(db, 'a', 200);
    markFailed(db, 'a');
    expect(deliveryById(db, 'a')).toMatchObject({ state: 'delivered', deliveredAt: 100 });
  });

  it('answers null for a delivery that does not exist', () => {
    expect(deliveryById(db, 'nope')).toBeNull();
  });

  it('refuses a state the pump has no branch for', () => {
    // A CHECK rather than a convention: `state` drives which rows are retried, so a typo'd
    // hand-fix that invented `'retry'` would make a row invisible to the pump forever.
    expect(() => insert('weird', 1, 'retry')).toThrow(/CHECK constraint failed/);
  });
});
