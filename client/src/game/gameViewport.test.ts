/**
 * Game's viewport wiring — the END-TO-END half of the 2026-08-25 fit-scale fix.
 *
 * `ui/menuLayer.test.ts` pins the scale math and `screens/viewportFit.test.ts` pins that
 * each screen fits the DESIGN size it is handed. Neither notices if `Game` stops handing
 * screens the design size at all: a mutation run over the 19 call sites that go through
 * `this.layers.menu.fit(this.screenSize())` found every one of them survivable, because
 * nothing in either suite so much as imports `Game.ts`.
 *
 * So this file asserts the composed property, in REAL screen pixels: after Game lays a
 * screen out and the menu layer scales it, every widget is inside the actual viewport AND
 * fills it — a layout done at the raw viewport size while the layer is scaled down would
 * still be "inside" it, just squeezed into the top-left corner (the same shape as the
 * HiDPI bug recorded in viewport.ts).
 *
 * Scope note: this is a WIRING test, not a Game test — `Game.ts`'s documented no-test-file
 * exemption (see viewport.ts) is about its size and its live collaborators, and stands.
 * Everything below drives it through its own entry points with fake Pixi collaborators,
 * the same shape controllers/GameLoop.test.ts already uses.
 */
import { describe, it, expect } from 'vitest';
import { Container } from 'pixi.js';
import { installFakeTextCanvas } from './screens/fakeTextCanvas';
import { Game } from './Game';
import { menuFitScale } from './ui/menuLayer';

installFakeTextCanvas();

// The mini-game viewport the bug was reported on: wechat/game.json declares
// deviceOrientation "landscape", so an iPhone 12/13 gives 844 x 390 logical px.
const WECHAT = { w: 844, h: 390 };

const NO_TOUCH = {
  active: false, stickRadius: 0, move: null,
  fire: { cx: 0, cy: 0, r: 0, pressed: false },
  weapon1: { cx: 0, cy: 0, r: 0 }, weapon2: { cx: 0, cy: 0, r: 0 },
  interact: { cx: 0, cy: 0, r: 0, pressed: false },
};

/** Enough of a Pixi Application for Game's constructor + start(): a real stage Container
 *  (so the layer tree and every global transform are real), a mutable `screen`, and a
 *  ticker that never fires — no frame ever runs here, only layout.
 *
 *  `resolution`/`resize` model the real renderer's contract (see AbstractRenderer): `resize`
 *  takes a LOGICAL size plus a resolution and leaves `screen` in logical px. The quality tier's
 *  `resolutionCap` (render/quality.ts) drives that call, and a fake without it both hid the
 *  behaviour and crashed the moment the tier changed. */
function fakeApp(screen: { width: number; height: number }, resolution = 2) {
  const renderer = {
    screen,
    resolution,
    resize(w: number, h: number, res?: number) {
      screen.width = w;
      screen.height = h;
      if (res !== undefined) renderer.resolution = res;
    },
  };
  return {
    stage: new Container(),
    renderer,
    ticker: { add: () => {}, remove: () => {} },
    canvas: {},
  } as unknown as ConstructorParameters<typeof Game>[0];
}

interface GameInternals {
  layers: { menu: Container; hudOverlay: Container };
  backdrop: { resize: (w: number, h: number) => void };
  forge: {
    view: Container;
    startBtn: { view: Container };
    rowCards: Array<{ view: Container }>;
  };
  settingsBtn: { view: Container };
  nav: {
    showForge: () => void;
    showMenu: () => void;
    pause: () => void;
    openSettings: () => void;
    relayout: () => void;
  };
}

function newGame(w: number, h: number) {
  const screen = { width: w, height: h };
  const game = new Game(
    fakeApp(screen),
    {
      onSwitchWeapon: null,
      attach: () => {},
      read: () => ({ moveX: 0, moveY: 0, firing: false, interacting: false }),
      getTouchVisual: () => NO_TOUCH,
      setControlMirror: () => {},
    } as never,
    { play: () => {}, setSfxVolume: () => {}, setMusicVolume: () => {}, resume: () => {} } as never,
  );
  game.start();
  return { game, screen, inner: game as unknown as GameInternals };
}

/** Union of every visible leaf's GLOBAL (post-scale, real-pixel) bounds under `root`. */
function globalContentBounds(root: Container) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const walk = (c: Container) => {
    if (!c.visible) return;
    if (c.children.length === 0) {
      const b = c.getBounds();
      if (b.width > 0 || b.height > 0) {
        minX = Math.min(minX, b.minX); minY = Math.min(minY, b.minY);
        maxX = Math.max(maxX, b.maxX); maxY = Math.max(maxY, b.maxY);
      }
      return;
    }
    for (const child of c.children) walk(child as Container);
  };
  walk(root);
  return { minX, minY, maxX, maxY };
}

/** The visible screen's own content, excluding its full-viewport Panel backdrop (child 0,
 *  which spans the viewport by construction and would make "fits" trivially true). */
function visibleScreenBounds(menu: Container) {
  const screen = menu.children.find((c) => c.visible && c.children.length > 1) as Container | undefined;
  if (!screen) throw new Error('no visible screen in the menu layer');
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const child of screen.children.slice(1)) {
    const b = globalContentBounds(child as Container);
    if (b.minX === Infinity) continue; // an all-hidden subtree contributes nothing
    minX = Math.min(minX, b.minX); minY = Math.min(minY, b.minY);
    maxX = Math.max(maxX, b.maxX); maxY = Math.max(maxY, b.maxY);
  }
  if (minX === Infinity) throw new Error('the visible screen drew nothing but its panel');
  return { minX, minY, maxX, maxY };
}

const SLACK = 1;

describe('Game — menu screens are laid out in design space and land inside the real viewport', () => {
  // Guard against this whole file passing trivially: if the fit were the identity at this
  // viewport, every assertion below would still hold with the fix reverted.
  it('the test viewport actually engages the fit-scale', () => {
    const { inner } = newGame(WECHAT.w, WECHAT.h);
    expect(menuFitScale(WECHAT.w, WECHAT.h)).toBeLessThan(1);
    expect(inner.layers.menu.scale.x).toBeCloseTo(menuFitScale(WECHAT.w, WECHAT.h), 6);
  });

  const PHASES: Array<[string, (i: GameInternals) => void]> = [
    ['menu', (i) => i.nav.showMenu()],
    ['forge', (i) => i.nav.showForge()],
    ['settings', (i) => { i.nav.showForge(); i.nav.openSettings(); }],
    ['paused', (i) => i.nav.pause()],
  ];

  it.each(PHASES)('%s — nothing spills out of the real viewport', (_name, drive) => {
    const { inner } = newGame(WECHAT.w, WECHAT.h);
    drive(inner);
    const b = visibleScreenBounds(inner.layers.menu);
    expect(b.minX).toBeGreaterThanOrEqual(-SLACK);
    expect(b.minY).toBeGreaterThanOrEqual(-SLACK);
    expect(b.maxX).toBeLessThanOrEqual(WECHAT.w + SLACK);
    expect(b.maxY).toBeLessThanOrEqual(WECHAT.h + SLACK);
  });

  // The other half, and the one that catches a MISSING fit rather than a broken one: a
  // screen laid out at the raw 844x390 and then scaled by 0.61 fits trivially — it just
  // occupies the top-left ~61% and leaves the rest of the viewport empty.
  it('forge — fills the viewport rather than being squeezed into a corner', () => {
    const { inner } = newGame(WECHAT.w, WECHAT.h);
    inner.nav.showForge();
    const b = visibleScreenBounds(inner.layers.menu);
    expect(b.maxY).toBeGreaterThan(WECHAT.h * 0.8);
    expect(b.maxX).toBeGreaterThan(WECHAT.w * 0.7);
  });

  it('forge — START RUN is on screen and no weapon card is drawn over it', () => {
    const { inner } = newGame(WECHAT.w, WECHAT.h);
    inner.nav.showForge();
    const btn = inner.forge.startBtn.view.getBounds();
    expect(btn.minY).toBeGreaterThanOrEqual(-SLACK);
    expect(btn.maxY).toBeLessThanOrEqual(WECHAT.h + SLACK);
    for (const card of inner.forge.rowCards) {
      if (!card.view.visible) continue;
      const c = card.view.getBounds();
      const overlaps = c.minX < btn.maxX && c.maxX > btn.minX && c.minY < btn.maxY && c.maxY > btn.minY;
      expect(overlaps).toBe(false);
    }
  });

  it('the forge SETTINGS button paints above every screen, not under one', () => {
    const { inner } = newGame(WECHAT.w, WECHAT.h);
    inner.nav.showForge();
    // Above EVERY screen, not just the forge. It was the only floating widget in the layer
    // until 2026-09-17, when the account prompt (design/16 holes 1 and 2) became the second
    // one — so the invariant is stated as "above every SCREEN, below every later float"
    // rather than relaxed to "above the one screen we happened to check" (the mutant that
    // hid here: moving the button into the screens array, but not last, still cleared a
    // forge-only check while leaving it under the party/login screens).
    const menu = inner.layers.menu.children;
    const FLOATS = 2; // settingsBtn, then the modal account prompt
    expect(menu.indexOf(inner.settingsBtn.view)).toBe(menu.length - FLOATS);
    expect(menu.indexOf(inner.settingsBtn.view)).toBeGreaterThan(menu.indexOf(inner.forge.view));
    // ...and the modal is above the button too, since it has to swallow taps meant for it.
    expect(menu.length - 1).toBeGreaterThan(menu.indexOf(inner.settingsBtn.view));
    expect(inner.settingsBtn.view.visible).toBe(true);
    const b = inner.settingsBtn.view.getBounds();
    expect(b.maxX).toBeLessThanOrEqual(WECHAT.w + SLACK);
    expect(b.maxY).toBeLessThanOrEqual(WECHAT.h + SLACK);
  });

  // Resize/orientation change goes through a different code path (relayoutViewport) than
  // first show, and has its own two-coordinate-space split to get wrong.
  it('a resize up re-fits: a desktop-sized window drops the scale back to 1', () => {
    const { inner, screen } = newGame(WECHAT.w, WECHAT.h);
    inner.nav.showForge();
    expect(inner.layers.menu.scale.x).toBeLessThan(1);
    screen.width = 1280; screen.height = 720;
    inner.nav.relayout();
    expect(inner.layers.menu.scale.x).toBe(1);
    const b = visibleScreenBounds(inner.layers.menu);
    expect(b.maxX).toBeLessThanOrEqual(1280 + SLACK);
    expect(b.maxY).toBeLessThanOrEqual(720 + SLACK);
  });

  it('a resize down re-fits the other way, and the forge still fits afterwards', () => {
    const { inner, screen } = newGame(1280, 720);
    inner.nav.showForge();
    expect(inner.layers.menu.scale.x).toBe(1);
    screen.width = WECHAT.w; screen.height = WECHAT.h;
    inner.nav.relayout();
    expect(inner.layers.menu.scale.x).toBeCloseTo(menuFitScale(WECHAT.w, WECHAT.h), 6);
    const b = visibleScreenBounds(inner.layers.menu);
    expect(b.maxY).toBeLessThanOrEqual(WECHAT.h + SLACK);
    expect(b.maxY).toBeGreaterThan(WECHAT.h * 0.8);
  });
});

describe('Game — the in-run HUD stays in REAL screen space, not design space', () => {
  it('the HUD layer is never scaled with the menus', () => {
    const { inner } = newGame(WECHAT.w, WECHAT.h);
    inner.nav.showForge();
    expect(inner.layers.menu.scale.x).toBeLessThan(1);
    expect(inner.layers.hudOverlay.scale.x).toBe(1);
  });

  // relayoutViewport hands `w`/`h` (design space) to the screens and `this.screenSize()`
  // (real) to the backdrop and HUD. Handing the backdrop the design size would stretch it
  // to 1385x640 on this viewport — invisible on screen, and exactly what this pins.
  it('the backdrop is sized to the real viewport, not the design one', () => {
    const { inner } = newGame(WECHAT.w, WECHAT.h);
    const sizes: Array<[number, number]> = [];
    const real = inner.backdrop.resize.bind(inner.backdrop);
    inner.backdrop.resize = (w: number, h: number) => { sizes.push([w, h]); real(w, h); };
    inner.nav.relayout();
    expect(sizes).toContainEqual([WECHAT.w, WECHAT.h]);
    for (const [w, h] of sizes) {
      expect(w).toBeLessThanOrEqual(WECHAT.w);
      expect(h).toBeLessThanOrEqual(WECHAT.h);
    }
  });
});
