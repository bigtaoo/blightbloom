// LoginScreen split: the account sheet's geometry — its constants, the top-to-bottom flow of
// whichever rows are showing, and the avatar disc. Free functions over the screen's widgets, so
// the widgets stay fields on `LoginScreen`, where the reflection harnesses and tests read them.
import type { Graphics, Sprite, Text } from 'pixi.js';
import type { Button } from '../ui/widgets';
import { FIELD_H, type FormField } from '../ui/FormField';
import { SHEET_PAD, SHEET_TITLE_H } from '../ui/MenuSheet';
import { MENU_COLORS } from '../ui/menuTheme';
import { avatarColor, initialOf } from '../ui/AccountCard';
import { getUiTexture } from '../../render/uiSkins';

/** The sheet's width, and the content width inside its padding. */
export const SHEET_W = 460;
export const CONTENT_W = SHEET_W - SHEET_PAD * 2;
/** The identity row: the avatar disc, and the text column beside it. */
export const AVATAR = 52;
export const ID_TEXT_X = AVATAR + 14;
const ID_H = 60;
const GAP = 14;
export const TAB_H = 38;
export const BUTTON_H = 46;
export const LOGOUT_H = 34;
const STATUS_H = 26;

/** Every widget the flow places. */
export interface LoginSheetParts {
  whoText: Text;
  standingText: Text;
  statusText: Text;
  privacyText: Text;
  privacyLink: Text;
  rule: Graphics;
  loginBtn: Button;
  registerBtn: Button;
  changePasswordBtn: Button;
  logoutBtn: Button;
  submitBtn: Button;
  userField: FormField;
  passField: FormField;
  oldPassField: FormField;
  newPassField: FormField;
}

/**
 * Flow the visible rows top to bottom and return the SHEET's height (title plate and padding
 * included). The fixed-height rows (tabs, fields, buttons) use their constants; the wrapped text
 * (the standing line, the status line, the notice) is measured, since its length is a
 * translation's.
 */
export function layoutLoginSheet(p: LoginSheetParts, loggedIn: boolean, passwordOpen: boolean): number {
  p.whoText.position.set(ID_TEXT_X, 4);
  p.standingText.position.set(ID_TEXT_X, 30);
  // Signed in, LOG OUT shares the identity row, and the name wraps short of it.
  const nameRoom = loggedIn ? CONTENT_W - ID_TEXT_X - p.logoutBtn.width - 10 : CONTENT_W - ID_TEXT_X;
  if (loggedIn) p.logoutBtn.view.position.set(CONTENT_W - p.logoutBtn.width, (AVATAR - LOGOUT_H) / 2);
  p.whoText.style.wordWrapWidth = nameRoom;
  p.standingText.style.wordWrapWidth = nameRoom;
  let y = Math.max(ID_H, 30 + p.standingText.height) + GAP;

  if (!loggedIn) {
    p.loginBtn.view.position.set(0, y);
    p.registerBtn.view.position.set(CONTENT_W - p.registerBtn.width, y);
    y += TAB_H + GAP + 2;
    p.userField.view.position.set(0, y);
    y += FIELD_H + 10;
    p.passField.view.position.set(0, y);
    y += FIELD_H + 8;
  } else {
    p.changePasswordBtn.view.position.set(0, y);
    y += TAB_H + (passwordOpen ? GAP + 2 : 8);
    if (passwordOpen) {
      p.oldPassField.view.position.set(0, y);
      y += FIELD_H + 10;
      p.newPassField.view.position.set(0, y);
      y += FIELD_H + 8;
    }
  }

  p.statusText.position.set(CONTENT_W / 2, y);
  // The status row keeps its room above a primary button, so an error appearing does not move
  // the button out from under the pointer; with no button under it, it takes none.
  const statusRoom = p.statusText.text ? p.statusText.height + 6 : 0;
  y += p.submitBtn.view.visible ? Math.max(STATUS_H, statusRoom) : statusRoom;
  if (p.submitBtn.view.visible) {
    p.submitBtn.view.position.set(0, y);
    y += BUTTON_H;
  }

  p.rule.clear();
  if (p.privacyText.visible) {
    y += 18;
    p.rule.rect(0, y, CONTENT_W, 1).fill({ color: MENU_COLORS.frameInner, alpha: 1 });
    y += 12;
    p.privacyText.position.set(CONTENT_W / 2, y);
    y += p.privacyText.height + 2;
    if (p.privacyLink.visible) {
      p.privacyLink.position.set(CONTENT_W / 2, y);
      y += p.privacyLink.height;
    }
  }
  // `MenuSheet.layout`'s own sums: the title plate, the gap under it, and the bottom padding.
  return SHEET_TITLE_H + 18 + y + SHEET_PAD;
}

/** The avatar: a signed-in player's initial on their name's hue (the lobby card's), or the
 *  account glyph on a neutral disc for a guest. */
export function drawLoginAvatar(
  parts: { avatar: Graphics; avatarInitial: Text; avatarGlyph: Sprite },
  name: string | null,
): void {
  const signedIn = name !== null && initialOf(name) !== '';
  const r = AVATAR / 2;
  parts.avatar.clear()
    .circle(r, r, r).fill({ color: signedIn ? avatarColor(name!) : 0x4a5568 })
    .circle(r, r, r).stroke({ color: MENU_COLORS.frame, width: 2, alpha: 0.6 });
  parts.avatarInitial.visible = signedIn;
  parts.avatarInitial.text = signedIn ? initialOf(name!) : '';
  parts.avatarInitial.position.set(r, r);
  const glyph = getUiTexture('icon_account');
  parts.avatarGlyph.visible = !signedIn && !!glyph;
  if (glyph) {
    parts.avatarGlyph.texture = glyph;
    parts.avatarGlyph.scale.set((AVATAR * 0.6) / Math.max(glyph.width, glyph.height, 1));
    parts.avatarGlyph.position.set(r, r);
  }
}
