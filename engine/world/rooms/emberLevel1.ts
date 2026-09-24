/**
 * Level 1 ("the Ember descent") — the shipped PvE level's hand-authored content,
 * loaded from `world/dungeons/ember/`.
 *
 * This module is a LOADER, not an authoring surface: every piece and every floor is
 * plain JSON on disk, in exactly the two shapes `tools/map-editor` reads and writes
 * (`RoomPiece` for the "PvE Room Library" tab, `DungeonFloorMap` for the "PvE
 * Dungeon Floor" tab), so the level can be tuned in the editor without touching a
 * line of TypeScript. PvP set that precedent first and has since moved the other way:
 * its 60-room launch arena is hand-authored TypeScript (`engine/world/arenas/`,
 * imported directly by `client/src/game/match/arenaCatalog.ts`), because a map whose
 * layout is a drawing reads better as code than as JSON. The two conventions coexist on
 * purpose — this level stays JSON under `world/` so the editor can round-trip it.
 *
 * Shape of the level (the spec this content was seeded against, and what
 * `emberLevel1.test.ts` holds it to):
 *   - 5 floors, 6 / 7 / 8 / 8 / 6 rooms each — the capstone counts as one of them, and
 *     so does each floor's SIDE room (below).
 *   - Every room between 15x15 and 20x20 grid cells.
 *   - Enemy count per room ramps with the room's cell count, 15 at 15x15 up to 30 at
 *     20x20. The deliberate exceptions are the extraction capstone and the three side
 *     rooms (0 enemies each). The capstone is the checkpoint/portal room, and
 *     `DoorSystem`/`ExtractionSystem` both treat "capstone cleared" as the floor's own
 *     gate, so garrisoning it would turn every checkpoint into a second boss fight.
 *   - Floors 0-3 are capped by `ember_l1_extraction`, floor 4 by `ember_l1_boss`
 *     (which doubles as its own extraction, design/05).
 *
 * ## The three side rooms (2026-09-14, design/05 "Chest rooms" / "Shops")
 *
 * Chests and shop counters used to be authored onto the COMBAT pieces — a small chest on
 * `alcove`/`court`/`gallery`/`rampart`, the big one on the extraction capstone, a counter on
 * `forge`/`crucible`. A piece is reused across floors, so that spread the same reward over
 * whichever floors happened to draw the piece, and it left the level with no room that is a
 * search instead of a fight (design/05's own "a floor mixes combat rooms with chest rooms",
 * filed as `ROADMAP` B1's remaining content half).
 *
 * They now live on three dedicated, enemy-free piece TYPES, each authored as a DEAD-END
 * branch off the floor's chain rather than a link in it — walking in is a detour a player
 * chooses, not a room the capstone is behind:
 *   - `ember_l1_cache` — one small chest. Floors 0, 1, 3 and 4.
 *   - `ember_l1_vault` — the big (per-seat mechanism) chest. Floor 2 only.
 *   - `ember_l1_market` — the shop counter. Floor 3 only.
 * Which floor carries which is therefore a FLOOR-MAP decision now, editable in the map
 * editor without touching a combat piece.
 *
 * Because all 5 floor indices are present in `EMBER_L1_FLOORS`, `SpawnSystem` takes
 * the `placeAuthoredFloor` path for every floor of a real run — the procedural
 * `generateFloor`/`placeFloorGraph2d` path costs zero `roomgenPrng` draws here and
 * only ever runs as a fallback if a floor map is removed.
 *
 * The JSON was seeded by `tools/map-editor/scripts/genEmberLevel1.mjs` (a one-shot
 * generator, deliberately not wired into any npm script — re-running it overwrites
 * editor tweaks). The JSON is the source of truth from here on, not the script.
 */
import type { RoomPiece } from '../../content/rooms';
import type { DungeonFloorMap } from '../dungeon';

import alcove from '../../../world/dungeons/ember/pieces/ember_l1_alcove.json';
import bastion from '../../../world/dungeons/ember/pieces/ember_l1_bastion.json';
import boss from '../../../world/dungeons/ember/pieces/ember_l1_boss.json';
import cache from '../../../world/dungeons/ember/pieces/ember_l1_cache.json';
import caldera from '../../../world/dungeons/ember/pieces/ember_l1_caldera.json';
import cell from '../../../world/dungeons/ember/pieces/ember_l1_cell.json';
import court from '../../../world/dungeons/ember/pieces/ember_l1_court.json';
import crucible from '../../../world/dungeons/ember/pieces/ember_l1_crucible.json';
import extraction from '../../../world/dungeons/ember/pieces/ember_l1_extraction.json';
import forge from '../../../world/dungeons/ember/pieces/ember_l1_forge.json';
import furnace from '../../../world/dungeons/ember/pieces/ember_l1_furnace.json';
import gallery from '../../../world/dungeons/ember/pieces/ember_l1_gallery.json';
import kiln from '../../../world/dungeons/ember/pieces/ember_l1_kiln.json';
import market from '../../../world/dungeons/ember/pieces/ember_l1_market.json';
import rampart from '../../../world/dungeons/ember/pieces/ember_l1_rampart.json';
import span from '../../../world/dungeons/ember/pieces/ember_l1_span.json';
import vault from '../../../world/dungeons/ember/pieces/ember_l1_vault.json';

import floor1 from '../../../world/dungeons/ember/ember_l1_floor_1.json';
import floor2 from '../../../world/dungeons/ember/ember_l1_floor_2.json';
import floor2Branch from '../../../world/dungeons/ember/ember_l1_floor_2_branch.json';
import floor3 from '../../../world/dungeons/ember/ember_l1_floor_3.json';
import floor4 from '../../../world/dungeons/ember/ember_l1_floor_4.json';
import floor5 from '../../../world/dungeons/ember/ember_l1_floor_5.json';

/** The level-1 piece library — 15 normal pieces (tagged `'ember_l1'`, three of them the
 * enemy-free side rooms above) plus the two role pieces the floors' capstones reference by id. Pass this as
 * `EngineConfig.dungeon.library`; `placeAuthoredFloor` resolves every floor's
 * `pieceId` against it. */
export const EMBER_L1_ROOMS: readonly RoomPiece[] = [
  cell,
  alcove,
  gallery,
  forge,
  kiln,
  span,
  court,
  furnace,
  bastion,
  crucible,
  rampart,
  caldera,
  cache,
  vault,
  market,
  extraction,
  boss,
] as RoomPiece[];

/** Floor index (0-based) → its authored map, for `DungeonConfig.floorMaps`. All five
 * indices are present, so a real run never generates a floor procedurally. */
export const EMBER_L1_FLOORS: Partial<Record<number, DungeonFloorMap>> = {
  0: floor1 as DungeonFloorMap,
  1: floor2 as DungeonFloorMap,
  2: floor3 as DungeonFloorMap,
  3: floor4 as DungeonFloorMap,
  4: floor5 as DungeonFloorMap,
};

/**
 * Floor index 1's alternate door-graph layout (Task 6, "room-layout randomization",
 * 2026-09-23 — user request: some floors keep their exit at the very end of a
 * strictly linear chain, so nothing is skippable; some put a real fork in the
 * middle, so a room can be skipped, with no time-pressure mechanic attached
 * either way — clearing every room stays a player choice, never a clock). Same 7
 * rooms, same pieces, same array order as `floor2` above (so enemy-id allocation
 * and notice-delay tuning are byte-identical whichever variant a run draws) — only
 * `r3_span`'s position and the door graph differ: `r2_kiln` gets a direct door
 * straight to `r4_forge`, and `r3_span` moves to a dead-end spur off `r2_kiln`
 * instead of sitting on the only path through. A run can walk kiln → span → back
 * out → forge (fighting span for its loot) or kiln → forge directly (skipping it)
 * — both real, both valid; `emberLevel1.test.ts`'s "branching layout variant" block
 * proves the skip exists here and does not exist on the plain `floor2` map above.
 */
export const EMBER_L1_FLOOR_2_BRANCH: DungeonFloorMap = floor2Branch as DungeonFloorMap;
