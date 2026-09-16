# Billing: the data model, the adapters, and the dev stub

Part 2 of the server-platform doc (index: [`design/19-server-platform.md`](../19-server-platform.md)).
Sections **§4–§5**: the tables money is recorded in, and the four platform adapters plus the stub
that lets the whole path be proven without a merchant account.

## 4. Billing: the data model — SHIPPED 2026-09-04

**Status: SHIPPED 2026-09-04** (ROADMAP 8.3). `server/src/billingDb.ts` owns the file and
`server/src/billsvc/BillingService.ts` the five rules; the process is `server/src/billsvc/main.ts`
on 8789 and its routes are `server/src/billsvc/server.ts`. Two amendments the plan below did not
anticipate are recorded at the end of this section, along with the one thing it left open — which
closed the next day (2026-09-05, ROADMAP 8.7) and now reads CLOSED rather than open.


> **AMENDED 2026-09-15 — the four SQLite files became four logical databases on one MongoDB
> Atlas cluster** (`server/src/mongo.ts`; volumes 66 and 67, and `design/16-accounts.md` for the
> decision that reverses its own heading). The paragraphs below still describe the SHAPE
> correctly — what each store holds, why the planes are separate, which constraint each rule
> rests on — and the storage words in them are historical. The three differences that are not
> cosmetic:
>
> - **"Money gets its own process and its own database" survives as a separate logical
>   DATABASE on the cluster**, not a collection prefix, reached through an injected `Db`. A
>   shared handle is how a later refactor quietly re-merges the two planes, which is the same
>   argument the separate FILE rested on.
> - **Foreign keys do not survive and have no equivalent.** Every FK the old schema declared is
>   an application-level check at its one write path now, which binds this code and not the
>   database — so a hand-issued document at a `mongosh` prompt bypasses it where a
>   hand-issued row at a `sqlite3` prompt failed loudly. The CHECK constraints DID survive, as
>   `$jsonSchema` and `$expr` collection validators.
> - **A UNIQUE column that was NULLABLE must become a PARTIAL index.** MongoDB treats a missing
>   field as one `null` and admits exactly one such document where SQLite treats every NULL as
>   distinct — so the naive translation of `platform_txn_id TEXT UNIQUE` rejects the second
>   concurrent UNSETTLED order, on the payment path, in production.

Three tables in `billsvc`'s **own** SQLite file (`BB_BILLING_DB_PATH`), never the account DB —
and never `db.ts`'s `openDb` either, because a shared opener is how a later refactor quietly
re-merges two files this decision separated on purpose:

```
orders(id, account_id, sku, platform, amount_cents, currency,
       state, platform_txn_id UNIQUE, created_at, settled_at)
receipts(id, account_id, platform, product, raw, verified_at)      -- id = `${platform}:${receipt}`
ledger(id, account_id, sku, order_id, receipt_id, kind, ts)        -- append-only, never updated
```

Five rules, each answering a specific failure funny actually hit:

- **`platform_txn_id`'s UNIQUE constraint is the idempotency key.** Platform callbacks are
  at-least-once by contract. Delivery is `INSERT ... ON CONFLICT DO NOTHING` followed by reading
  `changes()`, never SELECT-then-INSERT.
- **Delivery is triggered by the callback, never by the client.** The client's `POST /order/create`
  returns platform payment parameters and nothing else; `GET /order/:id` lets it poll. Whatever it
  claims about success is not an input.
- **Price comes from a server-side SKU table.** An `amount` in the request body is discarded.
- **A replayed receipt belonging to a different account is rejected, not replayed.** funny's
  comment is the whole argument: otherwise the response mirrors another account's state to the
  requester.
- **A receipt records which product it resolved to.** Without it, a receipt for one SKU can later
  be replayed to claim a different one.

**The one place funny's design is deliberately not copied.** funny's recharge path needs a
verify-and-heal saga with CAS claim fields (`healedAt`, `healClaimedAt`) because its receipt row
and its wallet increment are separate Mongo documents with no transaction around them: a crash
between the two loses the purchase silently, and two concurrent healers both observing "no ledger
entry" both re-grant. Here, `orders` + `entitlements` + `ledger` are three tables in one SQLite
file, so a single `BEGIN IMMEDIATE` makes the tear impossible and the CAS machinery unnecessary.

What survives the translation is the *reasoning*, pointed at the tear that does still exist —
between the **platform** and the local transaction. That is what §7's reconciliation covers.

**AMENDMENT 1 (2026-09-04): the named idempotency key is not sufficient on its own.**
`platform_txn_id`'s UNIQUE constraint is the right key and the claim-then-`changes()` shape above
is the right mechanism, but `txnId` arrives in the **callback body**, which nothing authenticates.
One dev-stub receipt posted at three different orders with three invented transaction ids wins
three claims and delivers three times. So `settle` claims **twice** inside the one transaction —
the receipt row's primary key first, then the ledger row's `purchase:<platform>:<txn>` id — and
prefers `verified.platformTxnId` over the body's whenever an adapter supplies one, because the
receipt is verified and the body is not. Losing the first claim is an at-least-once redelivery;
losing the second after winning the first means one platform transaction presented under two
receipts, which is refused rather than resolved silently either way.

**AMENDMENT 2 (2026-09-04): rule 4 belongs INSIDE the transaction.** It first shipped as a
`SELECT account_id FROM receipts` before `BEGIN IMMEDIATE`, which is correct today — but only
because there happens to be no `await` between that read and the claim. Written that way the
guarantee is a property of the current code rather than of the lock, so the ownership question is
now answered from the **lost claim**, under the write lock the transaction already holds.

**What the single-transaction claim actually rests on, and how it is checked.** The grant is called
from *inside* the transaction (`server/src/billsvc/delivery.ts`), and that is what makes the
decision above testable rather than assertable: a throwing grant rolls the order row, the receipt
row and the ledger row back together, the platform's next retry finds an open order, and the
connection stays usable. If the order row survived a failed grant, funny's saga would be necessary
here after all and this section would be wrong.

**CLOSED 2026-09-05 (ROADMAP 8.7): the loop reaches `entitlements`, through an OUTBOX.** The open
question this section left was not *whether* to close the loop but **where the internal call sits
against the transaction boundary**, and the honest answer is that it cannot sit inside it. §2 puts
`entitlements` in the **control plane's** database file, so "three tables in one SQLite file" does
not hold across it and one `BEGIN IMMEDIATE` cannot span it; and an HTTP call made from inside that
transaction would hold SQLite's write lock across a network round trip — serialising every
settlement behind the slowest control-plane response — while *still* not being atomic with the
remote write. It would buy the cost of the tear without removing it.

So the call sits strictly **outside**, and what goes **inside** is a durable promise to make it:

```
deliveries(id, account_id, sku, grants_json, order_id, receipt_id,
           state, attempts, created_at, delivered_at)   -- a FOURTH table in billsvc's own file
  id = the LEDGER row's own `purchase:<platform>:<txn>`
  state: 'pending' | 'delivered' | 'failed'
```

- `EntitlementDelivery.grant` (`server/src/billsvc/outbox.ts`) is one synchronous `INSERT` into
  that table, in the settlement transaction, over the settlement's own connection. The
  single-transaction claim above is therefore exactly as strong as it reads, and gains a fourth
  member: after the COMMIT, the obligation is on disk. **`ledgerOnlyDelivery` is no longer the
  default** — it stays as the explicit opt-out.
- The row's id is the **ledger row's**, not a minted one. The ledger claim was already won two
  statements earlier, so sharing the key makes a duplicate impossible without a second idempotency
  mechanism, and makes `ledger LEFT JOIN deliveries USING (id)` the one query that answers "which
  money moved without reaching an account" — the hand-auditability posture the other three tables
  are shaped for.
- `server/src/billsvc/deliveryPump.ts` drains it into `POST /internal/entitlements/grant`
  (`server/src/routes/internalEntitlements.ts`) over §3's internal key. Three triggers, in the
  order they matter: **opportunistically** right after a settlement commits (not awaited — the
  platform's callback must not be coupled to a peer that may be down), **once at startup** (the
  only thing that can resume a process that died between the COMMIT and the delivery, and the
  entire reason the table exists), and a **bounded interval** as the backstop. An interval alone
  would make every purchase wait a tick; a queue process is the infrastructure §8 declines to build.
- Delivery is therefore **at-least-once**, and that is safe *only* because §2's
  `UNIQUE(account_id, sku)` already makes the receiving grant idempotent — a redelivery grants
  nothing twice and still answers 200, so the pump can retire its row. **That property is the whole
  reason this is an outbox rather than a two-phase commit**; without it a coordinator would be
  unavoidable.
- The failure policy is the part with teeth, because the two directions fail differently. A **4xx**
  is the control plane refusing on purpose (unknown account, malformed body, rejected key): the row
  goes terminal and is logged as an error naming the account, because money moved and nothing was
  granted and only a human can fix that. A **5xx, a timeout or a refused connection** leaves the row
  `pending` **forever** — abandoning it loses a purchase, while a peer that comes back heals every
  stuck row on the next sweep. `attempts` is an operator signal, deliberately not a budget.

What is still not closed is the tear between the **platform** and the local transaction, which was
never this section's to close — that is §7's reconciliation, and it is unchanged.

**THE PLAYER-FACING SURFACE IN FRONT OF THESE ROUTES (2026-09-05, ROADMAP 8.8).** Nothing in this
section is reachable from a client, by design: `POST /order/create` and `GET /order/:id` are
internal, and `/skus` is public only on a port no player can see. `server/src/routes/store.ts` is
what a client actually calls — `GET /store/skus`, `POST /store/order`, `GET /store/order/:id` on
matchsvc, under the player's own bearer session. Three things about it belong here rather than in
§3, because they are properties of this data model rather than of the seam:

- **The accountId is the session's.** `createOrder` takes one because its caller was trusted; the
  proxy builds the outbound body from the verified session plus `sku`/`platform`, and never reads
  an `accountId` the client sent. Rule 3's reasoning about `amount`, applied to the other field a
  client would like to choose.
- **`GET /order/:id` does not check ownership, and now something does.** That was fine while its
  only caller was the delivery path; in front of a player it turns an order id into a read of
  another account's purchase. The proxy compares the returned order against the session and
  answers the same 404 an unknown id gets — a 403 would confirm that a guessed id names a real
  order. It fails closed on a response that carries no `accountId` at all, so this route breaks
  loudly rather than quietly widening if that field ever stops being returned.
- **Nothing retries.** `POST /order/create` is the one call in this whole section that is *not*
  idempotent — the order id is minted per call, so a retry books a second order against the same
  intent. The proxy therefore takes `internalFetch`'s default of exactly one attempt, and the
  polling budget lives on the client where a timeout is a UI state rather than a duplicate row.

## 5. IAP adapters and the dev stub — SHIPPED 2026-09-04

**Status: SHIPPED 2026-09-04** (ROADMAP 8.4), under `server/src/billsvc/iap/` with the second
fail-closed check in `server/src/billsvc/startupGuard.ts`. The four real adapters stop at
unverified, exactly as §9 says they must.

Shape borrowed from funny's `commercial/src/iap/`, which is a per-platform set of independent
functions behind one factory — CLAUDE.md's preferred split form, and it survived four platforms:

```
verifyReceipt(platform, receipt) -> { ok, product?, amountCents? }
```

One file per platform under `server/src/billsvc/iap/`, plus `devStub`. A factory reads credentials
from the environment and closes over a dispatch; a platform with no configured credentials returns
failure rather than throwing.

Two properties are non-negotiable, both taken verbatim from funny:

- **The dev stub is the reason the whole chain is testable with no merchant account.** Receipts
  prefixed `product:<sku>` resolve locally, so orders, idempotency, delivery and reconciliation
  can all be driven end to end before any real credential exists. It is a long-lived asset, not
  scaffolding.
- **Fail closed in production, twice.** With `NODE_ENV=production` the stub is disabled outright —
  it can be neither switched on by a mis-set env var nor fallen back to because credentials are
  missing; missing credentials mean verification fails and nothing is granted. The process also
  refuses to start with the dev flag set. One of those checks is the design; two is the design
  surviving a deploy.

**Where funny's assumption inverts.** funny sells a currency, so its verify result is
coins-first with a non-coin product as a secondary branch. Here there is no currency, so that
secondary branch is the *only* branch and the coin fields do not exist. The port is a
simplification, not a translation.

**As shipped, three notes.** The two fail-closed checks deliberately **share no code**:
`server/src/billsvc/iap/factory.ts` reads `NODE_ENV` before it reads `BB_BILLING_DEV_STUB`, and
`server/src/billsvc/startupGuard.ts` carries its own copy of that three-line predicate. Importing one into the other is the obvious
tidy-up and it would make both defences one defence with two call sites, which is the failure
"twice over" exists to survive — so each has a test asserting its own copy. The stub resolves a
`product:` receipt on **any** platform while enabled, which is what makes `/webhook/apple` drivable
end to end with no Apple account; when it is off the same receipt falls through to the real adapter
and fails there, which is the correct answer and not a fallback in the other direction. And the
four real adapters each have exactly two outcomes, both failures and neither throwing (a missing
credential, and a round trip that is not implemented) — a platform that cannot be verified must not
report `ok`, and one unconfigured platform must not be able to 500 the shared webhook route for the
others.

**The first real platform is Paddle (decided 2026-09-05) and it does NOT fit the shape above.**
`verifyReceipt(platform, receipt)` is a pull, and Paddle is a push: a signed webhook, no
client-held receipt, HMAC over the raw request body, and a Merchant of Record that — unlike the
four here — is the authority on what was actually charged. It lands on §3's platform-signature
path rather than as a fifth row in this section's dispatch. The full account, including the one
place it relaxes §4's AMENDMENT 1, is in §9.
