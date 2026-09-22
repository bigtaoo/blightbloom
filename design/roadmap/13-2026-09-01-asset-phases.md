# Work log — 2026-09-01 — the asset phases

One volume of the implementation log. The index, the phase spine and the rules for
appending live in [../ROADMAP.md](../ROADMAP.md); entries here are in date order.

## The first download becomes code only (2026-09-01, client + build + docs)

*"on the first package: I think it only needs the code and the loading screen's images. Everything else can be downloaded in batches."* The question came
out of the previous day's byte crisis: main had **2,729 bytes** of headroom, the music runtime is
code, and the fix that had shipped was to move one 606 kB PNG into a pack named for its own
symptom. The user's read was that the whole arrangement was backwards — the first download should
be code, and everything else should arrive while the player is in the lobby.

It was, and the reason is worth stating plainly: **the pack table shipped on 2026-08-25 bought
nothing it was capable of buying.** `preloadCoreArt` called `ensureAllPacks()` — all six packs, at
boot, in parallel. That satisfies WeChat's 4 MB rule (it is a rule about the FIRST download, and a
pack fetched a moment later is compliant) and it was argued as such at the time. What it left in
place was a byte tax on code: art held 2.49 MB of the 4.00 MB, so every code change was measured
against what was left.

### What the tiers are, and what decided them

Measured, not assumed — `client/public` is 4.93 MB across 163 files, and the split follows what
each screen actually draws:

| pack | contents | files | bytes | when |
| --- | --- | --- | --- | --- |
| `main` | `js/game.js` | 1 | 995 kB | the first download |
| `lobby` | `/ui/` | 17 | 387 kB | awaited at boot, behind a progress screen |
| `music` | `/audio/music/` | 2 | 1,115 kB | background, never awaited |
| `forge` | `/weapons/` | 27 | 443 kB | background, awaited at the run boundary |
| `run` | everything unmatched — rigs, fire/neutral biome, environment, SFX | 102 | 2,335 kB | background, awaited at the run boundary |
| `biome-ice` / `-lightning` / `-poison` / `boss` | unchanged | 14 | 654 kB | background, awaited at the run boundary |

First download **3.42 MB → 0.95 MB**, and the headroom that matters became 3.05 MB of room for
code. Total is unchanged at 5.72 MB / 30 MB: this moves bytes in TIME. The full design, including
every argument below, is in [`design/12`](../12-art-animation.md)'s "the first download is code
only".

Three decisions inside that table were not obvious.

**The forge is the gate, not START RUN.** The forge is where a player *chooses* using weapon art,
so weapons have to be dressed before it paints — and by then the background load has had the whole
login/menu/mode-select sequence to finish. Gating at START RUN would have shown a screen full of
grey placeholder cards and then made the wait anyway.

**Music is fetched and never awaited.** It is 1.09 MB and the one asset class a game can start
without, but it could not simply be backgrounded: a deck handed a path inside an unfetched
subpackage plays nothing, and `musicDirector`'s per-frame derivation is a no-op once `current`
already names the track it asked for. So the pack's completion calls the new
`MusicPlayer.invalidate()` — one hook, at one place, that decides nothing and only forgets a failed
answer. Without it the menu bed would have been silent for the session, which is precisely the
class of regression the previous day's runtime pass existed to close.

**The unreachable-today packs are awaited anyway.** `biome-ice` and friends are 654 kB of art no
authored content can reach, and gating them at their own point of use would mean re-running
`preloadBiomeTiles` once per pack and reasoning about a half-filled texture map. One transition
instead — because the rule this whole pass rests on is that **the set of available textures changes
only at a phase boundary**, never mid-room. `RoomBuilder` builds each room's sprites once, so a
texture that lands afterwards does not fix the sprite built without it; that is the "correct size,
correct blend mode, default (0,0) position, green tests, live report" failure shape this codebase
has the worst record with.

### `mainPack` and `defaultPack` had to stop being one field

`assetPacks.json` used one field for two ideas: the package whose root is `''` (WeChat's first
download) and the destination for a path no rule matches. They were both `main` and the distinction
had never come up. Now `mainPack: "main"` and `defaultPack: "run"`, and the flip IS the safety
property: **a new asset added with no rule can no longer silently enlarge the first download.** A
rule is required to opt INTO `main`, and `assetManifest.test.ts` now sweeps the real `client/public`
tree asserting no shipped file lands there — over the tree rather than over the loader tables,
because the file that would land in `main` by accident is exactly the file nobody remembered to add
to a table.

Each pack also declares a `phase` (`main` | `lobby` | `background` | `run`), so `preloadArt.ts`
asks `packsForPhase()` instead of naming packs and the boot sequence cannot drift from the table.

### Three things found while building it, none of them in the plan

**1. The gate has to be armed before `Game` is constructed.** `isRunArtReady()` answers `true`
until `beginDeferredArt()` has been called — deliberately, because that is what keeps the gate out
of every unit test and every caller that never deferred. The first wiring put the kick after
`game.start()`, which reads naturally ("start the download while the player reads the menu") and is
wrong: `start()` enters a run on its own first pass when `?replay=` is set, so that run would have
begun with placeholder art and no gate. Now pinned by reading both entry files' source, the same
technique `audio/musicPipeline.test.ts` uses to check `GameLoop` calls the director.

**2. The progress bar could not have moved.** `ensureRunArt(onProgress)` memoised the promise, and
the background kick creates that promise with no listener at all — so the gate's callback, arriving
later, was dropped on the floor. A single stored callback cannot work here; progress is now a
broadcast, and a listener registering mid-download is immediately replayed the current count so a
gate that opens at 12 of 16 draws its bar at 12 instead of starting at zero and jumping. Found by
the test asserting the tick sequence, not by looking at a bar.

**3. The build kept a full stale copy of the old main package.** `wechatAssetSync.mjs` prunes
`platforms/wechat` to match the plan, and derived the directories to sweep FROM the plan. That
works for a renamed texture and fails for exactly this change: once no `dest` begins with `ui/` or
`skins/`, the sweep never visits them, and the previous build's copy stays on disk — inside the
first download, invisible to the byte gate, which weighs `client/public` through the rules and
never looks at the built tree. The sweep is now derived by exclusion (everything except the bundle
and the appid config), empty top-level directories are removed so `ui/` does not sit hollow beside
`packs/lobby/ui/`, and `build/wechatAssetSync.test.mjs` is new. Its own first run then found that
the rewritten sweep threw ENOENT on a fresh checkout, where this build is the one that creates the
directory.

### What was verified, and how

- **The real WeChat-shaped runtime**, `render/wechatPhasedBoot.test.ts` (14 tests): phase one
  fetches `lobby` and nothing else, every UI texture resolves, every rig/weapon/biome/environment
  texture is *genuinely absent* — not merely unused, because the fake enforces WeChat's own rule
  that a file inside an unfetched subpackage names nothing — and the run phase then fills every one
  of them in. That last assertion is the property the whole design rests on: a loader re-run after
  its pack lands works. The harness carries its own check that phase one requested only
  `packs/lobby/` paths, so "absent" cannot pass for the wrong reason. The runtime fake moved out of
  `wechatAssetLoad.test.ts` into `render/wechatRuntimeFake.ts` so both files drive it.
- **The gate**, `controllers/ArtGate.test.ts` (7 tests) against the real `preloadArt` module state
  and a host whose downloads never settle until released: inert with nothing deferred, one screen
  and one retry per wait, a repeat swallowed while the wait is up (the scrim stops taps, not the
  keyboard, and `Game.confirm()` is reachable in the phase the player is still standing in), no
  ticker callback left behind, and the gate opening anyway when every download fails — a spinner
  that never comes down is the worst possible reading of "gameplay is never blocked on art".
- **The progress screen**, `ui/loadingScreen.test.ts` (10 tests): the spin advances on wall-clock
  time rather than frame count, the bar draws nothing until a total is known, the scrim is
  interactive at every viewport, and a resize mid-wait re-lays-out.
- **Live, in the browser**: the lobby paints fully dressed with zero console errors, the forge shows
  every weapon card, a real run renders the fire biome / rig / enemies / props, and the progress
  screen — constructed on `Layers.overlay` through the real renderer at 1280x720 — covers a live
  run and animates. That last check needed a screenshot to force frames: the in-app browser pane
  starves `requestAnimationFrame` when it is not compositing, and `ticker.lastTime` was 83 seconds
  stale while `FPS` still read 56. The game itself was frozen too, which is what said the spinner
  was fine and the harness was not.

### Answered the same morning in the real simulator (2026-09-01)

This entry shipped with four open questions and closed all four within the hour. Three of them — the
ones a wx-shaped fake could not reach — were measured against **base library 3.17.1** (DevTools
2.01.2510280, appid `wx25a3b18a3e83ffce`) through a temporary in-bundle probe on the
USER_DATA_PATH breadcrumb channel; the full account is in `design/04-wechat.md`, **The phased boot
on the real base library** and checklist item 17. The fourth, the curtain re-encode, was settled by
looking at it rather than measured — see below, and the entry after this one.

- **The phased boot works, including packs that land mid-render.** 17/17 `UI_ASSET_KEYS` resolve
  through `getUiTexture` after the lobby await; 7/7 `CHAR_BUNDLES` reach `getRigSkin` after the
  run phase, with all five biome floors, both sampled weapons and both sampled environment
  sprites defined. The feared shape — `wx.loadSubpackage` resolving while a `/ui/` path still
  names nothing — did not reproduce, and neither did its twin: the `run` packs settled ~850 ms
  *after* `game.start()`, so their loaders ran against a live render loop and still filled every
  map. `isRunArtReady()` was false for the first 1.4–1.7 s and then flipped, which is the first
  direct evidence the gate arms on this platform at all.
- **Seven concurrent `wx.loadSubpackage` calls all succeed.** The in-flight count climbed 1 to 7
  (the calls issued within 6 ms of each other) and every one reported `success` 885–951 ms later,
  with every texture out of them resolving. `ensurePacks` is not being serialised. Still
  undocumented by subpackage — a measurement is not a guarantee.
- **The background download does not hitch the lobby.** Over an 8 s window from the first menu
  frame, with instrumentation matched between arms, the two deferring runs delivered *more* frames
  than the two controls (324/313 vs 298/304) at a lower mean (24.4/24.8 ms vs 26.9/26.5) and a
  much lower median (19.9/19.8 vs 30.2/29.8), p95 identical at ~31.8 ms. Their only excess is two
  extra frames over 33 ms per window, all inside the first 1.7 s, where both controls carry long
  frames too. Nothing to serialise, nothing to de-prioritise.
- **Per-byte progress stays off, and that is now a decision.** `LoadSubpackageTask` and
  `onProgressUpdate` are typed in `platform/wechat/wx.d.ts` as of this pass, because the API is
  real — the return value is an object, registration does not throw, the handler fires. Its
  numbers are not: exactly one event per pack, always `progress: 50`, with
  `totalBytesExpectedToWrite` between 3,750 and 3,833 for payloads spanning 118 kB (`boss`) to
  2.39 MB (`run`), whose stubs are 403 bytes. A bar fed that fills to half of 3.7 kB and stops, so
  `packLoader.ts` keeps counting units and `wechatRuntimeFake.ts` now reproduces the useless event
  rather than an idealised one.

**Three measurement traps, worth more than the results.** (a) A first clean-looking reading said
`beginDeferredArt()` blocked the main thread for 199 ms; removing the probe's own seven report
writes from inside the timed span took it to **6 ms**. `writeFileSync` costs ~28 ms a call on this
runtime, so a breadcrumb probe that flushes inside what it is timing fabricates exactly the hitch
it went looking for — write breadcrumbs *around* a measured span. (b) The before/after readability
control is **void in the simulator**: reading a pack's file before its `loadSubpackage` was
supposed to throw and returned full bytes for all eight, because the whole project directory is
served off disk. Nothing here — including 2026-08-25's claim that `wx.loadSubpackage` "works for
real" — separates "the load made these files reachable" from "they were never unreachable". (c)
The first control run carried instrumentation the treatment runs did not (~1 MB of synchronous
reads inside the measured window), which made it incomparable and briefly pointed the wrong way;
both arms were re-run with identical probe builds before the table was believed.

### Shipped open, settled the same day

Nothing from this entry is still open. The three device questions are above; the fourth is here,
kept struck-through rather than deleted because the reasoning that framed it is what made the
answer a taste call instead of an arithmetic one.

- ~~**The curtain re-encode is now a plain question with no gate behind it.**~~ **Settled the same
  day, in the negative — the file stays at 468x832.** It was put to the owner as a render comparison
  rather than argued from bytes, because the only lever is pixel count and every setting of it
  magnifies an additively blended gradient that already sits at ~1:1 with its on-screen density. See
  [The curtain re-encode, settled by looking at it](#the-curtain-re-encode-settled-by-looking-at-it-2026-09-01-docs-only)
  below.

## The curtain re-encode, settled by looking at it (2026-09-01, docs only)

The question the entry above left open, asked and answered the same day. **`door_curtain_raw.png`
stays at 468x832 / 606,730 bytes.** No code, no asset and no test changed; what changed is that the
question is closed and written down, in `design/12-art-animation.md` under "the curtain re-encode,
settled".

The reason it needed an owner rather than a number is that **the only lever was pixel count and
every setting of it is an upscale.** A lossless re-encode with this repo's own codec returns a
byte-identical file — `pngCodec.mjs` is what produced the shipped one — and the alpha bounding box
is the full canvas (14.9% of pixels fully transparent, *none* fully opaque, mean alpha 122), so
`trimAlphaBoundingBox` reclaims nothing and `--no-trim` is belt-and-braces here rather than
load-bearing. Downsampling gives 250 kB at long-axis 512, 174 kB at 416, 110 kB at 320 — but the
curtain is drawn 549x788 DEVICE px on a perimeter door (64 world px, room zoom 4.29, renderer
resolution 2) against a 468x672 source band, so it already sits at roughly 1:1 and everything below
832 magnifies an additively blended translucent gradient.

**The comparison was built in the real renderer, which is the part worth reusing.** Variants into a
scratch directory, then swapped into the LIVE scene through the real `doorLeaf.fitArtToOpening` —
reachable in the page because the Vite dev server serves the actual source modules, so the fit rule
under test is the shipped one and not a re-derivation of it — and each frame pulled with
`renderer.extract.canvas` at 1:1 device pixels. Same door, same camera, same additive blend; the
drawn rect is identical geometry in all four panels and only the source file differs. Both shipped
door shapes were covered. One trap cost five calls: `layers.lit` carries a `filterArea` set from
the previous camera frame, so moving the world transform by hand without running the loop clips the
entire world out of the extract and returns a confidently blank frame with every container still
reporting `visible: true`.

Then measured, because looking is not the end of the ladder. Over the curtain's own 549x788 rect,
with `detail RMS` the Laplacian energy:

| | source | file | detail RMS | vs A | mean abs diff vs A | mean luma |
| --- | --- | --- | --- | --- | --- | --- |
| A | 468x832 | 592 kB | 15.71 | 100% | — | 105.23 |
| B | 288x512 | 250 kB | 12.39 | 79% | 2.29 | 105.48 |
| C | 234x416 | 174 kB | 11.46 | 73% | 1.78 | 105.51 |
| D | 180x320 | 110 kB | 10.80 | 69% | 2.66 | 105.62 |

Three things fell out of it that outlive the decision:

- **Mean luma is flat across every variant** (105.23 → 105.62). Downsampling costs this asset no
  brightness at all — the "you can pass here" cue itself is untouched, and only the fine filament
  and sparkle structure degrades. The 592 kB buys *texture*, not signal, which is exactly why it was
  a taste call and not an arithmetic one.
- **416 is an exact 2:1 halving of the master** (832→416, 468→234), so `boxDownsample` averages on
  whole pixel boundaries; it lands *closer* to the original per-pixel (1.78) than the larger 512
  variant (2.29) at 30% fewer bytes. 512 (1.625x) and 320 (2.6x) phase-shift the filaments.
  `--long-axis` is therefore not a monotonic quality dial: when a downsample has to look right,
  prefer 1/2 or 1/4 of the master over a rounder number.
- **The kerb door does not discriminate, despite looking like the harder test.** It is the bigger
  upscale (128 world px = 1098 device px from the same 468-wide source, 2.35x), yet all four
  variants land within 3% of the original, because `doorLeafFrame` crops it to the curtain's
  blown-out bottom bloom, which has half the detail energy to lose. Picking the wrong case would
  have produced four indistinguishable frames and a false "it makes no difference".

Checks re-run against the unchanged asset: `client` typecheck clean, `check:filelength` clean, the
five door/curtain/asset test files green (86 tests), WeChat package budget OK — the curtain is now
the second-largest file in the game behind `boss.mp3` (603 kB), inside `run` at 2.28 MB / 4.00 MB.
`wechatAssetLoad.test.ts` was verified rather than assumed to follow a re-encode: it reads IHDR
straight from the file buffer with no literals, so `doorCurtainCoverage.test.ts`'s `CURTAIN_ART_W`/
`CURTAIN_ART_H` are the only place carrying 468/832.

**What would reopen it**: byte pressure returning to the `run` pack, or a second illustrated overlay
of this class landing — one 606 kB additive sheet is a fixture, four are a policy. The 3.9 MB master
under `art/environment/` stays either way, so the downsample remains one `compress.mjs` invocation
plus one test constant if that day comes.

## Two days of features, audited for what the tests did not say (2026-09-01, engine + client + build, ENGINE_VERSION 50→51)

Asked to look over the features from 2026-08-31/09-01 for missing tests. Four parallel audits over
the music runtime, the phased asset boot, replay recording, and the v50 radius work. The suite was
green throughout — 344 files, ~5,650 tests — so everything below was found by asking *"would this
test fail if the behaviour were broken"* rather than by anything being red.

Two of the findings were not test gaps.

### The build crash: a stray file in `platforms/wechat` (build)

`syncAssets`'s prune derives `ownedTopLevel` by EXCLUSION from a `readdir` — deliberately, since a
plan-derived set cannot clean up a directory the plan used to own, which is exactly what the
2026-09-01 asset move created. But exclusion also admits plain FILES, and each entry went straight
to `walk()`, which readdirs whatever it is handed: `ENOTDIR: not a directory, scandir
'platforms/wechat/stray-note.txt'`, out of `npm run build:wechat`. `platforms/` is git-ignored
scratch that DevTools and a developer both write into, so it is reachable without contrivance;
every existing prune test seeded only directories, so nothing looked. Fixed by pruning a
non-directory top-level entry (unreserved and unplanned makes it stale by the same rule as a stale
texture), and pinned from both sides — the stray file goes, and the reserved `game.js`, also a
file, stays. The second case matters more than it looks: deleting the bundle entry every build is
the failure mode a naive widening of that sweep reaches for.

### v51: a locking door sealed the loot it closed over (engine)

The mechanism v50 left open, and the one it could not have found. `DoorSystem.rebuildWalls` is the
only thing in this engine that changes the wall set mid-run; an item already lying in a passage was
then inside stone, with nothing re-clamping it — nothing touches a pickup after its drop tick, and
`PickupSystem` collects on a radius test that never consults walls.

v50 made every drop SITE legal and `smoke.test.ts` asserts that per tick. Both statements are about
the moment of the drop. This happens strictly afterwards, which is why the 903-drop sweep behind
v50 could not see it: the sweep sampled drop sites. A doorway is not an exotic place for a drop to
be — it is where fights happen, and a mob dying on a threshold or a weapon swapped in one, followed
by the room activating, is an ordinary sequence. **This is a plausible mechanism for
*"there are still drops that cannot be picked up"*, which v50 closed as unexplained.**

Fixed with a re-clamp pass at `dropClearance()` over every alive pickup, after
`rebuildSpatialIndex()`. Unconditional rather than "only the ones in a passage", because the
predicate for "is this one affected" is the same solid query `clampToWalkable` already performs and
it is exactly a no-op on a clear point; idempotent, so a repeated rebuild cannot walk an item
across the floor; and it runs only on the rare tick a lock changed.

Written as a failing test first. Three cases in `systems/doors.test.ts`: the sealed item is
re-seated, an item across the room does not move by a single fp (so the fix cannot be "re-clamp
everything and let the arithmetic land where it lands"), and the re-seated item is not parked on the
far side of the closed door — which would be worse than the bug, sealing the player in with the
fight and the loot outside.

**A gotcha worth writing down, because it inverts what the gate appears to say.** `goldenHash`
passed *with the fix applied and before the bump* — that, and only that, is the evidence the change
does not move the shipped scenarios. After the bump every scenario's hash changes, dungeon or not,
because `serializeState` hashes `version` itself. So the order matters: run the hash gate BEFORE
bumping, or it tells you nothing.

### The test backlog

~30 gaps closed across 21 files (+1,592 lines), each verified by applying the named mutation,
watching the test go red, and reverting. Highlights, all of which survived the full suite before:

- **`Game.beginReplayRun` had zero coverage** — the function that shipped broken (`this.engine`
  never assigned), caught at the time only by live verification. Re-applying that exact mutation now
  fails 4 tests.
- **`invalidateMusic` was untested on both backends.** An empty body survived everywhere: every
  `invalidateMusic` under test was a hand-written fake, so nothing joined "the phased boot calls it"
  to "a deck actually re-points". The same shape as the bug that made every music piece pass its own
  check while the game stayed silent.
- **`void ensureRunArt()` in `beginDeferredArt` was pinned by nothing** — deleting it reverts the
  asset-phase feature's central claim (no background download; the full ~4.7 MB wait returns to the
  forge) and stayed green, because every test created the promise itself.
- **The bundle's pack attribution was never exercised** — no test ever wrote a `game.js`, so
  reverting to `defaultPack` survived while making the byte gate report the main package as 0 bytes.
  That gate exists for that number.
- **`updateWeaponPickupPrompt`'s radius** — `nearbyWeaponPickups`'s only production call site, with
  nothing asserting what it passes. Moving the constant out of `HudView` removed the duplicate
  definition and left the USE unpinned; the surviving mutant silences the panel at exactly the
  distances cannot be picked up was reported at.
- Two of the three `dropClearance()` sites had no behavioural test; `formatInspectReport` — the
  harness that gets pointed at a real bug report once and has to be right — had none at all.

Three results worth more than the tests:

1. **Two existing tests claimed more than they pinned.** `assetManifest.test.ts` hand-copied the
   build's `packOf` instead of importing it — and importing it was *not enough*, because no shipped
   path matches two rules, so "first matching prefix wins" was unfalsifiable in both directions
   until an adversarial fixture table was added. `wechatPhasedBoot.test.ts` said "no download and no
   loader" while only counting pack loads.
2. **`client/sim/dropReachability.sim.ts`** turns v50's ad-hoc 903-drop sweep — which was never
   committed — into a re-runnable gate: 16 runs, 796 drops, 142 wall-set changes under live loot,
   10,477 checks, ~6 s (`npm run test:drop-sim`, folded into `test:sims`). **It does not
   discriminate either fix on shipped content, and says so in its own header**: reverting v50's
   clamp gives byte-identical positions for all 796 drops, because every room is authored on a
   1000 fp lattice and that is exactly two player radii; and no door in those 16 runs ever closed
   over a drop. It is a CONTENT gate, like `smoke.test.ts` — its value is the next tighter room
   piece or wider body. An oversized-probe assertion is retained permanently to prove it can fail.
   Incidental measurement: real drops rest *touching* stone, worst reach 1 fp — the truncation
   residue, no slack.
3. **Two guards could not be pinned and were left uncovered rather than faked.** `preloadArt`'s
   listener-leak guards have no consequence observable from outside the module (`runArt` is memoised
   after resolve, so a retained listener can never fire again), and pinning them would mean adding
   an inspection seam to production code for a guard that is currently inert. The limitation is
   written into the neighbouring test's comment so the next reader does not mistake it for coverage.

**One process finding.** A `ReferenceError: SIM is not defined` inside `DeathDropsSystem.tick`
looked like a module-graph flake and was not: `SIM` does not appear in that file at all, so the only
way to throw it there is to be running while another concurrent mutation check has temporarily
rewritten the file to use `SIM.pickupRadius` without an import. Two parallel agents mutation-testing
in one shared working tree see each other's mutations. Mutation batteries need their own worktree.

