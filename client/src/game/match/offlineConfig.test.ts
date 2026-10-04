/** buildDungeonRunConfig / buildArenaDemoConfig: the offline PvE/dev-arena EngineConfig
 *  builders (see offlineConfig.ts's doc comments for the beginRun/arenaDemo contexts).
 *  Mirrors pvpConfig.test.ts's plain input->output style. */
import { describe, it, expect } from 'vitest';
import { fpToPx } from '../coords';
import { toFpGrid } from '@dd/engine/content/convert';
import { ARENA_CATALOG } from './arenaCatalog';
import { buildDungeonRunConfig, buildArenaDemoConfig } from './offlineConfig';
import { parseGameQueryParams } from './gameQueryParams';
import { createGameEngine } from '@dd/engine';
import type { EngineConfig } from '@dd/engine';
import { PLAYER_BASE } from '@dd/engine/content/players';

describe('buildDungeonRunConfig', () => {
  const localSeat = { skinId: 'vanguard', loadout: ['auto_pistol'] };

  it('solo (coop: false) uses the top-level skinId/loadout, no players list', () => {
    const cfg = buildDungeonRunConfig({ seed: 1, coop: false, localSeat, allySkinId: 'juggernaut' });
    expect(cfg.players).toBeUndefined();
    expect(cfg.skinId).toBe('vanguard');
    expect(cfg.loadout).toEqual(['auto_pistol']);
  });

  it('coop (coop: true) builds a two-seat players list: local seat then the bot ally', () => {
    const cfg = buildDungeonRunConfig({ seed: 1, coop: true, localSeat, allySkinId: 'juggernaut' });
    expect(cfg.skinId).toBeUndefined();
    expect(cfg.loadout).toBeUndefined();
    // The ally is flagged a bot (ENGINE_VERSION 88), so the run ends once the player is dead.
    expect(cfg.players).toEqual([localSeat, { skinId: 'juggernaut', bot: true }]);
  });

  it('carries seed through untouched and sets dungeon geometry, no arena', () => {
    const cfg = buildDungeonRunConfig({ seed: 123, coop: false, localSeat, allySkinId: 'juggernaut' });
    expect(cfg.seed).toBe(123);
    expect(cfg.dungeon).toBeDefined();
    expect(cfg.arena).toBeUndefined();
    expect(cfg.waves).toEqual([]);
  });

  it('is a pure function of its opts — identical config on every call', () => {
    const opts = { seed: 5, coop: true, localSeat, allySkinId: 'skirmisher' };
    expect(buildDungeonRunConfig(opts)).toEqual(buildDungeonRunConfig(opts));
  });
});

describe('buildArenaDemoConfig', () => {
  it('places two local seats on distinct teams (0 and 1) using landing_basic', () => {
    const cfg = buildArenaDemoConfig({ seed: 1, localSkinId: 'vanguard', allySkinId: 'juggernaut' });
    expect(cfg.arena).toBe(ARENA_CATALOG.landing_basic);
    expect(cfg.players).toHaveLength(2);
    expect(cfg.players![0]!.teamId).toBe(0);
    expect(cfg.players![1]!.teamId).toBe(1);
    expect(cfg.players![0]!.skinId).toBe('vanguard');
    expect(cfg.players![1]!.skinId).toBe('juggernaut');
  });

  it('converts room-centre grid coordinates to px start positions via fpToPx(toFpGrid(n))', () => {
    const cfg = buildArenaDemoConfig({ seed: 1, localSkinId: 'vanguard', allySkinId: 'juggernaut' });
    const px = (grid: number) => fpToPx(toFpGrid(grid));
    expect(cfg.players![0]!.start).toEqual([px(5), px(5)]);
    expect(cfg.players![1]!.start).toEqual([px(5), px(35)]);
  });

  it('has no dungeon geometry set (arena mode only)', () => {
    const cfg = buildArenaDemoConfig({ seed: 1, localSkinId: 'vanguard', allySkinId: 'juggernaut' });
    expect(cfg.dungeon).toBeUndefined();
  });

  describe('?arena=<id> — any catalog map, not just the synthetic fixture', () => {
    const opts = { seed: 1, localSkinId: 'vanguard', allySkinId: 'juggernaut' } as const;

    it('an explicit landing_basic is byte-identical to the default (no arenaId)', () => {
      expect(buildArenaDemoConfig({ ...opts, arenaId: 'landing_basic' })).toEqual(
        buildArenaDemoConfig(opts),
      );
    });

    it('builds the REAL 60-room launch map, seats standing on its own authored spawns', () => {
      const arena = ARENA_CATALOG.arena_launch;
      const cfg = buildArenaDemoConfig({ ...opts, arenaId: 'arena_launch' });
      const px = (grid: number) => fpToPx(toFpGrid(grid));
      expect(cfg.arena).toBe(arena);
      // Read out of the map rather than written as literals: the point of this path is
      // that the harness stands where a REAL match would, so the assertion has to move
      // if the map's spawns do. (Both are non-empty — pinned below, since two undefined
      // spawns would make this comparison vacuously true.)
      expect(arena.spawns.length).toBeGreaterThanOrEqual(2);
      expect(cfg.players![0]!.start).toEqual([px(arena.spawns[0]!.x), px(arena.spawns[0]!.y)]);
      expect(cfg.players![1]!.start).toEqual([px(arena.spawns[1]!.x), px(arena.spawns[1]!.y)]);
      expect(cfg.players![0]!.start).not.toEqual(cfg.players![1]!.start);
    });

    it('still puts the two seats on distinct teams, same as the fixture path', () => {
      const cfg = buildArenaDemoConfig({ ...opts, arenaId: 'arena_launch' });
      expect(cfg.players!.map((p) => p.teamId)).toEqual([0, 1]);
    });
  });

  it('is a pure function of its opts, seed passthrough included — identical config on every call', () => {
    const opts = { seed: 9, localSkinId: 'vanguard', allySkinId: 'juggernaut' };
    const a = buildArenaDemoConfig(opts);
    const b = buildArenaDemoConfig(opts);
    expect(a).toEqual(b);
    expect(a.seed).toBe(9);
  });
});

/**
 * The config builders above are asserted as pure input→output. This block closes the loop
 * the other way: the config a real `beginRun` hands the ENGINE must spawn a player who can
 * actually use the swap control (one gun + one melee weapon, ENGINE_VERSION 45). The
 * builders themselves can't tell — `loadout` is an opaque string array to them — so the
 * assertion has to run the real engine, and it starts from `parseGameQueryParams` because
 * `?wpn=<id>` is the one input that stages a ONE-weapon loadout on purpose (Game.ts merges
 * `loadoutOverride` into `meta.loadout` before calling the builder).
 */
describe('the run config actually reaches the engine armed for the swap control', () => {
  const spawnedWeapons = (cfg: EngineConfig, owner = 0) =>
    createGameEngine(cfg).state.players[owner]!.weapons.map((w) => ({ name: w.spec.name, kind: w.spec.kind }));

  const runFor = (search: string, coop = false) => {
    const q = parseGameQueryParams(search);
    // Exactly Game.ts's merge: an override replaces the staged meta loadout, absent leaves it.
    const loadout = q.loadoutOverride ?? [];
    return buildDungeonRunConfig({ seed: 1, coop, localSeat: { skinId: 'vanguard', loadout }, allySkinId: 'juggernaut' });
  };

  it.each([
    ['no dev override — the empty staged loadout every ordinary run carries', ''],
    ['?wpn=<a gun> — the melee slot still fills', '?wpn=repeater'],
    ['?wpn=<a blade> — the gun slot still fills', '?wpn=emberblade'],
    ['?wpn=<not a weapon> — dropped, then filled', '?wpn=definitely_not_a_weapon'],
  ])('solo: %s', (_label, search) => {
    const weapons = spawnedWeapons(runFor(search));
    expect(weapons).toHaveLength(PLAYER_BASE.weaponSlots);
    expect(new Set(weapons.map((w) => w.kind))).toEqual(new Set(['ranged', 'melee']));
  });

  it('?wpn= puts the requested weapon in the ACTIVE slot, so a dev toggle still tests that weapon', () => {
    expect(spawnedWeapons(runFor('?wpn=emberblade'))[0]).toEqual({ name: 'emberblade', kind: 'melee' });
  });

  it('coop: the local seat AND the bot ally both spawn able to swap', () => {
    const cfg = runFor('?wpn=repeater', true);
    for (const owner of [0, 1]) {
      const weapons = spawnedWeapons(cfg, owner);
      expect(weapons).toHaveLength(PLAYER_BASE.weaponSlots);
      expect(new Set(weapons.map((w) => w.kind))).toEqual(new Set(['ranged', 'melee']));
    }
  });
});
