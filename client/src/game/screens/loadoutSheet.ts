// Loadout split: the sheet's geometry — the character block and the material bank side by side,
// the weapon row under its own heading, the saved-run line, and the action bar closing the
// sheet. Free functions over the screen's widgets, so the widgets stay fields on `Loadout`,
// where the reflection harnesses and tests read them (same shape as `settingsSheet.ts`).
import type { Graphics, Sprite, Text } from 'pixi.js';
import type { Button } from '../ui/widgets';
import { BlueprintCard } from '../ui/BlueprintCard';
import type { MaterialBank } from '../ui/MaterialBank';
import { SHEET_PAD, SHEET_TITLE_H, placeHeading } from '../ui/MenuSheet';
import { MENU_COLORS } from '../ui/menuTheme';

/** The sheet's width, and the content inside its padding. */
export const SHEET_W = 720;
export const CONTENT_W = SHEET_W - SHEET_PAD * 2;
/** The character block: the portrait's square, and the text column beside it. */
export const PORTRAIT = 112;
export const CHAR_TEXT_X = PORTRAIT + 16;
/** The two halves of the top row: the character on the left, the material bank on the right. */
export const HALF_GAP = 40;
export const HALF_W = (CONTENT_W - HALF_GAP) / 2;
export const MAT_X = HALF_W + HALF_GAP;
/** The ‹ › pair under the character's text. */
export const ARROW_W = 36;
export const ARROW_H = 30;
/** The action bar's buttons. */
export const ACTION_H = 46;
const ACTION_GAP = 12;
/** One card per loadout slot plus the forge card, in one centred row. */
export const WEAPON_GAP = 14;

export interface LoadoutSheetParts {
  portraitFrame: Graphics;
  portraitFallback: Graphics;
  portrait: Sprite | null;
  charName: Text;
  charStats: Text;
  charOwned: Text;
  prevCharBtn: Button;
  nextCharBtn: Button;
  bank: MaterialBank;
  weaponsHeading: Text;
  /** The weapon cards that are drawn, then the forge card. */
  cards: readonly BlueprintCard[];
  savedText: Text;
  clearBtn: Button;
  startBtn: Button;
  continueBtn: Button;
  hint: Text;
  /** The weapons heading's hairline and the footer rule — one Graphics. */
  rules: Graphics;
}

/** The portrait on the left, name / pools / roster count beside it, the cycle pair under them. */
function characterBlock(p: LoadoutSheetParts): void {
  p.portraitFrame.position.set(0, 0);
  p.portraitFallback.position.set(0, 0);
  p.portrait?.position.set(PORTRAIT / 2, PORTRAIT / 2);
  const room = HALF_W - CHAR_TEXT_X;
  p.charName.style.wordWrapWidth = room;
  p.charName.position.set(CHAR_TEXT_X, 2);
  p.charStats.position.set(CHAR_TEXT_X, 36);
  p.charOwned.position.set(CHAR_TEXT_X, 60);
  p.prevCharBtn.view.position.set(CHAR_TEXT_X, PORTRAIT - ARROW_H);
  p.nextCharBtn.view.position.set(CHAR_TEXT_X + ARROW_W + 8, PORTRAIT - ARROW_H);
}

/**
 * The action bar. Without a saved run: CLEAR on the left, START RUN on the right. With one,
 * CONTINUE takes the right-hand slot (it is what the player came back for) and START RUN — now
 * "start over instead" — sits to its left. A translation too long for one row moves CLEAR up a
 * row of its own rather than letting the three overlap. Returns the bar's bottom.
 */
function actionBar(p: LoadoutSheetParts, y: number, saved: boolean): number {
  const right = saved ? p.continueBtn : p.startBtn;
  right.view.position.set(CONTENT_W - right.width, y);
  let pairLeft = CONTENT_W - right.width;
  if (saved) {
    pairLeft -= ACTION_GAP + p.startBtn.width;
    p.startBtn.view.position.set(pairLeft, y);
  }
  p.clearBtn.view.position.set(0, y);
  if (p.clearBtn.width + ACTION_GAP <= pairLeft) return y + ACTION_H;
  // Too long for one row: CLEAR stays above, the primary pair drops under it.
  const below = y + ACTION_H + 10;
  right.view.position.y = below;
  if (saved) p.startBtn.view.position.y = below;
  return below + ACTION_H;
}

/**
 * Place every widget and return the SHEET's height (title plate and padding included). The
 * buttons are `autoWidth`, so a locale change moves them — which is why this runs on every
 * render, not only on a resize.
 */
export function layoutLoadoutSheet(p: LoadoutSheetParts, saved: boolean): number {
  p.rules.clear();
  characterBlock(p);
  p.bank.view.position.set(MAT_X, 0);
  p.bank.layout(HALF_W);

  let y = PORTRAIT + 22;
  y = placeHeading(p.weaponsHeading, p.rules, 0, y, CONTENT_W) + 8;
  const rowW = p.cards.length * BlueprintCard.W + (p.cards.length - 1) * WEAPON_GAP;
  const rowLeft = (CONTENT_W - rowW) / 2;
  p.cards.forEach((card, i) => card.view.position.set(rowLeft + i * (BlueprintCard.W + WEAPON_GAP), y));
  y += BlueprintCard.H + 14;

  if (saved) {
    p.savedText.style.wordWrapWidth = CONTENT_W;
    p.savedText.position.set(CONTENT_W / 2, y);
    y += p.savedText.height + 10;
  }

  p.rules.rect(0, y, CONTENT_W, 1).fill({ color: MENU_COLORS.frameInner, alpha: 0.8 });
  y = actionBar(p, y + 14, saved) + 10;
  p.hint.position.set(CONTENT_W / 2, y);
  y += 16;

  // `MenuSheet.layout`'s own sums: the title plate, the gap under it, and the bottom padding.
  return SHEET_TITLE_H + 18 + y + SHEET_PAD;
}
