/**
 * The chapter-2 boss (design/gameplay/04-chapters.md). The three chapter-1 bosses are pinned
 * where their mechanics are exercised (`systems/bossai.test.ts`, `systems/dungeonrun.test.ts`);
 * this file pins what makes GLACIMAW a different fight and keeps it out of chapter 1's pool.
 */
import { describe, expect, it } from 'vitest';
import { BOSS_POOL, ENEMY_BLUEPRINTS, GLACIMAW, PYREFANG } from '@dd/engine/content/enemies';
import { ENEMY_SHARDFAN_SIM, MOB_WEAPON_IDS, WEAPON_SIM_BY_ID } from '@dd/engine/content/weapons';

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
