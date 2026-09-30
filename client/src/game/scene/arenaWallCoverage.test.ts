/// <reference types="node" />
/**
 * The five wall-content sweeps, run against the map a PvP match actually builds.
 *
 * **WHY THIS FILE EXISTS.** `wallComposition.test.ts`, `occlusionCoverage.test.ts`,
 * `doorStandCoverage.test.ts`, `doorSpillCoverage.test.ts` and `doorOcclusionCoverage.test.ts`
 * are this repo's answer to a failure mode it has shipped: a geometric predicate that reads
 * correctly, passes its unit tests on hand-built fixtures, and silently matches NOTHING in the
 * real level (`wallGeometry`'s old `w > h` guard left 1 wall standing where 32 should). Each of
 * them answers it by sweeping REAL content through the REAL pipeline.
 *
 * Every one of them sweeps `EMBER_L1_FLOORS` — the five PvE floors — and nothing else. The
 * arena had no walls at all until `arena_launch` was authored (2026-08-25), so there was
 * nothing to sweep; now there is, and it is a different shape of content by an order of
 * magnitude: 60 rooms against a PvE floor's 5-8, 25 distinct footprints, 494 authored wall
 * rects, rooms adjacent on both axes (a PvE floor has 11 stacked boundaries in total; this map
 * has 44), 113 pillars, and 74 authored passages. A rule tuned on 27 runs of level 1 can be
 * vacuous, or wrong, or merely out of headroom here without anything else noticing.
 *
 * So: `arena_launch` through `buildArenaGeometry` → `wallTier` → `mergeWallRuns` → `wallJoins`
 * → the passage clip (`RoomBuilder.build`'s own sequence for an arena — the same sequence minus
 * the door FIXTURES, which stay dungeon-only; see the door section), then the same questions the
 * five files ask of the PvE floors. Offline, deterministic, ~1s — with one test that drives the
 * real `RoomBuilder` end to end, because a harness that only mirrors the pipeline cannot notice
 * the pipeline changing under it.
 *
 * **What this pass found** (full account in ROADMAP's "The Seven Districts"):
 *
 *   1. The three DOOR sweeps had no subject at all here, and that was a real defect. `GameState`
 *      populates `dungeonDoors` only in dungeon mode, so `RoomBuilder`'s door-rect list was empty
 *      on every arena — `bordersDoorNorth` never fired, `doorClip`/`effectiveWallHeight` never
 *      ran, and 36 of the map's 74 authored passages were completely buried under the cap of the
 *      wall run standing south of them, 58 covered to some degree. FIXED 2026-08-26 by unioning
 *      `arenaMap.doors` into that list: 0 buried, 10 still partly covered by a run (worst 40 px
 *      of a 96 px passage), and the worn floor patch now marks all 74 thresholds. Door FIXTURES
 *      remain dungeon-only — an arena `Door` is an adjacency record with no lock and no leaf.
 *   2. `occludes` fires for 4 blocks at once at exactly one spot — a 2x2 pillar cluster — where
 *      `occlusionCoverage.test.ts` asserts at most 2. Walls alone still never exceed 2.
 *   3. The arena hides the player more than twice as often as a PvE floor (7.8% of standable
 *      floor fully hidden vs 3.3%), and takes the deep fade 5x as often (1.07% vs 0.2%). Both
 *      were higher before finding 1 was fixed (11.6% and 1.37%) — 44 runs got shorter with it.
 *   4. The shading float budget has half the headroom it does in PvE: the worst arena block is
 *      208 floats against a PvE worst of 120, which is over `wallComposition.test.ts`'s own
 *      `< AUTO_BATCH_VERTEX_LIMIT / 2` bound. Still batchable (the line is 400), but the bound
 *      that guards it was measured on the wrong content.
 *   5. One PvE case genuinely does not occur here (a room boundary only PARTLY covered by the
 *      room above, which `wallTier` answers per rect and `mergeWallRuns` then refuses to merge).
 *      Asserted as absent WITH its precondition, so "0" reads as a fact about the map rather
 *      than as a sweep that stopped looking.
 *
 * Deliberately NOT here, and the reason this file exists before a browser is opened: whether any
 * of it LOOKS right. This is the list of places to point a camera at.
 *
 * **The camera was pointed at all five, 2026-08-27** (real Chrome, `?arena=arena_launch`, the
 * coordinates taken from this file's own sweeps rather than hunted for by hand — ROADMAP's "The
 * camera list, answered" has the method and the frames). Every one came back acceptable:
 *
 *   1. The 2x2 colonnade at `terraces_r1c0` (336, 536) reads as **four columns going hazy**, not as
 *      a hole: each pillar keeps a legible silhouette outline while its body ghosts out, and an
 *      un-faded pillar two cells away is right there in frame as the contrast.
 *   2. `cisterns_r1c3`, the worst-hidden room, keeps the character fully visible; the wall block it
 *      fades reads as a translucent slab over the solid stone behind it.
 *   3. The deep pass (front FACE dropped too) reads as a glass block with hard edges — the one
 *      verdict with a reservation, since a ghosted rectangle is more "pane" than "x-rayed stone".
 *      **CLOSED 2026-08-27, and the reservation named the wrong thing**: not the fade value nor the
 *      edge but the EXTENT. 46% of the face the deep pass dropped is below every body a focus can
 *      put in front of the block, so it was going translucent for nobody and taking the block's
 *      base with it. `occlusion.deepFadeReach` bounds it and `wallRender.addWallFace` draws the
 *      face in two pieces on that row; the two sweeps below assert the bound on real content.
 *   4. The 208-float 672x64 KERB draws its three south spans with no seam between them.
 *   5. Passage 63's residual 40 px of 160 is imperceptible standing in the doorway.
 *
 * What the same pass DID find is not in this file's remit and is recorded in ROADMAP: the map's 12
 * deliberately-empty grid cells read as hard-edged black rectangles (~20% of a 16:9 frame from the
 * room next door) wherever the void is EAST or WEST of the player, because only a void to the SOUTH
 * puts a wall run's top surface and dark face between the player and it.
 */
import { describe, it, expect } from 'vitest';
import { Graphics, GraphicsContextSystem } from 'pixi.js';
import { createGameState, PLAYER_BASE, WALL_NORTH_BRIM } from '@dd/engine';
import { ARENA_CATALOG, ARENA_IDS, type ArenaId } from '../match/arenaCatalog';
import { fpToPx, PX_PER_GRID } from '../coords';
import {
  WALL_H_KERB,
  WALL_HEIGHT,
  wallHeight,
  wallTier,
  type RectPx,
  type WallTier,
} from './wallGeometry';
import {
  NO_JOINS,
  blockCapTop,
  bordersDoorNorth,
  effectiveWallHeight,
  mergeWallRuns,
  wallJoins,
  type WallJoins,
  type WallRun,
} from './wallRuns';
import { faceCrownFraction } from './wallTone';
import { floorRegionsPx, roomRectsPx } from './groundLayer';
import { voidEdges, type VoidEdges } from './wallVoidEdge';
import { VOID_RETURN_PX } from './wallTone';
import { Layers } from './layers';
import { Backdrop } from './Backdrop';
import { RoomBuilder } from './RoomBuilder';
import { pillarArtExtent } from './pillarRender';
import { deepFadeReach, needsDeepFade, occludes, XRAY_LABEL, type Occluder } from './occlusion';
import { drawBlockShading } from './wallRender';
import { addVoidReturns } from './wallVoidReturn';
import { Entity } from './Entity';
import { biomePalette } from '../theme';
import { AUTO_BATCH_VERTEX_LIMIT } from '../../perf/drawAttribution';
import { readRampFill, resetShadeRampCache, shadeRampCacheSize } from '../../render/shadeRamp';

/** An arena has no `dungeonConfig`, so `RoomBuilder` builds it with the neutral element —
 *  and the crown line a corner stops under is per element (`FACE_CROWN_ROWS`). Passing fire's
 *  here, as the PvE sweeps correctly do, would test a floor the game never draws. */
const ARENA_ELEMENT = 'neutral';
const CROWN = faceCrownFraction(ARENA_ELEMENT);

/** The drawn character, in world px — the same three numbers `occlusionCoverage.test.ts` uses
 *  (the shipped rig's own measurements, pinned off the real skin by `Actor.test.ts`). */
const BODY_H = 32;
const HALF_W = 12.96;
const CLEARANCE = fpToPx(PLAYER_BASE.solidRadius);
/** ...and the extra clearance a free-standing block's NORTH face gets on top of it (v47). */
const BRIM = fpToPx(WALL_NORTH_BRIM);
/** Sweep step in world px — a quarter of a grid cell, as in the PvE sweep. */
const STEP = 8;
const HIDDEN_FRACTION = 0.5;

interface Block {
  box: Occluder;
  tier: WallTier | 'pillar';
  /** The block's own footprint, for the "where does a perimeter run fire from" check. */
  rect: RectPx;
}

interface Arena {
  id: ArenaId;
  runs: WallRun[];
  joins: WallJoins[];
  blocks: Block[];
  /** Room rects in world px, with their authored ids — the ids are what makes a finding a place
   *  a camera can be pointed at rather than a coordinate. */
  rooms: Array<RectPx & { id: string }>;
  /** The raw (pre-merge) wall rects, which is what the player collides with — each carrying
   *  whether it is a free-standing block, because that is what decides whether its north face
   *  gets the v47 brim in `standable`. Dropping it here would leave the sweep standing the player
   *  in poses the engine no longer allows, and reporting blind spots that cannot happen. */
  walls: Array<RectPx & { freeStanding?: boolean }>;
  pillars: Array<{ gx: number; gy: number; r: number }>;
  /** Every authored passage, in world px. NOT what the client renders — see the door section. */
  passages: Array<RectPx & { i: number; a: string; b: string }>;
  /** What the ground layer actually PAINTS, which is what `voidEdges` reads. */
  floors: RectPx[];
  /** Per merged run, index-aligned with `runs`: which of its sides end at nothing. */
  voids: VoidEdges[];
}

/**
 * One catalog arena, taken through `RoomBuilder.build`'s own sequence for an arena.
 *
 * Built from a REAL `GameState` rather than from `buildArenaGeometry` directly, because what
 * `RoomBuilder` reads is `s.walls`/`s.arenaRoomRects`/`s.obstacles` — the same reason
 * `floorCoverage.test.ts`'s arena half does it this way. The one thing this harness cannot get
 * from `RoomBuilder` is the door list, and that is the point: there isn't one (see below).
 */
function buildArena(id: ArenaId): Arena {
  const map = ARENA_CATALOG[id];
  const s = createGameState({ seed: 1, worldW: 1, worldH: 1, waves: [], arena: map });
  // Through `roomRectsPx`, the dispatch `RoomBuilder.build` actually calls, rather than by
  // reading `s.arenaRoomRects` here. That branch (`dungeonRoomRects` if any, else the arena's,
  // else the world box) is the arena's entry into the whole wall stack, and a sweep that steps
  // around it measures the pipeline while leaving the call site untested — the exact gap the
  // 2026-08-26 floor-partition battery found the hard way (`cellExtent(s.worldH, s.worldW)`, the
  // world's axes swapped at the call site, survived the entire suite). The authored ids come
  // alongside, index-aligned, and the guard below pins that they really are.
  const roomsPx: RectPx[] = roomRectsPx(s, fpToPx(s.worldW), fpToPx(s.worldH));
  const rooms = roomsPx.map((r, i) => ({ ...r, id: s.arenaRoomRects[i]?.id ?? `(unnamed ${i})` }));
  const walls: Array<RectPx & { freeStanding?: boolean }> = s.walls.map((w) => ({
    x: fpToPx(w.x), y: fpToPx(w.y), w: fpToPx(w.w), h: fpToPx(w.h),
    ...(w.freeStanding ? { freeStanding: true as const } : {}),
  }));
  // Tier FIRST, then merge same-tier neighbours — `RoomBuilder`'s order, and load-bearing
  // (`mergeWallRuns`: a cross-tier merge would give a kerb a perimeter's height).
  const runs = mergeWallRuns(walls.map((rect) => ({ rect, tier: wallTier(rect, roomsPx) })));
  const pillars = s.obstacles.map((o) => ({ gx: fpToPx(o.gx), gy: fpToPx(o.gy), r: fpToPx(o.radius) }));
  // `Door.passageGrid` is absolute (unlike a room's `solids`, which are room-relative — see
  // `content/arenas.ts`), so it converts straight to px through the grid size.
  const passages = map.doors.map((d, i) => ({
    i,
    a: d.roomA,
    b: d.roomB,
    x: d.passageGrid.x * PX_PER_GRID,
    y: d.passageGrid.y * PX_PER_GRID,
    w: d.passageGrid.w * PX_PER_GRID,
    h: d.passageGrid.h * PX_PER_GRID,
  }));
  // The door clip, which `RoomBuilder.build` applies to an arena as of 2026-08-26 — before that
  // it fed `bordersDoorNorth` a list that was empty on every arena, and this harness had no
  // `doorClip` in it either because there was none in the pipeline. Both moved together: the
  // harness is only a sweep of the shipped geometry as long as it stays the same sequence, and
  // `the real RoomBuilder wires it` below is what stops the two drifting again.
  const passageRects: RectPx[] = passages.map((p) => ({ x: p.x, y: p.y, w: p.w, h: p.h }));
  const joins = wallJoins(runs, CROWN).map((j, i) =>
    bordersDoorNorth(runs[i]!.rect, passageRects) ? { ...j, doorClip: true } : j,
  );

  const blocks: Block[] = runs.map((run, i) => {
    // Height first (it may shrink), then the cap fed THAT result — never the raw tier height.
    const height = effectiveWallHeight(run.rect, wallHeight(run.tier), joins[i]!);
    const sortY = run.rect.y + run.rect.h;
    return {
      tier: run.tier,
      rect: run.rect,
      box: {
        left: run.rect.x,
        right: run.rect.x + run.rect.w,
        top: sortY + blockCapTop(run.rect, height, joins[i]),
        sortY,
        foldY: sortY - height,
      },
    };
  });
  for (const p of pillars) {
    const art = pillarArtExtent(p.r * 2 + 16, WALL_HEIGHT); // RoomBuilder's own bodyW/height
    blocks.push({
      tier: 'pillar',
      rect: { x: p.gx - p.r, y: p.gy - p.r, w: p.r * 2, h: p.r * 2 },
      box: { left: p.gx - art.halfW, right: p.gx + art.halfW, top: p.gy + art.top, sortY: p.gy, foldY: p.gy },
    });
  }
  const mergedRects = runs.map((run) => run.rect);
  const floors = floorRegionsPx(s, fpToPx(s.worldW), fpToPx(s.worldH));
  const voids = mergedRects.map((rect) => voidEdges(rect, mergedRects, floors));
  return { id, runs, joins, blocks, rooms, walls, pillars, passages, floors, voids };
}

const ARENAS: Arena[] = ARENA_IDS.map(buildArena);
/** The map a real PvP match builds, and the only one in the catalog with any stone in it —
 *  `landing_basic` is the wall-less `?arenaDemo=1` fixture. */
const LAUNCH = ARENAS.find((a) => a.id === 'arena_launch')!;

const overlapsX = (a: RectPx, b: RectPx): boolean =>
  Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 0.75;

/** The height `RoomBuilder` really draws run `i` of `a` at — its tier's, unless a clip shrank it.
 *  Both shading sweeps below go through this rather than `wallHeight(tier)`: 44 arena runs now
 *  carry a `doorClip`, and the raw tier height would shade blocks the client never draws. */
function drawnHeight(a: Arena, i: number): number {
  const run = a.runs[i]!;
  return effectiveWallHeight(run.rect, wallHeight(run.tier), a.joins[i]!);
}

/** The screen-y band a block's art occupies, in world px — mirrors `buildWallBlock`, as
 *  `wallComposition.test.ts` does. */
function artBand(run: WallRun, joins: WallJoins): [number, number] {
  // Through `effectiveWallHeight` + `blockCapTop` rather than re-deriving the three clips by
  // hand: the hand-rolled form covered `tuckNorth` only, and since the arena's passages reached
  // the clip rule (2026-08-26) 44 of these runs carry a `doorClip` it knew nothing about.
  const h = effectiveWallHeight(run.rect, wallHeight(run.tier), joins);
  const south = run.rect.y + run.rect.h;
  return [south + blockCapTop(run.rect, h, joins), south];
}

/* ------------------------------------------------------------------ the content reaches the code */

describe('the arena reaches the wall pipeline at all', () => {
  it('builds the launch map into standing geometry, at the scale the map claims', () => {
    // The guard every sweep of this class needs, and here it is also the load-bearing claim of
    // the pass: this content had never been through these functions. Numbers pinned rather than
    // merely non-zero, because they are what every measurement below is a fraction OF; a content
    // edit moving them is the notification that those fractions were re-measured.
    expect(LAUNCH.rooms).toHaveLength(60);
    // `roomRectsPx` really returned the arena's 60 authored rooms, in order — not the world box
    // it falls back to for a mode with no room model, and not the dungeon list.
    const map = ARENA_CATALOG.arena_launch;
    expect(LAUNCH.rooms.map((r) => r.id)).toEqual(map.rooms.map((r) => r.id));
    for (const [i, r] of LAUNCH.rooms.entries()) {
      const authored = map.rooms[i]!.rectGrid;
      expect([r.x / PX_PER_GRID, r.y / PX_PER_GRID, r.w / PX_PER_GRID, r.h / PX_PER_GRID], r.id)
        .toEqual([authored.x, authored.y, authored.w, authored.h]);
    }
    // 492 / 294 / 124 until 2026-09-30. The pocket fill (ENGINE_VERSION 81) added 13 rects; the
    // kit fixes the same day (82) opened the rooms they filled, leaving 2, lowered six chevron
    // runs, and dropped 11 pillars (8 chevron, 3 rubble).
    expect(LAUNCH.walls).toHaveLength(494);
    expect(LAUNCH.runs).toHaveLength(288); // 494 authored rects merge to 288 drawn blocks
    expect(LAUNCH.pillars).toHaveLength(113);
    expect(LAUNCH.passages).toHaveLength(74);
  });

  it('gives every tier real subjects — none of the three is dead on this map', () => {
    // `wallTier` has three answers and an arena exercises them differently from a PvE floor:
    // rooms adjacent on BOTH axes means every horizontal boundary is a kerb pair, while a PvE
    // floor has a handful. If any of the three went to zero the sweeps below would still pass.
    const tiers = new Map<WallTier, number>();
    for (const r of LAUNCH.runs) tiers.set(r.tier, (tiers.get(r.tier) ?? 0) + 1);
    expect(tiers.get('perimeter')).toBeGreaterThan(50); // measured 124
    expect(tiers.get('interior')).toBeGreaterThan(50); // measured 106 — the interior kits
    expect(tiers.get('kerb')).toBeGreaterThan(20); // measured 64
    // ...and the map is still mostly tall walls rather than a plain of kerbs.
    expect(tiers.get('kerb')!).toBeLessThan(LAUNCH.runs.length / 2);
  });

  it('and the wall-less demo fixture really is wall-less, so its silence below is expected', () => {
    // `landing_basic` is three rooms with `solids: []`. It stays in the loop-driven assertions
    // (a future catalog map is then covered the day it lands) and it must not be mistaken for
    // content this file swept.
    const demo = ARENAS.find((a) => a.id === 'landing_basic')!;
    expect(demo.runs).toHaveLength(0);
    expect(ARENAS).toHaveLength(2);
  });
});

/* ------------------------------------------------------------------ wallComposition, on the arena */

describe('arena walls — every block agrees with its neighbours', () => {
  it('has deep runs that tuck, and every tuck lifts by a real neighbour height', () => {
    const deepMeetingWall = LAUNCH.runs.filter(
      (r, i) => r.rect.h > wallHeight(r.tier) && LAUNCH.joins[i]!.north.length > 0,
    );
    expect(deepMeetingWall.length).toBeGreaterThan(20); // measured 79
    const tucked = LAUNCH.joins.filter((j) => j.tuckNorth);
    expect(tucked.length).toBeGreaterThan(10); // measured 24
    // Every tuck's lift is a NEIGHBOUR's height less its crown, never a constant: with two tiers
    // able to stand north of a tucking run, two distinct lifts have to appear or the shortest-
    // neighbour choice in `tuckLift` is untested by this content.
    const lifts = new Set(tucked.map((j) => j.tuckLiftPx));
    expect(lifts.size).toBeGreaterThanOrEqual(2);
    for (const lift of lifts) {
      expect([wallHeight('perimeter'), wallHeight('interior'), WALL_H_KERB].map((h) => h * (1 - CROWN)))
        .toContain(lift);
    }
  });

  it('never lets a clip open a hole: the neighbour that authorised a tuck covers the band', () => {
    // The whole safety argument for clipping, on this map's geometry rather than on paper. A tuck
    // removes the band `[r.y - height, r.y - height + lift]`; the neighbour that authorised it
    // must already paint every pixel of it, or the floor shows through the corner.
    let checked = 0;
    LAUNCH.runs.forEach((run, i) => {
      const joins = LAUNCH.joins[i]!;
      if (!joins.tuckNorth) return;
      const [clippedTop] = artBand(run, joins);
      const fullTop = run.rect.y - wallHeight(run.tier);
      expect(clippedTop).toBeGreaterThan(fullTop); // something WAS removed
      const covered = LAUNCH.runs.some((other, j) => {
        if (other === run || !overlapsX(other.rect, run.rect)) return false;
        if (Math.abs(other.rect.y + other.rect.h - run.rect.y) > 0.75) return false;
        const [oTop, oBottom] = artBand(other, LAUNCH.joins[j]!);
        return oTop <= fullTop + 0.001 && oBottom >= clippedTop - 0.001;
      });
      expect(covered, `run at ${run.rect.x},${run.rect.y}`).toBe(true);
      checked++;
    });
    expect(checked, 'tucked runs actually exercised').toBeGreaterThan(10);
  });

  it('never lets a tucked run cross its neighbour\'s CROWN course, at the arena\'s own crown', () => {
    // The same line the fourth wall report was about, asked with `neutral`'s crown fraction
    // instead of fire's — the swatches disagree (`FACE_CROWN_ROWS`), so an arena tuck stops at a
    // different row than a PvE one and nothing had checked the arena's.
    let pairs = 0;
    LAUNCH.runs.forEach((run, i) => {
      const joins = LAUNCH.joins[i]!;
      if (!joins.tuckNorth) return;
      const [top] = artBand(run, joins);
      for (const other of LAUNCH.runs) {
        if (other === run || !overlapsX(other.rect, run.rect)) continue;
        if (Math.abs(other.rect.y + other.rect.h - run.rect.y) > 0.75) continue;
        if (wallHeight(other.tier) < wallHeight(run.tier)) continue;
        const oh = wallHeight(other.tier);
        expect(top).toBeGreaterThanOrEqual(run.rect.y - oh + oh * CROWN - 0.001); // stops under it
        expect(top).toBeLessThan(run.rect.y - 0.001); // ...and still covers brick
        pairs++;
      }
    });
    expect(pairs, 'tuck/neighbour pairs on this map').toBeGreaterThan(10);
  });

  it('routes every south-edge join to exactly one of `south` / `tuckedSouth`', () => {
    for (const a of ARENAS) {
      a.runs.forEach((run, i) => {
        const joins = a.joins[i]!;
        for (const [x0, x1] of [...joins.south, ...joins.tuckedSouth]) {
          expect(x1).toBeGreaterThan(x0);
          expect(x0).toBeGreaterThanOrEqual(-0.001);
          expect(x1).toBeLessThanOrEqual(run.rect.w + 0.001);
        }
        for (const [a0, a1] of joins.south) {
          for (const [b0, b1] of joins.tuckedSouth) {
            expect(Math.min(a1, b1) - Math.max(a0, b0), `${a.id} overlapping join`).toBeLessThanOrEqual(0.75);
          }
        }
      });
    }
    // Both lists have to be populated somewhere on this map, or the routing is untested here.
    expect(LAUNCH.joins.filter((j) => j.south.length > 0).length).toBeGreaterThan(10); // 75
    expect(LAUNCH.joins.filter((j) => j.tuckedSouth.length > 0).length).toBeGreaterThan(5); // 17
  });

  it('reports a north join only where a TALL ENOUGH neighbour really touches', () => {
    let joins = 0;
    LAUNCH.runs.forEach((run, i) => {
      for (const [x0, x1] of LAUNCH.joins[i]!.north) {
        expect(x0).toBeGreaterThanOrEqual(-0.001);
        expect(x1).toBeLessThanOrEqual(run.rect.w + 0.001);
        const mid = run.rect.x + (x0 + x1) / 2;
        // A join is a licence to delete an edge cue: something must be there, and it must be at
        // least as TALL as this block.
        const toucher = LAUNCH.runs.find(
          (o) =>
            o !== run &&
            Math.abs(o.rect.y + o.rect.h - run.rect.y) <= 0.75 &&
            mid >= o.rect.x - 0.75 &&
            mid <= o.rect.x + o.rect.w + 0.75 &&
            wallHeight(o.tier) >= wallHeight(run.tier),
        );
        expect(toucher, `north join at ${run.rect.x},${run.rect.y} with no tall enough neighbour`).toBeDefined();
        joins++;
      }
    });
    expect(joins, 'north joins actually exercised').toBeGreaterThan(50); // measured 139
  });

  it("leaves a SHORTER neighbour's step alone, on arena content", () => {
    // The height filter, which on this map has ten times the PvE content behind it: every kerb
    // pair on a horizontal boundary stands north of the next room's interior blocks.
    let pairs = 0;
    LAUNCH.runs.forEach((run, i) => {
      for (const other of LAUNCH.runs) {
        if (other === run || !overlapsX(other.rect, run.rect)) continue;
        if (Math.abs(other.rect.y + other.rect.h - run.rect.y) > 0.75) continue;
        if (wallHeight(other.tier) >= wallHeight(run.tier)) continue;
        pairs++;
        const buried = LAUNCH.joins[i]!.north.some(([x0, x1]) => {
          const lo = Math.max(run.rect.x + x0, other.rect.x);
          const hi = Math.min(run.rect.x + x1, other.rect.x + other.rect.w);
          return hi - lo > 0.75;
        });
        expect(buried, `short neighbour buried an edge at ${run.rect.x},${run.rect.y}`).toBe(false);
      }
    });
    expect(pairs, 'short-northern-neighbour pairs on this map').toBeGreaterThan(20); // measured 64
  });
});

describe('arena walls — nothing tall stands on the floor of the room to its north', () => {
  interface Boundary {
    above: RectPx & { id: string };
    below: RectPx & { id: string };
    at: number;
    x0: number;
    x1: number;
  }

  /** Every stacked-room boundary, enumerated from the ROOM RECTS — rooms cannot merge, so a
   *  boundary counted here cannot disappear because the drawing changed (the mistake
   *  `wallComposition.test.ts` records making). */
  function boundaries(a: Arena): Boundary[] {
    const out: Boundary[] = [];
    for (const above of a.rooms) {
      for (const below of a.rooms) {
        if (above === below) continue;
        if (Math.abs(above.y + above.h - below.y) > 0.75) continue;
        const x0 = Math.max(above.x, below.x);
        const x1 = Math.min(above.x + above.w, below.x + below.w);
        if (x1 - x0 <= 0.75) continue;
        out.push({ above, below, at: above.y + above.h, x0, x1 });
      }
    }
    return out;
  }

  it('keeps every stacked room boundary CLEAR of the floor above it — the tier bug, swept', () => {
    // What `wallTier` got wrong until 2026-08-20, stated as the invariant rather than as a tier
    // name. The arena has 44 of these boundaries against the five PvE floors' 11, and unlike a
    // PvE floor its rooms stack in COLUMNS: a district is a run of vertically adjacent rooms, so
    // this is the map's most common shape rather than an occasional pairing.
    let checked = 0;
    for (const b of boundaries(LAUNCH)) {
      const alongBoundary = (r: RectPx): boolean =>
        Math.min(r.x + r.w, b.x1) - Math.max(r.x, b.x0) > 0.75;
      // Where the upper room's walkable floor actually stops, read out of the content rather than
      // assumed to be one grid row.
      const band0 = LAUNCH.runs.filter(
        (r) => alongBoundary(r.rect) && r.rect.y < b.at - 0.75 && r.rect.y + r.rect.h > b.at - 0.75,
      );
      expect(band0.length, `boundary ${b.above.id}/${b.below.id} has stone along it`).toBeGreaterThan(0);
      const limit = Math.max(...band0.map((r) => r.rect.y));
      const band = LAUNCH.runs.filter(
        (r) => alongBoundary(r.rect) && r.rect.y >= limit - 0.75 && r.rect.y <= b.below.y + 0.75,
      );
      expect(band.length, `boundary ${b.above.id}/${b.below.id} has blocks`).toBeGreaterThan(0);
      for (const run of band) {
        const [top] = artBand(run, LAUNCH.joins[LAUNCH.runs.indexOf(run)]!);
        // One kerb's worth of intrusion is the bound, not zero — a kerb on the upper room's own
        // south edge already reaches `WALL_H_KERB` onto its floor, and that is the case design/01
        // calls provably safe. An `interior` (70) or `perimeter` (104) tier here would not be.
        expect(top, `${b.above.id}/${b.below.id}: run ${run.rect.x},${run.rect.y} (${run.tier})`)
          .toBeGreaterThanOrEqual(limit - WALL_H_KERB - 0.001);
        checked++;
      }
    }
    expect(boundaries(LAUNCH).length, 'stacked-room boundaries on this map').toBe(44);
    expect(checked, 'blocks checked along them').toBeGreaterThan(50); // measured 95
  });

  it('has no PARTLY-covered boundary at all — the PvE case that does not occur here', () => {
    // `wallComposition.test.ts` covers the opposite finding on the PvE floors: `r5_bastion` and
    // `r4_furnace` author one collinear north boundary with a room above only half of it, so the
    // two halves get DIFFERENT tiers and then refuse to merge. That case has zero instances here,
    // and it would be easy to record that as "the rule is dead on the arena" — it is not. The
    // arena's rooms are a slot lattice with fixed column widths, so two vertically adjacent rooms
    // share their FULL width and a boundary is either wholly covered or absent.
    //
    // So the absence is asserted together with its precondition. Without the second half, a
    // future map that did break the lattice would silently stop being checked for the case, which
    // is exactly how a sweep stops meaning anything.
    for (const b of boundaries(LAUNCH)) {
      expect(b.x1 - b.x0, `${b.above.id}/${b.below.id} is a partial overlap`).toBe(
        Math.min(b.above.w, b.below.w),
      );
      expect(b.above.x).toBe(b.below.x);
      expect(b.above.w).toBe(b.below.w);
    }
    const collinearWithKerb = LAUNCH.runs
      .filter((a) => a.tier === 'perimeter')
      .filter((a) =>
        LAUNCH.runs.some(
          (b) =>
            b.tier === 'kerb' &&
            Math.abs(b.rect.y - a.rect.y) <= 0.75 &&
            Math.abs(b.rect.h - a.rect.h) <= 0.75 &&
            (Math.abs(b.rect.x - (a.rect.x + a.rect.w)) <= 0.75 ||
              Math.abs(a.rect.x - (b.rect.x + b.rect.w)) <= 0.75),
        ),
      );
    expect(collinearWithKerb).toEqual([]);
  });
});

/* ------------------------------------------------------------------ the shading still batches */

/** Pixi's own batching decision, run for real against the smallest fake renderer
 *  `GraphicsContextSystem` will accept — same construction as `wallComposition.test.ts`. */
function contextSystem(): GraphicsContextSystem {
  const renderer = {
    uid: 1,
    limits: { maxBatchableTextures: 16 },
    gc: { addResourceHash: () => undefined, now: 0 },
  } as never;
  return new GraphicsContextSystem(renderer);
}

describe('arena walls — the shading still batches, with less room to spare', () => {
  it('keeps every arena block under Pixi\'s auto-batch line — and reports the real headroom', () => {
    // The 2026-08-24 draw-call pass is worth 50 of the frame's 102 draw calls and rests entirely
    // on every block's shading geometry staying under Pixi's 400-float auto-batch line. That is a
    // property of CONTENT: the fill count depends on tier, cap depth, how many spans the joins
    // split the block into, and whether it tucks. `wallComposition.test.ts` measured the worst
    // shipped PvE block at 120 floats and set its guard at `< AUTO_BATCH_VERTEX_LIMIT / 2`.
    //
    // The arena's worst block is 208 — a 672x64 KERB whose joins split it into three south spans.
    // That is over the PvE guard and would have failed it, while still being comfortably batchable.
    // Recorded as its own number rather than by loosening the other file's: the guard that matters
    // is Pixi's line, and the guard that INFORMS is how much of it real content is already using.
    const sys = contextSystem();
    let blocks = 0;
    let worstFloats = 0;
    let worstFills = 0;
    let worstWhere = '';
    for (const a of ARENAS) {
      for (const [i, run] of a.runs.entries()) {
        const g = drawBlockShading(run.rect, drawnHeight(a, i), a.joins[i]!);
        const gpu = sys.updateGpuContext(g.context);
        const floats = gpu.geometryData.vertices.length;
        expect(
          gpu.isBatchable,
          `${a.id} run ${i} (${run.rect.w}x${run.rect.h}, ${run.tier}, ${floats} floats)`,
        ).toBe(true);
        blocks++;
        if (floats > worstFloats) {
          worstFloats = floats;
          worstWhere = `${a.id} ${run.tier} ${run.rect.w}x${run.rect.h}`;
        }
        worstFills = Math.max(worstFills, g.context.instructions.length);
      }
    }
    expect(blocks).toBeGreaterThan(200); // the sweep has to be a sweep
    expect(worstFloats, `worst block: ${worstWhere}`).toBeLessThan(AUTO_BATCH_VERTEX_LIMIT);
    // Measured 208/23. Bounded so a cue that pushes arena content past ~65% of the line fails
    // here first, which is where it would actually break — not at 50% of a PvE-sized block.
    expect(worstFloats).toBeLessThanOrEqual(260);
    expect(worstFills).toBeLessThan(30);
  });

  it('draws every arena cue as a SAMPLED ramp, off the same handful of shared textures', () => {
    // The structural half of the draw-call argument: a float budget alone does not hold it (one
    // cue reverted to 5 stepped rects costs +32 floats and survives any headroom), and the blocks
    // only land in ONE batch if they all sample the same few textures. Both re-asked on arena
    // geometry, because a profile that varied with SIZE would bake a texture per block shape and
    // the arena has an order of magnitude more distinct shapes than a PvE floor.
    resetShadeRampCache();
    let fills = 0;
    let strokes = 0;
    for (const a of ARENAS) {
      for (const [i, run] of a.runs.entries()) {
        const g = drawBlockShading(run.rect, drawnHeight(a, i), a.joins[i]!);
        for (const ins of g.context.instructions as ReadonlyArray<{ action: string; data: { style?: unknown } }>) {
          if (ins.action === 'stroke') {
            strokes++;
            continue;
          }
          expect(ins.action, `${a.id} run ${i}`).toBe('fill');
          expect(
            readRampFill(ins.data.style),
            `${a.id} run ${i} (${run.rect.w}x${run.rect.h}) has a flat fill, not a ramp`,
          ).not.toBeNull();
          fills++;
        }
      }
    }
    expect(fills).toBeGreaterThan(1000); // measured 3333 over 294 blocks, before the 2026-09-30 pocket fill
    expect(strokes).toBeGreaterThan(0); // the fold is still drawn
    expect(shadeRampCacheSize()).toBeGreaterThan(0);
    expect(shadeRampCacheSize()).toBeLessThanOrEqual(6); // 3 profiles, as in PvE
  });

  it('and the void return batches too, off ONE more shared texture', () => {
    // The return is a SECOND Graphics per free side, outside `drawBlockShading` and therefore
    // outside both gates above — which is exactly how the 2026-08-24 pass found 50 of 107 draw
    // calls in the first place, a cue added beside the budget rather than inside it. So the same
    // two questions, asked of the new geometry: does every one batch, and do they all sample the
    // same bake.
    //
    // The texture count is the load-bearing half. `powerRamp` is keyed on its exponent, so a
    // return whose falloff shape varied with the block (by height, by span length, by reach)
    // would bake a texture per shape and put all 83 of them in their own batches. One key for
    // all of them is what makes this cost geometry and not draw calls.
    resetShadeRampCache();
    const sys = contextSystem();
    let returns = 0;
    let worstFloats = 0;
    let worstWhere = '';
    let strokes = 0;
    for (const a of ARENAS) {
      for (const [i, run] of a.runs.entries()) {
        const v = a.voids[i]!;
        if (v.east.length === 0 && v.west.length === 0) continue;
        const seg = new Entity();
        const height = drawnHeight(a, i);
        addVoidReturns(seg, run.rect, height, blockCapTop(run.rect, height, a.joins[i]), v, {
          palette: biomePalette(undefined),
          cap: undefined, // no swatch here: the falloff Graphics is what this measures
        });
        for (const g of seg.children.filter((c): c is Graphics => c instanceof Graphics)) {
          const gpu = sys.updateGpuContext(g.context);
          const floats = gpu.geometryData.vertices.length;
          expect(gpu.isBatchable, `${a.id} run ${i} return (${floats} floats)`).toBe(true);
          if (floats > worstFloats) {
            worstFloats = floats;
            worstWhere = `${a.id} ${run.tier} ${run.rect.w}x${run.rect.h}`;
          }
          for (const ins of g.context.instructions as ReadonlyArray<{ action: string; data: { style?: unknown } }>) {
            if (ins.action === 'stroke') {
              strokes++;
              continue;
            }
            // Same structural gate as the shading: a graduated cue here is a sampled ramp or it
            // is hand-stepped bands, and only the KIND of fill can tell them apart.
            expect(ins.action, `${a.id} run ${i} return`).toBe('fill');
            const ramp = readRampFill(ins.data.style);
            // The palette fallback surface is a flat fill by design; the FALLOFF never is.
            if (ramp === null) expect(ins.data.style).toHaveProperty('color');
          }
        }
        returns++;
      }
    }
    expect(returns).toBeGreaterThan(50); // the sweep has to be a sweep — measured 83
    expect(strokes).toBeGreaterThan(0); // the east arris is still drawn
    // Tiny beside the shading's 208: a return is one quad and one line per span.
    expect(worstFloats, `worst return: ${worstWhere}`).toBeLessThan(AUTO_BATCH_VERTEX_LIMIT / 4);
    // ONE bake for all 83, whatever their heights, spans and reaches.
    expect(shadeRampCacheSize()).toBe(1);
  });
});

/* ------------------------------------------------------------------ occlusionCoverage, on the arena */

/** Can the player's body stand centred here? Conservative on purpose, as in the PvE sweep:
 *  anything this accepts is somewhere the player can genuinely be. */
function standable(a: Arena, gx: number, gy: number, brim = BRIM): boolean {
  for (const w of a.walls) {
    // The NORTH edge, brimmed on a free-standing block (ENGINE_VERSION 47) — the engine's own rule.
    // `brim` is a parameter ONLY so the deep-pass test can run a pre-v47 control past it; every
    // other caller takes the default, which is the shipped engine's number.
    const top = w.freeStanding ? w.y - brim : w.y;
    if (gx + CLEARANCE > w.x && gx - CLEARANCE < w.x + w.w && gy + CLEARANCE > top && gy - CLEARANCE < w.y + w.h) {
      return false;
    }
  }
  for (const p of a.pillars) {
    const reach = p.r + CLEARANCE;
    if ((gx - p.gx) ** 2 + (gy - p.gy) ** 2 < reach ** 2) return false;
  }
  return a.rooms.some((r) => gx > r.x && gx < r.x + r.w && gy > r.y && gy < r.y + r.h);
}

/** THE ORACLE — what fraction of the drawn body is behind stone here, from rectangle overlap
 *  between the two things that are actually drawn, with no reference to `occludes`. Rows are
 *  unioned so two blocks over the same rows (an L corner, a pillar cluster) cannot double-count.
 *  `fired` empty ⇒ nothing has faded, i.e. the "before" picture. */
function hiddenRows(gx: number, gy: number, cands: readonly Block[], fired: readonly Block[]): number {
  const focus = { x: gx, y: gy, halfW: HALF_W, bodyH: BODY_H };
  const bodyTop = gy - BODY_H;
  const rows = new Set<number>();
  for (const b of cands) {
    if (b.box.sortY <= gy) continue; // sorts behind the character — cannot cover them
    if (gx + HALF_W <= b.box.left || gx - HALF_W >= b.box.right) continue;
    // A block that is not firing stays opaque over all of its art; a firing one keeps everything
    // from its cap/face fold down, and one that ALSO took the deep pass keeps everything from the
    // bottom of that pass's reach down — the face is split there and its base never fades
    // (`occlusion.deepFadeReach`). Before 2026-08-27 this read "the deep pass leaves nothing
    // opaque", which is no longer what the renderer does; a stale oracle here is worse than no
    // oracle, because it agrees with the rule for the wrong reason.
    let opaqueTop = b.box.top;
    if (fired.includes(b)) {
      opaqueTop = needsDeepFade(b.box, focus)
        ? b.box.foldY + deepFadeReach(b.box.sortY - b.box.foldY, b.rect.h)
        : b.box.foldY;
    }
    for (let y = Math.ceil(Math.max(bodyTop, opaqueTop)); y < Math.min(gy, b.box.sortY); y++) rows.add(y);
  }
  return rows.size / BODY_H;
}

interface Sample {
  gx: number;
  gy: number;
  room: string;
  covered: number;
  hiddenAfter: number;
  fired: Block[];
}

/**
 * Every standable position on `a`, with what the oracle and the rule each say about it.
 *
 * The arena is 3872x3040 px, so the candidate grid is 15x a PvE floor's. Blocks are bucketed by
 * x first: a body is 26 px wide, so only the blocks whose art spans the sample's own column can
 * possibly cover it, and the sweep goes from ~30M block tests to ~1M. The bucket width is checked
 * against `HALF_W` below rather than assumed.
 */
function sweep(a: Arena): Sample[] {
  const BUCKET = 128;
  const width = Math.max(...a.rooms.map((r) => r.x + r.w)) + BUCKET;
  const nBuckets = Math.ceil(width / BUCKET) + 1;
  const buckets: Block[][] = Array.from({ length: nBuckets }, () => []);
  for (const b of a.blocks) {
    const from = Math.max(0, Math.floor((b.box.left - HALF_W) / BUCKET));
    const to = Math.min(nBuckets - 1, Math.floor((b.box.right + HALF_W) / BUCKET));
    for (let i = from; i <= to; i++) buckets[i]!.push(b);
  }
  const out: Sample[] = [];
  const focus = { x: 0, y: 0, halfW: HALF_W, bodyH: BODY_H };
  const minX = Math.min(...a.rooms.map((r) => r.x));
  const maxX = Math.max(...a.rooms.map((r) => r.x + r.w));
  const minY = Math.min(...a.rooms.map((r) => r.y));
  const maxY = Math.max(...a.rooms.map((r) => r.y + r.h));
  for (let gy = minY; gy <= maxY; gy += STEP) {
    for (let gx = minX; gx <= maxX; gx += STEP) {
      if (!standable(a, gx, gy)) continue;
      focus.x = gx;
      focus.y = gy;
      const cands = buckets[Math.min(nBuckets - 1, Math.floor(gx / BUCKET))]!;
      const fired = cands.filter((b) => occludes(b.box, focus));
      out.push({
        gx,
        gy,
        room: a.rooms.find((r) => gx > r.x && gx < r.x + r.w && gy > r.y && gy < r.y + r.h)?.id ?? '(none)',
        covered: hiddenRows(gx, gy, cands, []),
        hiddenAfter: hiddenRows(gx, gy, cands, fired),
        fired,
      });
    }
  }
  return out;
}

const SWEPT: Sample[] = sweep(LAUNCH);

/**
 * Every standable position that takes the DEEP pass, at a given north brim — the control the
 * deep-pass test below needs, and deliberately not a second `sweep()`: it skips the oracle
 * (`hiddenRows`, the expensive half) because the only question here is which samples the RULE
 * fires the deep pass for, not how much of the body survives it.
 *
 * Same grid and same bucketing as `sweep`, so a sample this reports is one that sweep would have
 * reported too — sharing `standable` is what makes the two comparable.
 */
function deepPassHits(brim: number): Array<{ gx: number; gy: number; blocks: Block[] }> {
  const a = LAUNCH;
  const BUCKET = 128;
  const width = Math.max(...a.rooms.map((r) => r.x + r.w)) + BUCKET;
  const nBuckets = Math.ceil(width / BUCKET) + 1;
  const buckets: Block[][] = Array.from({ length: nBuckets }, () => []);
  for (const b of a.blocks) {
    const from = Math.max(0, Math.floor((b.box.left - HALF_W) / BUCKET));
    const to = Math.min(nBuckets - 1, Math.floor((b.box.right + HALF_W) / BUCKET));
    for (let i = from; i <= to; i++) buckets[i]!.push(b);
  }
  const out: Array<{ gx: number; gy: number; blocks: Block[] }> = [];
  const focus = { x: 0, y: 0, halfW: HALF_W, bodyH: BODY_H };
  const minX = Math.min(...a.rooms.map((r) => r.x));
  const maxX = Math.max(...a.rooms.map((r) => r.x + r.w));
  const minY = Math.min(...a.rooms.map((r) => r.y));
  const maxY = Math.max(...a.rooms.map((r) => r.y + r.h));
  for (let gy = minY; gy <= maxY; gy += STEP) {
    for (let gx = minX; gx <= maxX; gx += STEP) {
      if (!standable(a, gx, gy, brim)) continue;
      focus.x = gx;
      focus.y = gy;
      const blocks = buckets[Math.min(nBuckets - 1, Math.floor(gx / BUCKET))]!.filter(
        (b) => occludes(b.box, focus) && needsDeepFade(b.box, focus),
      );
      if (blocks.length > 0) out.push({ gx, gy, blocks });
    }
  }
  return out;
}

describe('arena occlusion coverage — the launch map, swept', () => {
  it('is looking at a real amount of floor, and the x-ray bucketing cannot miss a block', () => {
    expect(SWEPT.length).toBeGreaterThan(60_000); // measured 72,686 standable samples
    expect(LAUNCH.blocks.length).toBeGreaterThan(300); // 288 runs + 113 pillars
    // The optimisation this sweep needs to be affordable, checked rather than assumed: a body is
    // only 2*HALF_W wide, so a block outside the sample's own 128 px column can never reach it.
    expect(HALF_W * 2).toBeLessThan(128);
    // A brute-force cross-check on one band of the map: same answers with no bucketing at all.
    const band = SWEPT.filter((s) => s.gy === 1000);
    expect(band.length).toBeGreaterThan(100);
    for (const s of band) {
      const all = LAUNCH.blocks.filter((b) => occludes(b.box, { x: s.gx, y: s.gy, halfW: HALF_W, bodyH: BODY_H }));
      expect(all.length, `bucketing lost a block at ${s.gx},${s.gy}`).toBe(s.fired.length);
    }
  });

  it('EVERY hidden spot fires the x-ray — no blind spot on the arena either', () => {
    // The bug, generalised. One position that reaches this list is one more screenshot.
    const missed = SWEPT.filter((s) => s.covered >= HIDDEN_FRACTION && s.fired.length === 0).map(
      (s) => `${s.room} at (${s.gx}, ${s.gy}) covered ${(s.covered * 100) | 0}%`,
    );
    expect(missed).toEqual([]);
  });

  it('never fires where the character is not covered at all', () => {
    const spurious = SWEPT.filter((s) => s.covered === 0 && s.fired.length > 0).map(
      (s) => `${s.room} at (${s.gx}, ${s.gy})`,
    );
    expect(spurious).toEqual([]);
  });

  it('every block it fires for is one really covering the character', () => {
    for (const s of SWEPT) {
      for (const b of s.fired) {
        expect(b.box.sortY, `${s.room} at (${s.gx}, ${s.gy})`).toBeGreaterThan(s.gy);
        expect(b.box.top).toBeLessThan(s.gy);
        expect(s.gx + HALF_W).toBeGreaterThan(b.box.left);
        expect(s.gx - HALF_W).toBeLessThan(b.box.right);
      }
    }
  });

  it('a KERB never fires, from anywhere on this map either', () => {
    // The claim `MIN_COVER_FRACTION` exists for, re-asked on a map where kerbs are the shape of
    // every horizontal room boundary rather than an occasional pairing: 64 kerb runs, and the
    // player walks along one at the south edge of nearly every room.
    const kerbs = SWEPT.filter((s) => s.fired.some((b) => b.tier === 'kerb')).map(
      (s) => `${s.room} at (${s.gx}, ${s.gy})`,
    );
    expect(kerbs).toEqual([]);
    expect(LAUNCH.blocks.some((b) => b.tier === 'kerb')).toBe(true);
  });

  it('a PERIMETER run fires only from BEYOND its own end, never from the room floor it bounds', () => {
    // What stops a room's own boundary fading while the player walks along it. On the arena the
    // "beyond its own end" ground is a passage between two rooms — 74 of them — and that makes
    // this count a second reading of the passage clip: it was 3255 samples while a perimeter run's
    // cap still spilled across the thresholds, and 20 once the clip took those caps back
    // (2026-08-26). So the invariant is the `insideFootprint` list, and the count is bounded from
    // ABOVE rather than below: perimeter runs going back to fading over open passages is the
    // regression this catches, and a floor with no clipped passage at all would read as 0 here
    // without the emptiness meaning anything. `pillar`/`interior` firings are unaffected (5435 and
    // 4610), which is what says the drop is the clip and not the sweep losing its subject.
    const hits = SWEPT.flatMap((s) => s.fired.filter((b) => b.tier === 'perimeter').map((b) => ({ s, b })));
    expect(hits.length).toBeLessThan(200); // measured 20, down from 3255
    expect(SWEPT.flatMap((s) => s.fired).filter((b) => b.tier !== 'perimeter').length).toBeGreaterThan(1000);
    const insideFootprint = hits
      .filter((h) => h.s.gy >= h.b.rect.y)
      .map((h) => `${h.s.room} at (${h.s.gx}, ${h.s.gy})`);
    expect(insideFootprint).toEqual([]);
  });

  it('fades at most TWO wall blocks at once — but four PILLARS at one spot', () => {
    // `occlusionCoverage.test.ts` asserts at most 2 blocks fade together, so that a room never
    // dissolves. Walls alone hold that here (an L corner is two and the arena adds no third).
    // PILLARS do not: an interior kit that places a 2x2 colonnade cluster puts four pillar arts
    // over one character standing in its middle. Exactly one sample of 72,686 reaches four, and
    // 583 reach two — so this is a specific piece of authored furniture, not a general property,
    // and a pillar fades WHOLE where a wall keeps its face. Whether it reads as four columns
    // going hazy or as a hole in the room is a camera question, which is why the number is
    // recorded here with the shape that produces it rather than smoothed into a looser bound.
    const worstWalls = Math.max(...SWEPT.map((s) => s.fired.filter((b) => b.tier !== 'pillar').length));
    expect(worstWalls).toBeLessThanOrEqual(2);
    const worstAll = Math.max(...SWEPT.map((s) => s.fired.length));
    expect(worstAll).toBe(4);
    const four = SWEPT.filter((s) => s.fired.length >= 4);
    expect(four).toHaveLength(1);
    expect(four[0]!.fired.every((b) => b.tier === 'pillar')).toBe(true);
    // ...and it is a cluster, not a fan: all four sit within one grid cell of the sample.
    for (const b of four[0]!.fired) {
      expect(Math.abs(b.rect.x - four[0]!.gx)).toBeLessThan(PX_PER_GRID * 3);
      expect(Math.abs(b.rect.y - four[0]!.gy)).toBeLessThan(PX_PER_GRID * 3);
    }
  });

  it('leaves the character more than half visible everywhere, and always keeps the head', () => {
    // The acceptance criterion the whole x-ray is judged on, re-measured on content that triggers
    // it three times as often as a PvE floor. Worst case here 43.8% still hidden — the same worst
    // case the PvE sweep reports, which is what a shared bound looks like when it is really the
    // geometry's own limit rather than a property of one level.
    const worst = SWEPT.filter((s) => s.hiddenAfter > 0.5)
      .slice(0, 8)
      .map((s) => `${s.room} at (${s.gx}, ${s.gy}) still ${(s.hiddenAfter * 100) | 0}% hidden`);
    expect(worst).toEqual([]);
    expect(Math.max(...SWEPT.map((s) => s.hiddenAfter))).toBeLessThan(HIDDEN_FRACTION);
    // Which half survives is not a detail: a body is drawn upward from its ground point, so what
    // a block covers is always the BOTTOM of it.
    const headless = SWEPT.filter((s) => s.covered >= 1 && s.hiddenAfter > 0 && s.hiddenAfter >= s.covered).map(
      (s) => `${s.room} at (${s.gx}, ${s.gy})`,
    );
    expect(headless).toEqual([]);
  });

  it('no longer takes the deep pass ANYWHERE — the v47 brim removed every case this map had', () => {
    // The deep pass is the fallback that drops a block's front FACE as well as its cap, revealing
    // whatever stands behind the wall. It is the ugliest thing the x-ray can do, and until v47 the
    // launch arena was where it happened most: 1.07% of standable floor, seven times a PvE floor's
    // 0.2% (`occlusionCoverage.test.ts`, which still measures it there).
    //
    // It is now ZERO here, and that is a CONSEQUENCE, not a target. `needsDeepFade` fires on tall
    // art over a shallow footprint, and on this map that shape is exactly the interior kit block:
    // 70 px of art over a footprint one grid cell deep. The v47 north brim moves the player far
    // enough out that a block's front face stops covering any of them, so the cap fade alone now
    // does the whole job — on a map where 108 of 494 wall rects are free-standing (106 of 492 before the 2026-09-30 pocket fill, 119 of 505 with it until the kits stopped sealing rooms the same day).
    //
    // A test that only asserted `=== 0` would stay green if the sweep silently stopped finding
    // anything at all, which is the failure mode this file exists to catch. So it is asserted
    // against a CONTROL: the same scan with the brim disabled, i.e. the pre-v47 reachability.
    const withBrim = deepPassHits(BRIM);
    const control = deepPassHits(0);
    expect(withBrim).toHaveLength(0);

    // The control has to find the cases the brim removed, at roughly the rate this file recorded
    // before — otherwise the zero above is measuring a broken sweep, not a fixed map.
    expect(control.length).toBeGreaterThan(0);
    expect(control.length / SWEPT.length).toBeGreaterThan(0.005);
    expect(control.length / SWEPT.length).toBeLessThan(0.02);

    // ...and every one of them is an INTERIOR block, which is WHY the brim could remove them all:
    // a perimeter run or a kerb is not free-standing and keeps its exact-footprint collision, so a
    // single deep-pass case on one of those would have survived into `withBrim`.
    const tiers = new Set(control.flatMap((h) => h.blocks.map((b) => b.tier)));
    expect([...tiers]).toEqual(['interior']);
    // 30s, and ONLY on this case. It is the one test in the client that sweeps the whole launch
    // map TWICE (once with the brim, once without, for the control above), and v8 coverage
    // instrumentation costs it 13x: 623 ms bare, 8.4 s under `--coverage`, i.e. it passes the
    // normal run and times out at vitest's 5 s default the moment coverage is on. Raising the
    // GLOBAL timeout instead would have been the cheaper edit and the wrong one — it would give
    // every one of the other 4,658 cases two minutes to hang before saying so, and a hang that
    // eventually reports is exactly the failure this repo's mutation work keeps mistaking for a
    // kill. So the exemption stays where the cost is.
  }, 30_000);

  // The three tests that used to live here — that the deep pass never fires below the band
  // `deepFadeReach` keeps opaque, that it leaves ZERO rows of the body buried, and how much of the
  // face it keeps — measured the deep pass against real content. They moved out rather than being
  // loosened: with no deep-pass sample left on this map they would assert over an empty set and
  // pass no matter what the rule did. All three are still made against real content by the PvE
  // sweep (`occlusionCoverage.test.ts`, which still reports deep-pass samples because a PvE
  // floor's cases are on PERIMETER runs — 104 px over a 32 px footprint — and a perimeter run
  // never carries `freeStanding`, so the brim does not reach it), and the rule itself stays
  // unit-tested in `occlusion.test.ts`.

  it('reports how much of this map hides the player at all — three times a PvE floor', () => {
    // The number the pass is judged by, kept in the suite rather than only in a commit message:
    // 12.3% of standable floor leaves the player at least half hidden and 7.8% leaves them
    // COMPLETELY invisible before the x-ray, against 5.4% and 3.3% on the five PvE floors. Both
    // were 16.7% and 11.6% until the passage clip (2026-08-26) took a wall height off 44 runs. The
    // arena is denser (113 pillars, 25 interior kits, colonnade rooms whose whole point is
    // cover), so more of it is behind stone by design — what this bounds is the sweep, not the
    // level: zero would mean the x-ray has become dead weight, and half the floor would mean the
    // measurement is wrong rather than the map.
    const half = SWEPT.filter((s) => s.covered >= HIDDEN_FRACTION).length / SWEPT.length;
    const full = SWEPT.filter((s) => s.covered >= 1).length / SWEPT.length;
    expect(half).toBeGreaterThan(0.05);
    expect(half).toBeLessThan(0.3);
    expect(full).toBeGreaterThan(0.03);
    expect(full).toBeLessThan(0.25);
    // And where it is concentrated, because that is the camera list: the worst room is a small
    // colonnade cell whose pillars cover 44% of its own standable floor (61% before the passage
    // clip), and three rooms have none. The bound sits well under today's number on purpose — it
    // is here to catch a room going mostly-hidden, not to be re-transcribed every time the
    // geometry moves.
    const perRoom = new Map<string, { n: number; full: number }>();
    for (const s of SWEPT) {
      const rec = perRoom.get(s.room) ?? { n: 0, full: 0 };
      rec.n++;
      if (s.covered >= 1) rec.full++;
      perRoom.set(s.room, rec);
    }
    const ranked = [...perRoom]
      .filter(([id]) => id !== '(none)')
      .map(([id, r]) => ({ id, frac: r.full / r.n }))
      .sort((a, b) => b.frac - a.frac);
    expect(ranked[0]!.frac).toBeGreaterThan(0.25); // cisterns_r1c3, 44.4%
    expect(ranked[0]!.frac).toBeLessThan(0.7); // ...and no room is mostly-hidden floor
    expect(ranked[ranked.length - 1]!.frac).toBeLessThan(0.05); // atrium_r3c4, 0%
    expect(perRoom.size).toBeGreaterThan(50); // the sweep reached nearly every room
  });
});

/* ---------------------------------------- the three DOOR sweeps, now that they have a subject here */

describe('arena passages — the clip rule that used to be dead code here', () => {
  // `doorStandCoverage`, `doorSpillCoverage` and `doorOcclusionCoverage` all sweep one subject:
  // `RoomBuilder`'s door-rect list. That list was built from `s.dungeonDoors` alone, and
  // `GameState` populates it only in dungeon mode — so on an arena it was EMPTY. `bordersDoorNorth`
  // was asked about an empty list and always answered no, `doorClip`/`effectiveWallHeight` never
  // executed, and 58 of the map's 74 authored passages stood under wall art with 36 buried
  // outright: a 96 px gap in a north-south perimeter wall sat entirely inside the 104 px of art the
  // run below it painted upward. Photographed before it was fixed, and the finding was that it did
  // not read as a bug — the courses ran on unbroken, so it looked like a wall somebody meant to
  // build. That makes it a READABILITY defect rather than a blemish: the map's own connectivity
  // graph was invisible, and 36 passages were places a player would never try to walk.
  //
  // Fixed 2026-08-26: `RoomBuilder.build` unions `s.arenaMap.doors` into that list, which both
  // clips the runs above a passage and paints `drawDoorWear`'s worn floor patch across it. Door
  // FIXTURES are deliberately NOT part of that — an arena `Door` is an adjacency record with no
  // lock and no leaf (design/15), fixtures are built from `DoorRuntime`s that `DoorSystem` locks
  // and `replay` serializes, and an arena passage is meant to stay open.
  //
  // This block used to end with a test that `doorFlankTier` — the rule that gave a door fixture
  // the height of the shortest wall it was cut into — would answer for all 74 passages at all
  // three tiers, kept as a standing measurement in case fixtures were ever wanted here. That rule
  // is gone (2026-09-03, `wallGeometry.DOOR_H`: every door stands at one height, whatever wall it
  // is cut into), and with it the question it was answering, so the test went with it rather than
  // being retargeted at a constant.

  it('the map authors 74 passages, and still builds no door FIXTURE for any of them', () => {
    const s = createGameState({ seed: 1, worldW: 1, worldH: 1, waves: [], arena: ARENA_CATALOG.arena_launch });
    expect(s.dungeonDoors).toHaveLength(0);
    expect(s.arenaMap?.doors).toHaveLength(74);
    // Reachable from the client with no engine change — `s.arenaMap` is the map itself — which is
    // what made the fix a `RoomBuilder` edit rather than a plumbing project. `passageGrid` is
    // ABSOLUTE (a room's `solids` are not), so it needs no room offset.
    expect(s.arenaMap?.doors[0]!.passageGrid).toBeDefined();
  });

  it('every authored passage really is a hole in the stone, inside a room rect', () => {
    // The premise the rest of this block rests on, and the one the predecessor map failed: on
    // `arena_prototype_60` the doors were logical-only. Here a passage overlapping a solid would
    // mean `perimeterSolids` did not carve it, and a passage outside every room rect would mean
    // the per-room floor (2026-08-26) paints no floor under it.
    for (const p of LAUNCH.passages) {
      const blocked = LAUNCH.walls.find(
        (w) =>
          Math.min(p.x + p.w, w.x + w.w) - Math.max(p.x, w.x) > 0.75 &&
          Math.min(p.y + p.h, w.y + w.h) - Math.max(p.y, w.y) > 0.75,
      );
      expect(blocked, `passage ${p.i} (${p.a}->${p.b}) is walled off`).toBeUndefined();
      const cx = p.x + p.w / 2;
      const cy = p.y + p.h / 2;
      expect(
        LAUNCH.rooms.some((r) => cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h),
        `passage ${p.i} (${p.a}->${p.b}) has no floor under it`,
      ).toBe(true);
    }
  });

  it('the REAL RoomBuilder clips every one of them: 58 covered passages -> 10, 0 buried', () => {
    // The call site, not the mirror. Every other test in this file rebuilds `RoomBuilder.build`'s
    // sequence by hand, which is what makes them readable and what makes them blind: this exact
    // fix was verified offline against that harness weeks before it was wired, and the harness
    // reported the same numbers with the shipping code doing nothing at all. So this one drives
    // the real `build()` against the real map and reads the occluders it registered.
    //
    // The occluder list is filled in build order — one per merged wall run, then the doors (none
    // here), then the pillars — so the first `wallEntities.length` entries are the wall blocks,
    // which is the subject: what a passage is buried UNDER is the run standing south of it.
    const layers = new Layers();
    const rb = new RoomBuilder(layers, new Backdrop(layers));
    const s = createGameState({ seed: 1, worldW: 1, worldH: 1, waves: [], arena: ARENA_CATALOG.arena_launch });
    rb.build(s);
    const inner = rb as unknown as { occluders: Array<{ box: Occluder }>; wallEntities: unknown[] };
    expect(inner.wallEntities).toHaveLength(288);
    expect(inner.occluders).toHaveLength(288 + 113); // ...and nothing else: zero door fixtures
    const wallBoxes = inner.occluders.slice(0, inner.wallEntities.length).map((o) => o.box);

    let covered = 0;
    let buried = 0;
    let worst = 0;
    const worstOf: string[] = [];
    for (const p of LAUNCH.passages) {
      let px = 0;
      for (const b of wallBoxes) {
        if (b.sortY <= p.y) continue;
        const ox = Math.min(b.right, p.x + p.w) - Math.max(b.left, p.x);
        const oy = Math.min(b.sortY, p.y + p.h) - Math.max(b.top, p.y);
        if (ox > 0.75 && oy > 0.75) px = Math.max(px, oy);
      }
      if (px > 0) covered++;
      if (px >= p.h - 0.75) buried++;
      if (px > 0) worstOf.push(`${p.i} ${p.a}->${p.b} ${px}px of ${p.h}`);
      worst = Math.max(worst, px);
    }
    // Reverting the union in `RoomBuilder.build` puts these back to 58 / 36 / 104 px, so these
    // three lines are the fix's own regression test — and the reason they are not a bare `0` is
    // that 10 passages keep a strip of the run beside them, worst 40 px of a 96 px gap.
    expect(buried, worstOf.join('; ')).toBe(0);
    expect(covered).toBeLessThanOrEqual(12); // measured 10
    expect(worst).toBeLessThanOrEqual(48); // measured 40, from 104

    // ...and the other half of the same fix: the worn floor patch, which is the cue that says a
    // hole in the stone is a threshold. Asserted by AIM rather than by count — every passage
    // centre must have its own stack of `drawDoorWear` bands centred on it, so a version that
    // painted 296 ellipses in the wrong place, or 295 in the right one, fails here.
    // Every additive piece of the layer, not one shared Graphics: since 2026-08-26 the ground is
    // mounted one piece per room (per door) so the camera can cull it — `groundCulling.ts`. Sweeping
    // all of them is the stronger form of this check anyway, because a wear patch that landed in the
    // wrong PIECE would still be caught by where it is AIMED, which is what this asserts.
    const additive = layers.ground.children.filter((c): c is Graphics => c instanceof Graphics && c.blendMode === 'add');
    expect(additive.length).toBeGreaterThanOrEqual(LAUNCH.passages.length);
    const ellipses = additive.flatMap((g) => g.context.instructions).flatMap((ins) => {
      const path = (ins as unknown as { data?: { path?: { instructions?: Array<{ action: string; data: number[] }> } } })
        .data?.path?.instructions;
      return (path ?? []).filter((i) => i.action === 'ellipse').map((i) => ({ cx: i.data[0]!, cy: i.data[1]! }));
    });
    const missing: string[] = [];
    let onPassage = 0;
    for (const p of LAUNCH.passages) {
      const cx = p.x + p.w / 2;
      const cy = p.y + p.h / 2;
      const bands = ellipses.filter((e) => Math.abs(e.cx - cx) < 0.5 && Math.abs(e.cy - cy) < 0.5).length;
      onPassage += bands;
      if (bands < 4) missing.push(`passage ${p.i} (${p.a}->${p.b}) has ${bands} wear bands`);
    }
    expect(missing).toEqual([]);
    expect(onPassage).toBe(4 * LAUNCH.passages.length); // 296 — `WEAR_BANDS` each, and no strays
  });

  it('and the sweep agrees once the PILLARS are counted too: 58 covered -> 20, none fully', () => {
    // The same question the harness asks, which differs from the test above in one way that
    // matters: it counts the pillar art as well, and half the residual is pillars. So the two
    // numbers are not a discrepancy — 10 passages keep part of a wall run, and 10 more (a
    // different 10 — no passage is in both lists) stand under the shading of a colonnade pillar
    // placed beside them by an interior kit. The clip rule cannot fix those; a kit edit could.
    const cover = (p: RectPx): { px: number; kind: string } => {
      let px = 0;
      let kind = '';
      for (const b of LAUNCH.blocks) {
        if (b.box.sortY <= p.y) continue;
        const ox = Math.min(b.box.right, p.x + p.w) - Math.max(b.box.left, p.x);
        const oy = Math.min(b.box.sortY, p.y + p.h) - Math.max(b.box.top, p.y);
        if (ox > 0.75 && oy > 0.75 && oy > px) {
          px = oy;
          kind = b.tier;
        }
      }
      return { px, kind };
    };
    const measured = LAUNCH.passages.map((p) => ({ p, ...cover(p) }));
    const buried = measured.filter((m) => m.px >= m.p.h - 0.75);
    const partly = measured.filter((m) => m.px > 0 && m.px < m.p.h - 0.75);
    expect(buried.map((m) => `${m.p.i} ${m.p.a}->${m.p.b}`)).toEqual([]); // was 36
    expect(partly.length).toBeLessThanOrEqual(24); // measured 20, from 58
    // The split, recorded because it is the whole reason the residual is not zero — and bounded
    // both ways, so a regression that put wall art back over the passages cannot hide inside it.
    expect(measured.filter((m) => m.px > 0 && m.kind === 'pillar').length).toBeGreaterThan(5); // 10
    expect(measured.filter((m) => m.px > 0 && m.kind !== 'pillar').length).toBeLessThanOrEqual(12); // 10, from 50
    expect(Math.max(0, ...measured.map((m) => m.px))).toBeLessThanOrEqual(64); // 55.6, a pillar
    // "a different 10" as an assertion rather than a claim in a comment: a passage under a pillar
    // has no wall over it at all, which is what makes the two residuals separate problems.
    const wallOnly = (p: RectPx): number => {
      let px = 0;
      for (const b of LAUNCH.blocks) {
        if (b.tier === 'pillar' || b.box.sortY <= p.y) continue;
        const ox = Math.min(b.box.right, p.x + p.w) - Math.max(b.box.left, p.x);
        const oy = Math.min(b.box.sortY, p.y + p.h) - Math.max(b.box.top, p.y);
        if (ox > 0.75 && oy > 0.75) px = Math.max(px, oy);
      }
      return px;
    };
    const both = measured
      .filter((m) => m.kind === 'pillar' && wallOnly(m.p) > 0)
      .map((m) => `${m.p.i} ${m.p.a}->${m.p.b}`);
    expect(both).toEqual([]);
  });

  it("holds the clip's own invariant on 44 arena runs, 21 of them the SHALLOW case", () => {
    // `doorSpillCoverage.test.ts` checks this on the five PvE floors' 12 clipped runs. Here it is
    // 44, and 21 of them are the shallow case `effectiveWallHeight` exists for (a run whose
    // footprint is shallower than its tier stands, whose FACE alone spills once the cap is
    // clipped) — PvE has 12 in total. Read off `LAUNCH.joins`, which the harness now populates
    // through `bordersDoorNorth` exactly as `RoomBuilder` does.
    const clipped = LAUNCH.runs.filter((_, i) => LAUNCH.joins[i]!.doorClip);
    expect(clipped).toHaveLength(44); // the rule matches this content, and this much of it
    let shallow = 0;
    for (const [i, run] of LAUNCH.runs.entries()) {
      const joins = LAUNCH.joins[i]!;
      if (!joins.doorClip) continue;
      const tierHeight = wallHeight(run.tier);
      if (run.rect.h <= tierHeight) shallow++;
      // The same two calls in the same order `RoomBuilder.build` makes them: the height first (it
      // may shrink), then the cap fed THAT result — never the raw tier height.
      const height = effectiveWallHeight(run.rect, tierHeight, joins);
      const capTop = blockCapTop(run.rect, height, joins);
      expect(run.rect.y + run.rect.h - height).toBeGreaterThanOrEqual(run.rect.y - 0.001); // face
      expect(run.rect.y + run.rect.h + capTop).toBeGreaterThanOrEqual(run.rect.y - 0.001); // cap
      expect(capTop).toBeLessThanOrEqual(-height); // never an inverted cap
    }
    expect(shallow).toBe(21);
    // The control this needs to not be vacuous: `NO_JOINS` on the same runs really does spill.
    const spilling = LAUNCH.runs.filter(
      (run) => run.rect.y + run.rect.h + blockCapTop(run.rect, wallHeight(run.tier), NO_JOINS) < run.rect.y - 0.001,
    );
    expect(spilling.length).toBeGreaterThan(100);
  });

});

describe('arena walls — the sides that end at nothing', () => {
  const sided = (v: VoidEdges) =>
    [
      ...v.east.map((span) => ({ side: 'east' as const, span })),
      ...v.west.map((span) => ({ side: 'west' as const, span })),
    ];
  const ALL = LAUNCH.voids.flatMap((v, i) =>
    sided(v).map((e) => ({ ...e, rect: LAUNCH.runs[i]!.rect, tier: LAUNCH.runs[i]!.tier })),
  );

  it('fires, and on both the empty slots and the map\'s own outer silhouette', () => {
    // The predicate this whole pass rests on, measured against the map it was written for
    // rather than against the fixture it was designed on — `wallGeometry`'s old `w > h` guard
    // is this file's founding example of a rule that reads correctly and matches nothing.
    const east = LAUNCH.voids.filter((v) => v.east.length > 0).length;
    const west = LAUNCH.voids.filter((v) => v.west.length > 0).length;
    expect(east, 'runs whose east side ends at nothing').toBeGreaterThan(30);
    expect(west, 'runs whose west side ends at nothing').toBeGreaterThan(30);
    // Both halves of the finding are present: the twelve deliberately-empty slots AND the
    // outer boundary, which is the same rule at the map's edge (`gap` is unbounded there).
    expect(ALL.some((s) => Number.isFinite(s.span.gap)), 'an interior empty slot').toBe(true);
    expect(ALL.some((s) => !Number.isFinite(s.span.gap)), 'the outer silhouette').toBe(true);
  });

  it('finds the END-ON case that a boolean answer would have dropped', () => {
    // An east-west run meeting an empty slot with its END: part of its side is void and part
    // abuts stone. This is the "端头" the camera list named, and the only reason `VoidEdges`
    // carries spans instead of two booleans — so if this count is ever zero, the span
    // machinery is dead weight and the simpler shape is the right one.
    const partial = ALL.filter((s) => s.span.to - s.span.from < s.rect.h - 1);
    expect(partial.length, 'partly-void sides').toBeGreaterThan(5);
    // ...and they really are the ends of long east-west runs, not slivers of a perimeter.
    expect(partial.some((s) => s.rect.w > s.rect.h * 4)).toBe(true);
  });

  it('never reaches its return onto a floor or another block\'s stone', () => {
    // The property the whole thing has to have: the return is drawn OUTSIDE the footprint, so
    // a wrong span is stone painted over a room someone is standing in. Checked as geometry
    // against what the ground layer paints, not by trusting the predicate that produced it.
    for (const { side, span, rect } of ALL) {
      const reach = Number.isFinite(span.gap) ? Math.min(VOID_RETURN_PX, span.gap / 2) : VOID_RETURN_PX;
      const x0 = side === 'east' ? rect.x + rect.w : rect.x - reach;
      const box = { x: x0, y: rect.y + span.from, w: reach, h: span.to - span.from };
      for (const other of [...LAUNCH.floors, ...LAUNCH.runs.map((r) => r.rect)]) {
        if (other === rect) continue;
        const ox = Math.min(box.x + box.w, other.x + other.w) - Math.max(box.x, other.x);
        const oy = Math.min(box.y + box.h, other.y + other.h) - Math.max(box.y, other.y);
        expect(Math.min(ox, oy), `${side} return at ${box.x},${box.y} over ${other.x},${other.y}`)
          .toBeLessThanOrEqual(0.75);
      }
    }
  });

  it('has room to spare on every void here, so the reach clamp is inert', () => {
    // Stated as a fact about the CONTENT rather than as a property of the code: the clamp
    // exists for a map that has not been authored yet. `ember_l1` floor 2 is the one that gets
    // anywhere near it — see `wallComposition.test.ts`, where the margin is exactly zero.
    const tightest = Math.min(...ALL.map((s) => s.span.gap));
    expect(tightest).toBeGreaterThanOrEqual(2 * VOID_RETURN_PX);
    expect(tightest, 'arena_launch is nowhere near the clamp').toBeGreaterThan(8 * VOID_RETURN_PX);
  });

  it('is a PERIMETER-tier phenomenon, which is what says the rule is scoped right', () => {
    // An interior block is surrounded by its own room's floor and can never have a free side;
    // a kerb has a room's floor immediately north of it, which says nothing about east/west,
    // so both tiers appearing here would be fine and only `interior` must not.
    expect(ALL.filter((s) => s.tier === 'interior')).toEqual([]);
  });
});

describe('the real RoomBuilder draws the returns, and off the right model', () => {
  it('builds one on every free side of the launch map, and nowhere else', () => {
    // The call site, not the pipeline mirror above. Both of this pass's two RoomBuilder mutants
    // — dropping the `voids` argument, and feeding `voidEdges` the ROOM rects instead of the
    // painted floor — survived the entire suite until this test and the one below existed: every
    // other check reaches `voidEdges` directly, so nothing noticed whether `RoomBuilder` called
    // it at all. Same gap the 2026-08-26 floor-partition battery found with `cellExtent`'s axes
    // swapped AT the call site.
    const layers = new Layers();
    const rb = new RoomBuilder(layers, new Backdrop(layers));
    const s = createGameState({ seed: 1, worldW: 1, worldH: 1, waves: [], arena: ARENA_CATALOG.arena_launch });
    rb.build(s);
    const inner = rb as unknown as { wallEntities: Array<{ children: Array<{ label: string }> }> };
    // A block's CAP is the only thing tagged `XRAY_LABEL` before the return exists (one layer
    // here, where no swatch loads); a return adds its surface and its falloff to the same group.
    const withReturn = inner.wallEntities.filter(
      (e) => e.children.filter((c) => c.label === XRAY_LABEL).length > 1,
    ).length;
    const expected = LAUNCH.voids.filter((v) => v.east.length > 0 || v.west.length > 0).length;
    expect(expected).toBeGreaterThan(50); // the sweep's own count, so this cannot go vacuous
    expect(withReturn).toBe(expected);
  });

  it('asks the FLOOR model, so a mode that paints the whole box grows no returns', () => {
    // `landing_basic` is the shipped case where `roomRectsPx` and `floorRegionsPx` genuinely
    // disagree: three 320 px rooms against a 1600 px box of painted floor. It authors no walls,
    // so one is poked in where no ROOM is but floor certainly is — which is exactly the
    // configuration that separates the two arguments, and the only reachable one.
    const layers = new Layers();
    const rb = new RoomBuilder(layers, new Backdrop(layers));
    const s = createGameState({ seed: 1, worldW: 1, worldH: 1, waves: [], arena: ARENA_CATALOG.landing_basic });
    const W = fpToPx(s.worldW);
    const H = fpToPx(s.worldH);
    // The precondition, asserted rather than assumed — if a future `landing_basic` covered its
    // own box this test would pass while checking nothing.
    expect(floorRegionsPx(s, W, H)).toEqual([{ x: 0, y: 0, w: W, h: H }]);
    expect(roomRectsPx(s, W, H).length).toBe(3);
    // fp is 1000 per grid (`engine/math/fixed.FP_SCALE`) and a grid is `PX_PER_GRID` px, so this
    // is a 1x10 grid wall at grid (20, 20) — px (640, 640, 32, 320), clear of all three rooms.
    const FP_PER_GRID = 1000;
    (s.walls as unknown as Array<{ x: number; y: number; w: number; h: number }>).push({
      x: 20 * FP_PER_GRID, y: 20 * FP_PER_GRID, w: FP_PER_GRID, h: 10 * FP_PER_GRID,
    });
    rb.build(s);
    const inner = rb as unknown as { wallEntities: Array<{ children: Array<{ label: string }> }> };
    expect(inner.wallEntities).toHaveLength(1);
    expect(inner.wallEntities[0]!.children.filter((c) => c.label === XRAY_LABEL)).toHaveLength(1);
    // ...and the room model really would have said otherwise, so the assertion above is a choice
    // being tested and not a property both arguments happen to share.
    const rect = { x: 20 * PX_PER_GRID, y: 20 * PX_PER_GRID, w: PX_PER_GRID, h: 10 * PX_PER_GRID };
    expect(voidEdges(rect, [rect], roomRectsPx(s, W, H)).east).not.toEqual([]);
  });

  it('fades the return WITH the cap when the x-ray dissolves a block', () => {
    // `addVoidReturns` tags its children `XRAY_LABEL`; `xrayLayers` filters on that label and
    // `fadeableBlock` captures each layer's base alpha. Everything about that is a CONTRACT
    // between three files, and the unit test only pins one end of it — a label. What this asks
    // is whether a real fade actually reaches the return, because a return left solid beside a
    // dissolved cap reads as a second object standing in the void.
    const layers = new Layers();
    const rb = new RoomBuilder(layers, new Backdrop(layers));
    const s = createGameState({ seed: 1, worldW: 1, worldH: 1, waves: [], arena: ARENA_CATALOG.arena_launch });
    rb.build(s);
    const inner = rb as unknown as {
      wallEntities: Array<{ children: Array<{ label: string; alpha: number }> }>;
      occluders: Array<{ cap: { apply(fade: number): void } }>;
    };
    const i = inner.wallEntities.findIndex(
      (e) => e.children.filter((c) => c.label === XRAY_LABEL).length > 1,
    );
    expect(i, 'a block with a return to fade').toBeGreaterThanOrEqual(0);
    const faded = inner.wallEntities[i]!.children.filter((c) => c.label === XRAY_LABEL);
    expect(faded.every((c) => c.alpha === 1)).toBe(true);
    inner.occluders[i]!.cap.apply(0.25);
    // Every one of them, not just the cap that was already in the group before this pass.
    for (const c of faded) expect(c.alpha).toBeCloseTo(0.25, 6);
  });

  it('and no shipped passage sits on a free side, so a DOOR needing one cannot arise', () => {
    // `doorRender.buildDoorBlock` is deliberately not wired to any of this: a door joins two
    // rooms, so both of its sides have a room's floor against them by construction. Asserted
    // rather than assumed, WITH the count, because "we did not wire it" and "it can never come
    // up" look identical in a diff — and if a map ever authors a passage in an outer wall this
    // goes red the day it lands instead of drawing a doorway that ends in a cliff.
    const rects = LAUNCH.runs.map((r) => r.rect);
    let checked = 0;
    for (const p of LAUNCH.passages) {
      const v = voidEdges({ x: p.x, y: p.y, w: p.w, h: p.h }, rects, LAUNCH.floors);
      expect(v.east, `passage ${p.i} ${p.a}->${p.b} east`).toEqual([]);
      expect(v.west, `passage ${p.i} ${p.a}->${p.b} west`).toEqual([]);
      checked++;
    }
    expect(checked).toBe(74);
  });
});
