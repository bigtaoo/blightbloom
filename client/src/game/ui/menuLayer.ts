import { Container } from 'pixi.js';

/**
 * The menu/overlay layer and the one piece of policy that belongs to it: every
 * full-screen screen (MainMenu/Forge/Settings/…) is laid out in a fixed
 * DESIGN space and the whole layer is scaled DOWN to fit viewports smaller than it,
 * rather than each screen re-flowing its own layout per viewport.
 *
 * Why this exists (live bug, 2026-08-25, WeChat mini-game on an iPhone 12/13):
 * `wechat/game.json` declares `deviceOrientation: "landscape"`, so the mini-game
 * viewport is 844x390 logical px — about half the height every menu screen was
 * written against. The Forge's blueprint grid alone flows to y≈509, while its fixed
 * bottom action bar sits at `h - 60` = 330, so START RUN was drawn *on top of* the
 * still-there weapon cards and read as "the button to enter the map isn't there"
 * (reported as 卡在选武器的页面). Every other screen was over-tall too, by less:
 * measured minimum heights were Forge 540 (570 to also clear its own bottom bar),
 * Settings 485, LoginScreen 405, PvpPreview/PartyScreen 400, ModeSelect 380 (that screen
 * is gone since 2026-09-10 — its routes are rows in the menu, which grew accordingly),
 * Screens 370, MainMenu 330 — against a 390px viewport.
 *
 * A uniform fit-scale fixes all of them at once and keeps one layout per screen. The
 * cost is density: at 844x390 the scale is 0.61, so a 12px label renders at ~7 CSS px
 * (~15 device px at the phone's pixelRatio 2). Re-flowing the Forge grid wider-and-
 * shorter on a very wide viewport would buy that back and is the follow-up if the
 * shrink reads too small on a real handset — it is not a correctness issue.
 *
 * Never scales UP (`Math.min(1, …)`): on any viewport at or above the design size this
 * is the identity transform, so desktop web is bit-for-bit unchanged.
 *
 * NOT the in-run HUD or the touch controls — those live in `Layers.ui` outside this
 * container and stay in real screen space, where a thumbstick that is physically
 * thumb-sized matters more than matching the menus' density.
 */
export const MENU_DESIGN_W = 760;
export const MENU_DESIGN_H = 640;

/** Fit scale for a viewport, capped at 1 (down-scale only). Pure — the unit under test. */
export function menuFitScale(w: number, h: number): number {
  if (!(w > 0) || !(h > 0)) return 1; // degenerate/unmeasured viewport: leave the layer alone
  return Math.min(1, w / MENU_DESIGN_W, h / MENU_DESIGN_H);
}

export class MenuLayer extends Container {
  /**
   * Mount the layer's contents in the only order that works: every full-screen `screens`
   * entry first, then everything in `floating` on top of all of them.
   *
   * This is a method rather than a bare `addChild(...)` at the call site because the
   * ordering is not obvious and getting it wrong is silent. Each screen paints a
   * full-viewport `Panel` before its own widgets, so ANY widget that floats over
   * "whichever screen is up" — today the forge's SETTINGS button — has to be added after
   * all of them. It was not: it is built in `Game.buildHud()`, which runs before the
   * screens are constructed, so mounting it there put it underneath the forge's own hub
   * backdrop, where it was invisible and untappable at every viewport, desktop included.
   */
  mount(screens: readonly Container[], floating: readonly Container[]): void {
    this.addChild(...screens, ...floating);
  }

  /**
   * Apply the fit scale for a real (CSS-pixel) viewport and return the DESIGN-space
   * size the screens should lay out against. Callers pass the returned size straight
   * into `show()`/`render()`, so a screen never needs to know it is being scaled.
   */
  fit(real: { w: number; h: number }): { w: number; h: number } {
    const s = menuFitScale(real.w, real.h);
    this.scale.set(s);
    return { w: real.w / s, h: real.h / s };
  }
}
