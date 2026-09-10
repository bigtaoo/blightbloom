/**
 * Forge (the loadout/outpost screen). Pixi Container/Text/Graphics construct and
 * mutate fine under plain vitest with no renderer attached (same finding
 * Screens.test.ts/PartyScreen.test.ts made) — asserted here via `.position`/`.visible`/
 * `.text`, not pixel output.
 *
 * Two real layout bugs, both reported live as "the screen is a mess": the buyable-
 * blueprint list had no length bound and could run off both edges of the screen as one
 * line, and the bottom action bar (clear/start/hint) was positioned by flowing down
 * from the row list + compare card and only *clamped* to fit once it overflowed —
 * which left it floating on top of the still-there row list instead of below it.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { Forge } from './Forge';
import { installFakeTextCanvas } from './fakeTextCanvas';
import { defaultMetaState, acquireBlueprint, purchasableBlueprints } from '../../meta';
import type { MetaState } from '../../meta';
import { setLocale, resetLocaleForTests } from '../../i18n';

// `Button.label` is private on the real class — same escape hatch every other screen
// test here uses (MainMenu.test.ts/PauseMenu.test.ts/Settings.test.ts) to read it anyway.
interface TestButton {
  view: { visible: boolean; position: { x: number; y: number } };
  label: { text: string };
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

function privateOf(f: Forge) {
  return f as unknown as {
    title: { text: string };
    infoText: { text: string; style: { wordWrap: boolean; breakWords: boolean } };
    rowCards: TestCard[];
    clearBtn: TestButton;
    startBtn: TestButton;
    continueBtn: TestButton;
    storeBtn: TestButton;
    hint: { position: { x: number; y: number }; text: string };
    charText: { text: string };
    compareCard: {
      view: { visible: boolean; position: { x: number; y: number }; height: number };
      leftName: { text: string };
      rightName: { text: string };
    };
  };
}

afterEach(() => resetLocaleForTests());

// Buys down the shelf to `max` or fewer remaining purchasable blueprints (defaultMetaState
// starts with 17 — see forge.test.ts's own purchasableBlueprints assertion).
function withFewBuyable(max: number): MetaState {
  let m = defaultMetaState();
  while (purchasableBlueprints(m).length > max) {
    m = acquireBlueprint(m, purchasableBlueprints(m)[0]!);
  }
  return m;
}

describe('Forge — infoText buyable-list bound', () => {
  it('collapses a long shelf to a bare count instead of joining every name', () => {
    const f = new Forge();
    const m = defaultMetaState();
    expect(purchasableBlueprints(m).length).toBeGreaterThan(3); // the case that used to overflow
    f.render(m, 1280, 720);
    const text = privateOf(f).infoText.text;
    expect(text).toContain(`${purchasableBlueprints(m).length} more available`);
    // None of the shelf's own blueprint ids should leak into the collapsed line — only
    // the count should. (A regression here would mean the old unbounded join is back.)
    for (const id of purchasableBlueprints(m).slice(3)) expect(text).not.toContain(id);
  });

  it('still lists names when the shelf is short enough to matter', () => {
    const f = new Forge();
    const m = withFewBuyable(2);
    const shelf = purchasableBlueprints(m);
    expect(shelf.length).toBeGreaterThan(0);
    expect(shelf.length).toBeLessThanOrEqual(3);
    f.render(m, 1280, 720);
    const text = privateOf(f).infoText.text;
    for (const id of shelf) expect(text).toContain(id);
    expect(text).not.toContain('more available');
  });

  it('omits the Store line entirely once nothing is left to buy', () => {
    const f = new Forge();
    const m = withFewBuyable(0);
    expect(purchasableBlueprints(m)).toHaveLength(0);
    f.render(m, 1280, 720);
    expect(privateOf(f).infoText.text).not.toContain('Store');
  });

  it('infoText wraps AND force-breaks unbroken runs (CJK locales have no spaces to wrap at, design/17-i18n.md)', () => {
    const f = new Forge();
    const style = privateOf(f).infoText.style;
    expect(style.wordWrap).toBe(true);
    expect(style.breakWords).toBe(true);
  });
});

describe('Forge — store button (design/19 §4; was ACQUIRE, the `demo: free grant` scaffold)', () => {
  /** `storeEnabled` is what the assembly sets from `platform/storePlatform.ts`. */
  function sellingForge(): Forge {
    const f = new Forge();
    f.storeEnabled = true;
    return f;
  }

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

  it('is hidden once nothing is left to buy — same condition the Store info line uses', () => {
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

  it("doesn't overlap the first blueprint row when shown", () => {
    const f = sellingForge();
    f.render(withFewBuyable(2), 1280, 720);
    const p = privateOf(f);
    expect(p.storeBtn.view.position.y).toBeLessThan(p.rowCards[0]!.view.position.y);
  });

  it('reflows the row list up once the button disappears — same instance, not a fresh one', () => {
    // The two tests above use separate Forge instances with separate MetaStates, which
    // only proves the button's OWN .visible flag toggles — not that render()'s
    // `y += 36` (only added when acquireBtn is visible) actually reflows every row/
    // page-nav element below it for the SAME screen across a real state transition
    // (buyable>0 → buyable==0), the same "boundary transition on one instance" pattern
    // the fixed-bottom-action-bar tests below already use via moveSelection/re-render.
    const f = sellingForge();
    let m = withFewBuyable(2);
    f.render(m, 1280, 720);
    const p = privateOf(f);
    expect(p.storeBtn.view.visible).toBe(true);
    const rowYWithButton = p.rowCards[0]!.view.position.y;

    while (purchasableBlueprints(m).length > 0) {
      m = acquireBlueprint(m, purchasableBlueprints(m)[0]!);
    }
    f.render(m, 1280, 720);
    expect(p.storeBtn.view.visible).toBe(false);
    const rowYWithoutButton = p.rowCards[0]!.view.position.y;
    // The shift is AT LEAST the button's own reserved 36px — dropping the Store info
    // line at the same time also shrinks infoText by one line's height, so the real
    // total delta is bigger than 36 alone; the >=36 floor is what actually pins down
    // "the button's reserved space really disappeared," without being coupled to the
    // separate, unrelated infoText line-count arithmetic.
    expect(rowYWithButton - rowYWithoutButton).toBeGreaterThanOrEqual(36);
  });
});

describe('Forge — fixed bottom action bar', () => {
  it('anchors clear/start/hint to the viewport height, not to the content flow above them', () => {
    const f = new Forge();
    const m = defaultMetaState();
    f.render(m, 1280, 720);
    const p = privateOf(f);
    expect(p.startBtn.view.position.y).toBe(720 - 60);
    expect(p.clearBtn.view.position.y).toBe(720 - 60 + 7);
    expect(p.hint.position.y).toBe(720 - 6);
  });

  it('stays at the same height-relative offset on a short viewport instead of drifting onto the row list', () => {
    // The original bug: this button's y came from `Math.min(flowedY, h - 70)`, so on a
    // short screen it landed wherever the flow happened to overflow to — which, with
    // eight full-size rows above it, meant on top of rows 6-8. Pinning it to `h` means
    // the same offset from the bottom holds regardless of viewport size.
    const f = new Forge();
    const m = defaultMetaState();
    f.render(m, 1280, 480);
    const p = privateOf(f);
    expect(p.startBtn.view.position.y).toBe(480 - 60);
    expect(p.clearBtn.view.position.y).toBe(480 - 60 + 7);
    expect(p.hint.position.y).toBe(480 - 6);
  });

  it('does not move the action bar when paging changes how much content sits above it', () => {
    const f = new Forge();
    const m = defaultMetaState();
    f.render(m, 1280, 600);
    const before = privateOf(f).startBtn.view.position.y;
    f.moveSelection(1); // may flip pages, changing the row-list content but not its size
    f.render(m, 1280, 600);
    expect(privateOf(f).startBtn.view.position.y).toBe(before);
  });
});

describe('Forge — compare card no-room hide', () => {
  it('shows the compare card when the viewport is tall enough', () => {
    const f = new Forge();
    f.render(defaultMetaState(), 1280, 900);
    expect(privateOf(f).compareCard.view.visible).toBe(true);
  });

  it('hides the compare card instead of overlapping the fixed action bar on a short viewport', () => {
    const f = new Forge();
    f.render(defaultMetaState(), 1280, 380);
    const p = privateOf(f);
    expect(p.compareCard.view.visible).toBe(false);
    // And the action bar itself must still be exactly where a taller render would put
    // it relative to `h` — hiding the card must not be achieved by moving the bar.
    expect(p.startBtn.view.position.y).toBe(380 - 60);
  });
});

describe('Forge — content display names (tName(), not raw catalog ids)', () => {
  it('shows the blueprint card\'s WEAPON display name, not its raw catalog id', () => {
    const f = new Forge();
    f.render(defaultMetaState(), 1280, 720);
    // order[0] is 'repeater' (blueprints.ts's first entry) — its own translated name.
    expect(privateOf(f).rowCards[0]!.nameLabel).toBe('Repeater');
  });

  it('shows the selected character\'s translated name in the char-stats line', () => {
    const f = new Forge();
    f.render(defaultMetaState(), 1280, 720);
    // defaultMetaState() selects DEFAULT_SKIN_ID ('vanguard').
    expect(privateOf(f).charText.text).toContain('Vanguard');
  });

  it('shows translated weapon names in the compare-card equipped/candidate headers', () => {
    const f = new Forge();
    f.render(defaultMetaState(), 1280, 900); // tall enough that the card isn't hidden
    const p = privateOf(f);
    // Empty loadout falls back to PLAYER_BASE.startWeapons (Blaster); the browse
    // cursor starts on order[0] (Repeater), the same kind (ranged) so they compare.
    expect(p.compareCard.leftName.text).toBe('Equipped: Blaster');
    expect(p.compareCard.rightName.text).toBe('Candidate: Repeater');
  });

  it('translates all three under zh', () => {
    const f = new Forge();
    setLocale('zh');
    f.render(defaultMetaState(), 1280, 900);
    const p = privateOf(f);
    expect(p.rowCards[0]!.nameLabel).toBe('连发枪');
    expect(p.charText.text).toContain('先锋');
    expect(p.compareCard.leftName.text).toBe('当前装备：爆能枪');
    expect(p.compareCard.rightName.text).toBe('候选：连发枪');
  });

  it('uses the translated compact element codes for the material bank line and blueprint cost, not the old English-derived slice()', () => {
    const f = new Forge();
    f.render(defaultMetaState(), 1280, 720);
    const p = privateOf(f);
    expect(p.infoText.text).toMatch(/PHY \d+.*FIR \d+.*ICE \d+.*LIG \d+.*POI \d+/s);
    expect(p.rowCards[0]!.costLabel).toBe('PHY×3'); // repeater: 3 physical

    setLocale('zh');
    f.render(defaultMetaState(), 1280, 720);
    expect(privateOf(f).infoText.text).toMatch(/物 \d+.*火 \d+.*冰 \d+.*雷 \d+.*毒 \d+/s);
    expect(privateOf(f).rowCards[0]!.costLabel).toBe('物×3');
  });
});

describe('Forge — i18n (design/17-i18n.md)', () => {
  it('render() retexts static labels and interpolates the info block under zh', () => {
    const f = new Forge();
    setLocale('zh');
    f.render(defaultMetaState(), 1280, 720);
    const p = privateOf(f);
    expect(p.title.text).toBe('锻造场');
    expect(p.startBtn.label.text).toBe('开始行动 ▸');
    expect(p.clearBtn.label.text).toBe('清空装备');
    expect(p.storeBtn.label.text).toBe('商店');
    expect(p.hint.text).toBe('[↑↓]/[1-9]/[C]/[X]/[Enter] 键盘快捷键仍然可用');
    expect(p.infoText.text).toContain('材料');
    expect(p.infoText.text).toContain('已拥有角色：3');
  });

  it('a blueprint card still shows the status text translated', () => {
    const f = new Forge();
    setLocale('zh');
    f.render(defaultMetaState(), 1280, 720);
    const text = privateOf(f).rowCards[0]!.statusLabel;
    expect(text).toMatch(/材料不足|可打造|未解锁/);
  });

  it('translates the blueprint unlock-source word instead of leaking the raw BlueprintSource enum value', () => {
    const f = new Forge();
    setLocale('zh');
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

  it('switching back to English on a later render() fully reverts', () => {
    const f = new Forge();
    setLocale('zh');
    f.render(defaultMetaState(), 1280, 720);
    setLocale('en');
    f.render(defaultMetaState(), 1280, 720);
    expect(privateOf(f).title.text).toBe('FORGE OUTPOST');
  });
});

/**
 * CONTINUE RUN (design/05 "Only the boss floor ends a run", ENGINE_VERSION 61) — the forge's
 * second primary button, and the two-row action bar it produces.
 *
 * The screen decides nothing here: it asks a `savedRun` PROVIDER, which the assembly points
 * at the real save slot. That indirection is what these cases are mostly about — a provider
 * read once and cached would show CONTINUE for a run that has since been won or abandoned,
 * which is the failure the three clear-the-slot call sites exist to prevent, and it would be
 * defeated entirely by this screen holding a stale copy.
 */
describe('Forge — CONTINUE RUN', () => {
  const SAVED = { floorIndex: 2, ticks: 5400, savedAtMs: 0 }; // floor 3, 3:00 played

  function withSave(saved: typeof SAVED | null = SAVED): Forge {
    const f = new Forge();
    f.savedRun = () => saved;
    return f;
  }

  it('is hidden with no saved run — the default provider answers null', () => {
    const f = new Forge();
    f.render(defaultMetaState(), 1280, 720);
    expect(privateOf(f).continueBtn.view.visible).toBe(false);
  });

  it('appears when there is one', () => {
    const f = withSave();
    f.render(defaultMetaState(), 1280, 720);
    expect(privateOf(f).continueBtn.view.visible).toBe(true);
  });

  it('re-reads the provider on every render, so a cleared save stops being offered', () => {
    // The live case: the run is resumed (or won, or abandoned), the slot is cleared, and the
    // forge is re-rendered by the very navigation that got us back here.
    let saved: typeof SAVED | null = SAVED;
    const f = new Forge();
    f.savedRun = () => saved;
    f.render(defaultMetaState(), 1280, 720);
    expect(privateOf(f).continueBtn.view.visible).toBe(true);

    saved = null;
    f.render(defaultMetaState(), 1280, 720);
    expect(privateOf(f).continueBtn.view.visible).toBe(false);
  });

  it('takes the footer slot, and pushes START RUN to the row above', () => {
    // Continuing is what a returning player came for, so it gets the primary position; and
    // the two must not overlap, because the other one discards the save.
    const f = withSave();
    f.render(defaultMetaState(), 1280, 720);
    const p = privateOf(f);
    expect(p.continueBtn.view.position.y).toBe(720 - 60);
    expect(p.startBtn.view.position.y).toBe(720 - 60 - 52);
  });

  it('leaves START RUN exactly where it was when there is no save', () => {
    // The regression guard for every existing action-bar assertion in this file: adding a
    // button must not move the one that was already there for the common case.
    const f = withSave(null);
    f.render(defaultMetaState(), 1280, 720);
    expect(privateOf(f).startBtn.view.position.y).toBe(720 - 60);
  });

  it('fires onContinue, never onStart', () => {
    const f = withSave();
    const calls: string[] = [];
    f.onStart = () => calls.push('start');
    f.onContinue = () => calls.push('continue');
    f.render(defaultMetaState(), 1280, 720);
    privateOf(f).continueBtn.onTap?.();
    expect(calls).toEqual(['continue']);
  });

  it('names the saved run in the info block — floor and time played', () => {
    // Two buttons that differ only by label are not enough to decide between "resume" and
    // "throw it away" on. 5400 ticks at 30 Hz is 3:00.
    const f = withSave();
    f.render(defaultMetaState(), 1280, 720);
    const text = privateOf(f).infoText.text;
    expect(text).toContain('floor 3'); // 0-based 2, displayed 1-based
    expect(text).toContain('3:00');
  });

  it('pads the seconds, so 65 ticks reads 0:02 and not 0:2', () => {
    const f = withSave({ floorIndex: 0, ticks: 65, savedAtMs: 0 });
    f.render(defaultMetaState(), 1280, 720);
    expect(privateOf(f).infoText.text).toContain('0:02');
  });

  it('says nothing about a saved run when there is none', () => {
    const f = new Forge();
    f.render(defaultMetaState(), 1280, 720);
    expect(privateOf(f).infoText.text).not.toContain('Saved run');
  });

  it('hides the compare card against the TOP of the two-row bar, not the footer row', () => {
    // Without this the card is measured against the lower row and can overlap START RUN on
    // a viewport that is short but not short enough to trip the original check — the same
    // "floating on top of what is still there" shape the flowed layout used to have.
    const tall = withSave();
    tall.render(defaultMetaState(), 1280, 900);
    expect(privateOf(tall).compareCard.view.visible).toBe(true);

    const f = withSave();
    f.render(defaultMetaState(), 1280, 620);
    const p = privateOf(f);
    if (p.compareCard.view.visible) {
      expect(p.compareCard.view.position.y + p.compareCard.view.height)
        .toBeLessThanOrEqual(p.startBtn.view.position.y);
    }
  });

  it('retexts from the active locale', () => {
    const f = withSave();
    setLocale('zh');
    f.render(defaultMetaState(), 1280, 720);
    expect(privateOf(f).continueBtn.label.text).toBe('继续行动 ▸');
    setLocale('en');
    f.render(defaultMetaState(), 1280, 720);
    expect(privateOf(f).continueBtn.label.text).toBe('CONTINUE RUN ▸');
  });
});
