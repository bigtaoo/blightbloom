import { describe, it, expect, beforeEach } from 'vitest';
import { TouchControls } from './TouchControls';

// width=1000, height=500 → unit=500 gives round numbers throughout:
// stickRadius=90, button r=40, margin m=60, gap=96
// weapon1 = { cx: 940, cy: 60, r: 40 }, weapon2 = { cx: 844, cy: 60, r: 40 }
// interact = { cx: 748, cy: 60, r: 40 } (a third button, one more `gap` out)
// fire button (design/10 v33, fixed position, standard layout) = { cx: 875, cy: 250, r: 90 }
function laidOut(): TouchControls {
  const c = new TouchControls();
  c.layout(1000, 500);
  return c;
}

describe('TouchControls.layout', () => {
  it('sizes the stick radius and corner buttons off the shorter screen dimension', () => {
    const c = laidOut();
    const v = c.getVisual();
    expect(v.stickRadius).toBe(90);
    expect(v.weapon1).toEqual({ cx: 940, cy: 60, r: 40 });
    expect(v.weapon2).toEqual({ cx: 844, cy: 60, r: 40 });
    expect(v.interact).toEqual({ cx: 748, cy: 60, r: 40, pressed: false });
    expect(v.fire).toEqual({ cx: 875, cy: 250, r: 90, pressed: false });
  });
});

describe('TouchControls movement stick', () => {
  let c: TouchControls;
  beforeEach(() => { c = laidOut(); });

  it('opens a move stick at the touch-down origin on the left half', () => {
    c.pointerDown(1, 100, 100);
    expect(c.hasActiveTouch()).toBe(true);
    expect(c.getVisual().move).toEqual({ ox: 100, oy: 100, dx: 0, dy: 0 });
    expect(c.getVisual().fire.pressed).toBe(false);
  });

  it('tracks drag offset within the stick radius, unclamped', () => {
    c.pointerDown(1, 100, 100);
    c.pointerMove(1, 150, 150); // dx=50, dy=50, len≈70.7 < 90
    const move = c.getVisual().move!;
    expect(move.dx).toBeCloseTo(50);
    expect(move.dy).toBeCloseTo(50);
    expect(c.read().moveX).toBeCloseTo(50 / 90);
    expect(c.read().moveY).toBeCloseTo(50 / 90);
  });

  it('clamps drag magnitude to the stick radius past the edge', () => {
    c.pointerDown(1, 100, 100);
    c.pointerMove(1, 300, 100); // dx=200, dy=0, len=200 > 90
    const move = c.getVisual().move!;
    expect(move.dx).toBeCloseTo(90);
    expect(move.dy).toBeCloseTo(0);
    expect(c.read().moveX).toBeCloseTo(1);
  });

  it('clears on pointerUp for the matching id', () => {
    c.pointerDown(1, 100, 100);
    c.pointerUp(1);
    expect(c.hasActiveTouch()).toBe(false);
    expect(c.getVisual().move).toBeNull();
  });

  it('ignores pointerMove/pointerUp for a non-matching id', () => {
    c.pointerDown(1, 100, 100);
    c.pointerMove(2, 999, 999); // a second, unrelated touch id
    expect(c.getVisual().move).toEqual({ ox: 100, oy: 100, dx: 0, dy: 0 });
    c.pointerUp(2);
    expect(c.hasActiveTouch()).toBe(true); // stick 1 is untouched by id 2's pointerUp
  });
});

describe('TouchControls fire button (design/10 v33 — no more aim stick)', () => {
  let c: TouchControls;
  beforeEach(() => { c = laidOut(); });

  it('holding anywhere in the right half marks the fire button pressed, opens no move stick', () => {
    c.pointerDown(2, 600, 100); // right half, nowhere near the fixed button geometry
    expect(c.getVisual().fire).toEqual({ cx: 875, cy: 250, r: 90, pressed: true });
    expect(c.getVisual().move).toBeNull();
    expect(c.read().firing).toBe(true);
  });

  it('fires immediately on touch-down — no drag/threshold needed (unlike the old aim stick)', () => {
    c.pointerDown(2, 501, 100); // barely into the right half
    expect(c.read().firing).toBe(true);
    c.pointerMove(2, 501, 100); // no movement at all
    expect(c.read().firing).toBe(true);
  });

  it('releases on pointerUp for the matching id', () => {
    c.pointerDown(2, 600, 100);
    c.pointerUp(2);
    expect(c.getVisual().fire.pressed).toBe(false);
    expect(c.read().firing).toBe(false);
  });

  it('ignores pointerUp for a non-matching id', () => {
    c.pointerDown(2, 600, 100);
    c.pointerUp(3);
    expect(c.getVisual().fire.pressed).toBe(true);
  });
});

describe('TouchControls weapon-swap buttons', () => {
  let c: TouchControls;
  let switched: number[];
  beforeEach(() => {
    c = laidOut();
    switched = [];
    c.onSwitchWeapon = (slot) => switched.push(slot);
  });

  it('tapping weapon1 fires the callback and opens no stick', () => {
    c.pointerDown(1, 940, 60); // dead centre of weapon1
    expect(switched).toEqual([1]);
    expect(c.hasActiveTouch()).toBe(false);
    expect(c.getVisual().fire.pressed).toBe(false);
  });

  it('tapping weapon2 fires the callback and opens no stick', () => {
    c.pointerDown(1, 844, 60); // dead centre of weapon2
    expect(switched).toEqual([2]);
    expect(c.hasActiveTouch()).toBe(false);
  });

  it('buttons take priority over the fire zone even though both sit in the right half', () => {
    // Exactly on weapon1's edge (still inside the circle) — would otherwise start firing.
    c.pointerDown(1, 940 + 39, 60);
    expect(switched).toEqual([1]);
    expect(c.getVisual().fire.pressed).toBe(false);
  });

  it('a touch just outside both button circles falls through to firing', () => {
    c.pointerDown(1, 940 + 41, 60); // 41 > r(40), and far from weapon2 too
    expect(switched).toEqual([]);
    expect(c.getVisual().fire.pressed).toBe(true);
  });
});

describe('TouchControls INTERACT button (revive channel — a real gap this pass closed)', () => {
  let c: TouchControls;
  beforeEach(() => { c = laidOut(); });

  it('holding it marks `interacting` true — previously hardcoded false with no on-screen control at all', () => {
    c.pointerDown(3, 748, 60); // dead centre of interact
    expect(c.read().interacting).toBe(true);
    expect(c.getVisual().interact.pressed).toBe(true);
    expect(c.hasActiveTouch()).toBe(true);
  });

  it('opens no stick and does not also fire, even though it sits in the "fire half"', () => {
    c.pointerDown(3, 748, 60);
    expect(c.getVisual().move).toBeNull();
    expect(c.read().firing).toBe(false);
  });

  it('releases on pointerUp for the matching id', () => {
    c.pointerDown(3, 748, 60);
    c.pointerUp(3);
    expect(c.read().interacting).toBe(false);
    expect(c.getVisual().interact.pressed).toBe(false);
    expect(c.hasActiveTouch()).toBe(false);
  });

  it('ignores pointerUp for a non-matching id', () => {
    c.pointerDown(3, 748, 60);
    c.pointerUp(4);
    expect(c.read().interacting).toBe(true);
  });

  it('takes priority over the fire zone, same as the weapon buttons', () => {
    // Exactly on interact's edge (still inside the circle) — would otherwise start firing.
    c.pointerDown(3, 748 + 39, 60);
    expect(c.read().interacting).toBe(true);
    expect(c.getVisual().fire.pressed).toBe(false);
  });

  it('holding weapon1/weapon2 and interact independently (three simultaneous touches)', () => {
    const switched: number[] = [];
    c.onSwitchWeapon = (slot) => switched.push(slot);
    c.pointerDown(1, 940, 60); // weapon1
    c.pointerDown(2, 748, 60); // interact
    expect(switched).toEqual([1]);
    expect(c.read().interacting).toBe(true);
    c.pointerUp(2);
    expect(c.read().interacting).toBe(false);
  });

  it('moves with the rest of the corner cluster when mirrored', () => {
    c.setMirrored(true);
    expect(c.getVisual().interact).toEqual({ cx: 252, cy: 60, r: 40, pressed: false });
  });
});

describe('TouchControls.setMirrored (design/10 left-handed control layout)', () => {
  it('moves the weapon buttons to the opposite corner', () => {
    const c = laidOut();
    c.setMirrored(true);
    const v = c.getVisual();
    expect(v.weapon1).toEqual({ cx: 60, cy: 60, r: 40 });
    expect(v.weapon2).toEqual({ cx: 156, cy: 60, r: 40 });
  });

  it('moves the fire button to the opposite half too', () => {
    const c = laidOut();
    c.setMirrored(true);
    expect(c.getVisual().fire).toEqual({ cx: 125, cy: 250, r: 90, pressed: false });
  });

  it('swaps which half drives movement vs. fire', () => {
    const c = laidOut();
    c.setMirrored(true);
    c.pointerDown(1, 100, 100); // left half → fire, mirrored
    expect(c.getVisual().fire.pressed).toBe(true);
    expect(c.getVisual().move).toBeNull();

    c.pointerDown(2, 900, 400); // right half → move, mirrored
    expect(c.getVisual().move).toEqual({ ox: 900, oy: 400, dx: 0, dy: 0 });
  });

  it('re-lays out immediately against the last known screen size, no resize needed', () => {
    const c = laidOut();
    expect(c.getVisual().weapon1.cx).toBe(940); // still standard before the toggle
    c.setMirrored(true);
    expect(c.getVisual().weapon1.cx).toBe(60);
  });

  it('is a no-op when the value has not actually changed', () => {
    const c = laidOut();
    const before = c.getVisual().weapon1;
    c.setMirrored(false); // already false
    expect(c.getVisual().weapon1).toEqual(before);
  });

  it('toggling back to standard restores the original geometry', () => {
    const c = laidOut();
    c.setMirrored(true);
    c.setMirrored(false);
    expect(c.getVisual().weapon1).toEqual({ cx: 940, cy: 60, r: 40 });
  });

  it('does nothing (no throw) before the first layout() call', () => {
    const c = new TouchControls();
    expect(() => c.setMirrored(true)).not.toThrow();
  });

  it('a real pointerDown hits the button at its NEW mirrored position, not the old one', () => {
    const c = laidOut();
    c.setMirrored(true);
    const switched: number[] = [];
    c.onSwitchWeapon = (slot) => switched.push(slot);

    c.pointerDown(1, 60, 60); // weapon1's new (mirrored) centre
    expect(switched).toEqual([1]);
    expect(c.hasActiveTouch()).toBe(false); // a button tap, not a stick
  });

  it('the OLD (standard) button position falls through to a stick once mirrored', () => {
    const c = laidOut();
    c.setMirrored(true);
    const switched: number[] = [];
    c.onSwitchWeapon = (slot) => switched.push(slot);

    c.pointerDown(1, 940, 60); // weapon1's old (standard) centre — now empty space
    expect(switched).toEqual([]);
    expect(c.hasActiveTouch()).toBe(true);
  });
});

describe('TouchControls.getVisual().active', () => {
  it('starts false, and never touches everything else before any touch', () => {
    const c = laidOut();
    expect(c.getVisual().active).toBe(false);
  });

  it('flips true on the very first pointerDown and never resets', () => {
    const c = laidOut();
    c.pointerDown(1, 100, 100);
    expect(c.getVisual().active).toBe(true);
    c.pointerUp(1);
    expect(c.getVisual().active).toBe(true); // stays true — "this session uses touch"
  });

  it('flips true even for a button tap, which never opens a stick', () => {
    const c = laidOut();
    c.pointerDown(1, 940, 60); // weapon1 button
    expect(c.getVisual().active).toBe(true);
  });
});

describe('TouchControls.setAssumeTouch', () => {
  // The bug this exists for: `active` used to be `everTouched` alone, so a phone player
  // opened the game and saw NO controls — no joystick, no fire button, no weapon buttons —
  // until they had already guessed where to press. The platform has to declare which case a
  // session is (`WebInput` from a coarse-pointer probe, `WeChatInput` unconditionally),
  // because this class owns no globals and cannot ask.

  it('draws the controls before any touch when the platform declares one', () => {
    const c = laidOut();
    expect(c.getVisual().active).toBe(false);
    c.setAssumeTouch(true);
    expect(c.getVisual().active).toBe(true);
  });

  it('leaves a real touch session active even if the declaration is withdrawn', () => {
    // `everTouched` and the declaration are independent inputs to one answer; a session
    // that HAS been touched stays a touch session regardless.
    const c = laidOut();
    c.pointerDown(1, 100, 100);
    c.setAssumeTouch(false);
    expect(c.getVisual().active).toBe(true);
  });

  it('changes nothing else about the visual', () => {
    // Specifically not a layout or geometry switch — the buttons were always positioned,
    // only the layer's visibility was gated. A control that MOVED when it appeared would be
    // a different bug with the same symptom.
    const before = laidOut().getVisual();
    const after = (() => {
      const c = laidOut();
      c.setAssumeTouch(true);
      return c.getVisual();
    })();
    expect(after.fire).toEqual(before.fire);
    expect(after.weapon1).toEqual(before.weapon1);
    expect(after.weapon2).toEqual(before.weapon2);
    expect(after.interact).toEqual(before.interact);
    expect(after.stickRadius).toEqual(before.stickRadius);
    expect(after.move).toEqual(before.move);
  });
});
