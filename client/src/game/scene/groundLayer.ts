// Split out of RoomBuilder 2026-08-20 (500-line convention, CLAUDE.md form ① — a set of
// independent functions over rects with no shared private state): everything painted on
// `layers.ground`, i.e. the floor itself and the four flat overlays on it. The walls, doors,
// pillars and the portal all stand on `layers.entities` and stay in RoomBuilder, which owns their
// lifetimes; nothing here needs to be remembered between builds, because `build()` destroys the
// whole ground layer and repaints it.
//
// The stack, bottom to top, and why it is in this order:
//
//   1. the floor — a stamped swatch, or a flat palette fill where no swatch exists (`floorRender`);
//   2. the floor's own variation — per-room wash, mottle, stains, rubble, door wear, half of it in
//      an additive Graphics because Pixi fills only multiply down and a floor that can only get
//      darker loses its mean (`floorRender`);
//   3. the 64 px grid — a readability aid, kept at `GRID_ALPHA` since 2026-08-18 because a
//      full-strength lattice is the loudest "this is a top-down blueprint" cue in the frame;
//   4. the per-room light pool (`roomLight`) — painted last of the four so the lattice fades toward
//      the walls with everything else.
//
// Each stage is mounted as one piece PER ROOM (per region, per door) rather than as one Graphics for
// the whole floor, and every piece carries the rect it paints so `groundCulling.ts` can switch the
// off-screen ones off. That is the 2026-08-26 arena pass: the stage order above is unchanged and the
// geometry was byte-for-byte the same, but the layer went from "285k floats submitted every frame
// wherever the camera is" to "whatever the viewport touches" — 17x less packed vertex data on
// `arena_launch`. Read `groundCulling.ts` before quoting that as a frame-time win: it is not one, and
// the header there says what the A/B actually measured.
//
// What DID move the frame is the 2026-08-27 pass on top of it: `floorClip.ts` stops each room's
// mottle painting outside the room, so a piece's rect is its room instead of its room plus 460 px of
// spill, and the cull above then drops a neighbour's halves. 0.53-0.93 ms of a ~4.4 ms arena frame,
// 13 on-screen pieces down to 7, 19.9% fewer floats on the layer. That is the first deliberate
// change to this geometry since the split, and it is why `groundGeometryBudget.test.ts`'s pins no
// longer reproduce the pre-split browser census.
import { Container, Graphics, type Texture } from 'pixi.js';
import { roomModel, type AABB, type GameState } from '@dd/engine';
import type { BiomePalette } from '../theme';
import { fpToPx } from '../coords';
import type { RectPx } from './wallGeometry';
import { drawDoorWear, drawFloorDecals, drawFloorMottle, drawRoomWash, hash2, stampFloor } from './floorRender';
import { staticGraphics } from '../../render/staticGraphics';
import { swatchMeta } from '../../render/biomeTiles';
import { DEFAULT_ROOM_LIGHT, WARM_STONE_ROOM_LIGHT, drawRoomLight } from './roomLight';
import { cellExtent, roomsCoverReachableSpace } from './floorPartition';
import { tagGroundPiece } from './groundCulling';
import { StagedBuild, solo, type BuildStep } from './stagedBuild';

/** Opacity of the 64 px floor grid. See the module header for why it is this low. */
const GRID_ALPHA = 0.12;
const GRID_STEP = 64;
/** Tile scale the mottle is sized against when no floor swatch is loaded at all. */
const FALLBACK_TILE = 256;

/** Everything the ground stage needs, all of it already computed by `RoomBuilder.build` for the
 *  wall pass — `rooms` for identity (wash/mottle/decals/light), `floorRegions` for coverage (see
 *  `floorRegionsPx`), `wallRects` to keep rubble off a wall's own footprint, `doorRects` for the
 *  worn patch across each doorway. */
export interface GroundDeps {
  rooms: readonly RectPx[];
  floorRegions: readonly RectPx[];
  wallRects: readonly RectPx[];
  doorRects: readonly RectPx[];
  palette: BiomePalette;
  floorTex: Texture | undefined;
}

/**
 * Paint the whole ground layer for the currently loaded floor. `ground` is expected to be empty
 * (RoomBuilder destroys its children first).
 *
 * Each room's variation is seeded off its own world POSITION rather than its index, so a room draws
 * the identical floor on every visit and on every client — design/06's determinism rule applied to
 * the render layer, the same way `Pickup`'s bob phase is a golden angle times its entity id.
 */
export function buildGroundLayer(ground: Container, deps: GroundDeps): void {
  const staged = new StagedBuild();
  staged.start(groundSteps(ground, deps));
  staged.runAll();
}

/**
 * The same paint as `buildGroundLayer`, as one step per mounted piece, in mount order — the unit a
 * descend spreads over frames (`stagedBuild.ts`). Running every step in order IS `buildGroundLayer`,
 * which is how it is implemented, so the two cannot drift apart.
 */
export function groundSteps(ground: Container, deps: GroundDeps): BuildStep[] {
  const { rooms, floorRegions, wallRects, doorRects, palette, floorTex } = deps;
  const tileSize = floorTex?.width ?? FALLBACK_TILE;
  // A warm-stone floor (design/13, 2026-10-10) is drawn stone by stone: the 64 px lattice over it
  // reads as a second, unrelated paving, and its edges are meant to fall much further into shadow.
  const authored = swatchMeta(floorTex)?.authoredTone === true;
  const steps: BuildStep[] = [];

  // (1) the floor itself. One container per region rather than 322 loose sprites, so the piece the
  // camera switches off is the region — the same granularity every other stage is culled at, and
  // the one rect that is already known exactly without measuring anything.
  for (const region of floorRegions) {
    steps.push(() => {
      const tiles = new Container();
      if (floorTex) {
        for (const tile of stampFloor(floorTex, region, !swatchMeta(floorTex)?.seamless)) tiles.addChild(tile);
      } else {
        const fill = staticGraphics();
        fill.rect(region.x, region.y, region.w, region.h).fill({ color: palette.ground });
        tiles.addChild(fill);
      }
      mountPiece(ground, tiles, region);
    });
  }

  // (2) the floor's variation. Two pieces per room, because the light half is additively blended —
  // and ALL the dark halves are mounted before ANY light half, not dark-then-light per room. That
  // matters: a mottle blob reaches well outside the room that seeded it, so the stage order has to
  // hold ACROSS rooms, not merely within one. Door wear rides at the top of the light half, where
  // it has always been.
  //
  // `staticGraphics` throughout, as before: painted once per room build and never touched again, on
  // a layer with its own render group.
  const lightHalves: Graphics[] = [];
  // Each room's variation is the heaviest paint on the floor (2-5 ms apiece on a desktop, most of
  // it the mottle's clip), so each gets a frame to itself when the build is staged.
  for (const room of rooms) {
    steps.push(solo(() => {
      const dark = staticGraphics();
      const light = staticGraphics();
      light.blendMode = 'add';
      const seed = hash2(Math.round(room.x), Math.round(room.y)) >>> 8;
      drawRoomWash(dark, room, seed);
      drawFloorMottle(dark, light, room, seed, tileSize);
      drawFloorDecals(dark, light, room, seed, wallRects);
      mountPainted(ground, dark);
      lightHalves.push(light);
    }));
  }
  // One step per light half, still all after every dark one: mounting them together would put all
  // their triangulation on one render.
  for (let i = 0; i < rooms.length; i++) steps.push(() => mountPainted(ground, lightHalves[i]!));
  for (const door of doorRects) {
    steps.push(() => {
      const wear = staticGraphics();
      wear.blendMode = 'add';
      drawDoorWear(wear, door);
      mountPainted(ground, wear);
    });
  }

  // (3) the grid, per region, and (4) the light pool, per room.
  for (const region of authored ? [] : floorRegions) {
    steps.push(() => {
      const grid = staticGraphics();
      drawRegionGrid(grid, region, palette);
      mountPiece(ground, grid, region);
    });
  }
  for (const room of rooms) {
    steps.push(() => {
      const light = staticGraphics();
      drawRoomLight(light, room, authored ? WARM_STONE_ROOM_LIGHT : DEFAULT_ROOM_LIGHT, wallRects);
      mountPainted(ground, light);
    });
  }
  return steps;
}

/** The 64 px lattice over one floor region. */
function drawRegionGrid(grid: Graphics, r: RectPx, palette: BiomePalette): void {
  const x1 = r.x + r.w;
  const y1 = r.y + r.h;
  for (let x = Math.ceil(r.x / GRID_STEP) * GRID_STEP; x <= x1; x += GRID_STEP) grid.moveTo(x, r.y).lineTo(x, y1);
  for (let y = Math.ceil(r.y / GRID_STEP) * GRID_STEP; y <= y1; y += GRID_STEP) grid.moveTo(r.x, y).lineTo(x1, y);
  grid.stroke({ color: palette.gridLine, width: 1, alpha: GRID_ALPHA });
}

/** Mount a piece whose painted extent is known exactly (a region's floor stamp, its grid). */
function mountPiece(ground: Container, node: Container, bounds: RectPx): void {
  tagGroundPiece(node, bounds);
  ground.addChild(node);
}

/**
 * Mount a piece and tag it with what it actually PAINTED, read back off the geometry.
 *
 * Not the room rect, even though since 2026-08-27 the two are usually equal. `drawFloorMottle` seeds
 * its blobs inside the room and used to draw them up to 1.8 tiles across, so a 448x384 room's dark
 * pass measured 838x446 px; `floorClip.ts` now clips those blobs to the room, so the same pass
 * measures the room. Reading the bounds back rather than assuming that is the point: it was what kept
 * the cull exact while the spill existed, and it is what will keep it exact if the clip ever gains a
 * margin — a hand-derived rect would have to be re-derived, and the door wear (deliberately painted
 * across a passage into both rooms) is already a piece the room rect would describe wrongly.
 */
function mountPainted(ground: Container, node: Container): void {
  const b = node.getLocalBounds();
  tagGroundPiece(node, { x: b.minX, y: b.minY, w: b.maxX - b.minX, h: b.maxY - b.minY });
  ground.addChild(node);
}

/** The floor's room footprints in world px — room IDENTITY (which rooms get their own wash, mottle,
 *  decals and light pool) and the input to `wallGeometry.wallTier`. Dungeon floors and the PvP arena
 *  each keep their own list, and `engine/state/roomModel.ts` is the one rule for picking between
 *  them (shared with `EnvironmentSystem` and `GameLoop.cameraFrame`, which used to have their own);
 *  a flat `EngineConfig.floors` run populates neither, so the world itself stands in as the single
 *  room (identical answer for a one-room world). */
export function roomRectsPx(s: GameState, w: number, h: number): RectPx[] {
  const { rects } = roomModel(s);
  if (rects.length === 0) return [{ x: 0, y: 0, w, h }];
  return rects.map(({ rect }) => toPx(rect));
}

/**
 * Where the FLOOR is actually painted (the stamp and the 64 px grid) — a different question from
 * `roomRectsPx`, which is room IDENTITY and already runs per room on both kinds of map.
 *
 * The floor may stop at the rooms exactly when the rooms are a partition of everywhere the player
 * can reach, and that is MEASURED per map (`roomsCoverReachableSpace`) rather than assumed from
 * the map's kind. It used to be assumed: dungeon floors per room, arenas whole-world, on the
 * strength of one sweep of `arena_prototype_60` — 5240 of its 11,524 non-wall cells (45%)
 * reachable and outside every room, because that map had no walls at all. `arena_launch`
 * (2026-08-25) walls every room, so the premise under the branch became false while the branch
 * kept answering the same way. Measured 2026-08-26: `arena_launch` 0 cells outside (its rooms ARE
 * a partition, and its floor now stops at them), `arena_prototype_60` 5240, `landing_basic` —
 * a wall-less `?arenaDemo=1` fixture — its whole 50x50 world minus three rooms. The derivation
 * costs 3ms once per arena build.
 *
 * A PvE dungeon floor keeps its direct answer: `floorCoverage.test.ts` sweeps all five shipped
 * floors for exactly this property (0 cells outside, against a world bounding box 1.41-2.26x the
 * rooms' own area), so re-deriving it on every room transition would buy nothing.
 *
 * This is the one caller that needs the room model's KIND and not just its rects, which is why
 * `roomModel` returns a tagged pair: the dungeon and arena branches genuinely differ. The third
 * kind, 'none' (a flat config, or a dungeon between floors), gets NO branch of its own on purpose
 * — it falls through both and lands on the same whole-world answer `roomsCoverReachableSpace`
 * gives for an empty room list, which that function documents and `floorPartition.test.ts` pins
 * ("reports no for a map with no rooms"). An early return for it here was the one mutant a
 * 2026-08-27 battery could not kill, because there was nothing to kill: two guards, one case.
 */
export function floorRegionsPx(s: GameState, w: number, h: number): RectPx[] {
  const model = roomModel(s);
  const rooms = model.rects.map(({ rect }) => rect);
  if (model.kind === 'dungeon') return rooms.map(toPx);
  if (model.kind === 'arena' && roomsCoverReachableSpace(cellExtent(s.worldW, s.worldH), s.walls, rooms)) {
    return rooms.map(toPx);
  }
  return [{ x: 0, y: 0, w, h }];
}

function toPx(rect: AABB): RectPx {
  return { x: fpToPx(rect.x), y: fpToPx(rect.y), w: fpToPx(rect.w), h: fpToPx(rect.h) };
}
