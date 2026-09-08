# Work log — 2026-09-05: the store, both halves

Volume 37. ROADMAP 8.8, in two passes on the same day: the CLIENT half (design/19 §4/§9's own
open item) first, and then the matchsvc PROXY the client half explicitly left open — the second
section below. Phase 8's operational half (volume 35) and its topology piece (volume 34) landed
the same day.

Indexed from [`../ROADMAP.md`](../ROADMAP.md). Design account in
[`../19-server-platform.md`](../19-server-platform.md) §3/§4/§9.

## The client buys through the billing plane (2026-09-05, client only, no engine bump)

### What was there

`ForgeActions.acquireBlueprint` (ROADMAP 2.4's monetization scaffolding) handed the player the
first purchasable blueprint for **free**, the moment the ACQUIRE button — or its `[B]` keyboard
shortcut — was pressed. That was always a scaffold, not a store: `design/19-server-platform.md`
§9 named the grant it produced as one that "survives until the next login and then vanishes",
because §2's server-side entitlements pass made `/account/meta` answer from its own table, and a
grant the client made to itself is invisible to it.

### What shipped

Four new client files, none of them touching `server/**`, `design/19`, or `ROADMAP.md` directly
during the pass — the wire protocol was pinned by the task rather than invented here, since the
matchsvc-side proxy for it is explicitly a later package:

- **`net/billing.ts`** — an injected-`fetch` wrapper over `GET /store/skus`, `POST /store/order`,
  `GET /store/order/:id`, shaped like `net/auth.ts`/`net/entitlements.ts`. Every response is parsed
  defensively: a SKU with no price is **dropped, not defaulted** (there is no fallback number here
  that is not a price the client invented), and `payment.configured` **fails closed** — anything
  that is not the literal boolean `true` means "this platform cannot take a payment", matching
  `server/src/billsvc/paymentParams.ts`'s own posture.
- **`platform/storePlatform.ts`** — the App-Store-3.1.1 gate. A web checkout inside an iOS build
  breaks Apple's anti-steering rule, and the WeChat mini-game has no merchant credentials to sell
  through either, so `detectStorePlatform()` returns `null` for both and the caller renders **no
  store entry at all**, not a disabled one. The `wx` check runs first and unconditionally, because
  the mini-game runtime injects DOM-shaped compat shims for libraries that probe for them
  (`game/match/gameQueryParams.ts` records the same trap with its always-empty `location.search`),
  so "has a document" alone would answer `true` there. `?store=dev` opts a web session into the
  server's dev stub — the one platform whose payment block is ever `configured: true`, and the only
  way to walk create → pay → webhook → delivered with nothing configured at all.
- **`controllers/StorePurchase.ts`** — the flow: list → order → poll → re-read ownership. Every
  dependency is injected, `sleep` included, so all eight outcomes (busy, not-logged-in,
  no-platform, not-configured, order-failed, payment-failed, timed-out, delivered) run with no
  network, no clock and no page. Two arms worth naming: `payment.configured === false` is reported
  as its own outcome and polls nothing, because the order is booked but nobody can pay for it and
  design/19's own reasoning is that a plausible-looking but unsigned payment block is a worse
  failure than an honest refusal; and a delivered purchase whose ownership re-read failed still
  reports **success** (`refreshed: false`), because the money moved and the entitlement exists —
  reusing `OnlineMatch.syncMetaWithSession`'s swallow-the-error shape here would have made that
  arm unreachable and told a paying player their purchase failed when it had not.
- **`screens/StoreScreen.ts`** — the screen. Every outcome code maps through an exhaustive
  `Record<..., TranslationKey>`, so a new code the flow can produce is a compile error here rather
  than silently falling through to generic copy. Rows render the server's `amountCents`/`currency`
  verbatim; nothing here derives, totals or discounts a price. A SKU already owned refuses locally
  before an order is booked — the one mistake on this screen that costs real money, since the
  server would happily take it for a second copy of something that grants nothing new.

### Where it plugs in

`Forge`'s ACQUIRE button and its `[B]` shortcut became STORE, opening a new `'store'` `Phase` —
a full phase rather than an overlay, because every forge key is guarded on
`phase === 'forge'` (`ForgeInput`), so a separate phase silences `[X] CLEAR LOADOUT` and the rest
of the table for free while a purchase is in flight, which an overlay would not. `gameAssembly.ts`
resolves the platform gate exactly once, at construction, and pushes it onto the Forge as a
`storeEnabled` flag; no screen decides for itself whether it may sell. `ForgeActions.acquireBlueprint`
is **deleted**, not deprecated — a guard test (`ForgeActions.test.ts`, "grants nothing for free")
drives every remaining forge verb and asserts none of them can widen what the account owns, so a
regression that reintroduced a free grant through some other path would still be caught.

### What was still open at the end of this pass — CLOSED the same day, in the section below

The three routes the client calls did not exist on matchsvc: `net/billing.ts` was hardwired to a
protocol billsvc alone answered, on its own process and port, with no proxy in front of it — so
this screen reached `ERR_CONNECTION_REFUSED` rather than a real account. Wiring
`GET /store/skus` / `POST /store/order` / `GET /store/order/:id` through matchsvc over §3's
internal trust seam was named here as the next package, and is
[the second pass in this volume](#the-proxy-that-answers-those-three-routes-2026-09-05-server-only-no-engine-bump).

### Tests

107 new client tests across four new test files, plus targeted updates to eleven existing ones
(`Forge.test.ts`, `ForgeActions.test.ts`, `ForgeInput.test.ts`, `ScreenFlow.test.ts`,
`ScreenNav.test.ts`, `gameWiring.test.ts`, `gameUiSound.test.ts`, `musicDirector.test.ts`,
`pureLayerBoundary.test.ts`, `viewportFit.test.ts`, `buttonCueConventions.test.ts`) whose fixtures
named the deleted `acquireBtn`/`onAcquire`/`acquireBlueprint` or needed a new `'store'` phase/screen
threaded through. Client suite 4933 → 5040 (241 files); `tsc --noEmit`, `check:filelength`,
`check:docpaths` and the 90/90 coverage gate all clean — `StorePurchase.ts` and `StoreScreen.ts`
land at 100%/95%+ lines/branches respectively, and `StorePurchase.ts` was added to
`pureLayerBoundary.ts`'s `PURE_FILES`: every dependency it has is injected, so the whole
create → poll → deliver chain — including its timed-out and delivered-but-unrefreshed arms — is
exercised with no network, no clock and no browser behind it.

Browser-verified against the real dev server: the STORE button renders only where
`storeEnabled` is true, `[B]` and the button both open the screen, and a guest reading it sees
"Log in first. Purchases belong to your account, not to this device." rather than a silent
no-op or a network error. One thing only the browser caught: `store.back`'s copy carried a `←`
glyph on top of the button's own `setIcon(icon_back)` arrow, rendering as "← ← FORGE" — fixed by
dropping the glyph from the string, matching `LoginScreen`'s bare-word back button.

### Left alone

- **The matchsvc-side `/store/*` proxy.** Named above — explicitly out of scope for this pass.
- **`meta/forge.ts`'s `acquireBlueprint`/`grantCharacter` exports.** Untouched. Only the
  `ForgeActions` controller wrapper that turned a button press into a free grant was deleted; the
  underlying transaction functions remain the reserved grant seam design/14/19 already describe,
  for whatever calls them once entitlement delivery reaches this side of the wire.
- **A character SKU.** `net/billing.ts`'s `SkuGrant` already carries `'character'` alongside
  `'blueprint'`, and `StoreScreen`'s owned-check and name lookup both handle it — but
  `server/src/billsvc/skus.ts` sells none yet, and which of the three launch characters is paid is
  still a product decision design/14 leaves to the store, not to this pass.

## The proxy that answers those three routes (2026-09-05, server only, no engine bump)

The other half of 8.8, and the last thing standing between the screen above and a purchase that
works. The client half shipped calling three routes **no process served**: `/store/skus`,
`/store/order` and `/store/order/:id` on matchsvc's own base URL. The billing plane answers a
different protocol, on a different port, in a different credential namespace.

### The three mismatches, confirmed before anything was written

| | client (`net/billing.ts`) | billsvc (`billsvc/server.ts`) |
| --- | --- | --- |
| **Path** | `/store/skus`, `/store/order`, `/store/order/:id` | `/skus`, `/order/create`, `/order/:id` |
| **Auth** | the player's own `Authorization: Bearer <session>` | `refuseUnlessInternal` — an `x-internal-key` |
| **Identity** | sends `{ sku, platform }` and deliberately nothing else | `createOrder` reads `accountId` **from the body** |

The third one is the load-bearing one, and it is why this is a proxy rather than a URL rewrite in
a config file. billsvc reading `accountId` off the request body is correct for an internal route —
its only caller was trusted. Exposed to a player's client it is a "charge somebody else's account"
parameter, and no amount of path rewriting fixes that.

### What shipped

`server/src/routes/store.ts` (one new route group, shaped like `routes/account.ts` — verify the
bearer locally, then do the work with the session's own `accountId`), plus three small pieces
around it:

- **`config.ts`** gains `billingPlaneUrl()` (`BB_BILLSVC_URL`, default `http://localhost:8789`,
  the exact mirror of `controlPlaneUrl()`) and `INTERNAL_CALLER_MATCHSVC`. billsvc's own
  `INTERNAL_CALLER_CONTROL_PLANE` became an **alias** of that constant rather than a second
  literal — the two label the same hop from its two ends, and an audit line is precisely where a
  hand-kept copy of a caller name goes quietly wrong.
- **`internalFetch.ts`** gains `collectBody` and `internalFetchJson`. Its first two callers — the
  ladder report and the delivery pump — read their real answer off a status code, so obligation 1
  ("always drain or cancel") was discharged by *cancelling* and the helper never returned a body.
  A proxy needs the bytes. `collectBody` READS the body instead, which is the same obligation
  discharged a different way rather than an exception to it: `res.text()` consumes the stream and
  releases the socket exactly as `cancel()` does. It is opt-in because buffering a body nobody
  will look at is pure cost. `internalFetchJson` adds the parse, and never throws on it — an HTML
  error page from something in front of billsvc must degrade to "no usable body", which is the
  same posture `net/billing.ts` takes on the other end of the same hop.
- **`matchsvc.ts`** dispatches the three routes and takes a `billing` option, the mirror of
  `BillsvcServerOptions.pump`, so a test can point the proxy at a stub plane without touching
  `process.env`.

### The five decisions

1. **`accountId` comes from the verified session, and the client's is never read.** `postOrder`
   builds its outbound body from three fields — the session's `accountId` plus the request's `sku`
   and `platform`. An `accountId` in the client's JSON is not overridden, not rejected and not
   logged; there is no code path along which it could reach `BillingService.createOrder`. Same
   shape as billsvc not reading `amount`: not reading a field beats reading and discarding it,
   because the version that survives someone adding a "pass-through" later is the one with no
   parameter to plumb.
2. **`GET /store/order/:id` is narrowed, and answers 404 rather than 403.** billsvc's
   `GET /order/:id` does not check ownership. Behind a proxy any logged-in player can reach, that
   turns an order id into a read of somebody else's purchase — their SKU, their price, their
   platform, their state. The order is compared against the session's `accountId` here, and a
   mismatch gets the SAME 404 a nonexistent id does: telling the two apart would confirm that a
   guessed id names a real order. It **fails closed** on a response carrying no `accountId` at
   all, so a billsvc that stopped sending the field breaks this route loudly instead of quietly
   serving every order to everyone.
3. **`/store/skus` requires a session even though billsvc's `/skus` is public.** Decided, not
   defaulted — and the reasons are written into the file so relaxing it is a decision too. The
   client never calls it without one anyway (`StorePurchase.loadCatalog` refuses with
   `not-logged-in`), so it costs no behaviour; one rule across all three routes means nobody has
   to remember which is the exception; and unauthenticated it is a free unmetered amplifier from
   the open internet onto the billing plane. The cost is named: a store that wants to show prices
   BEFORE login has to relax this, and that is a product decision.
4. **billsvc's 401 is NEVER relayed.** The mapping that is easy to get wrong and expensive when
   you do. billsvc refusing our internal key is *our* misconfiguration — an unset
   `BB_INTERNAL_KEY` in production, or two processes given different ones. Relayed verbatim it
   reaches `net/billing.ts` as a 401, which every caller reads as "your session is bad": a deploy
   mistake would present to every player as a login problem and to no operator as anything at
   all. It becomes a 502 plus a `console.error` naming the env var. Everything else splits the
   obvious way — a transport failure or a 5xx is a 502 with one player-facing sentence and no
   detail about which hop broke, while any other 4xx is relayed verbatim with billsvc's own
   message, because those are answers about the request and are the same answer on a retry.
5. **Nothing retries.** `retry` stays absent on all three routes. `POST /order/create` is not
   idempotent (a retry books a second order), and the two GETs are already retried — by a human,
   or by `StorePurchase.poll`'s ~90 s budget, which treats a thrown poll as one lost attempt
   rather than a failed purchase. The per-attempt timeout is 3 s rather than `internalFetch`'s
   5 s default, because the caller here is a player holding a screen open.

### Tests

Two new files, 32 cases, and they are split by what only each layer can produce.

`test/routes.store.test.ts` (25) is the unit layer over the three handlers with a faked
`AuthService` and an injected `fetchImpl`: no token / a token that resolves to nothing / a
non-`Bearer` header, on all three routes, asserting the hop is not even opened; Ada polling Bob's
order id and getting a 404 whose body contains neither Bob's account nor his SKU; the four
shapes of a response with no owner to check; an `accountId` planted in the request body, asserted
against the bytes that actually left; a refused connection, a 500, a per-attempt timeout, a 401
and a 403, a 200 whose body is HTML, a 200 whose JSON is `123`, and a 4xx with no usable `error`
string. Two of them exist for reasons that are easy to lose: one asserts the UNINJECTED config
path (every other case pins `billing`, which is exactly how a default goes untested), and one
drives the guard that keeps a floating proxy promise from taking the control plane down when the
response socket has already gone — reachable only through a fake `res` whose `writeHead` throws.

`test/store.proxy.http.test.ts` (7) stands up a real matchsvc and a real billsvc on two ephemeral
ports and drives them with `client/src/net/billing.ts` itself, imported through the `@dd/net/*`
alias — so the contract under test is the shipped one rather than a restatement of it. Three
things exist only there: that the path rewrite actually lines up; that the CORS preflight allows
`authorization` (design/16's browser-only bug, on the newest route group — node's fetch does not
enforce preflight, so this can only be asserted on a real `OPTIONS` response); and a whole
purchase with no merchant account anywhere — create through the proxy, "pay" through the dev
stub's webhook posted straight at billsvc, poll through the proxy until it reads `settled`, with
Bob's poll of Ada's settled order still 404. The last case takes billsvc down and asserts a 502
with `/health` still green, because the store going away must not take matchmaking with it.

Server suite 973 → 1004 across 44 → 46 files; 99.56% lines / 97.93% branches, `store.ts` at
100/100 on statements, functions and lines. `tsc --noEmit`, `check:filelength`, `check:docpaths`,
`check:logic` and the 90/90 coverage gate all clean.

### Left alone

- **The `entitlements` half of the loop.** Untouched: 8.7's outbox already delivers a settled
  purchase into `POST /internal/entitlements/grant`, and the client re-reads ownership through
  `/account/meta`. This pass adds no second delivery path, and the integration test stubs the
  pump's outbound fetch rather than exercising it, precisely so it is testing the proxy.
- **Order listing / purchase history.** billsvc has `ledgerFor(accountId)` and no route in front
  of it, here or there. `StoreScreen` does not ask for one, and design/19 §7 rules out an admin
  service, so a support read stays a `sqlite3` prompt for now.
- **A price display before login.** See decision 3 — the gate is deliberate and named.
