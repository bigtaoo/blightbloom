// The lobby's material readout (design/10 "The lobby, redesigned", 2026-09-27): one chip per
// element in the top-right corner, beside SETTINGS. The same numbers the Loadout screen shows
// as a line of text, moved to the front door because they are what decides whether a trip to
// the forge is worth making. Glyphs come from `elementIcons.ts`, so it needs no art.
import { Container, Graphics, Text } from 'pixi.js';
import { DAMAGE_TYPES, type DamageType } from '@dd/engine';
import { drawElementGlyph } from '../elementIcons';
import { elementColor } from '../theme';
import { estimateMonoWidth } from './textWidth';

export type MaterialCounts = Readonly<Partial<Record<DamageType, number>>>;

const CHIP_H = 28;
const CHIP_GAP = 6;
const GLYPH_R = 7;
const FONT = 13;
const CHIP_FILL = 0x141a26;

/** `1234` → `1234`, `12345` → `12k` — a chip is sized for four digits. */
export function compactCount(n: number): string {
  if (n < 10000) return String(n);
  if (n < 1_000_000) return `${Math.floor(n / 1000)}k`;
  return `${Math.floor(n / 1_000_000)}m`;
}

export class LobbyResources {
  readonly view = new Container();
  private chips = new Graphics();
  private labels: Text[];
  private counts: MaterialCounts = {};
  private totalW = 0;

  constructor() {
    this.labels = DAMAGE_TYPES.map(() => {
      const label = new Text({ text: '0', style: { fill: 0xf7fafc, fontSize: FONT, fontFamily: 'monospace', fontWeight: 'bold', padding: 8 } });
      label.anchor.set(0, 0.5);
      return label;
    });
    this.view.addChild(this.chips, ...this.labels);
    this.view.eventMode = 'none';
  }

  /** The row's width at the counts last `set` — for the caller laying out beside it. */
  get width(): number {
    return this.totalW;
  }

  get height(): number {
    return CHIP_H;
  }

  set(counts: MaterialCounts): void {
    this.counts = counts;
    this.redraw();
  }

  /** Draws from x = 0 rightwards; the caller right-aligns the row with `width`. */
  private redraw(): void {
    this.chips.clear();
    let x = 0;
    DAMAGE_TYPES.forEach((e, i) => {
      // A corrupted save can carry a non-number here (`accountSync.test.ts` has the string
      // case); a chip reading "NaN" is worse than one reading 0.
      const n = this.counts[e];
      const text = compactCount(typeof n === 'number' && Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0);
      const label = this.labels[i]!;
      label.text = text;
      const w = 8 + GLYPH_R * 2 + 6 + estimateMonoWidth(text, FONT) + 10;
      this.chips.roundRect(x, 0, w, CHIP_H, CHIP_H / 2).fill({ color: CHIP_FILL, alpha: 0.8 });
      this.chips.roundRect(x + 0.5, 0.5, w - 1, CHIP_H - 1, CHIP_H / 2).stroke({ color: elementColor(e), width: 1, alpha: 0.6 });
      drawElementGlyph(this.chips, e, x + 8 + GLYPH_R, CHIP_H / 2, GLYPH_R, elementColor(e), CHIP_FILL);
      label.position.set(x + 8 + GLYPH_R * 2 + 6, CHIP_H / 2);
      x += w + CHIP_GAP;
    });
    this.totalW = x - CHIP_GAP;
  }
}
