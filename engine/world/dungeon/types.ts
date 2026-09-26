/**
 * Pure type/interface declarations for the dungeon-assembly module, split out of
 * dungeon.ts (CLAUDE.md "500-line file convention", form ① — independent module:
 * zero logic, shared vocabulary every sibling file under ./dungeon/ builds on).
 * Re-exported wholesale from ../dungeon.ts so every existing
 * `import { DungeonConfig, PlacedRoom, ... } from '.../world/dungeon'` site is
 * untouched.
 */
import type { RoomPiece } from '../../content/rooms';
import type { RarityWeightRow } from '../../content/weaponRarityByDepth';
import type { Door, RoomId } from '../../content/arenas';

/** A tag against `RoomPiece.tags` — which pool a biome draws its normal rooms from. */
export type RoomTag = string;

/** First-pass linear difficulty scaling by floor depth (design/05 "to-tune"):
 * `base + perFloor * floorIndex`, floorIndex 0-based. Final tuning is design/05's
 * open work; the shape (a simple linear ramp) is what ships now. */
export interface CurveSpec {
  base: number;
  perFloor: number;
}

export interface DungeonConfig {
  biomeId: string;
  nameKey: string;
  floorCount: number;
  roomsPerFloor: { min: number; max: number };
  pieceTags: readonly RoomTag[];
  layout: 'linear' | 'branching' | 'graph2d'; // see module doc — 'graph2d' places in real 2D
  branchFactor?: number; // 'branching' only: candidate rooms per normal stage (default 2,
  // clamped to the pool size); ignored for 'linear' (always 1)
  extractionPieceId: string; // this floor's checkpoint room (every floor but the last)
  bossPieceId: string; // the deepest floor's room — doubles as ITS extraction
  difficultyCurve: CurveSpec;
  /** Optional per-floor-index hand-authored override (design/05 "Hand-authored PvE
   * floors", 2026-08-05): when `floorIndex` has an entry, `SpawnSystem` calls
   * `placeAuthoredFloor` instead of `generateFloor`/`placeFloor` for that floor —
   * zero `roomgenPrng` draws for it, the same PRNG-free property PvP's `ArenaMap`
   * already has. A floor index absent here still draws procedurally, byte-identical
   * to before this field existed — fully additive, no `ENGINE_VERSION` bump (no
   * shipped config sets it, and it changes nothing for one that doesn't). */
  floorMaps?: Partial<Record<number, DungeonFloorMap>>;
  /** Optional per-floor-index pool of interchangeable hand-authored layouts (Task 6,
   * "room-layout randomization", 2026-09-23): when `floorIndex` has an entry here,
   * `SpawnSystem` draws ONE `roomgenPrng.nextInt(variants.length)` pick among them
   * instead of reading `floorMaps[floorIndex]` directly — the same "one well-scoped
   * PRNG choice over otherwise-fixed hand content" shape `content/enemies.ts`'s
   * `BOSS_POOL`/`'boss_random'` sentinel already established for boss rooms, applied
   * here to floor TOPOLOGY instead of a single spawn point. A floor index absent
   * here still reads `floorMaps` directly and costs zero extra draws, unchanged from
   * before this field existed. Every variant for a given index is expected to share
   * the same room roster (same `pieceId`s, same array order) so enemy-id allocation
   * order (`state.nextId()`, spawn-order-driven) and notice-delay tuning stay
   * identical across variants — only door connectivity (and therefore which rooms a
   * run can skip) is meant to differ; see `emberLevel1.ts`'s
   * `EMBER_L1_FLOOR_2_BRANCH` for the shipped example. */
  floorLayoutVariants?: Partial<Record<number, readonly DungeonFloorMap[]>>;
  /** Optional per-floor weapon rarity curve (design/09 `dropTableByDepth`'s weapon half,
   * ROADMAP B4, 2026-09-26): one `RarityWeightRow` per floor index, integer percent points
   * summing to 100 (`rarityTableProblems`), read by every weapon find — chest payout, boss
   * drop, shop weapon slot. A floor past the last row uses the last row. Absent, the
   * level-1 table (`DEFAULT_WEAPON_RARITY_BY_DEPTH`) applies, so a config without the field
   * rolls exactly what it did before the field existed. Buffs, heals and coins stay
   * depth-blind by decision. */
  weaponRarityByDepth?: readonly RarityWeightRow[];
  /** Optional per-floor material tier curve (design/09 `materialTierByDepth`, ROADMAP B4):
   * entry `i` is the instance tier a material dropped on floor index `i` rolls at, clamped to
   * the last entry past the end (`materialTierForFloor`). Absent, the tier is the floor index
   * itself — the identity curve every config shipped with. */
  materialTierByDepth?: readonly number[];
}

/** One resolved stage: normally a single `RoomPiece`; a `RoomPiece[]` (length
 * always `>= 2`) only at a `'branching'` floor's one fork stage — real, distinct
 * sibling rooms `placeFloor` places side-by-side (module doc "fully-realized
 * branching"), not a resolved single pick. Deliberately NOT `readonly RoomPiece[]`
 * here — TS's `Array.isArray` type guard doesn't narrow a `readonly T[]` union
 * member out of the non-array branch (a `readonly T[] extends any[]` conditional
 * check is false), which would leave every `Array.isArray(stage) ? ... : stage`
 * site still seeing the array type in the `RoomPiece` branch. */
export type FloorStage = RoomPiece | RoomPiece[];

/** One floor's generated room sequence, already fully resolved — at most one
 * stage is a real fork (module doc), so `placeFloor` never has to make its own
 * content choice, only a placement one. The last stage is always the capstone:
 * `extractionPieceId` on every floor except the last, `bossPieceId` on the last
 * (design/05 "the last floor's boss room IS its extraction room"). */
export interface FloorLayout {
  floorIndex: number; // 0-based
  stages: readonly FloorStage[];
  /** Flattened, one-piece-per-stage view for simple/back-compat consumers (HUD
   * stage count, non-branching callers): the fork stage's first/primary candidate.
   * Always `stages.map(s => Array.isArray(s) ? s[0] : s)`. */
  rooms: readonly RoomPiece[];
}

/** One room placed into a floor's shared coordinate space. `id` is synthesized as
 * `${piece.id}#${stageIndex}` — a `RoomPiece` can be drawn more than once per
 * floor (branching wrap-around, or two stages happening to draw the same piece),
 * so the piece's own `id` alone cannot be relied on as a floor-unique `RoomId`. */
export interface PlacedRoom {
  id: RoomId;
  piece: RoomPiece;
  offsetXGrid: number;
  offsetYGrid: number;
  /** A point just inside the room, used as the force-regroup teleport target and
   * (for the first room) the run's initial spawn. */
  entranceGrid: { x: number; y: number };
}

/**
 * A hand-authored floor — the `DungeonConfig.floorMaps` per-floor-index override
 * that lets a floor be placed exactly, instead of drawn from `generateFloor`/
 * `placeFloor`'s PRNG stream. `rooms` reference the SAME `RoomPiece` library
 * `generateFloor` already draws from, by id — a hand-authored floor is not a
 * separate content vocabulary, just a different way of arranging the existing
 * one. `doors` reuses PvP's own `Door` type unchanged (`content/arenas.ts`) — a
 * hand-placed PvE door is no different a shape from a hand-placed PvP one.
 *
 * Array order carries meaning, reusing the two single-index assumptions already
 * baked into the engine rather than inventing a third: `rooms[0]` is the
 * entrance/spawn room (`SpawnSystem`'s `placed[0]`), `rooms[rooms.length - 1]` is
 * the capstone extraction/boss room (`ExtractionSystem`'s
 * `dungeonRoomRuntime[length - 1]`). This module trusts that ordering — it fails
 * loud only on a broken reference (a missing piece/room id), never re-validates
 * placement or the capstone convention; `tools/map-editor`'s
 * `validateDungeonFloorMap` is the save-time gate for those, matching how
 * `validateArenaMap` is PvP's own save-time gate rather than an engine-side check.
 */
export interface DungeonFloorMap {
  id: string;
  rooms: { id: RoomId; pieceId: string; offsetXGrid: number; offsetYGrid: number }[];
  doors: Door[];
}
