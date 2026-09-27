// A draggable [0,1] slider (settings volume, design/10), split out of `widgets.ts` with the menu
// shell (2026-09-27), which gave it the shell's look — a field-coloured track that fills with the
// frame's crystal cyan up to the knob — and a width that can change after construction.
import { Container, Graphics, Rectangle } from 'pixi.js';
import { playUiCue } from '../../audio/uiSound';
import { MENU_COLORS } from './menuTheme';

const TRACK_H = 8;
const KNOB_R = 10;

/** Drag tracking is done on a `dragSurface` (a full-screen container already in
 * `eventMode:'static'`, e.g. the owning screen's `view`) via `globalpointermove`, so the knob
 * keeps tracking even once the pointer moves off the thin track — the standard Pixi v8 drag
 * pattern. */
export class Slider {
  readonly view = new Container();
  private track = new Graphics();
  private fill = new Graphics();
  private knob = new Graphics();
  private w: number;
  private value = 0;
  private dragging = false;
  onChange: ((v: number) => void) | null = null;

  constructor(opts: { w: number; dragSurface?: Container }) {
    this.w = opts.w;
    this.knob.circle(0, 0, KNOB_R).fill({ color: MENU_COLORS.text })
      .circle(0, 0, KNOB_R).stroke({ color: MENU_COLORS.frame, width: 3 });
    this.view.addChild(this.track, this.fill, this.knob);
    this.view.eventMode = 'static';
    this.view.cursor = 'pointer';
    this.redraw();

    const surface = opts.dragSurface ?? this.view;
    this.view.on('pointerdown', (e) => {
      this.dragging = true;
      this.seekFromGlobal(e.global.x, e.global.y);
    });
    surface.on('globalpointermove', (e) => {
      if (this.dragging) this.seekFromGlobal(e.global.x, e.global.y);
    });
    // Release ENDS a drag and is where the cue plays — one tick per adjustment, not one per
    // pixel of travel. On the volume sliders this is doing double duty: the tick is played
    // through the bus the slider just changed, so releasing the SFX slider is also how you
    // hear what you set it to (design/10's settings screen, design/11's "playable silent" —
    // a volume control you cannot audition is a guess).
    surface.on('pointerup', () => this.endDrag(true));
    surface.on('pointerupoutside', () => this.endDrag(true));
    // An OS-level interruption (e.g. an incoming call/notification mid-drag) delivers
    // pointercancel instead of pointerup — without this, `dragging` gets stuck true, and
    // when several sliders share one `dragSurface` (Settings.ts), the NEXT unrelated
    // pointer move over that surface silently drags this slider's value again.
    // Silent: an incoming call is not the player committing a value.
    surface.on('pointercancel', () => this.endDrag(false));
  }

  /** End a drag, optionally with the commit cue. Guarded on `dragging` because these
   * listeners live on a SHARED drag surface — every pointerup anywhere on the settings
   * screen reaches all three sliders, and only the one being dragged has anything to say. */
  private endDrag(commit: boolean) {
    if (!this.dragging) return;
    this.dragging = false;
    if (commit) playUiCue('ui.toggle');
  }

  private seekFromGlobal(gx: number, gy: number) {
    const local = this.view.toLocal({ x: gx, y: gy });
    this.set(local.x / this.w);
    this.onChange?.(this.value);
  }

  /** Re-size the track — the settings sheet sizes it to its column. */
  setWidth(w: number): void {
    if (w === this.w) return;
    this.w = w;
    this.redraw();
  }

  get width(): number {
    return this.w;
  }

  set(v: number) {
    this.value = Math.max(0, Math.min(1, v));
    this.placeKnob();
  }

  get(): number {
    return this.value;
  }

  private redraw(): void {
    this.track.clear()
      .roundRect(0, -TRACK_H / 2, this.w, TRACK_H, TRACK_H / 2).fill({ color: MENU_COLORS.field })
      .roundRect(0, -TRACK_H / 2, this.w, TRACK_H, TRACK_H / 2).stroke({ color: MENU_COLORS.fieldBorder, width: 1 });
    this.view.hitArea = new Rectangle(-KNOB_R, -20, this.w + KNOB_R * 2, 40);
    this.placeKnob();
  }

  private placeKnob(): void {
    const x = this.value * this.w;
    this.knob.position.x = x;
    this.fill.clear();
    if (x > 0) this.fill.roundRect(0, -TRACK_H / 2, Math.max(x, TRACK_H), TRACK_H, TRACK_H / 2).fill({ color: MENU_COLORS.frame, alpha: 0.9 });
  }
}
