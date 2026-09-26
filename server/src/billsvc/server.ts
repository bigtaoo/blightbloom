/**
 * billsvc's HTTP surface (design/19-server-platform.md §4/§5) — the billing plane, a
 * third process on `BILL_PORT` (default 8789), deliberately not folded into the control
 * plane: matchsvc restarts on a matchmaking cadence, and platform callbacks need a stable
 * entry point, pinned credentials and an audit boundary.
 *
 * The ONLY file in this package that touches `node:http`, exactly as `matchsvc.ts` is for
 * the control plane and `index.ts` for the data plane. `createBillsvcServer` builds the
 * server WITHOUT starting it — the seam that makes real requests testable on an ephemeral
 * port — and `main.ts` is the CLI entry point.
 *
 *   GET  /health                                            → { ok, service }
 *   GET  /skus                                              → { skus }                       (public)
 *   POST /order/create   { accountId, sku, platform }        → { order, payment } | 400 | 401 (internal)
 *   GET  /order/:id                                         → { order } | 404 | 401          (internal)
 *   POST /webhook/paddle  <raw Paddle event, Paddle-Signature header>
 *                                                           → 200 | 400 | 401 | 404 | 503    (Paddle-signed, ROADMAP 9.1)
 *   POST /webhook/:platform { orderId, receipt, txnId, event? }
 *                                                           → { delivered } | 400 | 404      (platform-signed)
 *
 * WHO MAY CALL WHAT. Every route except the webhook is behind the internal-key guard: a
 * player's client never talks to this port, it asks the control plane, which forwards with
 * its internal key. `/skus` is the exception in the other direction — a price list is
 * public by definition and holding it behind a key buys nothing.
 *
 * The webhook is NOT internal-key authenticated, by design (§3: "authenticated by the
 * platform's own signature instead"). No platform credential exists in this project (§9),
 * so today the only thing standing between that route and the database is receipt
 * verification — which is precisely why `iap/factory.ts` fails closed on missing
 * credentials, and why a `product:` receipt is inert unless the dev stub is enabled.
 *
 * `POST /order/create` DROPS `amount`. Reading the field and ignoring it would be the same
 * behaviour; not reading it is the version that survives someone adding a "pass-through"
 * later (design/19 §4: "An `amount` in the request body is discarded").
 *
 * DELIVERY (design/19 §4's closed loop, 2026-09-05). This is where the two halves are wired:
 * `outbox.ts`'s delivery is what `BillingService` calls inside the settlement transaction,
 * and `deliveryPump.ts` is what drains the row it wrote into the control plane's
 * `entitlements` table afterwards. The webhook triggers a sweep opportunistically after a
 * settlement commits, WITHOUT awaiting it — the platform's callback must answer fast and
 * must not be coupled to a peer that may be down, and the settlement is already durable by
 * then. `main.ts` arms the startup sweep and the backstop interval.
 *
 * EVERY WEBHOOK EVENT IS LOGGED (design/19 §7, ROADMAP 8.5, `webhookLog.ts`). Every branch of
 * the webhook route below writes one `webhook_events` row before it answers — the settlement,
 * the replay, the cancel, the refusal, the unrecognised event type, and the body that was not
 * even JSON. Before that, only a callback that settled left any trace at all, and "why did my
 * payment not go through" had no evidence behind it. The recording is deliberately in the
 * ROUTE rather than in `BillingService`: several of those branches never reach `settle`, and a
 * log that covered only the ones that did would miss exactly the cases it exists for.
 *
 * AN UNKNOWN EVENT TYPE IS RECORDED AND NOT ACTED ON. It used to fall through into `settle`,
 * which meant a platform sending `refunded` or `chargeback` would have had it treated as a
 * purchase callback. Now `webhookEventType` narrows to a known set and anything else answers
 * 200 with `ignored: true` — 200 rather than 4xx because a platform retrying an event this
 * server has simply not implemented is noise, and the row is where anyone finds out it
 * started arriving.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Db } from 'mongodb';
import { BillingService, type BillingServiceDeps, type SettleResult } from './BillingService';
import {
  controlPlaneUrl,
  INTERNAL_CALLER_BILLSVC,
  INTERNAL_CALLER_MATCHSVC,
  internalKeys,
  sharedInternalKey,
} from '../config';
import { createInternalVerifier, describeInternalAuthFailure, type InternalVerifier } from '../internalAuth';
import { createBillingAdapters, devStubEnabled, type BillingEnv } from './iap/factory';
import { asIapPlatform, type PlatformOrderLister, type ReceiptVerifier } from './iap/types';
import type { DevStubOrderBook } from './iap/devStub';
import type { EntitlementDelivery } from './delivery';
import { createOutboxDelivery } from './outbox';
import { DeliveryPump, type DeliveryPumpDeps } from './deliveryPump';
import { recordWebhookEvent, webhookEventType, type WebhookOutcome } from './webhookLog';
import { gauge, processMetrics, renderMetrics, METRICS_CONTENT_TYPE, type Metric } from '../metrics';
import { pendingDeliveries } from './outbox';
import { readJson, readRaw, send } from './http';
import { readPaddleConfig } from './paddle/config';
import { handlePaddleWebhook, PADDLE_WEBHOOK_PATH } from './paddle/webhook';

/**
 * What billsvc calls the process on the other end of an internal call, for audit lines.
 * The control plane is the only one: a player's client never reaches this port, it asks
 * matchsvc, which forwards with its internal key.
 *
 * An ALIAS of `config.ts`'s `INTERNAL_CALLER_MATCHSVC` rather than a second literal, since
 * ROADMAP 8.8 gave matchsvc an outbound caller name of its own: the two constants label the
 * same hop from its two ends, and two hand-kept copies of one caller name is exactly the
 * drift that makes an audit line say something false.
 */
export const INTERNAL_CALLER_CONTROL_PLANE = INTERNAL_CALLER_MATCHSVC;

export interface BillsvcServerOptions {
  /**
   * The billing logical database (`mongo.ts`'s `billing` store), injected rather than
   * derived. REQUIRED, and it replaced the old `dbPath`/optional-`db` pair on purpose: a
   * builder that could open its own connection would be a second place the four-store split
   * is decided, and there is no `':memory:'` to fall back on. `ensureBillingIndexes` must
   * have run against it — `main.ts` does that at boot, a test does it in its setup.
   */
  db: Db;
  /** Environment the credential/stub policy is read from. Defaults to `process.env`. */
  env?: BillingEnv;
  /** Receipt verifier override. Defaults to `createReceiptVerifier(env)`. */
  verify?: ReceiptVerifier;
  /**
   * Entitlement delivery, called inside the settlement transaction (`delivery.ts`).
   * Defaults to `outbox.ts`'s — the shipped one, which writes the `deliveries` row the pump
   * below drains. Overriding it (with `ledgerOnlyDelivery`, or a spy) also disconnects the
   * pump from anything to do, since nothing else writes that table.
   */
  deliver?: EntitlementDelivery;
  /**
   * Delivery-pump overrides, merged over the `config.ts`-derived defaults. A test pins
   * `fetchImpl`/`nowMs`/`sleep` here rather than stubbing globals; the URL and the internal
   * key default to `controlPlaneUrl()` and `sharedInternalKey()`.
   *
   * The pump is BUILT here and never STARTED here: `createBillsvcServer` binds no port
   * either, and a builder that armed a background interval could not be called by a test
   * without leaving one running. `main.ts` starts it.
   */
  pump?: Partial<DeliveryPumpDeps>;
  /**
   * A pre-built `BillingService`, replacing everything above it. The routes are a thin
   * shell over this object, so this is the only seam from which a test can make a
   * settlement REJECT rather than resolve — the case the webhook's last-resort `.catch`
   * exists for, and which no `verify`/`deliver` override can produce now that `settle`
   * swallows both. Same reason `matchsvc.ts` injects `spawnBot`.
   */
  billing?: BillingService;
  /**
   * Internal-key verifier override. OPTIONAL, and the default is not "no auth" — it is
   * `internalAuth`'s verifier over `config.ts`'s env-derived registry, the same default
   * `routes/rating.ts` takes. The seam exists so a test can pin a registry without touching
   * `process.env`.
   */
  internalAuth?: InternalVerifier;
  nowMs?: BillingServiceDeps['nowMs'];
  newOrderId?: BillingServiceDeps['newOrderId'];
}

export interface BillsvcServer {
  server: Server;
  billing: BillingService;
  db: Db;
  /** The outbox drain (`deliveryPump.ts`). Built, not started — see `BillsvcServerOptions.pump`. */
  pump: DeliveryPump;
  /**
   * The reconciliation port (`reconcile.ts`, design/19 §7). Returned rather than mounted on a
   * route: reconciliation is a daily job, not a request, and `server/scripts/reconcile.ts` is
   * its entry point. Exposed here so a same-process caller reconciles through the SAME
   * adapters — and therefore the same credential reads and the same dev order book — that the
   * webhook verifies through.
   */
  listOrders: PlatformOrderLister;
  /**
   * The dev platform's authored order book, or `undefined` whenever the stub is off (always,
   * in production). In-memory and per-process: a script in another process has its own, which
   * is why `DevStubOrderBook.fromJson` exists.
   */
  devOrderBook?: DevStubOrderBook;
}

/**
 * What only billsvc knows, and both gauges answer a question an operator has actually had.
 *
 * `outbox_pending` is the one to watch: a purchase is settled here and DELIVERED to the
 * control plane asynchronously (design/19 §4), so a pending count that stops falling means
 * players have paid for things they do not own — invisible in every container metric,
 * because nothing is failing, and it is exactly the state the delivery pump exists to drain.
 *
 * `dev_stub` is a 0/1 posture gauge rather than a log line, because "is the billing plane
 * still pretending?" is a question asked months after the log that answered it rotated away.
 */
export async function billsvcMetrics(db: Db, devStubOn: boolean): Promise<Metric[]> {
  return [
    ...processMetrics('billsvc'),
    gauge(
      'bb_billsvc_outbox_pending',
      'Settled purchases not yet delivered to the control plane. A count that stops falling means paid-for entitlements are not being granted.',
      // Bounded rather than a count over the whole collection: this is a scrape every 30s
      // against a live store, and the interesting reading is "is it draining", which a
      // ceiling does not hide.
      (await pendingDeliveries(db, 1000)).length,
    ),
    gauge('bb_billsvc_dev_stub', 'One while the dev receipt stub is enabled — no real money can move.', devStubOn ? 1 : 0),
  ];
}

export function createBillsvcServer(opts: BillsvcServerOptions): BillsvcServer {
  const env = opts.env ?? process.env;
  const db = opts.db;
  // Shared with `BillingService` below on purpose: a webhook event stamped from one clock and
  // the order it settled stamped from another is the kind of thing that only shows up when
  // somebody is reading the two tables side by side to answer a support question.
  const now = opts.nowMs ?? (() => Date.now());
  // ONE adapter set over one environment, so the verifier and the reconciliation lister cannot
  // disagree about which platforms are configured or share a dev order book with nobody.
  const adapters = createBillingAdapters(env);
  // Paddle's secret and price table, read by the SAME function the lister reads through.
  // A refused `BB_PADDLE_PRICE_IDS` entry is an error at boot, not at the first purchase.
  const paddle = readPaddleConfig(env);
  for (const problem of paddle.priceErrors) console.error(`[blightbloom] billsvc: ${problem}`);
  const billing =
    opts.billing ??
    new BillingService({
      db,
      verify: opts.verify ?? adapters.verify,
      // The OUTBOX, not `BillingService`'s own `ledgerOnlyDelivery` default (design/19 §4's
      // closed loop). One synchronous insert into a fourth table in this same file, inside
      // the settlement transaction; `pump` below is what turns it into an `entitlements`
      // row in the control plane's file afterwards.
      deliver: opts.deliver ?? createOutboxDelivery(db),
      nowMs: now,
      newOrderId: opts.newOrderId,
      devStubOn: devStubEnabled(env),
      paddlePrices: paddle.prices,
    });
  const pump = new DeliveryPump({
    matchsvcUrl: controlPlaneUrl(),
    internalKey: sharedInternalKey(),
    caller: INTERNAL_CALLER_BILLSVC,
    ...opts.pump,
    // Last, and not overridable: the pump drains THIS process's outbox, and a test that
    // pointed it at another connection would be exercising nothing that ships.
    db,
  });
  // ROADMAP 8.1's shared verifier (`server/src/internalAuth.ts`), not a billsvc-local check:
  // one namespace, one fail-closed posture, one place to add per-caller keys. `config.ts`'s
  // registry names its single entry `gameserver` because that was the first hop to need a
  // key; the caller that reaches BILLSVC is the control plane, so the label is corrected
  // here rather than left to say something false in an audit line. Splitting the shared
  // secret into a key per caller is the growth path that registry already anticipates —
  // when it happens, this relabel is what gets deleted.
  const internalAuth =
    opts.internalAuth ??
    createInternalVerifier(internalKeys().registry.map((entry) => ({ ...entry, caller: INTERNAL_CALLER_CONTROL_PLANE })));

  /** Verifies an internal call, logging the rejection and telling the caller only "unauthorized". */
  const refuseUnlessInternal = (req: IncomingMessage, res: ServerResponse, route: string): boolean => {
    const auth = internalAuth.verify(req.headers);
    if (auth.ok) return false;
    // The reason (and the caller's own advisory, untrusted claim) goes to the operator, not
    // into the response — design/19 §7's "log every event, not just the successful one".
    console.warn(describeInternalAuthFailure(auth, route));
    send(res, 401, { error: 'unauthorized' });
    return true;
  };

  const server = createServer((req, res) => {
    if (req.method === 'OPTIONS') return send(res, 204, {});
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

    if (req.method === 'GET' && url.pathname === '/health') {
      return send(res, 200, { ok: true, service: 'daydayup-billsvc' });
    }

    // Never proxied — billsvc is reachable only from matchsvc over the internal network
    // (server/deploy/README.md), so this needs no gate of its own.
    if (req.method === 'GET' && url.pathname === '/metrics') {
      return void billsvcMetrics(db, devStubEnabled(env))
        .then((metrics) => {
          res.writeHead(200, { 'content-type': METRICS_CONTENT_TYPE });
          res.end(renderMetrics(metrics));
        })
        // A scrape that cannot read the store answers 500 rather than hanging: Prometheus
        // records the failure, where a lost promise would leave the scrape to time out and
        // look identical to the process being gone.
        .catch((e: unknown) => send(res, 500, { error: (e as Error).message }));
    }

    if (req.method === 'GET' && url.pathname === '/skus') {
      return send(res, 200, { skus: billing.listSkus() });
    }

    if (req.method === 'POST' && url.pathname === '/order/create') {
      if (refuseUnlessInternal(req, res, 'POST /order/create')) return;
      return readJson(req, res, async (body) => {
        const b = (body ?? {}) as { accountId?: unknown; sku?: unknown; platform?: unknown };
        // `amount` is not read. See the file header.
        const result = await billing.createOrder({ accountId: b.accountId, sku: b.sku, platform: b.platform });
        if (!result.ok) return send(res, 400, { error: result.error });
        send(res, 200, { order: result.order, payment: result.payment });
      });
    }

    const orderLookup = url.pathname.match(/^\/order\/([^/]+)$/);
    if (req.method === 'GET' && orderLookup) {
      if (refuseUnlessInternal(req, res, 'GET /order/:id')) return;
      return void billing
        .getOrder(decodeURIComponent(orderLookup[1]!))
        .then((order) => (order ? send(res, 200, { order }) : send(res, 404, { error: 'not found' })))
        .catch((e: unknown) => send(res, 500, { error: (e as Error).message }));
    }

    // Paddle BEFORE the generic webhook, and on the RAW reader: its signature is over the
    // exact bytes, so this path must never go through `readJson` (design/19 §9, item 2).
    if (req.method === 'POST' && url.pathname === PADDLE_WEBHOOK_PATH) {
      return readRaw(req, res, async (raw) => {
        const reply = await handlePaddleWebhook(
          { db, billing, config: paddle, now, schedule: () => pump.schedule() },
          req.headers,
          raw,
        );
        send(res, reply.status, reply.body);
      });
    }

    const webhook = url.pathname.match(/^\/webhook\/([^/]+)$/);
    if (req.method === 'POST' && webhook) {
      const platform = asIapPlatform(decodeURIComponent(webhook[1]!));
      // Not logged: `webhook_events.platform` would have nothing real to hold, and an unknown
      // path segment is a routing miss rather than a payment event. Recording it would also
      // let anyone with the public webhook URL write rows into an evidence table.
      if (!platform) return send(res, 404, { error: 'unknown platform' });
      return readJson(req, res, async (body, raw) => {
        const b = (body ?? {}) as { orderId?: unknown; receipt?: unknown; txnId?: unknown; event?: unknown };
        const orderId = typeof b.orderId === 'string' ? b.orderId : '';
        const txnId = typeof b.txnId === 'string' ? b.txnId : '';
        const eventType = webhookEventType(b.event);

        /**
         * Record what this callback said and what was decided about it.
         *
         * AWAITED before the response goes out, which is new in the MongoDB port. The write
         * used to be synchronous, so "recorded, then answered" was the only possible order.
         * Now it is a promise, and answering first would let a platform's redelivery (which
         * arrives the moment the first response lands) race the first callback's own row —
         * turning `seenCount` and `divergences`, the two fields an operator reads to spot a
         * forgery, into a function of network timing. The cost is one round trip on a path
         * that has already done several.
         */
        const logged = (outcome: WebhookOutcome, detail: string | null): Promise<string> =>
          recordWebhookEvent(db, { platform, orderId, txnId, eventType, outcome, detail, raw, ts: now() });

        // An event type this plane does not implement. RECORDED AND NOT ACTED ON — see the
        // file header. It used to fall through into `settle`, so a `refunded` callback would
        // have been treated as a purchase.
        if (eventType === 'unknown') {
          await logged('ignored', `unrecognised event type ${JSON.stringify(b.event)}`);
          return send(res, 200, { ok: true, ignored: true, event: b.event });
        }

        // A failure/cancel callback closes the order and grants nothing. Handled here
        // rather than inside `settle` because it has no receipt to verify — treating it as
        // a settlement with a missing receipt would report it as a verification failure,
        // which is a different (and alarming) thing from "the player cancelled".
        if (eventType === 'failed' || eventType === 'cancelled') {
          if (!orderId) {
            await logged('rejected', 'orderId required');
            return send(res, 400, { error: 'orderId required' });
          }
          const marked = await billing.markFailed({ orderId });
          if (!marked.ok) {
            await logged('rejected', `no order '${orderId}'`);
            return send(res, 404, { error: 'not found' });
          }
          // `changed: false` is a redelivery of a cancel this server already applied, which is
          // a different fact from having just closed the order and is recorded as one.
          await logged(marked.changed ? 'marked-failed' : 'no-change', null);
          return send(res, 200, { ok: true, state: 'failed', changed: marked.changed });
        }

        // `settle` is written to be total — it catches a throwing verifier and a throwing
        // delivery — so this try exists for the case it was written to make impossible, and
        // for the event write beside it. Without it the rejection reaches `readJson`'s net,
        // which answers but records nothing; the whole point of ROADMAP 8.5's log is that a
        // callback which went wrong leaves evidence.
        let result: SettleResult;
        try {
          result = await billing.settle({
            platform,
            orderId,
            receipt: typeof b.receipt === 'string' ? b.receipt : '',
            txnId,
          });
        } catch (e) {
          // Itself guarded: a throwing log here would be the one path that leaves the
          // platform with no response at all — the exact failure this catch exists to
          // prevent.
          try {
            await logged('rejected', `internal: ${(e as Error).message}`);
          } catch {
            /* the response matters more than the row */
          }
          return send(res, 500, { error: (e as Error).message, code: 'internal' });
        }
        if (result.ok) {
          await logged(result.delivered ? 'settled' : 'already-delivered', result.note ?? null);
          // TRIGGER 1 (`deliveryPump.ts`): advance the outbox now rather than at the
          // next interval, so the entitlement lands while the player is still looking at
          // the payment sheet. Deliberately NOT awaited and deliberately not part of
          // this response — the settlement is already committed and durable, and making
          // the platform's webhook wait on the control plane would couple a callback
          // that must answer fast to a peer that may be down. `pumpOnce` never rejects
          // (every failure is a stored state plus a log), so `schedule()` cannot produce
          // an unhandled rejection here.
          if (result.delivered) pump.schedule();
          return send(res, 200, {
            ok: true,
            orderId: result.orderId,
            sku: result.sku,
            delivered: result.delivered,
            note: result.note,
          });
        }
        // A rejection is a 4xx so the platform's retry stops on a permanent refusal and an
        // operator sees it. Which codes a specific platform wants folded into a 200 to stop
        // ITS retry loop is a per-platform question and is still not guessed at here — but
        // the refusal is now EVIDENCE rather than a dropped branch, which is what ROADMAP
        // 8.5's event log was wanted for: this row and its `detail` are the whole answer to
        // "why did my payment not go through".
        await logged('rejected', `${result.code}: ${result.reason}`);
        send(res, result.code === 'unknown-order' ? 404 : 400, { error: result.reason, code: result.code });
      });
    }

    send(res, 404, { error: 'not found' });
  });

  return { server, billing, db, pump, listOrders: adapters.listOrders, devOrderBook: adapters.devOrderBook };
}
