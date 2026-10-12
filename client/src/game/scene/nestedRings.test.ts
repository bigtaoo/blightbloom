/**
 * `nestedAlphas` — the alphas that make nested translucent shapes composite to a chosen profile
 * (room light, wall cast shadow, wall base hug). The property that matters is the composite, so that
 * is what is asserted: lay the shapes over each other the way the GPU will and read every band back.
 */
import { describe, it, expect } from 'vitest';
import { nestedAlphas } from './nestedRings';

/** Composite darkness of band `j`, under shapes `j..n-1`. */
function composite(alphas: readonly number[], j: number): number {
  let clear = 1;
  for (let k = j; k < alphas.length; k++) clear *= 1 - alphas[k]!;
  return 1 - clear;
}

describe('nestedAlphas', () => {
  it('composites every band back to its target', () => {
    const targets = [0.45, 0.4, 0.31, 0.2, 0.08, 0.01];
    const a = nestedAlphas(targets);
    targets.forEach((c, j) => expect(composite(a, j)).toBeCloseTo(c, 12));
  });

  it('gives the outermost shape its band\'s own darkness — nothing lies under it', () => {
    expect(nestedAlphas([0.5, 0.3]).at(-1)).toBeCloseTo(0.3, 12);
  });

  it('keeps every alpha in [0, 1) for a profile that does not increase outward', () => {
    for (const a of nestedAlphas([0.43, 0.43, 0.2, 0.2, 0])) {
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThan(1);
    }
  });

  it('is empty for no bands', () => {
    expect(nestedAlphas([])).toEqual([]);
  });
});
