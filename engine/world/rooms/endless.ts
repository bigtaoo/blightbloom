/**
 * The Endless Descent (design/gameplay/04-chapters.md, 2026-10-06) — the fifth entry in the
 * chapter catalog, unlocked by clearing chapter 4, for players who have beaten every chapter.
 *
 * It authors no floor of its own. Its floors are the four chapters' twenty authored floors,
 * chapter after chapter (floors 1-5 ember, 6-10 frost, 11-15 storm, 16-20 blight), and then the
 * cycle starts over at ember, for ever (`DungeonConfig.endless`, `dungeon/floorSource.ts`). Each
 * floor keeps everything its chapter gives it: map, layout variants, garrison, boss room, biome
 * palette and music. What the endless run owns is depth:
 *  - **One difficulty curve over the whole run**, read at the global floor index, so the second
 *    lap's ember floors are far harder than the first's. Only enemy HP scales (`enemies.ts`), as
 *    in every chapter.
 *  - **Every fifth floor is a boss floor whose portal offers EXTRACT as well as DESCEND.**
 *    Extracting ends the run with the bag; descending keeps it at risk. A death still loses it
 *    all, as everywhere (design/gameplay/01).
 *  - **Material tiers plateau at 4**, the highest any chapter drops: the identity curve every
 *    chapter uses would hand out tier 20 on floor 21.
 */
import type { RoomPiece } from '../../content/rooms';
import type { DungeonConfig } from '../dungeon';
import { EMBER_DUNGEON } from './ember';
import { EMBER_L1_ROOMS } from './emberLevel1';
import { FROST_DUNGEON, FROST_L1_ROOMS } from './frost';
import { STORM_DUNGEON, STORM_L1_ROOMS } from './storm';
import { BLIGHT_DUNGEON, BLIGHT_L1_ROOMS } from './blight';

const SEGMENTS: readonly DungeonConfig[] = [EMBER_DUNGEON, FROST_DUNGEON, STORM_DUNGEON, BLIGHT_DUNGEON];

/** Every segment's pieces in one library. Piece ids carry their chapter's prefix, so none collide. */
export const ENDLESS_ROOMS: readonly RoomPiece[] = [
  ...EMBER_L1_ROOMS,
  ...FROST_L1_ROOMS,
  ...STORM_L1_ROOMS,
  ...BLIGHT_L1_ROOMS,
];

/**
 * The endless config. `floorCount` is one lap (20 floors) and no floor is the last; the piece
 * ids and tags are the first segment's, read only by the procedural fallback, which no floor
 * reaches since every segment floor is authored.
 */
export const ENDLESS_DUNGEON: DungeonConfig = {
  biomeId: 'endless',
  nameKey: 'chapter.endless.name',
  floorCount: SEGMENTS.reduce((n, seg) => n + seg.floorCount, 0),
  roomsPerFloor: EMBER_DUNGEON.roomsPerFloor,
  pieceTags: EMBER_DUNGEON.pieceTags,
  layout: 'graph2d',
  extractionPieceId: EMBER_DUNGEON.extractionPieceId,
  bossPieceId: EMBER_DUNGEON.bossPieceId,
  difficultyCurve: { base: 1.125, perFloor: 0.25 },
  materialTierByDepth: [0, 1, 2, 3, 4],
  endless: { segments: SEGMENTS },
};
