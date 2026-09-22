// What a frame is allowed to COST when the player is not playing (2026-09-08, live report
// *"游戏现在运行在手机和ipad上时耗电量非常高"* — battery drain on a phone and an iPad).
//
// Two facts, both measured, both a function of `phase` alone:
//
// 1. **Outside `'playing'` nothing in `layers.world` is visible, and all of it was still
//    being drawn.** Every menu-shaped screen (main menu, mode select, forge, squad lobby,
//    PvP preview, matchmaking, settings) *and* the pause menu *and* both result screens are
//    backed by the same opaque full-viewport panel art, so the "freeze the last frame behind
//    the menu" that `GameLoop.update`'s own comment describes has never been visible to a
//    player. Nothing unmounts the room when a run ends either — `RunLifecycle.
//    resetRenderState` runs when the NEXT run starts — so a player sitting in the forge
//    after a run paid for a complete in-run frame: 29 ground pieces, 64 live entity views,
//    four full-viewport filter passes, at the display's refresh rate, indefinitely.
//
//    Measured with `?perf=1` at a phone-landscape 844x390 viewport, each phase reached
//    through its real flow (`window.__perf.attribute({})` for the counts, `probe({change})`
//    for the pixels):
//
//    | phase   | frame       | hiding `world` moves | with `ui` hidden |
//    |---------|-------------|----------------------|------------------|
//    | playing | 39 draws/18 | 92.0% of pixels      | 99.1%            |
//    | paused  | 39 draws/18 | **0 px** of 329,160  | 99.1%            |
//    | forge   | 42 draws/18 | **0 px**             | 99.1%            |
//
//    The third column is the load-bearing control: `perf/frameProbe.ts`'s default liveness
//    check blanks the whole stage, so it fires whether or not the subtree under test is on
//    screen (its own header names that trap). Hiding `layers.ui` instead moves 99.1% in all
//    three phases, which is what separates "the world is drawn and covered" from "the world
//    was not drawn at all" — the first is the one that costs battery. Switching the world
//    off takes the pause frame from 40 draws / 18 programs / 128 texture binds to 5 / 0 / 38.
//
// 2. **The ticker had no cap at all** (`maxFPS === 0`), so the render rate was whatever the
//    display ran at. The sim is 30 Hz (design/06), so a 120 Hz ProMotion iPad was drawing
//    four frames per sim tick and spending twice the power of the 60 Hz phone next to it on
//    interpolation nobody asked for. 60 is two render frames per sim tick, which is what
//    every frame-time number in design/01 was measured at, and the player can ask for 30 —
//    one render frame per tick, the cheapest rate that still shows every tick.
//
// 3. **A cap is not a number Pixi honours — it is a gate that drops frames** (2026-09-22,
//    live report: *"玩20分钟左右就头晕"* — dizziness after ~20 minutes on a desktop at
//    1920x1080 @ 60 Hz). `Ticker.update` truncates the elapsed time to whole milliseconds
//    before comparing it (`const delta = currentTime - this._lastFrame | 0`), and a 60 Hz
//    vsync interval is 16.67 ms, which truncates to 16 and loses to a `_minElapsedMS` of
//    16.667. With perfectly spaced timestamps the phase it carries forward hides that —
//    which is exactly what `powerBudget.test.ts` was driving, and why it reported the cap
//    healthy. Real vsync timestamps are not perfectly spaced, and at ±0.2 ms of jitter the
//    same gate drops **103 frames per minute — a doubled frame ~1.7 times a second,
//    indefinitely**. A steady 58 fps is not what that looks like to a player; a frame that
//    is twice as long as its neighbours 1.7 times a second is judder, and judder is what
//    makes people ill. See `tickerCapFor` for what replaced it.
//
// **Why this is not the render-quality lever** (`render/quality.ts`): that tier is picked by
// a FRAMERATE watchdog, and none of the above shows up as a slow frame. A device that holds
// 60 fps while drawing an invisible dungeon at 120 Hz never trips the watchdog and never
// will — it is not struggling, it is wasting. Power is a separate axis from framerate and
// needs its own policy, which is this file. The two compose: a tier decides what a drawn
// frame contains, this decides whether the frame is drawn at all and how often.
//
// Presentation-only, like every other render decision (design/12's "art never decides an
// outcome"): the sim runs off `GameLoop`'s own fixed 30 Hz accumulator, not off the render
// rate, so two clients with different caps stay byte-identical (design/06).
import type { Phase } from './phase';

/** What the player may pick for the in-run render rate, and what each one means.
 *
 *  60 is two render frames per 30 Hz sim tick — the rate every frame-time number in design/01
 *  was measured at, and what the interpolation in `Scene.interpolate` exists to smooth.
 *  30 is ONE render frame per sim tick: the cheapest rate that still shows every tick, so it
 *  halves the in-run frame cost without the sim and the screen drifting out of phase. Below
 *  that a player would start missing ticks entirely, which is a different (and worse) thing
 *  than a lower frame rate.
 *
 *  Not an `'auto'`: the render-quality tier already has a watchdog, and a SECOND thing silently
 *  changing how the game feels off the same fps stream is how two policies end up fighting over
 *  one measurement. This one is the player's. */
export type FrameRateSetting = 60 | 30;

/** Declared order for the settings screen's tap-to-cycle button. */
export const FRAME_RATE_SETTINGS: readonly FrameRateSetting[] = [60, 30];

/** The default, and the ceiling: `PLAY_MAX_FPS` is what an unconfigured host runs at. */
export const PLAY_MAX_FPS: FrameRateSetting = 60;

/** ...and while it is not. A menu is a static panel with button states on it; 30 fps is a
 *  visually identical menu at half the frames, and the idle screens are where a game that
 *  someone left open spends its hours.
 *
 *  It has a FLOOR, and it is not taste: `PerfMonitor` keeps sampling on a menu and
 *  `QualityWatchdog` latches a permanent low tier after three consecutive windows under 25 fps
 *  (`render/qualityWatchdog.ts`). An idle cap below that would downgrade the renderer for
 *  anyone who paused for six seconds, with the settings screen still reading `auto` and
 *  nothing having actually been slow. `powerBudget.test.ts` asserts the clearance against the
 *  real watchdog rather than against the number. */
export const IDLE_MAX_FPS = 30;

// ---- the cap, as Pixi actually applies it ----
//
// Everything above is a TARGET: "this phase is worth this many frames a second". What
// `Ticker` takes is not a target, it is `_minElapsedMS = 1000 / maxFPS`, checked against an
// elapsed time truncated to whole milliseconds and carried forward through
// `_lastFrame = currentTime - delta % _minElapsedMS`. Two properties of that gate decide
// everything in this section, and neither is documented by Pixi:
//
//   - **the truncation costs up to a full millisecond**, so a `_minElapsedMS` equal to the
//     display's own interval loses the comparison on most frames; and
//   - **a fractional `_minElapsedMS` makes the carried-forward phase drift**, because
//     `delta` is an integer and the remainder is not, so the residual grows a little on
//     every pass until it crosses an interval and a frame is dropped. That is the beat the
//     header's third point measures.
//
// Both are avoided by choosing a WHOLE number of milliseconds strictly below the interval
// we want between frames. `1000 / floor(1000 / fps)` is that number: at 60 fps it is
// 1000/16, i.e. a `_minElapsedMS` of exactly 16 against a 16.67 ms display interval — under
// it by enough to survive the truncation, integral so the phase cannot drift.
//
// Measured against the real `Ticker` in `powerBudget.test.ts` ("frame cadence", ±0.2 ms of
// jitter, one minute of frames), uneven frames as a percentage of frames drawn:
//
//   | display | target | shipped 2026-09-08 | this rule       |
//   |---------|--------|--------------------|-----------------|
//   | 60 Hz   | 60     | 58.3 fps / 2.9%    | 60 fps / 0%     |
//   | 120 Hz  | 60     | 58.3 fps / 5.7%    | 60 fps / 0.2%   |
//   | 144 Hz  | 60     | 58.8 fps / 44.7%   | 73.5 fps / 4%   |
//   | 60 Hz   | 30     | 29.6 fps / 3%      | 30 fps / 0.2%   |
//
// The residue on 90/100/165 Hz panels (5-9%) is the one thing this cannot fix: their vsync
// interval is not a whole number of milliseconds either, so no integer `_minElapsedMS`
// divides it evenly. Fixing THOSE means not using Pixi's gate at all — taking
// `app.render` off the ticker and calling it on our own schedule — which is a much larger
// change than the one the report asked for, and is recorded in design/01 as the follow-up
// rather than attempted here.

/**
 * The measured refresh rate of the display the game is on, or `null` while nothing has
 * measured it (`perf/displayRate.ts` does, once, a second after boot).
 *
 * A module mirror for the same reason `playCap` below is one: it is process-wide by
 * definition and read on a path that runs every frame.
 */
let displayHz: number | null = null;

/** The display probe has an answer (or has given up, with `null`). */
export function setDisplayHz(hz: number | null): void {
  displayHz = hz !== null && Number.isFinite(hz) && hz > 0 ? hz : null;
}

/** What the probe last reported. `null` means "not measured", never "unknown, assume 60". */
export function activeDisplayHz(): number | null {
  return displayHz;
}

/** Test helper — one case's measurement must not leak into the next. */
export function resetDisplayHz(): void {
  displayHz = null;
}

/** How far below the chosen whole millisecond the cap aims, to survive `Ticker.maxFPS`'s
 *  own float round trip. See the comment at the point of use. */
export const GATE_EPSILON_MS = 0.001;

/**
 * Translate a target frame rate into the `Ticker.maxFPS` that delivers it *evenly* on this
 * display. The three cases, in the order they are checked:
 *
 * 1. **The display is already at or below the target ⇒ no cap at all (`0`).** This is the
 *    case the report came from: a 60 Hz panel asked for 60 fps cannot be helped by a gate,
 *    only harmed by one, because every frame it drops is a frame the display was going to
 *    show. The 1.02 slack is because a "60 Hz" panel is rarely exactly 60.000 — 59.94 and
 *    60.02 are both ordinary — and a rule that capped the second and not the first would be
 *    decided by the third decimal place of a measurement.
 * 2. **The display rate is unknown ⇒ cap at the target's own whole millisecond.** Better
 *    than not capping (the 120 Hz waste this file exists to stop is real) and better than
 *    the raw target (which is the bug).
 * 3. **The display is faster ⇒ snap the target to a whole division of it first.** A 144 Hz
 *    panel asked for 60 gets 72 rather than 60: the nearest rate that is one frame per N
 *    vsyncs, which is the only kind of rate a vsynced display can deliver evenly at all.
 *    Asking for 60 there means 2.4 vsyncs per frame, and 2.4 is drawn as an endless
 *    2,2,3,2,2,3 — the 44.7% in the table above.
 *
 * Pure, and the reason it is exported separately from {@link applyPowerBudget}: every number
 * in that table is a property of this function alone, so the test drives it directly.
 */
export function tickerCapFor(targetFps: number, hz: number | null): number {
  if (hz !== null && hz <= targetFps * 1.02) return 0;
  const even = hz === null ? targetFps : hz / Math.max(1, Math.round(hz / targetFps));
  // `ceil(interval) - 1`, and the `- 1` is load-bearing rather than defensive: `floor` lands
  // ON the interval whenever the interval is already a whole millisecond (a 100 Hz panel
  // asked for 60 resolves to 50 fps, i.e. exactly 20 ms), and `delta` truncating to 19
  // against a `_minElapsedMS` of 20 is the shipped bug in miniature. Strictly below, always.
  const minMs = Math.max(1, Math.ceil(1000 / even) - 1);
  // ...and then a hair below THAT, because the value does not survive the round trip.
  // `Ticker` stores `1 / (fps / 1000)`, so asking for `1000 / 33` comes back as
  // 33.000000000000004 — a `_minElapsedMS` fractionally ABOVE the integer we picked, which
  // an integer `delta` of exactly 33 then loses to. Measured before this line existed: a
  // 30 fps idle cap on a 60 Hz panel read 2.7% uneven instead of 0.1%, entirely from the
  // last bit of a double. `EPSILON` is far too small to survive the same round trip; a
  // thousandth of a millisecond is below anything the gate can resolve and is not.
  return 1000 / (minMs - GATE_EPSILON_MS);
}

/** The one display bit this needs — narrowed per CLAUDE.md rather than taking `Layers` or a
 *  whole `Container`. `renderable`, not `visible`: it is the bit that means "do not draw
 *  this", it leaves `visible`, bounds and hit-testing untouched, and it emits no
 *  `visibleChanged` event. Pixi ANDs it down the entire subtree
 *  (`updateRenderGroupTransforms`: `globalDisplayStatus = local & parent.global`), so one
 *  write covers everything under `world`. */
export interface WorldLayerLike {
  renderable: boolean;
}

/** The one ticker knob (Pixi's `Ticker`, structurally). */
export interface FrameRateLike {
  maxFPS: number;
}

/** Is anything in `layers.world` visible in this phase? Exactly one phase draws the world;
 *  the table in the header is the evidence that every other one covers it completely. */
export function worldDrawnInPhase(phase: Phase): boolean {
  return phase === 'playing';
}

// ---- live mirror ----
//
// Same shape and same reason as `render/quality.ts`'s `activeQuality()` and i18n's `t()`
// (design/17): the persisted copy lives in `SettingsState`, `SettingsBinding` pushes every
// change here, and the per-frame reader takes it off the module. The alternative — threading
// the setting from `Game` through `GameLoop` into the budget — would put a settings parameter
// into a call that runs 60 times a second, for a value that is process-wide by definition.
let playCap: FrameRateSetting = PLAY_MAX_FPS;

/** The player picked an in-run frame rate (`SettingsBinding`, at boot and on every change). */
export function setPlayFrameCap(fps: FrameRateSetting): void {
  playCap = fps;
}

/** What a run is currently capped at. */
export function activePlayFrameCap(): FrameRateSetting {
  return playCap;
}

/** Test helper — restores the boot default so one test's pick cannot leak into the next. */
export function resetPlayFrameCap(): void {
  playCap = PLAY_MAX_FPS;
}

/** The render-rate cap for a phase. Idle screens are capped at `IDLE_MAX_FPS` or at the
 *  player's own in-run pick, whichever is LOWER: someone who asked for 30 in a fight has not
 *  asked for 30 in a menu, and a menu must never cost more frames than the game does. */
export function maxFpsForPhase(phase: Phase): number {
  return worldDrawnInPhase(phase) ? playCap : Math.min(IDLE_MAX_FPS, playCap);
}

/**
 * Apply both knobs, and hand back whether the world is being drawn.
 *
 * Called every frame on purpose: Pixi's `renderable` setter early-returns when the bit is
 * already right (`Container.js`: `if ((this.localDisplayStatus & 1) === valueNumber) return`),
 * so only an actual phase change costs anything, and nothing has to be wired into the several
 * places that write `RunState.phase`.
 */
export function applyPowerBudget(phase: Phase, world: WorldLayerLike, ticker: FrameRateLike): boolean {
  const drawn = worldDrawnInPhase(phase);
  world.renderable = drawn;
  // The phase decides the TARGET; `tickerCapFor` decides what to write so that the target
  // arrives as evenly spaced frames rather than as an average. Reading the mirror here, and
  // not at the call site, keeps the display measurement off `GameLoop`'s parameter list for
  // the same reason `playCap` is not on it.
  ticker.maxFPS = tickerCapFor(maxFpsForPhase(phase), displayHz);
  return drawn;
}
