// The framed sheet a menu screen's content sits on (design/10 "One shell for every menu",
// 2026-09-27): a night-blue card with a crystal-cyan frame and a title plate across its top.
//
// It exists because every screen outside the lobby used to float its text and buttons straight
// on the backdrop, with nothing grouping them and nothing guaranteeing contrast. Contrast is the
// sheet's job now; the backdrop behind it is the lobby painting, only dimmed.
//
// Pure drawing: `layout(w, h)` draws a `w x h` card at the origin and returns where its content
// area starts. It holds no press targets, so the reflection harnesses (`widgetOverlap`,
// `labelFit`) never mistake it for one.
import { Container, Graphics, Text } from 'pixi.js';
import { MENU_COLORS, menuText } from './menuTheme';

const RADIUS = 14;
/** The title plate's height, and the padding the content area keeps inside the frame. */
export const SHEET_TITLE_H = 58;
export const SHEET_PAD = 24;
/** The corner crystals' half-size. */
const GEM = 5;

export class MenuSheet {
  readonly view = new Container();
  private readonly body = new Graphics();
  /** Public for tests and for a screen that reads its title back; set it with `setTitle`. */
  readonly title: Text;
  private readonly gems = new Graphics();
  private w = 0;
  private h = 0;

  constructor(title = '') {
    this.title = new Text({ text: title, style: menuText('title', { fontSize: 24 }) });
    this.title.anchor.set(0.5);
    this.body.eventMode = 'none';
    this.gems.eventMode = 'none';
    this.title.eventMode = 'none';
    this.view.addChild(this.body, this.gems, this.title);
  }

  get width(): number {
    return this.w;
  }

  get height(): number {
    return this.h;
  }

  setTitle(text: string): void {
    this.title.text = text;
    this.title.visible = text !== '';
    if (this.w > 0) this.layout(this.w, this.h);
  }

  /** Draw the card at `w x h`; the content area is `SHEET_PAD` inside the frame, under the
   *  title plate (or from the top, when there is no title). */
  layout(w: number, h: number): { x: number; y: number; w: number; h: number } {
    this.w = w;
    this.h = h;
    const hasTitle = this.title.visible && this.title.text !== '';
    const plateH = hasTitle ? SHEET_TITLE_H : 0;
    const c = MENU_COLORS;
    this.body.clear()
      // A soft drop shadow, so the card sits ON the painting rather than in it.
      .roundRect(0, 8, w, h, RADIUS).fill({ color: 0x000000, alpha: 0.28 })
      .roundRect(0, 0, w, h, RADIUS).fill({ color: c.sheet, alpha: c.sheetAlpha });
    if (hasTitle) {
      this.body
        .roundRect(0, 0, w, plateH, RADIUS).fill({ color: 0x15233b, alpha: 0.9 })
        .rect(0, plateH - RADIUS, w, RADIUS).fill({ color: 0x15233b, alpha: 0.9 })
        .rect(SHEET_PAD, plateH - 1, w - SHEET_PAD * 2, 1).fill({ color: c.frame, alpha: 0.45 });
    }
    this.body
      .roundRect(4.5, 4.5, w - 9, h - 9, RADIUS - 4).stroke({ color: c.frameInner, width: 1, alpha: 0.9 })
      .roundRect(1, 1, w - 2, h - 2, RADIUS).stroke({ color: c.frame, width: 2, alpha: 0.75 });

    // Crystals on the four corners and either side of the title: the one ornament the sheet
    // carries, taken from the painting's own crystals.
    this.gems.clear();
    const gem = (x: number, y: number, s: number) => {
      this.gems.poly([x, y - s * 1.5, x + s, y, x, y + s * 1.5, x - s, y]).fill({ color: c.frame, alpha: 0.95 });
    };
    gem(RADIUS * 0.6, RADIUS * 0.6, GEM * 0.8);
    gem(w - RADIUS * 0.6, RADIUS * 0.6, GEM * 0.8);
    gem(RADIUS * 0.6, h - RADIUS * 0.6, GEM * 0.8);
    gem(w - RADIUS * 0.6, h - RADIUS * 0.6, GEM * 0.8);
    if (hasTitle) {
      this.title.position.set(w / 2, plateH / 2 + 1);
      // Estimated rather than measured (`Text.width` needs a canvas): 0.6em per glyph plus
      // the letter spacing, which is the same estimate the button labels use.
      const titleW = [...this.title.text].length * (24 * 0.6 + 2);
      const off = titleW / 2 + 18;
      gem(w / 2 - off, plateH / 2 + 1, GEM);
      gem(w / 2 + off, plateH / 2 + 1, GEM);
    }
    return { x: SHEET_PAD, y: plateH + (hasTitle ? 18 : SHEET_PAD), w: w - SHEET_PAD * 2, h: h - plateH - (hasTitle ? 18 : SHEET_PAD) - SHEET_PAD };
  }
}

/** A section heading's row inside a sheet: the label, then a frame-cyan hairline under it. */
export const SHEET_HEADING_H = 28;

/** Place a section heading at `(x, y)` and draw its `w`-wide hairline into `rules`; returns
 *  the y under the heading row. Shared by every sheet that splits into sections. */
export function placeHeading(text: Text, rules: Graphics, x: number, y: number, w: number): number {
  text.position.set(x, y);
  rules.rect(x, y + SHEET_HEADING_H - 8, w, 1).fill({ color: MENU_COLORS.frame, alpha: 0.45 });
  return y + SHEET_HEADING_H;
}
