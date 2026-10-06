import { CHAPTERS, DEFAULT_CHAPTER_ID, type ChapterId, type EngineConfig } from '@dd/engine';
import { toFpGrid } from '@dd/engine/content/convert';
import type { ArenaMap } from '@dd/engine/content/arenas';
import type { Point } from '@dd/engine/content/rooms';
import { ARENA_CATALOG, type ArenaId } from './arenaCatalog';
import { fpToPx } from '../coords';

// Ignored in dungeon/arena mode (each room/arena sets its own bounds) — mirrors the
// PLACEHOLDER_WORLD literal Game.ts uses for its own online configs.
const PLACEHOLDER_WORLD = 800;

/**
 * The offline PvE dungeon run config (beginRun). Local co-op (ROADMAP 3.1) opts in a
 * second seat — the bot ally, a distinct free character — via EngineConfig.players;
 * single-player passes the top-level skin/loadout and is byte-identical (an absent
 * `players` list → the same one-seat construction). Pulled out of Game.ts 2026-07-28.
 *
 * `chapterId` picks the dungeon (engine `world/chapters.ts`). `dungeon` is a fresh wrapper
 * around the catalog's own config and library objects — for 'ember' exactly the
 * `EMBER_DUNGEON` / `EMBER_L1_ROOMS` pair this always passed — so a chapter-1 run, its save's
 * content hash and its replay are byte-identical to before chapters existed. The caller
 * decides WHICH chapter (and whether it is unlocked); this only builds it. Optional only so
 * the balance sims under `client/sim/` keep measuring chapter 1 unchanged; every game-side
 * caller passes it.
 */
export function buildDungeonRunConfig(opts: {
  seed: number;
  chapterId?: ChapterId;
  coop: boolean;
  localSeat: { skinId: string; loadout: string[] };
  allySkinId: string;
}): EngineConfig {
  return {
    seed: opts.seed,
    worldW: PLACEHOLDER_WORLD,
    worldH: PLACEHOLDER_WORLD,
    waves: [],
    ...(opts.coop
      ? { players: [opts.localSeat, { skinId: opts.allySkinId, bot: true }] }
      : { skinId: opts.localSeat.skinId, loadout: opts.localSeat.loadout }),
    dungeon: chapterDungeon(opts.chapterId ?? DEFAULT_CHAPTER_ID),
  };
}

/** `EngineConfig.dungeon` for a chapter: a new wrapper object, the catalog's own content. */
function chapterDungeon(id: ChapterId): NonNullable<EngineConfig['dungeon']> {
  const { config, library } = CHAPTERS[id];
  return { config, library };
}

/**
 * Dev-only (`?arenaDemo=1` / `?arena=<id>`, see Game.arenaDemo's field doc comment): any
 * catalog ArenaMap + two local seats on distinct teams, with zero matchmaking round-trip.
 * Defaults to the small synthetic `landing_basic` fixture, which is what `?arenaDemo=1`
 * has always booted; `?arena=arena_launch` is how the real launch map gets walked in a
 * single tab; `landing_basic` stays reachable the same way, as the small synthetic fixture.
 */
export function buildArenaDemoConfig(opts: {
  seed: number;
  localSkinId: string;
  allySkinId: string;
  arenaId?: ArenaId;
}): EngineConfig {
  const arena = ARENA_CATALOG[opts.arenaId ?? 'landing_basic'];
  const px = (grid: number) => fpToPx(toFpGrid(grid));
  const [a, b] = arenaDemoStarts(arena);
  return {
    seed: opts.seed,
    worldW: PLACEHOLDER_WORLD,
    worldH: PLACEHOLDER_WORLD,
    waves: [],
    players: [
      { skinId: opts.localSkinId, teamId: 0, start: [px(a.x), px(a.y)] },
      { skinId: opts.allySkinId, teamId: 1, start: [px(b.x), px(b.y)] },
    ],
    arena,
  };
}

/**
 * Where the harness' two seats stand, in GRID units. A real map authors `spawns`
 * (design/15: >= seat count, system-assigned) and the first two are used verbatim, so the
 * demo starts where a real match would. `landing_basic` has none — it predates that field
 * — so it keeps its original hand-picked room A / room C centres, which is why this is a
 * fallback rather than a derivation from `rooms[0]`/`rooms[1]`: those would be rooms A and
 * B, putting both seats one door apart instead of at opposite ends of the L.
 */
function arenaDemoStarts(arena: ArenaMap): [Point, Point] {
  const [a, b] = arena.spawns;
  if (a && b) return [a, b];
  return [{ x: 5, y: 5 }, { x: 5, y: 35 }];
}
