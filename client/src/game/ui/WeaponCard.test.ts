/**
 * `WeaponCard` caches its whole redraw behind one key, so the things worth pinning are
 * the invalidation boundaries: which spec changes must repaint (name/rarity/element/
 * damage, and the active locale), and which must not (a cooldown tick, which happens
 * 30x a second). Plus the unarmed fallback, which was the one branch a `''` cache key
 * silently swallowed the first time this was written.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { Graphics } from 'pixi.js';
import type { DamageType, WeaponSimSpec } from '@dd/engine';
import { drawElementGlyph } from '../elementIcons';
import { elementColor } from '../theme';
import { estimateMonoWidth } from './textWidth';
import { WEAPON_SIM_BY_ID } from '@dd/engine';
import { WeaponCard } from './WeaponCard';
import { rarityColor } from '../theme';
import { setLocale, resetLocaleForTests, tName } from '../../i18n';
import { useLocale } from '../../i18n/loadLocale';

afterEach(() => resetLocaleForTests());

const BLASTER = WEAPON_SIM_BY_ID.blaster!;
const SABER = WEAPON_SIM_BY_ID.saber!;

function variant(base: WeaponSimSpec, over: Partial<WeaponSimSpec>): WeaponSimSpec {
  return { ...base, ...over } as WeaponSimSpec;
}

describe('WeaponCard — equipped weapon', () => {
  it('names the weapon and states rarity, kind and element in the subtitle', () => {
    const card = new WeaponCard();
    card.set(BLASTER, 0, 10);
    // Translated display name (tName(nameKey)), not the raw catalog id (.name is now
    // the render/texture-lookup key only).
    expect(card.nameText).toBe(tName(BLASTER.nameKey));
    expect(card.nameText).not.toBe(BLASTER.name);
    expect(card.subText).toContain(BLASTER.rarity);
    expect(card.subText).toContain(BLASTER.kind);
    expect(card.subText).toContain(BLASTER.damageType);
  });

  it('puts the damage number in the badge, not the subtitle', () => {
    const card = new WeaponCard();
    card.set(variant(BLASTER, { damage: 42 }), 0, 10);
    expect(card.damageText).toContain('42');
    expect(card.subText).not.toContain('42');
  });

  it('shows a melee weapon as melee', () => {
    const card = new WeaponCard();
    card.set(SABER, 0, 10);
    expect(card.subText).toContain('melee');
  });

  it('repaints when the weapon is swapped', () => {
    const card = new WeaponCard();
    card.set(BLASTER, 0, 10);
    card.set(SABER, 0, 10);
    expect(card.nameText).toBe(tName(SABER.nameKey));
    expect(card.subText).toContain('melee');
  });

  it('repaints when only the rarity changes (same weapon id)', () => {
    const card = new WeaponCard();
    card.set(variant(BLASTER, { rarity: 'common' }), 0, 10);
    expect(card.subText).toContain('common');
    card.set(variant(BLASTER, { rarity: 'legendary' }), 0, 10);
    expect(card.subText).toContain('legendary');
  });

  it('repaints when only the element changes (same weapon id)', () => {
    const card = new WeaponCard();
    card.set(variant(BLASTER, { damageType: 'physical' }), 0, 10);
    expect(card.subText).toContain('physical');
    card.set(variant(BLASTER, { damageType: 'fire' }), 0, 10);
    expect(card.subText).toContain('fire');
    expect(card.subText).not.toContain('physical');
  });

  it('repaints when only the damage changes (a run buff, same weapon)', () => {
    const card = new WeaponCard();
    card.set(variant(BLASTER, { damage: 1 }), 0, 10);
    card.set(variant(BLASTER, { damage: 7 }), 0, 10);
    expect(card.damageText).toContain('7');
  });

  it('does not repaint for a cooldown tick alone (this runs every frame)', () => {
    const card = new WeaponCard();
    card.set(BLASTER, 0, 10);
    const width = card.estimatedWidth();
    for (let t = 0; t <= 10; t++) card.set(BLASTER, t, 10);
    expect(card.estimatedWidth()).toBe(width);
    expect(card.nameText).toBe(tName(BLASTER.nameKey));
  });
});

describe('WeaponCard — unarmed fallback', () => {
  it('draws a real card, not an empty one, when there is no weapon', () => {
    const card = new WeaponCard();
    card.set(null, 0, 1);
    expect(card.nameText).toBe('NO WEAPON');
    expect(card.subText).toBe('unarmed');
    expect(card.damageText).toBe('');
  });

  it('reaches the unarmed branch even as the very first set() (empty-key regression)', () => {
    const card = new WeaponCard();
    card.set(null, 0, 1); // nothing drawn before this — the cache must not swallow it
    expect(card.nameText).not.toBe('');
  });

  it('recovers the real card after picking a weapon up, and drops it again on loss', () => {
    const card = new WeaponCard();
    card.set(null, 0, 1);
    card.set(BLASTER, 0, 10);
    expect(card.nameText).toBe(tName(BLASTER.nameKey));
    card.set(null, 0, 1);
    expect(card.nameText).toBe('NO WEAPON');
    expect(card.damageText).toBe('');
  });

  it('hides the cooldown bar while unarmed and shows it again once armed', () => {
    const card = new WeaponCard();
    const cdBar = card.view.children[card.view.children.length - 1]!;
    card.set(BLASTER, 0, 10);
    expect(cdBar.visible).toBe(true);
    card.set(null, 0, 1);
    expect(cdBar.visible).toBe(false);
  });
});

describe('WeaponCard — i18n', () => {
  it('re-translates on a locale change even though the weapon did not move', async () => {
    const card = new WeaponCard();
    card.set(BLASTER, 0, 10);
    expect(card.subText).toContain('ranged');

    await useLocale('zh');
    card.set(BLASTER, 0, 10); // identical spec — only the locale changed
    expect(card.subText).toContain('远程');
    expect(card.damageText).toContain('伤害');

    setLocale('en');
    card.set(BLASTER, 0, 10);
    expect(card.subText).toContain('ranged');
  });

  it('translates every rarity tier the engine can hand it', async () => {
    await useLocale('zh');
    const card = new WeaponCard();
    const expected: Record<string, string> = {
      common: '普通',
      fine: '精良',
      epic: '史诗',
      legend: '传说',
      legendary: '传奇',
    };
    for (const [tier, zh] of Object.entries(expected)) {
      card.set(variant(BLASTER, { rarity: tier as WeaponSimSpec['rarity'] }), 0, 10);
      expect(card.subText).toContain(zh);
    }
  });

  it('translates every damage type the engine can hand it', async () => {
    await useLocale('zh');
    const card = new WeaponCard();
    const expected: Record<string, string> = {
      physical: '物理',
      fire: '火',
      ice: '冰',
      lightning: '雷',
      poison: '毒',
    };
    for (const [element, zh] of Object.entries(expected)) {
      card.set(variant(BLASTER, { damageType: element as WeaponSimSpec['damageType'] }), 0, 10);
      expect(card.subText).toContain(zh);
    }
  });
});

describe('WeaponCard — layout width', () => {
  it('never reports narrower than the cooldown bar it draws', () => {
    const card = new WeaponCard();
    // `nameKey`, not `name` — the card displays `tName(spec.nameKey)`; `.name` is now
    // the render/texture-lookup id only (see WeaponCard.ts). An uncatalogued nameKey
    // (no dot, matches nothing) falls back to being echoed back raw by `tName()`,
    // same as this test's old `.name` override used to be echoed directly.
    card.set(variant(BLASTER, { nameKey: 'x' }), 0, 10);
    expect(card.estimatedWidth()).toBeGreaterThanOrEqual(150);
  });

  it('grows for a name long enough to push the damage badge past the bar', () => {
    const card = new WeaponCard();
    card.set(variant(BLASTER, { nameKey: 'x' }), 0, 10);
    const narrow = card.estimatedWidth();
    card.set(variant(BLASTER, { nameKey: 'a-truly-preposterous-weapon-name' }), 0, 10);
    expect(card.estimatedWidth()).toBeGreaterThan(narrow);
  });
});

describe('rarityColor — the border hue the card passes through (design/14)', () => {
  it('gives every tier a distinct colour', () => {
    const tiers: Array<WeaponSimSpec['rarity']> = ['common', 'fine', 'epic', 'legend', 'legendary'];
    const colors = tiers.map((r) => rarityColor(variant(BLASTER, { rarity: r })));
    expect(new Set(colors).size).toBe(tiers.length);
  });
});

/**
 * The element ICON in the damage badge (design/13's dual-channel law, 2026-08-25). The badge
 * was element-TINTED before, which is the colour channel only; the subtitle names the element
 * in words, which is a third channel that the player is not reading mid-fight. The glyph is
 * what the doc actually asks a weapon to carry.
 */
describe('WeaponCard — the element icon in the damage badge (design/13)', () => {
  type Instr = {
    action: string;
    data: { style?: { color?: number }; path?: { instructions: Array<{ action: string; data: unknown[] }> } };
  };

  function badgeOf(card: WeaponCard): Graphics {
    // `view` children: chip, [icon], name, sub, badge, badgeValue, cdBar — the badge is the
    // Graphics that is not the chip, found by type + order rather than by a fixed index (the
    // icon child appears only when a texture resolves).
    const gs = card.view.children.filter((c): c is Graphics => c instanceof Graphics);
    return gs[gs.length - 1]!;
  }

  /** `moveTo` is dropped: it is Pixi's own path bookkeeping and is emitted or not depending on
   *  what was drawn into the same Graphics beforehand, so keeping it would stop an identically
   *  shaped glyph from matching a reference drawn on a bare Graphics. */
  function digest(g: Graphics): string {
    return (g.context.instructions as unknown as Instr[])
      .map((ins) => {
        const path = (ins.data.path?.instructions ?? [])
          .filter((pi) => pi.action !== 'moveTo')
          .map((pi) => {
            const nums: number[] = [];
            for (const v of pi.data) {
              if (typeof v === 'number') nums.push(v);
              else if (Array.isArray(v)) for (const n of v) if (typeof n === 'number') nums.push(n);
            }
            return `${pi.action}(${nums.map((n) => n.toFixed(2)).join(',')})`;
          })
          .join('|');
        return `${ins.action} ${ins.data.style?.color ?? ''} ${path}`;
      })
      .join(';');
  }

  const ELEMENTS: readonly DamageType[] = ['fire', 'ice', 'lightning', 'poison', 'physical'];

  /** Where the card puts the glyph, recomputed here from the card's own public geometry rather
   *  than copied from its private constants — the reference has to land on the same spot as the
   *  real one for the containment assertion below to mean anything. */
  function glyphSpotOf(card: WeaponCard, spec: WeaponSimSpec): { cx: number; cy: number; r: number } {
    // The badge's frame is its first roundRect; the glyph sits one padding-step inside its left
    // edge, vertically centred on the 16 px frame.
    const frame = (badgeOf(card).context.instructions as unknown as Instr[])
      .flatMap((ins) => ins.data.path?.instructions ?? [])
      .find((pi) => pi.action === 'roundRect')!;
    const [x] = pi_nums(frame);
    void spec;
    const r = 5; // BADGE_GLYPH_R
    return { cx: x! + 6 + r, cy: 8, r };
  }

  function pi_nums(pi: { data: unknown[] }): number[] {
    const nums: number[] = [];
    for (const v of pi.data) {
      if (typeof v === 'number') nums.push(v);
      else if (Array.isArray(v)) for (const n of v) if (typeof n === 'number') nums.push(n);
    }
    return nums;
  }

  it.each(ELEMENTS)('%s draws ITS OWN glyph inside the badge', (damageType) => {
    // Asserted against an independently drawn reference glyph, not against "some path that is
    // not a roundRect" — a stroke emits a bare `moveTo`, so that weaker form passed happily on
    // a badge with the glyph call deleted outright (caught by the mutation battery).
    const spec = variant(BLASTER, { damageType });
    const card = new WeaponCard();
    card.set(spec, 0, 10);
    const { cx, cy, r } = glyphSpotOf(card, spec);
    const reference = new Graphics();
    drawElementGlyph(reference, damageType, cx, cy, r, elementColor(damageType), 0x0b0e14);
    expect(digest(badgeOf(card))).toContain(digest(reference));
  });

  it('a fire weapon does NOT contain the ice glyph (the containment check discriminates)', () => {
    const card = new WeaponCard();
    const spec = variant(BLASTER, { damageType: 'fire' });
    card.set(spec, 0, 10);
    const { cx, cy, r } = glyphSpotOf(card, spec);
    const ice = new Graphics();
    drawElementGlyph(ice, 'ice', cx, cy, r, elementColor('fire'), 0x0b0e14);
    expect(digest(badgeOf(card))).not.toContain(digest(ice));
  });

  it('the five elements produce five different badges', () => {
    const seen = new Set<string>();
    for (const damageType of ELEMENTS) {
      const card = new WeaponCard();
      card.set(variant(BLASTER, { damageType }), 0, 10);
      seen.add(digest(badgeOf(card)));
    }
    expect(seen.size).toBe(ELEMENTS.length);
  });

  it('the badge frame WIDENED for the glyph rather than the number being drawn over it', () => {
    // Two separate things had to happen when the glyph landed: the frame got wider, and the
    // number moved right. Each was its own mutant and neither was caught by a bounds check.
    const spec = variant(BLASTER, { damageType: 'fire', nameKey: 'x', damage: 7 });
    const card = new WeaponCard();
    card.set(spec, 0, 10);
    const frame = pi_nums(
      (badgeOf(card).context.instructions as unknown as Instr[])
        .flatMap((ins) => ins.data.path?.instructions ?? [])
        .find((pi) => pi.action === 'roundRect')!,
    );
    const [fx, , fw] = frame;
    const { cx, r } = glyphSpotOf(card, spec);
    // Glyph fully inside the frame…
    expect(cx - r).toBeGreaterThan(fx!);
    expect(cx + r).toBeLessThan(fx! + fw!);
    // …and the number starts to the RIGHT of the glyph, so the two never overlap.
    const numberX = (card.view.children.find((c) => 'text' in c && (c as { text: string }).text === card.damageText) as
      | { x: number }
      | undefined)!;
    expect(numberX.x).toBeGreaterThanOrEqual(cx + r);
    // …and the number still FITS: the frame has to have grown by the glyph's box, not just had
    // its contents shoved right. Dropping the widening leaves the digits hanging out past the
    // rounded end, which every geometric check above is blind to.
    const numberRight = numberX.x + estimateMonoWidth(card.damageText, 11);
    expect(numberRight).toBeLessThanOrEqual(fx! + fw!);
  });

  it('estimatedWidth() covers the widened badge, so the HUD panel cannot clip it', () => {
    const card = new WeaponCard();
    card.set(variant(BLASTER, { damageType: 'fire', nameKey: 'x' }), 0, 10);
    const b = badgeOf(card).getLocalBounds();
    expect(card.estimatedWidth()).toBeGreaterThanOrEqual(b.right - 1);
  });

  it('the unarmed card draws no glyph — there is no element to name', () => {
    const card = new WeaponCard();
    card.set(null, 0, 10);
    const paths = (badgeOf(card).context.instructions as unknown as Instr[]).flatMap(
      (ins) => ins.data.path?.instructions ?? [],
    );
    expect(paths).toHaveLength(0);
  });
});
