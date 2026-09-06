/**
 * Split of the delivery seam (2026-09-05): the ASYNC half of the closed entitlement loop —
 * it drains `outbox.ts`'s `deliveries` table into the control plane's `entitlements` table
 * over ROADMAP 8.1's internal seam. `outbox.ts` owns the durable half.
 *
 * This is the only place in the billing plane that makes an outbound network call, and it
 * sits strictly OUTSIDE the settlement transaction. That placement is the whole design:
 * an HTTP call from inside `BEGIN IMMEDIATE` would hold SQLite's write lock across a round
 * trip (serialising every settlement behind the slowest control-plane response) and would
 * still not be atomic with the remote write, so it would buy the cost of the tear without
 * removing it.
 *
 * Pure of env and globals, the same way `internalAuth.ts` and `ticket.ts` are: the URL, the
 * key, the clock, `fetch` and `sleep` all arrive through `deps`, so every branch below runs
 * with no server, no network and no timers. `server.ts` is where `config.ts` is read.
 *
 * WHEN IT RUNS, and why it is not just an interval. Three triggers, in the order they
 * matter:
 *
 *   1. OPPORTUNISTICALLY, right after a settlement commits (`server.ts`'s webhook). This is
 *      the one that delivers a purchase in the sub-second a player is still looking at the
 *      payment sheet; the other two exist for when it fails.
 *   2. ONCE AT STARTUP (`main.ts`). This is the only reason the table exists — a process
 *      that died between the COMMIT and the delivery must resume, and nothing else will
 *      re-trigger those rows.
 *   3. A BOUNDED INTERVAL as the backstop, for a control plane that was down when 1 and 2
 *      ran and came back later.
 *
 * An interval alone would be simpler and is the wrong shape for this repo: it makes every
 * purchase wait a tick for no reason, and it makes the delivery latency a function of a
 * tuning constant instead of of the settlement. A queue process is the other direction and
 * is the thing design/19 §8 declines to build — "no infrastructure the team does not need
 * yet". Opportunistic-plus-backstop is what that principle looks like when the work is
 * genuinely asynchronous.
 *
 * FAILURE POLICY, which is where the branches are:
 *
 *   4xx  the control plane refused on purpose — an unknown account, a malformed body, a
 *        rejected key. Repeating it verbatim cannot change the answer, so the row goes
 *        TERMINAL (`failed`) and is logged as an error. Money taken, nothing granted: this
 *        is a human's problem now, and saying so loudly beats retrying forever in silence.
 *   5xx, the peer is broken, unreachable or restarting. The row stays `pending` and is
 *   net, retried on the next sweep, forever. Giving up would lose a purchase; a peer that
 *   timeout comes back heals every stuck row at once. `attempts` is what an operator
 *        alerts on.
 *
 * `internalFetch`'s own bounded retry runs INSIDE one sweep (three attempts, backing off),
 * so a one-second blip never reaches the table at all; the sweep-level retry above is for
 * outages longer than that.
 *
 * WHERE A TERMINAL ROW GOES (design/19 §7, ROADMAP 8.5). Both terminal paths below — the 4xx
 * and the unreadable `grants_json` — are the same fact: MONEY WAS TAKEN AND NOTHING WAS
 * GRANTED. It is the only class in Phase 8 where that is true, and until 8.5 it existed
 * ONLY as a `console.error`: no owner, no second reader, and gone on the next log rotation.
 * `retire` now files it into `reviewQueue.ts` in the SAME transaction that makes the row
 * terminal, so the two cannot come apart — a crash between them would otherwise leave a
 * `failed` row nobody is ever told about, which is strictly the worst outcome available. The
 * error line stays: a queue row is for the person who works the queue, a log line is for the
 * person watching the deploy.
 */
import type { DatabaseSync } from 'node:sqlite';
import { internalFetch, type InternalFetchResult, type RetryPolicy } from '../internalFetch';
import type { SkuGrant } from './skus';
import { countAttempt, markDelivered, markFailed, pendingDeliveries, type DeliveryRecord } from './outbox';
import { fileReview, moneyTakenId } from './reviewQueue';

/** The control-plane route this pump POSTs to (`server/src/routes/internalEntitlements.ts`). */
export const GRANT_PATH = '/internal/entitlements/grant';

/** What one sweep did. Every field is a branch with its own test. */
export interface PumpResult {
  /** Rows read as `pending` and actually attempted. */
  attempted: number;
  /** Rows the control plane accepted — now `delivered`. */
  delivered: number;
  /** Rows the control plane refused on purpose — now `failed`, terminal, and logged. */
  failed: number;
  /** Rows left `pending` for a later sweep (5xx, timeout, connection refused). */
  deferred: number;
}

export interface DeliveryPumpDeps {
  db: DatabaseSync;
  /** Control-plane base URL, e.g. `http://localhost:8788`. `GRANT_PATH` is appended. */
  matchsvcUrl: string;
  /** The `x-internal-key` this process presents. `undefined` sends no header, and the peer
   * rejects the call with a logged reason — the visible outcome, not a silent one. */
  internalKey?: string;
  /** The advisory `x-internal-caller` the peer records in its audit line. */
  caller?: string;
  /** Rows per sweep. Bounded so one sweep cannot hold the loop for an unbounded time. */
  batchSize?: number;
  /** The backstop interval `start()` arms. */
  intervalMs?: number;
  nowMs?: () => number;
  /** Per-attempt retry INSIDE one sweep, on top of the sweep-level retry. */
  retry?: RetryPolicy;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}

export const DEFAULT_BATCH_SIZE = 32;
/** 60 s. Only ever the BACKSTOP — the opportunistic trigger is what a player experiences. */
export const DEFAULT_INTERVAL_MS = 60_000;
/** Three attempts inside one sweep, so a restarting peer costs no table churn at all. */
const DEFAULT_RETRY: RetryPolicy = { attempts: 3 };

/** The body `POST /internal/entitlements/grant` expects. Named so both sides can import it. */
export interface GrantDeliveryBody {
  /** The `deliveries`/`ledger` id. Advisory on the receiving side: it is logged, never
   * used as an idempotency key, because the receiver has a better one of its own
   * (`entitlements`' UNIQUE(account_id, sku)) that does not depend on the caller. */
  deliveryId: string;
  accountId: string;
  /** The billsvc SKU. Advisory too — the entitlement skus come from `grants`. */
  sku: string;
  /** REQUIRED by the receiver: `entitlements`' CHECK refuses a purchase with no order. */
  orderId: string;
  grants: SkuGrant[];
  ts: number;
}

/**
 * Parse the frozen grant list off a row. Returns `null` for anything that is not an array
 * of objects, which is unreachable through `createOutboxDelivery` and reachable through an
 * operator editing the table by hand — the posture design/19 §7 explicitly plans for, since
 * this project has no admin service and corrections happen at a `sqlite3` prompt.
 *
 * A corrupt row is TERMINAL rather than retried: re-reading the same bytes cannot make them
 * parse, and a row that fails forever in silence is worse than one an operator is told
 * about.
 */
export function parseGrants(grantsJson: string): SkuGrant[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(grantsJson);
  } catch {
    return null;
  }
  return Array.isArray(parsed) ? (parsed as SkuGrant[]) : null;
}

/**
 * Drains `deliveries`. Owns no state beyond its own scheduling latch — everything durable
 * is in the table, which is what lets a restarted process pick up exactly where this one
 * stopped.
 */
export class DeliveryPump {
  private readonly db: DatabaseSync;
  private readonly url: string;
  private readonly now: () => number;
  private readonly batchSize: number;
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Set by `schedule()`; consumed by the loop in it. See that method for why both exist. */
  private queued = false;
  private inFlight: Promise<void> | null = null;

  constructor(private readonly deps: DeliveryPumpDeps) {
    this.db = deps.db;
    this.url = `${deps.matchsvcUrl.replace(/\/+$/, '')}${GRANT_PATH}`;
    this.now = deps.nowMs ?? (() => Date.now());
    this.batchSize = deps.batchSize ?? DEFAULT_BATCH_SIZE;
    this.intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
  }

  /**
   * One sweep, awaited. This is what every test drives; the two schedulers below only
   * decide WHEN it runs.
   *
   * Rows are attempted in sequence rather than in parallel. The volume is one request per
   * purchase, and a serial sweep means a control plane that is struggling sees one call at a
   * time instead of a batch-sized burst from a peer that is, by construction, retrying.
   */
  async pumpOnce(): Promise<PumpResult> {
    const rows = pendingDeliveries(this.db, this.batchSize);
    const result: PumpResult = { attempted: 0, delivered: 0, failed: 0, deferred: 0 };
    for (const row of rows) {
      result.attempted += 1;
      const grants = parseGrants(row.grantsJson);
      if (grants === null) {
        this.retire(
          row,
          `delivery '${row.id}' has unreadable grants_json and can never be delivered`,
          { cause: 'unreadable-grants', grantsJson: row.grantsJson, attempts: row.attempts },
        );
        result.failed += 1;
        console.error(
          `[blightbloom] billsvc: delivery '${row.id}' has unreadable grants_json and can never be delivered — ` +
            `account '${row.accountId}' paid for '${row.sku}' (order '${row.orderId}') and has NOTHING. ` +
            'Needs a manual grant; filed for review.',
        );
        continue;
      }
      // Before the call, not after it: a crash mid-attempt still leaves the count behind.
      countAttempt(this.db, row.id);
      const outcome = await this.post(row, grants);
      if (outcome.ok) {
        markDelivered(this.db, row.id, this.now());
        result.delivered += 1;
        continue;
      }
      // A 4xx is the peer refusing on purpose. `internalFetch` has already decided this is
      // not retryable and stopped its own ladder; repeating it from here would only be
      // slower about reaching the same answer.
      if (outcome.failure === 'http' && outcome.status !== undefined && outcome.status < 500) {
        this.retire(row, `the control plane REFUSED delivery '${row.id}' with ${outcome.status}`, {
          cause: 'control-plane-refused',
          status: outcome.status,
          error: outcome.error ?? null,
          attempts: row.attempts + 1,
        });
        result.failed += 1;
        console.error(
          `[blightbloom] billsvc: the control plane REFUSED delivery '${row.id}' with ${outcome.status} — ` +
            `account '${row.accountId}' paid for '${row.sku}' (order '${row.orderId}') and has NOTHING. ` +
            'Needs a manual grant; filed for review.',
        );
        continue;
      }
      result.deferred += 1;
      console.warn(
        `[blightbloom] billsvc: delivery '${row.id}' deferred after ${row.attempts + 1} attempt(s) — ` +
          `${outcome.failure}${outcome.status === undefined ? '' : ` ${outcome.status}`}` +
          `${outcome.error === undefined ? '' : ` (${outcome.error})`}. Still owed; will retry.`,
      );
    }
    return result;
  }

  /**
   * Make one row terminal AND file it for review, atomically.
   *
   * One `BEGIN IMMEDIATE` around both, because the pair is the whole point: a `failed` row is
   * money taken with nothing granted, and the only way out of it is a human. A crash between
   * `markFailed` and `fileReview` would leave a terminal row that no sweep will ever look at
   * again and that nobody was told about — the one outcome worse than either failure alone.
   * They are two tables in the SAME file (`billingDb.ts`), so one transaction covers them,
   * which is the same argument design/19 §4 makes for the settlement path.
   *
   * The review id is `money-taken-nothing-granted:<deliveryId>`, and the delivery id is
   * already the ledger row's own claimed id — so re-filing is impossible without a second
   * idempotency mechanism, exactly as the outbox row itself is. `fileReview`'s
   * `ON CONFLICT DO NOTHING` then makes a re-run of an already-terminal row a no-op rather
   * than a duplicate.
   */
  private retire(row: DeliveryRecord, summary: string, evidence: Record<string, unknown>): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      markFailed(this.db, row.id);
      fileReview(this.db, moneyTakenId(row.id), {
        kind: 'money-taken-nothing-granted',
        accountId: row.accountId,
        // No day key: this is an event, not a day's worth of behaviour.
        dayKey: null,
        summary:
          `${summary} — account '${row.accountId}' paid for '${row.sku}' (order '${row.orderId}') and has NOTHING`,
        evidence: {
          deliveryId: row.id,
          accountId: row.accountId,
          sku: row.sku,
          orderId: row.orderId,
          receiptId: row.receiptId,
          createdAt: row.createdAt,
          ...evidence,
        },
        ts: this.now(),
      });
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  private post(row: DeliveryRecord, grants: SkuGrant[]): Promise<InternalFetchResult> {
    const body: GrantDeliveryBody = {
      deliveryId: row.id,
      accountId: row.accountId,
      sku: row.sku,
      orderId: row.orderId,
      grants,
      ts: row.createdAt,
    };
    return internalFetch(this.url, {
      method: 'POST',
      json: body,
      internalKey: this.deps.internalKey,
      caller: this.deps.caller,
      timeoutMs: this.deps.timeoutMs,
      retry: this.deps.retry ?? DEFAULT_RETRY,
      fetchImpl: this.deps.fetchImpl,
      sleep: this.deps.sleep,
    });
  }

  /**
   * Fire-and-forget advance, for the opportunistic trigger. Never overlaps itself, and a
   * call arriving DURING a sweep queues exactly one more rather than being dropped — the
   * settlement that triggered it committed after the running sweep took its snapshot, so
   * without the queue its row would wait for the interval.
   *
   * Nothing between the `while` test and the `finally` awaits, so a `schedule()` can never
   * land in the gap and be lost.
   */
  schedule(): void {
    this.queued = true;
    if (this.inFlight) return;
    this.inFlight = (async () => {
      try {
        while (this.queued) {
          this.queued = false;
          await this.pumpOnce();
        }
      } finally {
        this.inFlight = null;
      }
    })();
  }

  /** Trigger 2 (the startup sweep) and trigger 3 (the backstop interval), together. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.schedule(), this.intervalMs);
    // The interval must not be the reason a process refuses to exit — the gameserver's
    // SIGTERM ordering in `index.ts` exists for exactly this class of leak. `unref` is
    // guarded because a fake timer (and a non-node runtime) does not provide it.
    this.timer.unref?.();
    this.schedule();
  }

  /** Clears the backstop and awaits whatever sweep is in flight, so a shutdown (or a test)
   * never leaves a half-finished delivery writing into a closed database. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.inFlight;
  }
}
