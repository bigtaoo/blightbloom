# 20 — Game portals (CrazyGames)

**Status: the CrazyGames build target is BUILT and verified as far as this repository can
verify it (2026-09-07).** `npm run build:crazygames -w client` produces `client/dist-crazygames/`
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
| In-game purchases only for invited games, through the platform's Xsolla account | `storePlatform.detectStorePlatform` returns `null` for a portal host, so the Forge renders no STORE entry and binds no `[B]` key. Same reasoning as the iOS 3.1.1 branch beside it (`design/19` §9's 9.5). |
| Consent for data collection beyond SDK events | A one-line data notice on `LoginScreen` — the only screen in this game that sends anything about a player anywhere, because an account is never required to play (`design/16`). Factual and derived from the code, not boilerplate. |
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

## Three live findings the documentation does not contain

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

`__portal.diagnostics()` exists because of these: one console line on a live page reporting the
environment, the adblock probe and whether the brackets are flipping. It is the only instrument
this repository has for the half of the integration it cannot test.

## What IS verified, and how

Served from `http://127.0.0.1:8099/games/blightbloom/` — a sub-path, deliberately, since that
is the shape that breaks absolute paths:

- The built bundle boots, loads all art and renders (relative paths work under a sub-path).
- The real SDK script loads and answers: `environment: local`, and its own console logs
  `Requesting game loading stop`, `Requesting adblock status`, `Requesting gameplay stop`.
- PLAY goes straight from the front door into a live run — one click — and
  `__portal.diagnostics()` reports `· gameplay`, i.e. the bracket flipped.
- SELECT MODE still reaches co-op, PvP solo queue and the tutorial.
- **Online play works against the deployed backend**: PVP SOLO QUEUE → bot-fill at 30 s → a
  live match, `ALIVE 2/2`, `zoneEnabled`, and the lockstep advancing 897 ticks over 4 seconds
  of wall clock. `vite.crazygames.config.js` defaults `VITE_MATCHSVC_URL` to
  `https://bb.gamestao.com` for exactly this reason: `runState.ts` falls back to
  `http://localhost:8788`, which is right for `npm run dev` and is the one default that can
  never be right for an uploaded bundle.
- Tests: `client/src/platform/crazygames/` has seven suites, including `portalBuild.test.ts`,
  which asserts against the real `index.html` and the real config's own transform rather than
  a copy of them (`design/18` Layer 6's technique, applied to the client).

## What remains

- **A registered portal domain.** Everything above ran on `local`, where the SDK renders
  placeholder banners and no real ad. Whether a real page fills the 320×50 banner is the one
  behaviour that could not be settled here — the local SDK answered "no available banner size
  has been found" even with the container sized, which is why the request is the explicit
  `requestBanner({id, width, height})` form rather than the responsive one.
- **A rewarded-ad placement.** The SDK and controller support `rewarded` and it is tested, but
  nothing offers one, because every rewarded reward in a roguelite touches balance: doubling
  banked materials halves the grind and interacts with `design/14`'s "sell breadth, not power";
  keeping a run's materials after a wipe contradicts `design/05`'s locked wipe rule. **This is
  a product decision, not an engineering task**, and 9.x-style adapters must not settle it by
  accident.
- **A hosted privacy policy / terms URL.** The in-game data notice covers the collection point;
  a hosted document is a human deliverable. Nothing renders a link until one exists — an empty
  placeholder link is worse than none.
- **The upload itself**, its store listing, thumbnails and the review round trip.
