/**
 * `ArtFade` — the ramp lobby art plays when it lands after the lobby is already up
 * (render/uiSkins.ts's `lobby` tier, 2026-09-28).
 */
import { describe, it, expect } from 'vitest';
import { ART_FADE_MS, ArtFade } from './artFade';

describe('ArtFade', () => {
  it('is idle and fully opaque until started, and leaves its target alone', () => {
    const target = { alpha: 0.4 };
    const fade = new ArtFade(target);
    expect(fade.active).toBe(false);
    expect(fade.level).toBe(1);
    fade.update(50);
    expect(target.alpha).toBe(0.4); // an idle fade writes nothing
  });

  it('ramps its target from 0 to 1 over ART_FADE_MS, then stops', () => {
    const target = { alpha: 1 };
    const fade = new ArtFade(target);
    fade.start();
    expect(target.alpha).toBe(0);
    expect(fade.active).toBe(true);
    fade.update(ART_FADE_MS / 4);
    expect(target.alpha).toBeCloseTo(0.25);
    fade.update(ART_FADE_MS); // overshoot clamps
    expect(target.alpha).toBe(1);
    expect(fade.active).toBe(false);
    target.alpha = 0.7; // an owner changing it afterwards is not fought
    fade.update(16);
    expect(target.alpha).toBe(0.7);
  });

  it('ignores a negative step, and restarts from 0 when started again', () => {
    const target = { alpha: 1 };
    const fade = new ArtFade(target);
    fade.start();
    fade.update(-100);
    expect(target.alpha).toBe(0);
    fade.update(ART_FADE_MS / 2);
    fade.start();
    expect(target.alpha).toBe(0);
  });

  it('with no target, only reports its level — for an alpha its owner animates', () => {
    const fade = new ArtFade();
    fade.start();
    expect(fade.level).toBe(0);
    fade.update(ART_FADE_MS / 2);
    expect(fade.level).toBeCloseTo(0.5);
    fade.update(ART_FADE_MS);
    expect(fade.level).toBe(1);
  });
});
