// Settings split: the sheet's geometry — two columns of titled sections (AUDIO on the left;
// DISPLAY and GAME on the right), each a list of rows that put the setting's NAME on the left and
// its VALUE on the right. Free functions over the screen's widgets, so the widgets stay fields on
// `Settings`, where the reflection harnesses and tests read them (same shape as `loginSheet.ts`).
import type { Graphics, Text } from 'pixi.js';
import type { Button } from '../ui/widgets';
import type { Slider } from '../ui/Slider';
import { SHEET_PAD, SHEET_TITLE_H } from '../ui/MenuSheet';
import { MENU_COLORS } from '../ui/menuTheme';

/** The sheet's width; the content inside its padding; the two columns and the gutter between. */
export const SHEET_W = 720;
export const CONTENT_W = SHEET_W - SHEET_PAD * 2;
export const COL_GAP = 36;
export const COL_W = (CONTENT_W - COL_GAP) / 2;
/** A section's heading row, a volume row (name and percentage over the track), an option row
 *  (name beside a value chip), and the value chip's and the full-width buttons' heights. */
export const HEADING_H = 28;
export const SLIDER_ROW_H = 62;
export const SLIDER_ROW_MAX_H = 84;
export const OPTION_ROW_H = 46;
export const CHIP_H = 34;
export const WIDE_BUTTON_H = 38;
const SECTION_GAP = 18;
/** Room kept between an option's name and its chip. */
const NAME_GAP = 12;

export interface SliderRow { label: Text; value: Text; slider: Slider }
export interface OptionRow { label: Text; btn: Button }

export interface SettingsSheetParts {
  audioHeading: Text;
  displayHeading: Text;
  gameHeading: Text;
  /** The hairlines under each heading and between rows — one Graphics, redrawn per layout. */
  rules: Graphics;
  volume: readonly SliderRow[];
  muteBtn: Button;
  display: readonly OptionRow[];
  game: readonly OptionRow[];
  tutorialBtn: Button;
  /** The music credits, under both columns and as wide as both. */
  credits: Text;
}

/** Heading text plus the hairline under it; returns the y the first row starts at. */
function heading(text: Text, rules: Graphics, x: number, y: number): number {
  text.position.set(x, y);
  rules.rect(x, y + HEADING_H - 8, COL_W, 1).fill({ color: MENU_COLORS.frame, alpha: 0.45 });
  return y + HEADING_H;
}

/** Name left, chip right-aligned, both centred on the row; a hairline between rows. The name
 *  wraps short of the chip, since both halves are translated and either can be the long one. */
function optionRows(rows: readonly OptionRow[], rules: Graphics, x: number, y: number): number {
  rows.forEach((row, i) => {
    const mid = y + OPTION_ROW_H / 2;
    row.btn.view.position.set(x + COL_W - row.btn.width, mid - CHIP_H / 2);
    row.label.style.wordWrapWidth = Math.max(40, COL_W - row.btn.width - NAME_GAP);
    row.label.position.set(x, mid);
    if (i < rows.length - 1) rules.rect(x, y + OPTION_ROW_H, COL_W, 1).fill({ color: MENU_COLORS.frameInner, alpha: 0.8 });
    y += OPTION_ROW_H;
  });
  return y;
}

/**
 * Place every widget and return the SHEET's height (title plate and padding included). Only
 * the chips' widths are read back — they are `autoWidth`, so a value or a locale change moves
 * them — which is why this runs after every `syncWidgets`, not only on a resize.
 */
export function layoutSettingsSheet(p: SettingsSheetParts): number {
  p.rules.clear();

  // Right column first — it is the taller list, and the left one is spread to match it:
  // DISPLAY, then GAME with REPLAY TUTORIAL closing it.
  const x = COL_W + COL_GAP;
  let right = optionRows(p.display, p.rules, x, heading(p.displayHeading, p.rules, x, 0));
  right += SECTION_GAP;
  right = optionRows(p.game, p.rules, x, heading(p.gameHeading, p.rules, x, right));
  right += 8;
  p.tutorialBtn.setWidth(COL_W);
  p.tutorialBtn.view.position.set(x, right);
  right += WIDE_BUTTON_H;

  // Left column: the three volumes, then MUTE on the same baseline as REPLAY TUTORIAL. The
  // volume rows share the height the right column leaves them, within bounds, so the two
  // columns end together instead of the left one stopping two rows short.
  const room = right - HEADING_H - 16 - WIDE_BUTTON_H;
  const rowH = Math.max(SLIDER_ROW_H, Math.min(SLIDER_ROW_MAX_H, room / p.volume.length));
  let left = heading(p.audioHeading, p.rules, 0, 0);
  for (const row of p.volume) {
    row.label.position.set(0, left + 4);
    row.value.position.set(COL_W, left + 4);
    row.slider.setWidth(COL_W - 20);
    row.slider.view.position.set(10, left + 40);
    left += rowH;
  }
  left = Math.max(left + 8, right - WIDE_BUTTON_H);
  p.muteBtn.setWidth(COL_W);
  p.muteBtn.view.position.set(0, left);
  left += WIDE_BUTTON_H;

  // The gutter's own hairline, so the two columns read as two lists rather than one ragged one.
  const columns = Math.max(left, right);
  p.rules.rect(COL_W + COL_GAP / 2, 4, 1, columns - 4).fill({ color: MENU_COLORS.frameInner, alpha: 0.8 });

  // The music credits close the sheet, across both columns: a licence condition rather than a
  // setting, so they sit below every control instead of inside a section.
  const creditsTop = columns + SECTION_GAP;
  p.rules.rect(0, creditsTop - SECTION_GAP / 2, CONTENT_W, 1).fill({ color: MENU_COLORS.frameInner, alpha: 0.8 });
  p.credits.style.wordWrapWidth = CONTENT_W;
  p.credits.position.set(0, creditsTop);
  const bottom = creditsTop + p.credits.height;

  // `MenuSheet.layout`'s own sums: the title plate, the gap under it, and the bottom padding.
  return SHEET_TITLE_H + 18 + bottom + SHEET_PAD;
}
