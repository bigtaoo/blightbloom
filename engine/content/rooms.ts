/**
 * RoomPiece — the collision-geometry + spawn/exit data format for one hand-authored
 * room (design/07 "deferred to a future 09-content-data.md", design/09 "World data:
 * collision geometry — RoomState", ROADMAP 1.2). Authored in HUMAN grid units, like
 * every other content module (design/09 "author in human units, convert once");
 * `roomGeometry` is that one-time conversion, called when a piece is actually placed
 * into a live GameState — which is 1.3's job (seeded dungeon assembly). This module
 * only defines the shape + the pure converter; no RoomPiece content is authored yet
 * (the "hand-authored RoomPiece library" is explicitly a 1.3 deliverable) and nothing
 * here is wired into GameState construction yet — EngineConfig.walls/obstacles (the
 * demo's current room, `state/GameState.ts`) is the only live geometry source until
 * 1.3 lands.
 *
 * No GameState import (matches content/damage.ts and content/ballistics.ts's shape),
 * so content/state can depend on this without a cycle.
 */
import { toFpGrid } from './convert';
import type { AABB, Obstacle } from '../state/entities';

export type RoomEdge = 'north' | 'south' | 'east' | 'west';

/** A grid-unit point, human-authored. */
export interface Point {
  x: number;
  y: number;
}

/** An enemy spawn point; `type` is an optional ENEMY_BLUEPRINTS id hint (missing/
 * unknown → basic, same forward-compat rule as a wave's `SpawnSpec`, design/09). */
export interface SpawnPoint extends Point {
  type?: string;
}

/** A static rectangular solid, human grid units (design/09 "integer-grid AABBs"). */
export interface AabbGrid {
  x: number;
  y: number;
  w: number;
  h: number;
  /** This solid is a FREE-STANDING block inside a room, not part of a room's perimeter ring.
   *  Purely a collision hint (`config.WALL_NORTH_BRIM`, ENGINE_VERSION 47) — it never changes
   *  the rect itself, so the drawn footprint, `blockedCells`, spawn placement and every
   *  geometry metric see exactly the rect that was authored. See `AABB.freeStanding`. */
  freeStanding?: boolean;
}

/** A static round solid, human grid units (design/07 round pillars). */
export interface PillarGrid {
  center: Point;
  radius: number;
}

/** A connective opening for dungeon assembly (design/09) — which edge, and which
 * RoomPiece pool ("tag") it connects to. `toTag` is 1.3's concern; left optional
 * here since a piece can be authored before its neighbours are decided. */
export interface ExitDef {
  edge: RoomEdge;
  toTag?: string;
}

/**
 * A chest authored into a room (design/05 "Chest rooms"). Position in human grid units,
 * local to the piece, exactly like every other placement here.
 *
 * Note what is NOT here: a big chest's mechanism positions, and what the chest contains.
 * The mechanism COUNT is the run's seat count, which a piece cannot know (see
 * `content/chests.ts`), and the contents come from the floor's own loot economy rather
 * than from the piece — a chest is a delivery site, not a second drop table.
 */
export interface ChestPlacement {
  kind: 'small' | 'big';
  x: number;
  y: number;
}

/** A decorative placement (design/01 Y-sortable prop) — render-only, never read by
 * the sim, like an enemy blueprint's `tint`. */
export interface PropPlacement {
  id: string;
  x: number;
  y: number;
}

/**
 * One room's scripted enemy timeline (design/09 "Encounters", reusing funny's
 * WaveDirector shape). `spawnPoint` indexes into the OWNING piece's
 * `spawns.enemy` array — data-driven, so the script never duplicates a coordinate.
 * Wiring this into a tick-cursor WaveDirector (replacing the flat per-wave
 * SpawnSystem) is 1.3's concern; the shape is locked here so pieces can be
 * authored against it now.
 */
export interface WaveEntry {
  atTick: number;
  enemyType: string;
  spawnPoint: number;
  count: number;
  spacingTicks?: number;
  isBoss?: boolean;
}

export interface WaveScript {
  entries: WaveEntry[];
}

/** Exactly one non-normal room per floor carries the extract/descend portal
 * (design/09); the deepest floor's extraction room IS its boss room (1.4). */
export type RoomRole = 'normal' | 'extraction' | 'boss';

export interface RoomPiece {
  id: string;
  sizeGrid: { w: number; h: number };
  solids: AabbGrid[];
  pillars?: PillarGrid[];
  spawns: { player: Point[]; enemy: SpawnPoint[] };
  exits: ExitDef[];
  props?: PropPlacement[];
  /** Chests authored into this piece (design/05 "Chest rooms"). Absent on every piece
   *  authored before chests existed, which is the whole library up to ENGINE_VERSION 63 —
   *  a piece without this field places no chests and behaves exactly as it always did. */
  chests?: ChestPlacement[];
  encounter?: WaveScript;
  role?: RoomRole;
  // Which biome piece-pools (DungeonConfig.pieceTags, world/dungeon.ts, ROADMAP 1.3)
  // this piece is eligible to be drawn into. Omitted/empty = draws into no pool
  // (a role piece — extraction/boss — is referenced by id directly, not by tag).
  tags?: string[];
}

/**
 * Convert one piece's collision geometry to sim units (Fp), offset by where it is
 * placed in the world (grid units — 1.3 supplies the offset when stitching a
 * floor; a piece authored at its own local origin doesn't need to know its final
 * position). Pure and side-effect-free: does not touch GameState, just produces
 * the arrays `state.walls`/`state.obstacles` are built from.
 *
 * Only reads `solids`/`pillars`, so the param type is the minimal shape rather than
 * the full `RoomPiece` — `content/arenas.ts`'s `ArenaRoom` (ROADMAP 4.2b/c) has its
 * own id/rectGrid/doors/etc. but the same solids/pillars vocabulary, and reuses this
 * converter directly instead of duplicating the AABB/pillar conversion math.
 */
export function roomGeometry(
  piece: Pick<RoomPiece, 'solids' | 'pillars'>,
  offsetXGrid = 0,
  offsetYGrid = 0,
): { walls: AABB[]; obstacles: Obstacle[] } {
  const walls: AABB[] = piece.solids.map((s) => ({
    x: toFpGrid(s.x + offsetXGrid),
    y: toFpGrid(s.y + offsetYGrid),
    w: toFpGrid(s.w),
    h: toFpGrid(s.h),
    // Carried across the one grid -> fp conversion rather than re-derived: whether a solid is
    // free-standing is an AUTHORING fact (which list it came from), not something the rect's
    // own numbers can be asked about afterwards.
    ...(s.freeStanding ? { freeStanding: true as const } : {}),
  }));
  const obstacles: Obstacle[] = (piece.pillars ?? []).map((p) => ({
    gx: toFpGrid(p.center.x + offsetXGrid),
    gy: toFpGrid(p.center.y + offsetYGrid),
    radius: toFpGrid(p.radius),
  }));
  return { walls, obstacles };
}
