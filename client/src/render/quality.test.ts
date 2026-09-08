/**
 * The quality-tier table and its `'auto'` policy (`quality.ts`, 2026-08-25).
 *
 * The thing worth testing here is NOT "the profiles differ" — a table of booleans differs from
 * another table of booleans by construction, and an assertion that just reads the constants back
 * would pass with the tiers swapped. What has to hold is DIRECTIONAL and, since the `medium` tier
 * (2026-09-08), TRANSITIVE: every knob must be monotone down the whole ladder, so no rung is more
 * expensive than the rung above it on any knob. A reversed or out-of-order table is byte-identical
 * in any count and catastrophic in effect (design/ROADMAP: the reversed shading ramp).
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  QUALITY_SETTINGS,
  activeQuality,
  qualityProfile,
  resetActiveQuality,
  resolveTier,
  setActiveQuality,
  type QualityTier,
} from './quality';

afterEach(() => resetActiveQuality());

/** The ladder, most expensive first. `resolveTier`'s own `AUTO_LADDER` is private; this is the
 *  same order restated as the property the table has to satisfy. */
const LADDER = ['high', 'medium', 'low'] as const;

describe('quality profiles', () => {
  it('never makes a rung more expensive than the one above it, on any knob', () => {
    for (let i = 1; i < LADDER.length; i++) {
      const above = qualityProfile(LADDER[i - 1]!);
      const here = qualityProfile(LADDER[i]!);
      // The boolean passes: a cheaper rung may drop one the rung above runs, never the reverse.
      for (const knob of ['sceneLight', 'screenFx', 'bloom', 'actorShaders'] as const) {
        if (!above[knob]) expect(here[knob], `${here.tier}.${knob}`).toBe(false);
      }
      // The numeric ones as inequalities rather than pinned values, so retuning a tier does not
      // have to come here — only INVERTING one does. `<=`, not `<`: `medium` deliberately keeps
      // high's `resolutionCap` (see its note in quality.ts), i.e. a rung may spend its whole
      // saving on one knob.
      expect(here.particleBudget, `${here.tier}.particleBudget`).toBeLessThanOrEqual(above.particleBudget);
      expect(here.resolutionCap, `${here.tier}.resolutionCap`).toBeLessThanOrEqual(above.resolutionCap);
    }
    // ...and the two ends are strictly apart, so a table whose rungs are all EQUAL — which
    // satisfies every `<=` above — still fails here.
    const hi = qualityProfile('high');
    const lo = qualityProfile('low');
    expect(lo.particleBudget).toBeLessThan(hi.particleBudget);
    expect(lo.resolutionCap).toBeLessThan(hi.resolutionCap);
  });

  it('spends the medium rung on the three passes stacked ABOVE the lighting, not on lighting', () => {
    // The whole reason the rung exists: on a mobile tiler the render-target pass COUNT is the
    // cost, and `sceneLight` is the one pass that carries the game's look. A medium tier that
    // dropped the lighting and kept the vignette would be cheaper by the same count and would
    // look like a different game.
    const mid = qualityProfile('medium');
    expect(mid.sceneLight).toBe(true);
    expect(mid.screenFx).toBe(false);
    expect(mid.bloom).toBe(false);
    expect(mid.actorShaders).toBe(false);
  });

  it('keeps particles alive on the low tier — thinner, not gone', () => {
    // 0 is a legal budget for the ParticleSystem (see its `scaled`), but a tier that ships it
    // would silently delete muzzle flashes, which carry information about who is shooting.
    expect(qualityProfile('low').particleBudget).toBeGreaterThan(0);
  });

  it('reports its own tier back, so a profile is self-describing', () => {
    for (const tier of [...LADDER] as QualityTier[]) {
      expect(qualityProfile(tier).tier).toBe(tier);
    }
  });
});

describe('resolveTier', () => {
  it('honours an explicit pick regardless of what the watchdog decided', () => {
    // The case that matters: the watchdog stepped all the way down, then the player asked for
    // high anyway. Their choice wins — otherwise the setting would be a suggestion the game
    // can veto.
    for (const steps of [0, 1, 2, 99]) {
      expect(resolveTier('high', steps)).toBe('high');
      expect(resolveTier('medium', steps)).toBe('medium');
      expect(resolveTier('low', steps)).toBe('low');
    }
  });

  it('walks auto down one rung per downgrade', () => {
    expect(resolveTier('auto', 0)).toBe('high');
    expect(resolveTier('auto', 1)).toBe('medium');
    expect(resolveTier('auto', 2)).toBe('low');
  });

  it('clamps past the ends of the ladder instead of falling off it', () => {
    // The watchdog bounds its own steps, so this is defence against a caller that does not: an
    // out-of-range index would otherwise hand `undefined` to the live mirror as a QualityTier.
    expect(resolveTier('auto', 3)).toBe('low');
    expect(resolveTier('auto', 99)).toBe('low');
    expect(resolveTier('auto', -1)).toBe('high');
    expect(resolveTier('auto', 1.9)).toBe('medium');
  });
});

describe('the live mirror', () => {
  it('starts high, so a host that never wires the setting still gets the authored look', () => {
    expect(activeQuality().tier).toBe('high');
  });

  it('swaps the whole profile, not just the tier name', () => {
    for (const tier of [...LADDER] as QualityTier[]) {
      setActiveQuality(tier);
      expect(activeQuality()).toEqual(qualityProfile(tier));
    }
  });
});

describe('QUALITY_SETTINGS (the settings screen cycles this order)', () => {
  it('lists auto first and covers every setting exactly once', () => {
    expect(QUALITY_SETTINGS[0]).toBe('auto');
    expect([...QUALITY_SETTINGS].sort()).toEqual(['auto', 'high', 'low', 'medium']);
    // The cycle walks DOWN the cost after `'auto'`, which is the direction a player who opened
    // this screen looking for it is walking.
    expect([...QUALITY_SETTINGS].slice(1)).toEqual([...LADDER]);
  });
});
