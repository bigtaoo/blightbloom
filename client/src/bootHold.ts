/**
 * The minimum a boot splash stays up, shared by the two splashes this game has.
 *
 * Web/portal draw theirs in the DOM (`index.html`'s `#boot-loading`, driven by
 * `bootSplash.ts`); WeChat draws a Pixi one, because a mini-game has no DOM to put a splash
 * in (`game/ui/loadingScreen.ts`). The POLICY — how long a player looks at it before it is
 * allowed to come down — has to be the same on all three, so it lives here rather than
 * twice.
 *
 * ## Why a minimum at all
 *
 * Not decoration. A boot that finishes fast still has a hole in it: `preloadLobbyArt()`
 * resolving is not the same instant as the menu being on the glass, and the splash used to
 * be removed one statement after `game.start()` — before the renderer had drawn the stage
 * that call populated. What showed in that gap was whatever the canvas last held, which on a
 * cold boot is nothing. A floor on the visible time closes that gap for every fast boot, and
 * `bootSplash.afterFirstRenderedFrame` closes it for the slow ones.
 *
 * ## Measured from the page opening, not from here
 *
 * The clock starts at navigation, not at the first line of JavaScript — a 0.6 s request for
 * `index.html` and a 2.5 s one for the bundle are time the player has already spent looking
 * at the splash (measured on the live deploy, 2026-09-21), and charging them three more
 * seconds for it would be the opposite of what a floor is for. `performance.now()` is
 * exactly that number on web. WeChat's runtime has no navigation to be relative to, so the
 * fallback is this module's own load time, which on that host is within a few ms of the
 * game opening.
 */

/** When this module was evaluated — the WeChat fallback epoch. See the header. */
const LOADED_AT = Date.now();

/** How long the boot splash stays up at the very least, counted from the page opening. */
export const MIN_BOOT_SPLASH_MS = 3000;

/** ms since the page/mini-game began loading. */
export function bootElapsedMs(): number {
  const perf = (globalThis as { performance?: { now?: () => number; timeOrigin?: number } }).performance;
  // `timeOrigin` is the half that makes `now()` mean "since the page opened" rather than
  // "since some unspecified epoch" — without it the value is not comparable to a navigation
  // and the fallback is the honest answer.
  if (typeof perf?.now === 'function' && typeof perf.timeOrigin === 'number') return perf.now();
  return Date.now() - LOADED_AT;
}

/** How much longer the splash owes the player, given how long the boot has already taken.
 *  Zero once the floor has been paid — a slow boot never waits on this. */
export function remainingBootHoldMs(elapsedMs: number, minMs: number = MIN_BOOT_SPLASH_MS): number {
  return Math.max(0, minMs - elapsedMs);
}

export interface BootHoldDeps {
  /** ms since the page opened. Injected so a test does not have to wait out a real second. */
  elapsed?(): number;
  sleep?(ms: number): Promise<void>;
  /** Overrides `MIN_BOOT_SPLASH_MS` — the seam a host with a different floor would use. */
  minMs?: number;
}

/** Resolves when the splash has been up for its minimum. */
export function holdBootMinimum(deps: BootHoldDeps = {}): Promise<void> {
  const elapsed = deps.elapsed ?? bootElapsedMs;
  const sleep = deps.sleep ?? defaultSleep;
  return sleep(remainingBootHoldMs(elapsed(), deps.minMs));
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
