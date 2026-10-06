/**
 * The chapter-2 and chapter-3 bosses (design/gameplay/04-chapters.md). The three chapter-1
 * bosses are pinned where their mechanics are exercised (`systems/bossai.test.ts`,
 * `systems/dungeonrun.test.ts`); this file pins what makes GLACIMAW and VOLTREAVER different
 * fights and keeps both out of chapter 1's pool.
 */
import { describe, expect, it } from 'vitest';
import { BOSS_POOL, ENEMY_BLUEPRINTS, GALVANIST, GLACIMAW, PYREFANG, VOLTREAVER } from '@dd/engine/content/enemies';
import {
  BLASTER_SIM,
  ENEMY_ARCSEEKER_SIM,
  ENEMY_SHARDFAN_SIM,
  MOB_WEAPON_IDS,
  SEEKER_SIM,
  WEAPON_SIM_BY_ID,
} from '@dd/engine/content/weapons';

describe('GLACIMAW — chapter 2 boss', () => {
  it('is registered, is a boss, and draws the shared boss rig', () => {
    expect(ENEMY_BLUEPRINTS.glacimaw).toBe(GLACIMAW);
    expect(GLACIMAW.boss).toBe(true);
    expect(GLACIMAW.bodyRig).toBe('boss-core');
  });

  it('is NOT in the random pool — chapter 1 keeps drawing from exactly its own three', () => {
    expect(BOSS_POOL).not.toContain('glacimaw');
    expect([...BOSS_POOL]).toEqual(['blightlord', 'pyrefang', 'ironwarden']);
  });

  it('fires an aimed, jittered cone of ice — not a radial ring like Pyrefang', () => {
    expect(GLACIMAW.weapon).toBe(ENEMY_SHARDFAN_SIM);
    expect(ENEMY_SHARDFAN_SIM.kind).toBe('ranged');
    expect(ENEMY_SHARDFAN_SIM.bullets).toBeGreaterThan(1);
    expect(ENEMY_SHARDFAN_SIM.pattern ?? 'spread').toBe('spread');
    expect(ENEMY_SHARDFAN_SIM.spreadHalf).toBeGreaterThan(0);
    expect(ENEMY_SHARDFAN_SIM.damageType).toBe('ice'); // every shard chills
    expect(PYREFANG.weapon.kind === 'ranged' && PYREFANG.weapon.pattern).toBe('radial');
  });

  it('mirrors the frost mob: shrugs ice, melts to fire', () => {
    expect(GLACIMAW.resist?.ice).toBeLessThan(1000);
    expect(GLACIMAW.resist?.fire).toBeGreaterThan(1000);
  });

  it('escalates by firing faster, never by hitting harder', () => {
    expect(GLACIMAW.enrage?.bonusDamagePermille).toBe(0);
    expect(GLACIMAW.enrage?.bonusFireratePermille).toBeGreaterThan(0);
    expect(GLACIMAW.onDeathSpawn).toBeUndefined();
  });

  it('its loadout is a mob weapon — it can never roll as a drop or be crafted', () => {
    expect(MOB_WEAPON_IDS).toContain('enemyshardfan');
    expect(WEAPON_SIM_BY_ID.enemyshardfan).toBeUndefined();
  });
});

describe('VOLTREAVER — chapter 3 boss', () => {
  it('is registered, is a boss, and draws the shared boss rig', () => {
    expect(ENEMY_BLUEPRINTS.voltreaver).toBe(VOLTREAVER);
    expect(VOLTREAVER.boss).toBe(true);
    expect(VOLTREAVER.bodyRig).toBe('boss-core');
  });

  it('is NOT in the random pool', () => {
    expect(BOSS_POOL).not.toContain('voltreaver');
  });

  it('fires homing lightning orbs that a player can out-turn and shoot down', () => {
    const w = ENEMY_ARCSEEKER_SIM;
    expect(VOLTREAVER.weapon).toBe(w);
    expect(w.kind).toBe('ranged');
    expect(w.ballistic).toBe('homing');
    expect(w.bullets).toBeGreaterThan(1);
    expect(w.damageType).toBe('lightning'); // the chain arc onto a nearby teammate
    // Out-turnable: a lazier turn than the player's own seeker, which is meant to lock on.
    expect(w.turnRateBrad!).toBeGreaterThan(0);
    expect(w.turnRateBrad!).toBeLessThan(SEEKER_SIM.turnRateBrad!);
    // Shootable: slower than the starter blaster's bullet, and the fattest enemy bullet there is.
    expect(w.bulletSpeed).toBeLessThan(BLASTER_SIM.bulletSpeed);
    expect(w.bulletRadius).toBeGreaterThan(ENEMY_SHARDFAN_SIM.bulletRadius);
  });

  it('mirrors the lightning mob: shrugs lightning, rots to poison', () => {
    expect(VOLTREAVER.resist).toEqual({ lightning: GALVANIST.resist!.lightning, poison: GALVANIST.resist!.poison });
  });

  it('escalates by firing faster, never by hitting harder', () => {
    expect(VOLTREAVER.enrage?.bonusDamagePermille).toBe(0);
    expect(VOLTREAVER.enrage?.bonusFireratePermille).toBeGreaterThan(0);
    expect(VOLTREAVER.onDeathSpawn).toBeUndefined();
  });

  it('its loadout is a mob weapon — it can never roll as a drop or be crafted', () => {
    expect(MOB_WEAPON_IDS).toContain('enemyarcseeker');
    expect(WEAPON_SIM_BY_ID.enemyarcseeker).toBeUndefined();
  });
});
