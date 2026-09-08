/**
 * "Money taken, nothing granted" reaches the review queue (design/19 §7, ROADMAP 8.5) —
 * the consumer ROADMAP 8.7 left without one.
 *
 * 8.7 made a 4xx from the control plane TERMINAL and logged it as an error naming the account,
 * because money moved and nothing was granted and only a human can fix that. The log line was
 * the whole disposition: no owner, no second reader, gone on the next rotation. It is the only
 * class in Phase 8 where a player paid and received nothing, so it is the one that most needed
 * somewhere to go.
 *
 * The two cases here are the pump's two terminal paths — a deliberate refusal and an outbox row
 * that can never be read — plus the three properties that make the queue worth having:
 * atomicity with the state change, idempotency across sweeps, and the fact that a RETRYABLE
 * failure files nothing (the row is still owed, and filing it would tell a human to hand-grant
 * a purchase the next sweep is about to deliver).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { openBillingDb } from '../src/billingDb';
import { BillingService } from '../src/billsvc/BillingService';
import { createReceiptVerifier } from '../src/billsvc/iap/factory';
import { createOutboxDelivery, deliveryById } from '../src/billsvc/outbox';
import { DeliveryPump } from '../src/billsvc/deliveryPump';
import { moneyTakenId, openReviews, reviewById } from '../src/billsvc/reviewQueue';

const SKU = 'bp.cannon';
const STUB = createReceiptVerifier({ BB_BILLING_DEV_STUB: '1' });

let db: DatabaseSync;
let clock = 1_000;
let ids = 0;

beforeEach(() => {
  db = openBillingDb(':memory:');
  clock = 1_000;
  ids = 0;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});

/** Settle one purchase through the real path, leaving a pending outbox row. Returns its id. */
async function purchase(sku = SKU, accountId = 'acc-1'): Promise<{ deliveryId: string; orderId: string }> {
  const svc = new BillingService({
    db,
    verify: STUB,
    deliver: createOutboxDelivery(db),
    nowMs: () => clock,
    newOrderId: () => `o-${++ids}`,
  });
  const created = svc.createOrder({ accountId, sku, platform: 'dev' });
  if (!created.ok) throw new Error(created.error);
  const res = await svc.settle({
    platform: 'dev',
    orderId: created.order.id,
    receipt: `product:${sku}`,
    txnId: `txn-${ids}`,
  });
  if (!res.ok || !res.delivered) throw new Error('settlement did not deliver');
  return { deliveryId: `purchase:dev:txn-${ids}`, orderId: created.order.id };
}

function pump(status: number): DeliveryPump {
  return new DeliveryPump({
    db,
    matchsvcUrl: 'http://control.invalid',
    nowMs: () => clock,
    retry: { attempts: 1 },
    sleep: async () => {},
    fetchImpl: async () => new Response(JSON.stringify({ error: 'no such account' }), { status }),
  });
}

describe('a control-plane 4xx files the account for review', () => {
  it('makes the row terminal AND files it, with the evidence a human needs', async () => {
    const { deliveryId, orderId } = await purchase();
    clock = 5_000;
    const result = await pump(400).pumpOnce();
    expect(result.failed).toBe(1);
    expect(deliveryById(db, deliveryId)!.state).toBe('failed');

    const entry = reviewById(db, moneyTakenId(deliveryId))!;
    expect(entry.kind).toBe('money-taken-nothing-granted');
    expect(entry.accountId).toBe('acc-1');
    // No day key: this is an event, not a day's worth of behaviour.
    expect(entry.dayKey).toBeNull();
    expect(entry.state).toBe('open');
    expect(entry.createdAt).toBe(5_000);
    expect(entry.summary).toContain('REFUSED');
    expect(entry.summary).toContain('400');
    expect(entry.summary).toContain('has NOTHING');
    const evidence = entry.evidence as Record<string, unknown>;
    expect(evidence.cause).toBe('control-plane-refused');
    expect(evidence.status).toBe(400);
    expect(evidence.deliveryId).toBe(deliveryId);
    expect(evidence.orderId).toBe(orderId);
    expect(evidence.sku).toBe(SKU);
    // The receipt is on there too: it is what a manual grant has to be justified against.
    expect(evidence.receiptId).toBe(`dev:product:${SKU}`);
  });

  it('files for a 401 and a 404 too — any deliberate refusal', async () => {
    // 401 is the interesting one: it means this process's internal key is wrong, so EVERY
    // delivery is about to go terminal, and the queue is where that becomes visible as a list
    // of affected accounts rather than a wall of identical log lines.
    for (const status of [401, 404, 422]) {
      db.exec('DELETE FROM review_queue; DELETE FROM deliveries; DELETE FROM ledger; DELETE FROM receipts; DELETE FROM orders');
      ids = 0;
      const { deliveryId } = await purchase();
      await pump(status).pumpOnce();
      expect(reviewById(db, moneyTakenId(deliveryId))?.evidence).toMatchObject({ status });
    }
  });

  it('a RETRYABLE failure files nothing — the row is still owed', async () => {
    // The distinction with teeth. A 5xx leaves the delivery pending forever precisely because a
    // peer that comes back heals it; telling a human to hand-grant it would produce a duplicate
    // the moment the peer returns.
    const { deliveryId } = await purchase();
    const result = await pump(503).pumpOnce();
    expect(result.deferred).toBe(1);
    expect(result.failed).toBe(0);
    expect(deliveryById(db, deliveryId)!.state).toBe('pending');
    expect(openReviews(db)).toEqual([]);
  });

  it('a refused connection files nothing either', async () => {
    const { deliveryId } = await purchase();
    const p = new DeliveryPump({
      db,
      matchsvcUrl: 'http://control.invalid',
      retry: { attempts: 1 },
      sleep: async () => {},
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    expect((await p.pumpOnce()).deferred).toBe(1);
    expect(deliveryById(db, deliveryId)!.state).toBe('pending');
    expect(openReviews(db)).toEqual([]);
  });

  it('a SUCCESSFUL delivery files nothing', async () => {
    const { deliveryId } = await purchase();
    const p = new DeliveryPump({
      db,
      matchsvcUrl: 'http://control.invalid',
      retry: { attempts: 1 },
      fetchImpl: async () => new Response('{}', { status: 200 }),
    });
    expect((await p.pumpOnce()).delivered).toBe(1);
    expect(deliveryById(db, deliveryId)!.state).toBe('delivered');
    expect(openReviews(db)).toEqual([]);
  });
});

describe('an unreadable outbox row files the account for review', () => {
  it('is the same fact and lands in the same queue', async () => {
    // A hand-edited `grants_json` — the sqlite3-prompt posture design/19 §8 plans for. The
    // money moved, the row can never be delivered, and it is terminal for the same reason the
    // 4xx is: re-reading the same bytes cannot make them parse.
    const { deliveryId } = await purchase();
    db.prepare('UPDATE deliveries SET grants_json = ? WHERE id = ?').run('{not json', deliveryId);
    clock = 6_000;
    const result = await pump(200).pumpOnce();

    expect(result.failed).toBe(1);
    expect(deliveryById(db, deliveryId)!.state).toBe('failed');
    const entry = reviewById(db, moneyTakenId(deliveryId))!;
    expect(entry.kind).toBe('money-taken-nothing-granted');
    expect((entry.evidence as { cause: string }).cause).toBe('unreadable-grants');
    // The unreadable bytes themselves, so a human can reconstruct what was owed.
    expect((entry.evidence as { grantsJson: string }).grantsJson).toBe('{not json');
    expect(entry.summary).toContain('unreadable grants_json');
  });

  it('never made the HTTP call at all', async () => {
    const { deliveryId } = await purchase();
    db.prepare('UPDATE deliveries SET grants_json = ? WHERE id = ?').run('"not an array"', deliveryId);
    let calls = 0;
    const p = new DeliveryPump({
      db,
      matchsvcUrl: 'http://control.invalid',
      retry: { attempts: 1 },
      fetchImpl: async () => {
        calls += 1;
        return new Response('{}', { status: 200 });
      },
    });
    await p.pumpOnce();
    expect(calls).toBe(0);
    expect(reviewById(db, moneyTakenId(deliveryId))).not.toBeNull();
  });
});

describe('the properties that make the queue worth having', () => {
  it('the state change and the filing are ONE transaction', async () => {
    // A crash between them would leave a terminal row nobody is ever told about — strictly the
    // worst outcome available, worse than either failure alone. Forced here by making the
    // filing throw: if the two were separate statements, the row would already be `failed`.
    const { deliveryId } = await purchase();
    const p = pump(400);
    // A row already claiming the review id makes the second INSERT... no — `fileReview` is
    // `ON CONFLICT DO NOTHING` and cannot throw on a duplicate. Break the CHECK instead, by
    // dropping the table the filing needs.
    db.exec('DROP TABLE review_queue');
    await expect(p.pumpOnce()).rejects.toThrow();
    // Rolled back together: the delivery is still owed, so the next sweep (against a repaired
    // database) retries it rather than leaving it terminal and unreported.
    expect(deliveryById(db, deliveryId)!.state).toBe('pending');
  });

  it('re-sweeping an already-terminal row cannot file a second entry', async () => {
    // Belt and braces: `pendingDeliveries` will not return a `failed` row, so this is really
    // about the id. It is the delivery's own id, which is the ledger row's already-won claim —
    // so a duplicate is impossible without a second idempotency mechanism.
    const { deliveryId } = await purchase();
    await pump(400).pumpOnce();
    // Put it back to pending, as an operator retrying by hand would, and refuse it again.
    db.prepare(`UPDATE deliveries SET state = 'pending' WHERE id = ?`).run(deliveryId);
    clock = 9_000;
    await pump(400).pumpOnce();

    expect(openReviews(db)).toHaveLength(1);
    expect(reviewById(db, moneyTakenId(deliveryId))!.createdAt).toBe(1_000);
  });

  it('two refused accounts are two entries, each naming its own account', async () => {
    await purchase(SKU, 'acc-1');
    await purchase('bp.seeker', 'acc-2');
    const result = await pump(400).pumpOnce();
    expect(result.failed).toBe(2);
    const entries = openReviews(db);
    expect(entries.map((e) => e.accountId).sort()).toEqual(['acc-1', 'acc-2']);
    expect(entries.every((e) => e.kind === 'money-taken-nothing-granted')).toBe(true);
  });

  it('still logs the error line — the queue is for the person who works it, the log for the deploy', async () => {
    const { deliveryId } = await purchase();
    await pump(400).pumpOnce();
    expect(console.error).toHaveBeenCalledTimes(1);
    expect(vi.mocked(console.error).mock.calls[0]![0]).toContain(deliveryId);
    expect(vi.mocked(console.error).mock.calls[0]![0]).toContain('filed for review');
  });
});
