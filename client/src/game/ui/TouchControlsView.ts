import { Container, Graphics, Sprite, Text, type Texture } from 'pixi.js';
import type { TouchVisual } from '../../platform/types';
import { whenUiTexture } from '../../render/uiSkins';
import { THEME } from '../theme';

/**
 * The art for the three controls a phone player touches every second (`art/ui/prompts.md`,
 * "Touch controls"). Wired ahead of the files: the keys join `UI_ASSETS` in the same change
 * that adds the PNGs, since the WeChat load check requires every registered file to load.
 * Until a key lands, its control keeps the Graphics it has always drawn.
 */
export const TOUCH_ART_KEYS = ['touch_stick_base', 'touch_stick_knob', 'touch_fire'] as const;
export type TouchArtKey = (typeof TOUCH_ART_KEYS)[number];

// The art is painted opaque; the game makes it translucent so the floor shows through
// (the prompts were written against these two values).
const ART_ALPHA_IDLE = 0.5;
const ART_ALPHA_HELD = 0.9;
/** The knob's radius as a fraction of the stick's, shared by the Graphics and the sprite. */
const KNOB_SCALE = 0.4;

// Visual layer for the touch controls TouchControls.ts hit-tests (design/10 open
// question: touch players had no on-screen indication of the sticks/buttons). Pure
// presentation — it never reads pointer/touch events itself, only the geometry
// TouchControls already computed, so the drawing can never drift from the real hit
// zones. Hidden entirely until TouchVisual.active (the player has touched the screen
// at least once), so desktop/mouse play never sees it (WebInput's mouse+keyboard path
// is untouched either way — this only ever mirrors TouchControls' own state).
export class TouchControlsView {
  readonly view = new Container();
  private readonly moveBase = new Graphics();
  private readonly moveKnob = new Graphics();
  private readonly fireButton = new Graphics();
  private readonly weapon1 = new Graphics();
  private readonly weapon2 = new Graphics();
  private readonly interactButton = new Graphics();
  private readonly weapon1Label: Text;
  private readonly weapon2Label: Text;
  private readonly interactLabel: Text;
  // Appended after every Graphics/Text child, so the existing child order is unchanged.
  private readonly art: Record<TouchArtKey, Sprite> = {
    touch_stick_base: artSprite(),
    touch_stick_knob: artSprite(),
    touch_fire: artSprite(),
  };
  private readonly landed = new Set<TouchArtKey>();

  constructor() {
    const labelStyle = { fill: 0xe2e8f0, fontSize: 15, fontFamily: 'monospace' as const, fontWeight: 'bold' as const, padding: 8 };
    this.weapon1Label = new Text({ text: '1', style: labelStyle });
    this.weapon2Label = new Text({ text: '2', style: labelStyle });
    // '+' reads as "support/revive" without needing a translated word (design/10's own
    // "few, large, clear elements" preference) — same single-glyph-label convention
    // weapon1Label/weapon2Label already use, just tinted to match the button's own
    // pickupHeal-green rather than the neutral weapon-button grey.
    this.interactLabel = new Text({ text: '+', style: { ...labelStyle, fill: THEME.colors.pickupHeal } });
    this.weapon1Label.anchor.set(0.5);
    this.weapon2Label.anchor.set(0.5);
    this.interactLabel.anchor.set(0.5);

    this.view.addChild(
      this.moveBase, this.moveKnob, this.fireButton,
      this.weapon1, this.weapon2, this.weapon1Label, this.weapon2Label,
      this.interactButton, this.interactLabel,
      this.art.touch_stick_base, this.art.touch_stick_knob, this.art.touch_fire,
    );
    this.view.visible = false;
    // Presentation only — never intercepts the DOM/wx touch events TouchControls
    // itself listens for (those are attached to the canvas, not these Pixi nodes).
    this.view.eventMode = 'none';
    for (const key of TOUCH_ART_KEYS) whenUiTexture(key, (texture) => this.setArt(key, texture));
  }

  /** Swap one control from its Graphics to `texture`. Takes effect on the next `update`. */
  setArt(key: TouchArtKey, texture: Texture): void {
    this.art[key].texture = texture;
    this.landed.add(key);
  }

  update(visual: TouchVisual): void {
    this.view.visible = visual.active;
    if (!visual.active) return;

    // Movement stick — base+knob only exist once the origin is known (dynamic origin
    // on touch-down; there is nothing meaningful to draw at rest).
    drawStick(this.moveBase, this.moveKnob, visual.move, visual.stickRadius, THEME.colors.player);
    // Right-side zone: a plain hold-to-fire button (design/10 v33 — no more aim stick,
    // the engine auto-faces the nearest hostile). Fixed position, brightens while held.
    drawFireButton(this.fireButton, visual.fire);
    this.applyArt(visual);

    drawButton(this.weapon1, this.weapon1Label, visual.weapon1);
    drawButton(this.weapon2, this.weapon2Label, visual.weapon2);
    // INTERACT — held (like fire), so it gets the same brighten-while-pressed treatment,
    // just tinted green (revive/support) instead of fire's amber.
    drawInteractButton(this.interactButton, visual.interact);
    this.interactLabel.position.set(visual.interact.cx, visual.interact.cy);
  }

  /** Where a control's art has landed, show the sprite at the Graphics' own geometry and hide
   *  the Graphics. The Graphics still draw first, so their visibility rules stay the one source. */
  private applyArt(visual: TouchVisual): void {
    const stick = visual.move;
    const held = stick !== null && Math.hypot(stick.dx, stick.dy) > 0.001;
    if (this.landed.has('touch_stick_base')) {
      placeArt(this.art.touch_stick_base, this.moveBase, stick?.ox ?? 0, stick?.oy ?? 0, visual.stickRadius, ART_ALPHA_IDLE);
    }
    if (this.landed.has('touch_stick_knob')) {
      const x = stick ? stick.ox + stick.dx : 0;
      const y = stick ? stick.oy + stick.dy : 0;
      placeArt(this.art.touch_stick_knob, this.moveKnob, x, y, visual.stickRadius * KNOB_SCALE, held ? ART_ALPHA_HELD : ART_ALPHA_IDLE);
    }
    if (this.landed.has('touch_fire')) {
      const f = visual.fire;
      placeArt(this.art.touch_fire, this.fireButton, f.cx, f.cy, f.r, f.pressed ? ART_ALPHA_HELD : ART_ALPHA_IDLE);
    }
  }
}

function artSprite(): Sprite {
  const s = new Sprite();
  s.anchor.set(0.5);
  s.visible = false;
  return s;
}

/** Takes over `g`'s slot: visible exactly when `g` would have been, then `g` steps aside. */
function placeArt(s: Sprite, g: Graphics, x: number, y: number, radius: number, alpha: number): void {
  s.visible = g.visible;
  g.visible = false;
  s.position.set(x, y);
  s.width = s.height = radius * 2;
  s.alpha = alpha;
}

function drawStick(
  base: Graphics,
  knob: Graphics,
  stick: { ox: number; oy: number; dx: number; dy: number } | null,
  radius: number,
  color: number,
): void {
  base.visible = stick !== null;
  knob.visible = stick !== null;
  if (!stick) return;

  base.clear().circle(stick.ox, stick.oy, radius).fill({ color, alpha: 0.14 }).stroke({ color, width: 2, alpha: 0.4 });
  // Held true once the drag has moved enough to actually register (matches
  // TouchControls.read()'s own len>0.001 threshold for firing) — the knob brightens so
  // a bare tap-and-hold visibly reads as "not quite there yet".
  const held = Math.hypot(stick.dx, stick.dy) > 0.001;
  knob.clear().circle(stick.ox + stick.dx, stick.oy + stick.dy, radius * KNOB_SCALE).fill({ color, alpha: held ? 0.9 : 0.5 });
}

function drawFireButton(g: Graphics, b: { cx: number; cy: number; r: number; pressed: boolean }): void {
  const color = THEME.colors.muzzle;
  g.clear()
    .circle(b.cx, b.cy, b.r)
    .fill({ color, alpha: b.pressed ? 0.32 : 0.14 })
    .stroke({ color, width: 2, alpha: b.pressed ? 0.7 : 0.4 });
}

// Same held/brighten shape as drawFireButton, tinted heal-green so INTERACT reads as a
// distinct, "supportive" action rather than another weapon-swap tap.
function drawInteractButton(g: Graphics, b: { cx: number; cy: number; r: number; pressed: boolean }): void {
  const color = THEME.colors.pickupHeal;
  g.clear()
    .circle(b.cx, b.cy, b.r)
    .fill({ color, alpha: b.pressed ? 0.32 : 0.14 })
    .stroke({ color, width: 2, alpha: b.pressed ? 0.7 : 0.4 });
}

function drawButton(g: Graphics, label: Text, b: { cx: number; cy: number; r: number }): void {
  g.clear().circle(b.cx, b.cy, b.r).fill({ color: 0x2a3140, alpha: 0.78 }).stroke({ color: 0xe2e8f0, width: 2, alpha: 0.35 });
  label.position.set(b.cx, b.cy);
}
