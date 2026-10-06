/**
 * Where one floor of a run comes from, split out of dungeon.ts (CLAUDE.md "500-line file
 * convention", form ① — independent pure functions). Every per-floor question a system used to
 * answer from `state.dungeonConfig` + `state.floorIndex` directly — which authored map, which
 * biome, whether the floor ends the run — goes through here, because the endless dungeon
 * (design/gameplay/04-chapters.md "The Endless Descent") answers them per segment rather than
 * from its own top-level config.
 *
 * For every finite dungeon the answers are the config's own, at the run's own floor index,
 * exactly as each call site read them before this module existed — so no shipped chapter's run
 * moves (the golden gate pins that).
 */
import type { DungeonConfig } from './types';

/** The config a floor reads its content from, and the floor index inside that config. */
export interface FloorSource {
  readonly config: DungeonConfig;
  readonly floor: number;
}

/** Whether `config` is an endless dungeon — one that cycles through `endless.segments`. */
export function isEndlessDungeon(config: DungeonConfig): boolean {
  return (config.endless?.segments.length ?? 0) > 0;
}

/** The floors in one full cycle of an endless dungeon's segments; a finite dungeon's own count. */
export function lapFloorCount(config: DungeonConfig): number {
  if (!isEndlessDungeon(config)) return config.floorCount;
  return config.endless!.segments.reduce((n, seg) => n + seg.floorCount, 0);
}

/**
 * Floor `floorIndex` of a run in `config`. A finite dungeon is its own source. An endless one
 * walks its segments in order, each for its own `floorCount` floors, and starts over after the
 * last: with the four chapters as segments, floors 0-4 are chapter 1's, 5-9 chapter 2's, and
 * floor 20 is chapter 1's floor 0 again.
 */
export function floorSourceAt(config: DungeonConfig, floorIndex: number): FloorSource {
  if (!isEndlessDungeon(config)) return { config, floor: floorIndex };
  const segments = config.endless!.segments;
  // `rest` starts below the lap, which is the segments' sum, so the walk ends inside it.
  let rest = floorIndex % lapFloorCount(config);
  let i = 0;
  while (rest >= segments[i]!.floorCount) rest -= segments[i++]!.floorCount;
  return { config: segments[i]!, floor: rest };
}

/** The biome floor `floorIndex` is drawn in: the segment's own for an endless dungeon. */
export function biomeIdAt(config: DungeonConfig, floorIndex: number): string {
  return floorSourceAt(config, floorIndex).config.biomeId;
}

/** Whether floor `floorIndex`'s capstone is its source's boss room rather than an extraction. */
export function isBossFloor(config: DungeonConfig, floorIndex: number): boolean {
  const src = floorSourceAt(config, floorIndex);
  return src.floor >= src.config.floorCount - 1;
}

/**
 * Whether the floor's portal offers EXTRACT (end the run, keep the bag). A finite dungeon's
 * last floor, and nothing else (design/gameplay/01 "Only the boss floor ends a run"); an endless
 * dungeon's every boss floor, since it has no last floor.
 */
export function floorOffersExtract(config: DungeonConfig, floorIndex: number): boolean {
  return isBossFloor(config, floorIndex);
}

/** Whether the floor's portal offers DESCEND. Every floor but a finite dungeon's last. */
export function floorOffersDescend(config: DungeonConfig, floorIndex: number): boolean {
  return isEndlessDungeon(config) || floorIndex < config.floorCount - 1;
}
