// Forge split: the sheet's geometry — the material bank over the paged blueprint grid, and the
// side panel (what the run carries, the compare card, the forger and the store entry) either
// beside the grid or, on a viewport too narrow for that, under it. Free functions over the
// screen's widgets, so the widgets stay fields on `Forge`, where the reflection harnesses and
// tests read them (the same shape as `loadoutSheet.ts`).
import type { Graphics, Sprite, Text, Texture } from 'pixi.js';
import type { Button } from '../ui/widgets';
import { BlueprintCard } from '../ui/BlueprintCard';
import type { CompareCard } from '../ui/compareCard';
import type { MaterialBank } from '../ui/MaterialBank';
import { SHEET_PAD, SHEET_TITLE_H, placeHeading } from '../ui/MenuSheet';
import { MENU_COLORS } from '../ui/menuTheme';

/** Cards per page, as a `GRID_COLS`-wide grid. Paged, not scrolled — the arrow-key browse
 *  cursor already reaches any entry, flipping pages to keep itself visible. */
export const PAGE_SIZE = 8;
export const GRID_COLS = 4;
const GRID_GAP = 14;
const GRID_ROWS = Math.ceil(PAGE_SIZE / GRID_COLS);
export const GRID_W = GRID_COLS * BlueprintCard.W + (GRID_COLS - 1) * GRID_GAP;
export const GRID_H = GRID_ROWS * BlueprintCard.H + (GRID_ROWS - 1) * GRID_GAP;
/** The side column, and the gap (with a hairline down its middle) between it and the grid. */
export const SIDE_W = 300;
const SIDE_GAP = 32;
export const SIDE_X = GRID_W + SIDE_GAP;
/** The wide sheet (side column beside the grid) and the narrow one (the grid's width). */
export const WIDE_SHEET_W = SIDE_X + SIDE_W + SHEET_PAD * 2;
export const NARROW_SHEET_W = GRID_W + SHEET_PAD * 2;
/** The narrow layout's two half-columns under the grid: carrying, and compare. */
const HALF_GAP = 24;
export const NARROW_HALF_W = (GRID_W - HALF_GAP) / 2;
/** The ‹ PAGE / PAGE › pair under the grid, and the store button. */
export const PAGER_H = 30;
export const STORE_H = 40;
/** The forger is drawn only when at least this much of the column is left over. */
export const NPC_MIN_H = 72;
const NPC_MAX_H = 150;
/** `MenuShell`'s least margin either side of a sheet. */
const SHELL_MARGIN = 16;

/**
 * Whether a `w`-wide design space takes the wide sheet: only where it fits at full size. On a
 * portrait phone (the design width exactly) the wide sheet would shrink every card to about
 * three quarters; the narrow one keeps them at full size and spends the height that viewport
 * has plenty of instead.
 */
export function forgeIsWide(w: number): boolean {
  return w >= WIDE_SHEET_W + SHELL_MARGIN * 2;
}

/** The compare card's width in each layout. */
export function compareCardW(wide: boolean): number {
  return wide ? SIDE_W : NARROW_HALF_W;
}

export interface ForgeSheetParts {
  bank: MaterialBank;
  blueprintsHeading: Text;
  /** The whole pool, hidden ones included: the grid keeps its size on a partial page. */
  cards: readonly BlueprintCard[];
  prevPageBtn: Button;
  nextPageBtn: Button;
  pageLabel: Text;
  carryingHeading: Text;
  carryingText: Text;
  compareHeading: Text;
  compareCard: CompareCard;
  npc: Sprite;
  npcTexture: Texture | undefined;
  storeCaption: Text;
  storeBtn: Button;
  hint: Text;
  /** Headings' hairlines and the column divider — one Graphics. */
  rules: Graphics;
}

/** The bank, the grid and the pager; returns the column's bottom. */
function gridColumn(p: ForgeSheetParts): number {
  p.bank.view.position.set(0, 0);
  let y = p.bank.layout(GRID_W) + 18;
  y = placeHeading(p.blueprintsHeading, p.rules, 0, y, GRID_W) + 8;
  p.cards.forEach((card, slot) => {
    const col = slot % GRID_COLS;
    const row = Math.floor(slot / GRID_COLS);
    card.view.position.set(col * (BlueprintCard.W + GRID_GAP), y + row * (BlueprintCard.H + GRID_GAP));
  });
  y += GRID_H + 12;
  p.prevPageBtn.view.position.set(0, y);
  p.nextPageBtn.view.position.set(GRID_W - p.nextPageBtn.width, y);
  p.pageLabel.position.set(GRID_W / 2, y + PAGER_H / 2);
  return y + PAGER_H;
}

/** The CARRYING heading and the weapon names, `w` wide at `(x, y)`; returns their bottom. */
function carrying(p: ForgeSheetParts, x: number, y: number, w: number): number {
  y = placeHeading(p.carryingHeading, p.rules, x, y, w) + 4;
  p.carryingText.style.wordWrapWidth = w;
  p.carryingText.position.set(x, y);
  return y + p.carryingText.height;
}

/** The COMPARE heading and the card under it (when there is one); returns their bottom. */
function compare(p: ForgeSheetParts, x: number, y: number, w: number): number {
  y = placeHeading(p.compareHeading, p.rules, x, y, w) + 8;
  if (!p.compareCard.view.visible) return y;
  p.compareCard.view.position.set(x, y);
  return y + p.compareCard.view.height;
}

/**
 * The wide layout's side column: carrying and compare from the top, the store entry pinned to
 * the bottom (level with the pager), and the forger standing in whatever is left between them
 * — hidden when that is too little, rather than drawn over either.
 */
function sideColumn(p: ForgeSheetParts, bottom: number): void {
  const top = compare(p, SIDE_X, carrying(p, SIDE_X, 0, SIDE_W) + 16, SIDE_W) + 12;

  let floor = bottom;
  if (p.storeBtn.view.visible) {
    floor -= STORE_H;
    p.storeBtn.view.position.set(SIDE_X, floor);
    p.storeCaption.style.wordWrapWidth = SIDE_W;
    floor -= p.storeCaption.height + 6;
    p.storeCaption.position.set(SIDE_X, floor);
    floor -= 8;
  }

  const room = Math.min(NPC_MAX_H, floor - top);
  const tex = p.npcTexture;
  p.npc.visible = tex !== undefined && room >= NPC_MIN_H;
  if (tex && p.npc.visible) {
    p.npc.texture = tex;
    p.npc.scale.set(Math.min(room / tex.height, SIDE_W / tex.width));
    p.npc.position.set(SIDE_X + SIDE_W / 2, floor);
  }
}

/** The narrow layout's panel under the grid: carrying | compare, then the store row (caption
 *  left, button right). No room is set aside for the forger here. Returns its bottom. */
function underPanel(p: ForgeSheetParts, top: number): number {
  const right = NARROW_HALF_W + HALF_GAP;
  let y = Math.max(carrying(p, 0, top, NARROW_HALF_W), compare(p, right, top, NARROW_HALF_W));
  p.npc.visible = false;
  if (p.storeBtn.view.visible) {
    y += 16;
    const storeX = GRID_W - p.storeBtn.width;
    p.storeBtn.view.position.set(storeX, y);
    p.storeCaption.style.wordWrapWidth = storeX - 16;
    p.storeCaption.position.set(0, y + (STORE_H - p.storeCaption.height) / 2);
    y += Math.max(STORE_H, p.storeCaption.height);
  }
  return y;
}

/** Place every widget and return the SHEET's height (title plate and padding included). */
export function layoutForgeSheet(p: ForgeSheetParts, wide: boolean): number {
  p.rules.clear();
  let bottom = gridColumn(p);
  if (wide) {
    sideColumn(p, bottom);
    p.rules.rect(GRID_W + SIDE_GAP / 2, 0, 1, bottom).fill({ color: MENU_COLORS.frameInner, alpha: 0.8 });
  } else {
    bottom = underPanel(p, bottom + 18);
  }
  p.storeCaption.visible = p.storeBtn.view.visible;

  const y = bottom + 14;
  p.hint.position.set((wide ? WIDE_SHEET_W : NARROW_SHEET_W) / 2 - SHEET_PAD, y);
  // `MenuSheet.layout`'s own sums: the title plate, the gap under it, and the bottom padding.
  return SHEET_TITLE_H + 18 + y + 16 + SHEET_PAD;
}
