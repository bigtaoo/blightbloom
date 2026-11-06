# 22 — Launch readiness

What stands between the current build and Stage 3 (*"Ship it. Payments go live, store pages,
real acquisition"* — `ROADMAP.md`, "Product stages"). Written 2026-10-16 as an audit of the
docs **checked against the code**, not a re-statement of them: two of the gaps below (the web
checkout client, the WeChat revenue path) are recorded nowhere else, because each half of the
system was documented as done from its own side.

> **How to read this.** Every item is tagged by who can close it. **ENG** is repository work an
> agent can do. **OWNER** needs a real account, credential, legal filing or a real person, and
> no amount of code closes it. **DECIDE** is a product call that has to come before either.
> When an item closes, strike it through and say where it landed — do not delete it; a gap list
> that only ever shrinks silently is how `design/04`'s device items lost their provenance.

## Where each channel stands

| Channel | Playable today | Sells anything | What it is missing to launch |
| --- | --- | --- | --- |
| **Web** (`b.gamestao.com`) | Yes, live, auto-deployed from `main` | No | The Paddle checkout end to end (§1), legal pages that admit a payment processor (§1.4), a store listing somewhere (§4) |
| **CrazyGames** portal | Yes, built and verified on the SDK's `local` mode | No, by platform rule (`hostKind.ts`) | The upload and review, and every behaviour that only exists on a registered domain (§2) |
| **WeChat** mini-game | Yes in the simulator; the owner reported a real-device run on 2026-09-17 | No (`storePlatform.ts` returns `null` on `wx`) | A revenue decision (§3.1), the regulatory filings (§3.2), the device checklist (§3.3) |
| **Playgama** sandbox | Built (`npm run build:playgama`), archive passing the console's check (Bridge 2.4.1) and the sandbox published on 2026-11-06; single-player, offline | No (no in-app products) | Nothing for the test in §4.1; it is a measurement, not a launch |

Engineering-wise the game is in Stage 2 (polish), with 90/90 coverage, five PvE chapters,
the PvP battle royale and co-op all shipped. **Nothing below is gameplay.** The launch is
blocked on money, paperwork and players.

## 1. Payments: Paddle (web only)

ROADMAP Phase 9 reads as "9.1–9.3 code shipped 2026-09-26, not live", and the server half is
exactly that. The audit found the **client half was never built**.

### 1.1 ~~ENG — the web store still asks for `stripe`, and nothing opens Paddle.js~~

> **BUILT 2026-10-16 on `feat/paddle-web`, not yet merged.** `StorePlatform` is
> `'paddle' | 'dev'` and the web branch returns `'paddle'`. `client/src/platform/paddleCheckout.ts`
> adds Paddle.js's script tag on the first BUY only (never at boot), initialises it once, and
> opens the overlay with the one price and `customData: { orderId }`. `StorePurchase` takes the
> handoff as an injected `checkout` (it is pure-layer); the overlay's `checkout.completed` only
> moves the screen to a pending line (`store.confirming`) and the poll still waits for the
> signed webhook. Two new refusals have their own copy in all eight locales: the overlay closed
> unpaid (`checkout-closed`, worded so it does not claim nothing was charged) and the script
> could not load (`checkout-unavailable`). The server now also hands out the Paddle.js **client
> token** and its environment in the `paddle` payment block (`BB_PADDLE_CLIENT_TOKEN`, read
> beside the API host so the two cannot disagree), and the block stays `configured: false`
> until both the SKU's price id and the token exist. The original finding follows.

`detectStorePlatform` in `client/src/platform/storePlatform.ts` returns `'stripe'` for every
real web host, and its `StorePlatform` type is `'stripe' | 'dev'` — Paddle is not a value the
client can name. There is no Paddle.js loader or overlay checkout anywhere in `client/src`.
The server is ready for it: `paymentParamsFor('paddle', …)` in
`server/src/billsvc/paymentParams.ts` already returns `{ priceId, customDataOrderId }` with the
note *open Paddle.js checkout with items `[{ priceId, quantity: 1 }]` and customData
`{ orderId }`*, and `server/src/billsvc/paddle/webhook.ts` joins the signed
`transaction.completed` back to the order through `custom_data.orderId`.

So even with every OWNER item in §1.3 done, the web store today opens an order on a platform
with no credentials and nothing can be bought. Done means: `StorePlatform` gains `'paddle'`
and the web branch returns it; the Forge's store opens the overlay from the `payment` block;
the overlay's success event only shows a pending state (the webhook, not the browser, settles
the order — the same rule every other platform follows); the stale `stripe` wording in the
file's header comment is corrected. Paddle.js is a third-party script, so it loads only when
the store opens, never at boot (the first-download budget, roadmap volume 145).

### 1.2 ~~ENG — the webhook route is not public~~

> **BUILT 2026-10-16 on `feat/paddle-web`, not yet merged.** `server/caddy/Caddyfile` has an
> `@paddleWebhook` matcher, `method POST` and `path /webhook/paddle` exactly, proxied to
> `billsvc:8789` ahead of the catch-all. `server/test/deploy.caddy.test.ts` pins it: the matcher
> holds exactly those two lines, it is the only `reverse_proxy` to billsvc, and it comes before
> the catch-all. The destination URL for §1.3 is `https://<domain>/webhook/paddle`.

`server/deploy/README.md`: *billsvc is not reachable through Caddy today*. Paddle's
notification destination needs a public URL for `POST /webhook/paddle`. Done means one
`server/caddy/Caddyfile` route exposing **that path only** — every other billsvc route stays
internal, which is the whole point of the 8.1 trust seam.

### 1.3 OWNER — the Paddle account side

From ROADMAP 9.1–9.4, gathered in one place:

- the notification destination and its secret → `BB_PADDLE_WEBHOOK_SECRET`;
- **eleven** Paddle Prices (ten blueprint SKUs and `char.skirmisher`, per
  `server/src/billsvc/skus.ts`) and their ids → `BB_PADDLE_PRICE_IDS`;
- an API key → `BB_PADDLE_API_KEY` (reconciliation's order lister);
- a client-side token (Developer tools → Authentication) → `BB_PADDLE_CLIENT_TOKEN`, which
  Paddle.js needs to open the overlay (added by §1.1; public by design, but bound to one
  environment, so the sandbox and live tokens are not interchangeable);
- Paddle's own approval of `b.gamestao.com` as a selling domain (it reviews the site before
  live checkout; confirm its current checklist — it is expected to ask for the pricing, terms
  and refund pages in §1.4);
- a first real sandbox purchase, and a first sandbox refund, walked through to the
  entitlement appearing and being revoked.

### 1.4 ENG + OWNER — the legal pages say nothing is sold

`client/public/privacy.html` §5 and `client/public/terms.html` §4 both state that the game
sells nothing and no payment processor is connected. Both are true today and become false the
moment §1.1 ships. They need a payments section naming Paddle as the merchant of record, the
refund policy decided in ROADMAP 9.3 (an approved refund revokes the item; ladder history is
untouched), and what Paddle receives. The wording is the owner's to approve; drafting it is
ENG.

**DRAFTED 2026-10-16 — below, for the owner's approval; not yet in the live pages.** The live
§5 and §4 stay as they are until the store actually sells, because today they are the true
ones. Two facts need checking before this goes live: what of Paddle's webhook payload billsvc
keeps (it stores the raw event for the review queue, so whatever Paddle puts in
`transaction.completed` is ours to declare), and the exact merchant-of-record sentence Paddle's
domain review asks for.

*Privacy Policy §5 "Payments" (replaces "No payment data"):*

> Purchases on our own website are sold by **Paddle.com**, our reseller and merchant of
> record: Paddle is the seller named on your receipt, takes the payment and handles sales tax.
> You enter your payment details into Paddle's checkout window, never into the game, and we
> never receive your card or bank details. Paddle processes the data it needs to complete the
> sale (for example your email address, payment method and billing country) under its own
> privacy notice. From Paddle we receive a record of the sale: the item, the price and
> currency, Paddle's transaction and customer identifiers, your billing country, and the order
> number the game attached, which is how the item reaches your account. We keep these records
> for as long as tax and accounting law requires (legal obligation, Art. 6(1)(c) GDPR), and
> use them to deliver the item and to answer refund and support requests (contract,
> Art. 6(1)(b)). Purchases are not available on game portals or in the WeChat version.

*Terms of Service §4 "Purchases" (replaces "Blightbloom currently sells nothing"):*

> On our own website you can buy individual items — named blueprints and characters — for
> real money. Each is a one-time purchase that is added to your account permanently; there is
> no virtual currency, no subscription and no randomised item. You need an account to buy, and
> purchases are not offered on game portals or in the WeChat version.
>
> Our order process is conducted by our online reseller **Paddle.com**, the merchant of record
> for all our orders. Paddle handles payment, sales tax, receipts, refunds and order-related
> customer service, and its own checkout terms apply to the sale. The price shown in Paddle's
> checkout is the price you pay.
>
> The item is delivered to your account once Paddle confirms the payment, usually within
> seconds. If you are a consumer in the EU, you have a right of withdrawal; because the item is
> digital content supplied immediately, Paddle's checkout asks you to agree to immediate
> delivery and to acknowledge that this ends the withdrawal right. Refund requests go to
> Paddle (the link is on your receipt) or to support@gamestao.com. If a refund or a chargeback
> is approved, the item is removed from your account. Results you earned while you owned it,
> such as your ladder rating and match history, are not changed.

### 1.5 ENG — the SKU table is a CNY placeholder

> **Blocked on §1.3, deliberately not touched 2026-10-16.** The prices are the owner's, set in
> Paddle; writing guessed numbers here would only trade one wrong table for another.

`amountCents` is a record, not an authority (ROADMAP 9.2), so a mismatch is never a
rejection — but until the table matches Paddle's base prices **every** Paddle order reports an
`amount-mismatch` and the reconciliation review queue is noise. Update the table once §1.3's
prices exist.

## 2. CrazyGames

The integration is done and recorded in `design/20` "What remains". What is left is the part
that only a registered domain can answer.

- **OWNER — the upload**, its listing, thumbnails and the review round trip. At submission,
  **ask about `getUser`**: the SDK calls it BETA on every call and the whole silent login rests
  on it.
- **OWNER — set `BB_CG_GAME_ID`** on the deployed matchsvc once the game id exists. Until then
  `/auth/portal` accepts a user token minted for any game on the platform.
- **OWNER — read `__portal.diagnostics()` on the real page**: whether the 320×50 banner fills,
  whether the rewarded ad plays, which of the five account states it reports, whether the
  invite button and `updateRoom` render.
- **ENG + OWNER — the data declaration.** It was made on the premise that a guest's data never
  leaves the browser, which stopped being true when analytics shipped (`design/21` §5). Revisit
  it before the upload, and check `/terms` for the same sentence. **ENG half DONE 2026-10-16 on
  `feat/legal-data`, not yet merged:** `design/21` "The portal data declaration — draft
  answers" gives one answer per question, each traced to a `privacy.html` section. `/terms` was
  re-checked: it makes no collection claim, so analytics needs no change there; its stale
  sentence is §4 "Purchases", which is §1.4's. **OWNER:** paste the answers into the form.
- **ENG — measure what the Basic Launch grades. BUILT 2026-10-16 and merged into
  `15.10.2026` (`cbf8f62`), not yet deployed** (`design/21` §2.9). The Grafana half followed on
  `feat/legal-data` (not yet merged): a "Launch metrics" row on the analytics dashboard (open
  funnel, open-to-play conversion, boot p50/p90, day-0 playtime); segments stay on the console
  card, since one Prometheus series per channel × device would be cardinality for nothing. The platform judges conversion
  to gameplay, average playtime and D1/D7. Before this, only D1/D7 was measurable, and nothing
  could be split by channel or device. There is now a `page_open` beacon in `index.html`, so the
  visitor who leaves during the download is counted, along with the boot time. Each visit
  carries a source tag (`?src=` or the referrer's domain) and a phone/tablet/desktop + OS +
  browser split. Day-0 visible playtime is measured, and a "Launch metrics" console card pools
  all of it by segment. The privacy policy names the new fields; the data declaration above
  has to as well.
- ~~**ENG — the avatar.** The portal's requirements name username *and* avatar; only the
  username is drawn.~~ **BUILT 2026-10-16 on `feat/portal-avatar`, not yet merged**
  (`design/20`): a round picture beside "Hi, {name}", https-only, and every failure (CORS, a
  bad image, a sign-out mid-load) ends with no picture rather than a broken one.
- ~~**ENG, worth doing before launch — `SDK.data`.** Inside a third-party iframe `localStorage`
  can be blocked, and a guest's progress then silently does not persist. The stores read
  synchronously at boot, so this is a boot-ordering change, not a swap (`design/20`).~~
  **BUILT 2026-10-16 on `feat/portal-sdk-data`, not yet merged** (`design/20`, the `SDK.data`
  bullet): the portal build adopts `SDK.data` as its storage before any store reads, and the
  privacy policy says so. **OWNER:** the SDK persists it only when "Progress Save" is enabled
  for the game in the developer portal — turn it on at upload.

## 3. WeChat mini-game

### 3.1 DECIDE — the WeChat build has no way to earn

`storePlatform.ts` returns `null` on `wx` (an external web checkout is forbidden there, and
the server's `wechat` platform has no merchant credentials), and **no WeChat ad API is called
anywhere in the client** — no rewarded video, banner or interstitial. Launching this build as
it stands is launching it free. That is a legitimate choice, but it has to be made, because it
decides §3.2: a free build and a build with in-game purchases are filed differently. The two
realistic answers are rewarded ads through WeChat's own ad unit (the portal's rewarded-ad
seam in `design/20` is the model), or WeChat virtual payment, which needs everything in §3.2
plus a merchant account.

### 3.2 OWNER — regulatory filings, recorded nowhere in this repository

Nothing in `design/` mentions any of these. They are listed as **questions to confirm against
WeChat's current rules**, not as settled requirements:

- **Software copyright registration** for the game.
- **Game publishing licence (版号).** Required for in-game purchases; whether a free or
  ad-only build can go live without one, and on what terms, has to be checked against the
  rules at submission time.
- **ICP filing** for the mini-game itself.
- **The request domain.** `https://bb.gamestao.com` must be on the mini-game's server-domain
  whitelist (`design/04` item 18), and mainland platforms generally expect a whitelisted
  domain to carry an ICP filing. The backend runs on a Hetzner box outside mainland China
  behind Cloudflare, so **this may be a structural blocker** — the answer could be a separate
  mainland-hosted endpoint. Confirm first; it is the item most likely to change the plan.
- **Real-name verification and anti-addiction limits for minors**, the **age-appropriateness
  notice**, and the **healthy-gaming advisory** on the boot screen. The platform supplies
  parts of this; what the game itself must show has to be confirmed.

### 3.3 OWNER — the device checklist

`design/04` items **2, 3, 4, 5, 6, 11 and 18** are still unticked. The owner's 2026-09-17
report closed Stage 1's device question, but it recorded no per-item answer, so none of them
can be ticked from it. Each is a short read on a handset — the lowest base library and its
audio (2), whether a low-end Android holds its frame cap (3, readable from the settings
button since `qualityWatchdog.ts`), WebGL2 vs a silent WebGL1 fallback (4), touch feel (5),
lighting cost (6), whether the 4 MB package limit is raw or compressed (11), and whether a
request reaches `bb.gamestao.com` from a real account (18, which depends on §3.2's domain
question). Write down what each one answered.

## 4. Players and store pages

- **OWNER — a closed multiplayer test with people who are not the developer.** Stage 1's
  fourth item was scoped out on 2026-09-17, not answered. Three things still cannot be known
  without it: whether the big chest's coordination ever happens (one seat cannot test it),
  whether the juggernaut's PvP lead is real or the bot's (volume 128 attributes it to the
  bot), and the first-day funnel `design/21` §2.7 now measures — which is only meaningful on
  players who did not build the game. Keep it closed: an open launch is a first impression
  that happens once.
- **OWNER — store pages and acquisition.** No listing exists on any channel: no description,
  screenshots, trailer, icon set or keywords, in any of the eight shipped locales. The
  CrazyGames listing in §2 is the first of these; the web build has no storefront at all.

### 4.1 OWNER — the Playgama sandbox test: is the core loop worth more work?

Added 2026-11-06. The cheapest way to put the game in front of strangers: Playgama's sandbox
gives an unmoderated page and a one-off traffic bonus. It answers a narrower question than the
closed multiplayer test above — *does the single-player run hold a stranger?* — and it
answers it in days.

**What ships.** The `playgama` build target (`client/vite.playgama.config.js`,
`client/src/main.playgama.ts`, `client/src/platform/playgama/`). The sandbox's CSP blocks our
backend, so the build is offline: PvE only, no account, no co-op/PvP/squad routes
(`hostKind.canPlayOnline`), no outbound links, no Escape binding. Saves go through Bridge
storage, analytics through Bridge, and the interstitial is asked only when a run ends, with a
60 s cooldown in the Bridge config the build emits (`BRIDGE_CONFIG` in
`client/vite.playgama.config.js`).

**Console state (2026-11-06).** Game "Blightbloom" created as a draft; archive
`blightbloom-0.0.1-playgama-2026-11-06` uploaded, unpacked, Bridge found, check PASSED. The
sandbox was **published** the same day on the owner's yes (`https://playgama.ai/play/4g34tdpnqftrct`),
after the form (category `action`, eight languages, desktop/Android/iOS, landscape) and the
three covers (composed from `client/public/ui/lobby_bg.jpg` and the three `lobby_hero_*.png`)
were filled in. **No traffic has been spent**: `start_sandbox_traffic` is one-way and waits on
its own yes. Until it runs, the sandbox has only the players its link reaches.

A second archive, `blightbloom-2026-11-06-first-run-autostart`, was uploaded the same day with
the first-boot autostart (design/20 "Onboarding, second pass"): a new player lands in the first
run, not on the menu, which is what the 60 s survival gate below assumes. It sits in the form
beside the first one. Its check PASSED (Bridge 2.4.1) and the sandbox was **re-published** with
it on the owner's yes, same link, so every player the test measures starts in the first run.

**Ported from the sibling project `jump` (2026-11-06, the next archive).** Four pieces:

- **Hold while the iframe is 0×0.** Portals mount the game hidden and size it later. While the
  window reports a zero size, `PlaygamaSession` holds an `'unsized'` reason: the ticker and sim
  stop and audio mutes, and the hold lifts on the first non-zero `resize`
  (`PlaygamaSession.watchViewport`, called after `session.ready()`).
- **Away-pause.** Window blur or a hidden tab pauses a local run (`gameWiring.ts`, the
  `canPause` guard), so a player who tabs away does not come back dead.
- **Arrow to the next room.** Once a room is cleared (activated, no live enemy, wave schedule
  done), a chevron orbits the player after 1.2 s and points along open doors to the nearest
  unentered room, or to the exit room once all are entered (`ui/nextRoomGuide.ts`, pure;
  `scene/NextRoomArrow.ts`). It hides within 72 px of the door.
- **`performance_sample`.** Playgama's frame-time event (`platform/playgama/perfSample.ts`):
  30 s windows of active, visible play, with p10 fps, frame-time percentiles, long-frame counts,
  errors, lost contexts and long tasks, tagged with `build_version` (`VITE_GAME_VERSION`,
  `<package version>+<short sha>`, also set as `bridge.gameVersion`). It goes straight to
  `bridge.track`, not through `net/analytics.ts`.

These four shipped as archive `blightbloom-0.0.1+935340c-next-room-arrow-r2` (check PASSED,
Bridge 2.4.1), re-published to the sandbox on the owner's yes, same link. The first upload of
that build failed the check with `BRIDGE_NOT_INITIALIZED`. The code was fine; the zip was not.
Windows PowerShell 5.1's `Compress-Archive` writes entry names with backslashes
(`assets\index-….js`), so the unpacked page could not load its own scripts. Zip the build with
something that writes `/` (Python's `zipfile`, 7-Zip), and check with `unzip -l` before
uploading.

The third onboarding pass (design/20, "Onboarding, third pass") followed the same day, after
the owner's own first run ended inside ten seconds with no guidance seen. It makes the entry
room a warm-up with two `basic` mobs in the far corners (ENGINE_VERSION 89) and shows each
lesson in a large top-centre panel that waits for the player. It shipped as archive
`blightbloom-0.0.1+40382ff8-onboarding` (check PASSED, Bridge 2.4.1), re-published to the
sandbox on the owner's yes, same link. No sandbox traffic was spent on either earlier build,
so the gates below still read from a clean start.

**The gates.** Read after the traffic bonus is spent, on Playgama's own telemetry:

| Measure | Pass | Why this line |
| --- | --- | --- |
| Sessions | n ≥ 300 | Below this, the rates below swing by ±5 points on noise alone |
| Survives 60 s of the first run | ≥ 60% | The first minute is the hook; losing 4 in 10 there is an onboarding problem, not a depth one |
| Day-1 return | ≥ 10–15% | The usual floor for a web casual game worth iterating on |
| Runs on day 0, median | ≥ 2 | A player who starts a second run has accepted the loop |

**How to read the result.** All four pass → the loop is worth the launch work in §1–§3.
Sessions pass and the 60 s line fails → fix the first minute (onboarding, first wave) and
retest; do not read D1 yet. The 60 s line passes and D1 or runs-per-day fail → the loop does
not hold, and that is a design question before any channel work. Under 300 sessions → no
verdict; buy more traffic or wait, and do not tune on it.

## 5. Suggested order

1. **§3.2's domain question first.** It is the only item that could change architecture.
2. **§1.1, §1.2, §1.4 and §1.5 (ENG)** in one pass, against the Paddle sandbox, so §1.3 can be
   exercised the day its credentials exist. *(2026-10-16: §1.1 and §1.2 built, §1.4 drafted,
   §1.5 waits on §1.3's prices. Nothing has run against a real sandbox yet — that needs §1.3's
   client token and one price id.)*
3. **§4.1's Playgama sandbox test first** (days, no paperwork), then **§4's closed test**, on
   the web build, in parallel with the paperwork.
4. **CrazyGames (§2)** — the cheapest real launch: no payments, no filings, the SDK handles the
   ads.
5. **WeChat (§3)**, once §3.1 is decided and §3.2 has answers.
