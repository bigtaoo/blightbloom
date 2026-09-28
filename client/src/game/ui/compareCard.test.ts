import { describe, it, expect, afterEach } from 'vitest';
import { WEAPON_SPECS, applyQuality } from '@dd/engine';
import { CompareCard, buildCompareRows, equippedSpecOfKind } from './compareCard';
import { installFakeTextCanvas } from '../screens/fakeTextCanvas';

// `CompareCard.set` measures its names and body (`Text.width`), which needs a 2D context.
installFakeTextCanvas();
import { setLocale, resetLocaleForTests } from '../../i18n';
import { useLocale } from '../../i18n/loadLocale';

afterEach(() => resetLocaleForTests());

describe('buildCompareRows', () => {
  it('returns null comparing a ranged spec against a melee spec', () => {
    expect(buildCompareRows(WEAPON_SPECS.blaster!, WEAPON_SPECS.saber!)).toBeNull();
  });

  it('builds ranged-specific rows (fire rate/spread/speed), damage post-quality', () => {
    const rows = buildCompareRows(WEAPON_SPECS.blaster!, WEAPON_SPECS.repeater!);
    expect(rows).not.toBeNull();
    const byLabel = Object.fromEntries(rows!.map((r) => [r.label, r]));
    expect(byLabel.Damage!.left).toBe(String(applyQuality(WEAPON_SPECS.blaster!.damage, WEAPON_SPECS.blaster!.rarity)));
    expect(byLabel.Damage!.right).toBe(String(applyQuality(WEAPON_SPECS.repeater!.damage, WEAPON_SPECS.repeater!.rarity)));
    expect(byLabel['Fire rate']).toBeDefined();
    expect(byLabel.Spread).toBeDefined();
    expect(byLabel.Speed).toBeDefined();
    expect(byLabel.Arc).toBeUndefined();
  });

  it('builds melee-specific rows (swing/arc/reach/deflect)', () => {
    const rows = buildCompareRows(WEAPON_SPECS.saber!, WEAPON_SPECS.hammer!);
    expect(rows).not.toBeNull();
    const byLabel = Object.fromEntries(rows!.map((r) => [r.label, r]));
    expect(byLabel.Swing).toBeDefined();
    expect(byLabel.Arc).toBeDefined();
    expect(byLabel.Reach).toBeDefined();
    expect(byLabel.Deflect).toBeDefined();
    expect(byLabel['Fire rate']).toBeUndefined();
  });

  it('every row has a value on both sides', () => {
    const rows = buildCompareRows(WEAPON_SPECS.blaster!, WEAPON_SPECS.cannon!)!;
    for (const r of rows) {
      expect(r.left.length).toBeGreaterThan(0);
      expect(r.right.length).toBeGreaterThan(0);
    }
  });
});

describe('equippedSpecOfKind', () => {
  it('finds the loadout entry matching the requested kind', () => {
    expect(equippedSpecOfKind(['cannon', 'hammer'], 'ranged')).toBe(WEAPON_SPECS.cannon);
    expect(equippedSpecOfKind(['cannon', 'hammer'], 'melee')).toBe(WEAPON_SPECS.hammer);
  });

  it('returns undefined when the loadout has no entry of that kind', () => {
    expect(equippedSpecOfKind(['cannon'], 'melee')).toBeUndefined();
  });

  it('returns undefined for an empty loadout', () => {
    expect(equippedSpecOfKind([], 'ranged')).toBeUndefined();
  });
});

describe('buildCompareRows — i18n (design/17-i18n.md)', () => {
  it('row labels translate under zh; the values themselves (data, not copy) do not', async () => {
    await useLocale('zh');
    const rows = buildCompareRows(WEAPON_SPECS.blaster!, WEAPON_SPECS.repeater!)!;
    const byLabel = Object.fromEntries(rows.map((r) => [r.label, r]));
    expect(byLabel['伤害']).toBeDefined();
    expect(byLabel['射速']).toBeDefined();
    expect(byLabel['散射']).toBeDefined();
    expect(byLabel['速度']).toBeDefined();
    // English row labels must be gone, not merely supplemented.
    expect(byLabel.Damage).toBeUndefined();
  });

  it('melee row labels translate under zh, including the yes/no deflect value', async () => {
    await useLocale('zh');
    const rows = buildCompareRows(WEAPON_SPECS.saber!, WEAPON_SPECS.hammer!)!;
    const byLabel = Object.fromEntries(rows.map((r) => [r.label, r]));
    expect(byLabel['格挡']).toBeDefined();
    expect(['是', '否']).toContain(byLabel['格挡']!.left);
    expect(['是', '否']).toContain(byLabel['格挡']!.right);
  });

  it('switching back to English restores the original labels', async () => {
    await useLocale('zh');
    buildCompareRows(WEAPON_SPECS.blaster!, WEAPON_SPECS.repeater!);
    setLocale('en');
    const rows = buildCompareRows(WEAPON_SPECS.blaster!, WEAPON_SPECS.repeater!)!;
    expect(rows.some((r) => r.label === 'Damage')).toBe(true);
  });
});

describe('CompareCard — fitting a narrow card (the forge side column, 2026-09-27)', () => {
  type Internals = { view: { height: number }; leftName: { y: number }; rightName: { y: number }; body: { y: number; width: number; scale: { x: number } } };
  const card = (w: number, left: string, right: string) => {
    const c = new CompareCard();
    c.set({ w, leftName: left, leftColor: 0xffffff, rightName: right, rightColor: 0xffffff, rows: buildCompareRows(WEAPON_SPECS.blaster!, WEAPON_SPECS.repeater!)! });
    return c as unknown as Internals;
  };

  it('keeps both names on one line when they fit', () => {
    const c = card(420, 'Equipped: Blaster', 'Candidate: Repeater');
    expect(c.rightName.y).toBe(c.leftName.y);
  });

  it('stacks the candidate under the equipped name when they do not, and grows to hold it', () => {
    const wide = card(420, 'Equipped: Blaster', 'Candidate: Repeater');
    const narrow = card(300, 'Equipped: Blaster', 'Candidate: Repeater');
    expect(narrow.rightName.y).toBeGreaterThan(narrow.leftName.y);
    expect(narrow.body.y).toBeGreaterThan(narrow.rightName.y);
    expect(narrow.view.height).toBeGreaterThan(wide.view.height);
  });

  it('shrinks a stat block wider than the card to fit it, and draws a narrow one at full size', async () => {
    expect(card(420, 'A', 'B').body.scale.x).toBe(1);
    await useLocale('ru'); // `физический` twice over: wider than a 300px card
    const c = card(300, 'A', 'B');
    expect(c.body.scale.x).toBeLessThan(1);
    expect(c.body.width).toBeLessThanOrEqual(300 - 24 + 1e-6);
  });
});
