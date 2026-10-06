/**
 * Seeded dungeon assembly (design/05/09, ROADMAP 1.3) — "a seeded layout stitches
 * hand-authored pieces" (design/09's core divergence from funny's one scripted
 * level). `generateFloor` is the pure selection function: given a `DungeonConfig`,
 * which floor, the run's `roomgenPrng`, and a `RoomPiece` library, it returns the
 * ordered room sequence for that floor. `placeFloor`/`carveDoorGaps`/
 * `buildFloorGeometry` are the pure placement functions (design/05 "Room & door
 * model", 2026-08-04): they turn that ordered sequence into a co-resident,
 * door-connected floor — every room simultaneously live, matching PvP's `ArenaMap`
 * (`content/arenas.ts`) shape, rather than the old one-room-at-a-time swap. All of
 * these are pure and side-effect-free, like `content/rooms.ts roomGeometry` — none
 * touch GameState. Wiring a generated, placed floor into a live run is
 * `SpawnSystem`'s job.
 *
 * Three layouts: `'linear'` is a single ordered room sequence, one room per normal
 * stage. `'branching'` (design/05, 2026-08-05 "fully-realized branching") gets
 * **one real fork-and-reconverge diamond per floor**: a PRNG-chosen interior
 * normal-stage transition splits into `branchFactor` DISTINCT, same-width sibling
 * rooms placed side-by-side (real `PlacedRoom`s, a real walk-through-the-door
 * choice), which reconverge into the very next stage's room (an ordinary room or
 * the capstone) with no separate merge-room concept needed. Superseded prior
 * behavior (ENGINE_VERSION 34): branching used to resolve at generation time via a
 * second `roomgenPrng.nextInt(branchFactor)` draw per stage that just perturbed the
 * linear pick by a wraparound offset into the same pool — no sibling ever existed
 * as data. See the `FloorStage`/`generateFloor`/`placeFloor` doc comments below for
 * the concrete draw sequence and placement geometry. Only one fork per floor
 * (no fork-into-fork chaining) and siblings must share their pool piece's exact
 * width (so their shared east boundary lines up with one merge-room X, reusing
 * `pickDoorAnchor`'s adjacency assumption unmodified) — both deliberate scope cuts,
 * not data-model limits (`Door`/`PlacedRoom` already support an arbitrary graph).
 *
 * `'graph2d'` (design/05, ROADMAP "real 2D graph layout" follow-up) is the third
 * layout — it closes the one remaining deliberate scope cut in this module: a
 * generated floor is no longer forced onto a west→east spine. `generateFloor`'s
 * stage/piece selection is UNCHANGED for it (same one-`nextInt`-per-stage stream as
 * `'linear'` — it never forks, so every stage stays a plain `RoomPiece`, never a
 * sibling array); what differs is placement, in the dedicated `placeFloorGraph2d`
 * below (a sibling to `placeFloor`, not a variant of it, same precedent as
 * `placeAuthoredFloor`): each transition walks out of whichever of the previous
 * room's exits is both unconsumed and has a matching opposite exit on the next
 * piece, drawing a direction ONLY when more than one such exit is viable (the same
 * "only draw when it matters" discipline `combatPrng`'s crit draw already
 * established). A room's own exits already consumed entering it are excluded, so
 * every stage AFTER the first naturally narrows to a single viable direction for a
 * west/east-only pool (`'east'`, matching `placeFloor`'s own spine byte-for-byte)
 * — the ONE place this can genuinely diverge is the very first (spawn) room: it
 * has no entryEdge to exclude, so a piece authored with BOTH a west and an east
 * exit (e.g. `ember_hall`) offers both as real, drawn outgoing choices, and the
 * floor may legitimately start by placing its first neighbor to the west instead
 * of the east — real 2D freedom, not a regression (a spawn piece authored with only
 * the one exit it actually uses, `dungeonrun.test.ts TEST_LIB`'s own convention,
 * removes the ambiguity entirely). No shipped `DungeonConfig` uses `'graph2d'` yet
 * (`EMBER_DUNGEON` stays `'linear'`) — additive, no `ENGINE_VERSION` bump.
 *
 * This file is a thin assembly barrel (CLAUDE.md "500-line file convention", form
 * ① — independent function modules: every export below is a pure, side-effect-free
 * function/type with no shared private state, so the module splits cleanly by
 * concern into ./dungeon/*.ts): types in ./dungeon/types.ts, floor SELECTION in
 * ./dungeon/generateFloor.ts, the three PLACEMENT strategies each in their own
 * sibling file (./dungeon/{placeFloor,placeFloorGraph2d,placeAuthoredFloor}.ts,
 * sharing ./dungeon/placementConstants.ts and ./dungeon/entranceGeometry.ts), and
 * collision-geometry stitching in ./dungeon/floorGeometry.ts. Re-exported wholesale
 * so every existing `import { ... } from '.../world/dungeon'` site is untouched.
 */
export type { RoomTag, CurveSpec, DungeonConfig, EndlessSpec, FloorStage, FloorLayout, PlacedRoom, DungeonFloorMap } from './dungeon/types';
export {
  biomeIdAt,
  floorOffersDescend,
  floorOffersExtract,
  floorSourceAt,
  isBossFloor,
  isEndlessDungeon,
  lapFloorCount,
  type FloorSource,
} from './dungeon/floorSource';
export { curveAt, generateFloor } from './dungeon/generateFloor';
export { placeFloor } from './dungeon/placeFloor';
export { placeFloorGraph2d } from './dungeon/placeFloorGraph2d';
export { placeAuthoredFloor } from './dungeon/placeAuthoredFloor';
export { carveDoorGaps, buildFloorGeometry, toFpAabbGrid } from './dungeon/floorGeometry';
