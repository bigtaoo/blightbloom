/**
 * ROADMAP B4 (2026-09-26): the two depth curves design/09 sketched on `DungeonConfig` —
 * `weaponRarityByDepth` (the weapon half of `dropTableByDepth`) and `materialTierByDepth` —
 * are real optional fields now, each defaulting to exactly what shipped before it existed.
 *
 * Two halves. The pure helpers are pinned directly. Then each WEAPON-FIND SITE (chest, boss,
 * shop) and the material tier are driven with a config carrying a curve no default could
 * produce, because the failure this item exists to prevent is a site that silently keeps
 * reading the level-1 table: every helper test would stay green through that.
 */
import { describe, it, expect } from 'vitest';
import { toFp } from '@dd/engine/math/fixed';
import type { Brad } from '@dd/engine/math/trig';
import { freshStatus } from '@dd/engine/content/damage';
import { BASIC_ENEMY } from '@dd/engine/content/enemies';
import { createGameState, type GameState } from '@dd/engine/state/GameState';
import { ENEMY_TEAM_ID, type EnemyActor } from '@dd/engine/state/entities';
import { ChestSystem, DeathDropsSystem } from '@dd/engine/systems';
import { WEAPON_SPECS } from '@dd/engine/content/weaponSpecs';
import { Prng } from '@dd/engine/math/prng';
import type { DungeonConfig } from '@dd/engine/world/dungeon';
import { materialTierForFloor, WEAPON_DROP_POOL } from './drops';
import { rollShopStock } from './shops';
import {
  DEFAULT_WEAPON_RARITY_BY_DEPTH,
  WEAPON_POOL_BY_RARITY,
  rarityTableProblems,
  rollWeaponId,
  type RarityWeightRow,
} from './weaponRarityByDepth';

const ALL_LEGENDARY: readonly RarityWeightRow[] = [[0, 0, 0, 0, 100]];
const ALL_COMMON: readonly RarityWeightRow[] = [[100, 0, 0, 0, 0]];

describe('materialTierForFloor', () => {
  it('is the tier = floorIndex identity without a curve — the shipped behaviour', () => {
    for (const f of [0, 1, 4, 9]) {
      expect(materialTierForFloor(undefined, f)).toBe(f);
      expect(materialTierForFloor([], f)).toBe(f);
    }
  });

  it('reads the curve, and plateaus at its last entry past the end', () => {
    const curve = [0, 0, 1, 3];
    expect([0, 1, 2, 3, 4, 7].map((f) => materialTierForFloor(curve, f))).toEqual([0, 0, 1, 3, 3, 3]);
  });
});

describe('rollWeaponId with a table', () => {
  it('defaults to the level-1 table — explicit and implicit agree draw for draw', () => {
    for (let seed = 1; seed <= 50; seed++) {
      for (const floor of [0, 2, 4]) {
        expect(rollWeaponId(new Prng(seed), floor)).toBe(rollWeaponId(new Prng(seed), floor, DEFAULT_WEAPON_RARITY_BY_DEPTH));
      }
    }
  });

  it('honours a table no default could produce, on every floor past its end too', () => {
    const legendary = WEAPON_POOL_BY_RARITY.legendary;
    expect(legendary.length).toBeGreaterThan(0);
    for (let seed = 1; seed <= 40; seed++) {
      for (const floor of [0, 3, 12]) expect(legendary).toContain(rollWeaponId(new Prng(seed), floor, ALL_LEGENDARY));
    }
  });

  it('still costs exactly one draw', () => {
    const a = new Prng(7);
    const b = new Prng(7);
    rollWeaponId(a, 2, ALL_COMMON);
    b.nextInt(1000);
    expect(a.nextInt(1_000_000)).toBe(b.nextInt(1_000_000));
  });
});

describe('rarityTableProblems', () => {
  it('passes the shipped table', () => {
    expect(rarityTableProblems(DEFAULT_WEAPON_RARITY_BY_DEPTH)).toEqual([]);
  });

  it('names each way a table can be unusable', () => {
    expect(rarityTableProblems([])).toEqual(['no rows']);
    expect(rarityTableProblems([[50, 50, 0, 0, 1]])).toEqual(['floor 0: weights sum to 101, not 100']);
    expect(rarityTableProblems([[50.5, 49.5, 0, 0, 0]])).toEqual(['floor 0: weights must be non-negative integers']);
    expect(rarityTableProblems([[110, -10, 0, 0, 0]])).toEqual(['floor 0: weights must be non-negative integers']);
    expect(rarityTableProblems([[0, 0, 0, 0, 0]])).toEqual(['floor 0: weights sum to 0, not 100', 'floor 0: every weighted tier is empty']);
  });
});

// ── Each site reads the config ────────────────────────────────────────────────

function withConfig(seed: number, dungeon: Partial<DungeonConfig>): GameState {
  const s = createGameState({ seed, worldW: 1600, worldH: 1600, waves: [] });
  (s as { dungeonConfig?: Partial<DungeonConfig> }).dungeonConfig = dungeon;
  return s;
}

function corpse(s: GameState, boss: boolean): EnemyActor {
  const p = s.players[0]!;
  const e = {
    id: s.nextId(), faction: 'enemy', teamId: ENEMY_TEAM_ID,
    gx: p.gx, gy: p.gy, z: toFp(0), vx: toFp(0), vy: toFp(0), knockVx: toFp(0), knockVy: toFp(0),
    facing: 0 as Brad, hp: 0, maxHp: BASIC_ENEMY.maxHp, shield: 0, maxShield: 0, ticksSinceHit: 0,
    radius: BASIC_ENEMY.radius, footprintRadius: BASIC_ENEMY.footprintRadius, solidRadius: BASIC_ENEMY.radius,
    alive: true, weapon: null, firing: false, status: freshStatus(),
    enraged: false, armorBroken: false, aggroed: false, holding: false,
    ...(boss ? { boss: true } : {}),
  } as EnemyActor;
  s.enemies.push(e);
  return e;
}

const rarityOf = (id: string | undefined) => WEAPON_SPECS[id!]!.rarity;

describe("each weapon find reads the dungeon's own curve", () => {
  it('the boss drop', () => {
    const s = withConfig(5, { weaponRarityByDepth: ALL_LEGENDARY });
    corpse(s, true);
    new DeathDropsSystem().tick(s);
    const weapons = s.pickups.filter((i) => i.kind === 'weapon');
    expect(weapons.length).toBeGreaterThan(0);
    for (const w of weapons) expect(rarityOf(w.weaponId)).toBe('legendary');
  });

  it('the chest payout', () => {
    const s = withConfig(5, { weaponRarityByDepth: ALL_LEGENDARY });
    const p = s.players[0]!;
    s.chests.push({ id: s.nextId(), roomId: 'no_such_room', kind: 'small', gx: p.gx, gy: p.gy, mechanisms: [], opened: false });
    new ChestSystem().tick(s);
    const weapons = s.pickups.filter((i) => i.kind === 'weapon');
    expect(weapons.length).toBeGreaterThan(0);
    for (const w of weapons) expect(rarityOf(w.weaponId)).toBe('legendary');
  });

  it('the shop weapon slot', () => {
    let n = 1;
    const prng = { nextInt: () => 0, weightedIndex: (w: readonly number[]) => w.findIndex((x) => x > 0) };
    const stock = rollShopStock(prng, () => n++, 0, ALL_LEGENDARY);
    for (const o of stock) expect(rarityOf(o.weaponId)).toBe('legendary');
    // And the default, as the control: the same scripted draw lands on the pool's first weapon.
    const control = rollShopStock(prng, () => n++, 0);
    expect(control[0]!.weaponId).toBe(WEAPON_DROP_POOL[0]);
  });

  it("a kill's material rolls at the dungeon's curve, not the floor index", () => {
    let found = 0;
    for (let seed = 1; seed <= 400 && found < 3; seed++) {
      const s = withConfig(seed, { materialTierByDepth: [6] });
      corpse(s, false);
      new DeathDropsSystem().tick(s);
      for (const m of s.pickups.filter((i) => i.kind === 'material')) {
        expect(m.tier).toBe(6);
        found++;
      }
    }
    expect(found).toBeGreaterThan(0); // the loop really saw a material drop
  });
});
