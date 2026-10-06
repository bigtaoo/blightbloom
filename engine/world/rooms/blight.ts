/**
 * Chapter 4 ("the Blight descent", design/gameplay/04-chapters.md) — the poison chapter and the
 * finale, laid out exactly like chapters 2 and 3 (`frost.ts`, `storm.ts`).
 *
 * The JSON under `world/dungeons/blight/` was seeded by
 * `tools/map-editor/scripts/deriveChapter.mjs blight`: chapter 1's tuned JSON mirrored across
 * the anti-diagonal (every piece inside its own box, every floor inside its bounding box), with
 * every emberling turned into a blightling and the boss room naming chapter 4's own boss
 * (`rotbloom`). Chapter 1 runs left-to-right and down, chapter 2 top-to-bottom and right,
 * chapter 3 right-to-left and up, so this one runs bottom-to-top and left. The JSON is the
 * source of truth from here on; `blightLevel1.test.ts` pins that it still is that transform.
 *
 * Same shape as chapters 1-3 therefore: 5 floors of 6 / 7 / 8 / 8 / 6 rooms, the same three
 * enemy-free side rooms, the same skippable branch on floor indices 1-3.
 */
import type { RoomPiece } from '../../content/rooms';
import type { DungeonConfig, DungeonFloorMap } from '../dungeon';

import alcove from '../../../world/dungeons/blight/pieces/blight_l1_alcove.json';
import bastion from '../../../world/dungeons/blight/pieces/blight_l1_bastion.json';
import boss from '../../../world/dungeons/blight/pieces/blight_l1_boss.json';
import cache from '../../../world/dungeons/blight/pieces/blight_l1_cache.json';
import canker from '../../../world/dungeons/blight/pieces/blight_l1_canker.json';
import cell from '../../../world/dungeons/blight/pieces/blight_l1_cell.json';
import court from '../../../world/dungeons/blight/pieces/blight_l1_court.json';
import extraction from '../../../world/dungeons/blight/pieces/blight_l1_extraction.json';
import gallery from '../../../world/dungeons/blight/pieces/blight_l1_gallery.json';
import market from '../../../world/dungeons/blight/pieces/blight_l1_market.json';
import mire from '../../../world/dungeons/blight/pieces/blight_l1_mire.json';
import rampart from '../../../world/dungeons/blight/pieces/blight_l1_rampart.json';
import span from '../../../world/dungeons/blight/pieces/blight_l1_span.json';
import sump from '../../../world/dungeons/blight/pieces/blight_l1_sump.json';
import thicket from '../../../world/dungeons/blight/pieces/blight_l1_thicket.json';
import vault from '../../../world/dungeons/blight/pieces/blight_l1_vault.json';
import warren from '../../../world/dungeons/blight/pieces/blight_l1_warren.json';

import floor1 from '../../../world/dungeons/blight/blight_l1_floor_1.json';
import floor2 from '../../../world/dungeons/blight/blight_l1_floor_2.json';
import floor2Branch from '../../../world/dungeons/blight/blight_l1_floor_2_branch.json';
import floor3 from '../../../world/dungeons/blight/blight_l1_floor_3.json';
import floor3Branch from '../../../world/dungeons/blight/blight_l1_floor_3_branch.json';
import floor4 from '../../../world/dungeons/blight/blight_l1_floor_4.json';
import floor4Branch from '../../../world/dungeons/blight/blight_l1_floor_4_branch.json';
import floor5 from '../../../world/dungeons/blight/blight_l1_floor_5.json';

/** Chapter 4's piece library — the 15 `'blight_l1'`-tagged pieces plus the two role pieces. */
export const BLIGHT_L1_ROOMS: readonly RoomPiece[] = [
  cell,
  alcove,
  gallery,
  mire,
  warren,
  span,
  court,
  thicket,
  bastion,
  sump,
  rampart,
  canker,
  cache,
  vault,
  market,
  extraction,
  boss,
] as RoomPiece[];

/** Floor index (0-based) → its authored map. All five present, so nothing is procedural. */
export const BLIGHT_L1_FLOORS: Partial<Record<number, DungeonFloorMap>> = {
  0: floor1 as DungeonFloorMap,
  1: floor2 as DungeonFloorMap,
  2: floor3 as DungeonFloorMap,
  3: floor4 as DungeonFloorMap,
  4: floor5 as DungeonFloorMap,
};

/**
 * Chapter 4's config. Differs from `STORM_DUNGEON` in its biome, its pieces and its curve:
 *  - `biomeId: 'blight'` — the chapter id (`world/chapters.ts`) and the poison palette
 *    (client `theme.ts`'s `BIOME_ID_TO_ELEMENT`, the `biome-poison` swatch pack).
 *  - `difficultyCurve.perFloor` 0.375 on the same `base` of 1.125 as chapters 2 and 3: the same
 *    entrance, and the steepest step (floor 2 ×1.875, the boss floor ×2.625 against chapter 3's
 *    ×2.375). The base is the cliff `STORM_DUNGEON`'s comment records, so it stays.
 *
 * Why 0.375. Set by `client/sim/chapterSim.sim.ts` (2026-10-06), careful bot, starter kit, fresh-
 * start floor trials, 40 seeds (chapter 3 for comparison):
 *                         floor 1 kills / clears   floor 2 kills   boss duel (Rotbloom alone)
 *    chapter 3 (0.3125)       27 / 33%                 14
 *    chapter 4 at 0.3125      48 / 68%                 22             95 HP: 35% kills
 *    chapter 4 at 0.375       34 / 30%                 3.6           105 HP: 35% kills   ← shipped
 *    chapter 4 at 0.4375      36 / 50%                 3.6           115 HP: 20% kills
 * At chapter 3's own step the mirrored layout and the blightling garrison read EASIER than
 * chapter 3 on floor 1, so the finale needs the steeper curve just to match chapter 3 there.
 * Floor 2 is another rounding edge: at 1.875 the 3-HP basic mob becomes 6 HP (5 at chapter 3's
 * 1.75), which is the drop from 22 kills to 3.6. Runs off floor 0 (base alone) read 15/80
 * against chapter 3's 13.
 */
export const BLIGHT_DUNGEON: DungeonConfig = {
  biomeId: 'blight',
  nameKey: 'chapter.blight.name',
  floorCount: 5,
  roomsPerFloor: { min: 5, max: 7 }, // fallback-only — every floor is authored
  pieceTags: ['blight_l1'],
  layout: 'graph2d',
  extractionPieceId: 'blight_l1_extraction',
  bossPieceId: 'blight_l1_boss',
  difficultyCurve: { base: 1.125, perFloor: 0.375 }, // see the doc comment above
  floorMaps: BLIGHT_L1_FLOORS,
  floorLayoutVariants: {
    1: [BLIGHT_L1_FLOORS[1]!, floor2Branch as DungeonFloorMap],
    2: [BLIGHT_L1_FLOORS[2]!, floor3Branch as DungeonFloorMap],
    3: [BLIGHT_L1_FLOORS[3]!, floor4Branch as DungeonFloorMap],
  },
};
