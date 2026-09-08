# Work log — 2026-09-05: the billing plane learns to leave evidence

Volume 35. ROADMAP 8.5 — the operational half of Phase 8, and the last item in it. Three concerns
that share nothing with each other except a posture: **record what happened, and tell a human;
never act.**

Landed the same day as [volume 31](31-2026-09-05-exactly-once-settlement.md),
[volume 32](32-2026-09-05-delivery-outbox.md), [volume 33](33-2026-09-05-ladder-mode-gate.md) and
[volume 34](34-2026-09-05-game-registry.md). Volume 32 is the one this builds on directly: it
created a class of record — "money taken, nothing granted" — that had nowhere to go.

Indexed from [`../ROADMAP.md`](../ROADMAP.md). Design account in
[`../19-server-platform.md`](../19-server-platform.md) §7, which is now SHIPPED with five
amendments.

## 1. Every webhook event, not just the successful one

### What was there

`POST /webhook/:platform` had three outcomes and left evidence for one of them. A settlement wrote
`orders` / `receipts` / `ledger` / `deliveries`; a `failed` or `cancelled` event closed the order
and wrote nothing; a refusal answered 400 and wrote nothing; a body that was not JSON was read as
`{}`, answered 400, and vanished — bytes and all.

That is funny's stated reason for shipping this table, and it reads the same here: "why did my
payment not go through" has **no evidence behind it at all**. There is no other source. The
platform's dashboard is not accessible from this project (no merchant account), and a log line is
gone on the next rotation.

### What it is now

`server/src/billsvc/webhookLog.ts`, a sibling module of free functions, and a fifth table in
billsvc's own file. Every branch of the route writes one row before it answers — settlement,
replay, cancel, refusal, unrecognised event type, unparsable body.

```
webhook_events(id, platform, order_id, txn_id, event_type, outcome, detail, raw,
               first_seen_at, last_seen_at, seen_count, divergences)
  id = `${txnId}:${eventType}`
```

Three things in that row are decisions rather than columns.

**`raw` is kept as FIRST written; `outcome` is overwritten with the LATEST.** Two different rules
on purpose. The body is evidence of what the platform sent, so a later call must not be able to
erase it. The outcome is what the account's state now reflects, so a stale one would mislead in
exactly the situation the row is read in.

**`divergences` counts redeliveries whose body CHANGED under the same key.** A platform retry
repeats itself byte for byte, so zero is the normal answer and a non-zero count is somebody varying
fields under a key they do not own — the forgery shape §4's AMENDMENT 1 already had to close on the
settlement path, observed from the other side. It costs one expression in the UPSERT:

```sql
divergences = divergences + (raw <> excluded.raw)
```

done in SQL rather than as a read-then-write, because this runs on the webhook path and a
look-before-write there is the one shape the rest of this plane avoids everywhere else.

**The key has two fallbacks, and they are not a detail.** A callback carrying no transaction id is
not an edge case to shrug at — it is precisely the malformed payload whose evidence is worth the
most, and a naive `${txnId}:${eventType}` collapses every one of them into a single `:purchase` row
that each new bad payload overwrites. So:

| body carries | key |
|---|---|
| a txn id | `txn-9:purchase` |
| only a merchant order id | `order:o-7:cancelled` |
| neither | `raw:<sha256[0:16]>:purchase` |

The hash is a legitimate key rather than a giving-up value: a platform retrying an unparsable body
repeats the same bytes, so the redelivery lands on its own row. Both halves are tested — two
different garbage bodies produce two rows, and a repeat of one produces `seen_count = 2`.

An oversized body (past the route's 256 KB cap) is recorded as
`<oversized body discarded: >N bytes>` rather than as a truncated prefix, because a prefix would
later read like the whole thing.

### The one behaviour change in the whole pass

An unrecognised `event` string used to fall through into `settle`. A platform that started sending
`refunded` or `chargeback` would have had it treated as a purchase callback — and with a valid
receipt, it would have **delivered**. `webhookEventType` now narrows to `purchase | failed |
cancelled | unknown`, and `unknown` is recorded with outcome `ignored` and answered **200**.

200 and not 4xx: a platform retrying an event this server has simply not implemented is noise, and
the row is where anyone finds out it started arriving. The test asserts both halves — the 200 with
`ignored: true`, and that the order is still `created` with an empty ledger.

## 2. Reconciliation, and refusing to pretend it ran

§4's closing paragraph names the one tear a single `BEGIN IMMEDIATE` cannot close: between the
**platform** and the local transaction. A payment that succeeded on the platform's side and whose
callback never arrived leaves *no local row at all*, so nothing inside this database can notice it.

### The honest scope problem

There is no merchant account on Apple, Google, WeChat or Stripe (§9), so there is no platform order
list to pull, and there will not be one until a product decision is made. Pretending otherwise
would be worse than not building this.

Handled the way ROADMAP 8.4 handled the identical problem for verification. "List the platform's
recent orders" is an injected port:

```ts
type PlatformOrderLister = (platform, sinceMs, untilMs) => Promise<PlatformOrderListing>;
type PlatformOrderListing = { ok: true; orders: PlatformOrder[] } | { ok: false; reason: string };
```

The four real adapters each grew the call they *would* make — `listAppleOrders`, `listGoogleOrders`,
`listWechatOrders`, `listStripeOrders` — with two outcomes each, both failures, neither throwing,
exactly like their `verify` siblings. Writing them down was worth more than expected: three of the
four are **not** a single fetch, and the file comments now say so. Apple's list call is
`notifications/history` signed with an ES256 JWT over an issuer id, key id and .p8 the project has
no env var for; Google's has no REST endpoint at all and needs Play's Real-time Developer
Notifications drained from Pub/Sub, or the financial-report CSVs; WeChat's is a gzipped daily bill
behind a signed download URL, keyed on whole Beijing-time days, so a sub-day window cannot be
answered exactly. Stripe's genuinely is one paged `GET /v1/checkout/sessions`, which makes it the
cheapest platform to prove the logic against the day a key exists.

### Two rules that make a green report mean something

**A refusal is a first-class field, not an absent difference.** `ReconcileReport.unreconciled`
lists every platform that could not be asked, `complete` is false whenever it is non-empty, and the
formatted first line says COMPLETE or INCOMPLETE **before** it says how many differences. A caller
reading only `differenceCount` is the misreading the whole module is shaped to prevent, and there
is a test asserting exactly the trap: `differenceCount === 0` **and** `complete === false`, at once.

**The dev platform's order book is authored, never derived.** `DevStubOrderBook` reads nothing from
billsvc's tables. A dev platform computed from local `orders` could only ever report zero
differences — a reconciliation that passes by construction, which is worse than none because it
looks like evidence. It is seeded from `BB_BILLING_DEV_ORDERS` (a JSON array), and
`fromJson` **throws** on a malformed entry rather than skipping it: a skipped row would surface as
a `local-not-on-platform` finding, inventing evidence out of a typo in the harness input.

Also: no book configured is a **refusal**, not an empty list. "Nobody configured a platform to
compare against" and "the platform charged nothing" are different facts and only one is evidence.
Same for the stub being off, and for production, where it is off unconditionally.

### The difference classes

Joined on `platform_txn_id`, over settled local orders windowed half-open on `settled_at`:

| kind | meaning |
|---|---|
| `local-not-on-platform` | settled here, absent there. The shape a forged callback leaves. |
| `platform-not-local` | charged there, nothing here. **The** tear §4 leaves open. |
| `sku-mismatch` | matched, different product. Rule 5 asked later, from the side rule 5 cannot see. |
| `amount-mismatch` | matched, different money. |

Two smaller decisions, both tested. A platform that reports **no** amount produces **no** amount
finding — WeChat's bill does not carry one on every row, and a reconciliation that always fires is
one nobody reads; silence is not agreement, but it is also not evidence. And the guard is
`!== undefined`, not truthiness, so a platform reporting **0** against a local 1800 is caught.

`accountId` on a `platform-not-local` finding is `null`, never guessed: the platform does not know
this server's account ids, and the order may not exist here at all — which is the finding.

## 3. The daily grant audit, and the queue it files into

§7: count non-`purchase` entitlement grants per account per day; anything over a threshold goes to
a review list. The principle it inherits is stated in §7 and already holds in
[`../15-pvp-arena.md`](../15-pvp-arena.md)'s checkpoint quorum:

> **With no evidence, skip — never convict.**

`design/15`'s mechanism runs no consensus check at all below a quorum of real seats, and severs a
seat only on a *consecutive* run of mismatches. Both halves carry over literally, and each is a
test:

- **Exactly at the threshold is not an anomaly.** `count > threshold`, never `>=`. The threshold is
  the largest count anyone has said is fine, so a count equal to it is a case somebody already
  accepted. Both sides of the boundary are pinned, and so is a threshold of 0.
- **A source the audit was not told to count is skipped.** `DEFAULT_COUNTED_SOURCES` is an explicit
  list, not "anything that is not `purchase`" — so a source a later migration adds to `db.ts`'s
  CHECK arrives *uncounted*, and whoever adds it decides. The alternative silently changes what
  this audit convicts on the day someone edits an unrelated file.
- **`purchase` is skipped because the money is the evidence.**
- **It files; it does not act.** Asserted against the real `entitlements` table: the rows are all
  still there afterwards, and `EntitlementService.revoke` still has no caller in this server.

### Where it lives, and why it opens two databases differently

`entitlements` is in the **control plane's** file, and §7 rules out an admin service — so this is a
standalone module (`server/src/grantAudit.ts`, pure) plus a script
(`server/scripts/grantAudit.ts`), and deliberately **not** a matchsvc route.

The script opens the account database **read-only** and the billing database read-write for the
queue alone. That is the "never act" posture made structural rather than commented: SQLite enforces
it; a comment would not.

`(accountId, dayKey)` in **UTC** is the idempotency key. UTC for a reason that is about the key
rather than about correctness — a local-time boundary would file a second row for the same grants
the first time cron ran from a differently-configured box. And the default window is whole days
**ending at the last UTC midnight**: today is excluded, because a partial day re-audited tomorrow
would find its key already taken and file nothing for the rows that arrived in between.

### The queue

```
review_queue(id, kind, account_id, day_key, summary, evidence_json, state,
             created_at, reviewed_at, note)
  kind: 'grant-anomaly' | 'money-taken-nothing-granted'
```

`ON CONFLICT DO NOTHING`, never an upsert: the first filing is the record. A re-run must not move
`created_at` (how long this has been waiting), must not reopen a row a human closed, and must not
overwrite the note they wrote on it. All three are tests. An audit an operator is afraid to re-run
is an audit that stops being run.

The `note` column is what stands in for the admin service §8 declines to build, and `evidence_json`
that will not parse reads back as `null` rather than throwing — this table is explicitly meant to
be corrected at a `sqlite3` prompt, so one typo must not make the whole queue unreadable.

## 4. The consumer volume 32 left behind

Volume 32 made a 4xx from the control plane **terminal** and logged it as an error naming the
account: money moved, nothing was granted, only a human can fix it. A `console.error` was its
entire disposition — no owner, no second reader, gone on the next rotation. It is the only class in
Phase 8 where a player paid and received nothing.

`deliveryPump.ts` now files it, and the shape matters more than the fact:

- **In the SAME transaction** that makes the delivery terminal. A crash between `markFailed` and
  the filing would leave a terminal row nobody is ever told about — worse than either failure
  alone. Two tables in one file, so one `BEGIN IMMEDIATE` covers them, which is the same argument
  §4 makes for the settlement path. The test forces it by dropping `review_queue` and asserting the
  delivery is *still pending* afterwards.
- **Both terminal paths file**, not just the 4xx: an outbox row whose `grants_json` can never be
  read is the same fact, and that path never even makes the HTTP call.
- **A retryable failure files nothing.** The distinction with teeth. A 5xx row is still owed and a
  peer that comes back heals it, so filing it would tell a human to hand-grant a purchase the next
  sweep is about to deliver. Tested for 503 and for a refused connection.
- **The id is the delivery's id**, which is already the ledger row's won claim — so a duplicate is
  impossible without a second idempotency mechanism, exactly as the outbox row itself is.
- **The log line stays.** A queue row is for the person who works the queue; a log line is for the
  person watching the deploy.

## Shape and numbers

Three concerns, three sibling files, and `BillingService.ts` did not grow by a line — it was at 420
against an empty file-length baseline, and each of the three is an independent concern, so each is
its own module (CLAUDE.md's first split form). New:
`billsvc/webhookLog.ts`, `billsvc/reconcile.ts`, `billsvc/reviewQueue.ts`, `src/grantAudit.ts`,
`scripts/reconcile.ts`, `scripts/grantAudit.ts`. Changed: `billingDb.ts` (four tables → six),
`billsvc/server.ts` (the webhook route, and `readJson` now hands the raw bytes through),
`billsvc/deliveryPump.ts`, the five `iap/` adapters, `iap/types.ts`, `iap/factory.ts`.

Measured on this commit rather than on the shared tree (a peer's engine work is in flight in the
same checkout):

- **server: 836 → 973 tests across 38 → 44 files.** +136, all of them branch-shaped: the four
  webhook outcomes, the three key fallbacks, the four difference kinds, the port's four ways of
  refusing, the threshold on both sides, the idempotency keys re-driven.
- **server coverage 99.00% lines / 97.73% branches**, against the 90/90 gate. Every new module is
  at 100/100; the only uncovered line in the files this pass touched is `server.ts`'s pre-existing
  `req.url ?? '/'`.
- `npm run check:filelength`: 47 files, 0 over 500, baseline still empty.
- One existing test changed: `billingDb.test.ts`'s "exactly the four tables … and no more" is now
  six. That assertion is the reason it was worth writing.

## What is still open

- **Four of five platforms cannot be reconciled**, and a run says INCOMPLETE for them. That is §9's
  open question, not a gap in this pass — the port is there, the call each adapter would make is
  written down, and Stripe is the cheapest one to finish first.
- **Nothing schedules any of this.** Both are CLI scripts (`npm run reconcile -w server`,
  `npm run audit:grants -w server`); wiring them to a cron is a deployment question, and this
  project has no deployment for the server yet.
- **Nothing reads the review queue except a human with `sqlite3`.** Deliberate — §8's "no admin
  service" — and the point at which that stops being enough is the first refund, which §9 already
  names.
- **`starter` is counted by default** and nothing grants it today. The day a starter pack ships,
  the fix is `countedSources` without it, not a weaker threshold; the module header says so.
