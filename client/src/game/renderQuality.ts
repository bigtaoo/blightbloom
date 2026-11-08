// Split out of Game.ts (2026-08-25, 500-line convention). Owns one concern: turning the
// persisted quality SETTING plus the frame watchdog's verdict into the renderer configuration
// that the tier describes (`render/quality.ts`).
//
// Form (2) from CLAUDE.md, not (1): there is per-instance state to hold — the watchdog's latch
// and the platform's own resolution — so the alternative would be threading both through every
// call. The cross-boundary call list is three methods in one direction (`apply`, `observeWindow`,
// `pin`) and the four-member `deps` object below in the other, each narrowed to just what is
// used rather than being a handle on `FxController`/`Scene`/`Application`.
//
// Nothing here reads or writes engine state: a quality tier is presentation-only, which is what
// keeps two clients on different tiers byte-identical in simulation (design/06/12).
import { resolveTier, setActiveQuality, activeQuality, type QualitySetting } from '../render/quality';
import { QualityWatchdog, playFpsFloor, type FrameWindowLike } from '../render/qualityWatchdog';
import { expectedPlayFps } from './powerBudget';

export interface RenderQualityDeps {
  /** Re-mounts exactly the full-viewport filter passes the active tier calls for. */
  fx: { applyQuality(): void };
  /** Recomposes every live actor's skin filters against the active tier. */
  scene: { refreshQuality(): void };
  /** The live renderer. `resize` takes a LOGICAL size plus a resolution — see `apply`. */
  renderer: { resolution: number; resize(w: number, h: number, resolution?: number): void };
  /** The logical (CSS-pixel) viewport, i.e. Game's own `screenSize()`. */
  screenSize(): { w: number; h: number };
}

export class RenderQualityController {
  // Judged against what THIS display delivers at the player's in-run cap, read per window — see
  // `playFpsFloor` for why a flat floor let a 30 fps desktop keep the high tier forever.
  private readonly watchdog = new QualityWatchdog({ fpsFloor: () => playFpsFloor(expectedPlayFps()) });
  /** Whether the previous window closed during a run — see `observeWindow`. */
  private lastWindowPlaying = false;
  /** Whatever resolution the PLATFORM picked at `createApp()` — `min(devicePixelRatio, 2)` in
   *  both of them today. A tier's `resolutionCap` only ever lowers this, never raises it: the
   *  platform knows things about the host (a mini-game's `pixelRatio`, a browser's
   *  `autoDensity`) that a quality tier has no business overriding upward. */
  private readonly baseResolution: number;

  constructor(private readonly deps: RenderQualityDeps) {
    const res = deps.renderer.resolution;
    // A renderer that reports no resolution IS a 1x renderer; without this the `Math.min` in
    // `apply` would produce NaN and every comparison against it would read as "needs a resize",
    // forever.
    this.baseResolution = Number.isFinite(res) && res > 0 ? res : 1;
  }

  /**
   * Resolve the effective tier from `setting` + how many rungs the watchdog has stepped down,
   * push it into the live mirror, and re-apply everything that reads it.
   *
   * Safe to call at any time and idempotent — the resolution branch is the only part with a real
   * cost, and it is guarded on an actual change because `renderer.resize` reallocates the
   * backing buffer.
   */
  apply(setting: QualitySetting): void {
    setActiveQuality(resolveTier(setting, this.watchdog.downgrades), this.baseResolution);
    this.deps.fx.applyQuality();
    this.deps.scene.refreshQuality();
    const wanted = Math.min(this.baseResolution, activeQuality().resolutionCap);
    if (this.deps.renderer.resolution === wanted) return;
    // Through `resize`, not the bare `resolution` setter: the setter changes how many device
    // pixels back each logical pixel without telling the view its size has to be recomputed,
    // and `resize` is the call that does both and emits the `resize` event. The logical
    // (CSS-pixel) size is unchanged by design — `game/viewport.ts` reads `renderer.screen`,
    // which is resolution-independent, so no layout above this moves.
    const { w, h } = this.deps.screenSize();
    this.deps.renderer.resize(w, h, wanted);
  }

  /**
   * One closed perf sampling window (`src/perf`). Only consulted while the setting is `'auto'`:
   * on a pinned tier the watchdog has no authority, and letting it accumulate a verdict anyway
   * would leak measurements taken under one renderer configuration into a later `'auto'` session
   * running a different one.
   *
   * And only a window that lies wholly inside a run (`playing` at its close AND at the close
   * of the one before it) is evidence. Every other phase runs at `IDLE_MAX_FPS` = 30 on
   * purpose (`powerBudget.ts`), under the 45 fps floor a 60 fps run is judged by, so a menu
   * window would read as a slow device; and the window that straddles a run's start holds the
   * loading screen's frames, which describe the load and not the game. Like a `discarded`
   * window, a skipped one neither counts toward the streak nor resets it.
   */
  observeWindow(setting: QualitySetting, w: FrameWindowLike, playing: boolean): void {
    const wholeRun = playing && this.lastWindowPlaying;
    this.lastWindowPlaying = playing;
    if (setting !== 'auto' || !wholeRun) return;
    if (!this.watchdog.observe(w)) return;
    // Deliberately does not touch the persisted setting: a downgrade is a fact about this
    // session's measured framerate, not a choice the player made, and writing it to disk would
    // make one bad afternoon permanent.
    this.apply(setting);
  }

  /**
   * The player changed the setting. Pinning a tier by hand clears the watchdog's verdict, so
   * that coming back to `'auto'` re-measures instead of inheriting a downgrade from conditions
   * that may have passed (a background download, a thermal throttle).
   */
  pin(setting: QualitySetting): void {
    if (setting !== 'auto') this.watchdog.reset();
    this.apply(setting);
  }
}
