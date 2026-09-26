# Work log — 2026-09-26

Volume 98. See [`design/ROADMAP.md`](../ROADMAP.md) for the index and the phase spine.

## The Paddle adapter, written and tested but not live (2026-09-26, server + test + docs, no engine change)

Step 4's payments item: ROADMAP 9.1–9.3, landed the way 9.4 says it must be without credentials.
Each piece is the real call it would make, tested against fixtures, failing closed rather than
throwing, and reported as unverified. The owner's refund decision from the plan (*revoke the
entitlement and send the case to manual review; leave ladder history alone*) is built in. The full
account is in `design/19-server-platform.md` §9, "What shipped on 2026-09-26". This volume is the
index entry.

### 9.1 — the signed webhook

- **`billsvc/paddle/signature.ts`**, pure. It computes HMAC-SHA256 over `${ts}:${rawBody}`,
  accepts any matching `h1` (secret rotation) and compares in constant time. A malformed header
  is a refusal, never a throw.
- **The 5 s tolerance each way is Paddle's documented default.** A refused webhook is re-sent
  with a fresh signature, so clock drift shows up as log lines naming the skew rather than as a
  lost payment.
- **The raw body.** The helpers moved into `billsvc/http.ts`: `readRaw` hands over the exact
  bytes, and `readJson` is built on it. `POST /webhook/paddle` is routed before the generic
  webhook and never parses before verifying.
- **Order of checks.**
  - With no secret the answer is 503, one error line and nothing recorded. Paddle retries, so a
    purchase made meanwhile settles once the secret is set.
  - A bad signature gets 401 and no event row, so knowing the public URL does not buy writes.
  - Everything after that is recorded, keyed by Paddle's `event_id`.
- **`BillingService.settleSigned`** is 8.3 AMENDMENT 1's relaxation: it trusts the signed
  transaction id and keeps both existing claims, so a retry is a replay, not a second delivery.

### 9.2 — the price rule

- `SkuDef.paddlePriceId` exists but is unset everywhere. `BB_PADDLE_PRICE_IDS` (`sku=pri_…`)
  overrides it, because sandbox and live ids differ. An unknown price id is refused, and one
  mapped to two SKUs is dropped from both.
- What Paddle charged is recorded on the order and never compared at settlement.
  Reconciliation reports an amount or currency difference as `amount-mismatch`: a finding, never
  a rejection.
- `iap/paddle.ts` is a real paged `GET /transactions` lister, tested with a fake fetch. It
  refuses without `BB_PADDLE_API_KEY`.

### 9.3 — refunds

- **What revokes.** Only an approved `adjustment.created`/`.updated` whose action is `refund` or
  `chargeback`. Pending, rejected, `chargeback_warning` and `credit` are recorded and not acted
  on. A `chargeback_reverse` files a review case and re-grants nothing.
- **How it revokes.** One transaction claims an append-only `reversal:paddle:<txn>` ledger row,
  queues a revoke outbox row, and files a `refund` review case with the money joined.
- **What it touches.** The pump calls a new `POST /internal/entitlements/revoke`, which deletes
  only an entitlement held BECAUSE of that order (`EntitlementService.revokePurchase`). So a
  character also owned as a drop (the claim route from [volume 97](97-2026-09-26-backlog-close-juggernaut.md))
  survives. A refused revocation files `revocation-failed`. Ladder history is untouched.

### Numbers

Server tests 2127 → 2231 on the branch (the Paddle work alone), coverage 98.81% lines / 98.18%
branches. The signature test vector is **self-computed** with `node:crypto` from the documented
algorithm, because Paddle publishes an example header but no secret/body pair behind it. The test
header says so.

### Still owner-only

- Paddle Products/Prices and their ids.
- The notification destination and its secret.
- The API key.
- A public Caddy route to billsvc's `/webhook/paddle` (billsvc is internal-only today).
- The first real sandbox purchase and refund.

On the engineering side, the client still sells through its stub path and has no Paddle.js
checkout. And until the SKU table's placeholder prices match Paddle's, every Paddle order will
reconcile as `amount-mismatch`, correctly and noisily.
