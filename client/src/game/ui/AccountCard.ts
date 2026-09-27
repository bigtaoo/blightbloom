// The lobby's account card (design/10 "The lobby becomes a scene", 2026-09-27): who the player
// is, top-left — an avatar disc, the name, and one line under it saying what the account does
// for them. It replaced a plain `Button` reading LOGIN or the bare name, with the guest's
// "log in to save progress" hanging loose under it.
//
// ## Why not a `Button`
//
// A `Button` has one label; this has two lines and a drawn avatar. It keeps `Button`'s SHAPE on
// purpose, for the same reason `LobbyCard` does: `labelFit`, `viewportFit` and `widgetOverlap`
// find press targets by reflection — child 0 is the press box, the first `Text` child is the
// label, and it has `onTap`, `setText` and `setIcon`.
//
// ## The avatar
//
// There is no uploaded picture to show, and the account model has none. A signed-in player gets
// their name's initial on a disc whose hue is hashed from the name, so it is theirs and it is
// stable across sessions and devices; a guest gets the account glyph on a neutral disc.
import { Container, Graphics, Sprite, Text, Texture } from 'pixi.js';
import { playUiCue } from '../../audio/uiSound';
import { estimateMonoWidth } from './textWidth';

const RADIUS = 10;
const PAD = 5;
const GAP = 8;
const RIGHT_PAD = 12;
const NAME_FONT = 14;
const HINT_FONT = 10;
/** The card's narrowest width, so a short name does not shrink it to a pill. */
const MIN_W = 120;
const FILL = 0x1f2532;
const GUEST_DISC = 0x4a5568;
/** Avatar hues: saturated enough to read as a colour on the dark card, dark enough for a white
 *  initial. Eight, so two players on one device rarely share one. */
const AVATAR_HUES = [0x6b46c1, 0x2b6cb0, 0x2c7a7b, 0x2f855a, 0xb7791f, 0xc05621, 0xc53030, 0xb83280];

/** A stable avatar colour for a name: FNV-1a over its UTF-16 code units. */
export function avatarColor(name: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return AVATAR_HUES[h % AVATAR_HUES.length]!;
}

/** The name's first character, upper-cased — a whole code point, so an astral character is
 *  not split into half a surrogate pair. */
export function initialOf(name: string): string {
  const first = [...name.trim()][0] ?? '';
  return first.toUpperCase();
}

export class AccountCard {
  readonly view = new Container();
  /** Child 0 — the press box. See the file header for why its index is load-bearing. */
  private box = new Graphics();
  private hover = new Graphics();
  private disc = new Graphics();
  private label: Text;
  private hint: Text;
  private initial: Text;
  private iconSprite = new Sprite();
  private w = MIN_W;
  private readonly h: number;
  /** Read by `LobbyRoutes.test.ts`: TUTORIAL must not borrow this colour. */
  readonly borderColor = 0xb794f4;
  /** The signed-in name the avatar is drawn from; `null` draws the guest's glyph. */
  private avatarName: string | null = null;
  private glyph: Texture | undefined;
  onTap: (() => void) | null = null;

  constructor(text: string, h: number) {
    this.h = h;
    this.label = new Text({ text, style: { fill: 0xffffff, fontSize: NAME_FONT, fontFamily: 'monospace', fontWeight: 'bold', padding: 12, stroke: { color: 0x0b0e14, width: 3 } } });
    this.label.anchor.set(0, 0.5);
    this.hint = new Text({ text: '', style: { fill: 0xfbd38d, fontSize: HINT_FONT, fontFamily: 'monospace', fontWeight: 'bold', padding: 8, stroke: { color: 0x0b0e14, width: 3 } } });
    this.hint.anchor.set(0, 0.5);
    this.hint.visible = false;
    this.initial = new Text({ text: '', style: { fill: 0xffffff, fontSize: Math.round(h * 0.42), fontFamily: 'sans-serif', fontWeight: 'bold', padding: 8 } });
    this.initial.anchor.set(0.5);
    this.iconSprite.anchor.set(0.5);
    for (const node of [this.label, this.hint, this.initial, this.iconSprite]) node.eventMode = 'none';
    this.hover.visible = false;
    // The label BEFORE the initial: the harnesses take the first `Text` child as the label.
    this.view.addChild(this.box, this.hover, this.disc, this.label, this.hint, this.initial, this.iconSprite);
    this.view.eventMode = 'static';
    this.view.cursor = 'pointer';
    this.view.on('pointertap', () => {
      this.onTap?.();
      playUiCue('ui.tap');
    });
    this.view.on('pointerdown', (e) => e.stopPropagation());
    this.view.on('pointerover', () => { this.hover.visible = true; });
    this.view.on('pointerout', () => { this.hover.visible = false; });
    this.redraw();
  }

  get width(): number {
    return this.w;
  }

  get height(): number {
    return this.h;
  }

  setText(text: string): void {
    this.label.text = text;
    this.redraw();
  }

  /** The line under the name; empty hides it and centres the name. */
  setHint(text: string): void {
    this.hint.text = text;
    this.hint.visible = text !== '';
    this.redraw();
  }

  /** Draw a signed-in player's initial avatar, or the guest's glyph with `null`. */
  setAvatar(name: string | null): void {
    this.avatarName = name && initialOf(name) !== '' ? name : null;
    this.redraw();
  }

  /** The guest's glyph. `chipColor` is accepted for `Button` parity and ignored — the disc
   *  behind the glyph is the avatar's. */
  setIcon(texture: Texture | undefined, _chipColor?: number): void {
    this.glyph = texture;
    this.redraw();
  }

  private redraw(): void {
    const h = this.h;
    const d = h - PAD * 2;
    const textLeft = PAD + d + GAP;
    const nameW = estimateMonoWidth(this.label.text, NAME_FONT);
    const hintW = this.hint.visible ? estimateMonoWidth(this.hint.text, HINT_FONT) : 0;
    this.w = Math.max(MIN_W, Math.ceil(textLeft + Math.max(nameW, hintW) + RIGHT_PAD));
    const w = this.w;
    const r = Math.min(RADIUS, h / 2);

    this.box.clear()
      .roundRect(0, 0, w, h, r).fill({ color: FILL, alpha: 0.92 })
      // `Button`'s own border, so the card and SETTINGS measure the same row height.
      .roundRect(0.5, 0.5, w - 1, h - 1, r).stroke({ color: this.borderColor, width: 1.5, alpha: 0.9 });
    this.hover.clear().roundRect(0, 0, w, h, r).fill({ color: 0xffffff, alpha: 0.08 });

    const cx = PAD + d / 2;
    const cy = h / 2;
    const signedIn = this.avatarName !== null;
    this.disc.clear()
      .circle(cx, cy, d / 2).fill({ color: signedIn ? avatarColor(this.avatarName!) : GUEST_DISC })
      .circle(cx, cy, d / 2).stroke({ color: 0xffffff, width: 1.5, alpha: 0.35 });
    this.initial.visible = signedIn;
    this.initial.text = signedIn ? initialOf(this.avatarName!) : '';
    this.initial.position.set(cx, cy);
    this.iconSprite.visible = !signedIn && !!this.glyph;
    if (this.glyph) {
      this.iconSprite.texture = this.glyph;
      const s = (d * 0.62) / Math.max(this.glyph.width, this.glyph.height, 1);
      this.iconSprite.scale.set(s);
      this.iconSprite.position.set(cx, cy);
    }

    if (this.hint.visible) {
      const block = NAME_FONT + 3 + HINT_FONT;
      const top = (h - block) / 2;
      this.label.position.set(textLeft, top + NAME_FONT / 2);
      this.hint.position.set(textLeft, top + NAME_FONT + 3 + HINT_FONT / 2);
    } else {
      this.label.position.set(textLeft, h / 2);
    }
  }
}
