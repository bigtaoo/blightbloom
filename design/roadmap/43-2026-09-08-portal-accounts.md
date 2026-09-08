# 2026-09-08 — the login the portal forbids, and the room it wants told about

Volume 43, still the launch-readiness queue. Two entries from one question — *"第一个平台我打算上
crazy games 的审核，你看看整个游戏流程需要如何进行修改？尤其是新手引导和登录页"* — and from the
two decisions the answer needed: the first submission keeps multiplayer, and the same human on two
platforms is deliberately two accounts.

See [../ROADMAP.md](../ROADMAP.md) for the index.

---

## The login page a portal forbids, and the onboarding that was never on the first-click path (2026-09-08, client + server + docs, no engine change)

The question was framed as *"the server is deployed, so the normal game features need a login
now"*, and the first useful thing this pass produced was that **that premise is not true of this
code, and its being untrue is what makes the portal submission possible at all**.

`POST /find`, `GET /find/:id`, `/party/*` and `/rating/*` verify no bearer token; only `/auth/*`,
`/account/meta` and `/store/*` do. `net/identity.ts`'s `getPlayerId()` returns the logged-in
`accountId` when there is one and a local guest UUID otherwise, and that is the single seam
matchmaking, party and ladder attribution all read through. So a guest plays online, in co-op and
in PvP, exactly as before the backend existed — which is the pre-existing design/16 property
("logging in is NEVER required to play"), and it is also, as it turns out, a hard requirement of
the platform.

### What the platform actually forbids, and where we were on the wrong side of it

`docs.crazygames.com/requirements/account-integration` is explicit in a direction the earlier
portal pass did not check for. Guest play must always be permitted (we comply); a logged-in
CrazyGames user must be **automatically registered and logged in** inside the game (we did
nothing); the platform's username must be **displayed** (we showed our own); external login
options are **disallowed**, and the list names email; a **logout that leads back to one** is
disallowed; a login button may not be a **primary call to action**.

Our `LoginScreen` is a username/password form with LOGOUT and CHANGE PASSWORD on it. Three of
those rules, on one screen, reachable from the portal main menu — and design/20's own account
paragraph had concluded the opposite ("a one-line data notice… because an account is never
required to play"), which was true and irrelevant: the rule is about the form EXISTING, not about
it being mandatory.

### The shape: the login moves to the entry point, and the screen stops being reachable

The gate is `isPortalHost()`, the seam volume 41 built, and the precedent is `storePlatform.ts`'s
— *a build that may not sell renders no entry at all*, rather than one that is drawn and refuses.
`MainMenu.setAccountEntry(false)` hides the ACCOUNT button, `gameWiring.ts` leaves `onAccount`
**unwired** (both halves, because neither implies the other), and `LoginScreen` is still
constructed and mounted exactly as `StoreScreen` is on a build that may not sell.

What replaces it is `platform/crazygames/portalAuth.ts`, run from the entry point after
`sdk.init()`: ask `isUserAccountAvailable` first (a domain without accounts answers false, and
every call after that would be noise in a reviewer's console), then `getUser()` — `null` is most
players and is not an error — then `getUserToken()`, and exchange that for one of our sessions.
`addAuthListener` does the same for a player who logs in on the portal mid-session, and
`showAuthPrompt` is declared in the SDK shape and **deliberately never called**, because
auto-prompting is disallowed and a game-drawn login CTA is disallowed as a primary one.

Every failure path — no SDK, accounts unavailable, a guest, no token, a 401, our own server down —
ends in the same place: a fully playable guest. That is not a swallowed error; it is the state the
game already supports completely, and `AdController` answers an adblocked player the same way.

### The trust boundary, and why the token is never decoded on this side

The platform's documentation says not to decrypt the user token client-side, and it is right: the
claims are worth nothing until the signature is checked against a key the page has no business
holding. `POST /auth/portal` (`server/src/routes/auth.ts`) is that boundary.
`server/src/portalToken.ts` verifies RS256 with `node:crypto` in four lines — no JWT dependency,
following `ticket.ts`'s own precedent of hand-rolling the compact-JWT shape — and
`portalKeys.ts` fetches and caches `sdk.crazygames.com/publicKey.json` (PKCS#1 PEM, which
`createPublicKey` detects unaided).

Three decisions in that module are worth stating because each closes a plausible alternative:

- **`alg` is checked, never negotiated.** `ticket.ts` calls JWT algorithm negotiation a footgun
  and fixes its own algorithm for that reason; here the algorithm arrives in attacker-controlled
  bytes, so anything but `RS256` is rejected **before the key is touched**. Both classic
  confusions have their own test: `alg: none`, and `HS256` signed with the public key as the HMAC
  secret. So does `RS512`, so the check is an equality rather than a family match.
- **A failed FETCH keeps serving the stale key; a failed VERIFICATION never refetches.** Opposite
  postures, both deliberate. The key we hold is still the right key during someone else's CDN
  outage, and locking every portal player out for the length of it would be the wrong trade;
  meanwhile a refetch-on-failure would let anyone force an outbound request per bad token, so key
  rotation costs up to one TTL of failed logins instead.
- **`BB_CG_GAME_ID` is optional and warned about.** A user token is a bearer credential any game
  on the platform can obtain for the same player, so an unset id means trusting every other
  developer there not to replay one here. It is optional because the id is only knowable after
  registration and a first upload has to work before that — and it is deliberately not defaulted
  to a placeholder, because a wrong id rejects every real login and looks exactly like a broken
  integration.

### Two accounts for one human, on purpose — and the schema that makes it safe

Asked whether a portal identity should link to an existing local account, the owner chose **two
separate accounts**, to keep another platform's account rules out of ours. That decision is what
the `accounts` table now encodes.

`provider`/`provider_id` were reserved by design/16 for exactly this and the reservation held: a
new provider is a `provider != 'local'` row plus a route, and `UNIQUE(provider, provider_id)` was
already in the schema, so the find-or-create is safe under a race (the losing INSERT re-reads the
winner's row). What the reservation did **not** predict is the reason `display_name` had to be
added: a federated identity arrives with a name chosen under someone else's rules, and it cannot
be forced through ours.

- The handle is `{provider}:{providerId}` — unique by construction, and containing a `:`, which
  `validateUsername`'s `[a-zA-Z0-9_]` forbids. So `alice` the local account and `alice` the portal
  player can both exist and neither can register into the other's row.
- The provider's name is **not validated**. Our 3–20 characters, our charset and our profanity
  blacklist are the rules for a name a player chooses HERE. Applying them to a CrazyGames username
  would mean a player whose name is two characters, has a dash in it, or trips a substring in our
  list could never log in at all — an unfixable dead end for them, in exchange for a moderation
  rule the platform already applies at its own registration. It is stored in `display_name`,
  truncated at 40, never used as a handle.
- The row has **no password and no way to acquire one**. `password_hash` is `NOT NULL`, so a
  sentinel is needed, and it is checked *explicitly* rather than relied upon to fail the ordinary
  comparison — which it would, there being no `:` to split on, but then "no password opens this
  row" would be a property of the storage FORMAT three lines away from anything saying so.
  `login` additionally refuses any row whose provider is not `local`, so there are two independent
  guards; the test that plants a **working** hash on a federated row (and proves it works, on a
  local one) is the one that shows the second guard is load-bearing.

`display_name` also needed the first real migration this project has had. `CREATE TABLE IF NOT
EXISTS` is the whole schema story for a fresh file and cannot be for a deployed one — the table
exists, so its body is never re-read and the column simply is not there. `db.ts` gains an
`ADDED_COLUMNS` table applied by a `PRAGMA table_info` guard (SQLite's `ADD COLUMN` has no `IF NOT
EXISTS` and throws on a repeat), and `db.migrate.test.ts` builds the **pre-2026-09-08 DDL by hand
on a real temp file** — a `:memory:` database always takes the fresh-schema path and could never
have failed, which is exactly the shape of test that passes while the deployed server refuses to
start.

### The onboarding half: the hints were behind four clicks on the one path nobody takes

Volume 41 made PLAY start a run immediately on a portal, because the platform allows a first-time
visitor at most one click to gameplay. What that pass did not notice is what the same change did
to teaching: `TutorialHintController` ran for the standalone tutorial level and nothing else, and
the tutorial lives behind SELECT MODE with a "recommended" badge. **So the portal's first-click
path was also the path with no control instructions on it at all** — for a reviewer whose
requirements page asks for intuitive controls, and for every real first-time player.

The fix is not a forced tutorial (the platform asks for the opposite) but the hints where the
player already is: `beginRun` arms them whenever `!meta.hasSeenTutorial`, so a first-ever run
teaches over the real dungeon and the player's own loadout. `RunState.firstRunHints` is a separate
flag from `tutorialActive` because three other readers mean "the standalone level" by that one
(the pause menu's SKIP TUTORIAL label, the quit route back to ModeSelect, the fixed config), and
`Game.isTeaching()` — the renamed host method `GameLoop` gates on — is the union.

Two assumptions inside the hint machine were true by construction over `tutorialConfig.ts`'s
hand-picked repeater+hammer and are not true over a real loadout, so both became checks:

- **A lesson this loadout cannot teach is SKIPPED, not waited on.** "Swing your melee weapon into
  incoming bullets" is bad advice to a player carrying two ranged weapons, and the step machine
  would have parked on it forever. It also does not congratulate them: `done` reached by skipping
  is silent, or a player with one ranged weapon gets "nicely done" three seconds into their first
  run for nothing.
- **The text follows the input device, not the platform.** The one string named both ("left stick
  / WASD"), which is unreadable on both — and it described an aim stick design/10 v33 removed,
  i.e. it told players to aim manually in a game that auto-faces. Two keys per lesson now, picked
  off `InputSource.getTouchVisual().active`, and the desktop wording finally names the real keys
  (`1`/`2`) instead of a button that only exists on a phone.

### The seam a silent login needed, and the race it was built for

`LoginScreen.onSessionChange` already existed — `gameWiring` hangs the main-menu label refresh and
the account-bound meta re-sync off it — and a portal has no login screen to fire it. So
`platform/sessionEvents.ts` is `rewardedAd.ts` with the arrow reversed: the game installs a
reaction, the entry point fires it. That re-sync is what carries a guest's accumulated Forge
progress up to the account they just landed in (`pullAccountMeta` pushes local state up on a
brand-new account), which is also the platform's "migrate local guest progress on login".

It is **sticky**: a notification with no subscribers is remembered and delivered on the next
subscribe. Not padding — it is the failure volume 41 already recorded in different clothing
(`PortalSession.start()`'s only `menu` transition happens on frame one, while `init()` is still in
flight, so the gate it was checked against was closed when it went past and the banner never
appeared). A boot-time login racing screen assembly is the same shape and just as silent: the
player is logged in on the server and the menu says LOGIN.

### Where the data notice went

The collection point moved. Nobody types anything on a portal, so the screen that used to carry
the notice at the point of collection is unreachable, and `auth.dataNotice`'s wording ("Registering
stores your username, a password hash…") describes a thing that no longer happens there. A second
key, `auth.portalDataNotice`, is drawn as one small line under the main-menu card whenever the
account entry is off — under the card and not at the viewport bottom, because `BannerHost` owns
that and a notice underneath an ad is a notice nobody reads. Unobtrusive rather than blocking is
the platform's own wording for what it wants.

**Tests: server 1154 → 1175 (five new files), client 5264 → 5333 for this entry.** `npm run check` clean,
`tsc --noEmit` clean in all three packages, coverage green on the 90/90 gate. `__auth` joins
`__portal` on the live page, and `PortalSession.diagnostics()` grew an account clause with four
states, because they are four different bugs — no user module, a guest, signed in, and the one
worth an instrument: **the portal says this player is signed in and we are not holding a session
for them**, with the reason.

`platform` `net` `ui` `test` `docs`

---

## The room the portal wants told about, and the name every other client draws (2026-09-08, client + server + engine protocol + docs, no engine bump)

The owner's other decision was that the first submission **keeps multiplayer**, which makes
`docs.crazygames.com/requirements/multiplayer` apply. Nothing in volume 41 or 42 had touched it,
and it asks for four things: room state through the SDK so a friend can join, an invite affordance,
`isInstantMultiplayer` honoured, and the platform's usernames displayed in-game.

Half the transport was already there and unused — volume 41 shipped `inviteLink`/`getInviteParam`
wrappers with tests and no caller. What was missing was every policy decision.

### A room is a PARTY, and that is why this one is a subscription

Our joinable unit is a party: a pre-match lobby with a share code (`PartyScreen`), never a live
match room, whose seats are fixed and whose lockstep session cannot absorb a joiner (design/06).
`platform/partyPresence.ts` carries `{partyId, code, joinable}` out of the game;
`crazygames/PortalRooms.ts` turns it into `updateRoom`/`leftRoom` and the portal's own invite
button.

`PortalSession`'s header argues at length that everything the portal is told should be DERIVED from
the phase stream rather than pushed by hooks, and this is the one place that argument does not
reach — worth stating rather than looking like an inconsistency. A phase says which screen is
open, and a room is not a screen: a player sits in a party across the squad screen, the matchmaking
screen and (as a member waiting on their leader) the menu, and the interesting transitions — a
fourth member arriving, the leader pressing START — change no phase at all. There is no per-frame
read of the phase that answers this.

What it does borrow is the property that made that argument work: one declaration point, one
reader, no second path. `setPartyPresence` de-duplicates, so `PartyScreen`'s one-second poll does
not become a one-second SDK call — and `joinable` is reported **honestly** (`!matching &&
members.length < SQUAD_SIZE`, the same cap the server's own `MAX_PARTY_SIZE` aliases), because the
platform draws a join affordance off that answer and an advertised join that is then refused is
worse than none. A full party keeps its room and loses its invite button; a dissolved one gets
`leftRoom()`, which is a different statement from `updateRoom({isJoinable:false})` and is treated
as one.

### The two doors a host can push the game through

`isInstantMultiplayer` and an accepted invite are both intent that arrived WITH THE PAGE, which is
why neither could be a query param: every other boot-time entry into this game (`?online=1`,
`?pvp=1`) is read inside `Game`'s constructor from `location.search`, and the SDK's answer arrives
after `new Game(...)` has run. So `platform/onlineEntry.ts` is a capability the game installs
(`gameWiring` already owns both verbs) and `crazygames/portalBoot.ts` walks through one of them.

The precedence is a decision: **an invite beats instant multiplayer.** A player who clicked a
specific friend's link wants that party, and a queue for strangers is not a lesser version of the
same thing — it would silently discard the only information the link carried. `queueCoop` is co-op
and not PvP for a similar reason: an instant-multiplayer visitor consented to playing *with*
people, not to being dropped into a battle royale against them. And a missing capability is
reported as `no-entry-installed` rather than collapsing into `none`, because the registry is
installed during screen assembly and an absent one is a wiring bug, not a page without intent.

`PartyScreen.joinWithCode` runs the code through the SAME `doJoin` a typed one takes — the busy
guard, the stale-attempt token, the error text and the presence publish are all behaviour it has
to share, and the only difference is where the string came from. `gameWiring` shows the squad
screen *before* joining, because `show()` is what clears the previous visit's attempt token and
joining first would have the answer discarded as stale.

### A name is a new field on the wire, and the interesting half is where it comes FROM

"CrazyGames usernames must be displayed in-game so players can recognise their friends" needed a
channel this game had never had: **no player name existed anywhere in the netcode**. Not in the
ticket, not in `MatchRoom`, not in the protocol, not in the HUD.

It rides the path design/16 already cut for `accountId`, one field over: `TicketPayload.name` →
`Matchmaker` → the gameserver's `Seat`/`RoomConnection` → `MatchRoom.seatNames()` →
`MatchStart.names`. Four properties are load-bearing:

- **It is SERVER-SUPPLIED, and that is the whole point.** `POST /find` now reads the bearer
  session if the caller sent one, and the session's `accountId` and `username` **win outright over
  the body's `accountId`, which is ignored rather than merged**. A name is the one field in a match
  that other players SEE, so a client-declared one is an impersonation primitive. A guest, or an
  expired token, still falls back to the body exactly as before — a 401 there would break a player
  whose 30-day session simply lapsed, which is a state the game fully supports.
- **A room with no logged-in players puts NOTHING new on the wire.** `seatNames()` returns
  `undefined` unless some seat has a name, so every pre-existing client, fixture and test sees a
  byte-identical `match_start`. In a MIXED room the unnamed seats are `null` at their own index
  rather than compacted out, because position is the seat index and a shortened array attributes a
  name to the wrong player.
- **It is on `conn_resync` too.** A reconnecting client never sees `match_start` again, so without
  that it would come back from a dropped socket with everyone's name gone. `seat.name` also
  survives a disconnect for the same reason `seat.accountId` does: three seconds of packet loss
  must not blank a nameplate for everyone else.
- **It is presentation, and nothing in the sim can see it.** It does not travel in a
  `PlayerCommand`, it is not hashed, no system reads it. design/06's contract is that a frame's
  output is a function of its commands, and a display name is not an input.

The display is `ui/SeatRoster.ts` — one line in the HUD's existing left column, shown only when a
seat has a name. Three choices, each closing an obvious-looking alternative. **Not nameplates over
the actors**: a nameplate tracks a world position through the camera every frame and then fights
the occlusion x-ray for legibility, and at this zoom a four-seat room is four labels over four
20-pixel sprites. **Unnamed seats are omitted, not filled in**: `P3` would be a name this game
invented and then showed to other people as if it were theirs. **Not the ally row** — `AllyRow` is
only drawn for a LOCAL bot ally or the arena harness (`showAlly` is `isCoop() || isArenaDemo()`,
and an online co-op match sets neither), so a name put there would never be seen in the only place
a name exists, which is a bug this pass nearly shipped.

### The finding that made the room half real, found by enumerating the SDK

Everything above was written, tested and reported-as-working against the shipped v2 script, and
`PortalRooms.state()` said `room GKRZA (joinable)` on a live page. It was telling the portal
nothing. **The shipped `crazygames-sdk-v2.js` (2.9.0) game module has no `updateRoom`, no
`leftRoom` and no `isInstantMultiplayer` at all** — `Object.keys` on it returns exactly
`happytime / gameplayStart / gameplayStop / sdkGameLoadingStart / sdkGameLoadingStop / inviteLink
/ showInviteButton / hideInviteButton / setScreenshotHandler* / getInviteParam`. Those three
absent names are the whole of the room requirement, and a missing method on this SDK is a silent
no-op *by design* (`settle`, which is what keeps a remote script from breaking a frame) — so the
requirement was unmet with nothing red, and our own bookkeeping agreed with us.

The tell was in the SDK's own console: `Show invite button` and `Invite button link …&party=GKRZA`
were logged, and no `Update room` line ever was. Both documentation pages are right about
different things — `/sdk/html5-v2/game/` does not list those methods and `/sdk/game/` (v3) does,
and v3 is the version the docs now describe by default.

**So the build ships v3.** Two names differ and `sdk.ts` reads both, so `SDK_TAG` is the only line
that has to change to go back: the loading pair (`loadingStart`/`loadingStop` vs
`sdkGameLoading*`) and `isUserAccountAvailable` (a plain boolean VARIABLE in v3, a method in v2 —
its migration notes list exactly that change, for this field and for `environment`). Everything
else this client touches is named identically, checked by reading the shipped v3 bundle rather
than by reading about it, and then verified live: `environment` is the documented property,
`isUserAccountAvailable` is `true` and the account path runs through it, a real midgame ad answers
`{played: true}` with `app.ticker.started` true afterwards (no leaked suspension — the one thing
an SDK swap could plausibly have broken), and the SDK prints `Update room (local) with params:
{roomId, isJoinable: true, inviteParams: Object}` then `Left room (local)` as a party is created
and left. `portalBuild.test.ts` now asserts the **version** in the injected tag, with the reason,
because a downgrade is exactly the change nothing else would catch.

Two things v3 has that v2 did not and that are deliberately unbuilt: `addJoinRoomListener` (the
platform pushing a join INTO a running game, which is strictly better than reading an invite
param at boot and which `onlineEntry.ts` already has the verb for — but a `local` domain has
nobody to join with), and `reportGameCompletedPercentage`. One thing to ask the platform about at
submission: v3 logs on every call that **`getUser` is still in BETA**, and the whole silent-login
path rides on it.

**Tests: client 5333 → 5434 across the two entries, server 1154 → 1175, engine unchanged (1481).** `npm run check` clean,
`tsc --noEmit` clean, the golden-hash fixture untouched — the protocol grew a field the sim cannot
reach.

**Still open on this target**, and each of these is now in `design/20`'s own list: a registered
portal domain (real banner fill, real ad playback, and whether accounts are even enabled on the
domain all live behind it); a hosted privacy/terms URL; the upload. Two known gaps of this pass's
own: **no PvP roster beyond the same one line** — it is shown in PvP and is correct there, but
nothing labels who eliminated you — and **the CrazyGames avatar is not drawn anywhere**, only the
username; the requirements page names both. And `SDK.data` is deliberately not adopted: a
third-party iframe can have `localStorage` blocked, in which case a guest's progress silently does
not persist, and all three stores fail soft so nothing crashes — the fix is real but it is a
boot-ordering problem (the stores are read synchronously before the SDK has initialised) and it is
filed rather than guessed at.

`platform` `net` `ui` `test` `docs`
