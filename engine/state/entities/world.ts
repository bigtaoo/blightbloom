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
// 'coin' (2026-09-14, design/05 "Shops") is the in-run currency a shop room spends. Auto-
// collected like `material` and for the same reason (pure upside, no choice to make), but
// into the COLLECTING PLAYER's own wallet rather than a shared floor buffer: a coin is
// never banked, never carried out and never seen by the meta layer, so there is nothing for
// `ExtractionSystem` to merge and nothing for a death to forfeit beyond the run itself.
// 'schematic' (design/14, ENGINE_VERSION 68) is a boss kill's one-time blueprint drop — a
// physical ground item like every other carry-out, replacing the old auto-grant-to-the-
// whole-run `state.runBlueprint` flag. Auto-collected like `material`, and into the
// COLLECTING PLAYER's own per-seat carry-out bag (`PlayerActor.schematicStock`), not a
// shared one: whichever seat walks over it is the one whose account gets it, exactly like
// `material` now works (see `PlayerActor.floorMaterials`'s own doc comment for why the carry-
// out model moved from "whole squad shares one pool" to "per seat, first to touch keeps it").
export type PickupKind =
  | 'heal'
  | 'material'
  | 'coin'
  | 'weapon'
  | 'buff'
  | 'crate'
  | 'bandage'
  | 'energy'
  | 'schematic'
  // A boss kill's rare character unlock (design/14, 2026-09-26): `skinId` names one of
  // `DROP_CHARACTERS`. The schematic's twin in every respect — auto-collected, into the
  // COLLECTOR's own `PlayerActor.characterPickup`, and only handed to the account if the run
  // is won.
  | 'character'
  // Instant items (Task 4, ENGINE_VERSION 71) — auto-apply on overlap like `heal`/
  // `energy`, the two other capped-pool instants (`PickupSystem.pickupWouldApply`'s
  // own doc comment anticipated exactly this: "if a shield/temp-buff instant item is
  // ever added, this is the one place it needs a clause").
  | 'shield' // restores PlayerActor.shield toward maxShield — no instant shield refill existed before this; shield otherwise only recovers via idle regen.
  | 'emp'; // instant burst: lightning damage to every alive enemy within EMP_RADIUS_FP of the collector — the roster's first offensive (not self-restoring) instant item.

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

/**
 * One line on a shop's counter (design/05 "Shops", 2026-09-14).
 *
 * `kind` is the same vocabulary `PickupKind` uses, minus everything a shop does not sell, so
 * that a purchase resolves through the machinery a drop already goes through rather than
 * through a parallel one — `ShopSystem` spawns a weapon pickup and applies the other three
 * exactly as `PickupSystem` would.
 *
 * `sold` rather than removal from the array: the row stays on the counter greyed out, which
 * is what tells a player who just watched a teammate buy it why it is gone. Stock is SHARED
 * and wallets are per-seat, so first-come-first-served — the same rule a small chest runs on.
 */
export interface ShopOffer {
  /** From `GameState.nextShopId()`, a separate id space (see there). Compared only against
   *  `PlayerCommand.shopBuyId`, never against an entity or pickup id. */
  id: number;
  kind: 'weapon' | 'buff' | 'heal' | 'energy' | 'shield' | 'emp';
  weaponId?: string; // kind 'weapon' → id into WEAPON_SPECS
  // kind 'buff' → id into RUN_BUFFS. Since the pick-one-of-three (ROADMAP B2, 2026-09-26) it
  // is unset on the counter and written at the sale: WHICH of `choices` was bought.
  buffId?: string;
  /** kind 'buff' only (ROADMAP B2, 2026-09-26): the three buffs this line offers, one of which
   *  the buyer takes at the line's one price. Each carries its own id from the same
   *  `nextShopId()` space, and that id — not the offer's — is what `PlayerCommand.shopBuyId`
   *  names to buy it, so the choice rides the existing one-number command unchanged. */
  choices?: ShopBuffChoice[];
  price: number; // in coins (PlayerActor.coins)
  sold: boolean;
}

/** One of a buff line's three choices (ROADMAP B2). */
export interface ShopBuffChoice {
  id: number;
  buffId: string;
}

/**
 * A shop (design/05 "Shops"). Engine state for the same three reasons a `Chest` is: `sold`
 * is a decision the sim makes, it has to replay bit-for-bit, and a counter whose stock lived
 * in the renderer would restock itself on every resumed save.
 *
 * Instantiated once per floor placement from each `RoomPiece.shops` entry
 * (`SpawnSystem.generateAndPlaceFloor`) and cleared with the rest of the floor — an unbought
 * offer is gone when its geometry is, the same rule uncollected pickups and unopened chests
 * follow. A run therefore cannot walk back to a previous floor's shop, which is what keeps
 * "save your coins" a decision about the floors AHEAD.
 */
export interface Shop {
  id: number;
  /** The `PlacedRoom.id` this shop belongs to — it may only be traded with once that room is
   *  activated, so a counter cannot be worked from outside through a wall. */
  roomId: string;
  gx: Fp;
  gy: Fp;
  stock: ShopOffer[];
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
  skinId?: string; // kind 'character' → id into SKIN_DEFS, one of DROP_CHARACTERS (design/14)
  qty?: number; // kind 'material' → amount dropped; kind 'coin' → coins in this pile
  // kind 'material' → the ROLLED instance tier (design/09 materialTierByDepth,
  // ROADMAP 1.5), distinct from MaterialDef.tier (the catalog's static base — always
  // 0, since there's one id per element regardless of depth). Rises with dungeon
  // depth (DeathDropsSystem passes state.floorIndex as the depth signal); always 0
  // for a config without floors (identical to no field at all).
  tier?: number;
}
