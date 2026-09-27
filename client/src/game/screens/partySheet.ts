// PartyScreen split: the squad sheet's geometry — its constants, the two flows (the front door
// out of a party, the room once in one) and the seat rows. Free functions over the screen's
// widgets, so the widgets stay fields on `PartyScreen`, where the reflection harnesses and tests
// read them.
import type { Graphics, Text } from 'pixi.js';
import type { Button } from '../ui/widgets';
import { SHEET_PAD, SHEET_TITLE_H, placeHeading } from '../ui/MenuSheet';
import { MENU_COLORS } from '../ui/menuTheme';

/** The sheet's width, and the content width inside its padding. */
export const SHEET_W = 440;
export const CONTENT_W = SHEET_W - SHEET_PAD * 2;
export const PRIMARY_H = 48;
export const ACTION_H = 44;
export const LEAVE_H = 40;
/** The room code's box, and one seat row's height and pitch. */
const CODE_BOX_H = 58;
export const SEAT_H = 36;
const SEAT_GAP = 8;
const SEAT_PITCH = SEAT_H + SEAT_GAP;
const GAP = 10;
/** The status line keeps one line's room whether or not it has anything to say, so a one-line
 *  error appearing does not resize the sheet, and move the buttons, under the player's finger. */
const STATUS_H = 28;

/** Every widget the flows place. */
export interface PartySheetParts {
  rules: Graphics;
  /** The code box and the seat boxes — drawn, not pressed. */
  boxes: Graphics;
  introText: Text;
  codeHeading: Text;
  codeText: Text;
  codeHint: Text;
  membersHeading: Text;
  /** One label per seat, `capacity` of them showing; the rest hidden. */
  seatTexts: readonly Text[];
  waitingText: Text;
  statusText: Text;
  createCoopBtn: Button;
  createBtn: Button;
  joinBtn: Button;
  startBtn: Button;
  leaveBtn: Button;
}

/** What the flow depends on: which door, and how many seats the room has and has filled. */
export interface PartySheetState {
  inParty: boolean;
  capacity: number;
  /** Seats taken; the rest are drawn as open. */
  members: number;
}

/** Flow whichever rows are showing and return the SHEET's height (title plate and padding
 *  included). Wrapped text (the intro, the status line) is measured; its length is a
 *  translation's. */
export function layoutPartySheet(p: PartySheetParts, s: PartySheetState): number {
  p.rules.clear();
  p.boxes.clear();
  const y = s.inParty ? roomFlow(p, s) : doorFlow(p);
  p.statusText.position.set(CONTENT_W / 2, y);
  return SHEET_TITLE_H + 18 + y + Math.max(STATUS_H, p.statusText.height) + SHEET_PAD;
}

/** Out of a party: what this screen is for, then the three ways in. Co-op first and primary:
 *  it is the mode a pair of friends most often means by "play together". */
function doorFlow(p: PartySheetParts): number {
  p.introText.position.set(CONTENT_W / 2, 0);
  let y = p.introText.height + 16;
  p.createCoopBtn.view.position.set(0, y);
  y += PRIMARY_H + GAP;
  p.createBtn.view.position.set(0, y);
  y += ACTION_H + GAP;
  p.joinBtn.view.position.set(0, y);
  return y + ACTION_H + 12;
}

/** In a party: the code to share, the seats, then START (the leader) or who it waits on (a
 *  member), and LEAVE. */
function roomFlow(p: PartySheetParts, s: PartySheetState): number {
  const c = MENU_COLORS;
  let y = placeHeading(p.codeHeading, p.rules, 0, 0, CONTENT_W);
  p.boxes.roundRect(0, y, CONTENT_W, CODE_BOX_H, 10).fill({ color: c.field, alpha: 0.95 })
    .roundRect(0, y, CONTENT_W, CODE_BOX_H, 10).stroke({ color: c.frame, width: 1.5, alpha: 0.6 });
  p.codeText.position.set(CONTENT_W / 2, y + CODE_BOX_H / 2);
  y += CODE_BOX_H + 6;
  p.codeHint.position.set(CONTENT_W / 2, y);
  y += p.codeHint.height + 12;

  y = placeHeading(p.membersHeading, p.rules, 0, y, CONTENT_W);
  // A squad's four seats sit two by two: a seat holds a short name, and a single column of four
  // would push START off a landscape phone.
  const cols = s.capacity > 2 ? 2 : 1;
  const seatW = (CONTENT_W - (cols - 1) * SEAT_GAP) / cols;
  p.seatTexts.forEach((seat, i) => {
    seat.visible = i < s.capacity;
    if (!seat.visible) return;
    const left = (i % cols) * (seatW + SEAT_GAP);
    const top = y + Math.floor(i / cols) * SEAT_PITCH;
    const open = i >= s.members;
    p.boxes.roundRect(left, top, seatW, SEAT_H, 8).fill({ color: c.field, alpha: open ? 0.45 : 0.95 })
      .roundRect(left, top, seatW, SEAT_H, 8).stroke({ color: c.fieldBorder, width: 1, alpha: open ? 0.5 : 1 });
    seat.position.set(left + 14, top + SEAT_H / 2);
  });
  y += Math.ceil(s.capacity / cols) * SEAT_PITCH + 8;

  p.startBtn.view.position.set(0, y);
  p.waitingText.position.set(CONTENT_W / 2, y + PRIMARY_H / 2);
  y += PRIMARY_H + GAP;
  p.leaveBtn.view.position.set(0, y);
  return y + LEAVE_H + 12;
}
