/**
 * Weapon rarity distribution shifting toward higher tiers with floor depth (Task 7,
 * 2026-09-23). `rollWeaponId` replaces `WEAPON_DROP_POOL`'s old flat, depth-blind pick
 * for both `ChestSystem`'s payout and a shop's weapon slot — these tests hold the
 * PARTITION (every pool weapon lands in exactly the tier its own `rarity` says),
 * the DRAW COST (still one draw, matching the flat pick it replaced), and the actual
 * SHAPE of the shift (deeper floors draw higher tiers more often, on average).
 */
import { describe, it, expect } from 'vitest';
import { Prng } from '../math/prng';
import { RARITY_ORDER } from '../balance/rarity';
import { WEAPON_SPECS } from './weaponSpecs';
import { WEAPON_DROP_POOL } from './drops';
import { WEAPON_POOL_BY_RARITY, rollWeaponId } from './weaponRarityByDepth';

describe('WEAPON_POOL_BY_RARITY — WEAPON_DROP_POOL partitioned by intrinsic rarity', () => {
  it('every pool weapon appears in exactly the tier its own WEAPON_SPECS.rarity says', () => {
    for (const tier of RARITY_ORDER) {
      for (const id of WEAPON_POOL_BY_RARITY[tier]) expect(WEAPON_SPECS[id]!.rarity).toBe(tier);
    }
  });

  it('accounts for every pool weapon exactly once — no weapon lost, none duplicated', () => {
    const all = RARITY_ORDER.flatMap((tier) => WEAPON_POOL_BY_RARITY[tier]);
    expect(all.length).toBe(WEAPON_DROP_POOL.length);
    expect(new Set(all).size).toBe(WEAPON_DROP_POOL.length);
    expect(new Set(all)).toEqual(new Set(WEAPON_DROP_POOL));
  });

  it('every tier has at least one weapon — an empty tier would make a nonzero weight on it unrollable', () => {
    for (const tier of RARITY_ORDER) expect(WEAPON_POOL_BY_RARITY[tier].length, tier).toBeGreaterThan(0);
  });
});

describe('rollWeaponId — one weighted draw, shifting toward higher tiers with floor depth', () => {
  it('always returns a member of WEAPON_DROP_POOL, at every floor index', () => {
    const prng = new Prng(1);
    for (let floorIndex = 0; floorIndex < 5; floorIndex++) {
      for (let i = 0; i < 50; i++) expect(WEAPON_DROP_POOL).toContain(rollWeaponId(prng, floorIndex));
    }
  });

  it('is deterministic — the same seed at the same floor index rolls the same weapon', () => {
    expect(rollWeaponId(new Prng(42), 2)).toBe(rollWeaponId(new Prng(42), 2));
  });

  it('spends exactly one draw, same as the flat pick it replaces', () => {
    for (const seed of [1, 7, 99]) {
      const p = new Prng(seed);
      rollWeaponId(p, 3);
      const control = new Prng(seed);
      control.nextInt(2);
      expect(p.peek()).toBe(control.peek());
    }
  });

  it('an out-of-range floorIndex clamps rather than reading out of bounds', () => {
    const prng = new Prng(9);
    expect(() => rollWeaponId(prng, -1)).not.toThrow();
    expect(() => rollWeaponId(prng, 4)).not.toThrow();
    expect(() => rollWeaponId(prng, 99)).not.toThrow();
  });

  /** Average rarity-tier INDEX (0=common .. 4=legendary) over many rolls at one floor
   *  index — the measurable form of "shifts toward higher tiers with depth". */
  function averageTierIndex(floorIndex: number, samples: number): number {
    const prng = new Prng(1000 + floorIndex);
    let total = 0;
    for (let i = 0; i < samples; i++) {
      const id = rollWeaponId(prng, floorIndex);
      total += RARITY_ORDER.indexOf(WEAPON_SPECS[id]!.rarity);
    }
    return total / samples;
  }

  it('floor 4 rolls a meaningfully higher average rarity tier than floor 0', () => {
    const floor0 = averageTierIndex(0, 4000);
    const floor4 = averageTierIndex(4, 4000);
    expect(floor4).toBeGreaterThan(floor0 + 0.5); // comfortably outside sampling noise
  });

  it('the average rarity tier rises monotonically (within sampling noise) across floors 0-4', () => {
    const averages = [0, 1, 2, 3, 4].map((i) => averageTierIndex(i, 6000));
    for (let i = 1; i < averages.length; i++) {
      expect(averages[i]!, `floor ${i} vs floor ${i - 1}`).toBeGreaterThan(averages[i - 1]! - 0.05);
    }
    expect(averages[4]!).toBeGreaterThan(averages[0]!);
  });

  it('common and legendary weapons are both reachable at floor 0 and at floor 4', () => {
    // Neither end of the ladder is ever fully closed off — a run can still get lucky
    // early or unlucky late, this is a SHIFT in odds, not a hard gate.
    const seenAt = (floorIndex: number): Set<string> => {
      const prng = new Prng(5 + floorIndex);
      const tiers = new Set<string>();
      for (let i = 0; i < 2000; i++) tiers.add(WEAPON_SPECS[rollWeaponId(prng, floorIndex)]!.rarity);
      return tiers;
    };
    expect(seenAt(0).has('common')).toBe(true);
    expect(seenAt(0).has('legendary')).toBe(true);
    expect(seenAt(4).has('common')).toBe(true);
    expect(seenAt(4).has('legendary')).toBe(true);
  });
});
