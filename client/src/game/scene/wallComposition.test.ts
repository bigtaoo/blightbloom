/// <reference types="node" />
/**
 * Composition invariants over every wall of every SHIPPED level-1 room, plus the one
 * cross-layer check that the corner treatment depends on: that `FACE_CROWN_FRACTION` still
 * describes the real `wallface_<element>.png` on disk.
 *
 * **WHY THIS FILE EXISTS.** One wall — `ember_l1_cell`'s west perimeter run — was reported wrong
 * four times in a row on 2026-08-19, and every round shipped a green suite. The tests written each
 * round were not wrong, they were the wrong *class*: `wallRender.test.ts` and `wallRuns.test.ts`
 * pin one block, or one pair of hand-written rects, against numbers chosen by the same person who
 * had just chosen them in the source. Neither file can answer the questions the reports were
 * actually about:
 *
 *   - does every north-south run in the SHIPPED content actually get the corner treatment, or does
 *     some tier/merge/width condition silently disqualify most of it? (This repo has already
 *     shipped that exact bug once: `wallGeometry`'s old `w > h` guard left 1 wall standing where
 *     32 should, because level-1's rooms are almost entirely `w <= h`.)
 *   - do the pieces still tile the plane — no hole where a clip removed art nobody else draws, no
 *     wall announcing an edge in the middle of a continuous surface?
 *   - is the constant that places the clip line still true of the art it was measured from?
 *
 * So: real floors through the real pipeline (`placeAuthoredFloor` → `buildFloorGeometry` →
 * `wallTier` → `mergeWallRuns` → `wallJoins`, which is RoomBuilder's own sequence), assertions
 * about RELATIONSHIPS between blocks rather than restated coordinates, and one assertion that
 * reads actual PNG pixels. Every check here is mutation-verified — see the counts in
 * design/01-rendering.md's "a deep run TUCKS" entry.
 *
 * Deliberately NOT here: whether the result LOOKS right. That needs a live frame and a luma
 * sample; the numbers from those rounds live in design/01. These are the strongest checks that
 * survive in a canvas-free vitest run.
 */
import { describe, it, expect } from 'vitest';
import { Graphics, GraphicsContextSystem, Texture, TextureSource, TilingSprite } from 'pixi.js';
import { readdirSync, readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import {
  EMBER_L1_FLOORS,
  EMBER_L1_ROOMS,
  buildFloorGeometry,
  placeAuthoredFloor,
  toFpGrid,
  type RoomPiece,
} from '@dd/engine';
import { fpToPx } from '../coords';
import { WALL_H_KERB, wallHeight, wallTier, type RectPx } from './wallGeometry';
import { mergeWallRuns, wallJoins, type WallJoins, type WallRun } from './wallRuns';
import {
  BASE_AO_MAX,
  CAP_GRADIENT_MAX,
  FACE_COPING_SUPPRESS,
  FACE_CROWN_FRACTION_MIN,
  FACE_CROWN_ROWS,
  LIT_EDGE_COLOR,
  SIDE_COLOR,
  faceCrownFraction,
} from './wallTone';
import { buildWallBlock, drawBlockShading, FACE_BASE_LABEL, type WallSkin } from './wallRender';
import { XRAY_DEEP_LABEL, XRAY_LABEL } from './occlusion';
import { biomePalette } from '../theme';

/** A skin with both swatches present, at the shipped art's own pixel sizes. */
function texturedSkin(): WallSkin {
  return {
    palette: biomePalette('ember'),
    cap: new Texture({ source: new TextureSource({ width: 256, height: 256 }) }),
    face: new Texture({ source: new TextureSource({ width: 256, height: 128 }) }),
  };
}

/** The degraded path: neither swatch loaded, so every surface falls back to palette Graphics. */
function bareSkin(): WallSkin {
  return { palette: biomePalette('ember'), cap: undefined, face: undefined };
}
import { AUTO_BATCH_VERTEX_LIMIT } from '../../perf/drawAttribution';
import { readRampFill, resetShadeRampCache, shadeRampCacheSize } from '../../render/shadeRamp';
import { voidEdges, type VoidEdges } from './wallVoidEdge';
import { VOID_RETURN_PX } from './wallTone';

/** One floor, taken all the way through the sequence `RoomBuilder.build` uses. */
interface Floor {
  index: number;
  runs: WallRun[];
  joins: WallJoins[];
  /** The floor's room rects, the same ones `wallTier` was given — needed by the checks that ask
   *  where a run stands relative to the rooms around it, not just to its neighbouring blocks. */
  rooms: RectPx[];
  /** Per merged run, index-aligned with `runs`: which of its east/west sides end at nothing.
   *  A dungeon floor paints floor exactly at its room rects (`groundLayer.floorRegionsPx`), so
   *  `rooms` IS the floor model here — unlike an arena, where the two can diverge. */
  voids: VoidEdges[];
}

const FLOOR_INDICES = Object.keys(EMBER_L1_FLOORS).map(Number);

function buildFloor(index: number): Floor {
  const map = EMBER_L1_FLOORS[index]!;
  const { placed, doors } = placeAuthoredFloor(map, EMBER_L1_ROOMS as readonly RoomPiece[]);
  const geo = buildFloorGeometry(placed, doors);
  const roomsPx: RectPx[] = placed.map((r) => ({
    x: fpToPx(toFpGrid(r.offsetXGrid)),
    y: fpToPx(toFpGrid(r.offsetYGrid)),
    w: fpToPx(toFpGrid(r.piece.sizeGrid.w)),
    h: fpToPx(toFpGrid(r.piece.sizeGrid.h)),
  }));
  const runs = mergeWallRuns(
    geo.walls.map((wall) => {
      const rect: RectPx = { x: fpToPx(wall.x), y: fpToPx(wall.y), w: fpToPx(wall.w), h: fpToPx(wall.h) };
      return { rect, tier: wallTier(rect, roomsPx) };
    }),
  );
  // Level 1 is the ember biome, so its corners are placed with fire's crown line — the same
  // per-element lookup `RoomBuilder` does. Passing the default here would test a floor the
  // game never draws.
  const rects = runs.map((run) => run.rect);
  return {
    index,
    runs,
    joins: wallJoins(runs, faceCrownFraction('fire')),
    rooms: roomsPx,
    voids: rects.map((rect) => voidEdges(rect, rects, roomsPx)),
  };
}

const FLOORS: Floor[] = FLOOR_INDICES.map(buildFloor);

/** The screen-y band a block's art occupies, in world px: `[top, bottom]`. Mirrors
 *  `buildWallBlock` exactly — cap top (clipped when tucking) down to the footprint's south edge. */
function artBand(run: WallRun, joins: WallJoins): [number, number] {
  const h = wallHeight(run.tier);
  const south = run.rect.y + run.rect.h;
  const top = joins.tuckNorth
    ? south + Math.min(-h, -run.rect.h - joins.tuckLiftPx)
    : run.rect.y - h;
  return [top, south];
}

const overlapsX = (a: RectPx, b: RectPx): boolean =>
  Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 0.75;

describe('shipped level-1 walls — the content actually reaches the code', () => {
  it('places all five floors with walls to draw', () => {
    expect(FLOORS).toHaveLength(5);
    for (const f of FLOORS) expect(f.runs.length).toBeGreaterThan(10);
  });

  it('gives EVERY floor deep north-south runs, and tucks all of them', () => {
    // The regression this repo has already shipped once, in the other direction: a condition that
    // reads as a reasonable special case in the source and turns out to disqualify nearly all of
    // the real content. A deep run (`h > its own height`) whose north edge is fully buried MUST
    // tuck — if a future merge/tier change stops producing those, this fails loudly instead of the
    // corners quietly going back to overlapping.
    for (const f of FLOORS) {
      const deep = f.runs.filter((r, i) => r.rect.h > wallHeight(r.tier) && f.joins[i]!.north.length > 0);
      expect(deep.length, `floor ${f.index} has deep runs meeting a wall`).toBeGreaterThan(0);
      const tucked = f.runs.filter((_, i) => f.joins[i]!.tuckNorth);
      expect(tucked.length, `floor ${f.index} tucks them`).toBeGreaterThan(0);
    }
  });

  it('finds a real L corner on every floor — a run whose whole north edge is buried', () => {
    for (const f of FLOORS) {
      const corners = f.joins.filter((j) => j.tuckNorth && j.tuckLiftPx > 0);
      expect(corners.length, `floor ${f.index}`).toBeGreaterThan(0);
    }
  });
});

describe('shipped level-1 walls — every block agrees with its neighbours', () => {
  it('never lets a clip open a hole: the neighbour that authorised a tuck covers the band', () => {
    // The whole safety argument for clipping, checked against real geometry rather than proved on
    // paper. A tuck removes the band `[r.y - height, r.y - height + lift']`; the neighbour that
    // authorised it must already paint every pixel of it, or the floor shows through the corner.
    let checked = 0;
    for (const f of FLOORS) {
      f.runs.forEach((run, i) => {
        const joins = f.joins[i]!;
        if (!joins.tuckNorth) return;
        const [clippedTop] = artBand(run, joins);
        const fullTop = run.rect.y - wallHeight(run.tier);
        expect(clippedTop).toBeGreaterThan(fullTop); // something WAS removed
        const covered = f.runs.some((other, j) => {
          if (other === run || !overlapsX(other.rect, run.rect)) return false;
          if (Math.abs(other.rect.y + other.rect.h - run.rect.y) > 0.75) return false;
          const [oTop, oBottom] = artBand(other, f.joins[j]!);
          return oTop <= fullTop + 0.001 && oBottom >= clippedTop - 0.001;
        });
        expect(covered, `floor ${f.index} run at ${run.rect.x},${run.rect.y}`).toBe(true);
        checked++;
      });
    }
    expect(checked, 'tucked runs actually exercised').toBeGreaterThan(10);
  });

  it('never lets a tucked run cross its neighbour\'s CROWN course', () => {
    // The line the fourth report was about. The run may cover every brick course of the wall it
    // meets and none of its crown, because the crown is the unbroken horizontal the eye reads a
    // back wall by. Asserted against each neighbour's OWN height, not a constant.
    for (const f of FLOORS) {
      f.runs.forEach((run, i) => {
        const joins = f.joins[i]!;
        if (!joins.tuckNorth) return;
        const [top] = artBand(run, joins);
        for (const [j, other] of f.runs.entries()) {
          if (other === run || !overlapsX(other.rect, run.rect)) continue;
          if (Math.abs(other.rect.y + other.rect.h - run.rect.y) > 0.75) continue;
          if (wallHeight(other.tier) < wallHeight(run.tier)) continue;
          void j;
          const oh = wallHeight(other.tier);
          const crownUnderside = run.rect.y - oh + oh * faceCrownFraction('fire');
          expect(top).toBeGreaterThanOrEqual(crownUnderside - 0.001); // stops at or below it
          // ...and still covers brick: it must reach ABOVE that wall's foot.
          expect(top).toBeLessThan(run.rect.y - 0.001);
        }
      });
    }
  });

  it('routes every south-edge join to exactly one of `south` / `tuckedSouth`', () => {
    // Buried folds get masked, exposed ones get creased, and a join in both lists (or in neither)
    // means one of the two treatments is being applied to the wrong corner.
    for (const f of FLOORS) {
      f.runs.forEach((run, i) => {
        const joins = f.joins[i]!;
        const spans = [...joins.south, ...joins.tuckedSouth];
        for (const [a, b] of spans) {
          expect(b).toBeGreaterThan(a);
          expect(a).toBeGreaterThanOrEqual(-0.001);
          expect(b).toBeLessThanOrEqual(run.rect.w + 0.001);
        }
        for (const [a, b] of joins.south) {
          for (const [c, d] of joins.tuckedSouth) {
            expect(Math.min(b, d) - Math.max(a, c), `floor ${f.index} overlapping join`).toBeLessThanOrEqual(0.75);
          }
        }
      });
    }
  });

  it('reports a join only where a TALL ENOUGH neighbour really touches', () => {
    let joins = 0;
    for (const f of FLOORS) {
      f.runs.forEach((run, i) => {
        for (const [a, b] of f.joins[i]!.north) {
          expect(a).toBeGreaterThanOrEqual(-0.001);
          expect(b).toBeLessThanOrEqual(run.rect.w + 0.001);
          const mid = run.rect.x + (a + b) / 2;
          // Two invariants, because a join is only ever a licence to delete a cue: something must
          // actually be there, and it must be at least as TALL as this block.
          const toucher = f.runs.find((o) =>
            o !== run &&
            Math.abs(o.rect.y + o.rect.h - run.rect.y) <= 0.75 &&
            mid >= o.rect.x - 0.75 && mid <= o.rect.x + o.rect.w + 0.75 &&
            wallHeight(o.tier) >= wallHeight(run.tier));
          expect(toucher, `floor ${f.index} north join with no tall enough neighbour`).toBeDefined();
          joins++;
        }
      });
    }
    expect(joins, 'north joins actually exercised').toBeGreaterThan(10);
  });

  it("leaves a SHORTER neighbour's step alone, on real content", () => {
    // Floor 1 stacks a room's low south kerb directly north of the next room's full-height north
    // wall. A kerb cannot bury that wall's edge, so the wall must report no join there — this is the
    // pairing that makes the height filter load-bearing rather than defensive, and the unit test
    // next door only ever sees it on hand-written rects.
    let pairs = 0;
    for (const f of FLOORS) {
      f.runs.forEach((run, i) => {
        for (const other of f.runs) {
          if (other === run || !overlapsX(other.rect, run.rect)) continue;
          if (Math.abs(other.rect.y + other.rect.h - run.rect.y) > 0.75) continue;
          if (wallHeight(other.tier) >= wallHeight(run.tier)) continue;
          pairs++;
          const buried = f.joins[i]!.north.some(([a, b]) => {
            const lo = Math.max(run.rect.x + a, other.rect.x);
            const hi = Math.min(run.rect.x + b, other.rect.x + other.rect.w);
            return hi - lo > 0.75;
          });
          expect(buried, `floor ${f.index} short neighbour buried an edge`).toBe(false);
        }
      });
    }
    expect(pairs, 'short-northern-neighbour pairs exist in the shipped content').toBeGreaterThan(0);
  });

  it('leaves a kerb\'s neighbour alone — no tier ever inherits another\'s height', () => {
    // `mergeWallRuns` refuses cross-tier merges so a room's low south kerb cannot inherit the
    // perimeter height of the room beyond it. Re-checked here on real content, because the joins
    // pass runs through a SECOND height comparison and a sign error there would undo it.
    for (const f of FLOORS) {
      const kerbs = f.runs.filter((r) => r.tier === 'kerb');
      expect(kerbs.length, `floor ${f.index} has kerbs`).toBeGreaterThan(0);
      for (const k of kerbs) expect(wallHeight(k.tier)).toBeLessThan(wallHeight('perimeter'));
    }
  });
});

describe('shipped level-1 walls — nothing tall stands on the floor of the room to its north', () => {
  /** One boundary between two vertically stacked rooms: `above`'s south bound IS `below`'s north
   *  bound, and the two overlap horizontally. */
  interface Boundary {
    above: RectPx;
    below: RectPx;
    /** World y of the shared bound — `above.y + above.h`. */
    at: number;
    /** The x range the two rooms share, which is the only part of the boundary either owns. */
    x0: number;
    x1: number;
  }

  /**
   * Every stacked-room boundary on this floor, enumerated from the ROOM RECTS.
   *
   * Deriving it from the rooms rather than from the runs is the whole point, and the first
   * version of this file got it wrong: keyed off "a run whose north edge is a room's south
   * bound", the three boundaries whose two halves MERGE into one 64 px-deep kerb (floor 2
   * `r5_bastion`, floor 3 `r3_crucible`, floor 4 `r5_boss`) matched no run at all and were
   * silently skipped — the check passed on the other four and looked green. Rooms cannot merge,
   * so a boundary counted here cannot disappear because the drawing changed.
   */
  function boundaries(f: Floor): Boundary[] {
    const out: Boundary[] = [];
    for (const above of f.rooms) {
      for (const below of f.rooms) {
        if (above === below) continue;
        if (Math.abs(above.y + above.h - below.y) > 0.75) continue;
        const x0 = Math.max(above.x, below.x);
        const x1 = Math.min(above.x + above.w, below.x + below.w);
        if (x1 - x0 <= 0.75) continue; // side by side, touching at a corner only
        out.push({ above, below, at: above.y + above.h, x0, x1 });
      }
    }
    return out;
  }

  /** Where `room`'s walkable floor stops, read out of the content: the north edge of whatever
   *  the floor actually draws along that room's south bound. Never assumed to be one grid row: as
   *  of `ENGINE_VERSION` 44 every wall in the shipped content is a full 32 px deep, but four of them
   *  were 16 until that day (see ROADMAP "The 16 px wall runs"), and a hand-authored piece can put
   *  a shallower solid on a room's south edge without anything here noticing. */
  function floorLimit(f: Floor, b: Boundary): number {
    const band = f.runs.filter((r) =>
      Math.min(r.rect.x + r.rect.w, b.x1) - Math.max(r.rect.x, b.x0) > 0.75
      && r.rect.y < b.at - 0.75 && r.rect.y + r.rect.h > b.at - 0.75);
    expect(band.length, `floor ${f.index} boundary at ${b.at} has stone along it`).toBeGreaterThan(0);
    return Math.max(...band.map((r) => r.rect.y));
  }

  it('keeps a stacked room boundary CLEAR of the floor above it — the tier bug, swept', () => {
    // What `wallTier` got wrong until 2026-08-20, stated as the invariant rather than as a tier
    // name: the south half of a shared boundary is authored by the lower room and answers "I am
    // my room's north edge", which used to stand it at `WALL_H_PERIMETER`. Its art rises from its
    // own north edge, so at that height it reached a measured 72 px past the upper room's south
    // wall and onto the floor the kerb exists to keep clear — 22 runs of it, on all five floors.
    // Nothing here names a height: any tier whose art clears the floor above passes.
    let checked = 0;
    for (const f of FLOORS) {
      for (const b of boundaries(f)) {
        const limit = floorLimit(f, b);
        // Every block standing IN the boundary band — the upper room's own south wall, the lower
        // room's north wall, or the single merged mass when the two are the same tier. Bounded at
        // the lower room's north bound on purpose: a block starting a row further south is the
        // lower room's east/west wall, whose art also pokes into the room above (measured 40 px
        // over a 32 px-wide strip at the corner) but for a different reason — a north-south run
        // spilling past its own end, which no tier rule can fix and which
        // `occlusionCoverage.test.ts` covers under "a PERIMETER run fires only from BEYOND its
        // own end". Folding it in here would make this check about the x-ray instead of the tier.
        const band = f.runs.filter((r) =>
          Math.min(r.rect.x + r.rect.w, b.x1) - Math.max(r.rect.x, b.x0) > 0.75
          && r.rect.y >= limit - 0.75 && r.rect.y <= b.below.y + 0.75);
        expect(band.length, `floor ${f.index} boundary at ${b.at} has blocks`).toBeGreaterThan(0);
        for (const run of band) {
          // The bound is ONE KERB's worth of intrusion, not zero: a kerb standing on the upper
          // room's own south edge already reaches `WALL_H_KERB` px onto its floor, and that is
          // the case design/01 calls provably safe (the player's clearance keeps their ground
          // point a full wall thickness north of it). What must never happen is a block along
          // this boundary reaching FURTHER in than that — which is exactly what an `interior`
          // (70) or `perimeter` (104) tier here would do. No literal heights: the tiers are
          // compared through the one constant that defines "as low as a boundary gets".
          const [top] = artBand(run, f.joins[f.runs.indexOf(run)]!);
          expect(top, `floor ${f.index} boundary at ${b.at}, run ${run.rect.x},${run.rect.y} (${run.tier})`)
            .toBeGreaterThanOrEqual(limit - WALL_H_KERB - 0.001);
          checked++;
        }
      }
    }
    // Mutation guards. The count is pinned rather than merely non-zero because it is derived
    // from the ROOMS: 11 stacked pairs across the five floors (1 / 3 / 4 / 2 / 1), and every one
    // of them has stone along it. If a room moves, this number moving is the notification.
    // Zero would mean the pipeline broke, not that the level got better.
    expect(FLOORS.flatMap(boundaries).length, 'stacked-room boundaries in the content').toBe(16);
    expect(checked, 'blocks checked along them').toBeGreaterThan(15);
  });

  it('has NOT flattened a north wall the room above only partly covers', () => {
    // The cost this rule could have had, and the reason it needs no splitting pass. On floor 2
    // `r5_bastion` and `r4_furnace` sit side by side and author one collinear north boundary, but
    // only `r4_furnace` has a room (`r3_court`) above it. `wallTier` runs per authored rect and
    // `RoomBuilder` tiers BEFORE it merges, so the two halves get different answers and then
    // refuse to merge — where under the old rule they were one 32-cell perimeter run. If a future
    // change moved tiering after the merge, or widened the overlap test to "touches", this pair
    // would collapse to one height and a 20-cell room boundary would silently drop to 22 px.
    const collinear = FLOORS.flatMap((f) =>
      f.runs.filter((a) => a.tier === 'perimeter').filter((a) =>
        f.runs.some((b) => b.tier === 'kerb'
          && Math.abs(b.rect.y - a.rect.y) <= 0.75
          && Math.abs(b.rect.h - a.rect.h) <= 0.75
          && (Math.abs(b.rect.x - (a.rect.x + a.rect.w)) <= 0.75 || Math.abs(a.rect.x - (b.rect.x + b.rect.w)) <= 0.75))),
    );
    expect(collinear.length, 'perimeter runs standing beside a kerb on the same boundary').toBeGreaterThan(0);
    // ...and the floors are still mostly tall walls, not a plain of kerbs.
    const all = FLOORS.flatMap((f) => f.runs);
    const kerbs = all.filter((r) => r.tier === 'kerb').length;
    expect(kerbs).toBeGreaterThan(40); // measured 53, up from 37 before the fix
    expect(kerbs).toBeLessThan(all.length / 2);
  });
});

/* ------------------------------------------------------------------ the art the clip is measured from */

const PUBLIC = new URL('../../../public/', import.meta.url);

/** Decode an 8-bit RGB/RGBA PNG far enough to average its rows. Small and deliberate: the point
 *  is to read the ACTUAL shipped pixels, and the alternative (trusting a recorded number) is the
 *  failure mode this whole file exists to catch. */
function pngRowLuma(path: string): number[] {
  const buf = readFileSync(new URL(path, PUBLIC));
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const bitDepth = buf.readUInt8(24);
  const colorType = buf.readUInt8(25);
  expect(bitDepth, `${path} bit depth`).toBe(8);
  expect([2, 6], `${path} colour type`).toContain(colorType);
  const channels = colorType === 6 ? 4 : 3;

  const idat: Buffer[] = [];
  for (let at = 8; at + 8 <= buf.length; ) {
    const len = buf.readUInt32BE(at);
    const type = buf.toString('ascii', at + 4, at + 8);
    if (type === 'IDAT') idat.push(buf.subarray(at + 8, at + 8 + len));
    at += len + 12;
  }
  const raw = inflateSync(Buffer.concat(idat));

  const stride = width * channels;
  const prev = Buffer.alloc(stride);
  const line = Buffer.alloc(stride);
  const out: number[] = [];
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    raw.copy(line, 0, y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? line[i - channels]! : 0;
      const b = prev[i]!;
      const c = i >= channels ? prev[i - channels]! : 0;
      if (filter === 1) line[i] = (line[i]! + a) & 0xff;
      else if (filter === 2) line[i] = (line[i]! + b) & 0xff;
      else if (filter === 3) line[i] = (line[i]! + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        line[i] = (line[i]! + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
      }
    }
    let sum = 0;
    for (let x = 0; x < width; x++) {
      const o = x * channels;
      sum += 0.2126 * line[o]! + 0.7152 * line[o + 1]! + 0.0722 * line[o + 2]!;
    }
    out.push(sum / width);
    line.copy(prev);
  }
  return out;
}

describe('FACE_CROWN_ROWS — measured off the shipped art, and still true of it', () => {
  // The cross-layer check, and the class of bug this repo keeps hitting: a hand-tuned number sized
  // against art that has since been re-exported. The tuck's clip line IS this table. If someone
  // redraws a `wallface_*.png` with a taller coping course, nothing in the renderer notices and
  // every corner in that biome silently slices through a crown.
  //
  // It has already earned its place once: written with a single fire-measured constant, the first
  // run of this file reported ice's mortar line at row 17 where the constant said 31 — i.e. two of
  // four shipped biomes were being clipped through the crown, invisibly, and no unit test or render
  // of the ember floor could ever have shown it.
  // Five since 2026-08-25 — poison was the last element of design/13's locked five with no art.
  const SWATCHES = ['fire', 'ice', 'lightning', 'neutral', 'poison'] as const;

  /** The row of the swatch's mortar line: the darkest row in its top third. This IS the definition
   *  `FACE_CROWN_ROWS` is measured by, so the assertion is exact rather than a tolerance. */
  function mortarRow(rows: number[]): number {
    const third = rows.slice(0, Math.round(rows.length / 3));
    let at = 0;
    third.forEach((v, i) => { if (v < third[at]!) at = i; });
    return at;
  }

  it('has an entry for every shipped face swatch', () => {
    // A new biome whose art lands without being measured would otherwise fall back to the
    // conservative default and quietly clip its corners in the wrong place.
    const shipped = readdirSync(new URL('biome/', PUBLIC))
      .filter((f) => f.startsWith('wallface_') && f.endsWith('.png'))
      .map((f) => f.slice('wallface_'.length, -'.png'.length));
    expect(shipped.length).toBeGreaterThan(0);
    for (const el of shipped) expect(FACE_CROWN_ROWS[el], `no crown measured for '${el}'`).toBeDefined();
    expect([...SWATCHES].sort()).toEqual(shipped.sort());
  });

  it('records each swatch\'s real pixel height, so a re-export at a new size fails here', () => {
    for (const el of SWATCHES) {
      const rows = pngRowLuma(`biome/wallface_${el}.png`);
      expect(FACE_CROWN_ROWS[el]![1], `${el} row count`).toBe(rows.length);
    }
  });

  it('puts the line exactly on each swatch\'s mortar line', () => {
    for (const el of SWATCHES) {
      const rows = pngRowLuma(`biome/wallface_${el}.png`);
      expect(FACE_CROWN_ROWS[el]![0], `${el} mortar line`).toBe(mortarRow(rows));
    }
  });

  it('is a real crown/brick joint, not just any dark row', () => {
    // What makes the mortar line the right place to stop: a markedly brighter coping course above it
    // and the brick plateau below. That contrast is why the crown is the line the eye reads a back
    // wall by, and it is what would stop holding if the art lost its coping course entirely.
    for (const el of SWATCHES) {
      const rows = pngRowLuma(`biome/wallface_${el}.png`);
      const line = FACE_CROWN_ROWS[el]![0];
      const mean = (xs: number[]) => xs.reduce((a, x) => a + x, 0) / xs.length;
      const coping = mean(rows.slice(0, Math.max(1, line - 8)));
      const brick = mean(rows.slice(line + 4, Math.round(rows.length * 0.75)));
      expect(coping, `${el} coping vs brick`).toBeGreaterThan(brick * 1.3);
    }
  });

  it('records that the swatches DISAGREE, which is why the lookup is per element', () => {
    // Pinned deliberately: if a future art pass makes them agree, a single constant becomes correct
    // again and this test says so out loud rather than leaving the plumbing unexplained.
    const fractions = SWATCHES.map((el) => faceCrownFraction(el));
    expect(new Set(fractions.map((f) => f.toFixed(3))).size).toBeGreaterThan(1);
    expect(faceCrownFraction('ice')).toBeLessThan(faceCrownFraction('fire'));
  });

  it('defaults to the SHALLOWEST measured crown, which can never cross a deeper one', () => {
    const all = Object.values(FACE_CROWN_ROWS).map(([row, total]) => row / total);
    expect(FACE_CROWN_FRACTION_MIN).toBeCloseTo(Math.min(...all), 9);
    // An element with no measured crown takes it. Every element in design/13's closed five now has
    // one (poison's landed 2026-08-25), so the subject here is a hypothetical sixth — which is the
    // honest statement of what the fallback is for, and does not go stale the next time art lands.
    expect(faceCrownFraction('not_an_element_yet')).toBe(FACE_CROWN_FRACTION_MIN);
    expect(faceCrownFraction('poison')).not.toBe(FACE_CROWN_FRACTION_MIN); // it IS measured now
  });

  it("is actually WIRED to the room's element by RoomBuilder", () => {
    // The one step nothing else here can reach: `wallJoins` defaults to the conservative minimum, so
    // a caller that forgets to pass the room's own fraction still produces plausible corners — every
    // fire room would just clip a few px low, forever, silently. Read from source rather than
    // imported because importing RoomBuilder needs a live Pixi stage; same trick
    // `render/rigComposition.test.ts` uses on main.ts.
    const source = readFileSync(new URL('RoomBuilder.ts', import.meta.url)).toString('utf8');
    expect(source).toMatch(/wallJoins\(\s*merged,\s*faceCrownFraction\(element\)\s*\)/);
  });

  it('would NOT be satisfied by an arbitrary row — the check has teeth', () => {
    // Guards the assertions above against being vacuously true: 40% down the elevation is inside the
    // brick courses, and must not pass as the mortar line for any swatch.
    for (const el of SWATCHES) {
      const rows = pngRowLuma(`biome/wallface_${el}.png`);
      expect(mortarRow(rows), el).not.toBe(Math.round(rows.length * 0.4));
    }
  });
});

/**
 * Pixi's own batching decision, run for real against the smallest fake renderer
 * `GraphicsContextSystem` will accept. Duplicated from `render/staticGraphics.test.ts`, which is
 * where the 400-float rule itself is pinned — this file only asks the question of real content.
 */
function contextSystem(): GraphicsContextSystem {
  const renderer = {
    uid: 1,
    limits: { maxBatchableTextures: 16 },
    gc: { addResourceHash: () => undefined, now: 0 },
  } as never;
  return new GraphicsContextSystem(renderer);
}

describe('shipped level-1 walls — the shading still batches', () => {
  // The 2026-08-24 sampled-ramp pass is worth 50 of the frame's 102 draw calls, and the whole win
  // rests on one property of every block: its shading geometry stays under Pixi's 400-float
  // auto-batch line. That is a property of CONTENT, not of a hand-written rect — a block's fill
  // count depends on its tier, its cap depth, how many spans its joins split it into and whether it
  // tucks, so the block that overflows first will be some particular run on some particular floor.
  // Nothing else in the suite would notice: the shading would still draw, still look identical, and
  // just quietly cost a draw call and two program switches again.
  //
  // So: every wall of every shipped floor, through the real `GraphicsContextSystem`.

  it("keeps every block's shading under Pixi's auto-batch line, on all five floors", () => {
    const sys = contextSystem();
    let blocks = 0;
    let worstFloats = 0;
    let worstFills = 0;
    let worstWhere = '';
    for (const f of FLOORS) {
      for (const [i, run] of f.runs.entries()) {
        const g = drawBlockShading(run.rect, wallHeight(run.tier), f.joins[i]!);
        const gpu = sys.updateGpuContext(g.context);
        const floats = gpu.geometryData.vertices.length;
        const fills = g.context.instructions.length;
        expect(
          gpu.isBatchable,
          `floor ${f.index} run ${i} (${run.rect.w}x${run.rect.h}, tier ${run.tier}, ${floats} floats, ${fills} fills)`,
        ).toBe(true);
        blocks++;
        if (floats > worstFloats) {
          worstFloats = floats;
          worstWhere = `floor ${f.index} run ${i} (${run.rect.w}x${run.rect.h})`;
        }
        worstFills = Math.max(worstFills, fills);
      }
    }
    // The sweep has to be a sweep. If a content or merge change emptied it, every assertion above
    // would vacuously pass.
    expect(blocks).toBeGreaterThan(50);
    // ...and the headroom, stated so the next person adding a cue can see what they are spending.
    // The stepped form these replaced ran 520-2010 floats, i.e. 1.3-5x over the line; the worst
    // shipped block is now 120 floats over 15 fills.
    expect(worstFloats, `worst block: ${worstWhere}`).toBeLessThan(AUTO_BATCH_VERTEX_LIMIT / 2);
    expect(worstFills).toBeLessThan(30);
  });

  // ------------------------------------------------------------------------------------------
  // The face split of 2026-08-27 adds a SECOND piece to every block whose face the x-ray's deep
  // pass can partly reach — 227 of 294 blocks in a built arena. That is exactly the shape of cue
  // the 2026-08-24 pass found 50 of 107 draw calls in: something added per block, correct in
  // isolation, and outside every budget in this file. Live measurement said it is free (45 draws
  // before, 45 after) BECAUSE the piece is a batchable sprite — so these two checks pin the
  // property the measurement depended on, rather than the number it produced.

  it('adds no GRAPHICS to a block with a swatch — the split rides the sprite batch', () => {
    // A base piece drawn as a Graphics fill instead of a TilingSprite would look identical, pass
    // every other test in the suite, and cost a draw call on every splittable wall in the map.
    // The gate is the COUNT of Graphics per block, which is what a new one would move.
    let blocks = 0;
    let splitBlocks = 0;
    for (const f of FLOORS) {
      for (const [i, run] of f.runs.entries()) {
        const height = wallHeight(run.tier);
        const seg = buildWallBlock(run.rect, height, texturedSkin(), f.joins[i]!, f.voids[i]!);
        // `addWallFace` runs first, so the face IS the children drawn before the cap — no label
        // filtering, which matters because the shading shares `XRAY_DEEP_LABEL` and a void return
        // shares `XRAY_LABEL`. Every one of those children has to be a sprite.
        const capAt = seg.children.findIndex((c) => c.label === XRAY_LABEL);
        const faces = seg.children.slice(0, capAt);
        expect(faces.length, `floor ${f.index} run ${i}`).toBeGreaterThan(0);
        for (const c of faces) {
          expect(c, `floor ${f.index} run ${i}`).toBeInstanceOf(TilingSprite);
          expect(c, `floor ${f.index} run ${i}`).not.toBeInstanceOf(Graphics);
        }
        expect(faces.map((c) => c.label), `floor ${f.index} run ${i}`).toEqual(
          faces.length === 2 ? [XRAY_DEEP_LABEL, FACE_BASE_LABEL] : [FACE_BASE_LABEL],
        );
        if (faces.length === 2) splitBlocks++;
        blocks++;
      }
    }
    expect(blocks).toBeGreaterThan(50);
    // The sweep has to contain the case it is about: a room of unsplittable blocks would let the
    // whole thing pass without a single second face piece in it.
    expect(splitBlocks).toBeGreaterThan(20);
  });

  it("keeps the no-swatch fallback's face pieces under the auto-batch line too", () => {
    // The degraded path DOES draw a Graphics per piece, so the split really does add one there —
    // and it lands inside this budget rather than beside it. Each piece carries only the banding
    // that carries over its own span (`fillBand` clips), so the pair costs no more fills than the
    // one whole face did; that is the property, and the float counts are what prove it.
    const sys = contextSystem();
    let worstFloats = 0;
    let pieces = 0;
    for (const f of FLOORS) {
      for (const [i, run] of f.runs.entries()) {
        const height = wallHeight(run.tier);
        const seg = buildWallBlock(run.rect, height, bareSkin(), f.joins[i]!, f.voids[i]!);
        const faces = seg.children.filter(
          (c): c is Graphics =>
            c instanceof Graphics && (c.label === XRAY_DEEP_LABEL || c.label === FACE_BASE_LABEL),
        );
        // The shading carries `XRAY_DEEP_LABEL` as well, so drop it by position: the face is
        // everything drawn before the cap.
        const capAt = seg.children.findIndex((c) => c.label === XRAY_LABEL);
        for (const g of faces.filter((c) => seg.children.indexOf(c) < capAt)) {
          const gpu = sys.updateGpuContext(g.context);
          const floats = gpu.geometryData.vertices.length;
          expect(gpu.isBatchable, `floor ${f.index} run ${i} fallback face, ${floats} floats`).toBe(true);
          worstFloats = Math.max(worstFloats, floats);
          pieces++;
        }
      }
    }
    expect(pieces).toBeGreaterThan(50);
    // Headroom, stated so the next person adding a band to the fallback can see what it costs.
    // A face piece is at most three clipped rects, i.e. well under a tenth of the line.
    expect(worstFloats).toBeLessThan(AUTO_BATCH_VERTEX_LIMIT / 4);
  });

  it('draws every graduated cue as a SAMPLED ramp, never as hand-stepped bands', () => {
    // The structural form of the rule, and the gate that actually holds it. A float budget does not:
    // reverting one cue to 5 stepped rects costs +32 floats, which fits inside any headroom loose
    // enough to allow a future cue — measured, it survives the sweep above.
    //
    // What cannot be faked is the KIND of fill. A sampled ramp carries a texture and a matrix
    // (`readRampFill` recovers them); a hand-stepped band is a plain colour fill. So: every fill in
    // every shipped block's shading is a ramp, and the only non-fill is the cap/face fold, which is
    // a single hard line and correctly a stroke. Anyone hand-banding a gradient here again fails
    // this on the first block, whatever it costs in floats.
    let fills = 0;
    let strokes = 0;
    for (const f of FLOORS) {
      for (const [i, run] of f.runs.entries()) {
        const g = drawBlockShading(run.rect, wallHeight(run.tier), f.joins[i]!);
        for (const ins of g.context.instructions as ReadonlyArray<{ action: string; data: { style?: unknown } }>) {
          if (ins.action === 'stroke') {
            strokes++;
            continue;
          }
          expect(ins.action, `floor ${f.index} run ${i}`).toBe('fill');
          expect(
            readRampFill(ins.data.style),
            `floor ${f.index} run ${i} (${run.rect.w}x${run.rect.h}) has a flat fill, not a ramp`,
          ).not.toBeNull();
          fills++;
        }
      }
    }
    expect(fills).toBeGreaterThan(500); // ~173 blocks x 8-15 cues
    expect(strokes).toBeGreaterThan(0); // the fold is still drawn
  });

  it('samples only a handful of SHARED ramp textures across every wall in the game', () => {
    // The other half of the draw-call argument, and the one with no other guard on it. Getting
    // under 400 floats makes a block batchable; the blocks only end up in ONE batch if they all
    // sample the same few textures, because a batch holds a bounded number of texture slots.
    //
    // A profile that varied with geometry — `alphaRamp(0, height / 200)` is the plausible slip,
    // since every other number in `wallTone` is a fraction of something — would bake one texture
    // per distinct block size, blow the slot budget, and split the batch again. Every existing
    // assertion would stay green: the cache would still work, each ramp would still be linear, each
    // block would still be one quad.
    resetShadeRampCache();
    for (const f of FLOORS) {
      for (const [i, run] of f.runs.entries()) drawBlockShading(run.rect, wallHeight(run.tier), f.joins[i]!);
    }
    // Three profiles as of this pass: the plain 0->1 ramp, the east band's 0.45->1, and the crown
    // crease's 0.25->1. A ceiling rather than an equality, so adding a fourth cue is allowed and
    // going per-block is not.
    expect(shadeRampCacheSize()).toBeGreaterThan(0);
    expect(shadeRampCacheSize()).toBeLessThanOrEqual(6);
  });

  it('draws its cues in the order the tones were measured against', () => {
    // `drawBlockShading`'s call order IS part of the look — Pixi paints fills in call order and a
    // later one composites over an earlier one, which is why both shading modules' headers say so.
    // Reordering is invisible to every other assertion in the suite (same fills, same alphas, same
    // rects) and changes what the block looks like, so the sequence is pinned.
    //
    // The joins here are SYNTHETIC on purpose, and that is the finding: no shipped block exercises
    // every branch at once, because `wallJoins` sorts a join into `south` OR `tuckedSouth` and never
    // both (a corner and a tuck are the two answers to the same question). Ordering is a property of
    // the function rather than of the content, so the subject is built to reach all of it, and the
    // sweep above is what covers the real geometry.
    const rect = { x: 0, y: 0, w: 480, h: 224 };
    const height = wallHeight('perimeter');
    const all = {
      north: [[0, 480]] as Array<[number, number]>,
      south: [[100, 160]] as Array<[number, number]>,
      tuckNorth: true,
      tuckLiftPx: height * (1 - FACE_CROWN_FRACTION_MIN),
      tuckedSouth: [[300, 360]] as Array<[number, number]>,
      crownFraction: FACE_CROWN_FRACTION_MIN,
      doorClip: false,
      capless: false,
    };
    const g = drawBlockShading(rect, height, all);
    const tones = (
      g.context.instructions as ReadonlyArray<{ action: string; data: { style?: { color?: number; alpha?: number } } }>
    ).map((ins) => `${ins.action}:${ins.data.style?.color}@${ins.data.style?.alpha?.toFixed(3)}`);
    const at = (needle: string) => tones.findIndex((t) => t.includes(needle));
    const capGradient = at(`fill:0@${CAP_GRADIENT_MAX.toFixed(3)}`);
    const coping = at(`fill:0@${FACE_COPING_SUPPRESS.toFixed(3)}`);
    const chamfer = at(`fill:${LIT_EDGE_COLOR}@`);
    const eastBand = at(`fill:${SIDE_COLOR}@`);
    const fold = tones.findIndex((t) => t.startsWith('stroke:'));
    const baseCrease = at(`fill:0@${BASE_AO_MAX.toFixed(3)}`);
    for (const [name, idx] of Object.entries({ capGradient, coping, chamfer, eastBand, fold, baseCrease })) {
      expect(idx, `${name} is drawn at all`).toBeGreaterThanOrEqual(0);
    }
    // Cap depth gradient, the face's coping correction, the side bands, then the fold stroke...
    expect(capGradient).toBeLessThan(coping);
    expect(coping).toBeLessThan(chamfer);
    expect(chamfer).toBeLessThan(eastBand); // warm chamfer before the dark band, per length band
    expect(eastBand).toBeLessThan(fold);
    // ...and the base contact crease LAST of all. It has to outlive the side bands: drawn before
    // them, the block's darkest band would be composited under a 0.86-alpha side panel and the
    // wall would stop meeting the floor.
    expect(baseCrease).toBe(tones.length - 1);
  });
});

describe('the sides that end at nothing, on the five shipped floors', () => {
  const ALL = FLOORS.flatMap((f) =>
    f.voids.flatMap((v, i) =>
      [
        ...v.east.map((span) => ({ side: 'east' as const, span })),
        ...v.west.map((span) => ({ side: 'west' as const, span })),
      ].map((e) => ({ ...e, floor: f, rect: f.runs[i]!.rect })),
    ),
  );

  it('fires on every floor, not only in the arena it was found in', () => {
    // The finding came off `arena_launch`'s twelve empty slots, which made it look like a
    // property of that map's slot grid. It is not: a PvE floor's rooms do not tile a
    // rectangle either, so the same free sides are there, and they are there on all five.
    for (const f of FLOORS) {
      const n = f.voids.filter((v) => v.east.length > 0 || v.west.length > 0).length;
      expect(n, `floor ${f.index}`).toBeGreaterThan(4);
    }
  });

  it('never reaches its return onto a room\'s floor or another block\'s stone', () => {
    for (const { side, span, rect, floor } of ALL) {
      const reach = Number.isFinite(span.gap) ? Math.min(VOID_RETURN_PX, span.gap / 2) : VOID_RETURN_PX;
      const x0 = side === 'east' ? rect.x + rect.w : rect.x - reach;
      const box = { x: x0, y: rect.y + span.from, w: reach, h: span.to - span.from };
      for (const other of [...floor.rooms, ...floor.runs.map((r) => r.rect)]) {
        if (other === rect) continue;
        const ox = Math.min(box.x + box.w, other.x + other.w) - Math.max(box.x, other.x);
        const oy = Math.min(box.y + box.h, other.y + other.h) - Math.max(box.y, other.y);
        expect(Math.min(ox, oy), `floor ${floor.index} ${side} return at ${box.x},${box.y}`)
          .toBeLessThanOrEqual(0.75);
      }
    }
  });

  it('sits EXACTLY on the reach clamp on floor 2, with no margin at all', () => {
    // The number that made the clamp worth writing rather than asserting away. Floor 2's
    // narrowest void is one grid cell — 32 px — which is precisely what two facing returns of
    // `VOID_RETURN_PX` need, so today's content is at the limit and the next authored room
    // could cross it with nothing to notice. Both halves are pinned: the clamp is not firing
    // on anything shipped, AND the margin it would fire on is zero.
    const tightest = Math.min(...ALL.map((s) => s.span.gap));
    expect(tightest).toBe(2 * VOID_RETURN_PX);
    expect(ALL.every((s) => !Number.isFinite(s.span.gap) || s.span.gap / 2 >= VOID_RETURN_PX)).toBe(true);
  });
});
