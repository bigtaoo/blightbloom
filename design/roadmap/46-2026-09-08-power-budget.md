# 2026-09-08 — the frame nobody sees: a power budget, a middle rung, and a frame rate

Volume 46, a battery pass. One report — *"游戏现在运行在手机和ipad上时耗电量非常高"* — and what it
turned out to name was not a slow frame anywhere: **every instrument this repo has measures
framerate, and nothing measured waste.** A device that comfortably holds 60 fps while drawing an
invisible dungeon at 120 Hz is not struggling, so the auto-quality watchdog never fires and never
will.

See [../ROADMAP.md](../ROADMAP.md) for the index.

---

## The frame nobody sees, and the 120 Hz nobody asked for (2026-09-08, client only, no engine change)

Two wastes, both provable, neither visible to the quality tiers or to the frame sampler.

**Outside `'playing'` nothing in `layers.world` is visible, and all of it was still being drawn.**
Every menu-shaped screen — main menu, mode select, forge, squad lobby, PvP preview, matchmaking,
settings — *and* the pause menu *and* both result screens are backed by the same opaque
full-viewport panel art, so `GameLoop.update`'s own "freeze the last frame, keep fx fading" has
never been visible to a player. And nothing unmounts the room when a run **ends** —
`RunLifecycle.resetRenderState` runs at the start of the NEXT one — so a player sitting in the
forge after a dungeon was paying for a complete in-run frame: 29 ground pieces, 64 live entity
views, four full-viewport filter passes, at the display's refresh rate, for as long as they sat
there. Measured with `?perf=1` at a phone-landscape 844x390 viewport, every phase reached through
its real flow:

| phase | frame | hiding `layers.world` moves | with `layers.ui` hidden |
|---|---|---|---|
| playing | 39 draws / 18 programs | 92.0% of pixels | 99.1% |
| paused | 39 / 18 | **0 px** of 329,160 | 99.1% |
| forge, after a run | 42 / 18 | **0 px** | 99.1% |

**The third column is the finding about the instrument, and it is worth more than the numbers.**
`perf/frameProbe.ts` refuses to report without a liveness control, which is exactly right — but
its DEFAULT control blanks the whole stage, so it fires whenever *anything* is drawn, including a
frame that is entirely opaque menu. Every "hiding the world changes 0 pixels" reading therefore
came back `trustworthy: true` and meant nothing on its own. Hiding `layers.ui` instead moved 99.1%
in all three phases, and that is what separates *drawn and covered* (costs battery) from *not
drawn at all* (costs nothing). The module's own header asks for a narrower control; this is the
case it was written for. A second harness trap alongside it: reaching a phase by calling `nav.*`
from the console produces junk, because screens do not hide each other outside their real flows
(`beginQuickRun` hides only the main menu), so a run started after a console `showForge()` renders
UNDER the forge's art and every probe reads 0. The tell is the control case — hiding the world
while `'playing'` must move ~92%; a 0 there means the sequence is wrong, not that the finding is
real.

**The ticker had no cap at all.** `app.ticker.maxFPS` was `0` on every platform, so the render
rate was whatever the panel ran at: a 120 Hz ProMotion iPad drew FOUR frames per 30 Hz sim tick
and spent twice the power of the 60 Hz phone beside it on interpolation nobody asked for. Before
this pass, `grep maxFPS` over the whole client matched nothing outside `src/perf/`.

Fixed by `game/powerBudget.ts` — 90 lines of policy, a function of `phase` alone, applied from
`GameLoop.update` every frame (Pixi's `renderable` setter early-returns on an unchanged bit, so it
needs no wiring into the several places that write `RunState.phase`). Live, after: the menu frame
is **3 draws / 0 programs** where it was 11/6, pause **4/0** where it was 40/18, the forge after a
run **7/0** where it was 42/18, and resuming returns to 39/18 at 60 fps.

**Two `pixi.js` `Ticker` facts that needed a test rather than a reading.** `maxFPS` is not a number
Pixi stores and honours: it becomes `_minElapsedMS`, and the gate that reads it truncates the
elapsed time to an integer (`currentTime - this._lastFrame | 0`). A cap of 60 on a 60 Hz display
therefore has an obvious way to go wrong — 16 < 16.667 skips the frame — which would have halved
the frame rate of every player on the platform this pass was trying to help. It does not, because
`_lastFrame` carries the remainder forward, but that is a fact about pixi and not about our code:
`powerBudget.test.ts` drives a real `Ticker` with synthetic timestamps and pins 60 Hz staying at
~120 of 120 while 120 Hz falls to 117 of 240. And `set maxFPS` LOWERS `minFPS` when the cap is
below it, where `minFPS` is what clamps `deltaMS` after a stall (100 ms) — so an idle cap under 10
would quietly widen the catch-up clamp for the whole session, run included.

**What the CPU half was, measured, and why it stayed.** With the world switched off the remaining
per-frame work on a menu is `updateFx` + `scene.interpolate` over the 64 still-mounted views —
`update 0.4 ms` against `render 1.2 ms` on the pause screen before the change. At the new 30 fps
idle cap that is ~1% of a core, so skipping it was not worth rewriting the six tests that
deliberately pin "a door keeps breathing on a menu" and "fx keeps fading while paused". Recorded
because the reasoning is the deliverable: the GPU half was 30 of 40 draws, the CPU half is a
rounding error, and only the measurement says which.

`docs`: `01`'s new **power budget** section, `06`'s tick line (it said "render runs at display
rate (60 fps)" and stopped being true on a 120 Hz panel), `04`'s items 3 and 6, the root README.

## A middle rung on the ladder, and a frame rate the player picks (2026-09-08, client + i18n, no engine change)

The two levers the report asked for once the free wins were in, both chosen by the owner.

**`medium` is a rung, not "low with lighting".** It keeps `sceneLight` — the one pass that carries
the game's look — and drops `screenFx`, `bloom` and `actorShaders`, so a frame goes from four
full-viewport render-target passes to one. Measured live in a PvE room (one reading, three
columns, so the columns are comparable and the absolute numbers are not comparable with `01`'s
2026-08-25 table): draws **41 / 34 / 32**, programs **18 / 14 / 12**, and framebuffer binds
**11 / 3 / 1** across high / medium / low. The last line is the one a mobile tiler charges for —
each bind is a tile flush and a reload of the whole viewport — and `medium` buys 8 of the 11 while
a screenshot pair reads as the same game.

Its `resolutionCap` deliberately stays at high's 2, which is the interesting half. Pixi's
`Filter.resolution` defaults to 1 and does **not** follow the renderer's, so everything inside
`layers.lit`/`world`'s filters is *already* rasterized at 1x on every device: lowering the renderer
resolution buys only the final composite and the UNFILTERED layers, and what those hold is the HUD
and the menu text. Blurring the text to save the cheapest pass in the frame is the wrong trade at
this rung. `low` still makes it, because a device on `low` needs every fragment back.

**`resolveTier` became a ladder and `QualityWatchdog` a stepping detector.** `auto` walks
high → medium → low, one rung per streak, and the streak restarts after each step: "high does not
fit" is no evidence about medium, and dropping straight to the cheapest tier on the first slow
stretch would cost every mid-range phone the lighting it could afford. `downgrades: number`
replaces `downgraded: boolean`, bounded by `maxSteps` so a `true` past the bottom rung — which
could only mean "downgrade something already cheapest" — cannot happen. Reaching `low` off the
real sampler now takes ~12 s of slow windows rather than 6, which is how the end-to-end test
noticed the policy had changed rather than the fixture.

**A FRAME RATE setting, 60 or 30.** 30 is one render frame per 30 Hz sim tick — the cheapest rate
that still shows every tick, so it halves what a fight costs without the sim and the screen
drifting out of phase. Deliberately not an `'auto'`: the quality tier already has a watchdog on
that fps stream, and a second policy steering off the same measurement is how two systems end up
fighting over one number. It rides a module mirror (`setPlayFrameCap`/`activePlayFrameCap`, the
same shape as `activeQuality()` and i18n's `t()`) because the reader is the main loop 60 times a
second, and it lands in `SettingsBinding.applyAll` — not next to `quality.apply` in `load()` —
so it applies at boot AND on change AND on the ad-mute re-apply, which is the bug shape that class
was extracted to prevent.

Two constraints the two settings put on each other, both now assertions rather than intentions:
**the idle cap may not drop below the watchdog's floor** (`PerfMonitor` keeps sampling on a menu;
an idle cap under 25 fps would downgrade the renderer for anyone who paused for six seconds, with
the settings screen still reading `auto` and nothing having been slow — measured against the real
sampler, 30 never trips it and 20 does), and **an idle screen may never cost more frames than the
run** (`min(IDLE_MAX_FPS, playCap)`).

`i18n`: three keys × eight locales (`qualityMedium`, `qualityAutoMedium`, `frameRate`), with the
gender agreement the Romance and Slavic locales need on a word describing 画质/QUALITY. Adding a
tier also falsified three source comments that COUNT tiers — `actorFilters.ts`'s "the two tiers
agree on WHEN the actor is gone", `Scene.refreshQuality`'s "where the two tiers differ most" and
an `FxController` test titled "across both tiers" — the cardinality trap this log already records
for docs, met in code comments; `grep "two tiers\|both tiers"` found all three, and the rewrite is
to name the property ("every tier that does not run `actorShaders`") so a fourth rung falsifies
nothing.

## The premises a perf fix rests on, and the test that was vacuous (2026-09-08, client tests only, no code change)

An 18-mutant battery over the new policy, plus the two things it found.

**18 real mutants, 18 killed, both controls survived — after two rounds.** The first round killed
13 of 15 and the two survivors were both about the harness rather than the code. One was a genuine
gap: `maxFpsForPhase` returns `min(IDLE_MAX_FPS, playCap)` so a menu can never cost more frames
than a run, `IDLE_MAX_FPS` is 30 and the lowest OFFERED rate is 30 — so **every assertion written
from a legal value passes whether the `min` is there or not**, and deleting it survived a
5,500-test suite. That is the dominant survivor cause this repo has recorded before, stated
exactly: the fixture made two different things equal. The fix is to drive the module mirror past
its own type (`setPlayFrameCap(15 as FrameRateSetting)`) and say in the test why — the guard exists
for a rate that does not exist yet. Same shape, second instance in the same pass: the end-to-end
test asserted `toBe(Math.min(IDLE_MAX_FPS, 30))`, i.e. re-derived its expected value from the
expression under test. The other survivor was a **no-op mutant** — the edit appended an unused
const instead of changing the value, so its SURVIVED line was a second control and said nothing;
re-run as real edits (`PLAY_MAX_FPS = 30`, `FRAME_RATE_SETTINGS = [60]`) both died instantly.
Check that a survivor is a real edit before believing it.

**Both premises of the fix are now tests, not a browser measurement.**
`game/screens/menuCoversWorld.test.ts` pins that every screen a menu-shaped phase can show mounts
a full-bleed `Sprite` at `alpha === 1` covering the whole viewport from (0,0), behind the scrim —
nothing behind an opaque sprite that covers the viewport can reach the frame, and
`layers.test.ts` already pinned the other half (`ui` paints after `world`). Mocking `getUiTexture`
is what makes the SHIPPED branch reachable: it returns undefined under vitest, and a `Panel` with
no background art is scrim only, i.e. genuinely translucent — the known degraded look, and also
the state in which the world-hiding rule would turn a screen into a hole. Deleting
`background: 'hub'` from `PauseMenu` turns it red. The complementary case in `layers.test.ts`
walks the parent chain: every layer a run draws into is under `world`, and `backdrop`/`ui`/
`hudOverlay`/`menu`/`overlay` are not — `terrain` has already been moved between two parents once,
and a promotion like that would silently take a layer out of the one display bit this fix writes.

**A fits-the-viewport sweep is blind to the bug it was written for**, found by adding the only two
screens `viewportFit.test.ts` had ever been missing — `Matchmaking` and `StoreScreen`, missing for
a mechanical reason rather than a considered one (both do async work in `show()`, so neither fitted
the file's synchronous one-line builder), which left the queue and the store as the only screens
nothing checked against a 390 px-tall phone. Two structural limits fell out. **A bottom-anchored
control always "fits", at every height**: the store's BACK button sits at `h - 56`, so its measured
content ends 24 px above the bottom whatever height you hand it (616 of 640, 536 of 560) — an
overlap is not an overflow, and the store's real failure mode is the flowed part above it growing
DOWN into BACK, which is the Forge's original bug on the screen that takes money. It has its own
probe now, with its own can-this-fail control (220 px under the design height, BACK is covered).
And **±Infinity passes both bounds assertions**: a bounds walker that starts at `minY = Infinity,
maxY = -Infinity` and finds nothing visible returns those, and `Infinity >= -SLACK` and
`-Infinity <= h + SLACK` are both true, so the suite passes hardest exactly when the screen is
emptiest. `contentBounds` now throws instead. That is still a weak net on its own — an unsettled
store draws a title, a status line and BACK, so it reports perfectly finite bounds for a listing
with no items, and "the store fits" would be a claim about an empty store. What works is the
BUILDER asserting its own precondition (a full page of rows plus the pager visible), so every case
inherits it: deleting the settle point then failed 18 cases instead of 1.

Also worth keeping: reach a screen's error state through its real failure path, not by
hand-setting the state flag. `Matchmaking`'s error layout is the wider of its two states and its
message comes from `classifyError` → `t()`, so the string being measured is decided by the path —
the entry hands `show()` a `connect` that rejects and awaits a macrotask. And any geometry probe
over `view.children` must `.slice(1)`: the panel is child 0 and spans the viewport, so leaving it
in reported the design height as broken, every control "overlapping" the background.

Totals for the pass: 32 files, `powerBudget.ts` at 100% lines and branches, client coverage
97.56% → **97.64% lines / 93.05% branches**, `viewportFit.test.ts` 175 → 209 cases, and
`npm run check` / `check:logic` / the coverage gate all green.

**Still open, and stated so the next pass does not re-derive it:** none of this is a battery
measurement. There is no instrument here that reads power draw, so what is proven is that the work
went away — 30 of 40 draws on an idle screen, half the frames on a 120 Hz panel, 8 of 11
framebuffer binds at `medium` — and not how many minutes that buys. The device holding the report
is the only instrument for that.
