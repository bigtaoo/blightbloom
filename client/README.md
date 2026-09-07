# Blightbloom Client

Single-engine PixiJS v8 client — the render/host half of the game. It owns screens, input,
scene views, audio and art; it owns **no** gameplay outcome (those all come from `@dd/engine`).
What it drives today: the full PvE run loop (menu → loadout → generated floors → checkpoint →
extract or descend → result), online co-op, 8-player PvP with squads, accounts, and an
8-locale i18n system (English canonical + 中文/Deutsch/Français/Español/Polski/Русский/Italiano)
with first-boot browser-language auto-detection.

## Run (Web)

This is one package of a root npm workspace — install at the repo root, not here.

```bash
npm install        # from the repo root
npm run dev -w client        # open http://localhost:5173
```

## Controls

**Desktop (keyboard + mouse):**

| Input | Action |
|-------|--------|
| `WASD` / arrows | Move — the **body** faces the movement direction |
| Mouse | Aim — the **weapon** points at the cursor, independently of the body |
| Left click | Fire / swing (depends on the equipped weapon) |
| `1` / `2` | Switch to weapon slot 1 / 2 |
| `E` or `Space` | Interact: pick up / swap the weapon under you, hold to revive a downed ally |
| `Escape` or `P` | Pause (offline play only — an online match cannot stop the frame stream) |
| `O` | Settings (`Escape`/`O` closes it again) |

There is no block button and no jump: a melee **swing** parries bullets inside its own arc
(`design/03`), and jump was removed from the sim — actor `z` is a render offset only.

**Touch (mobile browser, Capacitor, WeChat):** virtual twin-stick — left half moves, right
half aims + fires; two corner buttons for weapon 1 / 2. Hit-test geometry lives in
`src/platform/TouchControls.ts` so every touch target behaves identically, and
`src/game/ui/TouchControlsView.ts` draws it, latched on the first touch so a mouse player
never sees it. Not there yet: an on-screen INTERACT control, and any verification of how this
feels under real thumbs on a real device (`design/04`).

## Dev `?query=` flags

Parsed in one place (`src/game/match/gameQueryParams.ts`); each is a dev/demo toggle, never
a shipped feature.

| Flag | Effect |
|------|--------|
| `?perf=1` | On-screen perf readout + WebGL draw-call probe (`src/perf/README.md`) |
| `?coop=1` | Bring a local bot ally |
| `?online=1` / `?pvp=1` | Route the run through CoopSession / the matchmade PvP arena |
| `?arenaDemo=1` | Synthetic local PvP arena |
| `?skin=` / `?wpn=` | Override the character / the starting weapon |
| `?lag=` | Inject synthetic one-way latency (ms) to feel the online predictor |
| `?mm=` | Override the matchsvc origin |
| `?pickupDebug=1` | Draw the sim's own collect radii + per-drop distances (`scene/PickupDebugOverlay.ts`) |
| `?replay=<url>` | Watch a recorded run instead of playing one, held at its marked tick (`match/replayPlayback.ts`) |

## What the render layer is responsible for

- Tilted-view scene + **Y-sort depth occlusion** (walking in front of / behind a pillar occludes correctly)
- **Height / shadow separation** — the `z`/shadow split the tilted view needs, kept in the render layer where a future hop or blink would live
- **Actor / Skin / Weapon three-layer structure** (see `design/02-entity-model.md`)
- **Upper/lower body split** — body faces movement, weapon tracks aim, both driven off one engine actor
- `.tao` **rig playback** (`src/render/`) with per-character atlases and weapon sprites mounted per body
  plan (`rigWeaponMount.ts`: the hero's orbiting sockets, a mob's held mount, the boss's none)
- Additive-blend fx layer (muzzle / deflect flashes), post-processing and particles, WeChat-safe rendering path
- **One screen-space lighting pass** over the scene layer (`game/fx/filters/litFx.ts`) — a
  per-pixel fake normal off the layer's own luminance, a fixed key light, and every live
  point light with real per-texel falloff, so a muzzle flash lights the room it goes off in
- **A frame-timing monitor in every session** (`src/perf/`, ported from `funny`): a sustained
  stutter leaves a `[perf]` console warning naming whether update or render was to blame;
  `?perf=1` adds an on-screen readout, a WebGL draw-call probe, and two console probes that
  attribute those draw calls to actual objects (`window.__perf.attribute` / `.census`)
- **Batching is a per-layer policy, not a default** (`src/render/staticGraphics.ts`): Pixi v8
  auto-batches a `Graphics` only under 400 floats of geometry, so authored-once geometry gets
  `batchMode: 'batch'` — but only on layers `scene/layers.ts` gives their own render group.
  Forcing it inside the Y-sorted `entities` layer is measurably slower; read that module before
  reaching for it

## Layout

Gameplay outcomes are decided by `@dd/engine` (the repo-root `engine/` package), never
here. Everything below is the **render/host** half: it reads authoritative engine state
and produces input, and nothing else (`design/06`/`design/08`).

```
src/
├─ main.ts            Web entry (WebPlatform → Game)
├─ main.wechat.ts     WeChat entry (WeChatPlatform → Game); loaded by ../wechat/game.js
├─ main.crazygames.ts Game-portal entry (design/20) — WebPlatform again, plus relative
│                     asset paths, the declared host, and the portal session. Built by
│                     vite.crazygames.config.js
├─ game/
│  ├─ Game.ts         the assembly shell: Pixi objects, the constructor, buildHud, and
│  │                  the host interfaces. 497 lines since the 2026-09-03 split — the
│  │                  behaviour moved to runState + controllers/ below
│  ├─ runState.ts     every mutable RUN field (phase, meta, mode flags, engine, session,
│  │                  score). PIXI-free by construction, which is what makes the rules
│  │                  above testable — see pureLayerBoundary.test.ts
│  ├─ phase.ts        the Phase union — shared vocabulary of Game and the screens
│  ├─ theme.ts        render palette (NOT gameplay tuning — that's the engine)
│  ├─ score.ts        the run's score table (host-side, never simulated)
│  ├─ coords.ts       the one place engine fp/brad becomes screen px/radians
│  ├─ scene/          world views mirroring engine state (Scene, Entity, Actor, Enemy,
│  │                  Bullet, Pickup, Portal, Backdrop, Skin, RoomBuilder, layers)
│  ├─ screens/        full-screen flow (MainMenu, ModeSelect, PvpPreview, Matchmaking,
│  │                  Forge, Login, Party, Pause, Settings, Screens, confirmEdge)
│  ├─ controllers/    input → PlayerCommand, engine events → host callbacks, and the
│  │                  shell's own behaviour (CommandBuilder, Ally/PvpBot controllers,
│  │                  LocalPredictor, EventReactor, RunOutcome, GameLoop, ScreenFlow,
│  │                  ArtGate, ForgeActions; plus the 2026-09-03 split — ScreenNav
│  │                  (phase→screen), RunLifecycle (start/end a run), OnlineMatch
│  │                  (queue + connect), ForgeInput (the forge key table), and the two
│  │                  free-function tables gameWiring + gameAssembly)
│  ├─ match/          how a run is configured and connected (arenaCatalog, matchConfig,
│  │                  offlineConfig, pvpConfig, onlineConnect, gameQueryParams),
│  │                  plus recording one (MatchRecorder/replayDownload/replayPlayback
│  │                  — see design/08 "Getting a replay OUT of a live session")
│  ├─ ui/             HUD + widget kit + menuLayer (the fit-scale that keeps every
│  │                  full-screen menu inside a short landscape-phone viewport;
│  │                  Layers.menu carries it, Layers.hudOverlay deliberately does not)
│  │                  (HudView composing PlayerCard/WeaponCard/
│  │                  StatChip/Minimap/DownedBanner, plus the shared widgets — Minimap
│  │                  is shared by both PvP and PvE, reading either state.arenaMap or a
│  │                  dungeonToArenaMap-converted floor via minimapLayout.ts)
│  │                  — pure-math modules sit beside their views so they stay testable
│  │                  without a canvas (textWidth is the only sizing input the HUD
│  │                  has; nothing here may call Text.width/getBounds)
│  └─ fx/             FxController, particles, filters
├─ perf/              frame-timing monitor + GL draw-call probe + on-screen readout
│                     (`?perf=1`); see its own README for the funny port's deviations
├─ render/            skin/rig/atlas infrastructure (.tao runtime, weapon + UI skins)
├─ net/               transport, CoopSession, matchmaking, party, auth, session
├─ meta/              persistent forge/blueprint state
├─ settings/          persisted user settings
├─ i18n/              English-canonical t() + locales
└─ platform/          platform isolation: canvas, Pixi Application, input, lifecycle
   ├─ types.ts        Platform / InputSource / InputState interfaces
   ├─ hostKind.ts     WHICH host this build is, DECLARED by the entry point — the one
   │                  platform fact no capability probe can answer (design/20)
   ├─ TouchControls.ts  shared virtual twin-stick (used by every touch host)
   ├─ web/            WebPlatform + WebInput (keyboard + mouse, and touch)
   ├─ wechat/         WeChatPlatform + WeChatAdapter + WeChatInput (wx canvas + touch)
   └─ crazygames/     the game-portal integration (design/20): the SDK façade, the ad
                      policy, the banner container, and the one-input phase session that
                      drives them. Nothing under game/ imports any of it.

sim/                  offline harnesses (PvP/PvE balance sims, the arena audit, and
                      replay/ — the recorded-run inspector behind
                      `DD_REPLAY=<path> npm run replay:inspect`). Outside src/ on
                      purpose: nothing shipped can import them.
```

`Game` takes a `Platform`-provided `InputSource`; it never references `window`,
`document`, or a device directly. Aim is abstracted as either a screen `point`
(mouse) or a `dir` (virtual joystick) so both control schemes reuse the same loop.

## Cross-platform builds

One PixiJS codebase, per-platform entry + platform layer. All share `src/game`.

| Target | Command | Notes |
|--------|---------|-------|
| Web (dev) | `npm run dev` | http://localhost:5173 |
| Web (prod) | `npm run build` | → `dist/` |
| WeChat mini-game | `npm run build:wechat` | bundles the IIFE, mirrors `public/` in by package and generates `game.json` into `../platforms/wechat/`; open that in WeChat DevTools. Real art loads, the game boots and renders, menu taps work, and the menus fit the 844x390 landscape-phone viewport (all 2026-08-25, main package 3.31 MB / 4.00 MB + 4 subpackages) — real-device verification (frame rate, touch feel, lowest base-library version) is what remains, see `../design/04-wechat.md` |
| Android | `npm run cap:add:android` then `npm run cap:sync` / `cap:open:android` | opens in Android Studio to build the APK (needs Android SDK) |
| iOS | `npm run cap:add:ios` then `cap:open:ios` | opens in Xcode (macOS only) |

Capacitor (`capacitor.config.ts`) wraps the `dist/` web build in a native webview;
touch input already works there. Native projects (`android/`, `ios/`) are generated on
demand and git-ignored. Desktop (Windows/macOS) can later use the community Electron
target; the web build itself already runs on desktop browsers.
