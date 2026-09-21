/**
 * The DOM boot splash — `index.html`'s `#boot-loading`, for the two hosts that have a DOM
 * (`main.ts`, `main.crazygames.ts`). WeChat's equivalent is the Pixi `LoadingScreen`
 * (`game/ui/loadingScreen.ts`); both obey the same floor, which lives in `bootHold.ts`.
 *
 * The splash itself is markup and CSS in `index.html`, on purpose: it has to paint before a
 * single byte of this bundle has been parsed, which is most of the wait it exists to cover
 * (the bundle is ~290 kB gzipped and took 2.5 s to arrive on the live deploy, measured
 * 2026-09-21, after a 0.6 s request for the HTML). So what is left for this module is only
 * the part that needs to know how the boot is going: the progress bar, and WHEN the splash
 * is allowed to come down.
 *
 * ## The gap this closes
 *
 * `document.getElementById('boot-loading')?.remove()` used to be a bare statement one line
 * after `game.start()`. `start()` populates the stage; it does not draw it. The renderer
 * draws on its next tick, so removing the splash there uncovered a canvas that had never
 * had the menu on it — and on a cold boot a canvas that has never been drawn to is blank.
 * Both halves of the fix are here:
 *
 *   - `afterFirstRenderedFrame` waits for the renderer to have actually drawn the populated
 *     stage, so what the splash uncovers is the menu and never the gap before it;
 *   - `hideBootSplash` then pays out `bootHold.ts`'s floor and fades, so a fast boot does
 *     not flash the splash and a slow one is never cut short.
 *
 * Failure is NOT handled here — `bootError.ts` owns that, and deliberately keeps the element
 * in place with a refresh message rather than removing it. A boot that throws must leave
 * something on screen.
 */
import { holdBootMinimum, type BootHoldDeps } from './bootHold';

/** Matches `#boot-loading`'s CSS transition in `index.html`. A fade that outlasts its class
 *  would remove the element mid-transition and cut the splash off with a visible step. */
export const BOOT_SPLASH_FADE_MS = 320;
/** The class `index.html` styles as `opacity: 0`. */
export const HIDING_CLASS = 'is-hiding';

/** The slice of a DOM element this module touches. Spelled out rather than imported because
 *  this project's vitest environment has no jsdom (see `bootError.test.ts`), so every test
 *  here hands in a plain object. */
export interface SplashNode {
  classList: { add(name: string): void };
  style: { width: string };
  remove(): void;
}
export interface SplashDoc {
  getElementById(id: string): SplashNode | null;
}

export interface BootSplashDeps extends BootHoldDeps {
  doc?: SplashDoc;
}

/** How far the bar has been pushed, so a later, smaller report cannot walk it backwards —
 *  the lobby pack's own ticks and the coarse stage marks in the entry points interleave. */
let shown = 0;

/**
 * Move the bar, as a fraction of the whole boot. Monotonic and clamped: a bar that goes
 * backwards reads as a failure, and the fraction is assembled from two different sources.
 */
export function setBootProgress(fraction: number, deps: BootSplashDeps = {}): void {
  const next = Math.max(shown, Math.min(1, Math.max(0, fraction)));
  shown = next;
  const bar = resolveDoc(deps)?.getElementById('boot-progress');
  if (bar) bar.style.width = `${Math.round(next * 100)}%`;
}

/**
 * Take the splash down: wait out the floor, fade, remove.
 *
 * Called LAST in `boot()`, after everything else the entry point installs — the floor is a
 * wait, and nothing else should be sitting behind it.
 */
export async function hideBootSplash(deps: BootSplashDeps = {}): Promise<void> {
  const sleep = deps.sleep ?? defaultSleep;
  setBootProgress(1, deps);
  await holdBootMinimum(deps);
  const el = resolveDoc(deps)?.getElementById('boot-loading');
  if (!el) return;
  el.classList.add(HIDING_CLASS);
  await sleep(BOOT_SPLASH_FADE_MS);
  el.remove();
}

/** The slice of Pixi's `Ticker` `afterFirstRenderedFrame` needs. Structural rather than
 *  imported so this module pulls in no renderer. */
export interface FrameTicker {
  addOnce(fn: () => void): unknown;
}

/** How long `afterFirstRenderedFrame` will wait for a frame that may never come. */
export const FIRST_FRAME_TIMEOUT_MS = 4000;

/**
 * Resolves once the renderer has drawn at least one frame of the stage as it stands now.
 *
 * TWO hops, and the second one is the point. `Application` renders from a ticker listener at
 * `UPDATE_PRIORITY.LOW`, which runs after a listener added here at the default priority — so
 * the first callback fires BEFORE that tick's render, not after it. The second fires on the
 * following tick, by which time the render in between has happened and the browser has
 * painted it (a ticker tick is a `requestAnimationFrame` callback, and the paint follows the
 * callback that schedules it).
 *
 * AND A TIMEOUT, which is not belt-and-braces: a ticker is driven by
 * `requestAnimationFrame`, and a tab that was opened in the BACKGROUND is never handed one.
 * Observed directly — a preview pane left hidden sat on `lastTime` and the boot never
 * finished. Nothing is lost by giving up on the wait there (a frame nobody can see is not
 * worth holding `boot()` open for, and the browser runs a rAF before it paints the tab when
 * it does come forward), and what it costs to leave it out is a `boot()` that never returns.
 */
export function afterFirstRenderedFrame(ticker: FrameTicker, deps: BootSplashDeps = {}): Promise<void> {
  const sleep = deps.sleep ?? defaultSleep;
  const drawn = new Promise<void>((resolve) => {
    ticker.addOnce(() => ticker.addOnce(() => resolve()));
  });
  return Promise.race([drawn, sleep(FIRST_FRAME_TIMEOUT_MS)]);
}

/** Test-only: module state outlives a single test file, and a bar left at 1 would make the
 *  next file's monotonic clamp swallow every report. Same convention as
 *  `render/preloadArt.ts`'s `resetPreloadArt`. */
export function resetBootSplashForTests(): void {
  shown = 0;
}

function resolveDoc(deps: BootSplashDeps): SplashDoc | null {
  if (deps.doc) return deps.doc;
  // A host with no `document` at all is the WeChat runtime, which never calls this — but an
  // entry point that grew a shared helper might, and a ReferenceError during boot is the one
  // failure mode a splash module must not have.
  return (globalThis as { document?: SplashDoc }).document ?? null;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
