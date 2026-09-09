# 19 — Server platform: trust seams, entitlements, billing

What the server side becomes once real money is involved. Four of the five pieces this doc
covers already ship (`design/16-accounts.md` login, account storage, matchmaking, the frame-relay
gameserver); the fifth — billing — does not exist, and adding it turns three things that are
currently *tolerable* into things that are *wrong*. This doc is the plan for all four.

Written 2026-09-04 after an audit of the sibling project `funny`'s server (13 services, Mongo +
Redis, a shipped `commercial` service with real Apple/Google/WeChat/Stripe adapters). Its
**topology** is deliberately not adopted; a named set of its **mechanisms** is, each because it
was written by a real incident. Every borrow below says which of funny's assumptions does not
hold here — the standing rule for porting from that project.

## Path convention in this doc

A backticked path carries a file extension **only when the file exists in this repo today**.
Planned modules (`server/src/billsvc/iap`) and sibling-project paths (funny's
`shared/src/internalFetch`) are written **without** one, so `checkDocPaths.mjs` reads them as
prose rather than as claims about this tree. Add the extension when the file lands — §3's two
modules did, on 2026-09-04, and carry `.ts` below.

## The decisions (locked)

- **Three processes, not five and not one.** Control plane (`matchsvc.ts`, 8788), data plane
  (`index.ts`, 8787), and a new **billing plane** (`billsvc`, 8789). Login and account storage
  stay inside the control plane — they are 200-line injected-`DatabaseSync` classes, and
  splitting them buys a network hop and nothing else.
- **Money gets its own process and its own database file.** Not for purity: the control plane is
  restarted and (later) horizontally scaled on a matchmaking cadence, and platform callbacks need
  a stable public entry point, pinned credentials, and an audit boundary that can be read and
  rolled back without the `/find` traffic in the way. funny reached the same conclusion —
  its commercial database is physically isolated from its meta database.
- **Entitlements are server-owned. `meta_state` becomes a cache.** The `/account/meta` route
  accepts a whole client-authored blob today. Once blueprints and characters are sold, that route
  is a free-money hole, and characters are the one meta axis that reaches PvP (`design/14-meta-forging.md`).
- **No wallet, no currency, no gacha.** `design/14-meta-forging.md` locks bounded direct purchase.
  A player buys a SKU and owns it. There is no balance, so there is nothing to double-spend,
  nothing to refund partially, and no channel-tagging problem (see *Not built*).
- **Internal routes get a real key.** Service-to-service calls are authenticated with a
  timing-safe shared-secret header, in a different namespace from both player sessions and the
  match `ticket.ts` HMAC.

---

## 1. The two planes today, and the two defects in them

| | Process | Port | Surface |
|---|---|---|---|
| Control plane | `matchsvc.ts` | 8788 | `/auth/*` (`AuthService.ts`, incl. `/auth/portal` — a verified game-portal user token, `portalToken.ts`, `design/20`), `/account/meta`, `/find` `/resume` (`Matchmaker.ts`), `/party/*` (`PartyService.ts`), `/rating/*` (`rating.ts`) |
| Data plane | `index.ts` | 8787 | `/ws` frame broadcast (`RoomManager.ts` / `MatchRoom.ts`), checkpoint hash adjudication |

Since 2026-09-04 `matchsvc.ts` is an **assembly shell only** — service construction, the
bot-fill hook, `/health`, the dispatch chain, `main()` — and every surface in that first row is
a group of free `(req, res, url, deps)` handlers under `server/src/routes/`:
`server/src/routes/auth.ts`, `server/src/routes/account.ts`, `server/src/routes/match.ts`,
`server/src/routes/party.ts`, `server/src/routes/rating.ts`, over a shared
`server/src/routes/http.ts` (the CORS block, `send`, `readJson`). It was one 431-line if/else
chain before, against an empty file-length baseline, and §2 and §3 both add routes to it — so
each seam below now names its own file, and the two passes cannot collide in one file.

The only trust seam between them is the signed ticket (`ticket.ts`): matchsvc signs
`{roomId, owner, seed, playerCount, mode, accountId}`, the gameserver trusts nothing else. That
part is correct and is not changed here. Two things around it were not — both **fixed
2026-09-04** (ROADMAP 8.1, `design/roadmap/29-2026-09-04-internal-trust-seam.md`):

- **D1 — `/rating/report` was unauthenticated.** It is called by the gameserver and by nothing
  else, but it had no key, no origin check, and open CORS. Any client could POST arbitrary ladder
  placements for any `accountId`. Closed by §3's inbound half. (This bullet and the next read
  "Fixed by §4" when the doc was written; §4 is billing, and the seam that fixes them is §3.)
- **D2 — the outbound report never drains its response body.** `reportSettledMatch` in `index.ts`
  is `fetch(...).catch(() => {})`. funny shipped that exact shape and measured the consequence
  under a concurrent burst: unconsumed undici bodies keep their sockets checked out, the
  keep-alive pool jams, and every request fails with `fetch failed` ~30 s later — so *none* of
  them arrived. Low PvP settlement volume is the only reason it never bit here. Closed by §3's
  outbound half.

Neither defect involved billing, and both were fixed first, as planned.

## 2. Entitlements move server-side — SHIPPED 2026-09-04

Until this landed, `/account/meta` (`server/src/routes/account.ts`) was a blind whole-blob upsert:
`INSERT ... ON CONFLICT DO UPDATE SET
data = excluded.data`, with the only validation being that a `data` key is present. That was the
right call when `MetaState` was a localStorage mirror (`design/16-accounts.md` says so) and
nothing in it was worth money.

The fix is not to validate the blob — that is whack-a-mole. It is to move the two account-level,
purchasable things out of it. `server/src/EntitlementService.ts` owns them, over one table in the
existing account database (`server/src/db.ts`):

```
entitlements(id, account_id, sku, source, order_id, granted_at)
  UNIQUE(account_id, sku)        -- SKUs here are own-or-not, never stacked
  source: 'purchase' | 'grant' | 'event' | 'starter' | 'drop'
```

- `meta_state` keeps what the client legitimately authors: materials, loadout selection,
  in-progress forge state. It stays a whole-blob upsert.
- Blueprint and character **ownership** is read from `entitlements`. On `GET /account/meta` the
  server overwrites the ownership fields in the returned blob from its own table; a client that
  POSTs itself extra ownership is ignored rather than rejected, so no pre-existing guest or
  offline path breaks.
- `forge.ts`'s `acquireBlueprint` / `grantCharacter` are already the grant seam
  `design/14-meta-forging.md` reserved for exactly this. What changes is *who may call them*, not
  their shape.
- A guest (no account) is byte-identical to today: local-only, no server row.

`source` is not decoration. It is what makes the operational work in §7 possible — a daily audit
of non-`purchase` grants, and a support path that can hand-issue one and have it look different
from a paid one afterwards.

### What the build settled that the plan left open

- **SKUs are namespaced rather than split across two tables**: `blueprint:<weaponId>` and
  `character:<skinId>`. One `UNIQUE(account_id, sku)` then covers both, a blueprint id can never
  collide with a skin id, and `WHERE sku LIKE 'character:%'` is the whole query §7's
  hand-correctable-with-SQL requirement needs.
- **`entitlements` DOES take the foreign key `ratings` deliberately refuses**, and the contrast is
  the point. A rating key is any opaque id `ladderReport.ts` hands over, including a guest/bot
  `seat:{roomId}:{seatIdx}` scaffold with no `accounts` row at all. An entitlement is only ever
  minted for a real logged-in account — a guest has no row here — so no legitimate id can fail the
  constraint, and `node:sqlite` enforcing foreign keys by default is then exactly what makes a
  typo'd hand-issue fail loudly instead of becoming an orphan that silently never delivers.
- **Two CHECK constraints**, both because §7 rules out an admin service and the schema therefore
  has to survive being corrected by a human at a `sqlite3` prompt: `source` is constrained to the
  enum §7's daily audit groups by, and a `'purchase'` with no `order_id` is rejected as
  unauditable — §7's reconciliation could never match it to anything.
- **The client's POST is normalized on WRITE, not merely overwritten on read.** Ownership is
  stripped before the blob is stored, so `meta_state` never holds a client-authored ownership
  claim that would mislead whoever reads that table with SQL.
- **`GET /account/meta` answers `{ data, entitlements }`**, the second being
  `{ sku, source, grantedAt }` per row — never `order_id`, which addresses a row in billsvc's
  private database. One round trip, and therefore no new route and no edit to `matchsvc.ts`'s
  dispatch chain, which §3 was landing in from a parallel worktree at the same time.
- **Nothing under `client/src/game/` had to change, and the Forge neither flickers nor rolls
  back.** The server returns EMPTY ownership for every account that exists today, and
  `client/src/meta/store.ts`'s `migrate()` already unions `STARTER_BLUEPRINTS` + `FREE_CHARACTERS`
  back in on every load — so ownership before and after a login is identical. What *does*
  disappear is ownership the client granted itself, which is the hole this section exists to
  close (see §9). `client/src/net/entitlements.ts` is the client half: the wire read, a defensive
  parse that drops one malformed entry without discarding the ones around it, and the same
  skip-unknown-namespace projection the server uses.

**Named so it is not mistaken for shipped:** nothing yet *calls* `EntitlementService.grant`. The
delivery path is billsvc's (§4) through an internal-key-authed route (§3), and
`EntitlementService.owns` exists and is tested but no PvP character gate consults it yet.

## 3. The internal trust seam — SHIPPED 2026-09-04

**Status: SHIPPED 2026-09-04** (ROADMAP 8.1), and **exactly-once since 2026-09-05**. Both
modules exist; `POST /rating/report` is behind the key, `reportSettledMatch` goes through the
outbound helper, and the settlement report is now idempotent at the receiver. Three things
the plan below did not anticipate are recorded at the end of this section — the third of them
was left open on 2026-09-04 and is closed under "Exactly-once settlement" after it.

Borrowed from funny's `shared/src/internalAuth` and `shared/src/internalFetch`, cut down.

**Inbound** (`server/src/internalAuth.ts`): an `x-internal-key` header compared with
`timingSafeEqual`, plus an advisory `x-internal-caller` for logs. funny's per-caller key registry
(one key per calling service, independently rotatable) is the right end state but is not worth it
at three calling services — keep the *shape* (a verifier object built from a registry that currently has
one entry) so adding the registry later is not a rewrite. This is a third namespace, deliberately
distinct from player bearer sessions and from the `ticket.ts` HMAC: internal routes never accept a
player token, and the mismatch is structural rather than a check.

Applies to `/rating/report` (D1, `server/src/routes/rating.ts`) immediately, and to every
`billsvc` route except the platform
webhook, which is authenticated by the platform's own signature instead.

**A THIRD CALLER, AND THE ONE RULE IT ADDED (2026-09-05, ROADMAP 8.8).** matchsvc's `/store/*`
proxy made the control plane an internal CALLER as well as a callee, and put the two namespaces
one function apart for the first time: a player's bearer session is verified in-process and an
internal-key call goes out carrying the accountId that session named. The boundary reads the same
in both directions — an internal route never accepts a player token, and a player route never
trusts an accountId the client asserted — but proxying adds a rule neither end had needed. **A
peer's 401 must not be relayed to the player.** billsvc refusing our internal key is a
misconfiguration on our side; forwarded verbatim it reaches the client as "your session is bad",
so a deploy that missed `BB_INTERNAL_KEY` would present to every player as a login problem and to
no operator as anything at all. It becomes a 502 and an error line naming the variable. The
outbound helper also grew the one thing a proxy needs that a fire-and-forget caller does not —
`collectBody`/`internalFetchJson`, which READ the response body rather than cancelling it. That is
obligation 1 discharged differently, not waived: `res.text()` releases the socket exactly as
`cancel()` does.

**Outbound** (`server/src/internalFetch.ts`): one helper that every cross-service call goes through,
which cannot forget the three things a bare `fetch` forgets:

1. **always drain or cancel the response body**, even when the real answer arrives elsewhere (D2);
2. **an explicit per-attempt timeout** — undici's `fetch` has no default, so a stuck socket hangs
   for tens of seconds instead of failing fast;
3. **bounded retry only for calls that are idempotent and not self-healing.** A settlement report
   is worth retrying; a periodic heartbeat is not, because the next tick re-sends it. Retry is
   therefore **opt-in**: `retry` absent means exactly one attempt, so a caller who never thought
   about it cannot accidentally get at-least-once delivery.

### What building it changed (2026-09-04)

- **The key comparison hashes both sides before `timingSafeEqual`.** The plan said
  "compared with `timingSafeEqual`", which is what `ticket.ts` already does — behind an
  `a.length !== b.length` guard, because that function *throws* on a length mismatch. That
  guard is right for an HMAC, which is always the same length, and wrong for an
  operator-chosen shared secret: it turns the real key's length into something an attacker can
  measure. Hashing first makes every comparison 32 bytes against 32 bytes, so it neither
  throws nor leaks the length. Without it a wrong-length key is a 500, not a refusal.
- **An unset key in production yields an EMPTY registry, not the dev key.** `config.ts` gives
  the internal key the same posture it already gives `BB_TICKET_SECRET` (real env var →
  production; unset → a published dev key plus one loud warning, so the two-process local
  setup works out of the box) with exactly one difference: under `NODE_ENV=production` an
  unset `BB_INTERNAL_KEY` refuses *every* internal call rather than falling back. A key
  printed in this repository is not a weaker credential than none — it is the same one — and
  the fallback would look configured. This is §5's "fail closed in production" rule, which
  that section states for the billing dev stub, reaching one section earlier than expected.
- **`/rating/report` was at-least-once, and retrying it double-applied a rating.**
  `RatingStore.applyMatch` carried no dedupe key, so a report that was delivered but whose
  response was lost was applied twice on retry — which is why the settlement budget shipped as
  a deliberate 3. **CLOSED 2026-09-05**, with exactly the shape §4 specifies for billing
  delivery: a dedupe key threaded through `ladderReport.ts`, a `UNIQUE` column in `db.ts`, and
  a claim-then-`changes()` check rather than SELECT-then-INSERT. See "Exactly-once settlement"
  below; the budget is now 5, because a retry can no longer multiply a rating.

### Exactly-once settlement — SHIPPED 2026-09-05

`ladderReport.ts` puts a `reportKey` in the report body, `db.ts` gains a `rating_reports`
table whose `report_key` PRIMARY KEY *is* the mechanism, and `RatingStore.applyMatchOnce`
claims that key with `INSERT ... ON CONFLICT DO NOTHING` + `changes()` **inside the same
`BEGIN IMMEDIATE` that writes `ratings`**. Four things the build settled that the sentence
above did not say.

- **The claim and the ratings roll back together, and that direction matters more.** Losing
  the claim and applying anyway is the original defect: a redelivery double-credits. Winning
  the claim and then failing is worse — the key is burned for a match whose deltas were never
  written, so that match's rating is gone permanently and every retry is answered "already
  applied". A double-credit is at least visible in the ladder and reversible. Both directions
  have their own tests, the failing-write one forced by a real SQLite trigger rather than a
  mocked driver, because the point is that the *database* aborts the write the claim is tied to.
- **A lost claim answers 200 with `duplicate: true`, deliberately not 409.** The sender is an
  at-least-once retry ladder, and `internalFetch` counts every non-2xx a failure: a 409 would
  log "ladder report failed" for a match whose rating actually landed, and keep asking. 200 is
  what *ends* at-least-once delivery meeting an idempotent receiver, so the marker goes in the
  body where an operator can still tell the two apart. A thrown apply is a 500 for the mirror
  reason — 500 is the one status that IS retried, and the claim has already rolled back.
- **`roomId` alone would have been a correct key, and is not the one that shipped.** A room
  settles at most once (`MatchRoom.reportResult` latches and destroys) and `matchsvc.ts` mints
  room ids with `randomUUID()`, and the mode does not change this: a PvE/co-op settlement takes
  the same `onSettled` path and is filtered per-REPORT by `reportSettledMatch`'s
  `hashOk`/`placements`/`winner` guard, so whatever gets through still gets through once per
  room. What breaks it is that the room id is not always ours — `index.ts`'s legacy dev
  handshake reads `roomId` off the query string, and the room is gone once it settles, so a
  local `?roomId=dev` can host a second, genuinely different match. So the key is
  `{roomId}:{16 hex of sha256 over the report}`: the prefix is what an operator greps, the
  digest is what keeps two matches apart, and it is stable across the retry ladder because it
  is a pure function of the body.
- **A report with NO `reportKey` is applied the old, non-deduped way, and logged.** The route
  has exactly one legitimate caller, so a keyless report means version skew during a rolling
  deploy. The two options are asymmetric: accept it and risk the bounded double-apply that
  stood until today, or 400 it and lose those matches' ratings for good, since a 4xx is never
  retried. The recoverable failure wins. This is not a hole worth closing — the route is
  key-gated, and anyone who can reach it can already post whatever placements they like.

### The ladder gate stops asking the players — SHIPPED 2026-09-05

The other half of "who may move a rating", and the one the key does not cover. Authentication
settled *who* may call `/rating/report`. It did not settle *which settlements the gameserver
sends*, and until 2026-09-05 that was decided by data the clients supply.

`reportSettledMatch`'s guard read
`!match.hashOk || !match.placements || typeof match.winner !== 'number'`, and only the first of
those is trusted. `hashOk` is the room's own work — `MatchRoom.reportResult` compares every seat's
end-of-match state hash and sets it itself. `placements` and `winner` are `reports[0]`'s values,
relayed verbatim out of the seats' own `result` messages, with `hashOk` saying only that every
seat sent the *same* hash, never that any of it describes a real match. So `placements`-is-present
was doing double duty: a legitimate precondition for `buildRatingReportBody`, and — per the comment
above it — the test for "was this PvP", which is a question the seats were answering about
themselves.

A co-op/PvE squad that plays a room out, agrees on a hash (they already do; same deterministic
sim) and all send a fabricated `placements` array plus a numeric `winner` therefore produced a
real ladder report for a match nobody competed in. The accounts moved are real: `seatAccounts`
comes from the verified ticket, so they never had to lie about who they were, only about what they
were playing.

**This is the qualification on the bullet above.** "Anyone who can reach the route can already post
whatever placements they like" is true of the route, and was the right call for a keyless report.
It understated the population: the gameserver — correctly authenticated, holding a real key — was
forwarding placements authored by ordinary clients who hold no key at all.

The room already knew better. `MatchRoomDeps.mode` is set from the verified ticket
(`resolveSeat` → `RoomManager.join` → the constructor), `RoomManager.join` rejects a joiner who
disagrees about it, and `index.ts`'s reconnect arm was already cross-checking `modeValue` to refuse
a stale or foreign ticket. Settlement just never consulted it — deliberately, and the comment said
so: "its presence, not the room's own knowledge of match type, is what selects the `'placement'`
reason — MatchRoom stays generic infrastructure". That reasoning is right about `match_over`'s
`reason` string, which is cosmetic. The mistake was letting a rule about a display string govern a
decision with ratings attached.

`SettledMatch` now carries `mode` and the guard leads with `mode !== 'pvp'`. Three notes:

- **`mode` is required, not optional.** An optional field would leave a future producer that omits
  it with `undefined`, which is not `'pvp'` and so fails closed *by luck*. Required makes it a
  compile error, and it found the one construction site at once.
- **`placements`/`winner` stay in the guard**, as the shape check `buildRatingReportBody` needs —
  not as evidence of the match type. They are on their own line so the file reads that way.
- **`MatchRoom` still imports nothing from matchsvc.** `mode` was already in `MatchRoomDeps`, so
  the room reports a fact about itself and the entrypoint decides what it means.

Recorded in [`roadmap/33-2026-09-05-ladder-mode-gate.md`](roadmap/33-2026-09-05-ladder-mode-gate.md).

## 4. Billing: the data model — SHIPPED 2026-09-04

**Status: SHIPPED 2026-09-04** (ROADMAP 8.3). `server/src/billingDb.ts` owns the file and
`server/src/billsvc/BillingService.ts` the five rules; the process is `server/src/billsvc/main.ts`
on 8789 and its routes are `server/src/billsvc/server.ts`. Two amendments the plan below did not
anticipate are recorded at the end of this section, along with the one thing it left open — which
closed the next day (2026-09-05, ROADMAP 8.7) and now reads CLOSED rather than open.

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

## 6. Topology: `GameRegistry`, deferred but shaped now

The gameserver's rooms are in-process `Map`s driven by in-process intervals (`RoomManager.ts`), so
today there can be exactly one. That is fine — a frame-broadcast room is inherently a stateful
shard — but it is currently an accident rather than a decision, and the cheap moment to shape it
is before anything depends on `/find`'s response format.

funny's answer, adopted: a registry inside matchsvc where each gameserver **registers** its public
WS URL and capacity at startup, **heartbeats** its load, and is dropped after 30 s of silence;
`/find` picks the least-loaded healthy instance and returns its URL **in the response, not in the
ticket** — the ticket stays purely a seat authorization and never learns the topology. Two details
from funny that are the actual content:

- **A single-instance deployment does not register at all**; a configured static address seeds one
  entry. So this can land now as the static branch only, with the register/heartbeat routes unbuilt.
- **Registration retries indefinitely with capped backoff, but gives up immediately on a 4xx**, and
  heartbeats deliberately do *not* re-register. A heartbeat that silently re-registered would mask
  a failed startup registration; a registration that gave up on a network blip would leave the
  instance permanently invisible.

This supersedes the "put a gameserver id inside the ticket" sketch that preceded this doc.

### Shipped 2026-09-05 — the static branch, and what building it settled (ROADMAP 8.6)

`server/src/GameRegistry.ts`, consulted by `matchsvc.ts`; `register`/`heartbeat` are methods with no
HTTP route, so the configured static address is the only branch a deployment reaches today.
`ticket.ts` is unchanged, and so is the client. Volume 34 has the full account; three points belong
here because they qualify the bullets above.

- **"A configured static address seeds one entry" must not be read literally.** Nothing heartbeats a
  configured address and nothing reports its load, so as a map entry it sits at load 0 and never goes
  stale — and therefore wins every `pick()` against real instances reporting real numbers. It is held
  in its own field and reached only when no registered instance qualifies. This is also why
  `GameServerEntry.lastSeenMs` is nullable and `capacity` is `Infinity` for that entry: an unknown
  capacity must read as unbounded rather than as full, and "never heard from" is a different state
  from "just checked in".
- **`pick()` returning `null` is a real answer, and the callers had to grow a refusal.** With no
  registered instance and no configured address it is the only answer. `routes/match.ts` answers 503
  `{ error: 'no gameserver available' }` on all three routes, which is what lets `MatchInfo.wsUrl`
  stay non-optional on the client — an `undefined` in the match object would surface not at the
  control plane but as a socket opened on `undefined?ticket=…`. Both `/find` routes ask BEFORE
  touching the queue: `Matchmaker.poll` deletes the waiter on its way to returning `matched`, so a
  503 decided afterwards would destroy the seat the player has been waiting for.
- **The registration rules are enforced or written down, not deferred with the routes.** The 4xx/
  backoff/never-re-register bullet above is in the class header, `REGISTER_BACKOFF_CAP_MS` is
  exported beside `STALE_MS` (equal today, deliberately two constants — one is how long the registry
  waits before disbelieving an instance, the other how long an instance waits before retrying), and
  `heartbeat()` returns `false` for an unknown id and writes nothing, so the half that can be
  enforced today is.

Also settled here rather than in `config.ts`: `BB_GAMESERVER_URL`'s default lives in
`GameRegistry.staticGameserverUrl()`, read per call for the reason `ticketSecret` is. The registry
owns the topology question, so `config.ts` has no reason to.

## 7. Operations — SHIPPED 2026-09-05

**Status: SHIPPED 2026-09-05** (ROADMAP 8.5). None of this was optional once money moved, and all
of it was small because the schema anticipated it — three new sibling modules under
`server/src/billsvc/` plus one at `server/src/grantAudit.ts`, two new tables in billsvc's own
file, and two CLI scripts under `server/scripts/`. `BillingService.ts` did not grow by a line:
each of the three is an independent concern, so each is a sibling file (CLAUDE.md's first split
form), not a method.

- **Log every webhook event, not just the successful one — `server/src/billsvc/webhookLog.ts`.**
  Keyed `${txnId}:${eventType}` so at-least-once redelivery upserts. funny's reason: failed and
  cancelled transactions are otherwise dropped silently by the handler, and "why did my payment
  not go through" then has no evidence behind it at all. Every branch of `POST /webhook/:platform`
  now writes one `webhook_events` row before it answers — the settlement, the replay, the cancel,
  the refusal, the unrecognised event type, and the body that was not even JSON.
- **Reconciliation, daily — `server/src/billsvc/reconcile.ts`.** Pull the platform's recent order
  list, compare against local `orders`. This is the check that covers the platform↔local tear §4
  leaves open, and it is the reason the ledger is append-only. Joined on `platform_txn_id`; four
  difference kinds (`local-not-on-platform`, `platform-not-local`, `amount-mismatch`,
  `sku-mismatch`).
- **A daily anomaly audit that files rather than acts — `server/src/grantAudit.ts`.** Count
  non-`purchase` entitlement grants per account per day; anything over a threshold goes to a
  review list. funny's two audits (`coinAnomalyAudit`, `anticheatAudit`) share one principle worth
  stating here because it is the same one `design/15-pvp-arena.md`'s checkpoint quorum already
  follows: **with no evidence, skip — never convict.** No automatic revocation.
- **No admin service.** funny has a whole one. Here the requirement is weaker but real: the schema
  must be queryable and hand-correctable by a human with SQL, which is what `source` on an
  entitlement and an append-only ledger buy. Revisit when the first refund arrives. The review
  list above is a TABLE for that reason, not a dashboard: `review_queue` in billsvc's own file,
  worked at a `sqlite3` prompt.

  > **SUPERSEDED 2026-09-09 by `design/21-ops-analytics.md`** — and NOT by the trigger this
  > bullet named. No refund has arrived; what arrived is a need to measure retention and to look
  > at a player without an SSH session. A console is designed (§3 there) as a fifth process with
  > `readOnly: true` handles.
  >
  > **The requirement above survives intact, and design/21 leans on it rather than replacing
  > it.** Its decision B2 — the publicly exposed console is read-only over player data, and every
  > player-data mutation stays a CLI script run on the box — is only proportionate *because* the
  > schema is hand-correctable with SQL. So this bullet's actual content became load-bearing at
  > the moment its conclusion stopped being. What did change is the sentence "no admin service":
  > read design/21 §6 for the eight things funny's admin has that are still deliberately absent.

Five things the plan above did not say, each because it only appears once the code is real.

**AMENDMENT 1: `${txnId}:${eventType}` needs two fallbacks, and they are not a detail.** A
callback that carries no transaction id is not an edge case to shrug at — it is precisely the
malformed or unparsable payload whose evidence is worth the most, and a naive key collapses every
one of them into a single row that each new bad payload overwrites. `webhookEventKey` falls back
to the merchant order id (`order:<id>:<event>`) and, failing that, to a truncated sha256 of the
raw bytes (`raw:<hash>:<event>`). The hash is a legitimate key rather than a giving-up value,
because a platform retry of an unparsable body repeats the same bytes — so the redelivery still
lands on its own row, which is the whole property the key exists for.

**AMENDMENT 2: an unknown event type must not settle.** Before this pass, `server.ts` special-cased
`failed`/`cancelled` and sent *everything else* into `settle` — so a platform that started sending
`refunded` or `chargeback` would have had it treated as a purchase callback. `webhookEventType`
now narrows to a known set and anything else is recorded with outcome `ignored` and answered 200
(200, not 4xx: a platform retrying an event this server has simply not implemented is noise, and
the row is where anyone finds out it started arriving). This is the one behaviour change in §7 as
opposed to an addition, and it is the reason "log every event" was worth doing as a pass rather
than as a line.

**AMENDMENT 3: reconciliation cannot be honest here without saying what it did NOT check.** §9
records that no merchant account exists on any of the four real platforms, so there is no platform
order list to pull. That is handled the way §5 handled the identical problem for verification:
"list the platform's recent orders" is an injected PORT (`PlatformOrderLister`), the dev stub
implements it against an **authored** order book (`DevStubOrderBook`, seeded from
`BB_BILLING_DEV_ORDERS`), and the four real adapters each carry the call they would make and
return not-implemented. Two consequences are load-bearing:

- A platform whose port refuses does **not** contribute zero differences — it lands in the
  report's `unreconciled` list, and `complete` is false whenever that list is non-empty. There is
  no code path that can report a clean reconciliation for a check that did not run, and the
  formatted first line says COMPLETE or INCOMPLETE *before* it says how many differences.
- The dev platform's book is authored and never derived from `orders`. A dev platform computed
  from the local tables could only ever report zero differences — a reconciliation that passes by
  construction, which is worse than none because it looks like evidence.

**AMENDMENT 4: the threshold comparison is `>`, and the audit reads a database it cannot write.**
Exactly at the threshold is not an anomaly: the threshold is the largest count anyone has said is
fine, so a count equal to it is a case somebody already accepted. And the "never convict" half is
enforced structurally rather than by comment — `server/scripts/grantAudit.ts` opens the account
database **read-only** (`entitlements` is the table it is judging) and the billing database
read-write for `review_queue` alone. A source that is not on the counted list is SKIPPED rather
than counted, including one a later migration adds to `db.ts`'s CHECK: it arrives uncounted, and
whoever adds it decides. `(accountId, dayKey)` in UTC is the idempotency key, so re-running the
audit over a day already filed produces nothing — not a duplicate, not a reopened row, not a
refreshed timestamp. An audit an operator is afraid to re-run is an audit that stops being run.

**AMENDMENT 5: the review queue already had a producer waiting for it.** §4's outbox (2026-09-05)
made a 4xx from the control plane terminal and logged it as an error naming the account — money
taken, nothing granted, the only class in Phase 8 where that is true — and a `console.error` was
its entire disposition: no owner, no second reader, gone on the next rotation. `deliveryPump.ts`
now files that row into `review_queue` **in the same transaction** that makes the delivery
terminal, because a crash between the two would leave a terminal row nobody is ever told about,
which is worse than either failure alone. Both terminal paths file: the deliberate 4xx and the
outbox row whose `grants_json` can never be read. A *retryable* failure files nothing, and that
distinction has teeth — a 5xx row is still owed and a peer that comes back heals it, so filing it
would tell a human to hand-grant a purchase the next sweep is about to deliver.

**Where the two new tables live, and why one of them is in the "wrong" file.** `webhook_events`
and `review_queue` are both in billsvc's own SQLite file (`billingDb.ts`), six tables now rather
than four. `review_queue` holding findings about the CONTROL PLANE's `entitlements` table is
deliberate: that file is the one an operator already opens when money is the question, the delivery
pump has that connection and no other, and a second queue in the account database would mean a
human has to know which of two places to look.

### Backups — SHIPPED 2026-09-07

§7 is about knowing what happened. This is about still having it. Two SQLite files hold the
only two facts this project cannot regenerate — `accounts.db` (identity, ladder, meta) and
`billing.db` (orders, entitlements, the outbox) — and until this landed the backup procedure
was two `scp` lines in `server/deploy/README.md`: a procedure exactly as reliable as somebody
remembering it, guarding the data that a launch makes irreplaceable.

The worker is a **fourth compose process** (`server/src/backup/`, bundled as `backup.mjs` by
the same `scripts/build.mjs`), not a host cron job, and that is the load-bearing choice: the
CI deploy key runs one forced command and installs `dist/` + `Dockerfile` +
`docker-compose.yml`, so a service rides the existing deploy while a host-level cron entry
would be a manual install nobody re-does — the same class of failure as §9's "a value written
into an env file is not a value the process can see".

Four properties worth locking down, each with a test that fails if it is dropped:

- **`VACUUM INTO`, not `cp`.** A copy of a live database captures a torn page set that opens
  fine and fails on the page that mattered. `VACUUM INTO` runs in a read transaction, so the
  destination is a point-in-time consistent snapshot with no cooperation from — and no
  interruption of — the running service.
- **The worker cannot write to a live database.** `VACUUM INTO` works through a *read-only*
  SQLite handle (verified against `node:sqlite`, not assumed), so both data directories are
  mounted `:ro` and its only writable mount is its own `backups` volume. "The backup job
  corrupted the database" is not a failure mode it has.
- **A snapshot is verified before it is published.** `PRAGMA integrity_check` on the copy,
  then gzip, then an atomic rename — so the directory never holds a file that merely looks
  like a backup, and an interrupted run leaves a `.part` that the pruner neither counts nor
  deletes.
- **Retention is per SOURCE and only advances on success.** 14 each, pruned after that
  source's own snapshot succeeded. A directory-wide count would let a busy database age out
  the other one's history, and pruning on schedule regardless of success turns a retention
  policy into a countdown to having nothing.

**It is observable, which is the other half of the problem.** A worker with no port is a
worker nothing polls, so each cycle publishes `status.json` and the same bundle answers
`node backup.mjs --health`: unhealthy when any source failed OR when the last cycle is too
old — the second is what stops a worker whose loop died after one good cycle from reporting
green forever off a stale success. That is the container's healthcheck, and `ci-deploy.sh`
asks for it after `docker compose up`, so a deploy that silently stops backing up fails in
CI. It also **refuses to start** with no source configured, rather than idling green: an
empty `BB_DB_PATH` is treated as unset, which is §9's own env-var trap applied one file over.

**Two limits, stated rather than papered over.** Nothing is copied OFF the box — a snapshot
beside the database survives every failure this project has actually had and none of the ones
that take the host with it, and on hardware this project only borrows that is a real
scenario; the off-box copy is a human `rsync`, filed as still open in
`server/deploy/README.md` §7. And a restore is downtime plus a shell (`docker compose stop`,
`gunzip -c > …`, start) — documented step by step there, deliberately needing no tooling from
this repo, because the day it is needed is the wrong day to depend on a script nobody has run.

## 8. Deliberately not built (all of these exist in funny)

| Not adopted | Why not here |
|---|---|
| Gateway separated from gameserver | funny's gateway carries presence, social and world traffic. This project's WS carries frames and nothing else. |
| Mongo, Redis, protobuf codegen, generated OpenAPI routes | Three processes, one client, and `@dd/engine`'s `ClientMsg`/`ServerMsg` is already the shared contract. |
| Wallet, currency, gacha, pity, subscription cards | `design/14-meta-forging.md` locks bounded direct purchase with no gacha. Importing the code would import the economy. |
| Channel-tagged balances | funny needs them because coins bought on the web may not be spent inside an iOS build (Apple's anti-circumvention terms). Selling SKUs rather than currency removes the problem — **and re-creates it the day a currency is introduced.** |
| ~~Loki / Alloy / Grafana~~ — **ADOPTED 2026-09-09, see §10** | The row read: *"its monitors exist to feed a sink this project does not have, so a literal port computes correct numbers and drops them."* That was exactly right when written, and the thing that changed is the premise rather than the argument — there is a live deployment now (server/deploy/README.md), a public client on three build targets, and therefore a sink worth having. §10 records what was taken, what was scaled down, and the one part of funny's design that was deliberately NOT ported (its feature-flagged, per-player targeted collection). |
| Social, auction, world, bot services | Other games. `BotClient.ts` already covers what is needed here. |

## 9. Open questions

- **DECIDED 2026-09-05: Paddle is the first real platform.** No merchant credential of any kind
  exists in this project, so §5's four adapters cannot be verified past the dev stub — and,
  since 2026-09-05, neither can §7's order listers, which is why a reconciliation run reports
  INCOMPLETE for four of five platforms rather than clean. The recorded comparison, kept because
  it is still true and still an argument: Stripe is the cheapest platform to prove the
  *reconciliation* logic against, its list call being a single paged `GET /v1/checkout/sessions`
  where Apple's needs an ES256 JWT over three credentials, Google's needs a Pub/Sub subscription
  and WeChat's is a gzipped CSV behind a signed download URL. That is a reconciliation cost, and
  it lost to a tax-and-compliance argument: Paddle is a **Merchant of Record**, so it owns VAT,
  sales tax and chargebacks, which a solo-operated project cannot own for itself.

  Paddle is **not built**, and four things about it do not fit the shape §5 shipped — which is
  why it is filed here rather than as a fifth row in an existing table:

  1. **It is push, not pull.** Every adapter in §5 answers
     `verifyReceipt(platform, receipt)`: the client holds a receipt and the server verifies it
     upstream. Paddle has no client-held receipt — it sends a signed `transaction.completed`
     webhook. Paddle therefore lands on the one path §3 already carved out and nothing has used
     since: *"every `billsvc` route except the platform webhook, which is authenticated by the
     platform's own signature instead."*
  2. **Signature verification needs the RAW body.** `Paddle-Signature: ts=<ts>;h1=<hmac>` is an
     HMAC-SHA256 over `${ts}:${rawBody}`, and `server/src/billsvc/server.ts`'s webhook route
     reaches its handler through `readJson` — already parsed. Re-serialising to verify is the
     classic failure here: key order and whitespace differ, the HMAC does not match, and it
     presents as "bad signature" rather than "you verified the wrong bytes". A bounded timestamp
     tolerance bounds replay. So this touches the webhook route itself, not only a new adapter file.
  3. **Merchant of Record partly inverts §4's price rule.** *"Price comes from a server-side SKU
     table"* holds for what we OFFER, but Paddle owns localised pricing, currency and tax, so it
     alone knows what was actually CHARGED. A SKU therefore gains a Paddle price id, the local
     `amountCents` in `server/src/billsvc/skus.ts` becomes a record rather than an authority, and
     a mismatch is a §7 reconciliation finding — never a rejection, because refusing money already
     taken converts a bookkeeping discrepancy into an undelivered purchase. funny reached the same
     place: it stores the resolved `usdCents` on the recharge row so a later refund decrements
     exactly what was added.
  4. **§4's AMENDMENT 1 relaxes here, and only here.** That amendment prefers the verifier's
     transaction id over the callback body's *because the body is unauthenticated*. A Paddle body
     is signed, so its transaction id is trustworthy and is the natural `platform_txn_id`. The
     amendment stays correct for every other platform; Paddle is the exception that proves what
     it was actually guarding.

  Two consequences outside billsvc. Paddle is **web-only**, so with it as the only real platform
  the store sells on the web build and nowhere else — `client/src/game/screens/StoreScreen.ts`'s
  gate (`platform/storePlatform.ts`) already produces exactly that, and offering Paddle checkout
  inside an iOS build would be the App Store 3.1.1 violation that gate exists to prevent. And
  refunds stop being hypothetical: a Merchant of Record handles chargebacks, so Paddle will send
  refund events, which makes the refund bullet below a dependency of this work rather than a
  parallel question.

  **THE PRECONDITION, found 2026-09-05 — RESOLVED 2026-09-07: billsvc now has a public address.**
  A Paddle webhook is a server-to-server POST to a public HTTPS URL, and until this date the
  project had no server deployment of any kind. `gameserver`/`matchsvc`/`billsvc` now run as three
  containers (`server/Dockerfile`, `server/docker-compose.yml`) on the same VPS + Cloudflare zone
  `funny` (via `deutsch`) already uses, behind the same Caddy instance, at the new subdomain
  `bb.gamestao.com` — full runbook in `server/deploy/README.md`. Getting there needed one thing
  this section didn't anticipate: this server pulls live TypeScript from sibling workspaces via
  path aliases (`@dd/engine`, `@dd/game/*`, `@dd/net/*`), so rsync-and-run (funny's/deutsch's own
  approach) would have meant shipping and `npm ci`-ing the whole monorepo onto the VPS.
  `server/scripts/build.mjs` instead esbuild-bundles each entrypoint into one flat file, resolving
  those aliases at BUILD time, so the deploy target needs nothing but Docker. **billsvc still runs
  in dev-stub mode** — this resolves the deployment precondition only, not the credential
  question below, which is unchanged and still open.

  **The deploy layer got its own tests on 2026-09-07** (design/18-test-strategy.md "Layer 6").
  Nothing had ever exercised the artifact that actually runs here: the server tree measured
  99.56% lines / 97.93% branches over `src/`, and every one of those tests imported TypeScript
  the way `tsx` does in dev, while production runs three esbuild bundles inside a container
  configured by four files no compiler reads. `server/test/deploy.bundle.test.ts` builds into a
  scratch directory, links in ONLY what `server/deploy/package.json` declares, and boots each
  bundle as a bare `node` process until it answers its own `/health` with its own service name —
  so a missing external fails here exactly as it would in the container.
  `server/test/deploy.manifests.test.ts` cross-checks bundle names, ports, externals, the base
  image's Node major and every compose env var against `build.mjs` and `src/`, and feeds the
  compose file's own billsvc env block to the real `assertBillingStartupSafety`.

  **What is reusable from funny's Paddle setup, and what is not.** The seller account is the same
  one; nothing else transfers cleanly. **Price ids cannot be reused at all** — funny sells coin
  tiers and this project sells ten named blueprint SKUs, so ten Products and ten Prices are new
  work, each with quantity adjustment turned OFF because an entitlement is own-or-not and has no
  quantity semantics. **The webhook secret cannot be reused either**: it is per notification
  destination, and billsvc's endpoint is a different URL, so it needs its own destination — which
  should subscribe to every event type rather than only the settling one, since §7's log exists
  precisely because a silently-dropped failure leaves "why did my payment not go through" with no
  evidence. The API key and the client-side token are account-level and *could* be shared, but a
  separately issued pair is independently revocable, which is worth more than the minute it costs.

  **The merchant-domain review is a real gate with a real failure history.** Paddle is a Merchant
  of Record, so it crawls the seller's domain and its legal pages before approving it. funny was
  rejected **twice**, and both reasons apply here unchanged: once because the game's root path is a
  bare canvas with nothing a crawler can read ("website inaccessible"), and once because its refund
  policy said purchases were final, which contradicts the 14-day minimum refund window in Paddle's
  own Buyer Terms. Its fix was five crawlable static pages — a landing page, pricing, refunds,
  terms, privacy — with the reviewed URL pointing at the landing page rather than the game, the
  refund page leading with the 14-day window, and the terms naming the operating entity. **This
  project's root path is a bare canvas too**, so whether `b.gamestao.com` inherits the approval
  already granted to the zone or needs its own submission is the first thing to check in the
  dashboard, and if it needs its own, those pages are a work package rather than a checkbox.

  **Five implementation traps carried over from funny, each one it actually hit.** The Paddle
  Billing API is **snake_case** (`price_id`, `custom_data`) and rejects camelCase silently, with a
  400 whose text names the field it claims is missing. `custom_data` is how identity survives the
  round trip — funny carries its account id there, and this project should carry billsvc's own
  order id, which is the join back to the order the webhook is settling. The signature is
  `ts=<epoch>;h1=<hex>` over `${ts}:${rawBody}`, compared with `timingSafeEqual` **inside a
  try/catch**, because a non-hex `h1` produces a short buffer and that function throws on a length
  mismatch. An env var set to the EMPTY STRING is worse than an unset one wherever the code reads
  `process.env.X ?? fallback`, since it overrides the fallback with nothing. And **a value written
  into an env file is not a value the process can see**: funny's Apple credential sat in its `.env`
  for months while production stayed fail-closed, because its compose file interpolates rather than
  loads and the service block never listed the variable. **That specific failure is now gated
  here**: this project's deploy mechanism landed 2026-09-07, and
  `server/test/deploy.manifests.test.ts` requires every variable in `docker-compose.yml` to be a
  name `src/` actually reads, requires each service to carry `env_file: .env` (compose LOADS the
  file rather than interpolating it), and refuses to let either credential be inlined into the
  tracked compose file. A variable that reaches the `.env` and not the process is still possible
  — nothing tracked can see inside an untracked `.env` — but the compose half of funny's failure
  cannot recur silently.
- Whether `entitlements` should also absorb the **materials** half of `MetaState` (it is farmable,
  not purchasable, so it is only worth it if duplication-by-blob-replay turns out to matter).
- **CLIENT HALF CLOSED 2026-09-05 (ROADMAP 8.8).** `ForgeActions.acquireBlueprint`'s `demo: free
  grant` scaffold (`design/14-meta-forging.md`, ROADMAP 2.4) is gone — the Forge's ACQUIRE became
  STORE, a real screen (`client/src/game/screens/StoreScreen.ts`) driving a real purchase
  (`controllers/StorePurchase.ts`) through `net/billing.ts`, hardwired to the `GET /store/skus` /
  `POST /store/order` / `GET /store/order/:id` protocol this section already specifies, under the
  player's own bearer session. `platform/storePlatform.ts` is the App-Store-3.1.1 gate: a build
  that may not sell (the WeChat mini-game today, an iOS build once one exists) renders no STORE
  entry at all, not a disabled one. **BOTH HALVES CLOSED 2026-09-05.** The proxy landed the same
  day: `server/src/routes/store.ts` serves those three routes on matchsvc, verifying the player's
  bearer session in-process and forwarding to billsvc over §3's outbound helper. It bridges three
  mismatches, not one — the paths (`/skus`, `/order/create`, `/order/:id` on the other side), the
  credential namespace, and the identity rule: billsvc's `createOrder` reads `accountId` from the
  request body, which is correct for an internal route and is a "charge somebody else's account"
  parameter the moment a player's client can reach it. See §4's own note on what the proxy settled.
- Refund handling is specified only to the extent of "the ledger is append-only and a reversal is
  a new row". What a revoked character does to a ladder history is unanswered.
- SQLite stays the answer until there are two control-plane processes. That, not revenue, is the
  signal to revisit.

## 10. Observability: one store for both halves — SHIPPED 2026-09-09

§7 is about knowing what happened to a purchase. This is about knowing what happened at
all — and it is the first section here whose second half is not on the server.

**The two questions that had no answer.** "What happened on the server?" meant `ssh` plus
`docker compose logs`, against a 10 MB × 3 rotating buffer, on a box one person can reach.
"What happened in a player's browser?" had no answer of any kind: every device-side bug this
project has actually had — the blank WeChat labels (design/04), the CrazyGames SDK calls
that were silent no-ops (design/20), the CORS preflight that failed as a bare
`Failed to fetch` (design/16) — was found because somebody happened to have devtools open.
That is not a method, and it stops working the moment a player is not us.

**The shape.** Four off-the-shelf containers in the existing compose project — Loki (store),
Alloy (collector), Prometheus (metrics), Grafana (query) — plus three things in this repo:
a structured logger every process writes through, a `/metrics` route on each service, and a
`POST /client/log` ingest route the browser flushes to. Both halves land in ONE store,
which is the property the whole design is arranged around: a player reports a failure, and
the answer is their session's lines and the server's lines on one timeline.

### The five decisions worth recording

**1. Labels are a fixed, tiny set; everything identifying goes in the LINE.** `source`,
`svc`, `level` for the backend; `source`, `level`, `host` for the client. The session id,
the build version, the account, the room id, the order id are all logfmt fields parsed at
query time. This is not tidiness: a label per session id is one Loki stream per player per
visit, which is the standard way to make a log store unqueryable — and on `/client/log`
those values come from the open internet. funny reached the same rule and states it the
same way.

**2. The log line is human-readable text, not JSON.** `HH:MM:SS.mmm LEVEL [tag] msg k=v`
(`server/src/log.ts`). `docker compose logs -f` over `ssh` remains the first thing anybody
reaches for when the box is misbehaving, and a screen of JSON is a screen nobody reads. The
collector regex-parses the prefix into the `level` label and leaves the rest alone. This is
the "logger *shape*" §8's old row already said was worth taking; what it did not anticipate
is that the shape is what makes the collector's job one regex.

**3. Telemetry may never affect a player.** Every outcome of `/client/log` is
`200 {ok, accepted}` — a refused batch reports `accepted: 0` rather than a 4xx, because a
4xx teaches a client to retry and a client retrying a malformed batch retries it forever.
The push to Loki is `void`-ed, never awaited, so a log store that is down or slow cannot
delay a response by a millisecond. And the client-side logger swallows its own failures
entirely: a logger that surfaces its own breakage to a player has become the bug it was
installed to find.

**4. A device clock is not a clock.** Client entries carry client timestamps, and a
browser's clock can be wrong by years — forward past Loki's future-sample rejection, or back
past its retention window, either of which drops the batch at the store with a 400 nobody at
our end is watching for. So a client timestamp is never used directly: the server converts
each entry to an AGE relative to the client's own send instant, bounds that age, and
subtracts it from the SERVER's clock. Relative timing inside a session survives; an absurd
device clock cannot push anything outside the ingestible window.

**5. The account id is written by the server or not at all.** `/client/log` needs no
session — the errors most worth having are the ones that happen INSTEAD of a login, and
gating on a session would collect logs from exactly the players whose client is working. So
when a bearer token is present the account is resolved from it, server-side, and a body
field claiming an account is ignored. The one field that says whose session this was must
not be the one field anybody can set.

### What was scaled down from funny, and what was left behind

funny runs two client channels: a **targeted** one behind four feature flags with a
per-player allowlist, and an **anomaly** one with six typed event kinds, per-type cooldowns,
a device-context envelope and a localStorage crash sentinel. Neither is ported whole.

- **The targeting is not ported at all**, because this project has no feature-flag system
  and building one to gate a logger is the wrong order. One always-on channel instead,
  made safe by caps rather than by an allowlist: 200 entries per request, 1000-char
  messages, a per-IP rate limit, a bounded body, and the fixed label set above. funny's own
  audit of its unguarded endpoint (`claudedocs/server-audits` (funny)) found ~200× amplification
  into its store from a single request; those caps are that lesson applied before rather
  than after.
- **The anomaly channel's TRANSPORT is ported verbatim, and it is the single most
  important line here**: `fetch(..., { keepalive: true, credentials: 'omit' })`, never
  `navigator.sendBeacon`. `sendBeacon` always sends credentialed, which makes the browser
  require `Access-Control-Allow-Credentials: true` — and `routes/http.ts` answers
  `Access-Control-Allow-Origin: *`, which by specification cannot be combined with
  credentials. The client is on `b.gamestao.com` and this server on `bb.gamestao.com`, so
  every send is cross-origin. Getting it wrong makes the exit flush silently never land,
  which is precisely the report you most wanted.

  > **Amended 2026-09-09 (design/21 Phase A), and it is the other half of this same bullet.**
  > `keepalive` protects a request the page has already STARTED — it does nothing for a request
  > still waiting on a CORS PREFLIGHT. The shared `CORS` block in `routes/http.ts` set no
  > `access-control-max-age`, so a browser cached no preflight and every flush was an `OPTIONS`
  > followed by a `POST`: observed one-for-one in live traffic. On the exit path that is two
  > sequential round trips behind an unloading document, which is the same failure this bullet
  > exists to prevent, reached a different way. `access-control-max-age: 600` fixed it — verified
  > live as one preflight for three POSTs — and every other route on this server gets the same
  > saving, since the block is shared.
- **The heartbeat is ported**, and is more load-bearing here than its five lines suggest:
  an idle log store and a broken one draw the same empty dashboard. funny ran for months in
  exactly that state. Every process logs `heartbeat` once at start and every five minutes,
  at `info` — deliberately not `debug`, so a deployment quieting things to `warn` cannot
  silence the one line that proves the pipeline works.

### Two facts about the host that shaped the deployment

Neither is about observability; both would have been bugs if ignored.

- **Service names are `obs-`prefixed because the network is shared.** This compose project
  joins the host's `docker_default`, and compose publishes each service NAME as a network
  alias on it. The box's owner already runs their own Loki, Grafana, Prometheus and Promtail
  there under exactly those names. A service called `loki` would put two containers behind
  one DNS name — their collector's pushes landing in our store, or ours in theirs,
  intermittently, with nothing failing anywhere.
- **Their collector already reads our containers, and this stack cannot change that.**
  Their promtail scrapes the Docker socket unfiltered, so every line ours have written is
  already in their store. Ours does the opposite deliberately — discovery is filtered to
  `wnet-test-*` twice over — but the asymmetry is theirs to fix, not ours.
  server/deploy/README.md §8 records it rather than leaving it to be discovered.

### Still open

- **No alerting.** Everything here is pull: somebody has to open a dashboard. The gap that
  matters is `bb_billsvc_outbox_pending` — a count that stops falling means players have
  paid for things they do not own, with every container green — and `up` on the two scrape
  targets that are the box owner's exporters. Deliberately not guessed at: an alert needs a
  destination somebody actually reads, and this project has none yet.
- **No trace correlation.** funny threads a `roomId` across its services so one match can be
  reconstructed with `| logfmt | roomId="…"`. The fields exist here in some lines and not
  others; making it a rule is a pass through every call site, and worth doing the first time
  a cross-service question is actually hard to answer.
- **Client logs are `warn` and above.** The ring buffer holds everything, so the lines
  leading up to a failure are captured, but only the tail from `warn` up is sent. Lowering
  it is a volume decision that needs a real traffic number, and there is not one yet.
- **Only the web build reports a real build version.** Every batch carries a `ver` field so
  "is this error only on the new build?" has an answer, and it resolves for `web` from the
  baseline the reload watcher already fetches. It is `unknown` on the other two, for reasons
  that belong to those targets rather than to this one: the WeChat config never runs the
  version-manifest plugin, and the portal build is served from a sub-path while the manifest
  URL is absolute, so the fetch 404s there (a pre-existing property of the reload watcher —
  design/20's no-self-managed-reload rule is why it was never fixed). Closing either means
  changing that target's build, not this layer.
