/**
 * entities/ split: the non-actor things a floor is made of — static solids, the AABB
 * every system measures against, and the pickups a kill leaves on the ground.
 */

import type { Fp } from '../../math/fixed';

/**
 * A static round solid (design/07 "walls are static solids"). Pillars are drawn
 * round, so the launch collision geometry is a circle rather than an AABB tile —
 * actors are pushed out along the centre line (MovementSystem step 4). Positions
 * are grid-fp, converted once at construction from the EngineConfig px layout.
 */
export interface Obstacle {
  gx: Fp;
  gy: Fp;
  radius: Fp;
}

/**
 * A static rectangular solid — the AABB tile/wall geometry design/07 deferred
 * (ROADMAP 1.2), complementing the round pillars above. `x,y` is the top-left
 * corner; `w,h` the extents. All Fp, converted once at construction/room-placement
 * from human grid units (`content/rooms.ts roomGeometry`). Actor push-out is
 * circle-vs-AABB (MovementSystem); bullets stop/expire on overlap
 * (ProjectileStepSystem) — same treatment as a round pillar, different shape test.
 */
export interface AABB {
  x: Fp;
  y: Fp;
  w: Fp;
  h: Fp;
  /**
   * This rect is a FREE-STANDING block inside a room (an interior cover block), rather than a
   * segment of a room's perimeter ring or a door passage. Set once at authoring time and
   * carried through `roomGeometry`/`carveDoorGaps`; absent everywhere else, which is why it is
   * optional rather than required — a door passage folded into `state.walls` by `DoorSystem`
   * and a flat `EngineConfig.walls` entry both correctly answer "no".
   *
   * What reads it, and nothing else may join them without a note here (design/18 G5 — this
   * list was stale for a whole version, claiming a single reader after there were three):
   *   - `MovementSystem.resolveWalls` — gives such a block's NORTH face
   *     `config.WALL_NORTH_BRIM` of extra clearance (ENGINE_VERSION 47);
   *   - `geom.clampToWalkable` — the same brimmed edge, so a dropped pickup can never settle
   *     inside a band no actor may stand in (ENGINE_VERSION 48);
   *   - `world/dungeon/floorGeometry.carveDoorGaps` — propagates the flag across the
   *     rect-minus-rect carve; it decides nothing, it only avoids losing the bit.
   *
   * Deliberately NOT read by the bare `circleOverlapsAabb` path (bullets, doorway tests, zone
   * traits): those must keep hitting the real stone. That asymmetry is intended, and
   * `boundaryParity.test.ts` is where it is declared rather than left to this comment. The
   * rect's own numbers stay the collision AND the drawn footprint — a flag that started
   * *moving* geometry would silently desync the two.
   */
  freeStanding?: boolean;
}

// design/09 vocabulary: heal (flat +1 HP) · material (carry-out currency) · weapon ·
// buff (run-scoped power). Materials are the only carry-out; banking is 1.4/1.5.
// 'crate' is arena-only (design/15): an unresolved lootMarker spawn — no payload
// fields set — that PickupSystem rolls into a real kind once a player is within
// SIM.lootRevealRadius. Keeps the roll (and its weaponId) out of shared GameState
// until a player could plausibly see it, so a map-wide state-reading/free-camera
// cheat can't read every floor's loot identity from across the whole arena.
// 'energy' (ENGINE_VERSION 59, design/03/05) is the ammo economy's refill — an
// instant item like `heal`, collected under the same "only when it would actually do
// something" rule, and carrying no payload fields (the amount is a constant,
// `ENERGY_PICKUP_AMOUNT`, not a per-drop roll).
export type PickupKind = 'heal' | 'material' | 'weapon' | 'buff' | 'crate' | 'bandage' | 'energy';

/**
 * A chest's kind (design/05 "Chest rooms"). The two differ in WHO can open one and in
 * how much it pays, never in where it may be authored:
 *   - `small` — one player, one INTERACT, no gate. Pays one weapon to the party.
 *   - `big`   — ringed by one MECHANISM per seat; opens only while every mechanism has
 *               a player standing on it, and pays one weapon PER SEAT so the per-capita
 *               reward is flat and only the coordination cost scales.
 */
export type ChestKind = 'small' | 'big';

/**
 * One of a big chest's pressure plates. Position is derived, never authored — see
 * `content/chests.ts mechanismRing`: the COUNT depends on the run's seat count, which no
 * room piece can know, so authoring it would be authoring a number that is wrong for every
 * party size but one. `occupied` is recomputed from scratch every tick by `ChestSystem`;
 * it is stored rather than local so the render layer can light a plate the player is on
 * without re-deriving the test (design/10 "UI reads state+events").
 */
export interface ChestMechanism {
  gx: Fp;
  gy: Fp;
  occupied: boolean;
}

/**
 * A chest (design/05 "Chest rooms"). Engine state, deliberately — `opened` is hashed,
 * replicated and replayed like any other decision the sim makes, because a chest that
 * opened on one client and not another is a desync, and a chest whose openness lived in
 * the renderer would re-open on every resumed save.
 *
 * Instantiated once per floor placement from each `RoomPiece.chests` entry
 * (`SpawnSystem.generateAndPlaceFloor`), and cleared with the rest of the floor — an
 * unopened chest is gone when its geometry is, the same rule uncollected pickups follow.
 */
export interface Chest {
  id: number;
  /** The `PlacedRoom.id` this chest belongs to — it may only be opened once that room is
   *  activated, so a chest cannot be worked from outside through a wall. */
  roomId: string;
  kind: ChestKind;
  gx: Fp;
  gy: Fp;
  /** Empty for `small`; one entry per seat for `big`. */
  mechanisms: ChestMechanism[];
  opened: boolean;
}

export interface PickupItem {
  id: number;
  kind: PickupKind;
  gx: Fp;
  gy: Fp;
  spawnTick: number; // tick it was dropped; not collectable until a later tick (design/08 step 8→9)
  alive: boolean;
  // Payload for the powered drops (design/05). Set on the matching kind only:
  weaponId?: string; // kind 'weapon' → id into WEAPON_SPECS
  buffId?: string; // kind 'buff' → id into RUN_BUFFS (design/14)
  materialId?: string; // kind 'material' → id into MATERIAL_DEFS (design/09)
  qty?: number; // kind 'material' → amount dropped
  // kind 'material' → the ROLLED instance tier (design/09 materialTierByDepth,
  // ROADMAP 1.5), distinct from MaterialDef.tier (the catalog's static base — always
  // 0, since there's one id per element regardless of depth). Rises with dungeon
  // depth (DeathDropsSystem passes state.floorIndex as the depth signal); always 0
  // for a config without floors (identical to no field at all).
  tier?: number;
}
