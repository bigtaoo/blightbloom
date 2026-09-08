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
  ticker.maxFPS = maxFpsForPhase(phase);
  return drawn;
}
