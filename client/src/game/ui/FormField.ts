// A labelled text field drawn on the canvas (design/10 "One shell for every menu", 2026-09-27):
// a caption above a box that shows the value (masked for a password) or a muted placeholder.
//
// Pixi has no text input, so the field does not edit anything itself: a tap asks the owner to
// open `TextInputOverlay` ON the field (`anchorRect` is where), and the owner hands the typed
// value back with `setValue`. The login screen used to ask for its two fields as two centred
// prompts in a row, which read as a dialog box rather than a form and hid which field was
// which.
import { Container, Graphics, Rectangle, Text } from 'pixi.js';
import { MENU_COLORS, menuText } from './menuTheme';
import { playUiCue } from '../../audio/uiSound';

/** The caption's height above the box, and the box's own height. */
export const FIELD_LABEL_H = 20;
export const FIELD_BOX_H = 42;
export const FIELD_H = FIELD_LABEL_H + FIELD_BOX_H;
const RADIUS = 8;

export class FormField {
  readonly view = new Container();
  private readonly box = new Graphics();
  private readonly caption: Text;
  private readonly shown: Text;
  private w: number;
  private value = '';
  private placeholder = '';
  private focused = false;
  readonly password: boolean;
  onTap: (() => void) | null = null;

  constructor(label: string, w: number, opts: { password?: boolean } = {}) {
    this.w = w;
    this.password = opts.password ?? false;
    this.caption = new Text({ text: label, style: menuText('heading') });
    this.caption.anchor.set(0, 0);
    this.shown = new Text({ text: '', style: menuText('value', { fontSize: 15 }) });
    this.shown.anchor.set(0, 0.5);
    this.caption.eventMode = 'none';
    this.shown.eventMode = 'none';
    this.view.addChild(this.box, this.caption, this.shown);
    this.view.eventMode = 'static';
    this.view.cursor = 'text';
    this.view.on('pointertap', () => {
      this.onTap?.();
      playUiCue('ui.tap');
    });
    this.view.on('pointerdown', (e) => e.stopPropagation());
    this.redraw();
  }

  get text(): string {
    return this.value;
  }

  setLabel(text: string): void {
    this.caption.text = text;
  }

  setPlaceholder(text: string): void {
    this.placeholder = text;
    this.redraw();
  }

  setValue(value: string): void {
    this.value = value;
    this.redraw();
  }

  setWidth(w: number): void {
    if (w === this.w) return;
    this.w = w;
    this.redraw();
  }

  /** Drawn with the crystal border while the DOM input is open on it. */
  setFocused(focused: boolean): void {
    if (focused === this.focused) return;
    this.focused = focused;
    this.redraw();
  }

  /**
   * The box's rectangle in canvas CSS px — where `TextInputOverlay` should put the real input.
   * Mapped with `toGlobal`, which recomputes the transforms above it rather than trusting the
   * last frame's, so it is right under the menu layer's fit scale and the shell's own scale
   * alike, even straight after a layout.
   */
  anchorRect(): { x: number; y: number; w: number; h: number } {
    const a = this.view.toGlobal({ x: 0, y: FIELD_LABEL_H });
    const b = this.view.toGlobal({ x: this.w, y: FIELD_LABEL_H + FIELD_BOX_H });
    return { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y };
  }

  private redraw(): void {
    const c = MENU_COLORS;
    const y = FIELD_LABEL_H;
    this.box.clear()
      .roundRect(0, y, this.w, FIELD_BOX_H, RADIUS).fill({ color: c.field, alpha: 0.95 })
      .roundRect(0.75, y + 0.75, this.w - 1.5, FIELD_BOX_H - 1.5, RADIUS)
      .stroke({ color: this.focused ? c.fieldFocus : c.fieldBorder, width: this.focused ? 2 : 1.5, alpha: 1 });
    this.view.hitArea = new Rectangle(0, 0, this.w, FIELD_H);
    const empty = this.value === '';
    this.shown.text = empty ? this.placeholder : this.password ? '•'.repeat(Math.min(this.value.length, 24)) : this.value;
    this.shown.style.fill = empty ? c.textMuted : c.text;
    this.shown.style.fontWeight = empty ? 'normal' : 'bold';
    this.shown.position.set(14, y + FIELD_BOX_H / 2);
  }
}
