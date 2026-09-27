/**
 * Forge — the CRAFTING page. Pixi Container/Text/Graphics construct and mutate fine under
 * plain vitest with no renderer attached (same finding Screens.test.ts/PartyScreen.test.ts
 * made) — asserted here via `.position`/`.visible`/`.text`, not pixel output.
 *
 * Two real layout bugs, both reported live as "the screen is a mess": the buyable-
 * blueprint list had no length bound and could run off both edges of the screen as one
 * line, and the bottom action bar was positioned by flowing down from the row list +
 * compare card and only *clamped* to fit once it overflowed — which left it floating on
 * top of the still-there row list instead of below it.
 *
 * That action bar lives on `Loadout.ts` since the 2026-09-21 split, and so do the cases
 * that were about it (the character line, START RUN / CLEAR / CONTINUE). What is left here
 * is the grid, the store entry, the compare card and the hint line this screen still owns.
 *
 * Since the menu shell (2026-09-27) all of it sits in one sheet the shell scales to fit, so
 * the old "pinned to `h`, give way on a short viewport" cases became "placed in the sheet, the
 * same at every viewport" ones — plus the two layouts (`forgeSheet.ts`): the side panel beside
 * the grid where the wide sheet fits, under it where it does not.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { Forge } from './Forge';
import { GRID_W, NARROW_SHEET_W, WIDE_SHEET_W, forgeIsWide, layoutForgeSheet, type ForgeSheetParts } from './forgeSheet';
import { installFakeTextCanvas } from './fakeTextCanvas';
import { BlueprintCard } from '../ui/BlueprintCard';
import { defaultMetaState, acquireBlueprint, purchasableBlueprints } from '../../meta';
import type { MetaState } from '../../meta';
import { setLocale, resetLocaleForTests } from '../../i18n';
import { useLocale } from '../../i18n/loadLocale';

// `Button.label` is private on the real class — same escape hatch every other screen
// test here uses (MainMenu.test.ts/PauseMenu.test.ts/Settings.test.ts) to read it anyway.
interface TestButton {
  view: { visible: boolean; position: { x: number; y: number } };
  label: { text: string };
  width: number;
  onTap: (() => void) | null;
}

// `BlueprintCard`'s own text fields are private too; it exposes the same kind of
// read-only test getters (`nameLabel`/`costLabel`/`statusLabel`/…) as `WeaponCard`'s.
interface TestCard {
  view: { visible: boolean; position: { x: number; y: number } };
  nameLabel: string;
  costLabel: string;
  statusLabel: string;
  keyLabel: string;
  stagedLabel: string;
}

// Forge.render() flows its layout off `Text.height`, which needs a canvas 2D context this
// environment has no real implementation of — see fakeTextCanvas.ts for the seam and why
// approximate glyph metrics are fine for every assertion below.
installFakeTextCanvas();

type Pos = { position: { x: number; y: number } };

/** The screen's widgets, plus the title the menu shell owns. */
function privateOf(f: Forge) {
  const shell = (f as unknown as { shell: { sheet: { title: { text: string } }; backBtn: TestButton } }).shell;
  const self = f as unknown as {
    bank: { heading: { text: string }; cells: Array<{ name: { text: string }; count: { text: string } }> };
    carryingHeading: { text: string };
    carryingText: { text: string } & Pos;
    storeCaption: { text: string; visible: boolean; style: { wordWrap: boolean; breakWords: boolean } } & Pos;
    rowCards: TestCard[];
    storeBtn: TestButton;
    prevPageBtn: TestButton;
    nextPageBtn: TestButton;
    hint: { text: string } & Pos;
    compareCard: {
      view: { visible: boolean; position: { x: number; y: number }; height: number };
      leftName: { text: string };
      rightName: { text: string };
    };
    parts(): ForgeSheetParts;
  };
  return Object.assign(Object.create(self) as typeof self, { title: shell.sheet.title, backBtn: shell.backBtn });
}

afterEach(() => resetLocaleForTests());

/** One page's worth of browse steps: enough to flip the grid to page 2. */
const PAGE_FLIP = 8;

// Buys down the shelf to `max` or fewer remaining purchasable blueprints (defaultMetaState
// starts with 17 — see forge.test.ts's own purchasableBlueprints assertion).
function withFewBuyable(max: number): MetaState {
  let m = defaultMetaState();
  while (purchasableBlueprints(m).length > max) {
    m = acquireBlueprint(m, purchasableBlueprints(m)[0]!);
  }
  return m;
}

/** `storeEnabled` is what the assembly sets from `platform/storePlatform.ts`. */
function sellingForge(): Forge {
  const f = new Forge();
  f.storeEnabled = true;
  return f;
}

describe('Forge — the store caption\'s buyable-list bound', () => {
  it('collapses a long shelf to a bare count instead of joining every name', () => {
    const f = sellingForge();
    const m = defaultMetaState();
    expect(purchasableBlueprints(m).length).toBeGreaterThan(3); // the case that used to overflow
    f.render(m, 1280, 720);
    const text = privateOf(f).storeCaption.text;
    expect(text).toContain(`${purchasableBlueprints(m).length} more available`);
    // Only the count — a regression here would mean the old unbounded join is back.
    expect(text).not.toContain(',');
  });

  it('still lists names when the shelf is short enough to matter — the weapons\' names, not ids', () => {
    const f = sellingForge();
    const m = withFewBuyable(2);
    const shelf = purchasableBlueprints(m);
    expect(shelf.length).toBeGreaterThan(0);
    expect(shelf.length).toBeLessThanOrEqual(3);
    f.render(m, 1280, 720);
    const text = privateOf(f).storeCaption.text;
    expect(text).toMatch(/^For sale: /);
    expect(text).not.toContain('more available');
    // The line used to join the raw catalogue ids (`cryobolt`), which are asset keys.
    for (const id of shelf) expect(text).not.toMatch(new RegExp(`\\b${id}\\b`));
    expect(text.split(', ')).toHaveLength(shelf.length);
  });

  it('goes with the button: gone once nothing is left to buy, and gone where this build may not sell', () => {
    const empty = sellingForge();
    empty.render(withFewBuyable(0), 1280, 720);
    expect(privateOf(empty).storeCaption.visible).toBe(false);

    // The old info line kept saying "Store: … [B] open the store" on a build with no store.
    const barred = new Forge();
    barred.render(withFewBuyable(2), 1280, 720);
    expect(privateOf(barred).storeCaption.visible).toBe(false);
  });

  it('wraps AND force-breaks unbroken runs (CJK locales have no spaces to wrap at, design/17-i18n.md)', () => {
    const style = privateOf(new Forge()).storeCaption.style;
    expect(style.wordWrap).toBe(true);
    expect(style.breakWords).toBe(true);
  });
});

describe('Forge — what the run carries', () => {
  it('names the default pair when nothing is forged, and counts 0 of the slots', () => {
    const f = new Forge();
    f.render(defaultMetaState(), 1280, 720);
    const p = privateOf(f);
    expect(p.carryingText.text).toBe('(none → Blaster + Saber)');
    expect(p.carryingHeading.text).toContain('0/2');
  });

  it('names forged weapons by their translated names', () => {
    const f = new Forge();
    f.render({ ...defaultMetaState(), loadout: ['repeater'] }, 1280, 720);
    const p = privateOf(f);
    expect(p.carryingText.text).toBe('Repeater');
    expect(p.carryingHeading.text).toContain('1/2');
  });

  it('falls back to the id for a loadout entry the catalogue no longer knows', () => {
    const f = new Forge();
    f.render({ ...defaultMetaState(), loadout: ['not-a-weapon'] }, 1280, 720);
    expect(privateOf(f).carryingText.text).toBe('not-a-weapon');
  });
});

describe('Forge — store button (design/19 §4; was ACQUIRE, the `demo: free grant` scaffold)', () => {
  it('is visible when this build may sell AND there is something purchasable', () => {
    const f = sellingForge();
    const m = withFewBuyable(2);
    expect(purchasableBlueprints(m).length).toBeGreaterThan(0);
    f.render(m, 1280, 720);
    expect(privateOf(f).storeBtn.view.visible).toBe(true);
  });

  it('DOES NOT EXIST on a platform that may not sell — even with a full shelf', () => {
    // The hard one (`platform/storePlatform.ts`): a web checkout inside an iOS store build
    // breaks App Store rule 3.1.1, and a reviewer finding the button is the whole failure
    // mode. Default-false is deliberate — a caller that forgets to set the flag shows no
    // store, which is the fail-closed direction.
    const f = new Forge(); // storeEnabled left at its default
    const m = withFewBuyable(2);
    expect(purchasableBlueprints(m).length).toBeGreaterThan(0); // there IS something to sell
    f.render(m, 1280, 720);
    expect(privateOf(f).storeBtn.view.visible).toBe(false);
  });

  it('is hidden once nothing is left to buy — same condition its caption uses', () => {
    const f = sellingForge();
    const m = withFewBuyable(0);
    f.render(m, 1280, 720);
    expect(privateOf(f).storeBtn.view.visible).toBe(false);
  });

  it('tapping it fires onStore — the same verb the KeyB shortcut runs, and it grants nothing', () => {
    const f = sellingForge();
    let fired = 0;
    f.onStore = () => { fired++; };
    const m = withFewBuyable(2);
    f.render(m, 1280, 720);
    (f as unknown as { storeBtn: { onTap: (() => void) | null } }).storeBtn.onTap?.();
    expect(fired).toBe(1);
    // The press opened a screen; it did not hand anything over. Before this pass the same
    // button unlocked a blueprint on the spot.
    expect(purchasableBlueprints(m)).toEqual(purchasableBlueprints(withFewBuyable(2)));
  });

  it('stands clear of the grid in both layouts: beside it when wide, under it when narrow', () => {
    const wide = sellingForge();
    wide.render(withFewBuyable(2), 1280, 720);
    expect(privateOf(wide).storeBtn.view.position.x).toBeGreaterThan(GRID_W);

    const narrow = sellingForge();
    narrow.render(withFewBuyable(2), 760, 1600);
    const p = privateOf(narrow);
    const gridBottom = p.rowCards[7]!.view.position.y + BlueprintCard.H;
    expect(p.storeBtn.view.position.y).toBeGreaterThan(gridBottom);
    expect(p.storeBtn.view.position.x + p.storeBtn.width).toBeCloseTo(GRID_W, 6);
  });

  it('does not move the grid when it disappears — the grid never made room for it', () => {
    // It used to take a row of its own above the grid, so selling the last blueprint shifted
    // every card up by 36px under the player's cursor.
    const f = sellingForge();
    let m = withFewBuyable(2);
    f.render(m, 1280, 720);
    const p = privateOf(f);
    const before = p.rowCards[0]!.view.position.y;
    while (purchasableBlueprints(m).length > 0) m = acquireBlueprint(m, purchasableBlueprints(m)[0]!);
    f.render(m, 1280, 720);
    expect(p.storeBtn.view.visible).toBe(false);
    expect(p.rowCards[0]!.view.position.y).toBe(before);
  });
});

describe('Forge — the sheet: one layout the shell scales, not one pinned to the viewport', () => {
  it('closes the sheet with the hint, under the pager and the store entry', () => {
    const f = sellingForge();
    f.render(withFewBuyable(2), 1280, 720);
    const p = privateOf(f);
    expect(p.hint.position.y).toBeGreaterThan(p.prevPageBtn.view.position.y);
    expect(p.hint.position.y).toBeGreaterThan(p.storeBtn.view.position.y);
  });

  it('places everything the same on a short viewport — the shell scales the sheet instead', () => {
    // The original bug, in the shape it took here: a bottom row whose y came from
    // `Math.min(flowedY, h - 70)` landed on top of cards 6-8 once the viewport got short.
    const tall = new Forge();
    tall.render(defaultMetaState(), 1280, 900);
    const short = new Forge();
    short.render(defaultMetaState(), 1280, 380);
    expect(privateOf(short).hint.position.y).toBe(privateOf(tall).hint.position.y);
    expect(privateOf(short).rowCards[7]!.view.position.y).toBe(privateOf(tall).rowCards[7]!.view.position.y);
  });

  it('does not move the pager when paging changes what sits above it', () => {
    const f = new Forge();
    const m = defaultMetaState();
    f.render(m, 1280, 600);
    const before = privateOf(f).prevPageBtn.view.position.y;
    f.moveSelection(PAGE_FLIP); // flips to page 2: the grid's content changes, not its size
    f.render(m, 1280, 600);
    expect(privateOf(f).prevPageBtn.view.position.y).toBe(before);
    expect(privateOf(f).nextPageBtn.view.position.y).toBe(before);
  });

  it('keeps the compare card on a short viewport — it no longer has to give way', () => {
    const f = new Forge();
    f.render(defaultMetaState(), 1280, 380);
    expect(privateOf(f).compareCard.view.visible).toBe(true);
  });
});

describe('Forge — the two layouts', () => {
  it('takes the wide sheet only where it fits at full size', () => {
    expect(forgeIsWide(WIDE_SHEET_W + 32)).toBe(true);
    expect(forgeIsWide(WIDE_SHEET_W + 31)).toBe(false);
    expect(forgeIsWide(760)).toBe(false); // a portrait phone's design width
    expect(NARROW_SHEET_W).toBeLessThan(760 - 32);
  });

  it('puts the compare card beside the grid when wide', () => {
    const f = new Forge();
    f.render(defaultMetaState(), 1280, 720);
    const p = privateOf(f);
    expect(p.compareCard.view.position.x).toBeGreaterThan(GRID_W);
    expect(p.carryingText.position.x).toBeGreaterThan(GRID_W);
  });

  it('puts it under the grid when narrow, beside what the run carries', () => {
    const f = new Forge();
    f.render(defaultMetaState(), 760, 1600);
    const p = privateOf(f);
    const gridBottom = p.rowCards[7]!.view.position.y + BlueprintCard.H;
    expect(p.compareCard.view.position.y).toBeGreaterThan(gridBottom);
    expect(p.carryingText.position.y).toBeGreaterThan(gridBottom);
    expect(p.compareCard.view.position.x).toBeGreaterThan(p.carryingText.position.x);
    expect(p.hint.position.y).toBeGreaterThan(p.compareCard.view.position.y + p.compareCard.view.height);
  });

  it('lays out without a compare card too, in both layouts (nothing under the cursor to diff)', () => {
    for (const w of [1280, 760]) {
      const f = new Forge();
      f.selectedIndex = f.order.length; // past the catalogue: no candidate
      f.render(defaultMetaState(), w, 1600);
      const p = privateOf(f);
      expect(p.compareCard.view.visible).toBe(false);
      expect(p.hint.position.y).toBeGreaterThan(p.prevPageBtn.view.position.y);
      expect(layoutForgeSheet(p.parts(), w === 1280)).toBeGreaterThan(0);
    }
  });
});

describe('Forge — content display names (tName(), not raw catalog ids)', () => {
  it('shows the blueprint card\'s WEAPON display name, not its raw catalog id', () => {
    const f = new Forge();
    f.render(defaultMetaState(), 1280, 720);
    // order[0] is 'repeater' (blueprints.ts's first entry) — its own translated name.
    expect(privateOf(f).rowCards[0]!.nameLabel).toBe('Repeater');
  });

  it('shows translated weapon names in the compare-card equipped/candidate headers', () => {
    const f = new Forge();
    f.render(defaultMetaState(), 1280, 900);
    const p = privateOf(f);
    // Empty loadout falls back to PLAYER_BASE.startWeapons (Blaster); the browse
    // cursor starts on order[0] (Repeater), the same kind (ranged) so they compare.
    expect(p.compareCard.leftName.text).toBe('Equipped: Blaster');
    expect(p.compareCard.rightName.text).toBe('Candidate: Repeater');
  });

  it('translates all three under zh', async () => {
    const f = new Forge();
    await useLocale('zh');
    f.render(defaultMetaState(), 1280, 900);
    const p = privateOf(f);
    expect(p.rowCards[0]!.nameLabel).toBe('连发枪');
    expect(p.compareCard.leftName.text).toBe('当前装备：爆能枪');
    expect(p.compareCard.rightName.text).toBe('候选：连发枪');
  });

  it('uses the translated compact element codes for the material bank and blueprint cost, not the old English-derived slice()', async () => {
    const f = new Forge();
    f.render(defaultMetaState(), 1280, 720);
    const p = privateOf(f);
    expect(p.bank.cells.map((c) => c.name.text)).toEqual(['PHY', 'FIR', 'ICE', 'LIG', 'POI']);
    expect(p.bank.cells.every((c) => /^\d+$/.test(c.count.text))).toBe(true);
    expect(p.rowCards[0]!.costLabel).toBe('PHY×3'); // repeater: 3 physical

    await useLocale('zh');
    f.render(defaultMetaState(), 1280, 720);
    expect(privateOf(f).bank.cells.map((c) => c.name.text)).toEqual(['物', '火', '冰', '雷', '毒']);
    expect(privateOf(f).rowCards[0]!.costLabel).toBe('物×3');
  });
});

describe('Forge — i18n (design/17-i18n.md)', () => {
  it('render() retexts static labels and the section headings under zh', async () => {
    const f = sellingForge();
    await useLocale('zh');
    f.render(defaultMetaState(), 1280, 720);
    const p = privateOf(f);
    expect(p.title.text).toBe('锻造场');
    expect(p.backBtn.label.text).toBe('返回');
    expect(p.storeBtn.label.text).toBe('商店');
    expect(p.hint.text).toBe('[↑↓] 浏览 · [1-9] 打造 · [B] 商店');
    expect(p.bank.heading.text).toBe('材料');
    expect(p.carryingHeading.text).toBe('携带  0/2');
    expect(p.storeCaption.text).toMatch(/^在售：/);
  });

  it('a blueprint card still shows the status text translated', async () => {
    const f = new Forge();
    await useLocale('zh');
    f.render(defaultMetaState(), 1280, 720);
    const text = privateOf(f).rowCards[0]!.statusLabel;
    expect(text).toMatch(/材料不足|可打造|未解锁/);
  });

  it('translates the blueprint unlock-source word instead of leaking the raw BlueprintSource enum value', async () => {
    const f = new Forge();
    await useLocale('zh');
    f.render(defaultMetaState(), 1280, 720);
    const p = privateOf(f);
    // order[2] = cryobolt (source: 'purchase'), order[6] = emberblade (source:
    // 'event') — both locked by default since only 'drop' blueprints are
    // pre-unlocked (defaultMetaState/STARTER_BLUEPRINTS). Regression test: this
    // used to interpolate the raw enum value untranslated ("未解锁（purchase）")
    // instead of the localized noun ("未解锁（购买）"); covers both non-'drop'
    // source values, since a fix scoped to only one could still leak the other.
    expect(p.rowCards[2]!.statusLabel).toBe('未解锁（购买）');
    expect(p.rowCards[6]!.statusLabel).toBe('未解锁（活动）');
  });

  it('also translates the unlock-source word under the source-of-truth English locale', () => {
    const f = new Forge();
    f.render(defaultMetaState(), 1280, 720); // en is the default locale
    const p = privateOf(f);
    expect(p.rowCards[2]!.statusLabel).toBe('locked (purchase)');
    expect(p.rowCards[6]!.statusLabel).toBe('locked (event)');
  });

  it('switching back to English on a later render() fully reverts', async () => {
    const f = new Forge();
    await useLocale('zh');
    f.render(defaultMetaState(), 1280, 720);
    setLocale('en');
    f.render(defaultMetaState(), 1280, 720);
    expect(privateOf(f).title.text).toBe('FORGE OUTPOST');
  });
});
