/**
 * Do any two TAP TARGETS on a screen occupy the same pixels?
 *
 * ## The hole this fills, and why the two sweeps next door could not
 *
 * `viewportFit.test.ts` asks whether anything lands outside the design space, and its own
 * header says to read it as *"nothing is off screen, never as nothing collides"*.
 * `labelFit.test.ts` closed one kind of collision — a label spilling out of its own button —
 * after that distinction cost a shipped defect in the lobby. Neither asks the other question
 * the same sentence implies: whether two *buttons* are drawn on top of each other.
 *
 * That gap cost a defect on 2026-09-21, the day the Loadout screen was split out of the
 * Forge. `CLEAR LOADOUT` was aligned to the left edge of the weapon row — `cx - 212` — and
 * `START RUN` starts at `cx - 110`, so a 160px-wide button was drawn 58px underneath the
 * primary action of the screen. Every case in both files above stayed green, correctly: the
 * button was comfortably inside the design space, and its label was comfortably inside its
 * own box. It was found by looking at a screenshot, which is not a gate.
 *
 * ## What it measures, and why that metric
 *
 * The BOX, not the view: each widget's child 0 is its background `Graphics`, which is the
 * shape a press actually lands on (`widgets.ts` — "the label is decoration: the box is what
 * the press lands on", and the label is `eventMode: 'none'` for exactly that reason). Taking
 * bounds off the whole view would fold in the label, whose glyph metrics here are
 * `fakeTextCanvas`'s approximation rather than the real font — so this file needs no text
 * measurement at all and its numbers are the same in every environment.
 *
 * Two things it deliberately does NOT claim:
 *
 *  - **Not a "nothing touches anything" rule.** Adjacency is fine and common (the lobby's
 *    rows sit 5px apart). Only a genuine intersection of two press targets fails.
 *  - **Not a proof for a widget that is hidden.** A screen draws different sets of controls
 *    in different states, so the builders below name the states where the most controls are
 *    on screen at once — the same "sweep the TALLEST variant" rule `viewportFit` follows,
 *    for the same reason.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { Container, Texture } from 'pixi.js';
import { installFakeTextCanvas } from './fakeTextCanvas';
import { MENU_DESIGN_W, MENU_DESIGN_H } from '../ui/menuLayer';
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
import { StorePurchase } from '../controllers/StorePurchase';
import type { StoreSku } from '../../net/billing';
import { defaultMetaState } from '../../meta';
import { defaultSettingsState } from '../../settings';
import { LOCALES, resetLocaleForTests } from '../../i18n';
import { useLocale } from '../../i18n/loadLocale';

// Same reasoning as `labelFit.test.ts`: `getUiTexture` answers `undefined` with nothing
// loaded, and an `autoWidth` button's box is `estimateMonoWidth(...) + 28 + iconLane()`, so
// without an icon every such box measures NARROWER here than it ships. A sweep that measures
// narrower boxes is a sweep that misses the overlap it exists to find.
vi.mock('../../render/uiSkins', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../render/uiSkins')>()),
  getUiTexture: () => Texture.WHITE,
}));

installFakeTextCanvas();

afterEach(() => resetLocaleForTests());

/** A widget that is a press target: it owns a `view` and an `onTap` slot. Catches `Button`
 *  and `BlueprintCard` alike, which is the point — the Loadout screen's weapon row is cards
 *  and its action bar is buttons, and they are laid out against each other. */
interface Tappable {
  view: Container & { visible: boolean; children: unknown[] };
}

function isTappable(v: unknown): v is Tappable {
  const o = v as { onTap?: unknown; view?: { children?: unknown; visible?: unknown } };
  return !!o && typeof o === 'object' && 'onTap' in o
    && !!o.view && Array.isArray(o.view.children) && typeof o.view.visible === 'boolean';
}

/**
 * Every press target a screen owns, including those it owns through a composed widget
 * (`MainMenu` → `LobbyRoutes`) or an array (the Forge's blueprint cards, the store's rows).
 *
 * Reflection over instance fields rather than a walk of the display tree, for the reason
 * `labelFit.test.ts` records: a tree walk has to GUESS what a button looks like, and "a
 * Graphics plus a Text" also describes a stat chip and a prompt.
 */
function tappablesOf(screen: object, depth = 2, path = ''): Array<[string, Tappable]> {
  const found: Array<[string, Tappable]> = [];
  for (const [key, value] of Object.entries(screen)) {
    const name = path ? `${path}.${key}` : key;
    if (isTappable(value)) {
      found.push([name, value]);
      continue;
    }
    if (Array.isArray(value)) {
      value.forEach((v, i) => {
        if (isTappable(v)) found.push([`${name}[${i}]`, v]);
        else if (depth > 0 && v && typeof v === 'object') found.push(...tappablesOf(v, depth - 1, `${name}[${i}]`));
      });
      continue;
    }
    // A composed widget (it has its own `view`) — but not a Pixi node, whose `children` walk
    // would take us into the display tree this function deliberately does not use.
    if (depth > 0 && value && typeof value === 'object' && 'view' in value && !('parent' in value)) {
      found.push(...tappablesOf(value, depth - 1, name));
    }
  }
  return found;
}

interface Rect { x: number; y: number; w: number; h: number }

/** The PRESS box of a widget: its background `Graphics` (child 0), in screen space. */
function boxOf(t: Tappable): Rect {
  const bg = t.view.children[0] as Container;
  const b = bg.getBounds();
  return { x: b.minX, y: b.minY, w: b.maxX - b.minX, h: b.maxY - b.minY };
}

/** Strict intersection. Touching edges is not an overlap — adjacent rows are the norm. */
function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w - SLACK && a.x + a.w - SLACK > b.x
    && a.y < b.y + b.h - SLACK && a.y + a.h - SLACK > b.y;
}

/** Sub-pixel noise, not a layout budget — the same value the sweeps next door use. */
const SLACK = 1;

/** Every overlapping PAIR on a screen, as readable strings. */
function overlapsOn(screen: object): string[] {
  const shown = tappablesOf(screen)
    .filter(([, t]) => t.view.visible)
    .map(([name, t]) => ({ name, box: boxOf(t) }))
    // A widget that has not been laid out yet (or draws nothing) has a zero-area box and
    // cannot meaningfully collide with anything.
    .filter((e) => e.box.w > 0 && e.box.h > 0);
  const hits: string[] = [];
  for (let i = 0; i < shown.length; i++) {
    for (let j = i + 1; j < shown.length; j++) {
      const a = shown[i]!;
      const b = shown[j]!;
      if (!intersects(a.box, b.box)) continue;
      hits.push(`${a.name} (${a.box.x.toFixed(0)},${a.box.y.toFixed(0)} ${a.box.w.toFixed(0)}x${a.box.h.toFixed(0)})`
        + ` overlaps ${b.name} (${b.box.x.toFixed(0)},${b.box.y.toFixed(0)} ${b.box.w.toFixed(0)}x${b.box.h.toFixed(0)})`);
    }
  }
  return hits;
}

const STORE_SKUS: StoreSku[] = [
  { sku: 'bp.cryobolt', title: 'Blueprint — Cryobolt', amountCents: 1200, currency: 'CNY', grants: [{ kind: 'blueprint', id: 'cryobolt' }] },
  { sku: 'bp.cannon', title: 'Blueprint — Cannon', amountCents: 1800, currency: 'CNY', grants: [{ kind: 'blueprint', id: 'cannon' }] },
];

function storeScreen(): StoreScreen {
  return new StoreScreen(new StorePurchase({
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
}

const SAVED = { floorIndex: 2, ticks: 9000, savedAtMs: 0 };

/** Build a screen and lay it out at the design size. Returns the INSTANCE, not its view. */
type Build = (w: number, h: number) => object | Promise<object>;

const SCREENS: Array<[string, Build]> = [
  // The two hub screens, in the states that put the most controls on screen at once: the
  // Forge with a store entry, the Loadout screen with a saved run (a two-row action bar,
  // i.e. START RUN moved 52px UP toward the weapon cards) AND a forged loadout.
  ['Forge', (w, h) => { const s = new Forge(); s.storeEnabled = true; s.render(defaultMetaState(), w, h); return s; }],
  ['Loadout', (w, h) => { const s = new Loadout(); s.render(defaultMetaState(), w, h); return s; }],
  ['Loadout (saved run + forged loadout)', (w, h) => {
    const s = new Loadout();
    s.savedRun = () => SAVED;
    s.render({ ...defaultMetaState(), loadout: ['repeater', 'emberblade'] }, w, h);
    return s;
  }],
  ['MainMenu', (w, h) => { const s = new MainMenu(); s.show(w, h); return s; }],
  // The portal shape adds a row (quick-play PLAY) and drops one (ACCOUNT); the saved-run
  // shape adds CONTINUE above SOLO. Both change which rows are adjacent to which.
  ['MainMenu (portal)', (w, h) => {
    const s = new MainMenu();
    s.setQuickPlay(true);
    s.setAccountEntry(false);
    s.show(w, h);
    return s;
  }],
  ['MainMenu (saved run)', (w, h) => {
    const s = new MainMenu();
    s.resumableRun = () => SAVED;
    s.show(w, h);
    return s;
  }],
  ['PvpPreview', (w, h) => { const s = new PvpPreview(); s.show(w, h, defaultMetaState().selectedSkin); return s; }],
  ['Screens', (w, h) => { const s = new Screens(); s.show(w, h, true, 'VICTORY', ['line one']); return s; }],
  // The offer adds a row between the stats and CONFIRM and pushes both exits down — the one
  // state on this screen where three buttons are stacked.
  ['Screens + ad offer', (w, h) => {
    const s = new Screens();
    s.show(w, h, true, 'EXTRACTED', ['line one'], { label: 'СМОТРЕТЬ РЕКЛАМУ: МАТЕРИАЛЫ x2', claim: async () => [] });
    return s;
  }],
  ['Settings', (w, h) => { const s = new Settings(); s.show(w, h, defaultSettingsState()); return s; }],
  ['PauseMenu', (w, h) => { const s = new PauseMenu(); s.show(w, h); return s; }],
  // The pause menu with SAVE & QUIT, which is a fourth row rather than a relabelled one
  // (design/05: the two exits are separate verbs precisely so neither can be pressed by
  // accident, which is a claim about where they are as much as about what they do).
  ['PauseMenu (savable run)', (w, h) => { const s = new PauseMenu(); s.show(w, h, undefined, true); return s; }],
  ['PartyScreen', (w, h) => { const s = new PartyScreen({ matchBaseUrl: '' }); s.show(w, h); return s; }],
  ['LoginScreen', (w, h) => { const s = new LoginScreen({ matchBaseUrl: '' }); s.show(w, h); return s; }],
  ['Matchmaking (connecting)', (w, h) => {
    const s = new Matchmaking();
    s.show(w, h, () => new Promise<never>(() => {}));
    return s;
  }],
  ['Matchmaking (error)', async (w, h) => {
    // The two-button state: Retry and Cancel side by side, which is the only place on this
    // screen where two press targets share a row.
    const s = new Matchmaking();
    s.show(w, h, () => Promise.reject(new Error('matchmaking failed')));
    await new Promise((r) => setTimeout(r, 0));
    s.resize(w, h);
    return s;
  }],
  ['StoreScreen', async (w, h) => {
    const s = storeScreen();
    s.show(w, h, defaultMetaState());
    await vi.waitFor(() => expect((s as unknown as { rows: Tappable[] }).rows[0]!.view.visible).toBe(true));
    return s;
  }],
];

describe('no two press targets are drawn on top of each other', () => {
  for (const locale of LOCALES) {
    it.each(SCREENS)(`${locale} — %s`, async (name, build) => {
      await useLocale(locale);
      const screen = await build(MENU_DESIGN_W, MENU_DESIGN_H);
      // A screen whose widgets could not be found would pass this test perfectly.
      const found = tappablesOf(screen).filter(([, t]) => t.view.visible);
      expect(found.length, `${name}: no visible press targets found — the reflection missed them`)
        .toBeGreaterThan(0);
      // Collected, not asserted one at a time: `expect` throws on the first failure, so a
      // per-pair assertion reports ONE overlap per screen and hides the rest behind it.
      expect(overlapsOn(screen), `${locale} ${name}: press targets sharing pixels`).toEqual([]);
    });
  }
});

describe('the sweep can actually fail', () => {
  // Every assertion above is a passing `[]`, which proves nothing unless a real overlap is
  // reachable. Rather than re-stating the 2026-09-21 geometry (deleted code cannot regress),
  // this moves a live button onto its neighbour and asserts the detector says so.
  it('reports a button moved on top of another one', () => {
    const s = new Loadout();
    s.render(defaultMetaState(), MENU_DESIGN_W, MENU_DESIGN_H);
    expect(overlapsOn(s)).toEqual([]);

    const p = s as unknown as { clearBtn: Tappable; startBtn: Tappable };
    p.clearBtn.view.position.set(p.startBtn.view.x + 4, p.startBtn.view.y);
    const hits = overlapsOn(s);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain('clearBtn');
    expect(hits[0]).toContain('startBtn');
  });

  it('does NOT report two rows that merely sit next to each other', () => {
    // The other half of the harness: a rule that fires on adjacency would flag every stacked
    // control in the project and would be turned off within a week. The lobby's rows are 5px
    // apart, so this is the real spacing rather than a contrived one.
    const m = new MainMenu();
    m.show(MENU_DESIGN_W, MENU_DESIGN_H);
    const routes = (m as unknown as { routes: Record<string, Tappable> }).routes;
    const solo = boxOf(routes.soloBtn!);
    const coop = boxOf(routes.coopBtn!);
    expect(coop.y - (solo.y + solo.h), 'the rows really are adjacent').toBeLessThanOrEqual(6);
    expect(overlapsOn(m)).toEqual([]);
  });

  it('measures the BOX, not the label — a wide label never counts as an overlap', () => {
    // Why child 0 rather than `view.getBounds()`: the label is `eventMode: 'none'` and can
    // legitimately be wider than its own box (that is `labelFit.test.ts`'s question, and a
    // different defect). Folding it in here would make the two files disagree about what a
    // button IS, and this one would start failing for a reason it cannot describe.
    const s = new Loadout();
    s.render(defaultMetaState(), MENU_DESIGN_W, MENU_DESIGN_H);
    const p = s as unknown as { clearBtn: { view: Container; label: { text: string } } };
    p.clearBtn.label.text = 'X'.repeat(200);
    expect(overlapsOn(s)).toEqual([]);
  });
});
