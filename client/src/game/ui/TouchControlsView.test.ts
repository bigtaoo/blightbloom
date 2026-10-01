import { describe, it, expect } from 'vitest';
import { Texture, type Graphics, type Sprite, type Text } from 'pixi.js';
import { TOUCH_ART_KEYS, TouchControlsView, type TouchArtKey } from './TouchControlsView';
import type { TouchVisual } from '../../platform/types';
import { THEME } from '../theme';

// Children are appended in this fixed order in the constructor — indexing into
// `view.children` is the only way in from the outside, since the individual
// Graphics/Text are private (this mirrors how the feature was hand-verified live in
// the browser: see the daydayup memory notes on why screenshots aren't available here).
const enum Child { MoveBase, MoveKnob, FireButton, Weapon1, Weapon2, Weapon1Label, Weapon2Label, InteractButton, InteractLabel, BaseArt, KnobArt, FireArt }

function graphicsAt(v: TouchControlsView, i: Child): Graphics {
  return v.view.children[i] as Graphics;
}
function textAt(v: TouchControlsView, i: Child): Text {
  return v.view.children[i] as Text;
}

/** Every button here draws a `.circle(...).fill(...).stroke(...)` chain — TWO
 *  instructions per shape (`action: 'fill'` vs `'stroke'`), same gotcha
 *  `DungeonFloorCanvas.test.ts` already found (filter on `ins.action` first, don't
 *  assume one instruction per shape) — so this reads just the `'fill'` one's own
 *  color/alpha, the same technique `Minimap.test.ts`'s `drawnShapes` uses for a
 *  fill-only shape, generalized to skip the stroke instruction here. */
function fillOf(g: Graphics): { color: number; alpha: number } {
  const ctx = g.context as unknown as { instructions: { action: string; data: { style?: { color: number; alpha: number } } }[] };
  const fill = ctx.instructions.find((ins) => ins.action === 'fill')!;
  return { color: fill.data.style!.color, alpha: fill.data.style!.alpha };
}

const BASE_VISUAL: TouchVisual = {
  active: true,
  stickRadius: 50,
  move: null,
  fire: { cx: 300, cy: 60, r: 50, pressed: false },
  weapon1: { cx: 100, cy: 20, r: 15 },
  weapon2: { cx: 60, cy: 20, r: 15 },
  interact: { cx: 20, cy: 20, r: 15, pressed: false },
};

describe('TouchControlsView', () => {
  it('starts hidden before the first update()', () => {
    const v = new TouchControlsView();
    expect(v.view.visible).toBe(false);
  });

  it('is presentation-only — never intercepts pointer events (canvas listeners own that)', () => {
    const v = new TouchControlsView();
    expect(v.view.eventMode).toBe('none');
  });

  it('stays hidden when TouchVisual.active is false, regardless of stick state', () => {
    const v = new TouchControlsView();
    v.update({ ...BASE_VISUAL, active: false });
    expect(v.view.visible).toBe(false);
  });

  it('becomes visible once active, with the move stick hidden while untouched', () => {
    const v = new TouchControlsView();
    v.update(BASE_VISUAL);
    expect(v.view.visible).toBe(true);
    expect(graphicsAt(v, Child.MoveBase).visible).toBe(false);
    expect(graphicsAt(v, Child.MoveKnob).visible).toBe(false);
  });

  it('draws the fire button at its fixed reported position regardless of the move stick', () => {
    const v = new TouchControlsView();
    v.update(BASE_VISUAL); // fixed position, drawn even though nothing is held
    const bounds = graphicsAt(v, Child.FireButton).getBounds();
    expect(bounds.x + bounds.width / 2).toBeCloseTo(300);
    expect(bounds.y + bounds.height / 2).toBeCloseTo(60);
  });

  it('draws the move stick base+knob at the reported origin/offset when held', () => {
    const v = new TouchControlsView();
    v.update({ ...BASE_VISUAL, move: { ox: 40, oy: 60, dx: 20, dy: -10 } });

    const base = graphicsAt(v, Child.MoveBase);
    expect(base.visible).toBe(true);
    const baseBounds = base.getBounds();
    expect(baseBounds.x + baseBounds.width / 2).toBeCloseTo(40);
    expect(baseBounds.y + baseBounds.height / 2).toBeCloseTo(60);

    const knob = graphicsAt(v, Child.MoveKnob);
    expect(knob.visible).toBe(true);
    const knobBounds = knob.getBounds();
    expect(knobBounds.x + knobBounds.width / 2).toBeCloseTo(60); // ox + dx
    expect(knobBounds.y + knobBounds.height / 2).toBeCloseTo(50); // oy + dy
  });

  it('re-hides the move stick the frame after release', () => {
    const v = new TouchControlsView();
    v.update({ ...BASE_VISUAL, move: { ox: 40, oy: 60, dx: 20, dy: -10 } });
    expect(graphicsAt(v, Child.MoveBase).visible).toBe(true);

    v.update({ ...BASE_VISUAL, move: null });
    expect(graphicsAt(v, Child.MoveBase).visible).toBe(false);
    expect(graphicsAt(v, Child.MoveKnob).visible).toBe(false);
  });

  it('draws both weapon buttons at their reported centre/radius every update, labelled 1/2', () => {
    const v = new TouchControlsView();
    v.update(BASE_VISUAL);

    const w1 = graphicsAt(v, Child.Weapon1).getBounds();
    expect(w1.x + w1.width / 2).toBeCloseTo(100);
    expect(w1.y + w1.height / 2).toBeCloseTo(20);

    const w2 = graphicsAt(v, Child.Weapon2).getBounds();
    expect(w2.x + w2.width / 2).toBeCloseTo(60);
    expect(w2.y + w2.height / 2).toBeCloseTo(20);

    const l1 = textAt(v, Child.Weapon1Label);
    expect(l1.text).toBe('1');
    expect(l1.position.x).toBe(100);
    expect(l1.position.y).toBe(20);

    const l2 = textAt(v, Child.Weapon2Label);
    expect(l2.text).toBe('2');
    expect(l2.position.x).toBe(60);
    expect(l2.position.y).toBe(20);
  });

  it('follows the buttons if their reported position changes (screen resize)', () => {
    const v = new TouchControlsView();
    v.update(BASE_VISUAL);
    v.update({ ...BASE_VISUAL, weapon1: { cx: 200, cy: 40, r: 15 } });
    const l1 = textAt(v, Child.Weapon1Label);
    expect(l1.position.x).toBe(200);
    expect(l1.position.y).toBe(40);
  });

  describe('INTERACT button (revive channel — a real gap this pass closed)', () => {
    it('draws at its reported centre/radius every update, labelled +', () => {
      const v = new TouchControlsView();
      v.update(BASE_VISUAL);

      const bounds = graphicsAt(v, Child.InteractButton).getBounds();
      expect(bounds.x + bounds.width / 2).toBeCloseTo(20);
      expect(bounds.y + bounds.height / 2).toBeCloseTo(20);

      const label = textAt(v, Child.InteractLabel);
      expect(label.text).toBe('+');
      expect(label.position.x).toBe(20);
      expect(label.position.y).toBe(20);
    });

    it('brightens while held, same shape as the fire button — a real alpha assertion, not just position', () => {
      const v = new TouchControlsView();
      v.update({ ...BASE_VISUAL, interact: { cx: 20, cy: 20, r: 15, pressed: false } });
      const unpressed = fillOf(graphicsAt(v, Child.InteractButton));
      expect(unpressed.color).toBe(THEME.colors.pickupHeal);
      expect(unpressed.alpha).toBeCloseTo(0.14);

      v.update({ ...BASE_VISUAL, interact: { cx: 20, cy: 20, r: 15, pressed: true } });
      const pressed = fillOf(graphicsAt(v, Child.InteractButton));
      expect(pressed.alpha).toBeCloseTo(0.32); // brighter than unpressed — the actual "held" signal
      expect(pressed.alpha).toBeGreaterThan(unpressed.alpha);
    });

    it('follows the button if its reported position changes (screen resize)', () => {
      const v = new TouchControlsView();
      v.update(BASE_VISUAL);
      v.update({ ...BASE_VISUAL, interact: { cx: 150, cy: 45, r: 15, pressed: false } });
      const label = textAt(v, Child.InteractLabel);
      expect(label.position.x).toBe(150);
      expect(label.position.y).toBe(45);
    });

    it('is drawn even when it sits at TouchVisual.active but nothing is pressed (always visible, unlike the dynamic move stick)', () => {
      const v = new TouchControlsView();
      v.update(BASE_VISUAL);
      // Unlike moveBase/moveKnob (hidden until a stick is held), the interact button has
      // no `null`/hidden state — same "always drawn" contract as the weapon buttons.
      expect(graphicsAt(v, Child.InteractButton).getBounds().width).toBeGreaterThan(0);
    });
  });

  describe('art for the stick and the fire button (wired ahead of the files, 2026-10-01)', () => {
    const HELD_STICK = { ox: 80, oy: 200, dx: 12, dy: -5 };
    const spriteAt = (v: TouchControlsView, i: Child): Sprite => v.view.children[i] as Sprite;
    /** A real texture of a known size, so a sprite sized from it has measurable bounds. */
    const tex = (): Texture => Texture.WHITE;

    it('draws only the Graphics while no art has landed — the fallback is the default', () => {
      const v = new TouchControlsView();
      v.update({ ...BASE_VISUAL, move: HELD_STICK });
      for (const i of [Child.BaseArt, Child.KnobArt, Child.FireArt]) expect(spriteAt(v, i).visible).toBe(false);
      for (const i of [Child.MoveBase, Child.MoveKnob, Child.FireButton]) expect(graphicsAt(v, i).visible).toBe(true);
    });

    it("swaps each control to its sprite at the Graphics' own position and size, and hides the Graphics", () => {
      const v = new TouchControlsView();
      for (const key of TOUCH_ART_KEYS) v.setArt(key, tex());
      v.update({ ...BASE_VISUAL, move: HELD_STICK });

      const base = spriteAt(v, Child.BaseArt);
      expect([base.visible, base.x, base.y, base.width]).toEqual([true, 80, 200, 2 * BASE_VISUAL.stickRadius]);
      const knob = spriteAt(v, Child.KnobArt);
      expect([knob.visible, knob.x, knob.y]).toEqual([true, 92, 195]);
      expect(knob.width).toBeCloseTo(2 * BASE_VISUAL.stickRadius * 0.4);
      const fire = spriteAt(v, Child.FireArt);
      expect([fire.visible, fire.x, fire.y, fire.width]).toEqual([true, 300, 60, 100]);

      for (const i of [Child.MoveBase, Child.MoveKnob, Child.FireButton]) expect(graphicsAt(v, i).visible).toBe(false);
    });

    it('keeps the stick art hidden while the stick is untouched, exactly as the Graphics were', () => {
      const v = new TouchControlsView();
      for (const key of TOUCH_ART_KEYS) v.setArt(key, tex());
      v.update({ ...BASE_VISUAL, move: null });
      expect(spriteAt(v, Child.BaseArt).visible).toBe(false);
      expect(spriteAt(v, Child.KnobArt).visible).toBe(false);
      // The fire button has no hidden state: it is drawn whenever the controls are.
      expect(spriteAt(v, Child.FireArt).visible).toBe(true);
    });

    it('brightens the knob and the fire button while held', () => {
      const v = new TouchControlsView();
      for (const key of TOUCH_ART_KEYS) v.setArt(key, tex());
      v.update({ ...BASE_VISUAL, move: { ...HELD_STICK, dx: 0, dy: 0 } });
      const idleKnob = spriteAt(v, Child.KnobArt).alpha;
      const idleFire = spriteAt(v, Child.FireArt).alpha;
      v.update({ ...BASE_VISUAL, move: HELD_STICK, fire: { ...BASE_VISUAL.fire, pressed: true } });
      expect(spriteAt(v, Child.KnobArt).alpha).toBeGreaterThan(idleKnob);
      expect(spriteAt(v, Child.FireArt).alpha).toBeGreaterThan(idleFire);
      // The base has no held state of its own.
      expect(spriteAt(v, Child.BaseArt).alpha).toBe(idleKnob);
    });

    it('swaps one control at a time: the others stay on their Graphics', () => {
      for (const only of TOUCH_ART_KEYS) {
        const v = new TouchControlsView();
        v.setArt(only, tex());
        v.update({ ...BASE_VISUAL, move: HELD_STICK });
        const pairs: [TouchArtKey, Child, Child][] = [
          ['touch_stick_base', Child.BaseArt, Child.MoveBase],
          ['touch_stick_knob', Child.KnobArt, Child.MoveKnob],
          ['touch_fire', Child.FireArt, Child.FireButton],
        ];
        for (const [key, art, g] of pairs) {
          expect(spriteAt(v, art).visible, `${only}: ${key} sprite`).toBe(key === only);
          expect(graphicsAt(v, g).visible, `${only}: ${key} graphics`).toBe(key !== only);
        }
      }
    });
  });
});
