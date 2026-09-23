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
import { Loadout } from './Loadout';
import { MainMenu } from './MainMenu';
import { PvpPreview } from './PvpPreview';
import { Screens } from './Screens';
import { Settings } from './Settings';
import { PauseMenu } from './PauseMenu';
import { PartyScreen } from './PartyScreen';
import { LoginScreen } from './LoginScreen';
import { Matchmaking } from './Matchmaking';
import { StoreScreen } from './StoreScreen';
import { AccountPrompt } from '../ui/AccountPrompt';
import { StorePurchase } from '../controllers/StorePurchase';
import type { StoreSku } from '../../net/billing';
import { defaultMetaState } from '../../meta';
import { defaultSettingsState } from '../../settings';
import { LOCALES, resetLocaleForTests } from '../../i18n';
import { setPublicFlags } from '../../net/clientFlags';
import { RunOutcome, type RunOutcomeHost } from '../controllers/RunOutcome';
import { createGameState, type GameState } from '@dd/engine/state/GameState';
import type { ArenaMap } from '@dd/engine/content/arenas';
import { BANNER_MAX_LENGTH, PUBLIC_FLAG_DEFAULTS } from '../../net/publicFlags';
import { useLocale } from '../../i18n/loadLocale';

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

/**
 * The result screen's REAL content, produced by the shipped `RunOutcome` rather than restated
 * here (2026-09-17).
 *
 * Both `Screens` entries below used to be built with `['line one', 'line two']`, which made
 * every one of them — INCLUDING the eight-locale sweep at the bottom of this file — a
 * measurement of English placeholder text. The sweep ran eight times over a fixture that could
 * not change with the locale, so it was structurally incapable of catching the thing it exists
 * to catch, and it proved it: `results.guestNotRanked` (design/16 hole 3) shipped at **878px in
 * Spanish and 809px in Polish against a 760px design width**, through a green run of this file.
 *
 * Driving the real `RunOutcome` rather than calling the same `t()` keys by hand is the half that
 * keeps it honest. A fixture that lists the keys is a second copy of the composition: add a
 * ninth line to a result screen and the copy still measures eight. This one measures whatever
 * the screen actually shows, so a future line is swept the day it is written and in every
 * locale, with nobody having to remember this file exists.
 *
 * Note the guest-ladder notice is present in the arena cases precisely because these run as an
 * unauthenticated player on the default `web` host — the widest real state, which is the one a
 * fit sweep wants.
 */
const MEASURE_ARENA: ArenaMap = {
  id: 'fit', sizeGrid: { w: 10, h: 10 },
  rooms: [{ id: 'A', rectGrid: { x: 0, y: 0, w: 10, h: 10 }, solids: [] }],
  doors: [], spawns: [{ x: 5, y: 5 }], eyeCandidates: [{ roomId: 'A' }],
};

type Outcome = { won: boolean; title: string; lines: readonly string[] };

/** Runs one outcome through `RunOutcome` and returns what it put on screen. */
function realOutcome(kind: 'arenaWin' | 'arenaLoss' | 'pveWin' | 'pveLoss'): Outcome {
  const arena = kind === 'arenaWin' || kind === 'arenaLoss';
  const s: GameState = createGameState({
    seed: 1, worldW: 0, worldH: 0, waves: [],
    // Eight seats: design/06's match-size ceiling, so the placement line is measured at the
    // widest field the game can actually produce rather than at a convenient small one.
    ...(arena ? { arena: MEASURE_ARENA, players: Array.from({ length: 8 }, (_, i) => ({ teamId: i })) } : {}),
  });
  // A six-digit score and a 1:37 clock: the numbers a real result block reaches, rather than
  // the zeroes a freshly-created state would hand it.
  s.tick = 60 * 97 + 15;
  if (arena) {
    if (kind === 'arenaWin') s.winner = 0;
    else { s.winner = 7; s.placements.push(1, 2, 3, 4, 5, 6, 0); }
  } else {
    s.floorIndex = 2;
    s.players[0]!.bankedMaterials = { fire: 3, ice: 2 };
    if (kind === 'pveLoss') s.winner = 'enemies';
  }
  let shown: Outcome | undefined;
  const host: RunOutcomeHost = {
    localOwner: 0,
    addScore: () => {}, currentScore: () => 123456, setPhase: () => {}, hideHud: () => {},
    bankRunCarryOut: () => {}, isOnline: () => true, // online: suppresses the ad offer, which
                                                    // the second entry below supplies itself
    showOutcomeScreen: (won, title, lines) => { shown = { won, title, lines }; },
  };
  new RunOutcome(host).handle(s);
  if (!shown) throw new Error(`realOutcome(${kind}): RunOutcome showed no screen — the fixture would measure nothing`);
  return shown;
}

const SCREENS: Array<[string, ScreenBuild]> = [
  // `storeEnabled` on: the STORE button reserves its own 36px row, so a selling build is
  // the TALLER of the two forge layouts and therefore the one the fit has to clear.
  ['Forge', (w, h) => { const s = new Forge(); s.storeEnabled = true; s.render(defaultMetaState(), w, h); return s.view; }],
  // The LOADOUT screen (2026-09-21) — the pre-run half the forge used to also be. Its own
  // entry for the same reason every other screen has one, and two of them, because a SAVED
  // RUN makes its action bar two rows instead of one plus a wrapped saved-run line. Without
  // the second case the sweep is structurally blind to the taller bar, which is the trap the
  // store entry at the bottom of this file records.
  ['Loadout', (w, h) => { const s = new Loadout(); s.render(defaultMetaState(), w, h); return s.view; }],
  ['Loadout (saved run: two-row action bar)', (w, h) => {
    const s = new Loadout();
    s.savedRun = () => ({ floorIndex: 4, ticks: 54000, savedAtMs: 0 });
    s.render(defaultMetaState(), w, h);
    return s.view;
  }],
  // ...and with a full loadout, because the weapon cards then carry real weapon NAMES (they
  // wrap) and a forged badge, where an empty one carries the starter kit's shorter pair.
  ['Loadout (forged loadout)', (w, h) => {
    const s = new Loadout();
    s.render({ ...defaultMetaState(), loadout: ['repeater', 'emberblade'] }, w, h);
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
  // The TALLEST lobby there is (2026-09-17): a portal build's quick-play row and data notice,
  // the longest legal maintenance banner above the title, AND the CONTINUE row + caption a
  // resumable save adds on top of the five routes. Each of those three was separately the
  // reason a previous entry was added here; the configuration that has all of them at once is
  // the only one that proves the card still centres on screen at a landscape phone's height.
  ['MainMenu (portal + banner + saved run)', (w, h) => {
    setPublicFlags({ ...PUBLIC_FLAG_DEFAULTS, 'ui.maintenanceBanner': 'M'.repeat(BANNER_MAX_LENGTH) });
    try {
      const s = new MainMenu();
      s.setQuickPlay(true);
      s.setAccountEntry(false);
      s.resumableRun = () => ({ floorIndex: 2, ticks: 9000, savedAtMs: 0 });
      s.show(w, h);
      return s.view;
    } finally {
      setPublicFlags(null);
    }
  }],
  // ...and the ordinary build with a saved run, which is the shape almost every returning
  // player actually sees.
  ['MainMenu (saved run)', (w, h) => {
    const s = new MainMenu();
    s.resumableRun = () => ({ floorIndex: 2, ticks: 9000, savedAtMs: 0 });
    s.show(w, h);
    return s.view;
  }],
  ['PvpPreview', (w, h) => { const s = new PvpPreview(); s.show(w, h, defaultMetaState().selectedSkin); return s.view; }],
  // All four outcomes, because they hold different content and the arena pair carries a line
  // the PvE pair does not (the guest-ladder notice).
  ...(['arenaWin', 'arenaLoss', 'pveWin', 'pveLoss'] as const).map((kind) =>
    [`Screens (${kind})`, (w: number, h: number) => {
      const o = realOutcome(kind);
      const s = new Screens();
      s.show(w, h, o.won, o.title, o.lines);
      return s.view;
    }] as [string, ScreenBuild]),
  // The rewarded-ad offer makes this screen a row TALLER and, with the longest locale's
  // label, wider than any fixed-width button on it — so the offer variant is the one the
  // fit actually has to clear, exactly as `storeEnabled` is for the Forge above.
  ['Screens + ad offer', (w, h) => {
    // The PvE win is the only outcome the offer can appear on (`RunOutcome.doubleOffer`), so
    // it is that outcome's real lines under it rather than four placeholders.
    const o = realOutcome('pveWin');
    const s = new Screens();
    s.show(w, h, o.won, o.title, o.lines,
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
  // The account modals (design/16 holes 1 and 2). Not a full-screen menu, but it is laid out
  // in the same design space and its panel is a fixed 268px tall, so it belongs to the same
  // question this file asks: does it stay on a 390px-tall landscape phone? Its scrim is child
  // 0 and spans the viewport by construction, exactly like a screen's backdrop `Panel`, so
  // `contentBounds` skips it without needing a special case.
  ['AccountPrompt (merge)', (w, h) => {
    const p = new AccountPrompt({ size: () => ({ w, h }) });
    void p.askGuestMerge({ materials: 5, blueprints: 1, characters: 0 }, 'alice');
    return p.view;
  }],
  ['AccountPrompt (notice)', (w, h) => {
    const p = new AccountPrompt({ size: () => ({ w, h }) });
    p.showNotice('SIGNED OUT', 'your saved session is no longer valid');
    return p.view;
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

describe('Loadout — START RUN is reachable, not buried under the weapon row', () => {
  /** The exact failure the user saw, on the screen that owns the button now: it exists and
   *  is on-screen, but a card is drawn over the same pixels, so there is nothing
   *  tappable-looking there. */
  function startButtonOverlapsACard(w: number, h: number, saved = false) {
    const l = new Loadout();
    // `saved` moves START RUN one row UP, toward the cards — see the saved-run cases below.
    if (saved) l.savedRun = () => ({ floorIndex: 4, ticks: 54000, savedAtMs: 0 });
    l.render(defaultMetaState(), w, h);
    const p = l as unknown as {
      weaponCards: Array<{ view: { visible: boolean; x: number; y: number } }>;
      forgeCard: { view: { visible: boolean; x: number; y: number } };
      startBtn: { view: { x: number; y: number } };
    };
    const btn = { x: p.startBtn.view.x, y: p.startBtn.view.y, w: 220, h: 44 }; // widgets.ts Button opts
    return [...p.weaponCards, p.forgeCard].some((c) => {
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
  // START RUN moves 52px UP, i.e. toward the weapon row. That is strictly closer to the
  // reported bug this whole block exists for, so it needs its own sweep rather than trusting
  // the one above: every case there lays out the shape where the button is furthest away.
  it.each(VIEWPORTS)('$name — with a saved run, START RUN sits a row higher', ({ w, h }) => {
    const design = new MenuLayer().fit({ w, h });
    expect(startButtonOverlapsACard(design.w, design.h, true)).toBe(false);
  });

  // Harness check: the assertion above must be able to FAIL. Laying the same screen out
  // against the RAW 844x390 viewport — what Game.ts did before ui/menuLayer.ts existed —
  // has to reproduce the reported bug, otherwise the passes above prove nothing.
  it('reproduces the original bug when the fit-scale is skipped', () => {
    expect(startButtonOverlapsACard(844, 390)).toBe(true);
  });

  // Pins WHY the design height is what it is: shrinking `MENU_DESIGN_H` far enough brings
  // the overlap back on every device at once.
  it('the design height clears the row the bottom bar has to sit under', () => {
    expect(startButtonOverlapsACard(1280, MENU_DESIGN_H)).toBe(false);
    expect(startButtonOverlapsACard(1280, MENU_DESIGN_H - 200)).toBe(true);
  });

  it('...and still clears it with the taller two-row bar, which can also FAIL', () => {
    // The saved-run sweep above needs the same harness check every other assertion in this
    // file has: a passing `false` proves nothing unless `true` is reachable. It is reachable
    // 52px sooner than for the one-row bar, which is the whole point of measuring it.
    expect(startButtonOverlapsACard(1280, MENU_DESIGN_H, true)).toBe(false);
    expect(startButtonOverlapsACard(1280, MENU_DESIGN_H - 200, true)).toBe(true);
  });
});

describe('Forge — the grid gives way rather than stacking on the hint line', () => {
  it('the compare card hides instead of overlapping what is pinned to the bottom', () => {
    // The other half of the same reservation the action bar used to get: this screen's
    // lowest drawn thing is now its hint line, and `renderCompareCard`'s no-room check
    // measures against it. Checked here rather than only in Forge.test.ts because this file
    // owns the "on screen but something is drawn over it" class of failure.
    const f = new Forge();
    f.storeEnabled = true;
    f.render(defaultMetaState(), 1280, MENU_DESIGN_H);
    const p = f as unknown as {
      compareCard: { view: { visible: boolean; y: number; height: number } };
      hint: { y: number };
    };
    if (p.compareCard.view.visible) {
      expect(p.compareCard.view.y + p.compareCard.view.height).toBeLessThanOrEqual(p.hint.y);
    }
  });

  // ...and the fits-the-viewport sweep's own harness check: unfitted, the Forge must overflow.
  it('the unfitted 844x390 viewport also overflows on its own', () => {
    const f = new Forge();
    f.storeEnabled = true;
    f.render(defaultMetaState(), 844, 390);
    expect(contentBounds(f.view).maxY).toBeGreaterThan(390);
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

/**
 * Translated copy changes measured text width, and the Forge FLOWS its layout off
 * `infoText.height` — so "fits in English" is not the same claim as "fits". design/17-i18n
 * ships 8 locales; a screen that only overflows in de/ru would otherwise reach a player before
 * it reached a test.
 *
 * **Two viewports, and the second one was missing until 2026-09-17.** This sweep ran only at the
 * mini-game's 844x390, which is the tightest real viewport in HEIGHT — and at that aspect the
 * fit scale is height-bound, so the design space is ~1386px WIDE. Every locale had ~626px of
 * horizontal slack it will not have on a portrait phone, where width binds and the design space
 * is exactly `MENU_DESIGN_W`. `VIEWPORTS` above already carries two width-binding entries for
 * precisely this reason, and the sweep at the top of the file runs them — but only in English.
 * So the locale axis and the width-bound axis were each covered and never crossed, which is a
 * hole shaped exactly like the thing both were built to catch.
 *
 * It was not hypothetical: `results.guestNotRanked` (design/16 hole 3) shipped at 878px in
 * Spanish and 809px in Polish against a 760px design width, and BOTH sweeps stayed green — the
 * English one because English is 445px, this one because 878 < 1386. Adding the portrait phone
 * here is what turns it red. (The result screen's own fixture was the other half of that miss;
 * see `realOutcome` above.)
 */
describe.each([
  { name: 'wechat landscape (height-bound)', w: 844, h: 390 },
  { name: 'portrait phone (width-bound)', w: 390, h: 844 },
])('every menu screen fits in every shipped locale — $name', ({ w, h }) => {
  afterEach(() => resetLocaleForTests());
  const design = new MenuLayer().fit({ w, h });

  for (const locale of LOCALES) {
    it.each(SCREENS)(`${locale} — %s`, async (_name, build) => {
      await useLocale(locale);
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
    it(`${locale} — every lobby label stays inside its own button`, async () => {
      await useLocale(locale);
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
