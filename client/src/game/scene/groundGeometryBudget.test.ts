/**
 * The ground stage's BATCH-POLICY ENVELOPE and its CULL, over real shipped maps.
 *
 * ## What this file was, and what changed on 2026-08-26
 *
 * `buildGroundLayer` mounts its overlay passes with `staticGraphics()`, which forces
 * `batchMode: 'batch'` and so overrides Pixi's 400-float auto-batch cutoff unconditionally. That
 * override is a *measured* trade, and `render/staticGraphics.ts`'s header states the content it was
 * measured on: **"a room's shared wall-shadow Graphics is ~24k floats, the floor's decal pass
 * ~50k"**, where forcing `batch` on `layers.ground`/`layers.shadow` bought -24 draw calls for
 * -0.08 ms.
 *
 * Nothing checked that the content stayed inside that envelope, and it had not. `arena_launch`
 * accumulated its per-room wash/mottle/decals into TWO whole-map `Graphics` of 284,966 and 265,566
 * floats, batched and submitted every frame however far away the camera was, on a layer measured at
 * **2.05 ms of a 4.3 ms arena GPU frame**. This file's first version gated that as a per-Graphics
 * budget with `arena_launch` pinned as a known-over-budget exemption.
 *
 * The change was not to draw less. It was to make what is drawn CULLABLE: the layer is now one piece
 * per room (per region, per door), each tagged with the rect it paints, and `groundCulling.ts`
 * switches the off-screen ones off once per frame from `FxController.updateCamera`. That split left
 * the geometry unchanged to the float — the sums below reproduced the pre-split browser census
 * exactly — so the exemption went not because the content shrank but because no single piece is
 * large any more.
 *
 * What that did and did not buy is recorded in `groundCulling.ts` and `perf/README.md`, and it is
 * not what the first version of this file predicted: the batcher packs 17x less vertex data, and the
 * GPU frame did not measurably move. So the bounds below are bounds on GEOMETRY, which is what they
 * always measured; none of them is evidence about milliseconds.
 *
 * **2026-08-27 changed that geometry on purpose**, for the first time since: `floorClip.ts` stops a
 * room's blobs painting outside the room, which took 19.9% of the layer's floats and 66% of what the
 * worst camera submits. The `REAL` block below is re-measured, and its own doc comment says which
 * numbers moved and which one deliberately did not. `floorClipCoverage.test.ts` owns the properties
 * the clip is FOR; this file still owns what the layer costs.
 *
 * ## The three bounds here, deliberately of different kinds
 *
 *  1. **A per-ROOM rate** (portable). These passes are painted per room, so the layer's total is
 *     `rooms x rate`. The rate is the part a 3-room dev fixture can still falsify, which makes it
 *     the bound that would have caught the original defect at authoring time.
 *  2. **A per-PIECE ceiling** (what the batch policy is about). Every mounted piece must stay inside
 *     the envelope `staticGraphics()` was measured on. Its control is that the map's TOTAL is still
 *     an order of magnitude past that ceiling — the per-piece pass must not be able to come from the
 *     content having got smaller.
 *  3. **What the CAMERA submits** (the property the fix created, and the one with no other reader).
 *     Swept over every room of every catalog map, through the real `FxController.updateCamera`. A
 *     regression that silently un-tagged the pieces, or mounted them as one Graphics again, leaves
 *     bounds (1) and (2) untouched and fails only here.
 *
 * Scope, stated rather than implied: the harness in the first half hands `buildGroundLayer` no
 * `wallRects`. Omitting them can only ADD floats (they suppress rubble — see `groundLayer.test.ts`'s
 * "keeps rubble off the wall footprints"), so those totals are an upper bound on the shipped one,
 * which is the safe direction for a budget. The second half drives the real `RoomBuilder`.
 */
import { describe, it, expect, vi } from 'vitest';
import { Container, Graphics, GraphicsContextSystem, Texture, TextureSource } from 'pixi.js';
import { createGameState } from '@dd/engine/state/GameState';
import { biomePalette } from '../theme';
import { buildGroundLayer, floorRegionsPx, roomRectsPx } from './groundLayer';
import { groundPieceBounds } from './groundCulling';
import { ARENA_CATALOG, type ArenaId } from '../match/arenaCatalog';
import { fpToPx, PX_PER_GRID } from '../coords';
import { AUTO_BATCH_VERTEX_LIMIT } from '../../perf/drawAttribution';
import { MAX_WALL_HEIGHT, type RectPx } from './wallGeometry';
import { Layers } from './layers';
import { Backdrop } from './Backdrop';
import { RoomBuilder } from './RoomBuilder';
import { FxController } from '../fx/FxController';

// The camera sweep below drives the REAL `FxController.updateCamera`, and its post-processing
// filters compile a GL program at construction — which needs a canvas this environment does not
// have. Stubbed exactly as `fx/FxController.test.ts` stubs them, and for the same reason: the shader
// is irrelevant to the camera math, and the alternative is mirroring the zoom rule in this file.
// `pixi.js` itself stays real apart from `BlurFilter` — `GraphicsContextSystem` is the whole point.
vi.mock('pixi.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('pixi.js')>()),
  BlurFilter: class { strength = 0; quality = 0; },
}));
// Spread over `vi.importActual` (the convention RoomBuilder.test.ts/wechatRoomBuild.test.ts
// already use here): only the filter CLASSES touch GL, while the module also exports plain
// values the scene layer reads — `SHELL_ASPECT`, the shield shell's screen aspect, which sizes
// `Actor`'s `filterArea`. Restating one of those in a mock would let it drift away from the
// shipped number, and a mock that must be edited every time the real module gains an export is
// its own trap: adding that one constant broke every test in this file.
vi.mock('../fx/filters', async () => ({
  ...(await vi.importActual<typeof import('../fx/filters')>('../fx/filters')),
  VignetteFilter: class { intensity = 0; radius = 0; },
  ChromaticAberrationFilter: class { amount: number; constructor(amount = 0) { this.amount = amount; } },
  MAX_SCENE_LIGHTS: 8,
  SceneLightFilter: class {
    setRegion() {}
    setLights() {}
  },
}));

/**
 * Per-PIECE ceiling for batch-forced ground geometry, in floats.
 *
 * Anchored to `staticGraphics.ts`'s own measurement (~50k for the floor's decal pass, where the
 * policy was a win) and rounded up to give authored content real room: this is "stay within an
 * order of the content this override was validated on", not a tuned optimum. It is deliberately NOT
 * transcribed from what any map scores today — the margin assertions below exist so nobody can
 * quietly retune it to whatever the content happens to be.
 */
const FLOOR_PASS_FLOAT_BUDGET = 64_000;

/**
 * Ceiling on what ONE camera may submit, in floats. Same anchor as the per-piece budget and the same
 * reasoning: a viewport's worth of floor should cost about what the whole floor cost back when the
 * batch policy was measured, not what a 60-room map's floor costs.
 */
const CAMERA_FLOAT_BUDGET = 128_000;

/** Side of the reference room the per-room rate below is measured at. */
const REF_ROOM_PX = 512;

/**
 * Floats per REF_ROOM_PX-square room, summed over the whole layer (measured 9,901-10,216 across
 * 1..60 of them).
 *
 * Scoped to that room size on purpose, because the rate is NOT room-invariant: the passes count
 * their blobs from room AREA (`Math.max(2, Math.round(area / MOTTLE_PX_PER_BLOB))` and friends), so
 * the same code yields ~10.0k floats for a 512px room and ~24.2k at 1024px. An earlier draft of this
 * file put a bare band here without scoping it and would have failed on any map authored with bigger
 * rooms while the real defect sailed through — the "informative bound measured on one body of
 * content" trap the 2026-08-26 batteries kept turning up. What gates the shipped content is the
 * two-sided pin on the real builder further down; this band only holds the COST MODEL (linear in
 * room count) in place.
 */
const PER_ROOM_FLOAT_BAND = { min: 7_000, max: 14_000 };

/** The viewport every camera sweep here is measured at — a desktop 16:9 window. */
const VIEWPORT = { vw: 1920, vh: 855 };

/** Pixi's real batching decision, driven by the smallest renderer it accepts — same fake as
 *  `staticGraphics.test.ts`, which is where that shape is justified. */
function contextSystem(): GraphicsContextSystem {
  const renderer = {
    uid: 1,
    limits: { maxBatchableTextures: 16 },
    gc: { addResourceHash: () => undefined, now: 0 },
  } as never;
  return new GraphicsContextSystem(renderer);
}

function tex(size: number): Texture {
  return new Texture({ source: new TextureSource({ width: size, height: size }) });
}

/** Floats in `node` and everything under it — the stamp's sprites live one level down inside their
 *  region's container, and a piece that stopped being a leaf must not fall out of the count. */
function floatsOf(node: Container, sys: GraphicsContextSystem): number {
  let n = node instanceof Graphics ? sys.updateGpuContext(node.context).geometryData.vertices.length : 0;
  for (const c of node.children) n += floatsOf(c, sys);
  return n;
}

/** Every Graphics under `node`, at any depth. */
function graphicsUnder(node: Container): Graphics[] {
  return node.children.flatMap((c) => [...(c instanceof Graphics ? [c] : []), ...graphicsUnder(c)]);
}

interface GroundGeometry {
  rooms: number;
  /** Floats per mounted PIECE (a top-level child of `ground`), largest first. */
  floats: number[];
  total: number;
  largest: number;
  /** True only if every mounted Graphics is batch-forced — otherwise a budget on them is a budget on
   *  nothing in particular. */
  allBatchForced: boolean;
  /** True only if every piece carries a cull rect — an untagged piece is resident forever. */
  allTagged: boolean;
}

/** `buildGroundLayer` over a set of room rects, measured through the real context system. */
function measure(
  rooms: readonly RectPx[],
  regions: readonly RectPx[],
  doorRects: readonly RectPx[] = [],
): GroundGeometry {
  const ground = new Container();
  buildGroundLayer(ground, {
    rooms: rooms as RectPx[],
    floorRegions: regions as RectPx[],
    wallRects: [],
    doorRects: doorRects as RectPx[],
    palette: biomePalette('ember'),
    floorTex: tex(256),
  });
  const sys = contextSystem();
  const floats = ground.children.map((c) => floatsOf(c, sys)).sort((a, b) => b - a);
  return {
    rooms: rooms.length,
    floats,
    total: floats.reduce((a, b) => a + b, 0),
    largest: floats[0] ?? 0,
    allBatchForced: graphicsUnder(ground).every((c) => c.context.batchMode === 'batch'),
    allTagged: ground.children.every((c) => groundPieceBounds(c) !== undefined),
  };
}

/** One catalog map, through the real producers a match resolves against. */
function measureArena(id: ArenaId): GroundGeometry {
  const map = ARENA_CATALOG[id];
  const state = createGameState({ seed: 1, worldW: 1, worldH: 1, waves: [], arena: map });
  const w = fpToPx(state.worldW);
  const h = fpToPx(state.worldH);
  // `passageGrid` is ABSOLUTE grid, unlike a room's `solids` — the same conversion `RoomBuilder`
  // does when it unions arena passages into the door list.
  const doorRects = map.doors.map((d) => ({
    x: d.passageGrid.x * PX_PER_GRID,
    y: d.passageGrid.y * PX_PER_GRID,
    w: d.passageGrid.w * PX_PER_GRID,
    h: d.passageGrid.h * PX_PER_GRID,
  }));
  return measure(roomRectsPx(state, w, h), floorRegionsPx(state, w, h), doorRects);
}

/**
 * The room counts every case below needs — 1, 4, 12, 30 and 60 rooms, some of them in more than one
 * case — used to mean a fresh `measure()` build at each count, four times over (the "grows linearly"
 * case alone summed to 107 rendered rooms). That was real work: v8 coverage instrumentation was
 * pushing the largest case's ~28s past vitest's 5s per-test default (found 2026-09-22, from a
 * coverage-leg-only timeout with the file's own room-render assertions unchanged — see the "grows
 * linearly" case below for what stays pinned).
 *
 * `buildGroundLayer`'s per-room passes (`drawRoomWash`/`drawFloorMottle`/`drawFloorDecals`/
 * `drawRoomLight`, and the region loop for the floor stamp and grid) each take only that one room's
 * own rect and a seed hashed off that room's own position — never a sibling room, never the total
 * count. So room i's five mounted pieces are byte-identical whether it is built alone or alongside
 * 59 others, and every count these tests want (1, 4, 12, 30, 60) is a PREFIX of the largest one.
 * Building once at 60 and slicing (`sliceSynthetic` below) cuts the describe block's total rendered
 * rooms from 192 (107 + 1 + 60 + 12 + 12) to 60.
 */
const SYNTHETIC_SERIES_N = 60;

/** Room rects for an N-room synthetic grid — shared by `buildSyntheticSeries` and the control test
 *  below it, so the two can never silently drift onto different layouts. */
function syntheticRoomRects(n: number, side = REF_ROOM_PX): RectPx[] {
  return Array.from({ length: n }, (_, i) => ({
    x: (i % 10) * (side + 88),
    y: Math.floor(i / 10) * (side + 88),
    w: side,
    h: side,
  }));
}

/** Ground layer geometry, unmeasured and unsorted, for `sliceSynthetic` to slice up. */
function buildSyntheticSeries(n: number, side = REF_ROOM_PX): { ground: Container; sys: GraphicsContextSystem } {
  const rooms = syntheticRoomRects(n, side);
  const ground = new Container();
  buildGroundLayer(ground, {
    rooms,
    floorRegions: rooms,
    wallRects: [],
    doorRects: [],
    palette: biomePalette('ember'),
    floorTex: tex(256),
  });
  return { ground, sys: contextSystem() };
}

/**
 * The first `k` rooms of an `n`-room `buildSyntheticSeries`, measured as `measure(rooms.slice(0, k),
 * ...)` would have measured them alone — see `SYNTHETIC_SERIES_N`'s comment for why that equivalence
 * holds. Relies on `buildGroundLayer`'s own mount order (its stage comments in groundLayer.ts): with
 * no doors, `ground.children` is five same-length groups — stamp, dark, light, grid, pool — each in
 * room order, so the first-`k`-of-each-group slice is exactly what a `k`-room build would mount.
 */
function sliceSynthetic(series: { ground: Container; sys: GraphicsContextSystem }, n: number, k: number): GroundGeometry {
  const { ground, sys } = series;
  const STAGES = 5;
  const children: Container[] = [];
  for (let stage = 0; stage < STAGES; stage++) {
    for (let i = 0; i < k; i++) children.push(ground.children[stage * n + i]!);
  }
  const floats = children.map((c) => floatsOf(c, sys)).sort((a, b) => b - a);
  const gfx = children.flatMap((c) => [...(c instanceof Graphics ? [c] : []), ...graphicsUnder(c)]);
  return {
    rooms: k,
    floats,
    total: floats.reduce((a, b) => a + b, 0),
    largest: floats[0] ?? 0,
    allBatchForced: gfx.every((c) => c.context.batchMode === 'batch'),
    allTagged: children.every((c) => groundPieceBounds(c) !== undefined),
  };
}

describe('the ground stage is painted PER ROOM, and that is what its cost scales with', () => {
  const series = buildSyntheticSeries(SYNTHETIC_SERIES_N);
  const slice = (k: number) => sliceSynthetic(series, SYNTHETIC_SERIES_N, k);

  it('grows linearly in room count, at a bounded per-room rate', () => {
    const counts = [1, 4, 12, 30, 60];
    const rates = counts.map((n) => {
      const m = slice(n);
      return { n, perRoom: m.total / n };
    });
    for (const { n, perRoom } of rates) {
      expect(perRoom, `${n} rooms`).toBeGreaterThan(PER_ROOM_FLOAT_BAND.min);
      expect(perRoom, `${n} rooms`).toBeLessThan(PER_ROOM_FLOAT_BAND.max);
    }
    // Linear, not merely monotonic: the rate must be flat across a 60x range in room count. A
    // per-room pass that started scaling super-linearly (say a decal pass that consulted every other
    // room) would keep every total under its budget on a small map and blow up on a big one.
    const perRoom = rates.map((r) => r.perRoom);
    expect(Math.max(...perRoom) / Math.min(...perRoom)).toBeLessThan(1.25);
  });

  it('is one piece per room per stage, so the LARGEST piece does not grow with the map', () => {
    // The inverse of what this test asserted before 2026-08-26, and the inversion is the fix. It
    // used to read "one whole-map Graphics per pass, so the total is the whole map every frame",
    // with `sixty.largest > one.largest * 40` — i.e. it pinned exactly the property that made the
    // layer uncullable. A 60x map now costs 60x the TOTAL and about 1x the largest piece.
    const one = slice(1);
    const sixty = slice(60);
    expect(sixty.total / one.total).toBeGreaterThan(40);
    expect(sixty.largest / one.largest).toBeLessThan(1.2); // measured 1.11
    expect(sixty.floats.length).toBe(one.floats.length * 60);
  });

  it('forces the batch on every piece it mounts — or these budgets are about nothing', () => {
    // If `staticGraphics()` stopped being used here, Pixi's own 400-float cutoff would apply and the
    // geometry would cost draw calls instead of a repack. Either is a real design, but the budgets
    // in this file are written for the batch-forced one.
    expect(slice(12).allBatchForced).toBe(true);
    expect(measureArena('arena_launch').allBatchForced).toBe(true);
    // ...and the pieces are still far past the auto cutoff, which is why the override is
    // load-bearing. Not EVERY piece: a door's worn patch is four ellipses and would batch on its own
    // merits, and after the split that is a real share of them.
    // ...and the two variation halves of every room are still far past the auto cutoff, which is
    // what keeps the override load-bearing. NOT every piece: after the split a grid (~120 floats)
    // and a light pool (288) would batch on their own merits, and so would a door's worn patch.
    const twelve = slice(12);
    const big = twelve.floats.filter((f) => f > AUTO_BATCH_VERTEX_LIMIT);
    expect(big).toHaveLength(24); // 12 rooms x {dark, light}
    expect(Math.min(...big)).toBeGreaterThan(AUTO_BATCH_VERTEX_LIMIT * 5);
  });

  it('tags every piece it mounts, or the cull silently leaves it resident', () => {
    expect(slice(12).allTagged).toBe(true);
    expect(measureArena('arena_launch').allTagged).toBe(true);
    expect(measureArena('landing_basic').allTagged).toBe(true);
  });

  it('the shared 60-room build matches a fresh build — the control for slicing instead of rebuilding', () => {
    // Every case above reads its geometry off `slice()`, i.e. off the ONE 60-room `series`, not off a
    // build of its own. This is the test that would fail if that shortcut were unsound: build 12 rooms
    // fresh, independently of `series`, and check the slice reports byte-identical geometry. It is the
    // property `SYNTHETIC_SERIES_N`'s comment claims (a room's pieces don't depend on its neighbours or
    // on the total room count) and the one `sliceSynthetic`'s group-offset arithmetic assumes (that
    // `buildGroundLayer`'s mount order is five same-length, room-ordered groups) — either breaking would
    // leave every other test in this describe block silently measuring the wrong thing, with nothing
    // here to catch it.
    const k = 12;
    const fresh = measure(syntheticRoomRects(k), syntheticRoomRects(k));
    const sliced = slice(k);
    expect(sliced.total).toBe(fresh.total);
    expect(sliced.largest).toBe(fresh.largest);
    expect(sliced.floats).toEqual(fresh.floats);
    expect(sliced.allBatchForced).toBe(fresh.allBatchForced);
    expect(sliced.allTagged).toBe(fresh.allTagged);
  });
});

describe('every catalog map stays inside the envelope staticGraphics() was measured on', () => {
  const ids = Object.keys(ARENA_CATALOG) as ArenaId[];

  it('sweeps the whole catalog, not a hand-picked subset', () => {
    expect(ids).toContain('arena_launch');
    expect(ids.length).toBeGreaterThanOrEqual(2);
  });

  for (const id of ids) {
    it(`${id}: every ground piece is under the budget, with margin`, () => {
      const m = measureArena(id);
      expect(m.largest).toBeLessThan(FLOOR_PASS_FLOAT_BUDGET);
      // State the margin, so a map that creeps up on the budget is visible as a shrinking number
      // here rather than as a still-passing test.
      expect(FLOOR_PASS_FLOAT_BUDGET / m.largest).toBeGreaterThan(2);
    });
  }

  it('...and on the big map that is NOT because the content got smaller', () => {
    // The control for the sweep above, and the replacement for the `OVER_BUDGET` exemption this file
    // used to carry: `arena_launch` still paints an order of magnitude more floor than the per-piece
    // budget. A version of `buildGroundLayer` that quietly stopped drawing four fifths of the floor
    // would pass every per-piece assertion above and fail here.
    const m = measureArena('arena_launch');
    expect(m.total / FLOOR_PASS_FLOAT_BUDGET).toBeGreaterThan(7); // measured 7.41 (9.0 pre-clip)
    expect(m.total / m.largest).toBeGreaterThan(50); // spread over ~98 pieces' worth
  });

  it('the smallest catalog map cannot reach the budget, so its pass is not evidence', () => {
    // Honest about what a green `landing_basic` proves: 3 rooms, largest piece 4,528, ~14x under the
    // per-piece budget. The per-room rate above and the camera sweep below are the bounds that
    // actually cover it; this asserts the limitation rather than leaving it implied.
    const m = measureArena('landing_basic');
    expect(m.largest * 10).toBeLessThan(FLOOR_PASS_FLOAT_BUDGET);
  });
});

/** The camera rect `GameLoop.cameraFrame` hands `updateCamera` for a room — its rect grown upward by
 *  the tallest a wall can be, so the north wall's cap is not pushed off the top of the viewport.
 *  Mirrored here (four lines, and `cameraFrame` is private) but the ZOOM and the cull that follow it
 *  are the real `FxController`, which is the half this file is measuring. */
function cameraFrameOf(room: RectPx): RectPx {
  return { x: room.x, y: room.y - MAX_WALL_HEIGHT, w: room.w, h: room.h + MAX_WALL_HEIGHT };
}

interface Shot {
  zoom: number;
  visible: number;
  submitted: number;
}

/** Walk one catalog map room by room with the real camera, and report what each stop submits. */
function cameraSweep(id: ArenaId): { shots: Shot[]; total: number; pieces: number } {
  const layers = new Layers();
  const rb = new RoomBuilder(layers, new Backdrop(layers));
  const state = createGameState({ seed: 1, worldW: 1, worldH: 1, waves: [], arena: ARENA_CATALOG[id] });
  rb.build(state);
  const fx = new FxController(layers);
  const sys = contextSystem();
  const world = { w: fpToPx(state.worldW), h: fpToPx(state.worldH) };
  const rooms = roomRectsPx(state, world.w, world.h);
  const total = layers.ground.children.reduce((a, c) => a + floatsOf(c, sys), 0);
  const shots = rooms.map((room) => {
    const at = { x: room.x + room.w / 2, y: room.y + room.h / 2 };
    fx.updateCamera(1, VIEWPORT, world, { interpGroundX: () => at.x, interpGroundY: () => at.y }, cameraFrameOf(room));
    const submitted = layers.ground.children
      .filter((c) => !c.culled)
      .reduce((a, c) => a + floatsOf(c, sys), 0);
    return { zoom: fx.zoom, visible: fx.visibleGroundPieces, submitted };
  });
  return { shots, total, pieces: layers.ground.children.length };
}

describe('what ONE camera submits — the property the per-room split exists for', () => {
  for (const id of Object.keys(ARENA_CATALOG) as ArenaId[]) {
    it(`${id}: every room's camera stays inside the camera budget, with margin`, () => {
      const { shots, total } = cameraSweep(id);
      expect(shots.length).toBeGreaterThan(0);
      const worst = Math.max(...shots.map((s) => s.submitted));
      expect(worst).toBeLessThan(CAMERA_FLOAT_BUDGET);
      expect(CAMERA_FLOAT_BUDGET / worst).toBeGreaterThan(1.5);
      // Every stop draws SOMETHING: a cull that switched the floor off entirely would sail through a
      // ceiling, and this is the direction a bad `groundPieceBounds` fails in.
      expect(Math.min(...shots.map((s) => s.submitted))).toBeGreaterThan(total / 100);
      expect(Math.min(...shots.map((s) => s.visible))).toBeGreaterThan(0);
    });
  }

  it('arena_launch: the camera sees a fraction of the map, and the fraction is the win', () => {
    const { shots, total, pieces } = cameraSweep('arena_launch');
    const submitted = shots.map((s) => s.submitted).sort((a, b) => a - b);
    const median = submitted[submitted.length >> 1]!;
    expect(pieces).toBe(374); // 60 stamps + 60 dark + 60 light + 74 door patches + 60 grids + 60 pools
    expect(shots).toHaveLength(60);
    // ~8.5% of the layer at the median stop, ~13% at the worst — and it is 100% without the cull.
    expect(median / total).toBeLessThan(0.1);
    expect(submitted[submitted.length - 1]! / total).toBeLessThan(0.15);
    // The camera really is zoomed into a room rather than looking at the whole map, or the fraction
    // above would be a statement about the viewport and not about the cull.
    expect(Math.max(...shots.map((s) => s.zoom))).toBeGreaterThan(3);
  });

  it('a camera over the whole map submits ALL of it — nothing is permanently hidden', () => {
    // The cull's own control, in the other direction. Every assertion above passes for a
    // `groundPieceBounds` that returned a zero-size rect for everything, and this is the one that
    // does not: pull the camera back far enough and the whole layer must come back.
    const layers = new Layers();
    const rb = new RoomBuilder(layers, new Backdrop(layers));
    const state = createGameState({ seed: 1, worldW: 1, worldH: 1, waves: [], arena: ARENA_CATALOG.arena_launch });
    rb.build(state);
    const fx = new FxController(layers);
    const sys = contextSystem();
    const world = { w: fpToPx(state.worldW), h: fpToPx(state.worldH) };
    const total = layers.ground.children.reduce((a, c) => a + floatsOf(c, sys), 0);
    // A viewport twice the world's size, from each corner and the middle: `updateCamera` clamps its
    // pan to the world, so the union of those five stops has to be every piece there is.
    const seen = new Set<Container>();
    const stops = [
      { x: 0, y: 0 },
      { x: world.w, y: 0 },
      { x: 0, y: world.h },
      { x: world.w, y: world.h },
      { x: world.w / 2, y: world.h / 2 },
    ];
    for (const at of stops) {
      fx.updateCamera(1, { vw: world.w * 2, vh: world.h * 2 }, world,
        { interpGroundX: () => at.x, interpGroundY: () => at.y }, null);
      for (const c of layers.ground.children) if (!c.culled) seen.add(c);
    }
    expect(seen.size).toBe(layers.ground.children.length);
    expect([...seen].reduce((a, c) => a + floatsOf(c, sys), 0)).toBe(total);
  });
});

/**
 * Pinned from the REAL `RoomBuilder.build` on `arena_launch`. Re-measured 2026-08-27 for the room
 * CLIP (`floorClip.ts`), which is the first deliberate change to this geometry since the numbers
 * were first taken.
 *
 * **What these numbers used to mean, and what they mean now.** Until 2026-08-27 they reproduced the
 * pre-split live browser `census()` of the same map EXACTLY (284,966 additive / 265,566 multiply on
 * ground, 49,392 on shadow) — that identity is what said the 2026-08-26 per-room split moved
 * geometry between display objects without changing a single vertex of it. The clip then removed the
 * blob spill that reached up to 460 px outside every room: **-19.9% of the layer's floats**
 * (284,966 -> 228,052 additive, 289,726 -> 232,318 rest), and -66% of what the worst camera submits.
 * So the split's byte-identity is now history rather than a live assertion, and what is live is the
 * pin itself. `shadowLargest` is UNCHANGED at 49,392, which is the control: the clip is not allowed
 * to touch a layer it does not draw on.
 */
const REAL = {
  /** Everything additive: every room's mottle-light + rubble highlights, plus every door's worn
   *  patch. 284,966 before the room clip. */
  additive: 228_052,
  /** Everything else on the layer: the dark half, the fallback flat fill this headless build gets in
   *  place of a stamped swatch (480), the grid (6,400) and the light pools (17,280). 289,726 before
   *  the room clip. */
  rest: 232_318,
  total: 460_370,
  /** Largest single piece, and the worst any one camera submits. 5,840 / 76,646 before the clip. */
  largestPiece: 5_558,
  worstCamera: 26_150,
  /** Unchanged by the clip, on purpose — see the note above. */
  shadowLargest: 49_392,
  /** `staticGraphics.ts`'s stated envelope for the wall-shadow pass, for comparison. */
  shadowMeasuredAt: 24_000,
};

/**
 * The pins above are EXACT, not banded, and that is a deliberate choice with a cost.
 *
 * Deterministic pipeline, fixed seed, fixed authored map: these integers reproduced byte-identically
 * across runs and matched the live browser `census()` exactly, so there is no noise for a tolerance
 * to absorb — a tolerance only decides how much silent drift is allowed through. A 2% band was tried
 * first and a battery walked `drawRoomWash` deletion straight past it: removing that pass moves the
 * multiply half by 480 floats, **0.18%**, which is exactly the size of change a band is worst at
 * seeing. Nothing else in the suite noticed it either.
 *
 * So: if you changed the floor art on purpose, re-measure and update these numbers in the SAME
 * commit as the art change. That is the intended workflow, the same one `arenaWallCoverage.test.ts`
 * uses for its 294/124/74 counts and `checkFileLength` uses for its baseline — the test is here to
 * make a geometry change visible, not to hold the art still.
 */

/** Every batch-forced Graphics on one layer of a real build, floats descending. */
function layerFloats(layer: Container, sys: GraphicsContextSystem): number[] {
  return graphicsUnder(layer)
    .map((c) => sys.updateGpuContext(c.context).geometryData.vertices.length)
    .sort((a, b) => b - a);
}

describe('the REAL builder, not the mirror in this file', () => {
  // Every case in the first half calls `buildGroundLayer` directly with rects this file assembles.
  // That is a MIRROR of the pipeline, and 2026-08-26 is the day this repo learned what that costs: a
  // door-clip fix was verified against a harness that mirrored `RoomBuilder.build`'s sequence,
  // scored perfectly, and the shipping code did nothing at all. So the aggregate is also read back
  // off the real call site.
  const built = (() => {
    const layers = new Layers();
    const rb = new RoomBuilder(layers, new Backdrop(layers));
    const state = createGameState({ seed: 1, worldW: 1, worldH: 1, waves: [], arena: ARENA_CATALOG.arena_launch });
    rb.build(state);
    const sys = contextSystem();
    const gfx = graphicsUnder(layers.ground);
    const sum = (list: Graphics[]): number =>
      list.reduce((a, c) => a + sys.updateGpuContext(c.context).geometryData.vertices.length, 0);
    return {
      pieces: layers.ground.children.map((c) => floatsOf(c, sys)).sort((a, b) => b - a),
      additive: sum(gfx.filter((c) => c.blendMode === 'add')),
      rest: sum(gfx.filter((c) => c.blendMode !== 'add')),
      shadow: layerFloats(layers.shadow, sys),
    };
  })();

  it('ground: the shipped geometry, to the float', () => {
    // Identified by BLEND MODE rather than by child index, so this keeps measuring the same two
    // halves however the pieces are ordered — and both are pinned, because an earlier draft bounded
    // only the larger one and a battery then showed three mutants walking straight through it (a
    // doubled stain density, a doubled mottle density, and `drawRoomWash` deleted outright, all of
    // which land on the multiply half).
    expect(built.additive).toBe(REAL.additive);
    expect(built.rest).toBe(REAL.rest);
    expect(built.additive + built.rest).toBe(REAL.total);
  });

  it('ground: no piece of it is large any more, and that is not because there is less of it', () => {
    expect(built.pieces[0]).toBe(REAL.largestPiece);
    expect(built.pieces).toHaveLength(374);
    expect(built.pieces[0]!).toBeLessThan(FLOOR_PASS_FLOAT_BUDGET);
    // The total is still 7x the per-piece budget — see the sweep's control above for why that
    // matters. Stated as a margin rather than as a second copy of the number. It was 9x before the
    // 2026-08-27 room clip took 19.9% of the layer's floats out; the bound moved with the measured
    // content and not to whatever the content happens to be, and it is still the assertion that
    // fails if `buildGroundLayer` ever quietly stops drawing most of the floor (that would read
    // ~1.8x, not 7).
    expect(REAL.total / FLOOR_PASS_FLOAT_BUDGET).toBeGreaterThan(7);
  });

  it('ground: the worst camera on the map, pinned', () => {
    const { shots } = cameraSweep('arena_launch');
    expect(Math.max(...shots.map((s) => s.submitted))).toBe(REAL.worstCamera);
    // And the margin to the budget, so nobody can transcribe the score into the budget later.
    expect(CAMERA_FLOAT_BUDGET / REAL.worstCamera).toBeGreaterThan(1.5);
    expect(REAL.worstCamera / REAL.total).toBeLessThan(0.15);
  });

  it('shadow: inside the budget, but recorded against the envelope it was measured at', () => {
    // Not a defect today, and the reason to pin it anyway: it is the SAME drift ground's was, two
    // doublings behind, and it is NOT covered by the split above — `wallRender`'s shadows are still
    // one shared Graphics per floor. `staticGraphics.ts` measured this pass at ~24k; the arena runs
    // it at ~49k, resident every frame.
    expect(built.shadow[0]).toBe(REAL.shadowLargest);
    expect(built.shadow[0]).toBeLessThan(FLOOR_PASS_FLOAT_BUDGET);
    expect(built.shadow[0]).toBeGreaterThan(REAL.shadowMeasuredAt); // ~2x, stated rather than implied
    // One shared context plus many small per-entity ones: a change that made them all large would
    // multiply the repack cost without moving the max.
    expect(built.shadow.length).toBeGreaterThan(100);
    expect(built.shadow[1]!).toBeLessThan(built.shadow[0] / 10);
  });

  it('every arena room yields the SAME mottle count under a halved density constant', () => {
    // Not a budget assertion — a content one, and the only mutant this file could not kill.
    // Halving `MOTTLE_PX_PER_BLOB` (260,000 -> 130,000) leaves `arena_launch` byte-identical. That
    // looked like a test gap and is not: the count is `Math.max(2, Math.round(area / PX_PER_BLOB))`,
    // and across all 60 rooms (82,944 to 286,720 px, median 143,360) BOTH constants land on 2 — the
    // small rooms clamp to the floor, and even the two rooms over 260,000 px round 2.21 back down to
    // 2. That constant's comment promises "~one blob per 510x510 of floor"; on this map it never gets
    // to mean anything, and the mottle is a flat 2 blobs per polarity per room regardless of size.
    //
    // Asserted as the exact equivalence rather than as a bound, so the next battery finds the answer
    // here instead of re-deriving it, and so a map authored with rooms big enough to leave the floor
    // shows up as a visible change.
    const state = createGameState({ seed: 1, worldW: 1, worldH: 1, waves: [], arena: ARENA_CATALOG.arena_launch });
    const rooms = roomRectsPx(state, fpToPx(state.worldW), fpToPx(state.worldH));
    const MOTTLE_PX_PER_BLOB = 260_000; // mirrored from floorRender.ts, deliberately
    const count = (area: number, per: number) => Math.max(2, Math.round(area / per));
    const counts = rooms.map((r) => count(r.w * r.h, MOTTLE_PX_PER_BLOB));
    const halved = rooms.map((r) => count(r.w * r.h, MOTTLE_PX_PER_BLOB / 2));
    expect(rooms).toHaveLength(60);
    expect(counts).toEqual(halved);
    expect(new Set(counts)).toEqual(new Set([2]));
  });

  it('the mirror in this file still mirrors — above the real number, and close to it', () => {
    // The check that fails the day `buildGroundLayer` gains a step the harness does not model.
    // Direction is asserted, not just closeness: the harness omits `wallRects`, which suppress
    // rubble, so it must come out slightly HIGHER. A harness that drifted BELOW the real number
    // would mean it is missing a pass, which is the failure that hid the door-clip fix.
    const harness = measureArena('arena_launch').total;
    expect(harness).toBeGreaterThanOrEqual(REAL.total);
    expect(harness / REAL.total).toBeLessThan(1.1);
  });
});
