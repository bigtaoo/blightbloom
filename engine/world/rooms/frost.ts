/**
 * Chapter 2 ("the Frost descent", design/gameplay/04-chapters.md) — the ice chapter's
 * content loader and its `DungeonConfig`, in one file because chapter 1 split the two only
 * for history's sake (`ember.ts` predates the authored level).
 *
 * The JSON under `world/dungeons/frost/` was seeded by
 * `tools/map-editor/scripts/deriveChapter.mjs`: chapter 1's tuned JSON, transposed, with the
 * fire and ice mobs swapped and the boss room naming chapter 2's own boss (`glacimaw`).
 * Like chapter 1 the JSON is the source of truth from here on and is edited in the map editor;
 * `frostLevel1.test.ts` pins that it still is that transform, and holds it to every property
 * chapter 1's own content test does.
 *
 * Same shape as chapter 1 therefore: 5 floors of 6 / 7 / 8 / 8 / 6 rooms, the same three
 * enemy-free side rooms, the same skippable branch on floor indices 1-3.
 */
import type { RoomPiece } from '../../content/rooms';
import type { DungeonConfig, DungeonFloorMap } from '../dungeon';

import alcove from '../../../world/dungeons/frost/pieces/frost_l1_alcove.json';
import bastion from '../../../world/dungeons/frost/pieces/frost_l1_bastion.json';
import boss from '../../../world/dungeons/frost/pieces/frost_l1_boss.json';
import cache from '../../../world/dungeons/frost/pieces/frost_l1_cache.json';
import cell from '../../../world/dungeons/frost/pieces/frost_l1_cell.json';
import cirque from '../../../world/dungeons/frost/pieces/frost_l1_cirque.json';
import cistern from '../../../world/dungeons/frost/pieces/frost_l1_cistern.json';
import court from '../../../world/dungeons/frost/pieces/frost_l1_court.json';
import drift from '../../../world/dungeons/frost/pieces/frost_l1_drift.json';
import extraction from '../../../world/dungeons/frost/pieces/frost_l1_extraction.json';
import gallery from '../../../world/dungeons/frost/pieces/frost_l1_gallery.json';
import glacier from '../../../world/dungeons/frost/pieces/frost_l1_glacier.json';
import hollow from '../../../world/dungeons/frost/pieces/frost_l1_hollow.json';
import market from '../../../world/dungeons/frost/pieces/frost_l1_market.json';
import rampart from '../../../world/dungeons/frost/pieces/frost_l1_rampart.json';
import span from '../../../world/dungeons/frost/pieces/frost_l1_span.json';
import vault from '../../../world/dungeons/frost/pieces/frost_l1_vault.json';

import floor1 from '../../../world/dungeons/frost/frost_l1_floor_1.json';
import floor2 from '../../../world/dungeons/frost/frost_l1_floor_2.json';
import floor2Branch from '../../../world/dungeons/frost/frost_l1_floor_2_branch.json';
import floor3 from '../../../world/dungeons/frost/frost_l1_floor_3.json';
import floor3Branch from '../../../world/dungeons/frost/frost_l1_floor_3_branch.json';
import floor4 from '../../../world/dungeons/frost/frost_l1_floor_4.json';
import floor4Branch from '../../../world/dungeons/frost/frost_l1_floor_4_branch.json';
import floor5 from '../../../world/dungeons/frost/frost_l1_floor_5.json';

/** Chapter 2's piece library — the 15 `'frost_l1'`-tagged pieces plus the two role pieces. */
export const FROST_L1_ROOMS: readonly RoomPiece[] = [
  cell,
  alcove,
  gallery,
  hollow,
  drift,
  span,
  court,
  glacier,
  bastion,
  cistern,
  rampart,
  cirque,
  cache,
  vault,
  market,
  extraction,
  boss,
] as RoomPiece[];

/** Floor index (0-based) → its authored map. All five present, so nothing is procedural. */
export const FROST_L1_FLOORS: Partial<Record<number, DungeonFloorMap>> = {
  0: floor1 as DungeonFloorMap,
  1: floor2 as DungeonFloorMap,
  2: floor3 as DungeonFloorMap,
  3: floor4 as DungeonFloorMap,
  4: floor5 as DungeonFloorMap,
};

/**
 * Chapter 2's config. Differs from `EMBER_DUNGEON` in exactly three ways, each a decision:
 *  - `biomeId: 'frost'` — the chapter id (`world/chapters.ts`) and the ice palette
 *    (client `theme.ts`'s `BIOME_ID_TO_ELEMENT`).
 *  - its own piece tag and role pieces.
 *  - `difficultyCurve.base` 1.25, against chapter 1's 1: every floor of chapter 2 scales mob HP
 *    a quarter higher than the same floor of chapter 1 (floor 1 ×1.25 → boss floor ×2.25). The
 *    garrisons themselves are chapter 1's, so this is the one knob that makes the second chapter
 *    the harder one; `npm run test:pve-sim` is what it was set against.
 */
export const FROST_DUNGEON: DungeonConfig = {
  biomeId: 'frost',
  nameKey: 'chapter.frost.name',
  floorCount: 5,
  roomsPerFloor: { min: 5, max: 7 }, // fallback-only — every floor is authored
  pieceTags: ['frost_l1'],
  layout: 'graph2d',
  extractionPieceId: 'frost_l1_extraction',
  bossPieceId: 'frost_l1_boss',
  difficultyCurve: { base: 1.25, perFloor: 0.25 },
  floorMaps: FROST_L1_FLOORS,
  floorLayoutVariants: {
    1: [FROST_L1_FLOORS[1]!, floor2Branch as DungeonFloorMap],
    2: [FROST_L1_FLOORS[2]!, floor3Branch as DungeonFloorMap],
    3: [FROST_L1_FLOORS[3]!, floor4Branch as DungeonFloorMap],
  },
};
