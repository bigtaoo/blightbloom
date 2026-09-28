/**
 * Screens (the victory/defeat outcome overlay). Pixi Container/Text/Graphics construct
 * and mutate fine under plain vitest with no renderer attached (same finding
 * TouchControlsView.test.ts / PartyScreen.test.ts made) — asserted here via
 * `.position`/`.visible`, not pixel output.
 *
 * `resize()` is the fix for a real bug: the canvas already tracks the browser viewport
 * (WebPlatform's `resizeTo: window`), but this screen's Panel/text positions were only
 * ever computed once, at whatever size was current when show() was called — so a
 * window resize left them pinned to the old size (reported as a boxed-in-the-corner
 * layout with black bars filling the rest of the canvas). `resize()` re-runs the same
 * layout math against a fresh size; it must also stay a no-op while the screen isn't
 * showing, since Game.ts calls it unconditionally on every window resize regardless of
 * the current phase.
 *
 * `confirmBtn`/`menuBtn` are real Buttons (2026-08-17, see Screens.ts's own doc
 * comment for why tap-anywhere-on-the-panel was removed) — `emitTap` below drives
 * their real `pointertap` event, the same "Press is not activate" contract
 * widgets.test.ts covers for Button in general.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { Texture } from 'pixi.js';
import { Screens, type ResultOffer } from './Screens';
import { setLocale, resetLocaleForTests } from '../../i18n';
import { useLocale } from '../../i18n/loadLocale';
import { installFakeTextCanvas } from './fakeTextCanvas';

// The sheet measures the stat lines (`Text.height`) to size their box, which needs a 2D context.
installFakeTextCanvas();

// The badge art. Nothing is loaded under vitest, so `getUiTexture` answers `undefined` and the
// badge stays hidden — `badge.tex` stands in for the art having arrived.
const badge = vi.hoisted(() => ({ tex: undefined as unknown }));
vi.mock('../../render/uiSkins', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../render/uiSkins')>()),
  getUiTexture: () => badge.tex,
  // `whenUiTexture` through the same fake: the real one reads the module's own map, which
  // this mock never fills, so constructor-time icons would silently stay off.
  whenUiTexture: ((_key, apply) => { const tex = badge.tex; if (tex) apply(tex as never); }) as typeof import('../../render/uiSkins').whenUiTexture,
}));

type Tappable = { view: { emit: (event: string) => void; visible: boolean; position: { x: number; y: number } }; label: { text: string } };

function privateOf(s: Screens) {
  const shell = (s as unknown as {
    shell: {
      sheet: { title: { text: string; style: { fill: unknown } }; height: number; view: unknown };
      backBtn: Tappable;
      scale: number;
    };
  }).shell;
  const self = s as unknown as {
    sub: { position: { x: number; y: number }; text: string };
    confirmBtn: Tappable & { width: number };
    offerBtn: Tappable;
    resultIcon: { visible: boolean };
  };
  /** MAIN MENU is the menu shell's corner chip since 2026-09-27. */
  return Object.assign(Object.create(self) as typeof self, { title: shell.sheet.title, menuBtn: shell.backBtn, shell });
}

/** Where the sheet sits on screen — the shell's root, which carries its scale and offset. */
function sheetAt(s: Screens) {
  const root = (s as unknown as { shell: { root: { position: { x: number; y: number }; scale: { x: number } } } }).shell.root;
  return { x: root.position.x, y: root.position.y, k: root.scale.x };
}

function emitTap(view: { emit: (event: string) => void }) {
  view.emit('pointertap');
}

afterEach(() => {
  resetLocaleForTests();
  badge.tex = undefined;
});

describe('Screens — show()', () => {
  it('centers its sheet on the given viewport size and becomes visible', () => {
    const s = new Screens();
    s.show(800, 600, true, 'EXTRACTED', ['line one']);
    const p = privateOf(s);
    expect(s.view.visible).toBe(true);
    expect(p.title.text).toBe('EXTRACTED');
    const at = sheetAt(s);
    // Centred horizontally: the gap on the left is the gap on the right.
    expect(at.x).toBeCloseTo((800 - 440 * at.k) / 2);
  });
});

describe('Screens — resize()', () => {
  it('re-lays the sheet out on a new viewport size while visible', () => {
    const s = new Screens();
    s.show(800, 600, true, 'EXTRACTED', ['line one']);
    s.resize(400, 300);
    const at = sheetAt(s);
    // Scaled down to fit the smaller window, and re-centred in it — not left at the old size.
    expect(at.x).toBeCloseTo((400 - 440 * at.k) / 2);
    expect(at.x + 440 * at.k).toBeLessThanOrEqual(400);
  });

  it('keeps CONFIRM across the sheet at the bottom, below the stat lines', () => {
    const s = new Screens();
    s.show(800, 600, true, 'EXTRACTED', ['line one', 'line two']);
    const p = privateOf(s);
    expect(p.confirmBtn.view.position.x).toBe(0);
    expect(p.confirmBtn.width).toBe(440 - 48);
    expect(p.confirmBtn.view.position.y).toBeGreaterThan(p.sub.position.y);
  });

  it('is a no-op before the screen has ever been shown', () => {
    const s = new Screens();
    const before = { ...sheetAt(s) };
    s.resize(1000, 1000);
    expect(s.view.visible).toBe(false);
    expect(sheetAt(s)).toEqual(before);
  });

  it('is a no-op after hide() — a resize while some other screen is up must not move this one', () => {
    const s = new Screens();
    s.show(800, 600, true, 'EXTRACTED', ['line one']);
    s.hide();
    const before = { ...sheetAt(s) };
    s.resize(200, 200);
    expect(s.view.visible).toBe(false);
    expect(sheetAt(s)).toEqual(before);
  });
});

describe('Screens — won flag (design/17-i18n.md)', () => {
  it('title/lines are shown verbatim regardless of `won` — the caller supplies the copy', () => {
    const s = new Screens();
    s.show(800, 600, false, '战败', ['line one']);
    expect(privateOf(s).title.text).toBe('战败');
  });

  it('tints the title for a win and for a loss — the one thing `won` decides here', () => {
    const s = new Screens();
    s.show(800, 600, true, 'EXTRACTED', ['a']);
    const win = privateOf(s).title.style.fill;
    s.show(800, 600, false, 'DEFEAT', ['a']);
    expect(privateOf(s).title.style.fill).not.toEqual(win);
  });
});

describe('Screens — confirm is a real button, not tap-anywhere (2026-08-17)', () => {
  it('a pointerdown anywhere on the panel does nothing — no full-panel handler left', () => {
    const s = new Screens();
    s.show(800, 600, false, 'DEFEAT', ['line one']);
    let confirmed = false;
    s.onConfirm = () => { confirmed = true; };
    emitTap(s.view as unknown as { emit: (event: string) => void }); // 'pointertap' on the root view itself
    (s.view as unknown as { emit: (event: string) => void }).emit('pointerdown');
    expect(confirmed).toBe(false);
  });

  it('tapping confirmBtn calls onConfirm exactly once per tap', () => {
    const s = new Screens();
    s.show(800, 600, false, 'DEFEAT', ['line one']);
    let calls = 0;
    s.onConfirm = () => { calls += 1; };
    emitTap(privateOf(s).confirmBtn.view);
    expect(calls).toBe(1);
  });

  it('tapping menuBtn calls onMenu, not onConfirm', () => {
    const s = new Screens();
    s.show(800, 600, false, 'DEFEAT', ['line one']);
    let confirmed = false;
    let wentToMenu = false;
    s.onConfirm = () => { confirmed = true; };
    s.onMenu = () => { wentToMenu = true; };
    emitTap(privateOf(s).menuBtn.view);
    expect(wentToMenu).toBe(true);
    expect(confirmed).toBe(false);
  });
});

describe('Screens — i18n (design/17-i18n.md)', () => {
  it('retexts CONFIRM and MAIN MENU on show() under zh', async () => {
    const s = new Screens();
    await useLocale('zh');
    s.show(800, 600, true, 'EXTRACTED', ['line one']);
    expect(privateOf(s).menuBtn.label.text).toBe('主菜单');
    expect(privateOf(s).confirmBtn.label.text).not.toBe('CONFIRM');
  });

  it('switching back to English on a later show() fully reverts', async () => {
    const s = new Screens();
    await useLocale('zh');
    s.show(800, 600, true, 'EXTRACTED', ['line one']);
    setLocale('en');
    s.show(800, 600, true, 'EXTRACTED', ['line one']);
    expect(privateOf(s).menuBtn.label.text).toBe('MAIN MENU');
    expect(privateOf(s).confirmBtn.label.text).toBe('CONFIRM');
  });
});

// ---------------------------------------------------------------------------------------
// The optional offer row (`ResultOffer`) — today the rewarded-ad materials bonus, built by
// RunOutcome.ts. This screen's half of it is three promises: the button only exists when
// there is an offer, it is ONE-SHOT, and it leaves the screen before the numbers change.
// ---------------------------------------------------------------------------------------
describe('Screens — the optional offer button', () => {
  /** An offer whose claim is resolved by the test, so the in-flight window is observable
   *  rather than something that has already closed by the time an assertion runs. */
  function deferredOffer(label = 'WATCH AD') {
    let calls = 0;
    let release: (lines: readonly string[]) => void = () => {};
    let fail: (e: Error) => void = () => {};
    const offer: ResultOffer = {
      label,
      claim: () => {
        calls += 1;
        return new Promise<readonly string[]>((resolve, reject) => { release = resolve; fail = reject; });
      },
    };
    return { offer, calls: () => calls, release: (l: readonly string[]) => release(l), fail: (e: Error) => fail(e) };
  }

  it('is hidden when show() is handed no offer — every build without a rewarded ad', () => {
    const s = new Screens();
    s.show(800, 600, true, 'EXTRACTED', ['a', 'b']);
    expect(privateOf(s).offerBtn.view.visible).toBe(false);
  });

  it('appears with the offer’s own label, and pushes CONFIRM down a row', () => {
    const bare = new Screens();
    bare.show(800, 600, true, 'EXTRACTED', ['a']);
    const bareConfirmY = privateOf(bare).confirmBtn.view.position.y;
    const bareMenu = { x: privateOf(bare).menuBtn.view.position.x, y: privateOf(bare).menuBtn.view.position.y };

    const s = new Screens();
    const { offer } = deferredOffer('WATCH AD: MATERIALS x2');
    s.show(800, 600, true, 'EXTRACTED', ['a'], offer);
    const p = privateOf(s);

    expect(p.offerBtn.view.visible).toBe(true);
    expect(p.offerBtn.label.text).toBe('WATCH AD: MATERIALS x2');
    // The offer sits above CONFIRM, and CONFIRM moves down by the row it takes — the
    // numbers matter less than the invariant that nothing lands on top of anything.
    // MAIN MENU is the corner chip now, which no row pushes anywhere.
    expect(p.offerBtn.view.position.y).toBeLessThan(p.confirmBtn.view.position.y);
    expect(p.confirmBtn.view.position.y - bareConfirmY).toBe(54);
    expect(p.offerBtn.view.position.y + 40).toBeLessThanOrEqual(p.confirmBtn.view.position.y);
    expect({ x: p.menuBtn.view.position.x, y: p.menuBtn.view.position.y }).toEqual(bareMenu);
  });

  it('a tap runs the claim, then swaps in its lines and retires the button', async () => {
    const s = new Screens();
    const d = deferredOffer();
    s.show(800, 600, true, 'EXTRACTED', ['floor', 'Materials banked: 4', 'time']);
    s.show(800, 600, true, 'EXTRACTED', ['floor', 'Materials banked: 4', 'time'], d.offer);

    emitTap(privateOf(s).offerBtn.view);
    expect(d.calls()).toBe(1);
    // Still on screen while the ad is up: the button is retired by the RESULT, not by the
    // tap, so a claim that never settles cannot silently drop the offer.
    expect(privateOf(s).offerBtn.view.visible).toBe(true);

    d.release(['floor', 'Materials banked: 8 (ad bonus x2)', 'time']);
    await Promise.resolve();
    await Promise.resolve();

    expect(privateOf(s).offerBtn.view.visible).toBe(false);
    expect((s as unknown as { sub: { text: string } }).sub.text)
      .toBe('floor\nMaterials banked: 8 (ad bonus x2)\ntime');
    // ...and the exits move back up, closing the row the button occupied.
    const bare = new Screens();
    bare.show(800, 600, true, 'EXTRACTED', ['floor', 'Materials banked: 8 (ad bonus x2)', 'time']);
    expect(privateOf(s).confirmBtn.view.position.y).toBe(privateOf(bare).confirmBtn.view.position.y);
  });

  it('is one-shot: a second tap while the first claim is in flight does not re-run it', () => {
    const s = new Screens();
    const d = deferredOffer();
    s.show(800, 600, true, 'EXTRACTED', ['a'], d.offer);

    emitTap(privateOf(s).offerBtn.view);
    emitTap(privateOf(s).offerBtn.view);
    emitTap(privateOf(s).offerBtn.view);

    expect(d.calls()).toBe(1);
  });

  it('is one-shot after it settles too — the reward cannot be taken twice', async () => {
    const s = new Screens();
    const d = deferredOffer();
    s.show(800, 600, true, 'EXTRACTED', ['a'], d.offer);

    emitTap(privateOf(s).offerBtn.view);
    d.release(['b']);
    await Promise.resolve();
    await Promise.resolve();
    emitTap(privateOf(s).offerBtn.view);

    expect(d.calls()).toBe(1);
  });

  it('a claim that REJECTS retires the button and leaves the lines alone', async () => {
    const s = new Screens();
    const d = deferredOffer();
    s.show(800, 600, true, 'EXTRACTED', ['floor', 'Materials banked: 4'], d.offer);

    emitTap(privateOf(s).offerBtn.view);
    d.fail(new Error('ad layer blew up'));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(privateOf(s).offerBtn.view.visible).toBe(false);
    expect((s as unknown as { sub: { text: string } }).sub.text).toBe('floor\nMaterials banked: 4');
  });

  it('a later show() with no offer clears the previous one — screens are reused', () => {
    const s = new Screens();
    const d = deferredOffer();
    s.show(800, 600, true, 'EXTRACTED', ['a'], d.offer);
    s.show(800, 600, false, 'DEFEAT', ['b']);

    expect(privateOf(s).offerBtn.view.visible).toBe(false);
    emitTap(privateOf(s).offerBtn.view);
    expect(d.calls()).toBe(0);
  });
});

describe('Screens — the rows that can be absent (design/10 "One shell for every menu")', () => {
  const LINES = ['Floor reached: 7', 'Materials banked: 12', 'Blueprints found: 2', 'Time: 08:41', 'Score: 4,210'];
  const boxTop = (s: Screens) => (s as unknown as { sub: { position: { y: number } } }).sub.position.y;

  it('puts the badge at the top of the sheet once its art has loaded, and moves the stats under it', () => {
    const bare = new Screens();
    bare.show(800, 600, true, 'EXTRACTED', LINES);
    expect(privateOf(bare).resultIcon.visible).toBe(false);

    badge.tex = Texture.WHITE;
    const s = new Screens();
    s.show(800, 600, true, 'EXTRACTED', LINES);
    const icon = (s as unknown as { resultIcon: { visible: boolean; position: { y: number }; height: number } }).resultIcon;
    expect(icon.visible).toBe(true);
    expect(icon.position.y).toBe(0);
    expect(icon.height).toBe(64); // scaled to the badge size, whatever the art's own size
    // The stats move down by the badge and its gap, and no further — control: without the
    // art they sit at the top, so the difference is the badge row and not a constant offset.
    expect(boxTop(s) - boxTop(bare)).toBe(64 + 14);
  });

  it('closes the badge row up again on a later show() without the art', () => {
    badge.tex = Texture.WHITE;
    const s = new Screens();
    s.show(800, 600, true, 'EXTRACTED', LINES);
    const withBadge = boxTop(s);
    badge.tex = undefined;
    s.show(800, 600, false, 'DEFEAT', LINES);
    expect(privateOf(s).resultIcon.visible).toBe(false);
    expect(boxTop(s)).toBe(withBadge - 64 - 14);
  });

  it('fits its tallest form — badge, five stat lines, the offer — on a phone held sideways', () => {
    // The sheet's height is summed by hand from its rows; a row left out of that sum would
    // push CONFIRM off the bottom of a short screen while every desktop check still passed.
    badge.tex = Texture.WHITE;
    const s = new Screens();
    s.show(844, 390, true, 'EXTRACTED', LINES, { label: 'WATCH AD: DOUBLE MATERIALS', claim: async () => [] });
    const confirm = (s as unknown as { confirmBtn: { view: { getBounds(): { minY: number; maxY: number } } } }).confirmBtn.view.getBounds();
    const offer = (s as unknown as { offerBtn: { view: { getBounds(): { maxY: number } } } }).offerBtn.view.getBounds();
    expect(confirm.maxY).toBeLessThanOrEqual(390);
    expect(offer.maxY).toBeLessThanOrEqual(confirm.minY);
    const at = sheetAt(s);
    expect(at.y + privateOf(s).shell.sheet.height * at.k).toBeLessThanOrEqual(390);
  });

  it('an offer that settles after the screen was left does not lay it out again', async () => {
    // The claim settles from an ad callback, whenever the ad closes — possibly after the player
    // has already left. Re-running the layout then would draw a hidden screen against a
    // viewport it no longer owns.
    let settle: (lines: readonly string[]) => void = () => {};
    const s = new Screens();
    s.show(800, 600, true, 'EXTRACTED', LINES, { label: 'WATCH AD', claim: () => new Promise((r) => { settle = r; }) });
    const before = sheetAt(s);
    const pending = s.claim();
    s.hide();
    settle(['Materials banked: 24']);
    await pending;
    expect(s.view.visible).toBe(false);
    expect(privateOf(s).offerBtn.view.visible).toBe(false); // the offer is still spent
    expect(sheetAt(s)).toEqual(before);
    // Control: the same settle while the screen is up DOES re-lay it out (the sheet shrinks by
    // the offer row, so it moves).
    let settle2: (lines: readonly string[]) => void = () => {};
    s.show(800, 600, true, 'EXTRACTED', LINES, { label: 'WATCH AD', claim: () => new Promise((r) => { settle2 = r; }) });
    const shown = sheetAt(s);
    const p2 = s.claim();
    settle2(['Materials banked: 24']);
    await p2;
    expect(sheetAt(s).y).not.toBe(shown.y);
  });
});
