/**
 * Chapter 3 ("the Storm descent", design/gameplay/04-chapters.md) — the lightning chapter's
 * content loader and its `DungeonConfig`, laid out exactly like chapter 2's `frost.ts`.
 *
 * The JSON under `world/dungeons/storm/` was seeded by
 * `tools/map-editor/scripts/deriveChapter.mjs storm`: chapter 1's tuned JSON turned half a
 * circle (every piece inside its own box, every floor inside its bounding box), with the fire
 * and lightning mobs swapped and the boss room naming chapter 3's own boss (`voltreaver`).
 * Chapter 1 runs left-to-right and down, chapter 2 (transposed) top-to-bottom and right, so
 * this one runs right-to-left and up. The JSON is the source of truth from here on;
 * `stormLevel1.test.ts` pins that it still is that transform.
 *
 * Same shape as chapters 1 and 2 therefore: 5 floors of 6 / 7 / 8 / 8 / 6 rooms, the same three
 * enemy-free side rooms, the same skippable branch on floor indices 1-3.
 */
import type { RoomPiece } from '../../content/rooms';
import type { DungeonConfig, DungeonFloorMap } from '../dungeon';

import alcove from '../../../world/dungeons/storm/pieces/storm_l1_alcove.json';
import bastion from '../../../world/dungeons/storm/pieces/storm_l1_bastion.json';
import boss from '../../../world/dungeons/storm/pieces/storm_l1_boss.json';
import cache from '../../../world/dungeons/storm/pieces/storm_l1_cache.json';
import cell from '../../../world/dungeons/storm/pieces/storm_l1_cell.json';
import coil from '../../../world/dungeons/storm/pieces/storm_l1_coil.json';
import conduit from '../../../world/dungeons/storm/pieces/storm_l1_conduit.json';
import court from '../../../world/dungeons/storm/pieces/storm_l1_court.json';
import dynamo from '../../../world/dungeons/storm/pieces/storm_l1_dynamo.json';
import extraction from '../../../world/dungeons/storm/pieces/storm_l1_extraction.json';
import gallery from '../../../world/dungeons/storm/pieces/storm_l1_gallery.json';
import maelstrom from '../../../world/dungeons/storm/pieces/storm_l1_maelstrom.json';
import market from '../../../world/dungeons/storm/pieces/storm_l1_market.json';
import rampart from '../../../world/dungeons/storm/pieces/storm_l1_rampart.json';
import span from '../../../world/dungeons/storm/pieces/storm_l1_span.json';
import spire from '../../../world/dungeons/storm/pieces/storm_l1_spire.json';
import vault from '../../../world/dungeons/storm/pieces/storm_l1_vault.json';

import floor1 from '../../../world/dungeons/storm/storm_l1_floor_1.json';
import floor2 from '../../../world/dungeons/storm/storm_l1_floor_2.json';
import floor2Branch from '../../../world/dungeons/storm/storm_l1_floor_2_branch.json';
import floor3 from '../../../world/dungeons/storm/storm_l1_floor_3.json';
import floor3Branch from '../../../world/dungeons/storm/storm_l1_floor_3_branch.json';
import floor4 from '../../../world/dungeons/storm/storm_l1_floor_4.json';
import floor4Branch from '../../../world/dungeons/storm/storm_l1_floor_4_branch.json';
import floor5 from '../../../world/dungeons/storm/storm_l1_floor_5.json';

/** Chapter 3's piece library — the 15 `'storm_l1'`-tagged pieces plus the two role pieces. */
export const STORM_L1_ROOMS: readonly RoomPiece[] = [
  cell,
  alcove,
  gallery,
  spire,
  coil,
  span,
  court,
  dynamo,
  bastion,
  conduit,
  rampart,
  maelstrom,
  cache,
  vault,
  market,
  extraction,
  boss,
] as RoomPiece[];

/** Floor index (0-based) → its authored map. All five present, so nothing is procedural. */
export const STORM_L1_FLOORS: Partial<Record<number, DungeonFloorMap>> = {
  0: floor1 as DungeonFloorMap,
  1: floor2 as DungeonFloorMap,
  2: floor3 as DungeonFloorMap,
  3: floor4 as DungeonFloorMap,
  4: floor5 as DungeonFloorMap,
};

/**
 * Chapter 3's config. Differs from `FROST_DUNGEON` in its biome, its pieces and one number:
 *  - `biomeId: 'storm'` — the chapter id (`world/chapters.ts`) and the lightning palette
 *    (client `theme.ts`'s `BIOME_ID_TO_ELEMENT`, the `biome-lightning` swatch pack).
 *  - `difficultyCurve.perFloor` 0.3125 against chapters 1 and 2's 0.25, on chapter 2's own
 *    `base` of 1.125: the same entrance as chapter 2, and every floor after it steeper
 *    (floor 2 ×1.4375, the boss floor ×2.375 against chapter 2's ×2.125).
 *
 * Why the step and not the base. Set by `client/sim/chapterSim.sim.ts` (2026-10-06), careful
 * bot, starter kit. Runs off floor 0 out of 80 (base alone decides floor 0):
 *    chapter 3 at base 1        21/80   ← content alone: chapter 1's 20, chapter 2's 17
 *    chapter 3 at base 1.125    13/80   ← shipped; chapter 2 reads 10 at the same base
 *    chapter 3 at base 1.1875    0/80   ← a wall: the 3-HP basic mob rounds up to 4
 *    chapter 3 at base 1.25      3/80
 * Every base above 1.125 rounds the commonest mob up a whole hit point, so the entrance has no
 * step between "chapter 2's" and "a wall". The deeper floors have room, and are where a player
 * who has cleared chapter 2 brings that chapter's gear: on a fresh-start floor-2 trial the
 * steeper curve halves the bot's kills (14 against 23 at chapter 2's step, 40 seeds).
 */
export const STORM_DUNGEON: DungeonConfig = {
  biomeId: 'storm',
  nameKey: 'chapter.storm.name',
  floorCount: 5,
  roomsPerFloor: { min: 5, max: 7 }, // fallback-only — every floor is authored
  pieceTags: ['storm_l1'],
  layout: 'graph2d',
  extractionPieceId: 'storm_l1_extraction',
  bossPieceId: 'storm_l1_boss',
  difficultyCurve: { base: 1.125, perFloor: 0.3125 }, // see the doc comment above
  floorMaps: STORM_L1_FLOORS,
  floorLayoutVariants: {
    1: [STORM_L1_FLOORS[1]!, floor2Branch as DungeonFloorMap],
    2: [STORM_L1_FLOORS[2]!, floor3Branch as DungeonFloorMap],
    3: [STORM_L1_FLOORS[3]!, floor4Branch as DungeonFloorMap],
  },
};
