// The lobby's art-backed route card (design/10 "The lobby, redesigned", 2026-09-27): a press
// target that paints a banner illustration behind its label instead of a flat fill.
//
// ## Why not a `Button`
//
// `Button` fills its box at alpha 1, and the whole point of these cards is the art under the
// label. Rather than teach the shared widget a second fill mode (`widgets.ts` sits at the
// 500-line convention's edge), this is its own small class — but it keeps `Button`'s SHAPE on
// purpose, because three test harnesses find press targets by reflection rather than by type:
//
//  - child 0 is the press box, a `Graphics` exactly `w x h` (`widgetOverlap.test.ts` reads it);
//  - the first `Text` child is the label (`labelFit.test.ts` measures it against child 0);
//  - it has `onTap`, `setText` and `setIcon`, which is what both harnesses key on.
//
// ## The label shrinks to fit rather than overflowing
//
// A card is a fixed box on a painted banner; it cannot grow the way an `autoWidth` button
// does. So the label's font size is fitted to the room the card has, from the same
// monospace estimate every other layout here uses (`textWidth.ts`), and never grows past the
// size it was built with. Measured the other way round — a fixed size, checked afterwards —
// is how `PVP SOLO QUEUE` shipped past its box in seven locales on 2026-09-10.
import { Container, Graphics, Rectangle, Sprite, Text, Texture } from 'pixi.js';
import { getUiTexture } from '../../render/uiSkins';
import { playUiCue } from '../../audio/uiSound';
import { estimateMonoWidth } from './textWidth';
import { ArtFade } from './artFade';

export interface LobbyCardStyle {
  /** `uiSkins.ts` key of the banner art. Absent, or not loaded, leaves the flat `fill`. */
  art?: string;
  /** The backing fill — what the card is when its art has not loaded. */
  fill: number;
  /** The frame colour: the card's tier and route cue (green = go, teal = co-op, …). */
  frame: number;
  /** The label's LARGEST size; it only ever shrinks from here to fit. */
  fontSize: number;
  /** Draw the breathing outer glow — the one primary action on the screen, and nothing else. */
  glow?: boolean;
}

const RADIUS = 10;
/** The label's left inset, and the room kept at the right edge. */
const INSET = 16;
const RIGHT_PAD = 12;
/** Smallest a label or hint may be fitted down to before it is ellipsised instead. */
const MIN_FONT = 10;
const HINT_FONT = 12;
/** Vertical strips in the left-to-right legibility shade, and its darkest alpha. Strips
 *  rather than stacked rectangles: stacked translucent shapes compound, strips do not. */
const SHADE_STRIPS = 16;
const SHADE_MAX = 0.62;
/** The glow's breathing period. Slow on purpose — a fast pulse reads as an alarm. */
const GLOW_PERIOD_MS = 2400;

export class LobbyCard {
  readonly view = new Container();
  /** Child 0 — the press box. See the file header for why its index is load-bearing. */
  private box = new Graphics();
  private glow = new Graphics();
  private clip = new Container();
  private clipMask = new Graphics();
  private art = new Sprite();
  // The banner lands after the lobby's first frame on a cold boot (uiSkins.ts's `lobby` tier):
  // set while this card's art is named but not loaded, so its arrival fades in.
  private artPending = false;
  private readonly artFade = new ArtFade(this.art);
  private shade = new Graphics();
  private hover = new Graphics();
  private frame = new Graphics();
  private iconSprite: Sprite | null = null;
  private label: Text;
  private hint: Text;
  private w: number;
  private h: number;
  private style: LobbyCardStyle;
  private labelText: string;
  private hintText = '';
  private clockMs = 0;
  onTap: (() => void) | null = null;

  constructor(text: string, w: number, h: number, style: LobbyCardStyle) {
    this.w = w;
    this.h = h;
    this.style = { ...style };
    this.labelText = text;
    // Monospace for the same reason every Button label is: the fit below is an estimate of a
    // monospace run, and it is only honest for a monospace font. The stroke is what makes a
    // white label readable over the brightest part of any banner.
    this.label = new Text({ text, style: { fill: 0xffffff, fontSize: style.fontSize, fontFamily: 'monospace', fontWeight: 'bold', padding: 14, stroke: { color: 0x0b0e14, width: 4 } } });
    this.label.anchor.set(0, 0.5);
    this.label.eventMode = 'none';
    this.hint = new Text({ text: '', style: { fill: 0xe2e8f0, fontSize: HINT_FONT, fontFamily: 'monospace', padding: 10, stroke: { color: 0x0b0e14, width: 3 } } });
    this.hint.anchor.set(0, 0);
    this.hint.eventMode = 'none';
    this.hint.visible = false;

    this.clip.addChild(this.art, this.shade, this.hover);
    this.clip.mask = this.clipMask;
    this.hover.visible = false;
    this.view.addChild(this.box, this.glow, this.clip, this.clipMask, this.frame, this.label, this.hint);
    this.redraw();

    this.view.eventMode = 'static';
    this.view.cursor = 'pointer';
    this.view.on('pointertap', () => {
      this.onTap?.();
      playUiCue('ui.tap');
    });
    // Same guard `Button` carries: a card inside a screen with its own full-panel
    // `pointerdown` handler must not double-fire.
    this.view.on('pointerdown', (e) => e.stopPropagation());
    this.view.on('pointerover', () => { this.hover.visible = true; });
    this.view.on('pointerout', () => { this.hover.visible = false; });
  }

  get width(): number {
    return this.w;
  }

  get height(): number {
    return this.h;
  }

  /** Change the card's size — SOLO is a banner when it is the primary and a slim bar when it
   *  is not, and it is one widget either way so its tap target never changes identity. */
  resize(w: number, h: number): void {
    if (w === this.w && h === this.h) return;
    this.w = w;
    this.h = h;
    this.redraw();
  }

  setText(text: string): void {
    this.labelText = text;
    this.layoutText();
  }

  /** The one-line description under the label; empty hides it. */
  setHint(text: string): void {
    this.hintText = text;
    this.layoutText();
  }

  setFrame(color: number): void {
    if (this.style.frame === color) return;
    this.style.frame = color;
    this.redraw();
  }

  setFill(color: number): void {
    if (this.style.fill === color) return;
    this.style.fill = color;
    this.redraw();
  }

  /** Swap the banner art (or drop it with `undefined`) — the slim SOLO bar has none. */
  setArt(key: string | undefined): void {
    if (this.style.art === key) return;
    this.style.art = key;
    this.redraw();
  }

  setGlow(on: boolean): void {
    if (!!this.style.glow === on) return;
    this.style.glow = on;
    this.redraw();
  }

  /** A small leading glyph, left of the label. `chipColor` is accepted for `Button` parity and
   *  ignored — the banner behind the icon already separates it from the card. */
  setIcon(texture: Texture | undefined, _chipColor?: number): void {
    if (!texture) {
      this.iconSprite?.destroy();
      this.iconSprite = null;
    } else {
      if (!this.iconSprite) {
        this.iconSprite = new Sprite();
        this.iconSprite.anchor.set(0.5);
        this.iconSprite.eventMode = 'none';
        this.view.addChildAt(this.iconSprite, this.view.getChildIndex(this.label));
      }
      this.iconSprite.texture = texture;
    }
    this.layoutText();
  }

  /** Pick up banner art that has landed since the last draw — `MainMenu` calls this as lobby
   *  art arrives. A no-op unless this card is still waiting on its art. */
  refreshArt(): void {
    if (this.artPending) this.redraw();
  }

  /** Advance the art's fade-in and the primary card's glow (a no-op on every other card). */
  update(dtMs: number): void {
    this.artFade.update(dtMs);
    if (!this.style.glow) return;
    this.clockMs = (this.clockMs + dtMs) % GLOW_PERIOD_MS;
    this.glow.alpha = 0.55 + 0.45 * Math.sin((this.clockMs / GLOW_PERIOD_MS) * Math.PI * 2);
  }

  private iconBox(): number {
    return Math.round(Math.min(36, this.h * 0.46));
  }

  private redraw(): void {
    const { w, h } = this;
    const r = Math.min(RADIUS, h / 2);
    this.box.clear().roundRect(0, 0, w, h, r).fill({ color: this.style.fill, alpha: 1 });
    this.clipMask.clear().roundRect(0, 0, w, h, r).fill({ color: 0xffffff });

    const texture = this.style.art ? getUiTexture(this.style.art) : undefined;
    this.art.visible = !!texture;
    if (texture && this.artPending) this.artFade.start();
    this.artPending = !!this.style.art && !texture;
    if (texture) {
      // Cover, cropped through the texture's own frame rather than by overflowing the card:
      // the sprite is then exactly the card's size, so nothing it draws can stick out past
      // the box a layout sweep measures. The crop keeps the banner's RIGHT side, where every
      // prompt put its subject — the left is the calm area the label sits on.
      const src = texture.frame;
      const aspect = w / h;
      let fw = src.width;
      let fh = fw / aspect;
      if (fh > src.height) {
        fh = src.height;
        fw = fh * aspect;
      }
      const fx = src.x + (src.width - fw);
      const fy = src.y + (src.height - fh) / 2;
      this.art.texture = new Texture({ source: texture.source, frame: new Rectangle(fx, fy, fw, fh) });
      this.art.width = w;
      this.art.height = h;
    }

    // The legibility shade: dark on the left where the label is, clear by 70% of the way
    // across, so the art's subject on the right stays at full value.
    this.shade.clear();
    const stripW = (w * 0.7) / SHADE_STRIPS;
    for (let i = 0; i < SHADE_STRIPS; i++) {
      const f = 1 - i / SHADE_STRIPS;
      this.shade.rect(i * stripW, 0, stripW + 0.5, h).fill({ color: 0x05070c, alpha: SHADE_MAX * f * f });
    }
    this.hover.clear().rect(0, 0, w, h).fill({ color: 0xffffff, alpha: 0.08 });

    this.frame.clear()
      .roundRect(1, 1, w - 2, h - 2, r).stroke({ color: this.style.frame, width: 2.5, alpha: 1 })
      .roundRect(3.5, 3.5, w - 7, h - 7, Math.max(0, r - 2.5)).stroke({ color: 0xffffff, width: 1, alpha: 0.18 });

    // Four expanding rings on a squared falloff — the band idiom, so the glow reads as light
    // and not as a second, fatter frame.
    this.glow.clear();
    if (this.style.glow) {
      for (let i = 1; i <= 4; i++) {
        const f = 1 - (i - 1) / 4;
        this.glow.roundRect(-i * 2, -i * 2, w + i * 4, h + i * 4, r + i * 2).stroke({ color: this.style.frame, width: 2, alpha: 0.32 * f * f });
      }
    }
    this.glow.visible = !!this.style.glow;
    this.layoutText();
  }

  private layoutText(): void {
    const { w, h } = this;
    let left = INSET;
    if (this.iconSprite) {
      const box = this.iconBox();
      const tex = this.iconSprite.texture;
      this.iconSprite.scale.set(Math.min(box / tex.width, box / tex.height));
      this.iconSprite.position.set(INSET + box / 2, h / 2);
      left = INSET + box + 10;
    }
    const room = w - left - RIGHT_PAD;
    this.label.text = this.labelText;
    this.label.style.fontSize = fitFont(this.labelText, this.style.fontSize, room);
    const hasHint = this.hintText !== '';
    this.hint.visible = hasHint;
    if (hasHint) {
      const size = fitFont(this.hintText, HINT_FONT, room);
      this.hint.style.fontSize = size;
      this.hint.text = ellipsise(this.hintText, size, room);
      const labelH = Number(this.label.style.fontSize);
      const block = labelH + 4 + size;
      const top = (h - block) / 2;
      this.label.position.set(left, top + labelH / 2);
      this.hint.position.set(left, top + labelH + 4);
    } else {
      this.label.position.set(left, h / 2);
    }
  }
}

/** The largest size at or under `base` at which `text` fits `room`, never below `MIN_FONT`. */
export function fitFont(text: string, base: number, room: number): number {
  const at = estimateMonoWidth(text, base);
  if (at <= room || at === 0) return base;
  return Math.max(MIN_FONT, Math.floor((base * room) / at));
}

/** `text`, cut with an ellipsis where it would run past `room` at `size`. */
export function ellipsise(text: string, size: number, room: number): string {
  if (estimateMonoWidth(text, size) <= room) return text;
  let cut = text;
  while (cut.length > 1 && estimateMonoWidth(`${cut}…`, size) > room) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}…`;
}
