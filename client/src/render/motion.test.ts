/**
 * The "reduce motion" mirror (`motion.ts`, 2026-09-22).
 *
 * A three-function module, so what is worth pinning is not the arithmetic — there is none —
 * but the two properties a module singleton can lose silently: it starts in the state the
 * game has always shipped in, and a test that changes it can put it back.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { motionReduced, resetReduceMotion, setReduceMotion } from './motion';

afterEach(() => resetReduceMotion());

describe('reduce motion', () => {
  it('is OFF until somebody asks for it', () => {
    // The default is load-bearing rather than arbitrary: every host that never wires
    // `SettingsBinding` (a test, a tool, the sim harnesses) reads this module, and a default of
    // `true` would silently delete the camera shake from all of them — including from the
    // screenshots and frame probes that art work is judged on.
    expect(motionReduced()).toBe(false);
  });

  it('holds what it was set to, both ways', () => {
    setReduceMotion(true);
    expect(motionReduced()).toBe(true);
    setReduceMotion(false);
    expect(motionReduced()).toBe(false);
  });

  it('resets to the default, which is what keeps one case out of the next', () => {
    setReduceMotion(true);
    resetReduceMotion();
    expect(motionReduced()).toBe(false);
  });
});
