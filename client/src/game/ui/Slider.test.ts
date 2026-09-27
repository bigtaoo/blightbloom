/**
 * `Slider`'s menu-shell half (2026-09-27): a width that can change after construction, and the
 * crystal fill up to the knob. The drag lifecycle and the commit cue are `widgets.test.ts`'s,
 * where they were written before the slider moved to its own file.
 */
import { describe, it, expect } from 'vitest';
import type { Graphics, Rectangle } from 'pixi.js';
import { Slider } from './Slider';
import { Slider as ReExported } from './widgets';

function parts(s: Slider) {
  return s as unknown as { knob: Graphics; fill: Graphics };
}

describe('Slider — width and fill', () => {
  it('is still importable from widgets.ts', () => {
    expect(ReExported).toBe(Slider);
  });

  it('moves the knob and the hit area with a new width, keeping the value', () => {
    const s = new Slider({ w: 200 });
    s.set(0.5);
    expect(parts(s).knob.x).toBe(100);
    s.setWidth(300);
    expect(s.width).toBe(300);
    expect(s.get()).toBe(0.5);
    expect(parts(s).knob.x).toBe(150);
    expect((s.view.hitArea as Rectangle).width).toBeGreaterThan(300);
  });

  it('fills up to the knob, and draws no fill at zero', () => {
    const s = new Slider({ w: 200 });
    s.set(0);
    expect(parts(s).fill.bounds.width).toBe(0);
    s.set(0.75);
    expect(parts(s).fill.bounds.width).toBeCloseTo(150, 0);
  });

  it('ignores a same-width resize', () => {
    const s = new Slider({ w: 200 });
    const before = s.view.hitArea;
    s.setWidth(200);
    expect(s.view.hitArea).toBe(before);
  });
});
