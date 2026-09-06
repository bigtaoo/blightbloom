# WeChat mini-game adaptation & verification

The WeChat mini-game is the most constrained target: **no DOM, no full window/document, no eval**. Rendering dependencies and base-library versions must be verified explicitly.

> **Status (2026-08-25, fifth pass): the game boots, renders, is navigable, has readable text
> and a playable map in the simulator, its five custom shaders are confirmed to COMPILE and do
> real work there, and a device that cannot afford them now has something to turn off.**
> Everything below this line is history in the order it was found; the two most recent items
> (the shader confirmation and the render quality tiers) are the "fifth pass" Update further
> down, and checklist item 16.
>
> Five WeChat-only bugs were found and fixed on the fourth pass, in the order they blocked each
> other — each one hid the next:
>
> 1. Boot never reached `Game.start()` (`URLSearchParams` is absent on this runtime) —
>    checklist item 10.
> 2. With the game running, every menu `Button`/`Slider` was silently unclickable (the wx
>    canvas has no DOM event API for Pixi's `EventSystem` to listen to) — item 12.
> 3. With the buttons live, the player could reach the Forge and then got **stuck** there:
>    every menu screen is laid out for a viewport roughly twice as tall as this one, so the
>    Forge's START RUN button was drawn underneath its own blueprint grid — item 13.
>
> 4. With the Forge navigable, **entering any room threw** — `capLight.bakeLitCap` built its
>    texture with `Texture.from(canvas)`, which identifies a canvas by `instanceof` against
>    DOM globals this runtime does not have — item 14.
> 5. With the map enterable, **every label in the game was blank** — Pixi sets
>    `context.letterSpacing = '0px'` before every measurement and every `fillText`, and that
>    one assignment poisons a wx 2D context — item 15.
>
> Note the shape of that list: (1) and (2) each made (3) unreachable, (3) made (4)
> unreachable, and (2) specifically looked fine from the outside because the in-run
> twin-stick controls bypass Pixi's interaction system entirely. "It renders" proved nothing
> about "it plays", and "it plays" proved nothing about "you can read it".
>
> The asset half is likewise verified against the real base library: both entries call the
> same `render/preloadArt.ts`, `client/public` is mirrored into `platforms/wechat` by
> package, the main package sits at **3.41 MB / 4.00 MB** with four subpackages, and every
> registered texture of every loader resolves (checklist item 9). `wx.loadSubpackage` works,
> and the runtime reports WebGL2.
>
> **Update (2026-08-25, fifth pass): the shaders are confirmed to RUN here, and there is now
> something to turn off.** Two gaps that had nothing to do with each other:
>
> - Every perf number in `01` was measured on a desktop Chrome. Nothing had ever been measured
>   on a phone — and, more to the point, a bad measurement would have had **nothing to act on**:
>   the four full-viewport filter passes, the per-actor skin shaders and the renderer resolution
>   all ran unconditionally, with no quality setting anywhere in the codebase. `render/quality.ts`
>   is the lever; see **Render quality tiers** below. Item 6 is no longer "measure and hope".
> - The custom shaders had never been shown to COMPILE on this runtime. That mattered because a
>   shader that fails to compile paints nothing and throws nothing, and the 2026-08-25 boot
>   verification only established that the composited frame was non-blank — which the (bright,
>   unfiltered) menu satisfies on its own. Now measured directly: removing `SceneLightFilter`
>   from the live scene in the simulator changes a large fraction of the frame, so the pass is
>   compiling and doing real work on the real base library. See **Verification**.
>
> **Update (2026-09-01, sixth pass): the two-phase asset boot is verified here.** The first
> download became code only earlier the same morning (`design/12`), which moved the whole asset path onto
> three claims a wx-shaped fake cannot test. All three now hold on base library 3.17.1: the phased
> boot resolves every texture in both phases (17/17 UI, 7/7 rigs) including packs that land ~850 ms
> into a live render loop; seven concurrent `wx.loadSubpackage` calls all succeed; and the
> background download does not hitch the lobby, measured against a matched control rather than
> eyeballed. Item 17 — and the three measurement traps it walked into are worth more than the
> result.
>
> Still open before this platform is shippable: everything that needs a real handset —
> lowest base library (item 2), low-end frame rate (item 3), touch feel (item 5) — plus the
> raw-vs-compressed package-limit question (item 11). Item 3 is now answerable **without any
> tooling on the device**: if the frame watchdog fires, the settings screen's quality button
> reads `AUTO (LOW)` / `自动 (低)`, which is a low-end device reporting itself. **A device also
> now owes two narrower answers than before**: whether `onProgressUpdate` reports real bytes once
> there is a real download, and whether a pack's files are genuinely unreachable before its load
> (the simulator answers neither — item 17's traps (a) and (b)).
>
> See **Asset loading** for the three mechanisms, **Viewport** for the landscape-phone
> layout constraint, and **Verification** for exactly what is and is not proven.
>
> **Status (2026-07-07): boot + render verified in WeChat DevTools.** The vertical
> slice (tilted-view grid, player + weapon, pillars with Y-sort/height/shadow, enemy)
> renders in the simulator on base library 3.15.2 with no console errors, using Pixi v8
> WebGL + our own DOM adapter + the unsafe-eval polyfill. Remaining checklist items
> (lowest base library, real-device frame rate, touch feel) still require a device.

## Key constraints

- No full `document` / `window`; `Image`, `OffscreenCanvas`, `createImageBitmap`, `Audio`, etc. are not provided. See **Adaptation approach** below for how we satisfy Pixi's DOM dependencies without weapp-adapter.
- Usually only **one main canvas** (the first `wx.createCanvas()`); multiple WebGL contexts are poorly supported → confirms the "single engine" decision. Later `wx.createCanvas()` calls return offscreen (2D) sub-canvases.
- **No WebGPU** → force Pixi to WebGL (`preference: 'webgl'`). We also tree-shake the WebGPU renderer out of the bundle entirely (see build notes).
- **No `eval` / `new Function`** (unsafe-eval is disabled). Pixi v8 generates uniform/UBO/shader upload code via `new Function` by default → must use Pixi's eval-free polyfill.
- Avoid `document.createElement('canvas')` for texture generation; the demo's glow uses pure Pixi Graphics (portable). Canvas2D that *is* needed (e.g. `Text` glyph rasterization) goes through the adapter's `createCanvas` → `wx.createCanvas()`.
- **A `document` DOES exist in the DevTools simulator and does not on a device.** This is the single most misleading thing about this target: `document.createElement('canvas')` answers in the simulator, so browser-only code can look healthy there and be a `ReferenceError` on a handset. Two shipped bugs hid behind it. See **Canvas2D on this runtime** below.

## Adaptation approach (verified)

We do **not** use weapp-adapter. Modern WeChat templates no longer ship it, and Pixi v8
exposes a clean official extension point — the `DOMAdapter` — that we implement in a
small file we own (`client/src/platform/wechat/WeChatAdapter.ts`). This matches the
project's open-source-control preference (see `00-tech-stack.md`, Decision 2).

Three concrete pitfalls were hit and fixed while bringing this up in DevTools:

| Symptom | Cause | Fix |
|---|---|---|
| `simulator game launch error: game.json: ["workers"] cannot be ''` — game never launches | `game.json` had `"workers": ""` (empty string is invalid) | Remove the `workers` field |
| Pixi needs `document`/`Image`/canvas that WeChat doesn't provide | No weapp-adapter | Implement Pixi's `Adapter` interface (`WeChatAdapter`), `DOMAdapter.set(WeChatAdapter)` before `app.init`, and init with `manageImports:false` so Pixi's browser-environment probe can't overwrite it with the `BrowserAdapter` (which calls `document.createElement`) |
| `Error: Current environment does not allow unsafe-eval` at `WebGLRenderer._unsafeEvalCheck` | WeChat forbids `eval`/`new Function`; Pixi generates upload code that way | `import 'pixi.js/unsafe-eval'` at the top of the WeChat entry — it swaps in eval-free polyfills and neuters the check |

Adapter surface actually implemented: `createCanvas` (→ `wx.createCanvas()`),
`createImage` (→ `wx.createImage()` — this is the WHOLE image path, see below), the
WebGL1 / 2D context constructor probes (for WebGL1-vs-2 detection and text metrics), and
stubs for `fetch`/`parseXML`/fonts.

`fetch` stays unimplemented on purpose, and an earlier version of this doc was wrong about
why it mattered. It said to "extend `fetch` if Assets are introduced later" — but when
Assets were introduced, nothing reached it. Pixi's texture parser only calls `fetch` on its
`createImageBitmap` path; with no `globalThis.createImageBitmap` (this runtime has none) it
takes the `DOMAdapter.createImage()` branch instead
(`pixi.js/lib/assets/loader/parsers/textures/loadTextures.mjs`), which needs no network
primitive at all. Anything that does land in `fetch` is asking for a REMOTE asset, which is
a bundle-boundary decision (`client/src/render/assetPacks.json`), not a loader detail — so
it should keep failing loudly rather than become a half-working `wx.request` shim.

## Version-selection principle (important)

- Use Pixi **v8**; do not upgrade blindly. Pick a version tested to run every asset-loading path on the **lowest target base library**, then pin it (lockfile).
- The main pitfalls are in the **asset/texture loaders'** differing reliance on `Image` / `ImageBitmap` → must be verified on a real device, not from docs. Real assets landed 2026-08-25, so this is live now rather than hypothetical: the exact device-dependent assumption is that `wx.createImage()` populates `width`/`height` before firing `onload`, and that `FileSystemManager.readFileSync(path, 'utf8')` returns a string on the lowest target base library. `wechatAssetLoad.test.ts` proves everything ABOVE those two facts; only a device or the simulator can prove the facts themselves.

## Build & run

`npm run build:wechat` (in `client/`) does everything:

1. `tsc --noEmit` typecheck, then a vite **lib build** (`vite.wechat.config.js`) of
   `src/main.wechat.ts` → a single self-contained **IIFE** at `client/wechat/js/game.js`
   (`inlineDynamicImports` → one file, no ESM `import`/`export`, no chunks — the WeChat
   runtime loads it via `require`).
2. The **WebGPU renderer is stripped** by a `strip-webgpu` plugin (stubs
   `gpu/WebGPURenderer.mjs`, whose subtree then tree-shakes away; `preference:'webgl'`
   means it never runs anyway).
3. A `copy-to-platform` plugin syncs `game.js` / `js/game.js` into **`platforms/wechat/`**
   — the project WeChat DevTools opens. Its `project.config.json` (with the real appid) is
   left untouched.
4. The same plugin then mirrors `client/public` into `platforms/wechat/` by package
   (`build/wechatAssetSync.mjs`) and GENERATES `game.json` — generated rather than copied
   because a second asset pack has to appear in it as a `subpackages` entry. The mirror
   prunes: a texture deleted or renamed in `client/public` is removed from the package
   instead of quietly continuing to cost bytes.

`npm run check:wechatpackage` (repo root, also folded into `npm run check`) is the byte
gate — see **Package budget** below. It reads `client/public` and the pack table directly,
so it is meaningful without running a build first, which is the point: art lands in the
repo long before anyone runs `build:wechat`, and that is when the budget should be checked.

Project shape reference: a WeChat mini-game needs `game.js` (entry, just
`require('./js/game.js')` — no weapp-adapter), `game.json`, and `project.config.json`.
Core logic is reused from `src/game`; only the entry and platform layer differ.

## Asset loading

Two mechanisms, because a mini-game has neither `fetch` nor `createImageBitmap`, and the
two halves of a shipped bundle need different answers. Both sit behind one seam,
`client/src/render/assetHost.ts`, whose web implementation is the identity function — so
the five loaders (`taoBundle` / `biomeTiles` / `uiSkins` / `environmentSprites` /
`weaponSkins`) kept their public shape exactly, and nothing at any call site changed.

| What | Web | WeChat |
|---|---|---|
| PNG | `Assets.load` → `createImageBitmap` | `Assets.load` → `DOMAdapter.createImage()` → `wx.createImage()`, `src` = a package-relative path |
| JSON sidecar (`animation.json`, `frames.json`) | global `fetch` | `wx.getFileSystemManager().readFileSync(path, 'utf8')` |
| Path form | `/skins/orb-core/eye.png` | `skins/orb-core/eye.png`, or `packs/<pack>/skins/...` for a subpackaged asset (`packedPathFor`, `assetManifest.ts`) |
| Subpackage | nothing to do — files are served | `wx.loadSubpackage`, via `packLoader.ts`, BEFORE any load that reads out of one |
| `Assets.init` | default | `{ skipDetections: true }` |

Three things worth keeping:

- **The image path never needed `fetch`.** See the adapter section above. `taoBundle.ts`'s
  two JSON reads — which used the GLOBAL `fetch`, not even the adapter's — were the only
  genuine blocker.
- **`Assets.init` must skip format detection.** Pixi's video-format probes call
  `document.createElement('video')`, and `Assets` sets its `_initialized` flag BEFORE
  running them. So on this runtime the default `init` throws, every concurrent load races
  past the flag, and the symptom is not a crash but exactly ONE arbitrary texture missing —
  whichever load happened to be first. `preloadCoreArt()` therefore calls `Assets.init`
  explicitly, with the host's options, before the first load. Found by
  `wechatAssetLoad.test.ts` on its first run, before any device saw it.
- **`getBaseUrl` returning `''`** is what lets a package-relative path survive Pixi's
  resolver untouched.

## Package budget

WeChat's limits (official 分包 docs, re-checked 2026-08-25): **main package ≤ 4 MB**, a
standard subpackage has **no individual cap**, an *independent* subpackage ≤ 4 MB, and the
whole game ≤ **30 MB**. `design/ROADMAP`'s parked note recorded only the 4 MB figure, which
made the situation look more constrained than it is.

**The main package is code and nothing else, as of 2026-09-01** (`design/12`, "the first download
is code only"). It holds `js/game.js` — **0.95 MB / 4.00 MB** — and every asset lives in one of
**eight** subpackages totalling ~4.52 MB (~5.47 MB for the whole game against the 30 MB ceiling —
both dropped ~0.25 MB on 2026-09-06, when the music loops were re-cut shorter for the tempo pass
in `design/11-audio.md`).
Until that pass main was 3.42 MB, of which 2.49 MB was art, which is why a 2,729-byte headroom
crisis was reachable at all.

| Pack | Contents | Bytes | Fetched |
|---|---|---|---|
| `main` | `js/game.js` | 0.95 MB | first download |
| `lobby` | `ui/*` | 0.38 MB | awaited at boot, behind a progress screen |
| `music` | `audio/music/*` | 0.84 MB | background, never awaited |
| `forge` | `weapons/*` | 0.43 MB | background, awaited at the run boundary |
| `run` | rigs, fire/neutral biome, environment, SFX — the default pack | 2.28 MB | background, awaited at the run boundary |
| `biome-ice` / `-lightning` / `-poison` / `boss` | see the table below | 0.64 MB | background, awaited at the run boundary |

`mainPack` and `defaultPack` in `assetPacks.json` are now different values (`main` / `run`), and
that is a safety property rather than bookkeeping: **an asset added with no rule can no longer
silently enlarge the first download.** A rule is required to opt into `main`, and
`assetManifest.test.ts` sweeps the real `client/public` tree asserting nothing does.

**Do not trust the figure above; run the gate.** On 2026-08-31 main was found at **4,191,575 /
4,194,304 bytes — 2,729 bytes of headroom, 99.93% full** — having last been recorded at 3.42 MB the
day before. Roughly 770 kB had arrived from unrelated work with nobody noticing, and the next code
change of any size would have failed the gate. `node build/checkWeChatPackage.mjs --verbose` prints
the current numbers and the twenty largest files.

`client/public` went from **13.66 MB to 3.20 MB** — and the
dominant cause was never the missing atlas packer `12` had queued, it was source art
shipped at authoring resolution. `orb-core`'s four bone textures were 1254² while the two
sibling characters on the same rig had been 256² for months (a 30× difference per file),
and six byte-identical 650 KB `socket_*.png` copies accounted for 3.9 MB on their own.
Atlas packing would have saved almost none of that: merging RGBA PNGs does not remove
pixels. It remains worth doing for draw calls, not for bytes.

The gate enforces RAW bytes deliberately. WeChat's docs state the 4 MB limit without saying
whether it is measured before or after the package is compressed; community write-ups say
after, and DevTools' upload dialog is the only authoritative answer. Until someone reads
that number, raw is the conservative direction — the gate prints the compressed estimate
(0.27 MB for the code-only main package, as of 2026-09-01) alongside it so the real headroom is
visible without depending on the guess.

**This question was reached and deliberately left closed (2026-08-31.)** When main hit 2,729 bytes
of headroom it became the difference between "there is an emergency" and "the emergency is with our
measure", so it was worth settling — and it is not settleable from here. Reading the upload dialog
needs a registered appid, a logged-in DevTools session, and pressing a button that **publishes the
package**. So bytes were moved instead — a bytes-justified `oversized` pack holding one 606 kB file — and this
stays on the needs-a-device list beside every other item in the checklist below. That pack is
**gone** as of 2026-09-01: with the first download down to 0.95 MB there was no pressure left to pay
off, and its own note had said to delete it rather than refill it with whatever was largest next. Anyone who does open that dialog
should record the number here.

Bundle boundaries live in `client/src/render/assetPacks.json`, read by three consumers (the
runtime's `assetManifest.ts`, the build's `wechatAssetSync.mjs`, and the gate).

**What is deferred, and why exactly these.** Each subpackage holds art a fresh run cannot
reach, checked against the shipped content rather than assumed:

| Pack | Contents | Why it is unreachable |
|---|---|---|
| `biome-ice` / `biome-lightning` / `biome-poison` | that element's floor / wall / wallface swatch | `theme.ts`'s `BIOME_ID_TO_ELEMENT` maps the only authored dungeon (`ember`) to `fire`, and anything without a `dungeonConfig` (PvP, arena) falls to `neutral` |
| `boss` | `skins/boss-core` | `blightlord` is its only user and spawns on floor 5 |

Explicitly NOT deferred: `brute-core` and `floater-core`. Both `brute` and `floater` spawn on
**floor 1** (`world/dungeons/ember/ember_l1_floor_1.json`), so a pack holding them would be a
lie the moment anyone made it lazy. `assetManifest.test.ts` pins that.

**They no longer all load at boot.** They did until 2026-09-01, from `preloadCoreArt`, and that
satisfied the 4 MB rule while buying nothing from it — every byte still arrived before the first
frame, and art still held 2.49 MB of the main package. Now `lobby` is awaited at boot, everything
else is kicked in the background from the lobby, and the `run`-phase packs are awaited again at the
run boundary by `game/controllers/ArtGate.ts` behind the same progress screen. Each pack declares
its `phase` in `assetPacks.json`, so `render/preloadArt.ts` reads the table rather than naming
packs.

The four packs in this table are awaited with the rest of the run phase even though nothing can
reach them today (654 kB), because the rule that keeps this from becoming a bug farm is that **the
set of available textures changes only at a phase boundary** — `RoomBuilder` builds a room's sprites
once, so a texture that lands mid-room does not fix the sprite built without it. Making one
genuinely lazy is still `await ensurePack('biome-ice')` at the point of use plus dropping it from
the phase; no loader, manifest entry or call site moves.

Every subpackage also gets a generated no-op `game.js` at its root. The 分包 docs describe
`root` as "a directory whose `game.js` is the entry file" and never document a resource-only
subpackage, so the entry is written rather than gambled on.

## WebGL1 degrades silently

`GlTextureSystem.mjs` gates mipmap generation on
`autoGenerateMipmaps && (supports.nonPowOf2mipmaps || isPowerOfTwo)` and forces clamp when
`!supports.nonPowOf2wrapping && !isPowerOfTwo` — and `GlContextSystem` sets both
`nonPowOf2*` flags to `isWebGl2`. So on a WebGL1-only device:

- every non-power-of-two texture **silently loses the mip chain it asked for**, which
  reproduces the 2026-08-12 "can't tell what this character is" colour-noise bug (`12`);
- every non-power-of-two texture that asked to **wrap is clamped**, which turns a tiling
  swatch into one tile plus a smear of its last column.

Neither logs nor throws. This is checklist item 4 below, restated as something concrete
rather than a device question. `texturePowerOfTwo.test.ts` pins the wrapping half: the ten
floor/wall swatches are 256² and safe, and the four `wallface_*` faces (256×125..127) are
recorded as a known gap — padding them to 256×128 is a one-row art change, but their crown
rows are measured against that exact height (`wallTone.ts`'s `FACE_CROWN_ROWS`), so it is
an art decision, not a packaging side effect. The mipmap half is deliberately not pinned by
a count: essentially all sprite art is non-power-of-two, and changing that means padding
every file and moving every anchor with it.

## Viewport: a landscape phone is SHORT, and menus are laid out for a desktop

`client/wechat/game.json` declares `"deviceOrientation": "landscape"`, so the mini-game
viewport on an iPhone 12/13 is **844 x 390 logical px** — wider than a desktop window is
tall, and roughly *half the height* every menu screen in `client/src/game/screens/` was
written against. `WeChatPlatform.createApp` sizes the renderer straight from
`wx.getWindowInfo()`, so `renderer.screen` is that 844 x 390 and every screen's own layout
math (`show(w, h)` / `render(meta, w, h)`) received it verbatim.

Measured minimum heights of the shipped layouts at the time (via
`client/src/game/screens/viewportFit.test.ts`'s own sweep): Forge 540 — 570 to also clear
its fixed bottom action bar — Settings 485, LoginScreen 405, PvpPreview/PartyScreen 400,
ModeSelect 380, Screens 370, MainMenu 330. Every one of them overflows 390; the Forge
overflows it badly enough that START RUN, anchored at `h - 60`, landed *inside* the
blueprint grid that flows to y≈509 and simply read as absent.

**The fix is a layer-wide fit-scale, not per-screen re-flow.** `client/src/game/ui/
menuLayer.ts` defines a design space (760 x 640) and `MenuLayer.fit(real)` sets the menu
container's scale to `min(1, w/760, h/640)`, returning the design-space size the screens lay
out against. `Layers.ui` therefore splits into exactly two screen-space children:

| sub-layer | holds | scaled? |
| --- | --- | --- |
| `hudOverlay` | in-run HUD, touch controls, minimap | no — a thumbstick stays thumb-sized |
| `menu` | every full-screen screen + the forge's SETTINGS button | yes |

Two properties matter. It **never scales up** (`min(1, …)`), so any viewport at or above the
design size — every desktop browser — is the identity transform and bit-for-bit unchanged.
And it costs **density**: 844 x 390 fits at 0.61, so a 12px label renders at ~7 CSS px
(~15 device px at `pixelRatio` 2). Re-flowing the Forge's 4x2 grid wider-and-shorter on a
very wide viewport would buy that back and is the follow-up if it reads too small in the
hand; it is a legibility question, not a correctness one.

Pixi hit-testing goes through the container transform, so taps land correctly with no
input-side change (verified live: a synthetic pointer at START RUN's on-screen position
flips `phase` `forge` -> `playing`).

## Adaptation layer (client/src/platform)

- `platform/` isolates platform differences behind interfaces: `Platform` (canvas +
  Pixi Application + input) and `InputSource`.
- Web entry `main.ts` uses `WebPlatform` (keyboard + mouse). WeChat entry
  `main.wechat.ts` uses `WeChatPlatform` (wx canvas + `WeChatAdapter` + touch), reusing
  the same `Game` core.
- **Input:** Web is mouse (fire) + keyboard (move); WeChat is a **move stick + a fire
  button** (`WeChatInput`, design/10 v33 — the right side used to be a second, aiming
  stick, but manual aim is gone: the engine auto-faces the nearest hostile, else the
  movement direction), plus corner buttons for weapon 1 / weapon 2 (no jump/block
  button — parry is the melee swing).
- ✅ **Full unit-test coverage across the platform layer, 2026-08-05 ("全部加测试" pass):**
  every file under `client/src/platform/` now has a dedicated test file except
  `types.ts` (pure type declarations) and `{Web,WeChat}Platform.ts`'s own `createApp()`
  method (constructs a real Pixi `Application`/`app.init()` against a real WebGL
  context — the same class of exemption `Game.ts`/`ArenaCanvas.mount()` already have,
  daydayup-testing-conventions memory). All of it runs under plain-node vitest, no
  jsdom: a hand-rolled `wx`/`window`/`AudioContext` fake per file (mirroring
  `WebInput.test.ts`'s pre-existing convention) is enough — `WeChatInput.test.ts`
  (touch→`TouchControls` wiring, including the `touchcancel` branch `WebInput` doesn't
  have), `audioSynth.test.ts` (the shared synth voice table, driven with a fake
  `AudioContext`/node graph that records its own calls), `WebAudio.test.ts`/
  `WeChatAudio.test.ts` (the autoplay-gesture gate, the `ctx.state==='running'` play
  gate, volume clamping, and — WeChat-only — the "base library claims support but
  construction throws" permanent-degrade branch), `WeChatAdapter.test.ts` (Pixi's DOM
  adapter surface against a fake `wx`, including the module-scoped 2D-context-probe
  cache — reset via `vi.resetModules()` per test so the cache can't leak across tests),
  and `{Web,WeChat}Platform.test.ts` (the two testable factory methods,
  `createInput`/`createAudio`). This closes the last gap this doc's own verification
  checklist below couldn't (screenshot/log-based live checks confirm the real device
  behaves correctly, but never pinned down the platform layer's OWN logic branches as a
  fast, deterministic regression suite).

## Canvas2D on this runtime

Everything Pixi does with a 2D canvas — `Text` rasterisation, `capLight`'s baked wall-cap
swatch — goes through `WeChatAdapter.createCanvas()` → `wx.createCanvas()`. Three traps, all
paid for in shipped bugs on 2026-08-25, all of the same shape: **Pixi identifying a browser by
touching a DOM global, on a runtime that has some of them and not others.**

| Trap | What breaks | What to do instead |
|---|---|---|
| `Texture.from(canvas)` | Picks a source class by SNIFFING (`resource instanceof HTMLCanvasElement \|\| instanceof OffscreenCanvas`). Neither global exists here, so a valid wx canvas matches nothing and Pixi throws `Could not find a source type for resource` | Name the class: `new Texture({ source: new CanvasSource({ resource: canvas }) })` |
| `document.createElement('canvas')` | Answers in the SIMULATOR, throws on a device. Browser-only code therefore passes every simulator check and dies on a handset | `DOMAdapter.get().createCanvas(w, h)` — and only AFTER `DOMAdapter.set(WeChatAdapter)` has run, i.e. after `WeChatPlatform.createApp()` |
| `context.letterSpacing = '0px'` | **Poisons the context.** After the assignment `measureText` returns a non-finite width and `fillText` paints nothing. Pixi does it before every measurement and every draw, gated only on the property existing on the context prototype — which it does here | `disableBrokenLetterSpacing()` at boot (`render/textMetrics.ts`) turns Pixi's flag off after checking the invariant that a ZERO spacing must not change a measurement |

The last one is worth the detail because of how total and how quiet it was: every label in the
game rendered blank, `glGetError` was 0, the texture was allocated at a sensible size, and
`fillText` was called exactly as often as it should be, with the right arguments, at the right
coordinates. The only observable difference was that the canvas it drew onto was dead. It was
localised by bisecting Pixi's own draw sequence one call at a time inside the running
mini-game (1058 painted pixels without the assignment, 0 with it).

Both are now covered without a device by `client/src/render/wechatTextRaster.test.ts` and
`client/src/game/scene/wechatRoomBuild.test.ts` — the same "WeChat-shaped host, real Pixi"
method as `wechatAssetLoad.test.ts`, described under **Verification checklist**.

## On-device test plan (what a person holding a phone should actually do)

Everything below needs hardware and cannot be run from here. Ordered by what is most likely to
find something. Items 3/4/5/6 of the checklist correspond.

**Narrowed on 2026-08-26, for the arena.** Items 1 and 2 used to be open questions in both
directions: nobody knew what the PvP arena's frame cost, or whether its cost was shaders or
geometry. That much is now settled off-device — `arena_launch` runs at **~4 ms of GPU time per
frame on a desktop Intel Arc**, and the split is **~3.0 ms resolution-independent against ~0.7 ms
of fill**, with `layers.ground` alone accounting for 56% of the frame and all 294 wall blocks plus
124 pillars accounting for 10%. See design/01's "The arena's frame, measured on a GPU" and
`client/src/perf/README.md`'s fourth measurement. Two consequences for the device run:

- Item 2 (**is the low tier enough?**) is now the *less* informative half for the arena. `低`
  removes full-viewport passes and halves resolution, i.e. it attacks the ~20% of the arena frame
  that is fill. Expect it to help less there than it does in a PvE room, and treat "`低` barely
  helped in the arena" as a CONFIRMATION of the measurement rather than a surprise.
- ~~The thing actually worth reporting from the arena is whether the **resolution-independent**
  half holds, because that is draw submission and vertex work.~~ **Superseded 2026-08-28.** That
  sentence carried the FOURTH measurement's inference, and the fifth measurement falsified it:
  making the floor cullable cut submission 17x (1,730,364 -> 101,304 floats) and moved the GPU
  frame **not at all** (4.07 vs 4.28 ms, min/max bands overlapping). The arena floor's cost is not
  vertex or triangle work and never was — it is per-primitive fragment work on many small blended
  primitives, 45% of which was NEIGHBOURING rooms' mottle spilling on screen. `floorClip.ts`
  shipped for that on 2026-08-27 and moved the frame 0.53-0.93 ms. The fourth measurement's split
  is still the right *number* and the wrong *diagnosis*; see `client/src/perf/README.md`'s fifth,
  sixth and seventh measurements before quoting it at a device.
- So what is worth carrying to the phone is the `[perf]` warning's `update` vs `render` naming
  itself, with **no prediction attached**. A `render`-side breach with `低` pinned now means
  something this repo has *not* already eliminated on desktop — which is exactly what makes it
  worth a device, and why there is no longer an off-device fix waiting for it to justify.

**Setup.** 微信开发者工具 → 预览 to get a QR code, scan with the test account. For anything that
needs a console, use **真机调试** instead of 预览 — it mirrors the device's `console` into the
IDE, which is where the `[perf]` warnings land.

1. **Does it hold the frame? (item 3)** Play into a room with several enemies and fight for two
   or three minutes — the sustained-slow detector needs ~6 seconds under 25fps and will not fire
   on a loading hitch. Then open **设置** and read the quality button.
   - `自动` — the device held the high tier. That is the answer.
   - `自动 (低)` — the watchdog fired: this device cannot hold the high tier, and has already
     been dropped. **This is the result worth reporting**, along with the phone model.
   - On 真机调试, the `[perf]` console warning additionally names whether the expensive half was
     `update` (our sim + scene mirroring) or `render` (the GPU submission), which is the
     difference between a CPU problem and a fill-rate one.
2. **Is the low tier enough? (item 6)** In the same room, pin 画质 to `高`, play a minute, then
   pin it to `低` and play the same minute. This is the lighting-cost measurement: `低` removes
   all four full-viewport passes and halves the renderer resolution. If `低` is comfortable and
   `高` is not, the tiers are doing their job and the default (`自动`) is correct. **If `低` is
   still not comfortable, that is a real finding** — it means the cost is not in the shaders and
   the next place to look is the draw-call/entity budget, not the filters.
3. **Lowest base library (item 2).** 详情 → 本地设置 → 调试基础库 → set to the lowest version the
   project targets, then relaunch. Check: does it boot, do menus paint text, does a room load,
   does the art look right? The simulator has been run on the newest library only, and this is
   the single cheapest way to find a runtime difference.
4. **WebGL2 / NPOT (item 4).** On 真机调试, the boot console reports the renderer. What matters:
   if the device reports WebGL**1**, the shipped art is non-power-of-two and silently loses
   mipmaps, so look for shimmering/aliasing on the floor and walls when the camera moves. This
   is a picture-quality question, not a crash one.
5. **Touch feel (item 5).** The twin-stick is wired and works, but "works" and "feels right" are
   different claims and only hands can settle the second. Specifically worth judging: dead zone,
   stick radius, whether the fire stick's aim is precise enough at this zoom, and whether the
   left-handed mirror in 设置 actually lands where a left-handed player wants it.
6. **The package limit (item 11).** Only the upload dialog settles whether the 4 MB main-package
   cap is measured raw or compressed. `npm run check:wechatpackage` reports both numbers (3.32 MB
   raw / ~2.68 MB compressed as of 2026-08-25), so the upload either accepts it or names which
   one it meant.

What NOT to spend device time on: anything already closed in the simulator (boot, taps, layout,
text, art loading, subpackages, the shaders compiling). Those are items 1 and 7-16, and they were
verified against the real base library.

## Verification checklist

> Method used so far: drive WeChat DevTools via its CLI (`cli.bat open --project
> platforms/wechat`) and capture the window with `PrintWindow` + read `WeappLog` logs.
> Mini-games have no automation API to assert rendered pixels, so this is
> screenshot + log based, not programmatic — and it needs the simulator installed, which
> it is not on every machine (it was absent on 2026-08-25).

Because that method cannot run on a commit, the asset path is covered by a
**WeChat-shaped simulation suite** instead: `client/src/render/wechatAssetLoad.test.ts`
deletes `fetch` / `createImageBitmap` / `document` / `window` / `Image` / `XMLHttpRequest`,
installs a `wx` fake backed by the REAL shipped files, and runs the REAL `preloadCoreArt()`
through the real Pixi `Assets` pipeline and the real `WeChatAdapter`. The only fake is `wx`
itself. It pins: no loader touches a browser-only global; Pixi takes the `createImage`
branch; every path asked for is package-relative and names a real file; every registered key
of every loader resolves at the source art's real dimensions.

It cannot pin what the real base library does — that `wx.createImage()` fills `width`/
`height` before `onload`, that `readFileSync(..., 'utf8')` returns a string on the lowest
base library, or anything about uploading a wx `Image` to GL. Those stay below.

**What the shaders do on the real base library (2026-08-25).** The same in-bundle-probe method
as items 10/12/15, aimed at a question tests cannot reach: a filter whose program fails to
compile paints nothing and throws nothing, so nothing verified before this distinguished
"the lighting pass runs" from "the lighting pass silently does nothing". Method: step the game
into a real room by hand, hide `layers.menu` (`beginRun()` does not — see
`perf/frameProbe.ts`'s header, this trap wasted the first two attempts and made every diff read
zero), extract a VIEWPORT-sized frame, then remove one pass at a time and diff. Measured at
844x390 @ resolution 2:

| removed | frame changed | verdict |
|---|---|---|
| `SceneLightFilter` | **27.4%** | compiles, runs, materially lights the scene |
| `VignetteFilter` + `ChromaticAberrationFilter` | **26.4%** | both compile and run |
| the bloom-lite `BlurFilter` | **1.7%** (max delta 663) | compiles and runs |
| the whole low tier (filters only, constant resolution) | **48.2%** | matches the 48.8% measured on web |

With two liveness controls that both fired — hiding `layers.world` moved 93.8% of the frame,
hiding `layers.entities` 18.4% — and a restore that came back byte-exact (0%). Without those
controls none of the numbers above would mean anything: the first run of this probe extracted
`app.stage` with no frame, which uses the stage BOUNDS, i.e. the whole co-resident dungeon
floor, so 97% of every buffer was off-screen black and every percentage described that
emptiness rather than the picture.

The bloom row needed its own setup and is the reason to distrust a small number here: it blurs
the ADDITIVE `fx` layer, which is EMPTY unless something is firing, so the first measurement read
0% and meant "nothing to blur", not "shader dead". Spawning a muzzle flash first is what turned
it into evidence. Its small percentage with a large max delta is the correct signature for a
local glow — which is why `frameProbe`'s diff reports the mean over CHANGED pixels and a bbox
rather than a whole-frame mean.

**The new settings row is tappable here (2026-08-25).** Driven through the platform's own
`WeChatEventBridge` — the same path a real finger takes into Pixi's `EventSystem`, not a direct
`onTap()` call, which would prove nothing about whether this runtime can deliver a touch to a
widget (item 12). The quality button went `auto` -> `high` on one synthesized tap, with MUTE as
the control (`false` -> `true`) so that a failure would have distinguished "this button is dead"
from "this technique is dead". This is the check item 13 would have wanted: a newly added row on
a screen already known to be tight at 844x390.

The quality tier's resolution knob is confirmed here too: pinning `low` took the renderer from
2 to 1 and the extracted buffer from 1,316,640 to 329,160 pixels — exactly a quarter — with the
scene still fully lit (mean luma 45.2 -> 46.7, 0% black; brighter because the vignette is gone,
which is what a low tier should look like).

Two more suites now use the same method for the two paths that went through a 2D canvas
rather than the loaders, both written after the bugs in items 14 and 15 got through:
`client/src/render/wechatTextRaster.test.ts` (text, through the real `CanvasTextGenerator`)
and `client/src/game/scene/wechatRoomBuild.test.ts` (the room build, through the real
`RoomBuilder`). Both fake the context to behaviours actually MEASURED on the runtime rather
than to what a browser does — that difference is the whole point, since a browser-shaped fake
is exactly what let both bugs ship.

**The phased boot on the real base library (2026-09-01).** `design/12`'s two-phase asset boot
shipped earlier the same morning with three questions no device-less test could reach, and
`render/wechatPhasedBoot.test.ts` proving only the ORDERING against a wx-shaped fake. Measured
here on **base library 3.17.1** (DevTools 2.01.2510280, appid `wx25a3b18a3e83ffce`) with a
temporary in-bundle probe on the same USER_DATA_PATH breadcrumb channel as items 10/12/15 — a
stage marker written BEFORE each phase, so a missing report distinguishes "boot failed" from
"the last call is unsupported here". This is checklist item 17. A representative boot:

| ms | stage |
|---|---|
| 130 | `platform.createApp()` returned |
| 858 | boot progress screen on the stage |
| 915 → 1698 | `wx.loadSubpackage('lobby')` — the one wait a player sees |
| 1870 | `preloadLobbyArt()` resolved, **17/17 UI textures** |
| 1903 → 1926 | `beginDeferredArt()`, of which **6 ms** is the seven `wx.loadSubpackage` calls |
| 1995 | `game.start()` — the menu paints |
| 2810 → 2876 | the seven background/run packs resolve, ~850 ms into a live render loop |
| 3689 | `ensureRunArt()` resolved, **7/7 rig bundles** |

What that establishes, question by question:

- **The phased boot works.** After the lobby await, 17/17 `UI_ASSET_KEYS` resolve through
  `getUiTexture` at real dimensions (`hub` 384x288, `icon_play` 127x128); after the run phase,
  7/7 `CHAR_BUNDLES` reach `getRigSkin`, and all five biome floors plus `wall_fire`,
  `getWeaponTexture` for both sampled weapons, `getDoorCurtainTexture()` and
  `getPortalArchTexture()` are defined. A pack fetched while the game is already rendering
  behaves like one fetched before `Application.init` — the run packs settled ~850 ms after
  `game.start()` and their loaders still filled every map. `isRunArtReady()` was false for the
  first 1.4–1.7 s and then flipped, so the gate genuinely arms here.
- **Seven concurrent `wx.loadSubpackage` calls are fine.** The instrumented in-flight count
  climbed 1 to 7, all seven reported `success` 885–951 ms later, and every texture out of them
  resolved. So `packLoader.ts`'s `ensurePacks` is not being serialised. Undocumented remains
  undocumented.
- **The background download does not hitch the lobby**, and only the control makes that an
  answer. Over an 8 s window from the first menu frame, with instrumentation matched between
  arms:

| | frames | mean | p50 | p95 | >33 ms | >50 ms |
|---|---|---|---|---|---|---|
| deferring, run A | 324 | 24.4 | 19.9 | 31.6 | 5 | 5 |
| deferring, run B | 313 | 24.8 | 19.8 | 31.9 | 5 | 4 |
| control (no kick), run A | 298 | 26.9 | 30.2 | 31.9 | 3 | 3 |
| control (no kick), run B | 304 | 26.5 | 29.8 | 31.8 | 3 | 3 |

  The deferring runs are *better* on every central measure and carry two extra long frames per
  window, all inside the first 1.7 s — where both controls have long frames too. Nothing to
  serialise, nothing to de-prioritise. `deltaMS` is clamped by Pixi's `minFPS` of 10, so a
  reported max of 100 is a ceiling and not a measurement. The median inversion is unexplained,
  which is itself the reason to read these as simulator numbers only.

**Three traps this probe walked into, all worth reusing.** (a) **`writeFileSync` costs ~28 ms a
call on this runtime.** The first clean-looking result said `beginDeferredArt()` blocked the main
thread for 199 ms; removing the probe's own seven report writes from inside it took that to
**6 ms**. A breadcrumb probe that flushes inside the thing it is timing fabricates exactly the
hitch it went looking for — write breadcrumbs around a measured span, never inside it.
(b) **The before/after readability control is VOID in the simulator.** Reading a pack's file with
`readFileSync` *before* its `loadSubpackage` was supposed to throw and did not: every one of the
eight returned full bytes, because the simulator serves the whole project directory off disk. So
nothing here — including item 9's 2026-08-25 claim that `wx.loadSubpackage` "works for real" —
distinguishes "the load made these files reachable" from "they were never unreachable". The
texture-resolution counts are still evidence that the phase ORDER is right; they are not evidence
about what `loadSubpackage` does. That separation needs a device. (c) **Control and treatment must
carry the same instrumentation.** The first control run was taken with the per-pack file reads
still enabled — ~1 MB of synchronous reads inside the measured window — which made it
incomparable with the treatment runs and briefly pointed the wrong way. Both arms were re-run
with identical probe builds before the table above was believed.

1. [x] Integrate the adapter; the `client` build boots in WeChat DevTools and renders the tilted-view scene. *(2026-07-07, base lib 3.15.2)*
2. [ ] Verify on the **lowest target base-library version** (not just the latest). **This is now
   blocking-shaped rather than hypothetical**: the condition an earlier version of this item set —
   "it becomes blocking the moment the cue catalogue lands" — was met on 2026-08-27, and every
   audio asset in the game is loaded on this platform today. Five questions ride on it:
   - whether `wx.createWebAudioContext()` exists at all (the sampled cues degrade to the synth
     voice table if not, `design/11`; **music is deliberately independent of it**, so a base
     library without it keeps the bed and loses the samples);
   - whether the 61 shipped **MP3** cue assets decode there. MP3 was chosen partly because
     `design/11` calls it universally decoded on WeChat, but every measurement behind that choice
     was taken in a desktop browser;
   - which shape that context's `decodeAudioData` takes — `audio/decodeAudio.ts` accepts both the
     promise and the callback form, and only a device says which one is real;
   - whether `wx.createInnerAudioContext()` accepts a path inside a **loaded subpackage**
     (`packs/music/audio/music/menu.mp3`). Package files are package files and `wx.loadSubpackage`
     has resolved long before `Game` exists, so this should simply work — but a failure is one
     `onError` line and a silent bed, which is exactly the shape nothing else here catches;
   - how `InnerAudioContext.currentTime` behaves across a real audio interruption, since that
     value is what `MusicPlayer` decides the loop wrap from.
3. [ ] Real-device check: frame rate on low-end Android (target 30 vs 60 fps). **Now readable
   without tooling** (2026-08-25): the frame watchdog (`render/qualityWatchdog.ts`) drops the
   renderer to the low tier after ~6s below 25fps, and the settings screen then reads
   `AUTO (LOW)` / `自动 (低)`. So the device answers the question itself — open settings after
   a few minutes of play and read the button. A remote-debug console additionally shows the
   `[perf]` warning, which names whether the expensive half was update or render.
4. [ ] Verify WebGL2 availability; define a fallback path if unavailable. **See "WebGL1
   degrades silently" above** — the fallback already exists inside Pixi and is invisible;
   what is unknown is only whether any target device takes it. The simulator reports WebGL2
   with NPOT mipmaps and wrapping (item 9), so this is a device-only question. It is not purely
   a performance one: the shipped art is deliberately non-power-of-two (104x128, 249x256,
   384x288...), so a device that silently falls back to WebGL1 loses mipmaps on all of it,
   which is a picture-quality regression rather than a crash.
5. [ ] Touch input on a real device (twin-stick logic is wired; feel needs hands-on).
6. [ ] Milestone 2: dynamic lighting (`SceneLightFilter`) performance on the lowest base
   library + low-end devices. Two halves, and one of them is now closed: **the pass compiles
   and does real work on the real base library** (2026-08-25 — removing it from the live scene
   in the simulator changes a large fraction of the composited frame, so it is not silently
   failing to compile). What remains is purely the COST on a handset — and unlike before, a bad
   answer now has a remedy: `render/quality.ts`'s low tier turns this pass off along with the
   other three, and halves the renderer resolution. To measure it by hand on a device, pin the
   quality setting to `HIGH` and then to `LOW` in the same room and compare.
7. [x] Real art loads at all, through the real loaders, in a runtime with none of the
   browser globals. *(2026-08-25, `wechatAssetLoad.test.ts` — simulation, not a device.)*
8. [x] The package fits, gated by `npm run check:wechatpackage`. Main was 3.41 MB / 4.00 MB
   plus four subpackages when this was ticked *(2026-08-25)*; since 2026-09-01 it is
   **0.95 MB / 4.00 MB plus eight subpackages** and the art arrives in phases — see
   **Package budget** for the live table, and item 17 for the device check on the phases.
9. [x] **Real art loads in the real simulator.** *(2026-08-25, DevTools 2.01.2510280, appid
   `wx25a3b18a3e83ffce`.)* Everything item 7 could only simulate is now confirmed against the
   actual base library: 7/7 rig bundles, 5/5 biome element sets, 17/17 UI textures, 11/11
   environment sprites, 25/25 weapon textures plus both kind defaults — all at the exact
   post-downsampling dimensions. **`wx.loadSubpackage` works for real**: `boss-core` and the
   ice/lightning/poison swatches came out of subpackages. And the runtime reports
   **`webGLVersion: 2`** with `nonPowOf2mipmaps: true` / `nonPowOf2wrapping: true`, so the
   silent-degradation hazard above does not bite in the simulator (a low-end device is still
   unknown — that is item 3).
10. [x] **`new Game(...)` did not survive this runtime — root cause found and fixed
   (2026-08-25).** Not the suspected shader compile: the `Game` constructor read
   `location.search` behind a `typeof location !== 'undefined'` guard
   (`parseGameQueryParams`, design's `?query=` dev overrides), and the WeChat mini-game
   runtime injects a compat `location` (with an always-empty `.search`) for libraries that
   probe it, but has no `URLSearchParams` at all — `new URLSearchParams(...)` threw a bare
   `ReferenceError` that `boot().catch(reportWeChatBootFailure)` only logged to a console
   DevTools keeps off disk. Fixed by guarding on both globals (extracted into
   `readGameQueryParams()`, `client/src/game/match/gameQueryParams.ts`) — there is no
   `?query=` to parse on this platform anyway. **Verified in the real simulator**
   (DevTools 2.01.2510280, appid `wx25a3b18a3e83ffce`) via a temporary USER_DATA_PATH
   breadcrumb probe: boot reaches `installPerf` with `ok:true`, the ticker reaches 90
   ticks, and `renderer.extract.pixels(app.stage)` reads a non-blank composited frame
   (mean luma 70.33) — the render loop is alive and drawing real content, not stuck or
   painting black. Free-form interactive playtesting (tapping AROUND through menus,
   watching what happens) is still not automatable here — `miniprogram-automator`'s
   `evaluate`/`screenshot` hang against a GAME target regardless of boot success
   (reconfirmed the same session) — but see item 12 below for a narrower technique that
   DOES work for a single targeted claim ("does tapping THIS button do THAT").
11. [ ] DevTools' upload dialog still has to settle whether the 4 MB limit is measured raw or
   compressed (see **Package budget**).
12. [x] **Every menu/HUD Button and Slider was silently unclickable on WeChat — found and
   fixed (2026-08-25, same day as item 10).** Root cause: `Button`/`Slider`
   (`game/ui/widgets.ts`) are built entirely on Pixi's own interaction system
   (`eventMode:'static'` + `.on('pointertap', ...)`), which only works because a real
   `HTMLCanvasElement` dispatches real events Pixi's `EventSystem` listens for. The wx
   canvas has no DOM event API at all — `WeChatPlatform.createApp` gave it harmless
   `addEventListener`/`removeEventListener` no-ops just so `Application.init` didn't
   crash calling them, which meant nothing ever fed Pixi's `EventSystem` anything to
   hit-test. `TouchControls` (the in-run twin-stick scheme) was unaffected — it
   hit-tests screen-space geometry itself and never went through Pixi's interaction
   system — which is exactly why this had gone unnoticed: the game LOOKED playable
   (renders, twin-stick moves/fires) right up until a player tried to tap PLAY.
   **Fix**: a new `platform/wechat/weChatDomEvents.ts` installs a real (if minimal)
   listener registry on the canvas, and `WeChatInput` drives it per touch — the first
   touch to start, while none other is already driving it, becomes a single synthetic
   mouse pointer (Pixi's `EventSystem` always takes its plain-mouse branch here, since
   this runtime has neither a global `PointerEvent` nor `TouchEvent`/`'ontouchstart'`,
   so replicating the touch branch would buy nothing over the simpler mouse shape).
   `mouseup`/`mousemove` are registered by Pixi on `globalThis`/`globalThis.document`
   rather than the canvas (hardcoded in `EventSystem.js`, not something an `Adapter` can
   redirect) — both already exist in this runtime (proven by `Application.init()` not
   throwing), so the fix wraps just those two `addEventListener` calls to also capture
   the handler, forwarding through to the original. **Verified in the real simulator**:
   a temporary probe wrapped `wx.onTouchStart`/`onTouchEnd` to capture WeChatInput's own
   registered callbacks, then — once MainMenu had had a few frames to build — read the
   real PLAY button's `getBounds()` and fed a synthetic touch through that SAME real
   callback chain at that exact position. Result: `Game.phase` flipped from `'menu'` to
   `'modeSelect'`, proving the full chain (wx touch → bridge → Pixi hit-test →
   `Button.onTap` → the game's own screen-flow) works end to end, not just in a unit test
   against a fake bridge. This targeted "synthesize one real tap, assert one real state
   change" technique is the answer to item 10's "not automatable" note above wherever the
   claim under test is narrow enough to state as a before/after — it does not extend to
   open-ended playtesting.
13. [x] **The Forge was a dead end on a landscape phone — found and fixed (2026-08-25,
   same day as items 10 and 12, and only reachable once both of those were closed).**
   Reported live from the simulator as *"点击开始游戏后会卡在选武器的页面，因为进入地图的
   按钮看不到"*. Not an input bug and not a WeChat bug: the 844 x 390 landscape viewport is
   about half the height every menu screen is laid out for, so the Forge's fixed bottom
   action bar (`h - 60` = 330) sat inside a blueprint grid that flows to y≈509, and START
   RUN painted over the weapon cards instead of below them. **Fix**: a fit-scale on a new
   `Layers.menu` container — see **Viewport** above. **Coverage**:
   three layers, sized by a mutation battery rather than by feel — the first 20-mutant run
   killed only 14, and each survivor was a real hole (the width axis of the fit was never
   exercised, the minimap's mount point was untested, and `Game.ts` had NO coverage at all:
   even the control mutant survived, since no test imported it). See the ROADMAP entry for
   the full account. The three layers:
   `client/src/game/ui/menuLayer.test.ts` (the scale math and the `mount` paint-order
   contract), `client/src/game/screens/viewportFit.test.ts` (all nine screens at seven real
   viewports — two of them width-bound, so the fit's width axis is exercised at all — then
   again across **all eight shipped locales** at the tightest one, since translated copy
   changes measured text width and the Forge flows its layout off `Text.height`; plus two
   harness checks pinning that the original bug reproduces when the fit-scale is skipped, a
   sweep that cannot fail proving nothing), and
   `client/src/game/gameViewport.test.ts` (the composed property in REAL pixels: `Game` is
   constructed headlessly against a fake `Application` and each screen's on-screen bounds
   must both FIT the viewport and FILL it — "fits" alone passes trivially when the fit is
   skipped, since the layout just squeezes into the top-left 61%). Verified live at exactly
   844 x 390 through the web entry too — the whole Forge fits, and a synthetic pointer at
   START RUN's on-screen position moves `phase` from `'forge'` to `'playing'`, so
   hit-testing survives the container scale.
   *Second, pre-existing bug found in the same area*: the forge's floating SETTINGS button
   was mounted before the screens, so it rendered underneath the hub Panel — invisible and
   untappable at every viewport, desktop included. It is now mounted above them.
14. [x] **Entering any room crashed — found and fixed (2026-08-25, fourth blocker of the
   day).** `Error: Could not find a source type for resource: [object HTMLCanvasElement]` out
   of `RoomBuilder.build`. `capLight.bakeLitCap` (the 2026-08-24 draw-call pass) bakes the
   wall cap's key light through a 2D canvas and then called `Texture.from(canvas)`, which
   chooses a source class by testing the resource against `HTMLCanvasElement` /
   `OffscreenCanvas` — neither of which is a global here, so the canvas matched nothing.
   Fixed by allocating through `DOMAdapter` and naming the class
   (`new Texture({ source: new CanvasSource({ resource: canvas }) })`), with the construction
   inside the existing try so an incapable host falls back to the old two-sprite additive cap
   instead of failing the room build. **A latent device-only boot crash fell out of the same
   read**: `main.wechat.ts` ran `pinTextMeasurementToPaintCanvas()` before
   `platform.createApp()`, i.e. before our adapter is installed, so it allocated through
   Pixi's BROWSER adapter — `document.createElement`, which the simulator answers and a device
   does not. Reordered, and the pin can no longer throw. Covered by
   `client/src/game/scene/wechatRoomBuild.test.ts` in both host shapes (with a `document` and
   without), which fail differently: the simulator shape crashed, the device shape silently
   skipped the bake and paid two draw calls per wall cap forever.
15. [x] **Every label in the game was blank — found and fixed (2026-08-25, fifth blocker).**
   Sprites drew, text did not, `glGetError` was 0, the glyph texture was allocated at a
   sensible size, and `fillText` was called exactly as often as it should be with the right
   arguments at the right coordinates. Cause: Pixi feature-detects `context.letterSpacing` on
   the 2D context PROTOTYPE, this runtime carries it, and **assigning the property poisons the
   context** — after it, `measureText` returns a non-finite width and a draw paints nothing.
   Pixi does that assignment before every measurement and every `fillText`. Localised by
   bisecting Pixi's own draw sequence one call at a time inside the running mini-game: 1058
   painted pixels with the step omitted, 0 with it included. Fixed by
   `disableBrokenLetterSpacing()` (`render/textMetrics.ts`), called from both entries, which
   checks an invariant rather than a platform name — a spacing of ZERO must not change what a
   measurement returns — and turns Pixi's flag off when it fails, dropping to the
   per-character drawing path. A non-finite guard on the measurement itself
   (`withFiniteMetrics`) sits under it, because Pixi's `?? 0` guards a MISSING field and not a
   NaN one, and `Math.max(43.3, NaN)` is NaN — which is how the width reached the glyph canvas
   as `NaN` and collapsed it to 1px. Covered by `client/src/render/wechatTextRaster.test.ts`.
   See **Canvas2D on this runtime**.

16. [x] **The shaders were never shown to COMPILE here, and there was no way to turn them
   off. Both closed (2026-08-25).** Every perf number in `01` came from a desktop Chrome, and
   the four full-viewport passes plus the per-actor skin shaders plus the renderer resolution
   all ran unconditionally — so items 3 and 6 were unanswerable in the only sense that matters:
   a bad answer had no remedy attached. `render/quality.ts` is the remedy (see `01`'s **Render
   quality tiers**), and the compile question was settled by measurement rather than by
   inference — see **Verification** below for the probe and its controls.

17. [x] **`design/12`'s two-phase asset boot works on the real base library, seven concurrent
   subpackage loads are safe, and the background download does not hitch the lobby
   (2026-09-01, base library 3.17.1).** The main package is `js/game.js` alone (0.95 MB / 4.00 MB)
   with eight subpackages, and `platforms/wechat` carries no stale top-level `ui/` / `skins/` /
   `biome/` / `weapons/` / `environment/` copy — the prune-by-exclusion holds on a real build.
   All three answers, the boot timeline, the frame-time table and the three measurement traps are
   under **The phased boot on the real base library** above. Two things did NOT come out of it:
   the byte-accurate progress bar (`LoadSubpackageTask.onProgressUpdate` is real and now typed,
   but reports one event at `progress: 50` with an expected size of ~3.7 kB for every pack, so the
   bar keeps counting units — see `design/12`), and any separation of "`loadSubpackage` made these
   files reachable" from "they were always on disk", which this simulator structurally cannot give
   (trap (b) above, and it retroactively narrows item 9).

**How to get diagnostics out of a mini-game at all.** There is no automation API worth the
name: `miniprogram-automator` *connects* to `cli auto --auto-port` (use `ws://127.0.0.1:…`,
not `localhost` — the port binds IPv6-only), but every method on it is 小程序-shaped
(`pageStack`, `navigateTo`, `currentPage`) and both `evaluate` and `screenshot` hang forever
against a GAME. What does work is making the game report on itself: write a JSON file to
`wx.env.USER_DATA_PATH`, which lands on disk under
`User Data/<profile>/WeappSimulator/WeappFileSystem/<openid>/<appid>/usr/` and can be read
from outside. Write the report BEFORE any step that might hang, and drop breadcrumbs at each
boot stage — a probe that only writes at the end cannot tell "boot failed" from "the last
call is unsupported here".

   *Status 2026-08-25:* DevTools is installed and `platforms/wechat` now carries a seeded
   `project.config.json`. Three gates were hit getting there, all worth writing down:

   - **Do not install the newest version winget offers.** `winget install
     Tencent.WeixinDevTools` gives `2.02.2608050`, whose **QR login is broken**: the scan
     completes (`[LoginState] qrcode-login-complete { hasUser: true, hasTicket: true,
     hasSignature: true }` in `WeappLog/logs`) but the second-stage `login update {…}` that
     commits the session never arrives, so WeChat says "登录成功" on the phone while the tool
     stays logged out. Only 游客模式 could log in. Pinning the previous major line —
     `winget install --id Tencent.WeixinDevTools --version 2.01.2510280 --force` — fixes it
     outright. Network, proxy, clock and multi-instance were all ruled out first; the
     `WeappLog/logs` `[LoginState]` sequence is what identifies it, since nothing is
     surfaced in the UI.
   - **The CLI needs 设置 → 安全设置 → 服务端口 switched ON**, once, by hand. That is a
     security setting, so it is a person's call, not something the build should flip.
   - **A mini-GAME project needs a real registered appid.** `touristappid` and an empty
     appid are both rejected by `cli open` with `不存在此 AppID (code 10)`, even from a
     logged-in session. `cli.bat` lands in `C:\Program Files (x86)\Tencent\微信web开发者工具\`.
