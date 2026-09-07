/**
 * Does every full-screen menu actually FIT the viewport it is shown in?
 *
 * The live bug this exists for (2026-08-25, WeChat mini-game, iPhone 12/13): with
 * `deviceOrientation: "landscape"` in wechat/game.json the viewport is 844x390 logical
 * px, roughly half the height these screens were written against. The Forge's blueprint
 * grid flows to y≈509 while its fixed bottom action bar sits at `h - 60` = 330, so START
 * RUN was drawn on top of the still-there weapon cards — reported as "stuck on the weapon
 * screen, the button to enter the map isn't visible" (卡在选武器的页面).
 *
 * The fix is a layer-wide fit-scale (ui/menuLayer.ts), so the oracle is: lay each screen
 * out at the DESIGN size `MenuLayer.fit()` hands back for a given real viewport, and
 * assert nothing lands outside it. That is the same size Game.ts passes in production —
 * every menu call site there goes through `this.layers.menu.fit(this.screenSize())`.
 *
 * Deliberately a sweep over every screen rather than a Forge-only regression: the Forge
 * was merely the WORST offender (measured minimum heights at the time: Forge 540, Settings
 * 485, LoginScreen 405, PvpPreview/PartyScreen 400, ModeSelect 380, Screens 370, MainMenu
 * 330 — all above the 390 the phone gives). A per-screen test would have let the next
 * screen to grow past the design height fail silently on the phone only.
 */
import { describe, it, expect, afterEach } from 'vitest';
import type { Container } from 'pixi.js';
import { installFakeTextCanvas } from './fakeTextCanvas';
import { MenuLayer, MENU_DESIGN_W, MENU_DESIGN_H } from '../ui/menuLayer';
import { Forge } from './Forge';
import { MainMenu } from './MainMenu';
import { ModeSelect } from './ModeSelect';
import { PvpPreview } from './PvpPreview';
import { Screens } from './Screens';
import { Settings } from './Settings';
import { PauseMenu } from './PauseMenu';
import { PartyScreen } from './PartyScreen';
import { LoginScreen } from './LoginScreen';
import { defaultMetaState } from '../../meta';
import { defaultSettingsState } from '../../settings';
import { LOCALES, setLocale, resetLocaleForTests } from '../../i18n';

// Forge.render()/Settings.show() flow off `Text.height` — see fakeTextCanvas.ts.
installFakeTextCanvas();

/** Real (CSS-pixel) viewports to check. The mini-game one is the bug; the rest guard the
 *  fix against being tuned to that single number. */
const VIEWPORTS = [
  { name: 'wechat landscape iPhone 12/13', w: 844, h: 390 },
  { name: 'wechat landscape iPhone SE', w: 667, h: 375 },
  { name: 'landscape tablet', w: 1024, h: 768 },
  { name: 'short desktop window', w: 1024, h: 560 },
  { name: 'desktop 720p', w: 1280, h: 720 },
  // The two below make WIDTH the binding axis. Without one of them the whole `w / DESIGN_W`
  // term of the fit is dead code as far as this suite is concerned — every landscape entry
  // above is height-limited, so `MENU_DESIGN_W` could be set to anything and nothing failed
  // (a real hole this suite had, found by a mutation run, not by reading it).
  { name: 'portrait phone', w: 390, h: 844 },
  { name: 'narrow desktop window', w: 720, h: 900 },
];

/** Every screen, built and laid out at whatever size it is handed. */
const SCREENS: Array<[string, (w: number, h: number) => Container]> = [
  // `storeEnabled` on: the STORE button reserves its own 36px row, so a selling build is
  // the TALLER of the two forge layouts and therefore the one the fit has to clear.
  ['Forge', (w, h) => { const s = new Forge(); s.storeEnabled = true; s.render(defaultMetaState(), w, h); return s.view; }],
  ['MainMenu', (w, h) => { const s = new MainMenu(); s.show(w, h); return s.view; }],
  ['ModeSelect', (w, h) => { const s = new ModeSelect(); s.show(w, h); return s.view; }],
  ['PvpPreview', (w, h) => { const s = new PvpPreview(); s.show(w, h, defaultMetaState().selectedSkin); return s.view; }],
  ['Screens', (w, h) => { const s = new Screens(); s.show(w, h, true, 'VICTORY', ['line one', 'line two']); return s.view; }],
  // The rewarded-ad offer makes this screen a row TALLER and, with the longest locale's
  // label, wider than any fixed-width button on it — so the offer variant is the one the
  // fit actually has to clear, exactly as `storeEnabled` is for the Forge above.
  ['Screens + ad offer', (w, h) => {
    const s = new Screens();
    s.show(w, h, true, 'EXTRACTED', ['line one', 'line two', 'line three', 'line four'],
      { label: 'СМОТРЕТЬ РЕКЛАМУ: МАТЕРИАЛЫ x2', claim: async () => [] });
    return s.view;
  }],
  ['Settings', (w, h) => { const s = new Settings(); s.show(w, h, defaultSettingsState()); return s.view; }],
  ['PauseMenu', (w, h) => { const s = new PauseMenu(); s.show(w, h); return s.view; }],
  ['PartyScreen', (w, h) => { const s = new PartyScreen({ matchBaseUrl: '' }); s.show(w, h); return s.view; }],
  ['LoginScreen', (w, h) => { const s = new LoginScreen({ matchBaseUrl: '' }); s.show(w, h); return s.view; }],
];

/**
 * Union bounds of a screen's CONTENT — every visible leaf except the screen's own
 * full-viewport `Panel` backdrop, which is always child 0 and by construction spans the
 * whole viewport (including it would make every screen trivially "fit" and measure
 * nothing).
 */
function contentBounds(view: Container) {
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
  const wasVisible = view.visible;
  view.visible = true; // screens start hidden; show() flips this only at the very end
  for (const child of view.children.slice(1)) walk(child as Container);
  view.visible = wasVisible;
  return { minX, minY, maxX, maxY };
}

const SLACK = 1; // sub-pixel text-metric noise, not a layout budget

describe.each(VIEWPORTS)('every menu screen fits $name ($w x $h)', ({ w, h }) => {
  const design = new MenuLayer().fit({ w, h });

  it.each(SCREENS)('%s', (_name, build) => {
    const b = contentBounds(build(design.w, design.h));
    expect(b.minY).toBeGreaterThanOrEqual(-SLACK);
    expect(b.maxY).toBeLessThanOrEqual(design.h + SLACK);
    expect(b.minX).toBeGreaterThanOrEqual(-SLACK);
    expect(b.maxX).toBeLessThanOrEqual(design.w + SLACK);
  });
});

describe('Forge — START RUN is reachable, not buried under the blueprint grid', () => {
  /** The exact failure the user saw: the button exists and is on-screen, but a weapon
   *  card is drawn over the same pixels, so there is nothing tappable-looking there. */
  function startButtonOverlapsACard(w: number, h: number) {
    const f = new Forge();
    f.storeEnabled = true; // the taller layout — see the sweep's note above
    f.render(defaultMetaState(), w, h);
    const p = f as unknown as {
      rowCards: Array<{ view: { visible: boolean; x: number; y: number } }>;
      startBtn: { view: { x: number; y: number } };
    };
    const btn = { x: p.startBtn.view.x, y: p.startBtn.view.y, w: 220, h: 44 }; // widgets.ts Button opts
    return p.rowCards.some((c) => {
      if (!c.view.visible) return false;
      return c.view.x < btn.x + btn.w && c.view.x + 132 > btn.x
        && c.view.y < btn.y + btn.h && c.view.y + 132 > btn.y; // BlueprintCard.W/H
    });
  }

  it.each(VIEWPORTS)('$name', ({ w, h }) => {
    const design = new MenuLayer().fit({ w, h });
    expect(startButtonOverlapsACard(design.w, design.h)).toBe(false);
  });

  // Harness check: the assertion above must be able to FAIL. Laying the same screen out
  // against the RAW 844x390 viewport — what Game.ts did before ui/menuLayer.ts existed —
  // has to reproduce the reported bug, otherwise the passes above prove nothing.
  it('reproduces the original bug when the fit-scale is skipped', () => {
    expect(startButtonOverlapsACard(844, 390)).toBe(true);
  });

  // ...and the same for the fits-the-viewport sweep: unfitted, the Forge must overflow.
  it('the unfitted 844x390 viewport also overflows on its own', () => {
    const f = new Forge();
    f.storeEnabled = true;
    f.render(defaultMetaState(), 844, 390);
    expect(contentBounds(f.view).maxY).toBeGreaterThan(390);
  });

  // Pins WHY the design height is what it is: the Forge is the tallest screen, and its
  // grid + fixed bottom bar is what sets the floor. Shrinking MENU_DESIGN_H below this
  // brings the overlap back on every device at once.
  it('the design height clears the grid the bottom bar has to sit under', () => {
    expect(startButtonOverlapsACard(1280, MENU_DESIGN_H)).toBe(false);
    expect(startButtonOverlapsACard(1280, MENU_DESIGN_H - 80)).toBe(true);
  });
});

describe('every menu screen fits in every shipped locale', () => {
  // Translated copy changes measured text width, and the Forge FLOWS its layout off
  // `infoText.height` — so "fits in English" is not the same claim as "fits". design/17-i18n
  // ships 8 locales; a screen that only overflows in de/ru would otherwise reach a player
  // before it reached a test. Run at the tightest real viewport (the mini-game one).
  afterEach(() => resetLocaleForTests());
  const design = new MenuLayer().fit({ w: 844, h: 390 });

  for (const locale of LOCALES) {
    it.each(SCREENS)(`${locale} — %s`, (_name, build) => {
      setLocale(locale);
      const b = contentBounds(build(design.w, design.h));
      expect(b.minY).toBeGreaterThanOrEqual(-SLACK);
      expect(b.maxY).toBeLessThanOrEqual(design.h + SLACK);
      expect(b.minX).toBeGreaterThanOrEqual(-SLACK);
      expect(b.maxX).toBeLessThanOrEqual(design.w + SLACK);
    });
  }
});

describe('the design space is sized to the content, not picked arbitrarily', () => {
  function widestOverflow(w: number) {
    return SCREENS.some(([, build]) => {
      const b = contentBounds(build(w, MENU_DESIGN_H));
      return b.minX < -SLACK || b.maxX > w + SLACK;
    });
  }

  it('every screen fits at exactly the design size', () => {
    expect(widestOverflow(MENU_DESIGN_W)).toBe(false);
  });

  // The other half, and the one that actually bites: an OVERSIZED design space is not a
  // layout bug, so nothing above would ever fail — it just silently shrinks everything on a
  // phone for no reason (the fit scale is `min(1, w/DESIGN_W, …)`, so doubling DESIGN_W
  // halves the scale on any width-limited viewport). Pinning that the width is not padded
  // is what keeps the constant honest. Same shape as the design-height probe below.
  it('is not padded — 200px narrower and the widest screen no longer fits', () => {
    expect(widestOverflow(MENU_DESIGN_W - 200)).toBe(true);
  });
});
