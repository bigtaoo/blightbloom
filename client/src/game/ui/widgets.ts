import { Container, Graphics, Text, Rectangle, Sprite, type Texture } from 'pixi.js';
import { getUiTexture } from '../../render/uiSkins';
import { playUiCue, type UiCue } from '../../audio/uiSound';
import { estimateMonoWidth } from './textWidth';

// A minimal Pixi widget kit (design/10 "build vs. a tiny in-house layer" — kept small,
// no framework). Every widget is pure presentation: it takes plain values in `set()`/
// constructor opts and draws — none of them read the engine directly (Game.ts is the
// only place that reads `state`/`events` and feeds these).

/** Rounded-rect background chrome shared by every overlay (menu/forge/settings/HUD
 * groupings) — one look, one place to retune, instead of each screen hand-rolling its
 * own `Graphics().rect().fill()`. */
export class Panel {
  readonly view = new Container();
  private readonly scrim = new Graphics();
  private bgSprite: Sprite | null = null;
  private w = 0;
  private h = 0;
  private radius: number;
  private color: number;
  private alpha: number;
  /** `uiSkins.ts` texture key for a full-bleed background image behind the flat
   * scrim (e.g. `'hub'`, design/13's outpost look) — omitted keeps the plain flat
   * fill this widget always had. Opt-in per screen: the small CompareCard uses a bare
   * Panel with no `background`, so it never picks up the big hub art meant for
   * full-screen menus. */
  private readonly backgroundKey?: string;
  // Border (opt-in): a flat near-black fill at low alpha is indistinguishable from the
  // app's own black backdrop wherever the panel sits outside the game world (design/10
  // legibility fix, 2026-08-02) — a thin lighter stroke gives it a readable edge
  // regardless of what's behind it.
  private readonly borderColor?: number;
  private readonly borderAlpha: number;

  constructor(opts: { radius?: number; color?: number; alpha?: number; background?: string; borderColor?: number; borderAlpha?: number } = {}) {
    this.radius = opts.radius ?? 0;
    this.color = opts.color ?? 0x0b0e14;
    this.alpha = opts.alpha ?? 0.82;
    this.backgroundKey = opts.background;
    this.borderColor = opts.borderColor;
    this.borderAlpha = opts.borderAlpha ?? 0.4;
    this.view.addChild(this.scrim);
  }

  layout(w: number, h: number) {
    if (w === this.w && h === this.h) return;
    this.w = w;
    this.h = h;

    // Preloaded (or not) before any screen ever calls layout() — main.ts awaits
    // preloadUiArt() before constructing Game — so a texture that exists is already
    // ready the first time this runs; a missing one just leaves bgSprite null forever.
    const bgTexture = this.backgroundKey ? getUiTexture(this.backgroundKey) : undefined;
    if (bgTexture) {
      if (!this.bgSprite) {
        this.bgSprite = new Sprite();
        this.view.addChildAt(this.bgSprite, 0); // behind the scrim
      }
      this.bgSprite.texture = bgTexture;
      // Stretch-to-fill, not crop — simplest given the wide range of screen sizes
      // this runs at; acceptable for a soft background behind foreground UI.
      this.bgSprite.width = w;
      this.bgSprite.height = h;
    }

    this.scrim.clear();
    // A real background image needs a lighter scrim so the art actually shows
    // through; the no-art fallback keeps today's fully-opaque-ish flat fill.
    const scrimAlpha = bgTexture ? Math.min(this.alpha, 0.55) : this.alpha;
    if (this.radius > 0) this.scrim.roundRect(0, 0, w, h, this.radius).fill({ color: this.color, alpha: scrimAlpha });
    else this.scrim.rect(0, 0, w, h).fill({ color: this.color, alpha: scrimAlpha });
    if (this.borderColor !== undefined) {
      if (this.radius > 0) this.scrim.roundRect(0.5, 0.5, w - 1, h - 1, this.radius).stroke({ color: this.borderColor, alpha: this.borderAlpha, width: 1 });
      else this.scrim.rect(0.5, 0.5, w - 1, h - 1).stroke({ color: this.borderColor, alpha: this.borderAlpha, width: 1 });
    }
  }
}

/** A labeled value/max bar (HP, shield, weapon cooldown) with a brief bright flash the
 * frame its value drops — the "flash/shake on hp_changed" cue design/10's HUD table
 * asks for, done once here instead of per-caller. */
export class Bar {
  readonly view = new Container();
  private track = new Graphics();
  private fill = new Graphics();
  private flashOverlay = new Graphics();
  private label: Text | null = null;
  private w: number;
  private h: number;
  private fillColor: number;
  private curFrac = 0;
  private lastValue = -1;
  private flashMs = 0;
  private static readonly FLASH_LIFE_MS = 160;

  constructor(opts: { w: number; h: number; fillColor: number; trackColor?: number; label?: boolean }) {
    this.w = opts.w;
    this.h = opts.h;
    this.fillColor = opts.fillColor;
    this.track.roundRect(0, 0, this.w, this.h, this.h / 2).fill({ color: opts.trackColor ?? 0x1f2532 });
    this.view.addChild(this.track, this.fill, this.flashOverlay);
    if (opts.label) {
      this.label = new Text({ text: '', style: { fill: 0xe2e8f0, fontSize: 11, fontFamily: 'monospace', padding: 6 } });
      this.label.anchor.set(0.5);
      this.label.position.set(this.w / 2, this.h / 2);
      this.view.addChild(this.label);
    }
  }

  /** value/max in [0, max]. `labelText` overrides the default `value/max` readout. */
  set(value: number, max: number, labelText?: string) {
    this.curFrac = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
    this.fill.clear();
    if (this.curFrac > 0) this.fill.roundRect(0, 0, this.w * this.curFrac, this.h, this.h / 2).fill({ color: this.fillColor });
    if (this.lastValue >= 0 && value < this.lastValue) this.flashMs = Bar.FLASH_LIFE_MS;
    this.lastValue = value;
    if (this.label) this.label.text = labelText ?? `${Math.max(0, Math.round(value))}/${Math.round(max)}`;
  }

  /** Advance the decrease-flash fade. Call once per render frame (dt in ms). */
  update(dt: number) {
    if (this.flashMs <= 0) {
      if (this.flashOverlay.visible) this.flashOverlay.clear();
      this.flashOverlay.visible = false;
      return;
    }
    this.flashMs = Math.max(0, this.flashMs - dt);
    const a = (this.flashMs / Bar.FLASH_LIFE_MS) * 0.55;
    this.flashOverlay.visible = true;
    this.flashOverlay.clear();
    if (this.curFrac > 0) this.flashOverlay.roundRect(0, 0, this.w * this.curFrac, this.h, this.h / 2).fill({ color: 0xffffff, alpha: a });
  }
}

/** A transient fading message queue (pickup/buff feedback, design/10 "pickup/buff
 * toast"). Newest message appears at the bottom; each message fades over its life and
 * is removed, and the stack re-settles upward. */
export class ToastQueue {
  readonly view = new Container();
  private items: { text: Text; life: number }[] = [];
  private w: number;
  private lifeMs: number;
  private lineH: number;

  constructor(opts: { w: number; lifeMs?: number; lineH?: number }) {
    this.w = opts.w;
    this.lifeMs = opts.lifeMs ?? 1400;
    this.lineH = opts.lineH ?? 22;
  }

  push(text: string, color = 0xe2e8f0) {
    const t = new Text({ text, style: { fill: color, fontSize: 15, fontFamily: 'monospace', fontWeight: 'bold', padding: 6 } });
    t.anchor.set(0.5, 0);
    t.position.x = this.w / 2;
    this.view.addChild(t);
    this.items.push({ text: t, life: this.lifeMs });
    this.relayout();
  }

  update(dt: number) {
    let removed = false;
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i]!;
      it.life -= dt;
      // Fade over the tail third of its life, full opacity before that.
      it.text.alpha = Math.max(0, Math.min(1, it.life / (this.lifeMs / 3)));
      if (it.life <= 0) {
        it.text.destroy();
        this.items.splice(i, 1);
        removed = true;
      }
    }
    if (removed) this.relayout();
  }

  private relayout() {
    this.items.forEach((it, i) => { it.text.position.y = i * this.lineH; });
  }
}

/** A tappable Pixi button — hit-area + label, no DOM (design/10 "no DOM widgets"). */
export class Button {
  readonly view = new Container();
  private bg = new Graphics();
  private label: Text;
  private iconChip: Graphics | null = null;
  private iconSprite: Sprite | null = null;
  private w: number;
  private readonly h: number;
  private readonly minW: number;
  private readonly fontSize: number;
  // Not `readonly`, for the same reason `borderColor` below is not: `setFill` re-colours it
  // at runtime. Its one caller is `LobbyRoutes.setSoloPrimary` — whether SOLO is the lobby's
  // primary action depends on the HOST, which is declared after the screens are constructed
  // (`gameWiring.ts`), so the fill cannot be a constructor argument.
  private color: number;
  // Not `readonly`: `setBorder` re-colours it at runtime for a SELECTED state
  // (FloorCardPrompt's picked card). Border rather than fill, matching the
  // browse-cursor convention BlueprintCard already uses — a filled highlight on a
  // button that is also pressable reads as "already pressed" rather than "chosen".
  private borderColor: number | undefined;
  private readonly borderAlpha: number;
  // `autoWidth` (opt-in): grows the box to fit the current text instead of clipping it
  // at a fixed pixel width sized for one locale's string. Off by default — every other
  // call site keeps its exact pre-existing fixed-width look; a caller opts in when its
  // label text is translated and can outgrow the width picked for English (settings.md
  // 2026-08-14, Russian "ВКЛЮЧИТЬ ЗВУК"/"УПРАВЛЕНИЕ: ЛЕВША" overflowing their box).
  private readonly autoWidth: boolean;
  // Which UI cue this button makes when pressed (design/11's screen-layer cues). Defaults to
  // `ui.tap`, so every one of the ~40 buttons in the client is audible without opting in —
  // the opt-INs are the exceptions that mean something else: `ui.back` for the button that
  // leaves a screen, `ui.toggle` for one that flips a setting under your finger, and
  // `'silent'` for the handful whose OUTCOME decides the sound (a forge craft row plays
  // `ui.tap` or `ui.denied` from `ForgeActions`, since only the transaction knows which).
  private readonly sound: UiCue | 'silent';
  onTap: (() => void) | null = null;

  // Border (opt-in, same convention as Panel's — design/10 legibility fix,
  // 2026-08-02): a flat fill alone reads as low-contrast wherever a button sits over
  // a background image darker/lighter than the fill itself (e.g. MainMenu's hub art).
  // A crisp stroke keeps the button legible regardless of what's behind it.
  constructor(text: string, opts: { w: number; h: number; color?: number; textColor?: number; fontSize?: number; borderColor?: number; borderAlpha?: number; autoWidth?: boolean; sound?: UiCue | 'silent' }) {
    const { w, h, color = 0x2a3140, textColor = 0xe2e8f0, fontSize = 15, borderColor, borderAlpha = 0.9, autoWidth = false, sound = 'ui.tap' } = opts;
    this.minW = w;
    this.w = w;
    this.h = h;
    this.fontSize = fontSize;
    this.color = color;
    this.borderColor = borderColor;
    this.borderAlpha = borderAlpha;
    this.autoWidth = autoWidth;
    this.sound = sound;
    // `padding` works around a real font-metrics mismatch observed in headless/sandboxed
    // Chromium: Pixi's own text measurement can come in narrower than the canvas's actual
    // paint-time glyph width for bold text, clipping the last character(s) — Pixi's own
    // documented mitigation ("occasionally some fonts are cropped").
    this.label = new Text({ text, style: { fill: textColor, fontSize, fontFamily: 'monospace', fontWeight: 'bold', padding: 14 } });
    this.label.anchor.set(0.5);
    // The label is decoration: the box (`bg`) is what the press lands on. Marking it
    // 'none' takes the whole Text out of hit-testing, which is both Pixi's own advice for
    // non-interactive children and the reason a headless test can hit-test a button at
    // all — `Text.containsPoint` measures the glyphs, and measuring needs a real canvas.
    this.label.eventMode = 'none';
    this.view.addChild(this.bg, this.label);
    this.redraw();
    this.view.eventMode = 'static';
    this.view.cursor = 'pointer';
    // Handler FIRST, then the cue — not for ordering's sake but because the settings mute
    // button is one of these: `onTap` is what applies the new volume, so running it first
    // makes muting end in silence and unmuting announce itself, instead of the reverse.
    this.view.on('pointertap', () => {
      this.onTap?.();
      if (this.sound !== 'silent') playUiCue(this.sound);
    });
    // A button nested inside a screen that ALSO has its own full-panel `pointerdown`
    // handler (e.g. Screens.ts's tap-anywhere-to-confirm) would otherwise double-fire —
    // pointerdown bubbles to ancestors regardless of what consumes the later tap. Stop
    // it here once so every button is safe to drop onto such a screen.
    this.view.on('pointerdown', (e) => e.stopPropagation());
  }

  /** Redraws `bg` at the current width and re-centers the label — called at
   * construction and, for `autoWidth` buttons, on every `setText`. Text measurement
   * uses `estimateMonoWidth` rather than Pixi's `Text.width` (see textWidth.ts): the
   * label is `fontFamily: 'monospace'`, so the estimate is accurate, and unlike
   * `Text.width` it needs no real canvas — same convention as StatChip/WeaponCard. */
  private redraw() {
    this.w = this.autoWidth
      ? Math.max(this.minW, estimateMonoWidth(this.label.text, this.fontSize) + 28)
      : this.minW;
    const radius = Math.min(8, this.h / 2);
    this.bg.clear().roundRect(0, 0, this.w, this.h, radius).fill({ color: this.color, alpha: 1 });
    if (this.borderColor !== undefined) this.bg.roundRect(0.5, 0.5, this.w - 1, this.h - 1, radius).stroke({ color: this.borderColor, alpha: this.borderAlpha, width: 1.5 });
    this.layoutLabel();
  }

  /**
   * Where the label sits: centred, or hard against the right of the icon chip when there is
   * one.
   *
   * Extracted from `setIcon` on 2026-09-10 because `redraw()` was re-centring it and `setIcon`
   * was the only thing that ever put it back. Any later `redraw` — an `autoWidth` button's
   * `setText`, and now `setFill`/`setBorder` — therefore dropped an icon button's label back
   * on top of its own chip, left-anchored, so it ran off the RIGHT edge by however far the
   * offset had been. Invisible to every existing test, because `getUiTexture` answers
   * `undefined` with no art loaded, so a unit-test button has no icon and is centred either
   * way; `viewportFit.test.ts`'s label-fit sweep installs a real texture for exactly this
   * reason.
   */
  private layoutLabel(): void {
    if (this.iconSprite) {
      const box = this.h - 8;
      this.label.anchor.set(0, 0.5);
      this.label.position.set(8 + box + 8, this.h / 2);
      return;
    }
    this.label.anchor.set(0.5);
    this.label.position.set(this.w / 2, this.h / 2);
  }

  /** Current box width — `minW` for a fixed-width button, or the text-fitted width for
   * an `autoWidth` one. Callers that center this button under a point (rather than
   * pinning its left edge) must read this after `setText`, not assume the constructor's
   * `w` — see Settings.ts's `layoutButtons`. */
  get width(): number {
    return this.w;
  }

  setText(text: string) {
    this.label.text = text;
    if (this.autoWidth) this.redraw();
  }

  /** Re-colour the box's border, for a selected/unselected state. A no-op on a button
   *  that was constructed without one — a border cannot be added later, only changed,
   *  so a caller that wants this has to opt in with `borderColor` at construction. */
  /** Re-colour the FILL — the primary/ordinary distinction, not a selected state. Border
   *  alone cannot carry it: design/10's 2026-08-02 legibility pass settled that a primary
   *  action on these screens is the filled green one. */
  setFill(color: number): void {
    if (this.color === color) return;
    this.color = color;
    this.redraw();
  }

  setBorder(color: number): void {
    if (this.borderColor === undefined || this.borderColor === color) return;
    this.borderColor = color;
    this.redraw();
  }

  /** Optional leading icon (Forge row real weapon art — reuses the same textures the
   * in-run renderer mounts, `render/weaponSkins.ts`, so no separate icon art is needed)
   * with a rarity-coloured backing chip (design/14 border-not-hue convention, matches
   * CompareCard). Pass `undefined` to clear. Shifts the label to sit right of the icon
   * instead of centering — the only layout change, so buttons without an icon are
   * unaffected. */
  setIcon(texture: Texture | undefined, chipColor?: number): void {
    if (!texture) {
      this.iconSprite?.destroy();
      this.iconSprite = null;
      this.iconChip?.destroy();
      this.iconChip = null;
      this.layoutLabel();
      return;
    }
    const box = this.h - 8;
    const cx = 4 + box / 2;
    const cy = this.h / 2;
    if (!this.iconChip) {
      this.iconChip = new Graphics();
      this.view.addChildAt(this.iconChip, 1);
    }
    this.iconChip.clear().roundRect(4, 4, box, box, 4).fill({ color: chipColor ?? 0x1f2532, alpha: 0.9 });
    if (!this.iconSprite) {
      this.iconSprite = new Sprite();
      this.iconSprite.anchor.set(0.5);
      this.view.addChildAt(this.iconSprite, 2);
    }
    this.iconSprite.texture = texture;
    // Contain (preserve aspect ratio) — most weapon art is a wide "socket-to-tip"
    // silhouette, not square, so a naive width/height stretch would squash it.
    const fit = Math.min((box - 4) / texture.width, (box - 4) / texture.height);
    this.iconSprite.scale.set(fit);
    this.iconSprite.position.set(cx, cy);
    this.layoutLabel();
  }
}

/** A draggable [0,1] slider (settings volume, design/10). Drag tracking is done on a
 * `dragSurface` (a full-screen container already in `eventMode:'static'`, e.g. the
 * owning screen's `view`) via `globalpointermove`, so the knob keeps tracking even once
 * the pointer moves off the thin track — the standard Pixi v8 drag pattern. */
export class Slider {
  readonly view = new Container();
  private track = new Graphics();
  private knob = new Graphics();
  private w: number;
  private value = 0;
  private dragging = false;
  onChange: ((v: number) => void) | null = null;

  constructor(opts: { w: number; dragSurface?: Container }) {
    this.w = opts.w;
    const h = 6;
    const knobR = 9;
    this.track.roundRect(0, -h / 2, this.w, h, h / 2).fill({ color: 0x1f2532 });
    this.knob.circle(0, 0, knobR).fill({ color: 0x63b3ed });
    this.view.addChild(this.track, this.knob);
    this.view.eventMode = 'static';
    this.view.cursor = 'pointer';
    this.view.hitArea = new Rectangle(-knobR, -20, this.w + knobR * 2, 40);

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

  set(v: number) {
    this.value = Math.max(0, Math.min(1, v));
    this.knob.position.x = this.value * this.w;
  }

  get(): number {
    return this.value;
  }
}
