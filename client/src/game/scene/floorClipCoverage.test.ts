/// <reference types="node" />
/**
 * The room clip (`floorClip.ts`, 2026-08-27), swept over the maps the game actually builds.
 *
 * **WHAT THE CLIP IS FOR.** `drawFloorMottle` centres blobs inside a room and draws them up to 460
 * world px across, so before this pass every room painted ~42% of its ink OUTSIDE itself, four dark
 * and four light halves were legitimately on screen where one room was visible, and the three
 * neighbours painted 1.31 + 1.91 extra viewports of pure spill. Measured on a real GPU, three
 * counterbalanced sessions with twin controls: the clip is worth **0.53-0.93 ms** of a ~4.4 ms arena
 * frame, and takes the visible ground pieces from 13 to 7 (`perf/README.md`'s seventh measurement).
 *
 * **WHY THE PROPERTIES BELOW ARE THE ONES WORTH ASSERTING.** A clip is easy to make fast and easy to
 * make ugly: truncating a smooth field leaves a step of the field's own local value, and a straight
 * step on a floor is exactly what `floorRender`'s header rejected the per-tile tint for. Measured
 * offline before the shape was chosen, a HARD clip at the room rect would leave a **29.98 luma** step
 * across a doorway (median 7.24) on a floor whose base is 25.9. So the clip ramps, and this file
 * asserts the three things that make that safe, each swept over real content:
 *
 *   1. **Where the cut is allowed to land is stone.** Every shipped room rect includes its own
 *      perimeter wall exactly one grid cell deep. Measured here, not assumed.
 *   2. **The cut ramps inside that cell**, faintest band at the room's edge and strongest a full cell
 *      in, so the largest step any one cut can make is one band's own alpha — a step that band's rim
 *      already makes in the shipped art.
 *   3. **Nothing paints outside its room any more**, which is what lets `groundCulling.ts` drop a
 *      neighbour's halves while staying an exact intersection.
 *
 * Deliberately NOT here: what it looks like. That was checked in a live frame — worst per-pixel luma
 * step inside all 74 passage floors went from 36.16 to 18.51 (median 24.23 to 14.65), i.e. the
 * clipped doorway is SMOOTHER than the unclipped one, and the ramp sits under the floor swatch's own
 * texel-to-texel variation. `perf/README.md` has that reading and the three frame readers that
 * failed their own controls before it.
 */
import { describe, it, expect } from 'vitest';
import { Container, Graphics } from 'pixi.js';
import {
  buildFloorGeometry,
  createGameState,
  EMBER_L1_FLOORS,
  EMBER_L1_ROOMS,
  placeAuthoredFloor,
  toFpGrid,
  type RoomPiece,
} from '@dd/engine';
import { ARENA_CATALOG, type ArenaId } from '../match/arenaCatalog';
import { fpToPx, PX_PER_GRID } from '../coords';
import { biomePalette } from '../theme';
import { buildGroundLayer, floorRegionsPx, roomRectsPx } from './groundLayer';
import { groundPieceBounds } from './groundCulling';
import { boxInsideRect, clipPolygonToRect, insetRect } from './floorClip';
import { drawFloorMottle } from './floorRender';
import type { RectPx } from './wallGeometry';

/** The neutral floor swatch's own luma, as `floorRender.test.ts` already measures the door wear
 *  against. Everything below composites over this. */
const FLOOR_BASE = 25.9;

/**
 * A visible step, in luma. Taken verbatim from `floorRender.test.ts`'s door-wear section — "1 level
 * is the 8-bit quantisation floor; 3 is the smallest difference that reads as a difference rather
 * than as dither" — so the two files agree about what "visible" means instead of each inventing it.
 */
const JND = 3;

interface Shape {
  action: string;
  nums: number[];
  poly: number[];
  color: number;
  alpha: number;
}

/** Every drawn shape of a Graphics, flattened across fills. Same reader `floorRender.test.ts` uses,
 *  plus the `poly` point list, which is what a clipped band arrives as. */
function shapes(g: Graphics): Shape[] {
  return g.context.instructions.flatMap((ins) => {
    const data = ins.data as {
      style?: { color?: number; alpha?: number };
      path?: { instructions: { action: string; data: unknown[] }[] };
    };
    return (data.path?.instructions ?? []).map((i) => ({
      action: i.action,
      nums: i.data.filter((v): v is number => typeof v === 'number'),
      poly: i.data.flatMap((v) => (Array.isArray(v) ? (v as number[]) : [])),
      color: data.style?.color ?? 0,
      alpha: data.style?.alpha ?? 0,
    }));
  });
}

function lumaOf(color: number): number {
  return 0.2126 * ((color >> 16) & 0xff) + 0.7152 * ((color >> 8) & 0xff) + 0.0722 * (color & 0xff);
}

function pointInPoly(pts: readonly number[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 2; i < pts.length; j = i, i += 2) {
    const xi = pts[i]!;
    const yi = pts[i + 1]!;
    const xj = pts[j]!;
    const yj = pts[j + 1]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function covers(sh: Shape, x: number, y: number): boolean {
  if (sh.action === 'ellipse') {
    const [cx, cy, rx, ry] = sh.nums as [number, number, number, number];
    return ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
  }
  if (sh.action === 'rect') {
    const [rx, ry, rw, rh] = sh.nums as [number, number, number, number];
    return x >= rx && x <= rx + rw && y >= ry && y <= ry + rh;
  }
  if (sh.action === 'poly') return pointInPoly(sh.poly, x, y);
  return false;
}

/**
 * A rubble SPECK, or its key-light highlight (`floorRender.drawFloorDecals`). Excluded from the
 * doorway-step sweep below, and from nothing else.
 *
 * The reason is the decal pass's own: *"A speck is DROPPED rather than clipped, body and highlight
 * together: at alpha 0.46/0.13 a cut through one is a hard step no ramp can hide, and at 2-4 px
 * across there is nothing to ramp over."* So a speck is never a step the CLIP made — it is drawn
 * whole, inside one room, or not at all — and the bound this sweep measures against (`bandStep`)
 * is derived from the mottle, which is the only thing the clip ramps. Left in, one speck landing in
 * a doorway reads as a 33-luma clip failure: that is exactly what happened the first time a door
 * was cut into `ember_l1_court`'s west wall (2026-09-14), on a 2.7 px white dot.
 *
 * Separated by SIZE, with an order of magnitude of headroom on both sides: a speck is 1.8-4.4 px
 * (`RUBBLE_R_MIN`/`_SPAN`), the next-smallest thing the ground layer draws is a stain blob at 16,
 * and the ramp being distinguished from is `CLIP_FEATHER_PX` (32) wide. The test below pins that
 * nothing this filter actually removes comes near the 8 px line.
 */
const SPECK_MAX_R = 8;
const isSpeck = (sh: Shape): boolean =>
  sh.action === 'ellipse' && Math.max(sh.nums[2] ?? 0, sh.nums[3] ?? 0) <= SPECK_MAX_R;

/** What one room's overlay stack composites to at a point: its multiply half times the base, plus
 *  what its additive half adds. Plain alpha blending over `FLOOR_BASE`, no renderer involved. */
function lumaAt(dark: readonly Shape[], light: readonly Shape[], x: number, y: number): number {
  let f = 1;
  for (const s of dark) if (covers(s, x, y)) f *= 1 - s.alpha * (1 - lumaOf(s.color) / 255);
  let add = 0;
  for (const s of light) if (covers(s, x, y)) add += lumaOf(s.color) * s.alpha;
  return FLOOR_BASE * f + add;
}

const overlap = (a0: number, a1: number, b0: number, b1: number): number =>
  Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));

const inRect = (r: RectPx, x: number, y: number): boolean =>
  x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;

interface MapGeometry {
  rooms: RectPx[];
  regions: RectPx[];
  walls: RectPx[];
  passages: RectPx[];
}

/** One catalog arena, through the same producers `RoomBuilder.build` reads. */
function arenaGeometry(id: ArenaId): MapGeometry {
  const map = ARENA_CATALOG[id];
  const s = createGameState({ seed: 1, worldW: 1, worldH: 1, waves: [], arena: map });
  const w = fpToPx(s.worldW);
  const h = fpToPx(s.worldH);
  return {
    rooms: roomRectsPx(s, w, h),
    regions: floorRegionsPx(s, w, h),
    walls: s.walls.map((x) => ({ x: fpToPx(x.x), y: fpToPx(x.y), w: fpToPx(x.w), h: fpToPx(x.h) })),
    // `passageGrid` is ABSOLUTE grid, unlike a room's `solids` — the conversion `RoomBuilder` does.
    passages: map.doors.map((d) => ({
      x: d.passageGrid.x * PX_PER_GRID,
      y: d.passageGrid.y * PX_PER_GRID,
      w: d.passageGrid.w * PX_PER_GRID,
      h: d.passageGrid.h * PX_PER_GRID,
    })),
  };
}

/** One shipped PvE floor, through `placeAuthoredFloor` + `buildFloorGeometry` — the same entry
 *  `floorCoverage.test.ts` uses, because a dungeon floor's rooms never reach `GameState.walls` in
 *  the form an arena's do. */
function pveGeometry(index: number): MapGeometry {
  const { placed, doors } = placeAuthoredFloor(EMBER_L1_FLOORS[index]!, EMBER_L1_ROOMS as readonly RoomPiece[]);
  const geo = buildFloorGeometry(placed, doors);
  const g2px = PX_PER_GRID / toFpGrid(1);
  const rooms: RectPx[] = placed.map((r) => ({
    x: r.offsetXGrid * PX_PER_GRID,
    y: r.offsetYGrid * PX_PER_GRID,
    w: r.piece.sizeGrid.w * PX_PER_GRID,
    h: r.piece.sizeGrid.h * PX_PER_GRID,
  }));
  return {
    rooms,
    regions: rooms,
    walls: geo.walls.map((w) => ({ x: w.x * g2px, y: w.y * g2px, w: w.w * g2px, h: w.h * g2px })),
    passages: doors.map((d) => ({
      x: d.passageGrid.x * PX_PER_GRID,
      y: d.passageGrid.y * PX_PER_GRID,
      w: d.passageGrid.w * PX_PER_GRID,
      h: d.passageGrid.h * PX_PER_GRID,
    })),
  };
}

/**
 * How the band `depth` px inside every room edge is covered, sampled every 8 px along all four
 * edges of every room. `bare` is the number that matters: it is floor with no stone over it, i.e.
 * somewhere a cut would be visible.
 */
function edgeBand(geo: MapGeometry, depth: number): { wall: number; passage: number; bare: number } {
  let wall = 0;
  let passage = 0;
  let bare = 0;
  for (const r of geo.rooms) {
    const edges: Array<[number, number, number, number]> = [
      [r.x, r.y + depth, r.w, 0],
      [r.x, r.y + r.h - depth, r.w, 0],
      [r.x + depth, r.y, 0, r.h],
      [r.x + r.w - depth, r.y, 0, r.h],
    ];
    for (const [ex, ey, ew, eh] of edges) {
      const n = Math.max(1, Math.round((ew + eh) / 8));
      for (let k = 0; k < n; k++) {
        const px = ex + (ew * (k + 0.5)) / n;
        const py = ey + (eh * (k + 0.5)) / n;
        if (geo.walls.some((wl) => inRect(wl, px, py))) wall += 1;
        else if (geo.passages.some((p) => inRect(p, px, py))) passage += 1;
        else bare += 1;
      }
    }
  }
  return { wall, passage, bare };
}

const PVE_FLOORS = Object.keys(EMBER_L1_FLOORS).map(Number);

describe('the depth the clip may cut in is stone, on every map the game ships', () => {
  // This is `CLIP_FEATHER_PX`'s entire justification. It is `PX_PER_GRID` because that is how deep
  // the authored wall inside a room rect goes — `perimeterWalls()` for a PvE floor, each arena
  // room's own `solids` for the arena — and if that ever stopped being true the ramp would be
  // ramping across visible floor instead of under a wall.
  const cases: Array<[string, MapGeometry]> = [
    ['arena_launch', arenaGeometry('arena_launch')],
    ...PVE_FLOORS.map((i) => [`pve floor ${i}`, pveGeometry(i)] as [string, MapGeometry]),
  ];

  it('sweeps the arena AND all five PvE floors, not one of them', () => {
    expect(cases).toHaveLength(6);
    expect(cases.map(([, g]) => g.rooms.length).reduce((a, b) => a + b, 0)).toBeGreaterThan(80);
  });

  for (const [name, geo] of cases) {
    it(`${name}: the outer grid cell of every room rect is wall or passage, never bare floor`, () => {
      for (const depth of [2, 16, PX_PER_GRID - 2]) {
        const { wall, passage, bare } = edgeBand(geo, depth);
        expect(bare, `${name} @${depth}px in`).toBe(0);
        expect(wall).toBeGreaterThan(passage * 4); // stone is the rule, a doorway the exception
      }
    });

    it(`${name}: and it is only that deep — one cell further in is floor`, () => {
      // The control for the case above. Without it, a map that was solid stone everywhere (or a
      // sampler that answered "wall" to everything) would pass it, and the feather depth would be
      // resting on a measurement that could not fail.
      const { bare } = edgeBand(geo, PX_PER_GRID + 2);
      expect(bare).toBeGreaterThan(0);
    });
  }

  it('landing_basic is the exception, and says so — it authors no walls at all', () => {
    // The `?arenaDemo=1` fixture has `solids: []`, so its room rects contain no stone and a cut at
    // one of its room edges IS on bare floor. Asserted rather than left as a silent gap: if this
    // fixture ever grows walls, this test fails and the sweep above should gain it.
    const geo = arenaGeometry('landing_basic');
    expect(edgeBand(geo, 2).wall).toBe(0);
    expect(edgeBand(geo, 2).bare).toBeGreaterThan(0);
  });
});

/** `buildGroundLayer` over one room in isolation, so a piece can be attributed to a room exactly.
 *  The real function, with the real wall list — omitting `wallRects` would let rubble sit on a wall
 *  and change what the clip has to handle. */
function roomStack(room: RectPx, walls: readonly RectPx[]): { dark: Shape[]; light: Shape[] } {
  const ground = new Container();
  buildGroundLayer(ground, {
    rooms: [room],
    floorRegions: [],
    wallRects: walls as RectPx[],
    doorRects: [],
    palette: biomePalette('ember'),
    floorTex: undefined,
  });
  return {
    dark: shapes(ground.children[0] as Graphics),
    light: shapes(ground.children[1] as Graphics),
  };
}

/** `buildGroundLayer` over a whole map, through the real function. */
function buildWholeMap(geo: MapGeometry): Container {
  const ground = new Container();
  buildGroundLayer(ground, {
    rooms: geo.rooms,
    floorRegions: geo.regions,
    wallRects: geo.walls,
    doorRects: geo.passages,
    palette: biomePalette('ember'),
    floorTex: undefined,
  });
  return ground;
}

describe('no room paints outside itself, which is what the cull can then act on', () => {
  // Swept over the arena AND all five PvE floors AND the whole-world-floor fixture, not just the map
  // the pass was measured on. That is not padding: the first draft of this file asserted "the pieces
  // outside a room are exactly the door-wear patches", which is true of `arena_launch` and false of
  // `landing_basic`, where `floorRegionsPx` falls back to the whole world and the region stamp and
  // grid are legitimately tagged with a rect no room contains.
  const cases: Array<[string, MapGeometry]> = [
    ['arena_launch', arenaGeometry('arena_launch')],
    ['landing_basic', arenaGeometry('landing_basic')],
    ...PVE_FLOORS.map((i) => [`pve floor ${i}`, pveGeometry(i)] as [string, MapGeometry]),
  ];

  for (const [name, geo] of cases) {
    it(`${name}: every piece is inside a room or a floor region — door wear excepted`, () => {
      // The rect is grown by a hundredth of a px, not the piece: a dark half's bounds is EXACTLY its
      // room (the wash is `rect(room)`), so an epsilon on the wrong side of this comparison fails
      // every piece that is precisely right.
      const fits = (b: RectPx, rects: readonly RectPx[]): boolean =>
        rects.some((r) => boxInsideRect(insetRect(r, -0.01), b.x, b.y, b.x + b.w, b.y + b.h));
      const strays = buildWholeMap(geo).children.filter(
        (c) => !fits(groundPieceBounds(c)!, geo.rooms) && !fits(groundPieceBounds(c)!, geo.regions),
      );
      // What is left over is one patch per authored passage, and each really is a passage's:
      // `drawDoorWear` reaches 1.9 x the passage's short side into the rooms on both sides, on
      // purpose (it is the floor-level cue for where a door is), and it is a handful of ellipses
      // rather than a viewport of mottle.
      //
      // How MANY are left over is a statement about the map's floor regions rather than a constant,
      // and both branches are asserted so neither can drift silently: where the regions ARE the
      // rooms (the arena and every PvE floor) a wear patch is outside all of them, and where
      // `floorRegionsPx` falls back to the whole world (`landing_basic`, whose rooms are not a
      // partition of its walkable space) the world region contains every piece there is.
      const regionsAreRooms = JSON.stringify(geo.regions) === JSON.stringify(geo.rooms);
      expect(strays).toHaveLength(regionsAreRooms ? geo.passages.length : 0);
      for (const st of strays) {
        const b = groundPieceBounds(st)!;
        expect(
          geo.passages.some(
            (p) => overlap(b.x, b.x + b.w, p.x, p.x + p.w) > 0 && overlap(b.y, b.y + b.h, p.y, p.y + p.h) > 0,
          ),
        ).toBe(true);
      }
    });

    it(`${name}: the overlay halves reach 0 px past their room, where they used to reach 418`, () => {
      // Measured before the clip: the worst piece's painted rect stood 418 px outside the nearest
      // room (the blob radius is up to 460 and the centre is inside), which at zoom 4.29 is ~1790
      // screen px — the mechanism behind "45% of the floor is rooms the camera is not in".
      let worst = 0;
      let measured = 0;
      for (const c of buildWholeMap(geo).children) {
        const b = groundPieceBounds(c)!;
        const room = geo.rooms.find((r) => boxInsideRect(insetRect(r, -0.01), b.x, b.y, b.x + b.w, b.y + b.h));
        if (!room) continue; // a door wear patch or a whole-world region piece, covered above
        measured += 1;
        worst = Math.max(
          worst,
          room.x - b.x,
          b.x + b.w - (room.x + room.w),
          room.y - b.y,
          b.y + b.h - (room.y + room.h),
        );
      }
      // Room-scoped pieces really were found, or "0 px past their room" is a claim about nothing.
      expect(measured).toBeGreaterThanOrEqual(geo.rooms.length * 3);
      expect(worst).toBeLessThan(1e-6);
    });
  }

  for (const [name, geo] of cases) {
    it(`${name}: every piece's cull tag is the rect that piece actually paints`, () => {
      // The invariant `groundCulling.ts` rests on, stated where the clip can break it. Both of the
      // sweeps above are blind to a MIS-TAGGED piece — tag every light half with room 0's rect and
      // they still pass, because room 0's rect is a room and contains itself — which a battery over
      // `groundLayer.mountPainted` found by walking straight through them. The cull is an exact
      // intersection against this tag, so a tag that describes a different piece silently culls
      // something that is on screen, or keeps something that is not.
      let checked = 0;
      for (const c of buildWholeMap(geo).children) {
        const tag = groundPieceBounds(c)!;
        const b = c.getLocalBounds();
        // Empty geometry has no meaningful bounds (Pixi reports an inverted-infinity box), and a
        // region container of stamp Sprites is measured through its children rather than itself.
        if (!Number.isFinite(b.minX) || b.maxX <= b.minX) continue;
        if (c.children.length > 0) continue;
        checked += 1;
        // Half a pixel, and that number is the widest half-stroke on this layer rather than slack:
        // the 64 px grid is STROKED at `width: 1` and tagged with its region, so its paint straddles
        // the region rect by 0.5 px on every side. Everything painted with fills — the overlay halves
        // and the light pool — matches its tag to the float. So the cull is exact to within one
        // stroke's half-width, which is worth knowing precisely rather than approximately: a real
        // mis-tag (the battery's "tag every light half with room 0" mutant) is out by hundreds.
        expect(Math.abs(tag.x - b.minX), `${name} tag x`).toBeLessThanOrEqual(0.5);
        expect(Math.abs(tag.y - b.minY), `${name} tag y`).toBeLessThanOrEqual(0.5);
        expect(Math.abs(tag.w - (b.maxX - b.minX)), `${name} tag w`).toBeLessThanOrEqual(1);
        expect(Math.abs(tag.h - (b.maxY - b.minY)), `${name} tag h`).toBeLessThanOrEqual(1);
      }
      // Measured pieces really were found, or this asserts nothing at all.
      expect(checked, `${name} measured pieces`).toBeGreaterThanOrEqual(geo.rooms.length * 3);
    });
  }

  it('a room too small to hold the ramp still paints, and still stays inside itself', () => {
    // `insetRect` clamps at the rect own centre, so on a room narrower than twice the feather an
    // inner band's clip collapses to zero area instead of inverting, and that band contributes a
    // zero-area polygon. No shipped room is anywhere near this (the smallest is 288 px, nine grid
    // cells); this pins the degradation as graceful rather than leaving it for a future authored map.
    //
    // Recorded because it cost a round: the first version of this case reported NaN coordinates and
    // an early return for an empty clip rect was written to "fix" them. The NaN was in the test —
    // `moveTo` instructions carry two numbers and were being read through the ellipse branch below.
    // The clipper was always finite (`clipHalfPlane` only divides when the two distances differ in
    // sign, so it cannot go 0/0), the guard changed no output, and it was removed again. Every
    // comparison here is still written so a NaN would fail it.
    for (const side of [32, 64, 128]) {
      const room = { x: 0, y: 0, w: side, h: side };
      const dark = new Graphics();
      const light = new Graphics();
      drawFloorMottle(dark, light, room, 7, 256);
      // Only the two kinds of SHAPE a blob is made of; a path's `moveTo`/`lineTo` bookkeeping is not
      // a shape and describes no extent.
      const all = [...shapes(dark), ...shapes(light)].filter((sh) => sh.action === 'ellipse' || sh.action === 'poly');
      expect(all.length, `${side}px room`).toBeGreaterThan(0);
      for (const sh of all) {
        const xs = sh.action === 'poly'
          ? sh.poly.filter((_, i) => i % 2 === 0)
          : [sh.nums[0]! - sh.nums[2]!, sh.nums[0]! + sh.nums[2]!];
        const ys = sh.action === 'poly'
          ? sh.poly.filter((_, i) => i % 2 === 1)
          : [sh.nums[1]! - sh.nums[3]!, sh.nums[1]! + sh.nums[3]!];
        expect(Math.min(...xs), `${side}px room`).toBeGreaterThanOrEqual(-0.01);
        expect(Math.max(...xs), `${side}px room`).toBeLessThanOrEqual(side + 0.01);
        expect(Math.min(...ys), `${side}px room`).toBeGreaterThanOrEqual(-0.01);
        expect(Math.max(...ys), `${side}px room`).toBeLessThanOrEqual(side + 0.01);
      }
    }
  });

  it('leaves a blob that already fits completely alone, and only cuts at the boundary', () => {
    // The clip must not be a rewrite of the mottle: a blob that fits is still an `ellipse`
    // instruction with the same radii, so nothing about how a room's own floor reads has changed. A
    // version that polygonised everything would pass every bound above and fail here.
    const room = { x: 0, y: 0, w: 4096, h: 4096 };
    const dark = new Graphics();
    const light = new Graphics();
    drawFloorMottle(dark, light, room, 11, 256);
    const all = [...shapes(dark), ...shapes(light)];
    expect(all.length).toBeGreaterThan(20);
    const ellipses = all.filter((s) => s.action === 'ellipse');
    // A blob is only clipped if its 460 px reach crosses the room's outer cell, which in a 4096 px
    // room is a perimeter band ~42% of the area — so 530 of these 1299 shapes stay untouched
    // ellipses. The bound is a third, i.e. it holds while most of the interior is left alone, and a
    // version that polygonised every band would read 0.
    expect(ellipses.length).toBeGreaterThan(all.length / 3);
    // ...and every band that DID become a polygon has a cut edge in the outer grid cell, which is
    // the only place a cut is allowed to be. A clip that fired somewhere in the middle of the room
    // would leave a straight edge on open floor.
    for (const s of all.filter((sh) => sh.action === 'poly')) {
      const xs = s.poly.filter((_, i) => i % 2 === 0);
      const ys = s.poly.filter((_, i) => i % 2 === 1);
      const gap = Math.min(
        Math.min(...xs) - room.x,
        room.x + room.w - Math.max(...xs),
        Math.min(...ys) - room.y,
        room.y + room.h - Math.max(...ys),
      );
      expect(gap).toBeLessThanOrEqual(PX_PER_GRID + 0.01);
    }
  });

  it('drops a rubble speck whole rather than cutting one', () => {
    // A speck is 2-4 px across at alpha 0.46 (dark) and 0.13 (white): a straight cut through one is
    // a ~33 luma step with nothing to ramp over, so `drawFloorDecals` skips the speck instead. The
    // claim here is that no small shape is ever a `poly`.
    const arena = arenaGeometry('arena_launch');
    for (const room of arena.rooms.slice(0, 12)) {
      const { dark, light } = roomStack(room, arena.walls);
      for (const s of [...dark, ...light]) {
        if (s.action !== 'poly') continue;
        // A clipped mottle band or stain, never a speck: the smallest thing that may be clipped is
        // a stain at STAIN_R_MIN = 16 px, so its polygon spans much more than a speck's 4.
        const xs = s.poly.filter((_, i) => i % 2 === 0);
        const ys = s.poly.filter((_, i) => i % 2 === 1);
        const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
        expect(span).toBeGreaterThan(8);
      }
    }
  });
});

describe('the cut ramps across one grid cell, so a doorway never gets an edge', () => {
  const geo = arenaGeometry('arena_launch');

  it('clips a strong band further in than a faint one — the ramp itself', () => {
    // The mechanism the luma bound below rests on. Each band is clipped at its own inset, ordered by
    // alpha, so the largest step any single cut can make is ONE band's alpha rather than the whole
    // blob's stack. Read off the real geometry: group the clipped bands of one room by alpha and
    // compare how far in their polygons stop.
    const room = geo.rooms.find((r) => r.w <= 448)!;
    const { dark } = roomStack(room, geo.walls);
    const polys = dark.filter((s) => s.action === 'poly');
    expect(polys.length).toBeGreaterThan(4);
    const reach = polys.map((s) => {
      const xs = s.poly.filter((_, i) => i % 2 === 0);
      // How far the band's own boundary stops short of the room's west edge.
      return { alpha: s.alpha, inset: Math.min(...xs) - room.x };
    });
    const faintest = reach.reduce((a, b) => (b.alpha < a.alpha ? b : a));
    const strongest = reach.reduce((a, b) => (b.alpha > a.alpha ? b : a));
    expect(strongest.alpha).toBeGreaterThan(faintest.alpha);
    expect(strongest.inset).toBeGreaterThan(faintest.inset);
    // ...and the whole ramp lives inside the one grid cell of stone the room rect contains.
    expect(strongest.inset).toBeLessThanOrEqual(PX_PER_GRID);
    // Distinct insets, not one line: with the feather at 0 every band would stop on the same rect
    // and the step would be the blob's whole stack at once.
    expect(new Set(reach.map((r) => Math.round(r.inset))).size).toBeGreaterThan(2);
  });

  /**
   * The strongest single step the mottle's own radial profile already makes, in luma — its innermost
   * band's alpha against the brightest thing it paints with. Read off the real `drawFloorMottle` in a
   * room big enough that nothing is clipped, so the bound below is DERIVED from the pass being
   * clipped rather than transcribed: a cut that stays under it cannot introduce an edge the blob did
   * not already have, and re-tuning `MOTTLE_LIGHT_ALPHA` moves the gate with it.
   */
  const bandStep = (() => {
    const dark = new Graphics();
    const light = new Graphics();
    drawFloorMottle(dark, light, { x: 0, y: 0, w: 4096, h: 4096 }, 11, 256);
    return Math.max(...[...shapes(dark), ...shapes(light)].map((s) => s.alpha * Math.max(lumaOf(s.color), FLOOR_BASE)));
  })();

  /** Every luma discontinuity the clip leaves across `geo`'s passages, sampled 9 times each. */
  function doorwaySteps(geo: MapGeometry): { steps: number[]; matched: number } {
    const stacks = new Map<number, { dark: Shape[]; light: Shape[] }>();
    const stackOf = (i: number): { dark: Shape[]; light: Shape[] } => {
      if (!stacks.has(i)) {
        // Specks dropped here rather than in `lumaAt`, which every other section still reads
        // unfiltered — see `isSpeck`: they are not the clip's doing, and this is the one sweep
        // that asks what the clip did.
        const st = roomStack(geo.rooms[i]!, geo.walls);
        stacks.set(i, { dark: st.dark.filter((sh) => !isSpeck(sh)), light: st.light.filter((sh) => !isSpeck(sh)) });
      }
      return stacks.get(i)!;
    };
    const steps: number[] = [];
    let matched = 0;
    for (const p of geo.passages) {
      const pair = geo.rooms
        .map((r, i) => [r, i] as const)
        .filter(([r]) => overlap(p.x, p.x + p.w, r.x, r.x + r.w) > 0 && overlap(p.y, p.y + p.h, r.y, r.y + r.h) > 0)
        .map(([, i]) => i);
      if (pair.length !== 2) continue;
      const [ia, ib] = pair as [number, number];
      const a = geo.rooms[ia]!;
      const b = geo.rooms[ib]!;
      const vertical = p.w < p.h; // a tall passage joins two rooms east-west
      const line = vertical ? (a.x < b.x ? a.x + a.w : b.x + b.w) : (a.y < b.y ? a.y + a.h : b.y + b.h);
      const sa = stackOf(ia);
      const sb = stackOf(ib);
      matched += 1;
      for (let k = 0; k < 9; k++) {
        const t = (k + 0.5) / 9;
        const px = vertical ? line : p.x + p.w * t;
        const py = vertical ? p.y + p.h * t : line;
        // One px either side of the shared boundary: after the clip, each side is painted only by
        // its own room, so this difference IS the discontinuity the clip creates.
        const ax = vertical ? (a.x < b.x ? px - 1 : px + 1) : px;
        const ay = vertical ? py : (a.y < b.y ? py - 1 : py + 1);
        const bx = vertical ? (a.x < b.x ? px + 1 : px - 1) : px;
        const by = vertical ? py : (a.y < b.y ? py + 1 : py - 1);
        steps.push(Math.abs(lumaAt(sa.dark, sa.light, ax, ay) - lumaAt(sb.dark, sb.light, bx, by)));
      }
    }
    return { steps, matched };
  }

  it('the speck filter removes specks, and nothing that could be a clip step', () => {
    // Two failure modes, both guarded: a filter that removes nothing is a comment pretending to be
    // code, and one that grows to swallow a mottle band would silently disarm the gate below.
    const all = [...PVE_FLOORS.map(pveGeometry), arenaGeometry('arena_launch')]
      .flatMap((g) => g.rooms.map((r) => roomStack(r, g.walls)))
      .flatMap((st) => [...st.dark, ...st.light]);
    const removed = all.filter(isSpeck);
    expect(removed.length, 'the shipped floors really are speckled').toBeGreaterThan(100);
    // 4.4 px is `RUBBLE_R_MIN + RUBBLE_R_SPAN`, a speck's own largest body; the highlight is
    // smaller still. Nothing the filter takes comes within 3 px of its own 8 px line.
    expect(Math.max(...removed.map((sh) => Math.max(sh.nums[2] ?? 0, sh.nums[3] ?? 0)))).toBeLessThanOrEqual(4.4);
  });

  it('the derived bound is a real bound, not a vacuous one', () => {
    // If one band's own step were below the threshold this repo calls visible, "under one band" would
    // be a stronger claim than it sounds and the assertions below would be measuring the wrong thing.
    // Measured 4.90 luma against a JND of 3.
    expect(bandStep).toBeGreaterThan(JND);
  });

  const stepCases: Array<[string, MapGeometry, number]> = [
    ['arena_launch', arenaGeometry('arena_launch'), 74],
    ...PVE_FLOORS.map((i) => {
      const g = pveGeometry(i);
      return [`pve floor ${i}`, g, g.passages.length] as [string, MapGeometry, number];
    }),
  ];

  for (const [name, geo, expectedPassages] of stepCases) {
    it(`${name}: every doorway's step stays under one band of the mottle it is clipping`, () => {
      const { steps, matched } = doorwaySteps(geo);
      // Every authored passage really was measured — a sweep that matched none of them would pass any
      // bound at all, which is this repo's most-repeated way of testing nothing.
      expect(matched, `${name} passages matched`).toBe(expectedPassages);
      expect(steps).toHaveLength(expectedPassages * 9);
      const worst = Math.max(...steps);
      const median = [...steps].sort((a, b) => a - b)[steps.length >> 1]!;
      // THE GATE. Measured worsts: arena 2.59, PvE floors 2.76 / 1.67 / 3.04 / 2.76 / 2.73, against a
      // 4.90 bound. (Floors 0 and 1 read 1.14 / 1.17 before the 2026-09-14 side rooms added a door
      // apiece; every floor's worst still sits under two thirds of one band.) A hard clip at the
      // room rect reads 29.98 on the arena.
      expect(worst, `${name} worst doorway step ${worst.toFixed(2)} luma`).toBeLessThan(bandStep);
      // ...and the TYPICAL doorway is below what this repo calls a visible difference at all. Stated
      // distributionally on purpose: the worst case is legitimately allowed to reach one band, and
      // asserting `worst < JND` is exactly the trap this sweep was widened to catch — that bound
      // passes on `arena_launch` (2.59) and FAILS on PvE floor 2 (3.04), so measuring one map would
      // have shipped a gate the next body of content breaks while the real property still holds.
      expect(median, `${name} median doorway step ${median.toFixed(2)} luma`).toBeLessThan(JND);
    });
  }

  it('landing_basic has no doorway to measure, and that is a fact about the fixture', () => {
    // Asserted with its precondition rather than left as a map missing from the sweep: the wall-less
    // `?arenaDemo=1` fixture authors two passages that join no pair of its room rects, so there is no
    // shared boundary for a clip to cut across. If it ever grows real adjacency, this fails and it
    // belongs in the sweep above.
    const geo = arenaGeometry('landing_basic');
    expect(geo.passages.length).toBeGreaterThan(0);
    expect(doorwaySteps(geo).matched).toBe(0);
  });
});

describe('clipPolygonToRect', () => {
  const square = [0, 0, 100, 0, 100, 100, 0, 100];

  it('leaves a polygon that already fits untouched', () => {
    expect(clipPolygonToRect(square, { x: -10, y: -10, w: 200, h: 200 })).toEqual(square);
  });

  it('returns nothing for a polygon wholly outside', () => {
    // Also what makes `fillClippedEllipse`'s fully-outside early return a pure FAST PATH rather than
    // a behaviour: a battery mutant that removes it survives, and this is the assertion that says the
    // survival is an equivalence and not a gap — the clipper answers empty either way, and an empty
    // polygon draws nothing.
    expect(clipPolygonToRect(square, { x: 500, y: 500, w: 10, h: 10 })).toEqual([]);
  });

  it('keeps a polygon whose edge lies exactly ON the clip boundary', () => {
    // The other battery survivor, and this one was a real (if narrow) defect rather than an
    // equivalence: `clipHalfPlane` keeps points where the signed distance is >= 0, and tightening
    // that to > 0 passed all 3,337 tests. It drops every vertex sitting exactly on the boundary
    // without adding an intersection to replace it, so a blob whose rim is coincident with its clip
    // rect degenerates below `fillClippedEllipse`'s three-point gate and vanishes instead of being
    // drawn whole. Float coordinates make that measure-zero in the shipped mottle, which is exactly
    // why nothing reached it — so the trigger is made reachable here rather than the guard relaxed.
    expect(clipPolygonToRect(square, { x: 0, y: 0, w: 100, h: 100 })).toEqual(square);
  });

  it('clamps every point of a crossing polygon into the rect', () => {
    const out = clipPolygonToRect(square, { x: 25, y: 25, w: 50, h: 50 });
    expect(out.length).toBeGreaterThanOrEqual(8);
    for (let i = 0; i < out.length; i += 2) {
      expect(out[i]!).toBeGreaterThanOrEqual(25 - 1e-9);
      expect(out[i]!).toBeLessThanOrEqual(75 + 1e-9);
      expect(out[i + 1]!).toBeGreaterThanOrEqual(25 - 1e-9);
      expect(out[i + 1]!).toBeLessThanOrEqual(75 + 1e-9);
    }
  });

  it('keeps the part that is inside, rather than merely staying inside', () => {
    // A clipper that returned the rect's own corners would pass the containment test above. This one
    // fails unless the SHAPE survives: a triangle poking into the rect stays a triangle, with the
    // area it actually shares.
    const tri = [0, 0, 100, 0, 0, 100];
    const out = clipPolygonToRect(tri, { x: -10, y: -10, w: 60, h: 200 });
    let area = 0;
    for (let i = 0; i < out.length; i += 2) {
      const j = (i + 2) % out.length;
      area += out[i]! * out[j + 1]! - out[j]! * out[i + 1]!;
    }
    expect(Math.abs(area / 2)).toBeGreaterThan(2000); // the triangle is 5000; the clip takes a corner off
    expect(Math.abs(area / 2)).toBeLessThan(5000);
  });

  it('insetRect never turns a rect inside out', () => {
    const r = insetRect({ x: 0, y: 0, w: 10, h: 40 }, 32);
    expect(r.w).toBeGreaterThanOrEqual(0);
    expect(r.h).toBeGreaterThanOrEqual(0);
    expect(r.x).toBe(5);
  });
});
