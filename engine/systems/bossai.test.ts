/**
 * Boss AI depth (design/09's own aspirational `EnemyBlueprint.onDeathSpawn`/`traits`,
 * ENGINE_VERSION 27). Exercises the Blightlord's two shipped traits end-to-end through
 * the real systems (DeathDropsSystem's onDeathSpawn adds, WeaponFireSystem's enrage
 * latch) — not just the pure `buildEnemyActor` factory in isolation.
 */
import { describe, it, expect } from 'vitest';
import { createGameState } from '@dd/engine/state/GameState';
import type { GameState } from '@dd/engine/state/GameState';
import { buildEnemyActor, BLIGHTLORD, BASIC_ENEMY, IRONWARDEN } from '@dd/engine/content/enemies';
import { pxToFp } from '@dd/engine/content/convert';
import { DeathDropsSystem, WeaponFireSystem } from '@dd/engine/systems';
import type { DungeonConfig } from '@dd/engine/world/dungeon';

const CFG = { seed: 13, worldW: 1600, worldH: 1200, waves: [] as const };
const state = (): GameState => createGameState(CFG);

// Minimal DungeonConfig — only difficultyCurve matters for these tests; no floor is
// ever actually generated (SpawnSystem.tickDungeon never runs), so the room library
// can stay empty.
const CURVE_DUN: DungeonConfig = {
  biomeId: 't',
  nameKey: 't',
  floorCount: 5,
  roomsPerFloor: { min: 1, max: 1 },
  pieceTags: ['t'],
  layout: 'linear',
  extractionPieceId: 't_extract',
  bossPieceId: 't_boss',
  difficultyCurve: { base: 1, perFloor: 1 },
};
const dungeonState = (floorIndex: number): GameState => {
  const s = createGameState({ ...CFG, dungeon: { config: CURVE_DUN, library: [] } });
  s.floorIndex = floorIndex;
  return s;
};

describe('buildEnemyActor — the shared factory (design/09)', () => {
  it('a plain basic mob carries no boss traits', () => {
    const s = state();
    const e = buildEnemyActor(s, pxToFp(400), pxToFp(400), 'basic');
    expect(e.enrage).toBeUndefined();
    expect(e.enraged).toBe(false);
    expect(e.onDeathSpawn).toBeUndefined();
  });

  it('a blightlord carries both traits from its blueprint, unenraged at full HP', () => {
    const s = state();
    const e = buildEnemyActor(s, pxToFp(400), pxToFp(400), 'blightlord');
    expect(e.enrage).toEqual(BLIGHTLORD.enrage);
    expect(e.onDeathSpawn).toEqual(BLIGHTLORD.onDeathSpawn);
    expect(e.enraged).toBe(false);
    expect(e.hp).toBe(BLIGHTLORD.maxHp);
  });
});

describe('buildEnemyActor — floor-to-floor difficulty escalation (design/05 "to design" item)', () => {
  it('a config with no dungeon at all is unscaled (byte-identical to before this change)', () => {
    const e = buildEnemyActor(state(), pxToFp(400), pxToFp(400), 'basic');
    expect(e.maxHp).toBe(BASIC_ENEMY.maxHp);
    expect(e.hp).toBe(BASIC_ENEMY.maxHp);
  });

  it('floor 0 of a dungeon resolves to curve.base — unscaled, same as no dungeon', () => {
    const e = buildEnemyActor(dungeonState(0), pxToFp(400), pxToFp(400), 'basic');
    expect(e.maxHp).toBe(BASIC_ENEMY.maxHp); // curveAt(base:1, perFloor:1, floor 0) === 1
  });

  it('deeper floors scale maxHp up by the dungeon\'s own difficultyCurve, weapon damage untouched', () => {
    const e2 = buildEnemyActor(dungeonState(2), pxToFp(400), pxToFp(400), 'basic');
    // curveAt({base:1, perFloor:1}, 2) = 1 + 1*2 = 3
    expect(e2.maxHp).toBe(Math.round(BASIC_ENEMY.maxHp * 3));
    expect(e2.hp).toBe(e2.maxHp);
    expect(e2.weapon!.spec.damage).toBe(BASIC_ENEMY.weapon.damage); // unscaled — tougher, not harder-hitting

    const e4 = buildEnemyActor(dungeonState(4), pxToFp(400), pxToFp(400), 'basic');
    expect(e4.maxHp).toBeGreaterThan(e2.maxHp); // strictly increasing with depth
  });

  it('never scales maxHp below 1', () => {
    const zeroCurve: DungeonConfig = { ...CURVE_DUN, difficultyCurve: { base: 0, perFloor: 0 } };
    const s = createGameState({ ...CFG, dungeon: { config: zeroCurve, library: [] } });
    const e = buildEnemyActor(s, pxToFp(400), pxToFp(400), 'basic');
    expect(e.maxHp).toBeGreaterThanOrEqual(1);
  });
});

describe('enrage (WeaponFireSystem, design/09 traits)', () => {
  it('latches ONCE the tick hp first crosses the threshold, boosting damage + fire rate', () => {
    const s = state();
    const e = buildEnemyActor(s, pxToFp(400), pxToFp(400), 'blightlord');
    s.enemies.push(e);
    e.firing = true;
    const fire = new WeaponFireSystem();

    // Above the 30% threshold: fires unenraged (plain ENEMY_GUN_SIM damage). Events
    // are cleared before each tick, matching what GameEngine.step() does for real —
    // calling the system directly here skips that, so it must be done by hand.
    e.hp = Math.ceil(e.maxHp * 0.4);
    e.weapon!.cooldownTicks = 0;
    s.clearEvents();
    fire.tick(s);
    expect(e.enraged).toBe(false);
    expect(s.events.some((ev) => ev.type === 'enrage')).toBe(false);
    const baseDamage = s.projectiles[s.projectiles.length - 1]!.damage;

    // Drop below the threshold: the VERY NEXT fire latches enraged + fires the event,
    // and this shot's damage is measurably higher than the pre-enrage shot.
    e.hp = Math.floor((e.maxHp * BLIGHTLORD.enrage!.hpThresholdPermille) / 1000); // exactly at/under 30%
    e.weapon!.cooldownTicks = 0;
    s.clearEvents();
    fire.tick(s);
    expect(e.enraged).toBe(true);
    expect(s.events.some((ev) => ev.type === 'enrage' && ev.id === e.id)).toBe(true);
    const enragedDamage = s.projectiles[s.projectiles.length - 1]!.damage;
    expect(enragedDamage).toBeGreaterThan(baseDamage);

    // One-way latch: firing again does NOT re-emit the event (enemies never self-heal
    // back above the threshold today, so re-checking every tick would be pure waste).
    e.weapon!.cooldownTicks = 0;
    s.clearEvents();
    fire.tick(s);
    expect(s.events.some((ev) => ev.type === 'enrage')).toBe(false);
  });

  it('a mob with no enrage trait never latches, regardless of hp', () => {
    const s = state();
    const e = buildEnemyActor(s, pxToFp(400), pxToFp(400), 'basic');
    s.enemies.push(e);
    e.firing = true;
    e.hp = 1; // as close to dead as possible
    new WeaponFireSystem().tick(s);
    expect(e.enraged).toBe(false);
    expect(s.events.some((ev) => ev.type === 'enrage')).toBe(false);
  });
});

describe('armor break (WeaponFireSystem, design/09 traits — Task 2, ENGINE_VERSION 70)', () => {
  it("latches ONCE the tick hp first crosses the threshold, REPLACING resist with the broken profile", () => {
    const s = state();
    const e = buildEnemyActor(s, pxToFp(400), pxToFp(400), 'ironwarden');
    s.enemies.push(e);
    const fire = new WeaponFireSystem();
    const armoredResist = IRONWARDEN.resist;
    const brokenResist = IRONWARDEN.armorBreak!.resist;

    // Above the 50% threshold: still armored.
    e.hp = Math.ceil(e.maxHp * 0.6);
    s.clearEvents();
    fire.tick(s);
    expect(e.armorBroken).toBe(false);
    expect(e.resist).toEqual(armoredResist);
    expect(s.events.some((ev) => ev.type === 'armor_break')).toBe(false);

    // Drop to/under the threshold: latches immediately, resist swaps, event fires.
    e.hp = Math.floor((e.maxHp * IRONWARDEN.armorBreak!.hpThresholdPermille) / 1000);
    s.clearEvents();
    fire.tick(s);
    expect(e.armorBroken).toBe(true);
    expect(e.resist).toEqual(brokenResist);
    expect(s.events.some((ev) => ev.type === 'armor_break' && ev.id === e.id)).toBe(true);

    // One-way latch: ticking again does not re-emit, and resist stays the broken map
    // even if hp somehow rose back above the threshold (enemies never self-heal today).
    e.hp = e.maxHp;
    s.clearEvents();
    fire.tick(s);
    expect(e.resist).toEqual(brokenResist);
    expect(s.events.some((ev) => ev.type === 'armor_break')).toBe(false);
  });

  it('a mob with no armorBreak trait never latches or touches resist, regardless of hp', () => {
    const s = state();
    const e = buildEnemyActor(s, pxToFp(400), pxToFp(400), 'ironclad');
    s.enemies.push(e);
    const originalResist = e.resist;
    e.hp = 1;
    new WeaponFireSystem().tick(s);
    expect(e.armorBroken).toBe(false);
    expect(e.resist).toEqual(originalResist);
    expect(s.events.some((ev) => ev.type === 'armor_break')).toBe(false);
  });
});

describe('onDeathSpawn (DeathDropsSystem, design/09 traits)', () => {
  it("a dying blightlord spawns its configured adds, alive, around its death position", () => {
    const s = state();
    const boss = buildEnemyActor(s, pxToFp(400), pxToFp(400), 'blightlord');
    boss.hp = 0; // lethal this tick
    s.enemies.push(boss);
    new DeathDropsSystem().tick(s);

    // The boss itself is compacted out (dead); exactly `count` adds remain, alive.
    expect(s.enemies).toHaveLength(BLIGHTLORD.onDeathSpawn!.count);
    for (const minion of s.enemies) {
      expect(minion.alive).toBe(true);
      expect(minion.hp).toBeGreaterThan(0);
      expect(minion.onDeathSpawn).toBeUndefined(); // no infinite chain — basic adds carry none
      // Spawned near the boss's death position (within its own body radius + a
      // reasonable slack for the walkable clamp), not at the origin or off-map.
      expect(Math.abs(minion.gx - boss.gx)).toBeLessThan(boss.radius * 2);
      expect(Math.abs(minion.gy - boss.gy)).toBeLessThan(boss.radius * 2);
    }
    expect(s.events.some((ev) => ev.type === 'death' && ev.id === boss.id)).toBe(true);
  });

  it('a plain basic mob dying spawns no adds', () => {
    const s = state();
    const e = buildEnemyActor(s, pxToFp(400), pxToFp(400), 'basic');
    e.hp = 0;
    s.enemies.push(e);
    new DeathDropsSystem().tick(s);
    expect(s.enemies).toHaveLength(0);
  });
});
