/** buildOnlineConfig: derives the EngineConfig from a server-issued MatchStart. Mirrors
 *  pvpConfig.test.ts's plain input->output style. See matchConfig.ts's doc comment for
 *  why `m.mode === 'pvp'` branches to the arena shape (buildPvpEngineConfig) instead. */
import { describe, it, expect } from 'vitest';
import { SKIN_DEFS, EMBER_DUNGEON, EMBER_L1_ROOMS, FROST_DUNGEON, FROST_L1_ROOMS, type MatchStart } from '@dd/engine';
import { buildOnlineConfig } from './matchConfig';
import { buildPvpEngineConfig } from './pvpConfig';

function matchStart(overrides: Partial<MatchStart> = {}): MatchStart {
  return { seed: 1, startFrame: 0, localOwner: 0, playerCount: 2, ...overrides };
}

describe('buildOnlineConfig', () => {
  it('delegates to buildPvpEngineConfig(seed, playerCount) when mode is "pvp"', () => {
    const m = matchStart({ mode: 'pvp', seed: 42, playerCount: 8 });
    expect(buildOnlineConfig(m)).toEqual(buildPvpEngineConfig(42, 8));
  });

  it('builds a PvE dungeon config for the "coop" mode', () => {
    const m = matchStart({ mode: 'coop', seed: 7, playerCount: 3 });
    const cfg = buildOnlineConfig(m);
    expect(cfg.dungeon).toBeDefined();
    expect(cfg.arena).toBeUndefined();
    expect(cfg.seed).toBe(7);
    expect(cfg.players).toHaveLength(3);
  });

  it('builds a PvE dungeon config when mode is absent (undefined)', () => {
    const m = matchStart({ mode: undefined, seed: 9, playerCount: 1 });
    const cfg = buildOnlineConfig(m);
    expect(cfg.dungeon).toBeDefined();
    expect(cfg.arena).toBeUndefined();
  });

  it('skins each seat by index into SKIN_DEFS, cycling if playerCount exceeds the skin count', () => {
    const ids = Object.keys(SKIN_DEFS);
    const m = matchStart({ playerCount: ids.length + 1 });
    const cfg = buildOnlineConfig(m);
    const skinIds = cfg.players!.map((p) => p.skinId);
    expect(skinIds).toEqual(Array.from({ length: ids.length + 1 }, (_, i) => ids[i % ids.length]));
  });

  it('is a pure function of the MatchStart fields it reads — identical config on every call', () => {
    const m = matchStart({ mode: 'coop', seed: 5, playerCount: 4 });
    expect(buildOnlineConfig(m)).toEqual(buildOnlineConfig(m));
  });

  it('non-pvp seats carry only skinId — no teamId, matching the PvE (non-arena) seat shape', () => {
    const m = matchStart({ mode: 'coop', playerCount: 2 });
    const cfg = buildOnlineConfig(m);
    for (const p of cfg.players!) expect('teamId' in p).toBe(false);
  });

  it('flags the seats match_start names as bots, and only those (ENGINE_VERSION 88)', () => {
    const cfg = buildOnlineConfig(matchStart({ mode: 'coop', playerCount: 3, botSeats: [2] }));
    expect(cfg.players!.map((p) => p.bot === true)).toEqual([false, false, true]);
    // A room of people builds the seat shape it always did: no `bot` key at all.
    for (const p of buildOnlineConfig(matchStart({ mode: 'coop', playerCount: 3 })).players!) expect('bot' in p).toBe(false);
    for (const p of cfg.players!.slice(0, 2)) expect('bot' in p).toBe(false);
  });

  it('ignores botSeats in an arena: the PvP config is the same with or without it', () => {
    const m = matchStart({ mode: 'pvp', seed: 3, playerCount: 4 });
    expect(buildOnlineConfig({ ...m, botSeats: [1, 2, 3] })).toEqual(buildOnlineConfig(m));
  });

  // Chapters (world/chapters.ts). Identity (`toBe`), not equality: every client in a room must
  // build the SAME catalog objects, and a chapter-1 room must build exactly what it built
  // before chapters existed — a structurally-equal copy would pass `toEqual` and still be a
  // second definition that could drift.
  it('builds chapter 1 — the very same catalog objects — when match_start names no chapter', () => {
    const cfg = buildOnlineConfig(matchStart({ mode: 'coop' }));
    expect(cfg.dungeon!.config).toBe(EMBER_DUNGEON);
    expect(cfg.dungeon!.library).toBe(EMBER_L1_ROOMS);
    // And naming chapter 1 explicitly is the same room.
    expect(buildOnlineConfig(matchStart({ mode: 'coop', chapterId: 'ember' }))).toEqual(cfg);
  });

  it('builds the chapter match_start names', () => {
    const cfg = buildOnlineConfig(matchStart({ mode: 'coop', chapterId: 'frost' }));
    expect(cfg.dungeon!.config).toBe(FROST_DUNGEON);
    expect(cfg.dungeon!.library).toBe(FROST_L1_ROOMS);
  });

  it('falls back to chapter 1 for a chapter id this build does not know', () => {
    const cfg = buildOnlineConfig(matchStart({ mode: 'coop', chapterId: 'abyss' as never }));
    expect(cfg.dungeon!.config).toBe(EMBER_DUNGEON);
  });

  it('ignores chapterId in an arena: the PvP config is the same with or without it', () => {
    const m = matchStart({ mode: 'pvp', seed: 3, playerCount: 4 });
    expect(buildOnlineConfig({ ...m, chapterId: 'frost' })).toEqual(buildOnlineConfig(m));
  });
});
