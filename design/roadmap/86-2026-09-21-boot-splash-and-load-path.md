# Work log — 2026-09-21

Volume 86. See [`design/ROADMAP.md`](../ROADMAP.md) for the index and the phase spine.

## A loading page with a floor under it, and four things measured on the way to the menu (2026-09-21, client + build + docs, no engine change)

> *"add a loading page when entering the game, held for at least 3 s. Today you sometimes get a white screen on the way in. While you are at it, check the current loading strategy — I want the first page as small as it can be, and as fast as it can be to get into"*

Three asks in one sentence — a loading page with a three-second floor, a white screen to explain,
and the loading strategy to look at — and the honest way to take the third one is to measure
before touching anything. Resource timing off the live deploy (`b.gamestao.com`), cold load:

| what | starts | ends |
| --- | --- | --- |
| `index.html` | 0 ms | 642 ms (TTFB) |
| `/assets/index-*.js` (287 kB gzipped) | 651 ms | 3170 ms |
| `WebGLRenderer` / `RenderTargetSystem` / `BufferResource` | 3339 ms | ~3470 ms |
| `browserAll` / `webworkerAll` | 3565 ms | ~4840 ms |
| the 70 SFX files | 6272 ms | ~6520 ms |
| run-phase skin sidecars (`beginDeferredArt`) | 6627 ms | ~6810 ms |

Six seconds to a menu, and only the second row of that table is bytes the player had to wait for.

### The white screen was two different things, and only one of them is the network

The first 642 ms is a browser painting its own default over an empty document, and nothing that
runs inside the page can cover it — that half is the HTML request, and it is why the splash lives
in `index.html` as static markup rather than being drawn by anything this bundle contains.

**The second half was ours.** `main.ts` ended with
`document.getElementById('boot-loading')?.remove()`, one statement after `game.start()`.
`start()` populates the stage; it does not draw it. The renderer draws on its next tick, so the
splash was removed to uncover a canvas the menu had never been rendered onto — and a canvas that
has never been drawn to is blank. The gap is one frame wide, which is exactly the shape of a bug
reported as *"sometimes"*.

`bootSplash.afterFirstRenderedFrame` closes it, and the interesting part is why it takes **two**
ticker hops rather than one. `Application` renders from a ticker listener at
`UPDATE_PRIORITY.LOW`, which runs *after* one added at the default priority — so the first
callback fires before that tick's render, not after it. The second fires on the following tick,
by which time the render in between has happened and the browser has painted it. A one-hop
version passes any test that only asks "does it resolve".

It also has a **timeout**, and that was not defensive programming: a ticker is driven by
`requestAnimationFrame`, and a tab opened in the BACKGROUND is never handed one. Found by
running it — a preview pane left hidden sat on `lastTime` and `boot()` never returned. Nothing is
lost by giving up on a frame nobody can see, and what it costs to leave out is a boot that never
finishes.

### The floor is counted from the page opening, not from the first line of JavaScript

`bootHold.ts`, `MIN_BOOT_SPLASH_MS = 3000`, shared by both splashes this game has — the DOM one
on web and the portal, the Pixi one on WeChat (`showBootLoading`'s `done()` returns a promise
now, and `main.wechat.ts` awaits it). Measuring from navigation rather than from module
evaluation is the whole point: the 642 ms + 2.5 s above is time the player has already spent
looking at it, and charging them three more seconds for it would be the opposite of what a floor
is for. `performance.now()` is exactly that number where `timeOrigin` exists; WeChat has no
navigation to be relative to, so it falls back to the module's own load time — and a `now()`
without a `timeOrigin` is the tell, because a mini-game's epoch can be hours old and the floor
would silently never apply.

The splash itself grew a real progress bar (driven by `preloadLobbyArt`'s own per-item ticks, not
a timed animation), a fade, and a *"still loading — check your connection"* line revealed by a
**CSS animation at 15 s** rather than by script, so it still appears in the one case where no code
of ours is ever going to run.

### Four findings in the loading strategy, three fixed

**1. Pixi's renderer chunks were arriving one round trip late.** The 3339 ms row above: they are
reached through dynamic `import()`, so the browser cannot discover them until the entry chunk has
downloaded, parsed and run. ~1.5 s of pure latency for ~55 kB of code.
`build/runtimeChunkPreload.mjs` emits a `<link rel="modulepreload">` for each into the head, so
they fetch alongside the entry chunk. **A name list, not "every chunk"** — `WebGPURenderer`,
`CanvasRenderer` and `BitmapFont` are 69 kB this build never loads, since `WebPlatform` pins
`preference: 'webgl'` — and a name matching no emitted chunk **fails the build**, because a Pixi
upgrade that renames them would otherwise turn the whole thing into a silent no-op with
everything still green. Same guard shape as `vite.crazygames.config.js`'s `applied` flag, which
exists for the same class of silence.

**2. Every art file was being revalidated on every visit.** Found while checking whether the
`/ui/` pack could be preloaded from the document. `_headers` named the page, the version manifest
and `/assets/*`, so all ~200 shipped art and audio files fell to Cloudflare's static-assets
default: `public, max-age=0, must-revalidate`. That lets the browser keep the bytes and requires
it to ask before using them — a returning player opened a conditional request per file, every
visit. **They come back 304 with no body, which is why this was invisible in a bytes-transferred
view.** A round trip per file, batched behind the connection limit, is the same wait whether or
not bytes come back with it. The six asset directories now carry
`max-age=3600, stale-while-revalidate=604800`; `immutable` is not available here the way it is for
`/assets/*`, because the art is not content-hashed and would pin a player to whatever they first
downloaded with no URL to release them. What makes an hour of staleness safe to trade is
`design/12`'s own rule — **art is pure presentation and never feeds the engine** — so a player
briefly running new code against older textures sees an older icon and cannot desync.
`build/checkAssetHeaders.mjs` fails the build if a directory under `client/public/` has no rule,
because a new art directory would land in exactly the same silence.

**3. The SFX preload was competing with the download the player was waiting on.** 70 files,
kicked beside `createAudio()` — i.e. before `preloadLobbyArt()`. Every cue has a procedural voice
and none can be triggered before there is a menu, so there is nothing to buy by starting them
earlier and a slower first screen to pay for it. Moved below the lobby await in all three entries.

**4. The first download itself**, which is the one that needed a decision rather than a fix.
Attributing the 912 kB entry chunk back to its sources through the build's own sourcemap put
`src/i18n/locales` third at **85 kB (9.4%)**, behind PixiJS (306 kB) and `@dd/engine` (117 kB) and
ahead of every screen. Eight tables ship; a visit can read one.

### The seven locale tables leave the bundle, and the test cost is paid rather than avoided

A control build with the other seven removed came out **22 kB smaller after brotli** — so
`loadLocale.ts` now holds one `import()` per locale and only `en.ts` stays static (it is the
source-of-truth locale every other is typed against, and it is the fallback; a fallback that can
itself be missing is not one).

`t()` **stays synchronous** — 1,500 call sites, and an async seam there is an async seam
everywhere — so the split lives entirely in *when* a table is registered, and `lookup()` grew one
arm: an unregistered locale falls back to English. That is a silent fallback, so each of the three
places it could hide is closed explicitly:

- the entry points **kick `ensureLocale(persistedLocale())` early and await it before
  `new Game(...)`**. Before, because screens read `t()` while being CONSTRUCTED — a table landing
  a tick later leaves English baked into labels nothing re-reads. Kicked early rather than awaited
  in place, so the chunk's round trip overlaps `createApp()` and the `lobby` pack instead of being
  a new one after the bundle; both orderings are source-order assertions, the technique
  `wechatPhasedBoot.test.ts` established;
- the settings screen's language button calls **`useLocale`**, not `setLocale` — load, then
  switch. `setLocale` alone would redraw that screen in English and leave it there, which is
  precisely the property the old comment on that button claimed it had;
- **`prefetchLocales()`** runs once the lobby is up, beside `beginDeferredArt()` and never
  awaited, so the button is a toggle rather than a fetch by the time anyone reaches it.

A failed import resolves rather than rejects and drops itself from the memo, so a retry is
possible — a memoised rejection would pin a player to English for the session.

**~60 `setLocale('zh')` calls across 27 test files became `await useLocale('zh')`**, and the
functions around them became `async`. The cheaper option was a vitest `setupFiles` registering all
eight tables so no test had to change; it was rejected, because it would leave every test running
against a state production never has — which is exactly how *"the language silently stayed
English"* gets shipped green.

### What is left, and why it is not a packaging problem

`@dd/engine` (117 kB), `game/scene` (71 kB) and `game/fx` (46 kB) are 26% of the chunk and none of
them is needed to draw a menu. They cannot be split without an architectural change, and the
reason is worth recording so it is not re-derived: **`game/runState.ts` imports the engine**, and
`runState.ts` is the pure lower layer the whole client rests on — `ScreenNav`, the main menu and
every other lobby screen reach it. 79 non-test modules import `@dd/engine`. Moving it behind the
run gate that already exists for the run ART is the right shape and a real project.

Two things were checked and are **not** the remaining lever. Compression: the edge already serves
brotli (285 kB against 294 kB gzipped). And preloading the lobby art from the document: Pixi
fetches textures inside a **web worker**, whose requests do not appear in the page's own network
timeline, so whether a `<link rel="preload" as="image">` would be a cache hit or a second 432 kB
download could not be verified — and shipping that unverified is a coin flip on the one download
in front of the menu.

### *"are there tests worth adding"* — five holes, and every one of them was a silence

The follow-up pass, run the way volumes 80 and 81 ran theirs: not "more assertions", but *where
could this pass be wrong with the suite still green*. All five answers were the same shape.

**1. The module is written to fail silently, and nothing checked the file it depends on.**
`bootSplash.ts` shrugs when `getElementById` answers `null` — that is a legitimate, tested state,
because it is the WeChat runtime, which has no DOM. Which means renaming `boot-progress` in
`index.html` leaves a bar that never moves, and renaming `boot-loading` leaves the splash sitting
over the running game for the rest of the session — **with every test in the file still green**,
because they all hand in their own `doc`. Six cases now read the real `client/index.html`: both
ids, the `.is-hiding` rule actually setting `opacity: 0`, the CSS transition duration **equal to
`BOOT_SPLASH_FADE_MS`** (longer removes the element mid-fade, shorter leaves a transparent splash
parked for the difference — two numbers in two languages in two files that have to agree), the
dark background on `html, body` rather than on the splash alone, the slow-connection hint still
being revealed by a **CSS animation** rather than by script (its one purpose is the case where no
script of ours ever runs), and the whole splash being **markup with exactly one `<script>` in the
file** — the entry module.

**2. The boot ORDER had four new load-bearing steps and no assertions.** `bootSequence.test.ts`
covers all three entries: the first rendered frame before the hide (reversing them restores the
blank frame this pass existed to remove), the hide **last** in `boot()` (it is a wait of up to
three seconds, and the auto-reload install was sitting where it could be queued behind it), the
SFX kick after the lobby pack, and `preloadLobbyArt` still being **passed its progress callback**
— the parameter is optional, so dropping it leaves the bar parked at 20% for the whole download
it describes.

**3. `persistedLocale()` shipped with no test at all**, and its interesting property is not the
happy path: it must read **the same storage key `SettingsBinding` will read a moment later**. Two
different defaults would mean the game switching to a language whose table was never fetched —
and `t()` answers in English rather than failing, so the only symptom is a menu in the wrong
language on a returning player's visit.

**4. A plugin that is correct and not listed does nothing.** `portalBuild.test.ts` pinned the
portal config's plugin list for its own reasons; the web build had nobody watching, so deleting
`runtimeChunkPreload()` from `vite.config.js` was a one-word edit that breaks no test, ships a
working game, and puts the 1.5 s back.

**5. …and the same is true one level up: a gate that is not in the chain never runs.**
`checkScriptChain.test.mjs` asserts every `check:*` script is in `npm run check` or exempt with a
written reason (two are: coverage and the logic gates, both minutes rather than seconds and both
their own CI job). Wrappers like `check:full` are excluded by **deriving** them — a `check:*` that
itself runs `check` is a superset — rather than by name, so a future wrapper needs no edit and
cannot become a hiding place.

**Twenty-three mutations, twenty-three killed** — but only twenty-two on the first pass. The
survivor was *"run the slow suite before the fast gates"*, and **the test was at fault**: it read
`indexOf('npm run typecheck') < indexOf('npm run test')`, and moving the suite to the front
removes `typecheck` from the chain entirely, so `indexOf` answers −1 and −1 is less than
everything. The file's own header warns about exactly that trap for source-reading needles, two
paragraphs above the assertion that fell into it. It now splits the chain on `&&` and names the
first and last step, which is the claim it meant to make.

### The sweep matched literals, and eleven call sites went hollow

Found by a peer session reviewing its own file, not by me, and it is the most instructive thing
in this pass.

The rewrite from `setLocale('zh')` to `await useLocale('zh')` was done with a regex over the
LITERAL form. Eleven call sites across eight files switch locale inside a
`for (const locale of LOCALES)` loop, where the argument is a variable — so the regex matched
nothing there, and **a source-reading sweep's worst failure is matching nothing**, applied to
the sweep itself rather than to a test.

Those eleven kept compiling and kept passing, which is the whole problem: with the tables now
lazy, seven of every eight iterations ran against the English fallback. `contentNames.test.ts`
is the one that hurts — it is the *test-time* replacement for the compile-time exhaustiveness
that content nameKeys cannot have (they are runtime strings, not `TranslationKey`s), and it
quietly stopped checking seven locales. The per-locale WIDTH sweeps (`labelFit`, `viewportFit`,
`widgetOverlap`, `textMetrics`) stopped measuring the long strings they exist for: the Russian
labels that motivated `autoWidth` in the first place were being measured as English.

**Measured, not argued.** Break one Russian content name and run the single-loop parity test:
with `await useLocale(locale)` it is **1 red**; with the pre-fix `setLocale(locale)` it is
**0 red, fully green**. (The first two attempts at this control were invalid — one neutered
`useLocale` and tripped an unrelated case, the other ran in a file whose earlier loop had
already loaded every table. A control that shares module state with the thing it is controlling
for is not a control.)

All eleven now `await useLocale(locale)`, and all 1,000 cases in those files pass — so nothing
had been masked; the tests were hollow, not wrong.

**The guard is a property, not a regex**, because a regex is what failed: in a test file the
only argument `setLocale` may take is `'en'`, the one locale that is statically bundled and can
never be missing. Everything else goes through `useLocale`, whatever shape the argument has.
`loadLocale.test.ts` is the single exemption and has to be — it is the file that pins "renders
English until the table lands", so it must be able to do the forbidden thing — and the scan
asserts it found 200+ test files and at least one `setLocale` before concluding anything, since
an empty scan is the way this class of check goes green over nothing.

### Numbers

Entry chunk **912.12 kB → 829.68 kB** raw, **289.66 → 261.56 kB** gzipped. Client suite
7,077 → **7,178** green. Three new build-level suites in the root `test`
(`runtimeChunkPreload`, `checkAssetHeaders`, `checkScriptChain`) and one new gate in
`npm run check` (`check:assetheaders`). No `ENGINE_VERSION` bump — nothing in `@dd/engine` was
touched.
