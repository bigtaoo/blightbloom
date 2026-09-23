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

This file is the **index, the path convention, the locked decisions, and §8–§9**. The ten numbered
sections' substance lives in [`design/serverplatform/`](serverplatform/), each part under 1000
lines. The doc had reached 1,039 lines in one file.

Code comments cite this path by SECTION NUMBER — **`design/19 §4`**, `design/19 §7, ROADMAP 8.5` —
so the map below is keyed by number and every `§N` lands in one hop. The numbers are the stable
address: **do not renumber a section**, and a new one takes the next free number rather than
slotting in. §8 (*Deliberately not built*) and §9 (*Open questions*) stay in this file because
they are the doc's live scheduling surface and the shortest thing a reader comes here for.

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

  > **There are five now (2026-09-09), and the count is the only part that went stale.** The
  > backup worker (§"Backups") and the ops console (`adminsvc`, design/21 §3.1) both arrived
  > later. Neither is a PLANE: this bullet is about where a player's request may be served
  > from, and both additions are things no player ever talks to — the worker serves nothing at
  > all, and the console is a separate origin behind its own credential precisely so that
  > admin routes do not inherit matchsvc's "public unless it remembers not to be". So the
  > decision the bullet records — that login and accounts stay inside the control plane rather
  > than becoming a fourth plane — still holds, and is what §7's superseding note leans on.
  > Annotated rather than rewritten, because "not five" was an argument somebody made and the
  > reasoning is worth more than a corrected number.
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

## The sections

### [§1–§3 — the planes, entitlements, and the trust seam](serverplatform/01-the-planes-and-the-trust-seam.md)

What the two original planes were, the defects real money turned from tolerable into wrong, and the seam that separates a player-facing call from a service-to-service one.

- **[§1. The two planes today, and the two defects in them](serverplatform/01-the-planes-and-the-trust-seam.md#1-the-two-planes-today-and-the-two-defects-in-them)** — Control plane and data plane as they shipped, and what stops being tolerable once a SKU exists.
- **[§2. Entitlements move server-side — SHIPPED 2026-09-04](serverplatform/01-the-planes-and-the-trust-seam.md#2-entitlements-move-server-side--shipped-2026-09-04)** — `/account/meta` accepted a client-authored blob; `meta_state` becomes a cache.
  - [What the build settled that the plan left open](serverplatform/01-the-planes-and-the-trust-seam.md#what-the-build-settled-that-the-plan-left-open)
- **[§3. The internal trust seam — SHIPPED 2026-09-04](serverplatform/01-the-planes-and-the-trust-seam.md#3-the-internal-trust-seam--shipped-2026-09-04)** — A timing-safe shared-secret header, in its own namespace, and the routes it closes.
  - [What building it changed (2026-09-04)](serverplatform/01-the-planes-and-the-trust-seam.md#what-building-it-changed-2026-09-04)
  - [Exactly-once settlement — SHIPPED 2026-09-05](serverplatform/01-the-planes-and-the-trust-seam.md#exactly-once-settlement--shipped-2026-09-05)
  - [The ladder gate stops asking the players — SHIPPED 2026-09-05](serverplatform/01-the-planes-and-the-trust-seam.md#the-ladder-gate-stops-asking-the-players--shipped-2026-09-05)

### [§4–§5 — billing](serverplatform/02-billing.md)

The tables money is recorded in, and the four platform adapters plus the stub that lets the whole path be proven without a merchant account.

- **[§4. Billing: the data model — SHIPPED 2026-09-04](serverplatform/02-billing.md#4-billing-the-data-model--shipped-2026-09-04)** — `orders` / `receipts` / the append-only `ledger` / `deliveries`, and why money gets its own database file.
- **[§5. IAP adapters and the dev stub — SHIPPED 2026-09-04](serverplatform/02-billing.md#5-iap-adapters-and-the-dev-stub--shipped-2026-09-04)** — One `verifyReceipt` port, four real platforms behind it, and a stub that is not a bypass.

### [§6–§7 — topology and operations](serverplatform/03-topology-and-operations.md)

How a client finds a gameserver, and everything that has to be true for a human to run this.

- **[§6. Topology: `GameRegistry`, deferred but shaped now](serverplatform/03-topology-and-operations.md#6-topology-gameregistry-deferred-but-shaped-now)** — The gameserver's address becomes a lookup, so the one-box case stops being an assumption.
  - [Shipped 2026-09-05 — the static branch, and what building it settled (ROADMAP 8.6)](serverplatform/03-topology-and-operations.md#shipped-2026-09-05--the-static-branch-and-what-building-it-settled-roadmap-86)
- **[§7. Operations — SHIPPED 2026-09-05](serverplatform/03-topology-and-operations.md#7-operations--shipped-2026-09-05)** — Record what happened, tell a human, never act: webhook evidence, reconciliation, the grant audit, the review queue.
  - [Backups — SHIPPED 2026-09-07](serverplatform/03-topology-and-operations.md#backups--shipped-2026-09-07)

### [§10 — observability](serverplatform/04-observability.md)

One store for both halves: the backend's logs and the browser's.

- **[§10. Observability: one store for both halves — SHIPPED 2026-09-09](serverplatform/04-observability.md#10-observability-one-store-for-both-halves--shipped-2026-09-09)** — Loki / Alloy / Prometheus / Grafana in the backend's own compose.
  - [The five decisions worth recording](serverplatform/04-observability.md#the-five-decisions-worth-recording)
  - [What was scaled down from funny, and what was left behind](serverplatform/04-observability.md#what-was-scaled-down-from-funny-and-what-was-left-behind)
  - [Two facts about the host that shaped the deployment — BOTH EXPIRED 2026-09-15](serverplatform/04-observability.md#two-facts-about-the-host-that-shaped-the-deployment--both-expired-2026-09-15)
  - [Still open](serverplatform/04-observability.md#still-open)

**§8 and §9 are below, in this file.**

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

  **One thing outside billsvc becomes due at the same moment: the cluster's backup tier
  (2026-09-17).** The Atlas cluster has no point-in-time recovery, so an operator error is
  recoverable only to the last daily NDJSON cycle. That is a deliberate trade while the
  irreplaceable data is two accounts and a rollup table; it is a different question once a
  settled payment can fall inside the window a restore discards, because `ledger`/`receipts`
  then stop being reconstructible from anything this project holds. **The trigger is the first
  real payment settling, not the credential arriving** — and PITR is a tier change with a bill
  attached, not a checkbox, which is why it is written down as a trigger instead of being done
  now. Reasoning in `server/deploy/README.md` §7 rather than duplicated here.

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
  **`POST /store/order` also spends a per-IP budget since 2026-09-22** (`ORDER_RATE_LIMIT`, thirty
  in ten minutes — the same number `/auth/register` uses, because both bound a write into a
  database that is not this process's). The session gate bounds WHO may reach the billing plane
  and nothing bounded HOW OFTEN: a session costs one registration and is good for thirty days, so
  the "requiring a session is what keeps this from being a free unmetered amplifier" argument in
  the route's own header was load-bearing for *anywhere* and silent about *how much*. The budget
  is spent before `requireAuth`, since resolving a session is itself a database read any caller
  can ask for; the two GETs stay unbudgeted, `GET /store/order/:id` because `StorePurchase.poll`
  calls it on a timer while a player watches a payment resolve.
- Refund handling is specified only to the extent of "the ledger is append-only and a reversal is
  a new row". What a revoked character does to a ladder history is unanswered.
- ~~SQLite stays the answer until there are two control-plane processes.~~ **Reversed
  2026-09-15** (`design/16-accounts.md`, volumes 66–67): the owner's call moved all four stores
  to a MongoDB Atlas cluster. The argument below was never refuted — its PREMISE was replaced,
  which is a different thing, and 16 records both rather than overwriting one with the other.
  The original text, kept because the next person to propose a storage change should read what
  this one cost: SQLite stays the answer until there are two control-plane processes. That, not revenue, is the
  signal to revisit.

