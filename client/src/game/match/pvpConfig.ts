/**
 * Shared PvP arena EngineConfig builder (design/15, ROADMAP Phase 4 closeout). Pulled out
 * of `Game.buildOnlineConfig` so there is exactly ONE place that turns `(seed,
 * playerCount)` into the arena run config — the same anti-drift lesson design/06 already
 * states for the wire protocol ("two hand-mirrored copies inevitably drift") applies here
 * too, now that a headless bot client (server/src/BotClient.ts) needs to build the
 * byte-identical config independently, without importing the Pixi-heavy Game.ts.
 *
 * MUST stay a pure function of `seed`/`playerCount` (determinism, design/06): seats are
 * skinned by index, real or bot, no chosen character or crafted loadout enters here.
 *
 * `teamId` (design/05/15's PvP squad follow-up) is likewise derived purely from
 * `(owner, playerCount)` via `teamIdForOwner` below — NOT threaded in from a match
 * ticket — precisely because this function has no ticket to read: `BotClient.ts` calls
 * it with only `(seed, playerCount)`, same as a real client. `server/src/Matchmaker.ts`
 * assigns real (and bot) SEATS using this exact same formula (imported from here via
 * the `@dd/game/pvpConfig` alias it already uses for this file), so a seat's squad is
 * never in question regardless of who ends up sitting in it.
 */
import { Prng, SKIN_DEFS, type EngineConfig } from '@dd/engine';
import { toFpGrid } from '@dd/engine/content/convert';
import type { ArenaMap } from '@dd/engine/content/arenas';
import { ARENA_CATALOG } from './arenaCatalog';
import { fpToPx } from '../coords';

// Ignored once `arena` is set (each arena's own geometry defines the bounds) — mirrors
// the PLACEHOLDER_WORLD literal Game.ts uses for its own (non-PvP) online/offline configs.
const PLACEHOLDER_WORLD = 800;

/** PvP squad size (design/05/15, the long-deferred "squads" reserved interface). Also
 * the cap `server/src/PartyService.ts` enforces on party membership. */
export const SQUAD_SIZE = 4;

/** The effective squad size for a given match's total seat count — `SQUAD_SIZE` when
 * it divides evenly into AT LEAST 2 squads, else `1` (today's exact free-for-all)
 * rather than guessing an uneven split. The "at least 2" guard matters: a bare
 * divisibility check would make a `playerCount === SQUAD_SIZE` match (e.g. a 4-seat
 * match with SQUAD_SIZE=4) resolve to ONE squad covering every seat — everyone on the
 * same team, unable to ever damage each other, never reaching a winner. Keeps any
 * non-standard `?seats=` dev value safe instead of crashing OR silently deadlocking. */
export function squadSizeForPlayerCount(playerCount: number): number {
  return SQUAD_SIZE > 1 && playerCount % SQUAD_SIZE === 0 && playerCount / SQUAD_SIZE >= 2 ? SQUAD_SIZE : 1;
}

/** Which squad a seat (`owner`, 0-indexed) belongs to for a match of this size —
 * contiguous chunks of `squadSizeForPlayerCount(playerCount)`. */
export function teamIdForOwner(owner: number, playerCount: number): number {
  return Math.floor(owner / squadSizeForPlayerCount(playerCount));
}

/** Seeds the spawn-assignment stream. Distinct from every engine stream (`GameState`'s
 *  `SEED_*`), and read here only, before the engine exists. */
export const SEED_SPAWN = 0x5b4a5e11;

/**
 * Which authored spawn each seat drops at, as a `start` in px (design/15: `spawns` is
 * ">= seat count; system-assigned per match, no player choice"). A seeded shuffle, so a
 * seat index is not tied to a corner of the map. Until 2026-09-29 nothing did this: every
 * seat started at the `worldW/2, worldH/2` default of `GameState.buildSeat`, which is one
 * point inside spawn 0's room, so every real match began with the whole lobby stacked there
 * and every gun firing past bodies closer than its `muzzleOffset`.
 */
export function assignArenaStarts(arena: ArenaMap, seed: number, playerCount: number): [number, number][] {
  if (arena.spawns.length < playerCount) {
    throw new Error(`arena has ${arena.spawns.length} spawns for ${playerCount} seats`);
  }
  const order = arena.spawns.map((_, i) => i);
  new Prng(seed ^ SEED_SPAWN).shuffle(order);
  const px = (grid: number) => fpToPx(toFpGrid(grid));
  return order.slice(0, playerCount).map((i) => [px(arena.spawns[i]!.x), px(arena.spawns[i]!.y)]);
}

export function buildPvpEngineConfig(seed: number, playerCount: number): EngineConfig {
  const ids = Object.keys(SKIN_DEFS);
  const arena = ARENA_CATALOG.arena_launch;
  const starts = assignArenaStarts(arena, seed, playerCount);
  return {
    seed,
    worldW: PLACEHOLDER_WORLD,
    worldH: PLACEHOLDER_WORLD,
    waves: [],
    players: Array.from({ length: playerCount }, (_, i) => ({
      skinId: ids[i % ids.length]!,
      teamId: teamIdForOwner(i, playerCount),
      start: starts[i]!,
    })),
    arena,
  };
}
