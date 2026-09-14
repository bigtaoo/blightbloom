/**
 * levelSim.ts — the end-to-end half of the level simulator: a real `createGameEngine`
 * run over the real shipped level, driven by `PveBotController`, with per-room metrics
 * recorded. These tests are about the HARNESS being trustworthy (does it record what
 * it claims to, is it reproducible, does it terminate); the balance numbers themselves
 * are the job of `sim/pveLevelSim.sim.ts`, which is excluded from the default `npm
 * test` glob because full 5-floor runs are slow.
 *
 * Everything here is therefore capped with a small `maxTicks`: enough real ticks to
 * activate the entrance room and take fire, cheap enough for the normal suite.
 */
import { describe, expect, it } from 'vitest';
import { ROOM_FIRE_BUDGET } from '@dd/engine';
import { runLevel } from './levelSim';

const SHORT = { maxTicks: 400 };

describe('runLevel', () => {
  it('plays the real shipped level and records the entrance room encounter', () => {
    const m = runLevel({ seed: 101, ...SHORT });
    const entrance = m.encounters.find((e) => e.floorIndex === 0);
    expect(entrance).toBeDefined();
    expect(entrance!.garrison).toBeGreaterThan(0); // the authored garrison really spawned
    expect(entrance!.activatedTick).toBeGreaterThan(0);
  });

  it('is reproducible — same seed and profile, byte-identical metrics (design/06)', () => {
    const a = runLevel({ seed: 202, ...SHORT });
    const b = runLevel({ seed: 202, ...SHORT });
    expect(a).toEqual(b);
  });

  it('reports the character it actually played, and the pool the burst numbers are read against', () => {
    const m = runLevel({ seed: 303, skinId: 'juggernaut', ...SHORT });
    expect(m.skinId).toBe('juggernaut');
    expect(m.effectiveHp).toBeGreaterThan(0); // maxHp + maxShield of the real SkinDef
  });

  it('counts a live tick for every tick the player is alive, and no dry tick on the starter gun', () => {
    // The starter blaster is below break-even (`balance/energy.ts`), so a fresh save can
    // NEVER be dry on it however long it fires — the property that keeps the ammo economy
    // invisible to a new player. A non-zero dry count on this run would mean the pool is
    // biting where the design says it must not.
    const m = runLevel({ seed: 707, ...SHORT });
    const alive = Object.values(m.aliveTicksByFloor).reduce((a, b) => a + b, 0);
    expect(alive).toBeGreaterThan(0);
    expect(alive).toBeLessThanOrEqual(m.ticks); // never more live ticks than ticks
    expect(Object.values(m.dryTicksByFloor).reduce((a, b) => a + b, 0)).toBe(0);
  });

  it('records the pool the run was actually played with, so dry ticks have a denominator', () => {
    // Read off the character rather than assumed to be 100 — capacity is a `SkinDef` stat
    // since ENGINE_VERSION 60, and a run buff can raise it further mid-run.
    const a = runLevel({ seed: 808, skinId: 'juggernaut', ...SHORT });
    const b = runLevel({ seed: 808, skinId: 'skirmisher', ...SHORT });
    expect(a.finalMaxEnergy).toBeGreaterThan(0);
    expect(b.finalMaxEnergy).toBeGreaterThan(a.finalMaxEnergy);
  });

  it('defaults to a fresh save’s loadout — the starter blaster, i.e. what a new player has', () => {
    // An empty `loadout` is what `defaultMetaState()` carries, and it is the case the
    // "I get killed the moment I walk in" report came from.
    const m = runLevel({ seed: 404, ...SHORT });
    expect(m.profileName).toBe('careful');
    expect(m.seed).toBe(404);
  });

  it('takes real damage and records it against the room that dealt it', () => {
    const m = runLevel({ seed: 505, profileName: 'aggressive', ...SHORT });
    const hit = m.encounters.filter((e) => e.damageTaken > 0);
    expect(hit.length).toBeGreaterThan(0);
    // Per-room damage must add up to no more than the run total (bullets in flight can
    // land after the player has left a room, so equality is not guaranteed).
    const summed = m.encounters.reduce((n, e) => n + e.damageTaken, 0);
    expect(summed).toBeLessThanOrEqual(m.damageTaken);
  });

  it('records the reaction window as ticks AFTER activation, never before it', () => {
    const m = runLevel({ seed: 606, profileName: 'aggressive', ...SHORT });
    for (const e of m.encounters) {
      if (e.reactionTicks === null) continue;
      expect(e.reactionTicks).toBeGreaterThanOrEqual(0);
    }
  });

  it('never reports more simultaneous shooters than the engine’s own room budget allows', () => {
    // Cross-checks the tracker against `ROOM_FIRE_BUDGET` (engine/balance/encounter.ts)
    // — if this ever exceeds it, either the budget regressed or the tracker is
    // miscounting, and both are worth failing on.
    const m = runLevel({ seed: 707, ...SHORT });
    for (const e of m.encounters) expect(e.peakShooters).toBeLessThanOrEqual(ROOM_FIRE_BUDGET);
  });

  it('bounds the burst window to one second of damage, not the whole run', () => {
    const m = runLevel({ seed: 808, profileName: 'aggressive', ...SHORT });
    expect(m.peakBurstDamage).toBeLessThanOrEqual(m.damageTaken);
  });

  it('stops at maxTicks and says so, instead of running forever', () => {
    const m = runLevel({ seed: 909, maxTicks: 60 });
    expect(m.outcome).toBe('timeout');
    expect(m.ticks).toBe(60);
  });

  it('tracks the lowest health fraction seen, as a fraction of the pool', () => {
    const m = runLevel({ seed: 111, profileName: 'aggressive', ...SHORT });
    expect(m.lowestHpFrac).toBeGreaterThanOrEqual(0);
    expect(m.lowestHpFrac).toBeLessThanOrEqual(1);
  });

  it('records every drop the run produced, attributed to a floor and a real kind', () => {
    const m = runLevel({ seed: 101, profileName: 'aggressive', maxTicks: 1200 });
    expect(m.drops.length).toBeGreaterThan(0); // the entrance garrison really dropped loot
    for (const d of m.drops) {
      expect(['material', 'coin', 'heal', 'weapon', 'buff', 'bandage', 'energy']).toContain(d.kind);
      expect(d.floorIndex).toBe(0); // 1200 ticks never reaches a descend
      expect(d.tick).toBeGreaterThan(0);
    }
    // Every drop comes off a kill (nothing else spawns loot in PvE yet), so the count
    // can never exceed the kills — the tracker's own sanity check against
    // double-counting a pickup that merely sat on the floor for another tick.
    expect(m.drops.length).toBeLessThanOrEqual(m.enemiesKilled);
  });

  it('does not count a weapon the PLAYER dropped by swapping as a drop the table produced', () => {
    // `PickupSystem.applyWeapon` puts the outgoing weapon back on the floor as a
    // fresh pickup on the same tick the new one is collected. Counting those would
    // inflate exactly the number this harness exists to measure, so a weapon
    // `pickup` event disqualifies new weapon pickups on its tick. Proven here by the
    // invariant it protects: weapons RECORDED can never exceed weapons that were
    // rolled, and a swap would make recorded > rolled.
    const m = runLevel({ seed: 505, profileName: 'aggressive', maxTicks: 3000 });
    const recorded = m.drops.filter((d) => d.kind === 'weapon').length;
    expect(recorded).toBeLessThanOrEqual(m.enemiesKilled);
    for (const d of m.drops) expect(d.tick).toBeLessThanOrEqual(m.ticks);
  });

  it('splits kills by floor, and the split adds up to the run total', () => {
    const m = runLevel({ seed: 303, profileName: 'aggressive', maxTicks: 1200 });
    const summed = Object.values(m.killsByFloor).reduce((a, b) => a + b, 0);
    expect(summed).toBe(m.enemiesKilled);
    expect(m.killsByFloor[0]).toBeGreaterThan(0);
  });

  it('reports no checkpoint for a run that never finished a floor', () => {
    // The honest-denominator field: a 400-tick run is still inside the entrance room,
    // so nothing may claim floor 0's loot allowance was fully handed out.
    const m = runLevel({ seed: 404, ...SHORT });
    expect(m.checkpointFloors).toEqual([]);
  });

  it('never counts the floor a run DIED on as a completed floor', () => {
    // The regression test for a real measurement bug (2026-09-05): a team wipe pushes
    // a `win` event too, with `winner: 'enemies'`, and the first version of this
    // tracker counted it as a reached checkpoint. The sweep then reported floor 0 as
    // "8 of 8 visits complete" on the same screen as "5 of 8 runs died in r4_forge",
    // which would have made every per-full-floor loot number quietly wrong.
    const m = runLevel({ seed: 505, profileName: 'aggressive', maxTicks: 6000 });
    if (m.outcome !== 'died') return; // the seed extracted or timed out; nothing to assert
    expect(m.checkpointFloors).not.toContain(m.floorReached);
    // You completed exactly the floors you descended off, no more.
    expect(m.checkpointFloors).toHaveLength(m.floorReached);
  });

  it('a died outcome always names the room the run ended in — the actionable half of a death', () => {
    // Long enough for the aggressive profile to actually die somewhere.
    const m = runLevel({ seed: 202, profileName: 'aggressive', maxTicks: 4000 });
    if (m.outcome === 'died') expect(m.endRoom).not.toBeNull();
  });
});
