// The material bank (design/10 "One shell for every menu", design/14): a heading over one cell
// per element — the element's short name in its own colour, over the banked total summed across
// every rolled tier. Shared by the loadout and the forge, the two screens that answer "what can
// I spend?", so the currency reads the same on both.
import { Container, Graphics, Text } from 'pixi.js';
import { DAMAGE_TYPES } from '@dd/engine';
import type { MetaState } from '../../meta';
import { bankTotal } from '../../meta';
import { elementColor } from '../theme';
import { t } from '../../i18n';
import { ELEMENT_SHORT_KEY } from '../../i18n/contentKeys';
import { MENU_COLORS, menuText } from './menuTheme';
import { placeHeading } from './MenuSheet';

/** A cell's height and the gap between two cells. */
export const MATERIAL_CELL_H = 64;
const CELL_GAP = 8;

export interface MaterialCell { name: Text; count: Text; color: number }

export class MaterialBank {
  readonly view = new Container();
  readonly heading: Text;
  /** One cell per element, in `DAMAGE_TYPES` order. */
  readonly cells: readonly MaterialCell[];
  private readonly rules = new Graphics();

  constructor(title: string) {
    this.heading = new Text({ text: title, style: menuText('heading') });
    this.cells = DAMAGE_TYPES.map((e) => {
      const color = elementColor(e);
      const name = new Text({ text: '', style: menuText('label', { fontSize: 11, fill: color }) });
      name.anchor.set(0.5, 0);
      const count = new Text({ text: '', style: menuText('value', { fontSize: 20 }) });
      count.anchor.set(0.5, 0);
      return { name, count, color };
    });
    this.view.addChild(this.rules, this.heading, ...this.cells.flatMap((c) => [c.name, c.count]));
  }

  setTitle(text: string): void {
    this.heading.text = text;
  }

  /** The short names in the active locale, and each element's total. */
  render(m: MetaState): void {
    DAMAGE_TYPES.forEach((e, i) => {
      this.cells[i]!.name.text = t(ELEMENT_SHORT_KEY[e]);
      this.cells[i]!.count.text = String(bankTotal(m, e));
    });
  }

  /** Lay the bank out `w` wide from its view's origin; returns its height. */
  layout(w: number): number {
    this.rules.clear();
    const y = placeHeading(this.heading, this.rules, 0, 0, w) + 8;
    const n = this.cells.length;
    const cellW = (w - CELL_GAP * (n - 1)) / n;
    this.cells.forEach((cell, i) => {
      const x = i * (cellW + CELL_GAP);
      this.rules
        .roundRect(x, y, cellW, MATERIAL_CELL_H, 8).fill({ color: MENU_COLORS.field, alpha: 0.9 })
        .roundRect(x + 0.5, y + 0.5, cellW - 1, MATERIAL_CELL_H - 1, 8).stroke({ color: MENU_COLORS.fieldBorder, width: 1 })
        .rect(x + 8, y, cellW - 16, 3).fill({ color: cell.color });
      cell.name.position.set(x + cellW / 2, y + 12);
      cell.count.position.set(x + cellW / 2, y + 30);
    });
    return y + MATERIAL_CELL_H;
  }
}
