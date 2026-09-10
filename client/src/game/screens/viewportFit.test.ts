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
 * 485, LoginScreen 405, PvpPreview/PartyScreen 400, ModeSelect 380 (merged into MainMenu
 * on 2026-09-10), Screens 370, MainMenu
 * 330 — all above the 390 the phone gives). A per-screen test would have let the next
 * screen to grow past the design height fail silently on the phone only.
 *
 * And the store, newly swept, exposes what this sweep CANNOT see. Its content reaches y=616
 * of a 640 design height — but at a 560 one it reaches 536, because its BACK button is
 * anchored to `h - 56` rather than flowed. A bottom-anchored control always "fits", at every
 * height, so a fits-the-viewport sweep is structurally blind to the store's real failure mode:
 * the flowed part above it (title, status line, six rows, pager) growing DOWN into it. That is
 * the Forge's bug exactly — a button that is on screen with content drawn over the same pixels
 * — and it needs the same kind of probe, which is the `describe` block near the bottom of this
 * file. Read the sweep below as "nothing is off screen", never as "nothing collides".
 *
 * `Matchmaking` and `StoreScreen` joined the list on 2026-09-08 — the only two full-screen
 * menus it had ever been missing, and missing for a mechanical reason rather than a
 * considered one: both do work in `show()` that the others do not (one opens a connection,
 * one lists SKUs), so neither could be built by a synchronous one-liner like the entries
 * around them. That is a property of the harness, not of the screens, and it left the two
 * screens a paying player sees — the queue and the store — as the only ones nothing checked
 * against a 390 px-tall phone. Builders may now be async; the injected `connect`/`api` seams
 * both screens already have for their own tests are what make them buildable with no network.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { Texture, type Container } from 'pixi.js';
import { installFakeTextCanvas } from './fakeTextCanvas';
import { MenuLayer, MENU_DESIGN_W, MENU_DESIGN_H } from '../ui/menuLayer';
import { Forge } from './Forge';
import { MainMenu } from './MainMenu';
import { PvpPreview } from './PvpPreview';
import { Screens } from './Screens';
import { Settings } from './Settings';
import { PauseMenu } from './PauseMenu';
import { PartyScreen } from './PartyScreen';
import { LoginScreen } from './LoginScreen';
import { Matchmaking } from './Matchmaking';
import { StoreScreen } from './StoreScreen';
import { StorePurchase } from '../controllers/StorePurchase';
import type { StoreSku } from '../../net/billing';
import { defaultMetaState } from '../../meta';
import { defaultSettingsState } from '../../settings';
import { LOCALES, setLocale, resetLocaleForTests } from '../../i18n';
import { setPublicFlags } from '../../net/clientFlags';
import { BANNER_MAX_LENGTH, PUBLIC_FLAG_DEFAULTS } from '../../net/publicFlags';

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

/** Every screen, built and laid out at whatever size it is handed. Async is allowed — see
 *  the two entries at the end of the list. */
type ScreenBuild = (w: number, h: number) => Container | Promise<Container>;

const SCREENS: Array<[string, ScreenBuild]> = [
  // `storeEnabled` on: the STORE button reserves its own 36px row, so a selling build is
  // the TALLER of the two forge layouts and therefore the one the fit has to clear.
  ['Forge', (w, h) => { const s = new Forge(); s.storeEnabled = true; s.render(defaultMetaState(), w, h); return s.view; }],
  // The Forge with a SAVED RUN (2026-09-10, ENGINE_VERSION 61) — its action bar is two rows
  // instead of one, plus a fourth info line, so this is the taller of the two forge layouts
  // and by this sweep's own rule the one the fit has to clear. Its own entry rather than a
  // flag on the case above, because `savedRun` defaults to "no save": without it the sweep is
  // structurally blind to the taller bar, which is the trap the store entry at the bottom of
  // this file records.
  ['Forge (saved run: two-row action bar)', (w, h) => {
    const s = new Forge();
    s.storeEnabled = true;
    s.savedRun = () => ({ floorIndex: 4, ticks: 54000, savedAtMs: 0 });
    s.render(defaultMetaState(), w, h);
    return s.view;
  }],
  ['MainMenu', (w, h) => { const s = new MainMenu(); s.show(w, h); return s.view; }],
  // The menu with a MAXIMUM-LENGTH maintenance banner, which is the taller of its two
  // layouts and therefore the one the fit has to clear — the same reason the Forge entry
  // above turns `storeEnabled` on rather than sweeping the shorter build.
  //
  // Without this entry the sweep would be structurally blind to the banner: a screen built
  // by `new MainMenu(); show()` reads the flag store, the store starts empty, and the
  // banner is never drawn. A zero here with no evidence the case arose is not a measurement,
  // which is precisely the trap the store entry at the bottom of this file records.
  ['MainMenu (maintenance banner)', (w, h) => {
    setPublicFlags({ ...PUBLIC_FLAG_DEFAULTS, 'ui.maintenanceBanner': 'M'.repeat(BANNER_MAX_LENGTH) });
    try {
      const s = new MainMenu();
      s.show(w, h);
      return s.view;
    } finally {
      setPublicFlags(null);
    }
  }],
  // The lobby in its two TALLER shapes (2026-09-10). The default entry above is the short
  // one; a portal build adds a quick-play row on top AND a data notice plus a policy link
  // under the card, and the banner variant reserves room above the title for three wrapped
  // lines. Without these the sweep would only ever see the configuration that fits easiest,
  // which is the trap the store entry at the bottom of this file records in full.
  ['MainMenu (portal: quick play + data notice)', (w, h) => {
    const s = new MainMenu();
    s.setQuickPlay(true);
    s.setAccountEntry(false);
    s.show(w, h);
    return s.view;
  }],
  ['MainMenu (portal + maintenance banner)', (w, h) => {
    setPublicFlags({ ...PUBLIC_FLAG_DEFAULTS, 'ui.maintenanceBanner': 'M'.repeat(BANNER_MAX_LENGTH) });
    try {
      const s = new MainMenu();
      s.setQuickPlay(true);
      s.setAccountEntry(false);
      s.show(w, h);
      return s.view;
    } finally {
      setPublicFlags(null);
    }
  }],
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
  // Both of this screen's states, for the same reason `Screens` above appears twice: they
  // hold different content. 'connecting' is a status line and one button; 'error' is a
  // WRAPPED message plus two buttons side by side, so it is both the taller and the wider of
  // the two, and its text comes from `classifyError` -> `t()`, i.e. it is a different length
  // in each of the eight locales the sweep at the bottom of this file runs.
  ['Matchmaking (connecting)', (w, h) => {
    const s = new Matchmaking();
    s.show(w, h, () => new Promise<never>(() => {})); // never settles: stays on the wait state
    return s.view;
  }],
  ['Matchmaking (error)', async (w, h) => {
    const s = new Matchmaking();
    // Reached through the REAL failure path rather than by hand-setting the state flag: the
    // rejection runs `classifyError`, which is what decides the string being measured.
    s.show(w, h, () => Promise.reject(new Error('matchmaking failed')));
    await new Promise((r) => setTimeout(r, 0)); // let the .then/.catch chain land
    s.resize(w, h);
    return s.view;
  }],
  // The PAGED listing: `PAGE_SIZE` is 6 and the row block is a fixed 6 slots tall, so what
  // makes this the tallest store layout is not the number of SKUs but the pager row, which
  // only appears above 6. Seven of them is therefore the worst case, and the labels are the
  // real catalogue ids so the localised-name lookup has something to find (the same fixture
  // choice `StoreScreen.test.ts` explains).
  ['StoreScreen (paged)', async (w, h) => {
    const s = new StoreScreen(new StorePurchase({
      baseUrl: () => 'http://mm',
      session: () => ({ accountId: 'a', username: 'alice', token: 'tok' }),
      platform: () => 'dev',
      api: {
        listSkus: async () => STORE_SKUS,
        createOrder: async () => { throw new Error('not used'); },
        fetchOrder: async () => { throw new Error('not used'); },
      },
      refreshOwnership: async () => {},
      sleep: async () => {},
    }));
    s.show(w, h, defaultMetaState());
    // Settle on the listing itself, not on a status string: `t('store.loading')` changes with
    // the locale, and the locale sweep below runs this builder in all eight.
    await vi.waitFor(() => expect(rowsOf(s)[0]!.view.visible).toBe(true));
    // ...and assert the state this entry claims to be, HERE, so every case that uses it
    // inherits the check. `contentBounds`' own refusal is not enough on its own: an unsettled
    // store still draws a title, a status line and BACK, so it reports perfectly finite bounds
    // for a listing with no items in it — "the store fits" would then be a claim about an
    // empty store. Verified by deleting the `waitFor` above: with this block present the
    // sweep goes red, without it only one case did.
    const visibleRows = rowsOf(s).filter((r) => r.view.visible).length;
    expect(visibleRows, 'a full page of SKU rows').toBe(6); // PAGE_SIZE, private to StoreScreen
    expect(pagerOf(s).view.visible, 'the pager, i.e. more SKUs than one page').toBe(true);
    return s.view;
  }],
];

/** Seven SKUs — one more than a page. Two ids are real `source: 'purchase'` catalogue
 *  entries; the rest only have to be wide. */
const STORE_SKUS: StoreSku[] = [
  { sku: 'bp.cryobolt', title: 'Blueprint — Cryobolt', amountCents: 1200, currency: 'CNY', grants: [{ kind: 'blueprint', id: 'cryobolt' }] },
  { sku: 'bp.cannon', title: 'Blueprint — Cannon', amountCents: 1800, currency: 'CNY', grants: [{ kind: 'blueprint', id: 'cannon' }] },
  ...Array.from({ length: 5 }, (_, i) => ({
    sku: `bp.filler${i}`, title: `Blueprint — Filler ${i}`, amountCents: 2400 + i,
    currency: 'CNY', grants: [{ kind: 'blueprint' as const, id: `filler${i}` }],
  })),
];

/** The store's six row buttons and its pager — private, same escape hatch
 *  `StoreScreen.test.ts` uses. */
function rowsOf(screen: StoreScreen) {
  return (screen as unknown as { rows: Array<{ view: { visible: boolean } }> }).rows;
}
function pagerOf(screen: StoreScreen) {
  return (screen as unknown as { nextPageBtn: { view: { visible: boolean } } }).nextPageBtn;
}

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
  // Refuse to report bounds for a screen that drew nothing. Without this the whole file is
  // vacuous for such a screen and silently so: the initial values are ±Infinity, and
  // `Infinity >= -SLACK` and `-Infinity <= h + SLACK` are BOTH true, so every case passes
  // hardest exactly when the screen is emptiest. It is a live risk for any entry that has to
  // settle async work before its content exists (the store lists SKUs) — an entry whose await
  // was wrong would otherwise read as the best-behaved screen in the sweep.
  if (maxX < minX || maxY < minY) {
    throw new Error('contentBounds: no visible content — the screen was built but drew nothing, '
      + 'so every assertion made from these bounds would pass vacuously');
  }
  return { minX, minY, maxX, maxY };
}

const SLACK = 1; // sub-pixel text-metric noise, not a layout budget

describe.each(VIEWPORTS)('every menu screen fits $name ($w x $h)', ({ w, h }) => {
  const design = new MenuLayer().fit({ w, h });

  it.each(SCREENS)('%s', async (_name, build) => {
    const b = contentBounds(await build(design.w, design.h));
    expect(b.minY).toBeGreaterThanOrEqual(-SLACK);
    expect(b.maxY).toBeLessThanOrEqual(design.h + SLACK);
    expect(b.minX).toBeGreaterThanOrEqual(-SLACK);
    expect(b.maxX).toBeLessThanOrEqual(design.w + SLACK);
  });
});

describe('Forge — START RUN is reachable, not buried under the blueprint grid', () => {
  /** The exact failure the user saw: the button exists and is on-screen, but a weapon
   *  card is drawn over the same pixels, so there is nothing tappable-looking there. */
  function startButtonOverlapsACard(w: number, h: number, saved = false) {
    const f = new Forge();
    f.storeEnabled = true; // the taller layout — see the sweep's note above
    // `saved` moves START RUN one row UP, toward the grid — see the saved-run cases below.
    if (saved) f.savedRun = () => ({ floorIndex: 4, ticks: 54000, savedAtMs: 0 });
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

  // With a saved run START RUN is no longer the bottom row — CONTINUE RUN takes that slot and
  // START RUN moves 52px UP, i.e. toward the blueprint grid. That is strictly closer to the
  // reported bug this whole block exists for, so it needs its own sweep rather than trusting
  // the one above: every case there lays out the shape where the button is furthest away.
  it.each(VIEWPORTS)('$name — with a saved run, START RUN sits a row higher', ({ w, h }) => {
    const design = new MenuLayer().fit({ w, h });
    expect(startButtonOverlapsACard(design.w, design.h, true)).toBe(false);
  });

  it('and the compare card gives way to the taller bar rather than overlapping it', () => {
    // The other half of the same reservation: `renderCompareCard`'s no-room check measures
    // against the TOP of the action bar, so with two rows it has to hide 52px sooner. Checking
    // it here rather than only in Forge.test.ts because this file owns the "on screen but
    // something is drawn over it" class of failure.
    const f = new Forge();
    f.storeEnabled = true;
    f.savedRun = () => ({ floorIndex: 4, ticks: 54000, savedAtMs: 0 });
    f.render(defaultMetaState(), 1280, MENU_DESIGN_H);
    const p = f as unknown as {
      compareCard: { view: { visible: boolean; y: number; height: number } };
      startBtn: { view: { y: number } };
    };
    if (p.compareCard.view.visible) {
      expect(p.compareCard.view.y + p.compareCard.view.height).toBeLessThanOrEqual(p.startBtn.view.y);
    }
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

  it('...and still clears it with the taller two-row bar, which can also FAIL', () => {
    // The saved-run sweep above needs the same harness check every other assertion in this
    // file has: a passing `false` proves nothing unless `true` is reachable. It is reachable
    // 52px sooner than for the one-row bar, which is the whole point of measuring it.
    expect(startButtonOverlapsACard(1280, MENU_DESIGN_H, true)).toBe(false);
    expect(startButtonOverlapsACard(1280, MENU_DESIGN_H - 80, true)).toBe(true);
  });
});

describe('Store — BACK is reachable, not buried under the SKU rows', () => {
  // The Forge's bug, on the screen that takes money. `backBtn` is the one control here that
  // is anchored to the bottom (`h - 56`) while everything above it flows downward from the
  // top, so a short enough layout draws the pager — and then the last SKU row — straight over
  // it. Nothing in the sweep above can see that: an overlap is not an overflow, and the
  // bottom-anchored button is on screen at every height by construction.
  const buildStore = SCREENS.find(([n]) => n.startsWith('StoreScreen'))![1];

  /** Does anything flowed collide with the bottom-anchored BACK button? */
  async function backButtonIsCovered(w: number, h: number) {
    const view = await buildStore(w, h);
    // Geometry from the widgets themselves (`StoreScreen`'s constructor): rows 460x34, the
    // pager buttons 80x26, BACK 140x32.
    const boxes: Array<{ x: number; y: number; w: number; h: number }> = [];
    let back: { x: number; y: number; w: number; h: number } | null = null;
    // `.slice(1)` skips the full-viewport Panel, exactly as `contentBounds` does — it covers
    // the whole screen, so leaving it in makes every control trivially "overlapped" (this
    // probe reported the design height as broken until it was excluded).
    for (const child of view.children.slice(1)) {
      if (!child.visible) continue;
      const b = child.getBounds();
      if (b.width === 0 && b.height === 0) continue;
      boxes.push({ x: b.minX, y: b.minY, w: b.width, h: b.height });
    }
    // BACK is the last child added, and the only one whose top sits within 56px of the bottom.
    back = boxes[boxes.length - 1] ?? null;
    if (!back) throw new Error('store: no BACK button measured');
    return boxes.slice(0, -1).some((r) =>
      r.x < back!.x + back!.w && r.x + r.w > back!.x && r.y < back!.y + back!.h && r.y + r.h > back!.y);
  }

  it('clears BACK at the design height, and at every shipped viewport', async () => {
    expect(await backButtonIsCovered(MENU_DESIGN_W, MENU_DESIGN_H)).toBe(false);
    for (const { w, h } of VIEWPORTS) {
      const design = new MenuLayer().fit({ w, h });
      expect(await backButtonIsCovered(design.w, design.h), `${w}x${h}`).toBe(false);
    }
  });

  it('...and the probe can fail: 220px under the design height, BACK is covered', async () => {
    // The harness check every overlap probe in this file carries. Without it, "no overlap" is
    // indistinguishable from "the probe measures nothing" — the mistake that made the whole
    // Forge sweep worth writing. It also locates the real floor: the flowed part of this
    // screen needs about 420px, so the 640 design height has room for roughly five more rows
    // before BACK is the thing that gives.
    expect(await backButtonIsCovered(MENU_DESIGN_W, MENU_DESIGN_H - 220)).toBe(true);
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
    it.each(SCREENS)(`${locale} — %s`, async (_name, build) => {
      setLocale(locale);
      const b = contentBounds(await build(design.w, design.h));
      expect(b.minY).toBeGreaterThanOrEqual(-SLACK);
      expect(b.maxY).toBeLessThanOrEqual(design.h + SLACK);
      expect(b.minX).toBeGreaterThanOrEqual(-SLACK);
      expect(b.maxX).toBeLessThanOrEqual(design.w + SLACK);
    });
  }
});

describe('the design space is sized to the content, not picked arbitrarily', () => {
  async function widestOverflow(w: number) {
    for (const [, build] of SCREENS) {
      const b = contentBounds(await build(w, MENU_DESIGN_H));
      if (b.minX < -SLACK || b.maxX > w + SLACK) return true;
    }
    return false;
  }

  it('every screen fits at exactly the design size', async () => {
    expect(await widestOverflow(MENU_DESIGN_W)).toBe(false);
  });

  // The other half, and the one that actually bites: an OVERSIZED design space is not a
  // layout bug, so nothing above would ever fail — it just silently shrinks everything on a
  // phone for no reason (the fit scale is `min(1, w/DESIGN_W, …)`, so doubling DESIGN_W
  // halves the scale on any width-limited viewport). Pinning that the width is not padded
  // is what keeps the constant honest. Same shape as the design-height probe below.
  it('is not padded — 200px narrower and the widest screen no longer fits', async () => {
    expect(await widestOverflow(MENU_DESIGN_W - 200)).toBe(true);
  });
});

interface ButtonLike {
  setIcon(t: Texture): void;
  view: { children: Array<{ text?: string; x: number; width: number; anchor: { x: number } }> };
}

describe('a label that spills out of its own button (2026-09-10)', () => {
  // The blind spot the sweep above has, found the hard way and closed here for the one
  // screen it bit. The lobby's first draft put CO-OP and PVP QUEUE side by side at 135px;
  // `PVP SOLO QUEUE` needs 169 and Polish needs 187, so the label ran out of its button and
  // across the gap into its neighbour — in seven of the eight locales. Every case above
  // stayed green, and correctly so: the text was still comfortably inside the design space,
  // which is the only thing "fits the viewport" can mean. Read that sweep as "nothing is off
  // screen", never as "nothing collides"; this is the collision half, for buttons.
  //
  // The metric is `fakeTextCanvas`'s 0.6em-per-character approximation, so it is not the
  // real font. It errs the useful way for Latin text — the live measurement of the string
  // above came out at 0.55em — and it under-measures CJK, where a glyph is about a full em.
  // A Chinese label that only just fits here is therefore not proof; a Latin one is.
  afterEach(() => resetLocaleForTests());

  /** Every Button on the lobby, in the order it is drawn, with its own box width. */
  function lobbyButtons(m: MainMenu) {
    const p = m as unknown as {
      playBtn: unknown;
      routes: Record<string, unknown>;
      accountBtn: unknown;
      settingsBtn: unknown;
    };
    const r = p.routes;
    return {
      PLAY: p.playBtn, SOLO: r.soloBtn, 'CO-OP': r.coopBtn, PVP: r.pvpSoloBtn,
      SQUAD: r.squadBtn, TUTORIAL: r.tutorialBtn, ACCOUNT: p.accountBtn, SETTINGS: p.settingsBtn,
    } as Record<string, ButtonLike>;
  }

  for (const locale of LOCALES) {
    it(`${locale} — every lobby label stays inside its own button`, () => {
      setLocale(locale);
      const m = new MainMenu();
      m.setQuickPlay(true); // draws PLAY too, so the portal build is covered in the same pass
      m.show(MENU_DESIGN_W, MENU_DESIGN_H);
      for (const [name, btn] of Object.entries(lobbyButtons(m))) {
        // The icon a shipped lobby button HAS. Without it `getUiTexture` answers undefined,
        // the label centres itself, and this sweep would measure a layout no player ever
        // sees — the centred one fits in places the real one does not, because the real one
        // starts after the chip. `Texture.WHITE` needs no GPU and no art pack.
        btn.setIcon(Texture.WHITE);
        const kids = btn.view.children;
        const box = (kids[0] as unknown as Container).getLocalBounds().width;
        const label = kids.find((c) => typeof c.text === 'string');
        expect(label, `${name} has no label`).toBeDefined();
        const left = label!.x - label!.width * label!.anchor.x;
        expect(left + label!.width, `${locale} ${name}: ${label!.text} runs past its box`)
          .toBeLessThanOrEqual(box + SLACK);
        expect(left, `${locale} ${name}: ${label!.text} starts left of its box`)
          .toBeGreaterThanOrEqual(-SLACK);
      }
    });
  }
});
