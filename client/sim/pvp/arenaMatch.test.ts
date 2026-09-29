/**
 * `arenaMatch.ts` — the match runner and bookkeeping behind `pvpCapacity.sim.ts`. The sweep's
 * conclusions are counts of distinct matches and of starved ticks, so both are pinned here:
 * that a seed actually varies the match, and that each counter counts what it says.
 */
import { describe, expect, it } from 'vitest';
import { PVP_SCALE_FACTOR, WEAPON_SIM_BY_ID, createGameEngine } from '@dd/engine';
import { ARENA_PROFILES } from './ArenaBotController';
import { equipArenaGun, runArenaMatch, shuffledArenaConfig } from './arenaMatch';

describe('equipArenaGun', () => {
  it('puts the gun in the gun slot, scaled as an arena pickup is', () => {
    const p = createGameEngine(shuffledArenaConfig(11, 2)).state.players[0]!;
    equipArenaGun(p, 'cannon');
    const gun = p.weapons.find((w) => w.spec.kind === 'ranged')!;
    expect(gun.spec.name).toBe('cannon');
    expect(gun.spec.damage).toBe(Math.round(WEAPON_SIM_BY_ID.cannon!.damage * PVP_SCALE_FACTOR));
    expect(p.weapon).toBe(gun); // the gun slot was active, so the pointer moved with it
    expect(p.weapons.some((w) => w.spec.kind === 'melee')).toBe(true);
  });

  it('refuses a blade', () => {
    const p = createGameEngine(shuffledArenaConfig(11, 2)).state.players[0]!;
    expect(() => equipArenaGun(p, 'hammer')).toThrow(/not a gun/);
  });
});

// Each case plays whole arena matches: seconds each alone, more under the full suite's load.
describe('runArenaMatch', { timeout: 60_000 }, () => {
  it('is a function of its inputs', () => {
    expect(runArenaMatch(5, 2, ARENA_PROFILES.full)).toEqual(runArenaMatch(5, 2, ARENA_PROFILES.full));
  });

  it('plays a different match per seed, even for two seats and a spread-free gun', () => {
    // Two seats have two seatings; without the per-seat start delay this was two matches.
    const outcomes = new Set<string>();
    for (let seed = 1; seed <= 8; seed++) {
      const m = runArenaMatch(seed, 2, ARENA_PROFILES.full, { gun: 'flamer' });
      outcomes.add(`${m.ticks}:${m.winner}`);
    }
    expect(outcomes.size).toBeGreaterThan(2);
  });

  it('counts a starved seat whatever it holds, and a dry one only while holding the gun', () => {
    // A 1-point bar can never pay for a cannon pull: every live tick is starved.
    const m = runArenaMatch(5, 2, ARENA_PROFILES.shipped, { gun: 'cannon', pool: 1 });
    for (const s of m.bySeat) {
      expect(s.starvedTicks).toBe(s.liveTicks);
      expect(s.dryTicks).toBe(s.liveTicks); // the shipped bot never holsters it
      expect(s.shots).toBe(0);
    }
    const blade = runArenaMatch(5, 2, ARENA_PROFILES.lootsDry, { gun: 'cannon', pool: 1 });
    for (const s of blade.bySeat) {
      expect(s.starvedTicks).toBe(s.liveTicks);
      expect(s.dryTicks).toBeLessThan(s.liveTicks); // it put the gun away
      expect(s.swaps).toBeGreaterThan(0);
    }
  });

  it('counts shots, parries and the lowest bar', () => {
    const m = runArenaMatch(5, 2, ARENA_PROFILES.parries);
    const seats = m.bySeat;
    expect(seats.every((s) => s.shots > 0 && s.liveTicks > 0)).toBe(true);
    expect(seats.some((s) => s.parries > 0)).toBe(true);
    expect(runArenaMatch(5, 2, ARENA_PROFILES.shipped).bySeat.every((s) => s.parries === 0 && s.swaps === 0)).toBe(true);
    for (const s of runArenaMatch(5, 2, ARENA_PROFILES.shipped, { gun: 'novaburst' }).bySeat) {
      expect(s.minEnergyFrac).toBeLessThan(1);
      expect(s.minEnergyFrac).toBeGreaterThanOrEqual(0);
    }
  });

  it('resizes every bar when asked', () => {
    const m = runArenaMatch(5, 2, ARENA_PROFILES.shipped, { gun: 'novaburst', pool: 30 });
    // novaburst costs 26: from a 30 bar one pull leaves 4, well under a fifth.
    expect(Math.min(...m.bySeat.map((s) => s.minEnergyFrac))).toBeLessThan(0.2);
  });
});
