# 20 — Game portals (CrazyGames)

**Status: the CrazyGames build target is BUILT and verified as far as this repository can
verify it (2026-09-07; account integration and the multiplayer requirements 2026-09-08).** `npm run build:crazygames -w client` produces `client/dist-crazygames/`
— the directory to zip and upload. What is not verified here is anything that requires a
registered portal domain: whether a real page fills a banner, whether an ad actually plays, and
whether the account/purchase policies below are applied the way a reviewer applies them. See
*What remains* at the end.

A game portal is a fourth distribution target, beside our own domain (`b.gamestao.com`,
`design/00`), the WeChat mini-game (`design/04`) and the Capacitor shells. It is different from
all three in one specific way, and that difference is the whole content of this document:
**every other target constrains what the client CAN do; a portal constrains what it MAY do.**

## The locked decision

**A portal target is a build, not a fork.** `client/src/main.crazygames.ts` is a third entry
point beside `main.ts` and `main.wechat.ts`; `client/src/platform/crazygames/` holds the
integration; nothing under `client/src/game/` imports any of it, and `Game.ts` gained no line
for it. Removing the target is deleting one entry point, one config and one directory.

The alternative — a branch, or a `PORTAL` flag threaded through the game — was rejected because
the portal's requirements are almost entirely about the SHELL (paths, ads, the first click,
what may be sold) rather than about the game, and the two places that genuinely differ inside
the game are one-line host branches.

## Why feature detection stops working, and what replaced it

Every platform difference in this client before now was a CAPABILITY difference, and
`client/src/platform/` is built around that: `storePlatform.ts` asks whether there is a
`document` and a `fetch`, `replayDownload.ts` asks whether an anchor can carry a download,
`assetHost.ts` asks nothing and is simply swapped by the entry point.

A CrazyGames page is an ordinary Chrome inside an iframe. It has a `document`, it has `fetch`,
it has no `wx`; every probe in this codebase answers exactly as it does on our own domain. What
differs is permission. So `client/src/platform/hostKind.ts` is a **declared** fact — set by the
entry point, read by the two modules whose behaviour depends on policy — and `isPortalHost()`
is the predicate, so a second portal target joins it in one place.

## The requirements that changed code

Sourced from `docs.crazygames.com` (`/requirements/technical`, `/requirements/gameplay`,
`/requirements/ads`, `/sdk/html5-v2`, `/sdk/in-game-purchases`).

| Requirement | What it changed |
|---|---|
| "Use only relative paths… avoid absolute paths as they fail to load" | `base: './'` in `vite.crazygames.config.js` for the paths Vite writes, **and** `baseAssetHost(import.meta.env.BASE_URL)` in `render/assetHost.ts` for the ~200 absolute `'/skins/…'` paths this repository's own source contains. Both halves are needed; neither covers the other. |
| Only ads requested through the SDK are allowed | `platform/crazygames/sdk.ts` + `AdController.ts`. There is no other ad path in this client and never was. |
| An ad may never interrupt gameplay | `AdController` refuses outright while `inGameplay()`, and `PortalSession` only ever asks at a transition OUT of a run into a menu — never on the result screen, where the player is still reading their own numbers. |
| The game is muted and frozen for the length of an ad | `platform/crazygames/suspension.ts`: `audio/externalMute.ts` (a factor over the settings, never a write to them) plus `app.ticker.stop()`. Released in a `finally`, because an ad that errors must not leave the game silent. |
| An adblocked player plays normally | `AdController.rewardAvailable()` answers `false` and the offer is not drawn at all — never drawn-and-disabled. |
| Banners: not during gameplay, only on screens open 5+ seconds, must not block game UI | `BannerHost.ts`: one 320×50 container, fixed at bottom centre, shown on the main menu and only there, hidden AND cleared everywhere else, with the documented 30-second refresh floor enforced locally. |
| "Land new users in gameplay immediately… a maximum of 1 click" | `MainMenu.setQuickPlay(true)` + `RunLifecycle.beginQuickRun()`. PLAY starts a run with the meta's own loadout (the starter kit for a new player); SELECT MODE moves to its own button, so co-op, PvP and the tutorial stay exactly where they were. **Four clicks became one, and nothing became unreachable.** |
| In-game purchases only for invited games, through the platform's Xsolla account | `storePlatform.detectStorePlatform` returns `null` for a portal host, so the Forge renders no STORE entry and binds no `[B]` key. Same reasoning as the iOS 3.1.1 branch beside it (`design/19` §9's 9.5). **This is also the precedent the account gate follows** — a build that may not do a thing renders no entry for it, never one drawn and refusing. |
| Consent for data collection beyond SDK events | ~~A one-line data notice on `LoginScreen`~~ — **superseded 2026-09-08**, and by a change that moved the collection point rather than by a better wording. `LoginScreen` is unreachable on this host now (see *Account integration* below), so `auth.portalDataNotice` is drawn as one line under the main-menu card instead: unobtrusive rather than blocking, which is the platform's own wording. |
| A logged-in portal user must be registered and signed in automatically; no external login; no logout leading back to one; no login button as a primary CTA; the platform's username must be displayed | **`design/20`'s "Account integration" section below, 2026-09-08.** This row did not exist when this table was written, and the paragraph that stood in its place concluded the opposite — see that section's opening. |
| Room information must be passed through the SDK so a friend can join; invite links; `isInstantMultiplayer`; usernames displayed in-game | **`design/20`'s "The multiplayer requirements" section below, 2026-09-08.** Applies because the first submission keeps co-op and PvP (the project owner's decision). |
| English localisation is mandatory; detect the user's language | Already true (`design/17`): `en` is canonical, `DEFAULT_LOCALE` is `en`, and first boot picks from `navigator.languages`. `index.html`'s `lang` was `zh-CN` and is now `en`. |
| Prevent arrow/space page scroll; suppress selection and magnification | `WebInput`'s `SCROLL_KEYS` (cancelled on every repeat, and yielding to a focused text field), plus `user-select`/`touch-action` in `index.html`. |
| ≤50 MB initial download (≤20 MB for mobile homepage), ≤20 s to gameplay | Already satisfied, and by design rather than luck: `design/12`'s asset phases mean the boot download is the `lobby` pack plus UI, with run art fetched in the background. Whole bundle 6.2 MB. **This is a property to protect, not a box ticked** — collapsing the phases back into one eager preload would move the measured number, since the platform measures from page open to the first `gameplayStart`. |

## What the game does NOT know about

`platform/crazygames/PortalSession.ts` derives everything the portal is told from ONE input:
the phase, once per frame, on its own ticker callback installed by the entry point.

```
gameplay bracket   `playing` vs not (plus "an ad is up", which is not a phase)
midgame ad         a transition OUT of a run into a menu = "between runs"
happytime          a transition INTO `victory`
banner             `menu` and only `menu`
```

That shape was chosen over event hooks for the reason `game/musicDirector.ts` records for
music: five hooks whose correctness is "nobody forgot one" have two failure modes — a moment
nobody hooked, and a moment that fires twice. A per-frame derivation has neither, and it also
keeps `Game.ts` (at exactly its 500-line limit) and `GameLoop.ts` untouched.

Two things fell out of writing it that are worth keeping recorded, because both are cases where
a phase is not what it looks like:

- **`settings` is a full phase but behaves like an overlay.** Opened from a pause it returns to
  that pause, so comparing against the raw previous phase read `paused → settings` as "left a
  run" and put an ad over a run the player was coming straight back to. It is transparent to
  the break derivation now.
- **`start()` resolves after the first frame.** The only `menu` transition of a session happens
  on frame one, while `init()` is still in flight, so the SDK-enabled gate was closed when it
  went past and the banner never appeared at all. `start()` clears the tracked phase so the
  next frame re-runs the current one.

## Four live findings the documentation does not contain

Found by building the bundle, serving it from a sub-path and driving it — not by reading. All
three are the same class: the shipped SDK is not the documented SDK.

1. **`SDK.environment` does not exist in v2.9.0.** `'environment' in SDK` is `false`. The
   prototype has `getEnvironment()` instead. Reading the documented property reported
   `disabled` on a page whose own console was logging `environment: local`, and the entire
   integration then did nothing at all — no brackets, no banner, no ads, no error.
2. **`getEnvironment()` returns a Promise**, not a string. A synchronous read gets an object,
   fails the string check, and reports `disabled`. `init()` now tries the v3 property first,
   then awaits the v2 method.
3. **`SDK.init()` can simply never settle.** An unbounded `await` there means
   `PortalSession.start()` never resolves, `loadingStop()` is never called, and the portal
   shows a loading spinner over a game that has been playable for minutes. Every wait in
   `sdk.ts` is now bounded by one 3-second budget.

4. **The shipped v2 game module has no `updateRoom`, no `leftRoom` and no
   `isInstantMultiplayer` at all** (2026-09-08). Enumerating it on a live page returns exactly
   `happytime / gameplayStart / gameplayStop / sdkGameLoadingStart / sdkGameLoadingStop /
   inviteLink / showInviteButton / hideInviteButton / setScreenshotHandler* / getInviteParam`.
   Those three absent names are the WHOLE of the platform's room requirement, and because a
   missing method on this SDK is a silent no-op by design (`settle`), the integration reported
   its own room state correctly while telling the portal nothing — a requirement unmet with
   nothing red anywhere. The two documentation pages are both right about different things:
   `/sdk/html5-v2/game/` does not list them and `/sdk/game/` (v3) does.

   **So the build ships v3 now** (`vite.crazygames.config.js`'s `SDK_TAG`). Two names differ and
   `sdk.ts` reads BOTH, so the tag is the only line that has to change to go back:
   `loadingStart`/`loadingStop` (v3) vs `sdkGameLoadingStart`/`sdkGameLoadingStop` (v2), and
   `isUserAccountAvailable` as a plain boolean VARIABLE (v3) vs a method (v2). Everything else
   this client touches is named identically — verified by reading the shipped v3 bundle rather
   than by reading about it, and then live: `requestAd` still answers `{played: true}` with the
   ticker released afterwards, `environment` is the property v3's notes promise, and the SDK's
   own console prints `Update room (local) with params: {roomId, isJoinable: true, inviteParams}`
   and `Left room (local)`. Findings 1–3 above stay recorded as v2 findings, because that is what
   they were and the tag can go back.

`__portal.diagnostics()` exists because of these: one console line on a live page reporting the
environment, the adblock probe, whether the brackets are flipping, the account state and the room
state. It is the only instrument this repository has for the half of the integration it cannot
test.

## What IS verified, and how

Served from `http://127.0.0.1:8099/games/blightbloom/` — a sub-path, deliberately, since that
is the shape that breaks absolute paths:

- The built bundle boots, loads all art and renders (relative paths work under a sub-path).
- The real SDK script loads and answers: `environment: local`, and its own console logs
  `Requesting game loading stop`, `Requesting adblock status`, `Requesting gameplay stop`.
- PLAY goes straight from the front door into a live run — one click — and
  `__portal.diagnostics()` reports `· gameplay`, i.e. the bracket flipped.
- SELECT MODE still reaches co-op, PvP solo queue and the tutorial. **Verified against the
  screen that carried them until 2026-09-10**; that button is gone and the same three routes
  are rows in the lobby directly under PLAY (design/10). What the line asserts — that a
  one-click front door does not cost the portal build the other modes — is unchanged.
- **Online play works against the deployed backend**: PVP SOLO QUEUE → bot-fill at 30 s → a
  live match, `ALIVE 2/2`, `zoneEnabled`, and the lockstep advancing 897 ticks over 4 seconds
  of wall clock. `vite.crazygames.config.js` defaults `VITE_MATCHSVC_URL` to
  `https://bb.gamestao.com` for exactly this reason: `runState.ts` falls back to
  `http://localhost:8788`, which is right for `npm run dev` and is the one default that can
  never be right for an uploaded bundle.
- Tests: `client/src/platform/crazygames/` has seven suites, including `portalBuild.test.ts`,
  which asserts against the real `index.html` and the real config's own transform rather than
  a copy of them (`design/18` Layer 6's technique, applied to the client).

## The rewarded-ad placement (decided and shipped 2026-09-07)

This section used to be a paragraph under **What remains** saying the reward was a product
decision an engineering pass must not settle by accident. It was settled, deliberately, by the
project owner: **a successful extraction may be doubled.** Watch a rewarded ad on the results
screen and the run's carry-out bag is banked a second time.

**Why that reward and not one of the other three that were on the table.** It is the only one
that clears both locked rules at once:

- `design/05`'s **wipe rule** is why the offer does not exist on the defeat screen at all. Not
  disabled there — absent. "Keep your materials after a wipe" and "watch an ad to continue" are
  both the same violation, and the DEFEAT arm of `RunOutcome.handle` passes no offer argument
  whatsoever, so a later pass cannot wire one in and merely grey it out.
- `design/14`'s **"sell breadth, not power"** is why the currency is materials. A material is
  not power: it is the farmable half of the economy, and it is spendable only on blueprints the
  account already owns. An ad that handed out a run buff, a revive or a weapon would be selling
  power for attention, which is the same axis the monetisation model refuses to sell for money.
- The **non-ad player is never worse off**, and that is guaranteed by ORDERING rather than by a
  second code path: the baseline bag is banked *before* the offer is drawn. A player who ignores
  the button, blocks ads, or gets an unfilled request keeps 100% of what they carried out. The
  requirements page asks for exactly this ("leave them the non-ad alternative"), and it is
  asserted in `RunOutcome.test.ts` on `banked` — the only observable that can tell the two
  orderings apart.

**Four independent reasons no offer is drawn**, each a case in the tests: no rewarded ad is
installed (every target but the portal), the player blocks ads, the run was ONLINE (an ad freezes
this client, and a lockstep session cannot wait — `design/06`), or the run carried nothing out
(an offer to double zero is a button that lies about what it does).

**One rule the platform's own cap does not cover.** A rewarded ad does not count against the
SDK's "one midgame every three minutes", so watching one and then pressing CONFIRM handed the
player a second ad seconds later — two individually legal calls making one illegal outcome (the
requirements page's "comes as a surprise"). `AdController.REWARDED_MIDGAME_COOLDOWN_MS`
suppresses the automatic midgame for a minute after a rewarded ad the player actually WATCHED. An
unfilled request starts no cooldown: it cost the player no time, so it must not cost them the
ordinary break ad.

**Where it lives, and why the portal's "the game does not know it exists" shape survives it.**
An offer is the one thing `PortalSession` cannot derive from the phase stream — it has to be
DRAWN on a screen the game owns, and its reward lands in the meta layer. So the capability is
declared game-side (`client/src/platform/rewardedAd.ts`, a module-level registry beside
`hostKind.ts`/`storePlatform.ts`), the portal supplies an adapter over `AdController`
(`crazygames/portalRewardedAd.ts`), and `main.crazygames.ts` installs it. `src/game/` still
imports nothing from `platform/crazygames/`, and deleting the portal target still costs one
entry point and one directory.

**Verified live** on the portal dev build with the real SDK reporting `local`: a forced
extraction with 4 banked materials drew the amber offer, a real tap ran a real
`sdk.requestAd('rewarded')`, the materials row became `Materials banked: 8 (ad bonus x2)`, the
account bank went 4 → 8, the button retired and the two exits closed the row it had occupied, the
ticker was running again afterwards (no leaked suspension), and a midgame requested immediately
after came back `{played: false, reason: 'too-soon'}`.

**Still unbuilt, on purpose:** nothing offers a rewarded ad anywhere else. A second placement is
a second balance decision, not a second call site.

## Account integration (2026-09-08)

**This section replaces a paragraph that was wrong.** The requirements table above used to say
the platform's account rules cost us one data notice, "because an account is never required to
play (`design/16`)". The premise was true and the conclusion did not follow: the rule is about
the credential form EXISTING on that host, not about it being mandatory.

`docs.crazygames.com/requirements/account-integration` disallows external login options (its list
names email), disallows a logout that leads back to one, and disallows a login button as a primary
call to action; and it REQUIRES that a logged-in CrazyGames user be automatically registered and
logged in inside the game, that the platform's username be displayed, and that guest play always
remain possible. `LoginScreen` is a username/password form with LOGOUT and CHANGE PASSWORD on it,
reachable from the portal main menu. Three rules, one screen.

### What is true about this game's login, and why it is what makes a portal possible at all

Worth stating plainly because it is easy to assume the opposite once a backend exists: **nothing
in this game requires a login.** `POST /find`, `GET /find/:id`, `/party/*` and `/rating/*` verify
no bearer token; only `/auth/*`, `/account/meta` and `/store/*` do. `net/identity.ts`'s
`getPlayerId()` returns the logged-in `accountId` when there is one and a local guest UUID
otherwise, and that is the one seam matchmaking, party and ladder attribution read through. A
guest plays online, in co-op and in PvP. Only the STORE (already off on this host) and cloud
progress need an account.

### The shape

| Half | Where | The rule it satisfies |
|---|---|---|
| No credential form | `MainMenu.setAccountEntry(false)` + `onAccount` left unwired in `gameWiring.ts` | No external login; no logout back to one; no login CTA |
| Silent sign-in | `platform/crazygames/portalAuth.ts`, installed by `main.crazygames.ts` | New and returning portal users are registered/logged in automatically |
| Every start | the same `start()`, plus `addAuthListener` for a mid-session login | "Request current user data every time the game starts" |
| The name shown | `MainMenu`'s account LABEL (not a button), and `ui/SeatRoster.ts` in a match | The platform's username must be displayed |
| Guest progress carried up | `platform/sessionEvents.ts` → `gameWiring`'s existing meta re-sync → `pullAccountMeta`'s brand-new-account branch pushes local state up | "Support migrating local guest progress upon login" |
| The data notice | `auth.portalDataNotice`, one line under the main-menu card, with a link to the hosted policy under it (`platform/policyLinks.ts`) | Terms/privacy notice at the collection point |

`showAuthPrompt` is declared in `CgSdkShape` and **deliberately never called**: auto-prompting is
disallowed outright, and a game-drawn login call to action is disallowed as a primary one. The
declaration exists so the omission reads as a choice rather than an oversight.

### The trust boundary

`POST /auth/portal` (`server/src/routes/auth.ts`) is the only route in this server that accepts an
identity claim signed by somebody else. The order is the content: verify, then mint.

- `server/src/portalToken.ts` verifies RS256 with `node:crypto` — no JWT dependency, following
  `ticket.ts`'s own precedent — and checks `alg` as an **equality** BEFORE the key is parsed. That
  closes `alg: none` and `HS256`-signed-with-the-public-key (the key is public), both of which are
  their own test cases, as is `RS512` so the check cannot become a family match.
- `server/src/portalKeys.ts` caches `sdk.crazygames.com/publicKey.json` (PKCS#1 PEM, which
  `createPublicKey` detects unaided) with two opposite failure postures: a failed FETCH keeps
  serving the stale key, because it is still the right key during someone else's outage; a failed
  VERIFICATION never refetches, because that would let anyone force an outbound request per bad
  token. Key rotation therefore costs up to one TTL of failed logins, which is the cheaper failure.
- `BB_CG_GAME_ID` is **optional and warned about**. A user token is a bearer credential any game
  on the platform can obtain for the same player, so leaving it unset means trusting every other
  developer there. It is optional because the id is only assigned at registration and a first
  upload has to work before that — and deliberately not defaulted to a placeholder, because a
  wrong id rejects every real login and looks exactly like a broken integration. **Set it once the
  portal assigns one.**
- A 503 and a 401 are different answers on purpose: 401 means the player's token was bad, 503 means
  we could not check. Only the second should leave a player quietly playing as a guest while the
  SDK still believes they are signed in.

### LOCKED DECISION: one human on two platforms is two accounts

Decided by the project owner, 2026-09-08, when the alternative (linking a portal identity to an
existing local account, via the platform's own `showAccountLinkPrompt`) was put beside it: two
separate accounts, to keep another platform's account rules out of ours.

That decision is what the `accounts` table encodes, and the three consequences are all in
`AuthService.loginWithProvider`:

- **The handle is derived, not chosen.** `{provider}:{providerId}` is unique by construction and
  contains a `:`, which `validateUsername`'s `[a-zA-Z0-9_]` forbids — so `alice` the local account
  and `alice` the portal player both exist and neither can register into the other's row.
- **The provider's name is not validated.** Our length, charset and profanity rules are the rules
  for a name a player chooses HERE. Applied to a CrazyGames username they would leave a player
  whose name is two characters, contains a dash, or trips a substring in our list unable to log in
  at all — an unfixable dead end, for a moderation rule the platform already applies at its own
  registration. It is stored in the new `accounts.display_name`, truncated at 40, never a handle.
- **The row has no password and no way to get one.** `password_hash` is `NOT NULL`, so the
  sentinel `'!'` is stored — and checked EXPLICITLY in `verifyPassword` rather than relied upon to
  fail the ordinary comparison (it would; there is no `:` to split on — but then "no password opens
  this row" is a property of the storage format three lines from anything that says so). `login`
  additionally refuses any row whose `provider` is not `local`. Two independent guards, and the
  test that plants a *working* hash on a federated row is what shows the second is load-bearing.

`UNIQUE(provider, provider_id)` was already in the schema (design/16 reserved it) and is what makes
the find-or-create safe under a race: the losing INSERT re-reads the winner's row. `display_name`
needed the **first real migration this project has had** — `db.ts`'s `ADDED_COLUMNS`, applied
behind a `PRAGMA table_info` guard because SQLite's `ADD COLUMN` has no `IF NOT EXISTS`. It is
tested against the pre-2026-09-08 DDL on a real temp file, because a `:memory:` database always
takes the fresh-schema path and could never fail.

### Onboarding: the first-click path had no instructions on it

The "land new users in gameplay immediately… a maximum of 1 click" row in the table above was
satisfied by making PLAY start a run. What that did to teaching was not noticed at the time:
`TutorialHintController` ran for the standalone tutorial level and nothing else, and the tutorial
lives behind SELECT MODE. **So the portal's one-click path was also the path with no control
instructions on it** — for a reviewer whose gameplay requirements ask for intuitive controls, and
for every real first-time player.

The fix is not a forced tutorial — the platform asks for the opposite — but the same teaching beats
where the player already is. `RunLifecycle.beginRun` arms them whenever `!meta.hasSeenTutorial`, so
a first-ever run teaches over the real dungeon and the player's own loadout; `hasSeenTutorial`
retires them at gameover, so it is once per player. It is NOT behind a host branch: a first-time
player on our own domain benefits identically, and one behaviour is cheaper to keep correct than
two.

Two things had to become checks, because both were true by construction over the tutorial's
hand-picked repeater+hammer and are not true over a real loadout:

- A lesson this loadout cannot teach is **skipped, not waited on** — "swing your melee weapon into
  incoming bullets" is bad advice to a player carrying two ranged weapons, and the step machine
  parked on it forever. It is also silent when it lands on `done` by skipping, or a player with one
  ranged weapon is congratulated three seconds in for nothing.
- The wording follows the **input device**. One string named both ("left stick / WASD"), which is
  unreadable on both — and it described an aim stick `design/10` v33 removed, i.e. it told players
  to aim manually in a game that auto-faces. Two keys per lesson now, off
  `InputSource.getTouchVisual().active`.

## The multiplayer requirements (2026-09-08)

Applies because the project owner decided the **first submission keeps multiplayer**. The
alternative that was on the table — hide co-op/PvP/SQUAD on this host with the same policy gate the
store uses, pass a single-player review, integrate later — was rejected deliberately.

`docs.crazygames.com/requirements/multiplayer` asks for four things. Half the transport for them
already existed and was unused: volume 41 shipped `inviteLink`/`getInviteParam` wrappers, with
tests and no caller.

### A room is a PARTY

Our joinable unit is a party — a pre-match lobby with a share code (`screens/PartyScreen.ts`) —
never a live match room, whose seats are fixed and whose lockstep session cannot absorb a joiner
(`design/06`). `platform/partyPresence.ts` carries `{partyId, code, joinable}` out of the game and
`crazygames/PortalRooms.ts` turns it into `updateRoom`/`leftRoom` plus the platform's own invite
button.

**Why this one is a subscription when everything in `PortalSession` is a per-frame derivation.**
That file's header argues the derivation at length, and this is the one place the argument does not
reach: a phase says which SCREEN is open, and a room is not a screen. A player sits in a party
across the squad screen, the matchmaking screen and (as a member waiting on their leader) the menu,
and the transitions that matter — a fourth member arriving, the leader pressing START — change no
phase at all. What it does borrow is the property that made that argument work: one declaration
point, one reader, no second path. `setPartyPresence` de-duplicates, so `PartyScreen`'s one-second
poll does not become a one-second SDK call.

`joinable` is `!matching && members.length < SQUAD_SIZE` — the same cap the server's own
`MAX_PARTY_SIZE` aliases — and it is reported honestly rather than optimistically, because the
platform draws a join affordance off that answer and an advertised join that is then refused is
worse than none. A full party keeps its room and loses its invite button; `leftRoom()` is reserved
for actually leaving, since "the room is full" and "not in a room" are different statements to
whoever is being shown a join button.

### The two doors a host can push the game through

`isInstantMultiplayer` and an accepted invite are intent that arrived WITH THE PAGE, which is why
neither could be a query param: every other boot-time entry into this game (`?online=1`, `?pvp=1`)
is read inside `Game`'s constructor from `location.search`, and the SDK answers after `new
Game(...)` has run. So `platform/onlineEntry.ts` is a capability the game installs (`gameWiring`
already owns both verbs) and `crazygames/portalBoot.ts` walks through one.

- **An invite BEATS instant multiplayer.** A player who clicked a specific friend's link wants that
  party; a queue for strangers is not a lesser version of the same thing, and it would silently
  discard the only information the link carried.
- **`queueCoop` is co-op and not PvP.** An instant-multiplayer visitor consented to playing *with*
  people, not to being dropped into a battle royale against them.
- A missing capability is reported as `no-entry-installed`, not folded into `none`: the registry is
  installed during screen assembly, so an absent one is a wiring bug rather than a page with no
  intent.

`PartyScreen.joinWithCode` runs an invited code through the SAME `doJoin` a typed one takes — busy
guard, stale-attempt token, error text and presence publish are all behaviour it must share.

### The name channel

"CrazyGames usernames must be displayed in-game so players can recognise their friends" needed
something this game had never had: **no player name existed anywhere in the netcode** — not in the
ticket, not in `MatchRoom`, not in the protocol, not in the HUD.

It rides the path `design/16` already cut for `accountId`, one field over: `TicketPayload.name` →
`Matchmaker` → the gameserver's `Seat`/`RoomConnection` → `MatchRoom.seatNames()` →
`MatchStart.names` (and `ConnResync.names`). Four properties are load-bearing:

- **Server-supplied, and that is the point.** `POST /find` reads the bearer session when the caller
  sent one, and the session's `accountId` and `username` **win outright over the body's
  `accountId`, which is ignored rather than merged**. A name is the one field in a match that other
  players SEE, so a client-declared one is an impersonation primitive. A guest — or an expired
  token — still falls back to the body exactly as before; a 401 there would break a player whose
  30-day session simply lapsed, which is a fully supported state.
- **A room with no logged-in players puts nothing new on the wire.** `undefined`, not an array of
  nulls, so every pre-existing client, fixture and test sees a byte-identical `match_start`.
- **A mixed room nulls seats at their own index** rather than compacting, because position IS the
  seat index and a shortened array attributes a name to the wrong player.
- **Presentation only.** It never travels in a `PlayerCommand`, is never hashed, and no system
  reads it — `design/06`'s contract is that a frame's output is a function of its commands, and a
  display name is not an input. The golden-hash fixture is untouched.

`ui/SeatRoster.ts` is the display: one line in the HUD's existing left column, shown only when a
seat has a name. **Not nameplates over the actors** — a nameplate tracks a world position through
the camera every frame and then fights the occlusion x-ray for legibility, and at this zoom a
four-seat room is four labels over four 20-pixel sprites. **Not the ally row**: `AllyRow` is drawn
only for a LOCAL bot ally or the arena harness (`showAlly` is `isCoop() || isArenaDemo()`, and an
online co-op match sets neither), so a name put there would never be seen in the only place a name
exists.

## What remains

- **A registered portal domain.** Everything above ran on `local`, where the SDK renders
  placeholder banners and no real ad. Whether a real page fills the 320×50 banner is the one
  behaviour that could not be settled here — the local SDK answered "no available banner size
  has been found" even with the container sized, which is why the request is the explicit
  `requestBanner({id, width, height})` form rather than the responsive one.

  Since 2026-09-08 this gates the ACCOUNT and ROOM halves too: whether `isUserAccountAvailable`
  answers true at all, whether a real user token verifies against the published key, and whether
  the invite button and `updateRoom` render anything are all behaviours that only exist on a
  registered domain. `__portal.diagnostics()` grew an account clause and a room clause for exactly
  that — FIVE account states, because they are five different bugs. Two of them report a broken
  integration rather than an absent player: *the portal says this player is signed in and we are
  not holding a session for them*, and (added later the same day) *`getUser` did not work at all*.
  The second was the same null as `guest` until it was separated out — see "the guest that was
  really a broken SDK" below.
- ~~**A hosted privacy policy / terms URL.**~~ **Shipped 2026-09-08.**
  `client/public/{privacy,terms}.html`, live at `b.gamestao.com/privacy` and `/terms`, linked
  from under the data notice on `MainMenu` (portal) and `LoginScreen` (every other target).
  The rule that outlived the gap is worth keeping: nothing renders a link until a URL exists,
  and that is now a `string | null` in `platform/policyLinks.ts` rather than prose.
  `isUsablePolicyUrl` also refuses a RELATIVE URL, which is the specific way this breaks on
  this target only — `/privacy` resolves against the PORTAL's host inside its frame, so it
  would 404 for exactly the players the link is required for while passing every check run on
  our own domain. The clean URL depends on Cloudflare's `html_handling`, which
  `wrangler/client.jsonc` now states explicitly for that reason.

  The document CONTENT is written from what this game does rather than adapted from the
  sibling project's: no email address is collected anywhere, no analytics or telemetry exists
  in the tree, no payment processor is connected (`/webhook/dev` is not proxied publicly and
  `/store/skus` needs a session, so nothing can be bought), ads are portal-only and
  player-initiated, and an account is optional — so a guest's data never leaves the browser,
  which is the strongest thing either document has to say.

  > **Superseded 2026-09-09, two clauses of it (design/21-ops-analytics.md §5).** The
  > paragraph above is kept as written because it records why the documents say what they
  > say. Two of its premises have since stopped holding: **analytics and telemetry now exist**
  > (a log store, and the retention instrumentation of design/21 Phase A), and therefore **a
  > guest's data does leave the browser** — anonymous gameplay events and error reports do,
  > which is the whole point of measuring retention, since a guest is who retention is about.
  > `client/public/privacy.html` is the authority on what is collected and was rewritten in
  > the same pass; the other three clauses (no email, no payment processor, portal-only
  > player-initiated ads) are still true. **A data declaration on the portal's own side was
  > made from the same premise and has to be revisited** — it is filed in design/21 §5 rather
  > than here, because it is now one item on a list of consequences rather than a portal
  > detail.
- **The upload itself**, its store listing, thumbnails and the review round trip.
- **`SDK.game.addJoinRoomListener` is not used.** v3 has it (v2 did not), and it is the platform
  PUSHING a join into a running game rather than the game reading an invite parameter at boot —
  strictly better for a friend joining mid-session, where `getInviteParam` cannot help because
  there is no page load to read it on. `platform/onlineEntry.ts` already has the verb it would
  call. Not built because it could not be exercised here: a `local` domain has nobody to join.
- **`getUser` is in BETA on the platform's side.** The v3 SDK logs, on every call:
  *"The getUser function is still in BETA, please get in touch with us if you are interested in
  using it."* The whole silent-login path depends on it, so ASK THEM at submission time rather
  than discovering at review that it is gated.

  What is no longer open is the ability to SEE it happen. Until 2026-09-08 a `getUser` that
  threw was reported as `guest`, because `readUser` goes through `settle()` and that function's
  whole contract is to make a failure indistinguishable from "returned nothing". So the
  likeliest failure of the entire account integration looked exactly like a page full of
  players who are not signed in — on the one instrument built to observe it. `settleReporting`
  keeps the reason now and `diagnostics()` reports `getUser BROKEN (<reason>)`. Nothing
  branches on it: every failure path still ends at a fully playable guest, which is the rule
  `settle` exists to enforce and this does not relax. The new arm is checked BEFORE the guest
  arm, because the two share a null user and a guard placed after it would be unreachable. (Its sibling warning is already handled: the `id`
  field is being removed from the user object, and this client reads `userId` and sends
  `getUserToken`'s token — never `id`.)
- **`BB_CG_GAME_ID` on the deployed matchsvc.** Until it is set, `/auth/portal` accepts a user
  token minted for any game on the platform (warned once at startup, `config.portalGameId`).
- **The CrazyGames AVATAR is not drawn anywhere.** The requirements name username *and* avatar;
  only the username is shown. The avatar is an external image URL, which means a texture load
  across an origin this page does not control — a real piece of work, not a line.
- **No PvP-specific roster beyond that one line.** `SeatRoster` is correct in PvP and shown there,
  but nothing labels who eliminated you, and in an eight-seat FFA the line is the whole social
  signal. Adequate rather than good.
- **`SDK.data` is deliberately not adopted.** A third-party iframe can have `localStorage`
  blocked, in which case a guest's progress silently does not persist between sessions — all three
  stores (`net/session.ts`, `settings/store.ts`, `meta/store.ts`) fail soft, so nothing crashes and
  nothing warns. The platform's data module exists for exactly this and is a drop-in for the
  `localStorage` API, but the stores are read SYNCHRONOUSLY at boot, before the SDK has
  initialised, so adopting it is a boot-ordering change rather than a swap. A signed-in player is
  unaffected (their progress lives on our server); a guest on a browser that blocks third-party
  storage is the case this leaves open.
