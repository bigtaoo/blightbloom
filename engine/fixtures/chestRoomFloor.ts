/**
 * A synthetic one-floor dungeon whose only job is to make **chests** observable in a golden
 * hash — design/05 "Chest rooms", `ENGINE_VERSION` 63.
 *
 * ## Why this exists (read before deleting it as redundant)
 *
 * Third instance of the same hole `brimGrinderFloor.ts` and `extractionGateFloor.ts` were
 * written for, and the memory of the previous two is what made it cheap to spot this time.
 * The shipped level DOES author chests now (five pieces carry one), so `ember-dungeon-floor1`
 * moved when they landed — but it moved for the wrong reason and pins nothing about the
 * feature:
 *
 *   - that scenario's hash shifted because instantiating three chests advances
 *     `GameState.nextId()` three times before the floor's enemies are built, and
 *     `noticeDelayTicks(e.id)` staggers the opening volley off the enemy id. A pure
 *     bookkeeping ripple.
 *   - **no chest in it is ever opened.** Its own note says a scripted stick does not clear
 *     rooms, so the run never leaves the spawn room; the spawn room has no chest; and even if
 *     it did, a big chest needs every plate occupied at once, which one seat wandering at
 *     random will not arrange.
 *
 * So deleting the whole of `ChestSystem.open` would have left the gate green. The fix, as
 * both times before, is geometry and an input script chosen so the contact is guaranteed
 * rather than lucky.
 *
 * ## The shape, and why each piece of it is the way it is
 *
 * **Two seats.** Not a co-op flourish — it is the only way a big chest's rule exists at all.
 * `mechanismRing` derives one plate per seat, so a one-seat run rings the chest with a single
 * plate and "everyone is standing on one" is satisfiable by one player. Two seats is the
 * smallest party for which the chest is a coordination gate rather than a step.
 *
 * **Both seats spawn ON their own plate.** With the chest at the room's centre and two seats,
 * the ring puts its plates due east and due west at `CHEST_MECHANISM_RING_GRID`, so the two
 * authored player spawns are written at exactly those points. The chest therefore opens on
 * the first tick, before the stick has moved anybody meaningfully — `MovementSystem` (step 4)
 * runs before `ChestSystem` (10.5) in the same tick, but one tick of stick displacement is a
 * fraction of `CHEST_MECHANISM_RADIUS_GRID`. Making the open happen by construction instead
 * of by wandering is the entire reason the spawns are where they are; do not "tidy" them to
 * the room centre.
 *
 * **A small chest one grid from seat 0's spawn**, plus the `chest` input flag pulsing INTERACT
 * every 3 ticks (against the ordinary `interact` flag's 53). Same reasoning as
 * `extractionGateFloor.ts`'s 7-vs-61 extract cadence: the pulse has to land while the player
 * is provably still in reach, and tick 3 is early enough that no plausible stick has carried
 * them out of a 1.5-grid radius.
 *
 * **Three enemies, ringed close.** The golden gate's anti-vacuity guard wants a run that
 * really fired and really hit (`bullet_fired > 20`, `hit > 0`), and a room with two players
 * standing on plates and nothing to shoot satisfies neither.
 *
 * ## What the scenario built on this actually pins
 *
 * `chest_open: 2` in the witness, one per kind, and the pickups they pay. The two failure
 * directions read straight off the diff rather than off the hash: a big chest that stops
 * requiring every plate (or starts ignoring them) changes when — or whether — the count
 * reaches 2, and a payout rule that drifts moves `pickups` without moving `chest_open`.
 */
import { CHEST_MECHANISM_RING_GRID } from '../config';
import type { RoomPiece } from '../content/rooms';
import type { DungeonConfig, DungeonFloorMap } from '../world/dungeon';

/** Room centre, in the piece's own grid units. The chest sits here; everything else is
 *  measured from it, so the fixture has one number to change rather than five. */
const CX = 10.5;
const CY = 10.5;
const R = CHEST_MECHANISM_RING_GRID;

export const CHEST_ROOM: RoomPiece = {
  id: 'chest_room_capstone',
  tags: ['chest_room'],
  sizeGrid: { w: 21, h: 21 },
  // A plain solid ring, nothing free-standing — same reasoning as `extractionGateFloor.ts`:
  // this fixture is about chests, and a brimmed block would couple `WALL_NORTH_BRIM` into its
  // baseline for no reason.
  solids: [
    { x: 0, y: 0, w: 21, h: 1 },
    { x: 0, y: 20, w: 21, h: 1 },
    { x: 0, y: 1, w: 1, h: 19 },
    { x: 20, y: 1, w: 1, h: 19 },
  ],
  spawns: {
    // Seat 0 east, seat 1 west — EXACTLY the two plates `mechanismRing` derives for two seats
    // (brad 0 and brad BRAD_FULL/2). See the header: this is load-bearing, not cosmetic.
    player: [
      { x: CX + R, y: CY },
      { x: CX - R, y: CY },
    ],
    // Three, close enough that automatic aim finds them on tick one. The count matches
    // `extractionGateFloor.ts`'s, and for the same measured reason recorded there: one enemy
    // makes a run too short to clear the anti-vacuity guard.
    enemy: [
      { x: CX, y: CY - 5, type: 'basic' },
      { x: CX - 5, y: CY - 3, type: 'basic' },
      { x: CX + 5, y: CY - 3, type: 'basic' },
    ],
  },
  chests: [
    // The big one at the centre of the plate ring.
    { kind: 'big', x: CX, y: CY },
    // The small one one grid north of seat 0's spawn — inside `CHEST_INTERACT_RANGE_GRID`
    // plus a body radius, so the tick-3 INTERACT pulse provably reaches it.
    { kind: 'small', x: CX + R, y: CY - 1 },
  ],
  // One room, no doors: nothing is ever locked, and the run plays inside it.
  exits: [],
  role: 'boss',
};

const floorMap: DungeonFloorMap = {
  id: 'chest_room_f0',
  rooms: [{ id: 'c1', pieceId: CHEST_ROOM.id, offsetXGrid: 0, offsetYGrid: 0 }],
  doors: [],
};

export const CHEST_ROOM_ROOMS: readonly RoomPiece[] = [CHEST_ROOM];

export const CHEST_ROOM_DUNGEON: DungeonConfig = {
  biomeId: 'ember',
  nameKey: 'biome.ember',
  // One floor: chests are a room-level mechanic and descending adds nothing to what this pins,
  // while a second floor would put the floor-card offer into the same baseline.
  floorCount: 1,
  roomsPerFloor: { min: 1, max: 1 },
  pieceTags: ['chest_room'],
  layout: 'graph2d',
  // The single floor is the last one, so its capstone is the boss piece; `extractionPieceId`
  // is required by the schema and never reached here.
  extractionPieceId: CHEST_ROOM.id,
  bossPieceId: CHEST_ROOM.id,
  difficultyCurve: { base: 1, perFloor: 0 },
  floorMaps: { 0: floorMap },
};
