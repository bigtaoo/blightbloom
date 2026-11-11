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
storage, analytics through Bridge, and the interstitial is asked at each of the three natural
pauses `PlaygamaSession.naturalPause()` names — a run walked out of, a resume from the pause
menu, a restart from a result screen (2026-11-11c below) — each under its own placement id
(`AD_PLACEMENTS`), which `BRIDGE_CONFIG` in `client/vite.playgama.config.js` declares back to
Bridge along with the 60 s cooldown and a `preloadOnStart` for the commonest of the three
(2026-11-11e below).

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

The owner's next run of that build reported two things the same day. **The arrow shook while
the player moved:** it was posed from the player view's `curX/curY`, the tick-rate target the
view lerps toward, so it stepped 30 times a second around a smoothly drawn body. It is now posed
once per frame from the player's DRAWN ground position, after the camera's whole-pixel nudge
(`Scene.drawGuides`, called at the end of `GameLoop.updateCamera`). **The spawn looked empty:**
the entry room's two mobs stand ten grid from the spawn, off the edge of an 800 px frame. While
a room is fought, the same arrow now points at its nearest live enemy in the enemy red (after the
same 1.2 s delay), fading out as that enemy comes within 7 grid (224 px, on screen); once the
room is done it turns into the green door arrow, with the delay restarted so the drops get a look
first. Its bearing eases toward the target (90 ms time constant) instead of snapping: walking
between the two mobs flipped the nearest one, and the chevron jumped 32 world px round the body
in a single frame. Both fixes shipped as archive `blightbloom-0.0.1+f63ae5fa-guide-arrow` (check
PASSED, Bridge 2.4.1), re-published to the sandbox on the owner's yes, same link. Unlike the lessons, which only show on a player's first run, this arrow shows on every run.

The owner's run of that build answered with the next problem: **a bare arrow says nothing.** A
new player clicks, the click only shoots, and nothing says that WASD walks. Two changes:

- **The arrow carries words.** Under the player, unrotated, in the arrow's colour: "Enemies ahead
  — follow the red arrow" or "Room clear — follow the green arrow to the next room", plus a
  second line with the move keys ("Move: WASD or arrow keys", or the touch wording) until the
  player has walked 8 grid in the run. The label shows and hides with the arrow, on every run,
  in all eight locales (`scene/NextRoomArrow.ts`).
- **The chevron became a dart** (22 long, 18 wide, notched tail). The old one was 14 long and
  20 wide, and at some bearings a wing read as the tip: the reported door down-left of the
  player looked like an arrow pointing right.

Shipped as archive `blightbloom-0.0.1+21e5b74f-guide-label` (check PASSED, Bridge 2.4.1),
re-published to the sandbox on the owner's yes, same link.

The owner's next run got past the warm-up and **died in the second room**, `ember_l1_alcove`:
nine mobs, all live from the first tick, entered through the door they stand nearest to. The
sibling games agree on the rule this broke (Holy Kicker, Potion Siege, Notebook Wars): the first
chapter teaches, the second tests. Two changes, both on chapter 1 only (ENGINE_VERSION 90,
`engine/ENGINE_VERSION_HISTORY.md` has the numbers):

- **One shooter per room on chapter 1's first floor** (`DungeonConfig.fireBudgetByFloor`,
  `[1]`; every other floor keeps `ROOM_FIRE_BUDGET` 2).
- **Chapter 1 mobs have less HP early** (`difficultyCurve` 0.6 + 0.35 per floor, was 1 + 0.25),
  reaching the same ×2 at the boss floor.

On `client/sim/pveLevelSim` (40 seeds per bot) both bots now clear floor 1 every time, where the
careful bot cleared it 4 times in 40 and the aggressive one never did; the alcove costs 1–2 HP
instead of 5 of 10. It also made two chapter-sim gates pass that were red on the daily branch
(chapter 2 "harder than chapter 1"). Two other chapter-sim gates are red before and after,
unchanged: a frost room's worst one-second burst equals the effective HP pool (10 vs 10), and
chapter 3's entrance is cleared off floor 0 in 4 of 80 careful runs against a gate of 5. Neither
chapter can be reached from the client yet. Shipped as archive
`blightbloom-0.0.1+14af20b3-chapter1-ramp`, re-published to the sandbox on the owner's yes, same
link.

Then a local first-run pass, played headless and in the browser against that build, found the
wall had moved rather than gone, plus seven smaller faults. All fixed together (ENGINE_VERSION
91, `engine/ENGINE_VERSION_HISTORY.md` has the numbers):

- **Floor 2 was the new wall.** The second shooter per room and the bigger HP multiplier arrived
  together there. Chapter 1 now fields one shooter per room on every floor except the boss
  (`fireBudgetByFloor` `[1, 1, 1, 1]`); the HP curve is unchanged, so the boss floor is as hard as
  before. A "novice" bot (never seeks heals, never rests, never swaps) went from dying on floors 2
  and 3 at a mean of 135 s to dying on floors 3–5 at a mean of 385 s.
- **Bulwark did nothing.** Its "+2 max HP" never reached the player; the floor card now applies
  its buff the same way a pickup does.
- **Aim stuck on a foe behind cover** while one in the open shot back. Auto-aim now prefers the
  nearest foe in sight.
- **The exit room had no arrow to the portal.** Once a floor is clear, the arrow points at the
  portal in the extraction colour, with its own label ("Floor clear — walk to the portal to
  choose what's next"), and hides at the portal's own prompt radius.
- **The arrow vanished in the doorway gap**: it hid within 72 px of a door, the width of the gap.
  Now 40 px.
- **The swap lesson could wait forever** and its panel covered the portal. It gives up after 15 s
  like the deflect lesson does, and the lesson panel steps aside while either checkpoint panel is
  open.
- **The card panel covered the hero.** In pick mode its bottom now sits 100 px above the screen
  centre, scaling down (not below half size) on a short screen.
- **The opening said the same thing twice**: the STEP 1 move panel and the arrow's move-keys
  line. The arrow drops its keys line while the move lesson is on screen.

One item from the report was left as is on purpose: an arrow toward a foe behind cover. From a
top-down camera a foe behind a pillar is still on screen, so pointing at it is not misleading.
The sim instruments needed adjusting, not the game. The chapter sim's no-softlock gate caught the
level bot walking onto a heal it could not take (full HP, empty shield) and standing on it until the
run timed out. The co-op revive gate caught the bot circling a foe behind a wall block into that
block forever: its stuck detector measures movement per tick, so a seat sliding a pixel back and
forth on the wall face never counted as pinned. The orbit now watches its own net distance and goes
the other way round when it has gone nowhere (`client/sim/pve/botOrbit.ts`); making the general
detector net-distance instead made the bot so much better at travel that four chapter-2-to-4 and
endless difficulty gates, calibrated against the old bot, went red. And the co-op gate's "leader
revives the ally" check moved to chapter 2, because chapter 1 now almost never downs the ally.
With those, `npm run test:sims` is green, including the two chapter-sim gates that were red on
the daily branch.
Shipped as archive `blightbloom-0.0.1+99cba6ee-first-run-fixes` (check PASSED, Bridge 2.4.1),
re-published to the sandbox on the owner's yes, same link.

**The telemetry from those builds, read on 2026-11-08,** pointed at three things that were not
gameplay. Fixed together on the `06.11.2026` daily branch and shipped the same day on the
owner's yes: archive `blightbloom-2026-11-08-a6febbce-perf-ladder` (check PASSED, Bridge 2.4.1),
sandbox re-published at 12:06 UTC, same link. Telemetry before that time is the old build
(`99cba6ee`); split any before/after read on `build_version`.

- **Auto quality never stepped down on ~30 fps devices.** About 1 window in 10 sat at
  `fps_p10` 28–30, yet 47 of 55 sessions stayed on `high`: the watchdog's flat 25 fps floor
  sat under them. The floor is now three quarters of the rate the display delivers at the
  player's frame cap (45 at the 60 cap, 25 at the 30 cap, 54 on a 144 Hz panel; `powerBudget.ts`
  `deliveredFps` / `expectedPlayFps`, `qualityWatchdog.ts`), and only windows wholly inside a
  run count, since a menu idles at 30 by design (`renderQuality.ts`).
- **Two of our events doubled Playgama's own.** Bridge already reports `session_end` and
  `active_time`; ours went through `bridge.analytics.send` as well and the dashboard counted
  both. `bridgeAnalytics.ts` `PLATFORM_OWNED_EVENTS` now drops ours on this host only.
  `session_start` gained `boot_ms` (measured from `performance.timeOrigin`, as this host has no
  inline beacon), and `performance_sample` reports the real `target_fps` instead of a fixed 60, so
  a player on the 30 fps battery setting no longer reads as a slow device.
- **`long_task_max_ms` of ~600 ms during play** were room builds. A cold run profiled at 6×
  CPU throttle put the first build at ~560 ms, ~430 of it in the procedural stone bakes
  (`paintStoneDoor`, `paintStonePillar`, and a full sort of a quarter-million texels to find the
  wall top's median luma). The bakes are now byte-identical and 1.5–5× faster: quickselect for the
  median, memoised per swatch; swatch read-backs cached per texture; closures and per-pixel arrays
  out of the inner loops. Every remaining long frame over ~150 ms in that profile happens behind
  the loading cover. It still counts as "playing" for `performance_sample`, on purpose: a
  covered stall is still a stall the player waits through, so hiding it would flatter the number.

**The first thirty seconds (2026-11-08, after the `a6febbce` build).** The likes went up (6), but
52% of loaded sessions left inside 30 s. Three fixes on the `08.11.2026` daily branch, shipped the
same day on the owner's ask: archive `blightbloom-2026-11-08-5e325436-first-30s` (check PASSED,
Bridge 2.4.1), sandbox re-published at 16:34 UTC, same link. Telemetry between 12:06 and 16:34 UTC
is `a6febbce` (design/20 "Onboarding, fourth pass" has the detail):

- **Telemetry that survives a quick exit.** On Playgama every custom event is now sent the moment
  it is tracked instead of batched (`sendEachEvent`), so a 10-second visit still reports. New
  event `first_input` (`ms`, `kind` key|pointer, `screen`): the share of sessions with no
  `first_input` is the share that never touched the game, which separates "did not start" from
  "started and did not like it".
- **The first room has something on screen** (`ENGINE_VERSION` 92): the two warm-up mobs are
  dormant, 6.5 grid away, and wake when approached or shot.
- **Swap and deflect are taught when they apply**: swap once a fight is on, deflect on the first
  enemy shot, not in a room the player just cleared.

Read on the next build: the `first_input` rate and its `ms`, and the 30-second exit share,
split on `build_version`.

The traffic run ended at 16:52 UTC, 18 minutes after that publish, so `5e325436` got only three
sessions. They did show one regression: every `session_start` said locale `en` while the same
visit's later events said `ru`/`fr`/`es`. Per-event sending flushes `session_start` during boot,
and `getLocale` answers the default until `new Game(...)` applies the persisted one. The fix is
`appliedLocaleOr(bootLocale)` in all four entry points. Archive
`blightbloom-2026-11-09-6d2ae6b5-locale-fix` passed its check (Bridge 2.4.1) and was re-published on
2026-11-09 at 07:59 UTC, same link, with no update note because players will see no difference.
On `5e325436` alone, a locale split of `session_start` counts every visit as English. Older
builds batched their events, so they are not affected.

Then `4f9804f3` (design/21 §2.10, design/10 Results) was published on 2026-11-09 at 09:34 UTC,
same link, in the middle of the traffic run. It adds two things. A lost run now sends a
`run_death` event (killer type, room, hits taken, last-five-seconds burst) after its
`run_end`. And the defeat screen has a one-tap TRY AGAIN that starts a fresh run. Archive
`blightbloom-2026-11-09-4f9804f3-death-cause` passed its check (Bridge 2.4.1). The update note
tells players about TRY AGAIN. When reading the traffic run, split it at 09:34 UTC: sessions
before then can retry only through the Loadout screen and send no `run_death`.

**Keys that never reach the game (2026-11-10, published with `ee9465b8` below).** The traffic run's first
inputs were 46 pointer presses and no key, and 17 of 63 runs got no input at all. A portal
iframe gets no key presses until the player clicks inside it. The fix is ported from Holy
Kicker and lives in `client/src/platform/keyFocus.ts`. The game calls `window.focus()` at boot
and on every press. While `document.hasFocus()` is false on a non-touch session, the move
lesson reads "Click the game first, then use the keys." and the Playgama session holds the run
(hold `keys`: clock stopped, `gameplay_started` withheld). The window's focus event releases
the hold. Every Playgama event now also carries `focus` and `input`, so the next read can tell
"never had the keys" apart from "had them and left". Checked in a browser pane without focus:
the panel showed, the run stayed frozen, and one click released it. CrazyGames gets the focus
call and the hint but not the hold.

**Three more reads of the traffic run (2026-11-10).**

- **Visits that never start a run.** 26 sessions sent no `run_start`. All of them lasted 0 s,
  and 8 never sent a `screen_view`, so they left during the load. From the old data, leaving
  while the run art was still downloading could not be told apart from never reaching the start
  at all. Now it can: the run gate sends `run_wait` (`art` pending|ready) when it holds, and
  `run_start` carries `wait_ms` (design/21 §2.11). The music pack (3.41 MB) was downloading at
  the same time as the run art. It now starts only after the run art is in
  (`preloadArt.ts` `beginDeferredArt`). Resizing the curtain stays the owner's call, as decided
  on 2026-09-01.
- **The room-2 deaths (`ember_l1_alcove`).** The bots do not reproduce them. Five profiles were
  run on 40 paired seeds each: careful, aggressive, novice, a close-range "brawler" and a
  "rusher" that only fires at 2 grid. In the alcove they take 0.9–4 HP, and none dies there.
  Humans died there taking 10–15 hits. Two candidate fixes were A/B'd and neither was kept:
  - Every alcove spawn dormant: the aggressive bot's damage went 0.9 → 2.0, and brawler deaths
    in the next room went 1 → 14.
  - Two of the three emberlings removed: the damage moved up for some profiles and down for
    others.

  Neither moves damage one way across the bots, so neither is a fix. The missing ingredient is
  probably aim, which every bot does perfectly. The next step is the human data: `run_death`
  (killer, room, hits, burst) on more visits, and a replay of one alcove death. No engine change
  until those agree with a measurement.
- **Frame rate on the slowest devices was under-reported.** `performance_sample` read Pixi's
  `deltaMS`, which is clamped to 100 ms. In the slow windows `frame_time_max_ms` sat at exactly
  100, and `frames_over_100ms` was 0 everywhere while long tasks ran to 7 s. Those windows took
  about 90 s of wall clock to bank 30 s of "active" frames. The devices reporting 10 fps were
  really drawing about 3. The sampler now reads `elapsedMS`. It disarms on hide and on
  `pagehide`, so the first frame back is not counted as one frozen frame. Each sample now also
  carries `gl` (software|hardware|unknown, from the unmasked renderer string, never the string
  itself). That tells whether the slowest windows are machines drawing WebGL in software, which
  no quality tier can rescue. `low` already ran on 14 of 38 sessions. Read on the next build
  before tuning anything: `fps_p10` and `frames_over_250ms` split by `gl`. A software-renderer
  share would argue for starting those machines at `low` at boot, a decision this data cannot
  make yet.

Both blocks above shipped in `ee9465b8`. Archive `blightbloom-2026-11-10-ee9465b8-real-frametimes`
passed its check (Bridge 2.4.1) and was re-published on 2026-11-10 at 09:32 UTC, same link. Its
update note tells players about the click-to-start keys fix and the faster run start. Split
every read from here on `build_version` `ee9465b8`. Earlier builds send no `focus`/`input`,
`run_wait`, `wait_ms` or `gl`, and their frame times are clamped at 100 ms.

**2026-11-11 — the first floor, from the sandbox's own death data.** Not a guess at what is
hard: `run_end.floor` has a median of 1, `run_death.room` puts 23 of 25 deaths in a floor-1
room (`r2_alcove` 10, `r1_cell` 6, `r4_forge` 5), and the killers are the cheapest mobs in the
tree — `basic` 11, `emberling` 7, and not one stalker or ravager — at a median of 13 hits taken
with a 50% burst share. That is attrition from a crowd, not a spike from one dangerous thing,
so the fix is sustain and crowd size rather than any single enemy. Four changes, three of them
sim-visible (`ENGINE_VERSION` 93, full account in `engine/ENGINE_VERSION_HISTORY.md`):

- **The run waits for the player.** `first_input.ms` has a median of 7.7 s and 76 of 97 first
  touches land INSIDE a live run — the portal build autostarts, so for those seconds the player
  is reading the screen while the dungeon shoots at them. `client/src/game/controllers/openingHold.ts`
  freezes the sim until the first deliberate input (stick, fire, interact, or a latched HUD tap
  such as the weapon chip), with a 20 s fuse for a seat nobody is sitting in. It skips ticks
  exactly as hit-stop does, so replays, golden hashes and the engine version are untouched.
- **Chapter 1's shield refills in 1.5 s instead of 3.** `DungeonConfig.shieldRegenDelay`, set
  on `EMBER_DUNGEON` only. At 3 s a player who stays in the room is hit again before the gate
  ever opens, which switched the whole shield pool off for exactly the player this chapter is
  for.
- **Floor 1's three fight rooms lose part of their garrison** — alcove 9 → 5, gallery 10 → 7,
  forge 10 → 8 — keeping the ramp's shape. Chapters 2-4 keep the garrisons they were authored
  with; propagating the cut was tried first and turned the chapter-difficulty sims red.
- **The sim bots learned the two human weaknesses** that make the measurement above readable:
  a `newcomer` profile that does nothing for the first 7.7 s and never backs off. It extracts
  6 of 40 seeds where the `careful` bot now extracts 21 — the first instrument here that sits
  BELOW the sandbox population instead of above it.

What it is worth, measured rather than hoped: the `careful` bot went 19/40 → 21/40 extracted,
and in chapter 1 a player who walks one direction and never fires can no longer die in the
entry room at all (eight directions × 40 s, gated by `client/sim/firstFloorSurvival.test.ts`;
until this change the eastward walk died at tick 438). Nothing is built or published from this
yet — the next sandbox archive carries it, and the honest read is the 60 s survival line in the
gates below, split on the build version that first ships it.

**2026-11-11b — the run gate, and the instrument that was measuring it wrong.** The same
window read from the other end. `run_wait.art` came back `pending` in **113 of 113** sessions:
the run art is never in when the player asks for a run, because `firstRunAutostart.ts` opens
the gate within a frame of `beginDeferredArt()`. The median `wait_ms` was 4,621 ms. Two
changes, neither sim-visible (no `ENGINE_VERSION` bump):

- **The lobby UI tier is off the gate's critical path.** `loadRunArt()` opened with
  `await preloadUiTier('lobby')`, on the written reasoning that "a player cannot reach the run
  gate in the time it takes". The 113/113 is that reasoning being measured and failing: the
  tier is kicked by `preloadLobbyArt` in the same frame the gate opens, so ~253 kB of the
  decoration of the screen the player has just LEFT sat strictly serialised in front of the
  ~2.3 MB the gate actually exists for. The await is gone; the kick and `preloadUiTier`'s
  per-tier memo are untouched, so nothing downloads any later than it did, and a key that
  lands after a menu is drawn still reaches it through `whenUiTexture` exactly as the `late`
  tier always has. Asserted as an absence in `preloadArt.test.ts` — the gate must not ask for
  those files, not merely not block on them.
- **`wait_ms` stopped counting tabs nobody was looking at.** It was wall clock from
  `noteRunWait` to `run_start`, so a player who opened the gate and switched tabs banked the
  whole absence: p90 4,752,650 ms (79 minutes), max 42,434,681 (11.8 hours). The unreadable
  top end was the smaller half. `net/analyticsEvents.ts` bounds the field at 600,000 and
  `coerceProp` DROPS an out-of-range int rather than clamping it, so those sessions carried no
  `wait_ms` at all — and since the waits most likely to be backgrounded are the slow ones, the
  bound was deleting the rows the field exists to find and the surviving median was measured
  over whoever stayed on the tab. It now accrues per frame in `reportFrame`, each step clamped
  to `MAX_WAIT_STEP_MS` (250 ms); a hidden tab runs no `requestAnimationFrame`, so the absence
  arrives as one oversized frame and the clamp is what eats it. Same shape as `perfSample.ts`,
  for the same reason. **Every `wait_ms` before this build is a different measurement** — split
  on `build_version` before comparing, and expect the new median to be higher, not lower, now
  that the slow sessions are no longer being discarded.

**Considered in the same pass and deliberately not done**, so the next reader does not spend
the afternoon re-deriving them:

- *Narrowing the run gate's biome await to the entering chapter's element* (~203 kB: ice,
  lightning and poison are locked behind clearing the chapter before them). `assetPacks.json`
  already answers this in writing — `biome-ice`/`-lightning`/`-poison` are in the `run` phase
  precisely "so a frost run never starts on the flat fallback palette" — and narrowing only the
  web loader would buy nothing on WeChat, where the packs are the real download. It would also
  open a new path to the flat fallback for a co-op guest on the host's chapter, since an online
  run does not cross this gate at all. 9% of the gate is not worth re-litigating that for.
- *Re-encoding `door_curtain_raw.png`* (593 kB, 26% of the gate, 12x the next-largest door
  state). design/12's "Update (2026-09-01b)" records a render comparison put to the owner and
  answered "leave it alone", with a note asking that it not be re-litigated. It is not.
- *Releasing the gate on a critical subset.* That is the partial-availability state design/12's
  phase-boundary rule exists to forbid, and this repo's worst bug class.

One lead was chased and found clean: `screen_view` shows `paused` in 61 of 239 playing
sessions, which looked like the Playgama iframe auto-pausing a quarter of the players.
It is not — `PlaygamaSession` maps `pause_state_changed` to a `Hold`, which stops the clock
without touching `RunState.phase`. Those are players opening the pause menu themselves.

**2026-11-11c — the ad was placed at the one pause the player does not take.** Ad Shows per
Play is the second gate (≥ 0.30) and the week of 2026-11-05..11 read **0.236** — 25 shows
(24 interstitial, 1 rewarded) over 106 qualifying plays, with 10 `interstitial_failed` on top.
The shortfall is not a cooldown or a failure rate. It is placement.

`PlaygamaSession` asked for an interstitial on one condition, `inRun(from) && !inRun(to)`, and
`inRun` folds play, the pause menu and the result screen into a single state. So the only
moment that could ever be marked was the walk back to the lobby — the pause taken by the
player who has decided to stop. The telemetry shows how rare that is: **274 `run_start`s
produced 62 `run_end`s**, so 77% of runs end with the tab closing mid-floor, and those 62 ends
could yield at most 34 requests. Meanwhile the pauses the player *does* take were invisible:
`screen_view` recorded `paused` in 61 of 239 playing sessions (the lead cleared above — those
are real pause-menu opens), and 43 of the 62 ends were losses, each sitting under a TRY AGAIN
button that feeds straight back into `playing`. Both are named in Playgama's own monetization
guide — "when the player resumes from pause", "shortly after the player presses restart" —
and neither leaves `inRun`, so neither could fire.

The fix is `naturalPause(from, to)`, which keeps the run-ended arm and adds those two. It adds
no timer and no counter of our own: the guide is explicit that Bridge owns the spacing
(`minimumDelayBetweenInterstitial`), so marking *more* moments is the lever we have.
(**Corrected 2026-11-11e**: this paragraph originally added "and a request inside the cooldown
fails at once without showing anything". The Bridge SDK's own interstitial page says the
opposite — "Call `showInterstitial()` at every natural pause; if it is too early, Bridge waits
or skips according to platform behavior instead of showing ads too frequently." An early call
is not a wasted one, which is the whole reason a client-side cooldown of ours would be a
regression rather than a safeguard.) `whileAd`
already holds the clock, the sound and the gameplay bracket from the moment an ad opens, so
none of the three can interrupt play (requirements 2.1.3 and 2.1.6).

Deliberately not marked: **the start of a run** (the opening seconds are what Bridge holds its
first ad back to protect), and **the floor-to-floor descent** — "between levels" on paper, but
this game descends without a screen in between, so the player would be standing in a room with
their hand on the keys. A pause the player did not take is not a pause.

Also rejected, and worth recording so they are not re-proposed:
- *A revive / second-chance rewarded ad on defeat.* design/05's wipe rule is locked: a death
  may never be bought back. This is the single highest-volume ad slot in the game (43 losses a
  week) and it stays shut.
- *Offering the material double on `abandon` or `loss`.* `RunOutcome.doubleOffer()` is reached
  only from `win()` because carry-out banks only on extraction, so `carried` is 0 by rule on
  every other outcome. Its true cost is already visible: `ad_offer_shown` fired **3** times in
  the week, exactly matching the 3 wins. The rewarded offer is attached to a 5%-frequency
  event and could not move the gate at 100% conversion.
- *A banner on the loss screen.* The guide calls this out as effective and we ship none, but it
  needs layout safe-zones across every result screen. A larger change than this pass, not a
  rejection — it is the next candidate if 0.30 is still out of reach.

What to read next week: `interstitial_opened` per qualifying play (the gate itself), and
whether `interstitial_failed` rises — a rise there is the cooldown doing its job against the
new volume, not a regression.

**2026-11-11d — the screen half the sessions end on said nothing a player could act on.**
Session facts for the 30 sandbox sessions of 2026-11-09..11, grouped by the last screen each
one was on when it stopped: **defeat 14, playing 6, paused 5, loadout 4, menu 1**. Just under
half of all sessions end on the defeat screen, which makes it the single highest-traffic
screen in the game that is not the run itself — and the one with the least on it.

The obvious reading, that losing is expensive to recover from, is **wrong and was measured**:
of 28 recorded losses **16 (57%) were restarted**, and the gap from the loss to the next
`run_start` has a **p50 of 0.0 s** — TRY AGAIN (2026-11-09) already made the retry one tap, and
players take it instantly. Restart friction is solved. What the remaining 43% walk away from is
not a cost; it is an absence. The defeat screen was four lines — floor fallen on, materials
lost, time, score — every one of them a restatement of the loss, none of them naming a cause
and none naming a fix. A player who closes the tab there closes it not knowing what to change.

Meanwhile the game has known since 2026-11-09 exactly why they died and has been telling only
us: `run_death` carries `killer`, `room`, `hits` and `burst_pct` (§2.10, `deathCause.ts`). So
this pass spends none of that on new instrumentation and all of it on the player.
`client/src/game/deathAdvice.ts` turns those numbers into **one line, below the ledger and
directly above TRY AGAIN**, in three readings that each name a *different* action:

- **spike** (`burst_pct` ≥ 70): most of the pool went inside five seconds. The action is
  positional — keep moving, break line of sight — because no amount of healing survives it.
- **attrition** (anything else above 3 hits): the median sandbox death, 13 hits at 50% burst.
  Nothing spiked; the player stood in fire and never let the shield come back. The action is
  the 1.5 s shield-regen delay chapter 1 gained in ENGINE_VERSION 93 — which exists for exactly
  this death and which nothing on screen mentioned.
- **fragile** (≤ 3 hits, no spike): a run ended by a handful of hits is an unbuilt character
  walking downstairs, not a misplayed fight. The action is the loadout, before the next
  descent.

A death with no recorded hit at all (a disconnect, a resumed run killed on its first frame)
gets no line rather than a guess, and the row simply closes up — the stat box is one wrapped
`Text`, so nothing in the layout had to move.

Three things deliberately NOT done:

- *Naming the killer.* `killer` is a blueprint id (`basic`, `turret`, `fire_status`), not a
  display name. Showing it would buy a display string per enemy in **eight** locales to tell
  the player something the fight already showed them. The one thing they could not see is
  which of the three mistakes above they made.
- *A `hint` prop on `run_death`.* The per-event field cap is **4** (`analyticsEvents.test.ts`)
  and `run_death` is at 4. It is also unnecessary: the reading is a pure function of `hits` and
  `burst_pct`, both already sent, so next week's "did the line change the retry rate" question
  can be answered off the data as it stands without loosening a cap that exists to keep an
  internet-facing write bounded.
- *Anything resembling a second chance.* design/05's wipe rule is locked: a death may never be
  bought back, so there is no revive ad here and no reward on the defeat screen. This pass
  changes what the screen SAYS, not what the loss costs.

This is client-only and needs no `ENGINE_VERSION` bump. What to read next week: `run_end`
per session (1.63 today, and ~5 is what a 330 s average needs at a p50 run of 61 s), and the
loss→restart rate against today's 57%.

**2026-11-11e — two of the three things this pass set out to do turned out to be things that
must not be done.** The brief was: find out why `active_time` stopped firing on 11-08, convert
it to a 30 s wall-clock heartbeat to match Swarm Orbit's, and fix the interstitial timing to
pull the 28.6% failure rate down. All three rested on a reading of the telemetry that does not
survive contact with the code or with Playgama's own guides. Recorded in full, because the
same three conclusions are easy to reach again from the same console screen.

- *`active_time` did not break; it was removed on purpose.* Commit `bc1769ca` (2026-11-08,
  "stop duplicating Bridge's session signals") added it to `PLATFORM_OWNED_EVENTS` in
  `client/src/platform/playgama/bridgeAnalytics.ts`, alongside `session_end`. The telemetry
  guide (v1.1.2) is unambiguous about why: "Do not duplicate session, playtime, advertisement
  or purchase signals already supplied by the platform." Re-adding it — in any cadence, wall
  clock or otherwise — would be re-breaking something that was fixed three days ago.
- *The measurement we were about to build already exists, and nobody had read it.*
  `client/src/platform/playgama/perfSample.ts` emits `performance_sample` roughly every 30 s
  and has been doing so all along: 857 events across 157 sessions, last one 2026-11-11T12:07.
  Every sample carries **both** notions of time — `window_ms` (wall clock: p50 30,015, p10
  29,634, p90 30,352, max 1,410,834) and `active_ms` (p50 30,012, max 30,090). The cadence is
  exactly the 30 s heartbeat the brief asked for.
- *And what it says is worth more than the heartbeat would have been.* `sum(window_ms)` over
  those 157 sessions is 27,472 s, i.e. **≈175 s of instrumented gameplay per session**, against
  the **266.6 s** the platform credits each session on average. About a third of the graded
  wall clock is time this instrument deliberately never looks at — loading, menus, pauses, a
  parked tab — because the guide requires `performance_sample` to exclude exactly that. Which
  also settles what to do about the gap: **nothing**. Padding our sample window to close the
  distance to the platform's number would not lengthen a single session; it would only make our
  own perf data lie, in the direction the gate happens to reward. The gate is moved by keeping
  players, and §1/§2 above are the ways to do that.
- *The 28.6% ad failure rate is a stale blend.* Daily `interstitial` opened/failed:
  11-06 4/1, 11-07 2/3, 11-08 8/6, **11-09 3/0, 11-10 6/0, 11-11 2/0**. The last
  `advertisement_interstitial_failed` fired 2026-11-08T16:24; the 11 requests since have all
  opened. The 28.6% is dominated by a window that closed three days ago — the same window in
  which the sandbox was first published and the Bridge config first shipped. Reading a
  week-aggregate rate as a current one is how an already-fixed problem gets fixed twice.

**What shipped instead**, from the one genuinely new fact in the pass — the Bridge SDK's
interstitial page documents three `advertisement.interstitial` config keys this build was not
using:

- `placements`, declaring `run_end`, `run_restart` and `run_resume`, and `naturalPause()` now
  returns which of the three earned each request (`AD_PLACEMENTS` in `PlaygamaSession.ts`).
  Until now every pause arrived as the same unnamed `showInterstitial()`, so
  `advertisement_interstitial_opened` could not be split by pause and 2026-11-11c's whole
  premise — that the two newly-marked pauses are the common ones — was unfalsifiable.
- `preloadOnStart: 'run_end'`, which fetches the first creative right after init rather than
  inside the player's two-second pause. This is the SDK's own answer to a slow fill, and
  `run_end` is the placement that fires first in most sessions.
- `placementFallback: 'run_end'`, so a request that somehow carries no id is still routed and
  still counted rather than landing nowhere.

The two halves of that list live either side of the build/source line — the ids the game sends
are in `AD_PLACEMENTS`, the ids the platform can route are in the JSON the config emits — and
nothing at runtime would report a mismatch, since an undeclared id just falls back. So
`playgamaBuild.test.ts` agrees them, reading the **emitted bytes** rather than the config
object: `client/tsconfig.json` has no `allowJs`, so a `.ts` test importing that `.js` sees only
one level of the shape and the nested `interstitial` object is invisible to the type checker.
Four new tests, 4/4 mutants killed.

What to read next week: `advertisement_interstitial_opened` **split by placement**, which is
what this pass bought. If `run_resume` and `run_restart` together are not the majority of
requests, 2026-11-11c placed the ad in the wrong two pauses and the banner in its rejected list
becomes the next candidate.

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
