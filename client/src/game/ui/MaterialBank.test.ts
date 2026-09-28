/**
 * The material bank (design/10 "One shell for every menu") — the five element cells the loadout
 * and the forge share. Pinned: one cell per element in `DAMAGE_TYPES` order, the counts are the
 * bank's totals across tiers, the names follow the locale, and the cells tile the width given.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { Graphics, Text } from 'pixi.js';
import { DAMAGE_TYPES } from '@dd/engine';
import { MaterialBank, MATERIAL_CELL_H } from './MaterialBank';
import { SHEET_HEADING_H, placeHeading } from './MenuSheet';
import { bankMaterials, defaultMetaState } from '../../meta';
import { elementColor } from '../theme';
import { resetLocaleForTests } from '../../i18n';
import { useLocale } from '../../i18n/loadLocale';

afterEach(() => resetLocaleForTests());

describe('MaterialBank', () => {
  it('has one cell per element, each in its element\'s colour', () => {
    const bank = new MaterialBank('MATERIALS');
    expect(bank.cells).toHaveLength(DAMAGE_TYPES.length);
    bank.cells.forEach((c, i) => expect(c.color).toBe(elementColor(DAMAGE_TYPES[i]!)));
  });

  it('shows each element\'s banked total and its short name', async () => {
    const bank = new MaterialBank('MATERIALS');
    bank.render(bankMaterials(defaultMetaState(), { mat_ice: 4 }));
    expect(bank.cells.map((c) => c.name.text)).toEqual(['PHY', 'FIR', 'ICE', 'LIG', 'POI']);
    expect(bank.cells[2]!.count.text).toBe('4');
    expect(bank.cells[0]!.count.text).toBe('0');

    await useLocale('zh');
    bank.render(defaultMetaState());
    expect(bank.cells[0]!.name.text).toBe('物');
  });

  it('tiles the width it is given, under its heading, and reports its height', () => {
    const bank = new MaterialBank('MATERIALS');
    const h = bank.layout(300);
    expect(h).toBe(SHEET_HEADING_H + 8 + MATERIAL_CELL_H);
    const xs = bank.cells.map((c) => c.name.x);
    // Centred in equal cells: evenly spaced, the first and last equally far from the edges.
    const step = xs[1]! - xs[0]!;
    xs.forEach((x, i) => expect(x).toBeCloseTo(xs[0]! + i * step, 6));
    expect(xs[0]!).toBeCloseTo(300 - xs[xs.length - 1]!, 6);
    expect(bank.cells[0]!.name.y).toBeGreaterThan(SHEET_HEADING_H);
  });

  it('retitles', () => {
    const bank = new MaterialBank('A');
    bank.setTitle('MATERIALIEN');
    expect(bank.heading.text).toBe('MATERIALIEN');
  });
});

describe('placeHeading', () => {
  it('places the label and returns the y under its row', () => {
    const text = new Text({ text: 'X' });
    expect(placeHeading(text, new Graphics(), 10, 40, 200)).toBe(40 + SHEET_HEADING_H);
    expect([text.x, text.y]).toEqual([10, 40]);
  });
});
