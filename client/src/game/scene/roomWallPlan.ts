// Split out of RoomBuilder.build 2026-09-28 (500-line convention, CLAUDE.md form 1): the wall
// GEOMETRY of one floor — which rects stand, merged how, joined how, ending where — as one pure
// function over the state. RoomBuilder turns the answer into display objects; nothing here makes
// one, which is also what lets a descend compute it in one step and build from it over several.
import type { GameState } from '@dd/engine';
import { fpToPx, PX_PER_GRID } from '../coords';
import { wallTier, type RectPx } from './wallGeometry';
import { bordersDoorNorth, mergeWallRuns, wallJoins, type WallRun } from './wallRuns';
import { floorRegionsPx, roomRectsPx } from './groundLayer';
import { voidEdges } from './wallVoidEdge';
import { faceCrownFraction } from './wallTone';
import type { BiomeElement } from '../theme';

/** Everything `planRoomWalls` works out, index-aligned where it says so. */
export interface RoomWallPlan {
  /** Room footprints in world px (room IDENTITY) — `groundLayer.roomRectsPx`. */
  roomsPx: RectPx[];
  /** Where the floor is painted — `groundLayer.floorRegionsPx`. */
  floorsPx: RectPx[];
  /** Px rects of `s.dungeonDoors`, index-aligned with it. */
  doorRectsPx: RectPx[];
  /** Every passage the wall art must stay off: the dungeon doors plus an arena's own. */
  passageRectsPx: RectPx[];
  /** The standing runs, tiered then merged. */
  merged: WallRun[];
  /** Per merged run: its joins (with `doorClip` folded in) and its void edges. */
  joins: ReturnType<typeof wallJoins>;
  voids: ReturnType<typeof voidEdges>[];
}

export function planRoomWalls(s: GameState, w: number, h: number, element: BiomeElement): RoomWallPlan {
  // The ground layer — floor, its variation, the grid, the room light — is `groundLayer.ts`
  // (split out 2026-08-20, 500-line convention). It is painted AFTER the wall/door geometry below
  // is worked out, because the decals need the merged wall footprints (rubble must not sit on a
  // wall's own footprint) and the door rects (the worn patch across a doorway).
  const roomsPx = roomRectsPx(s, w, h);

  // AABB walls (ROADMAP 1.2 — finally drawn): a tiled swatch + outline once wall art
  // exists for this element, else the same flat fill + outline as before. A
  // currently-locked door's passage rect lives in `s.walls` too (DoorSystem folds it
  // in while locked) but must render as a door fixture, not a generic wall segment —
  // `doorAabbs` is a reference-identity set (DoorSystem pushes the SAME `passageAabb`
  // object, never a copy) so this skip is exact and free for non-dungeon modes
  // (`dungeonDoors` is empty there).
  const doorAabbs = new Set(s.dungeonDoors.map((dr) => dr.passageAabb));
  // Px-space rects of every door passage, for `bordersDoorNorth` below — a door is never a
  // wall (it's skipped from `runs` just above), but it's a fixture standing in the room all
  // the same, and a run's cap must not be allowed to spill onto it (live report: the door
  // "随时清晰可见" — always clearly visible — was half swallowed by a run's cap standing south
  // of it, the exact "door passage between two rooms" case design/01 already called out).
  const doorRectsPx: RectPx[] = s.dungeonDoors.map((dr) => ({
    x: fpToPx(dr.passageAabb.x),
    y: fpToPx(dr.passageAabb.y),
    w: fpToPx(dr.passageAabb.w),
    h: fpToPx(dr.passageAabb.h),
  }));
  // Every passage the wall pass must keep its art off — NOT the same list: an arena authors its
  // passages as `arenaMap.doors` and never populates `dungeonDoors` (a `DoorRuntime` is
  // DoorSystem's lockable-fixture record; an arena passage has no lock and no leaf, design/15).
  // Until 2026-08-26 that left the list empty on every arena, so `bordersDoorNorth` always
  // answered no and the clip rule was dead code there — 58 of `arena_launch`'s 74 passages stood
  // under wall art, 36 buried outright; feeding them here takes it to 10, worst 40 px
  // (`arenaWallCoverage.test.ts`). `passageGrid` is ABSOLUTE grid, unlike a room's `solids`, so
  // no room offset. Fixtures still come only from `doorRectsPx`: an arena builds none.
  const passageRectsPx: RectPx[] = [
    ...doorRectsPx,
    ...(s.arenaMap?.doors ?? []).map((d) => ({
      x: d.passageGrid.x * PX_PER_GRID,
      y: d.passageGrid.y * PX_PER_GRID,
      w: d.passageGrid.w * PX_PER_GRID,
      h: d.passageGrid.h * PX_PER_GRID,
    })),
  ];
  // Tier FIRST, then merge same-tier neighbours into one mass (`wallRuns.ts`): adjacent rooms
  // each author their own perimeter wall, so a room boundary is two parallel 32 px rects and
  // drawing each as its own block put a lit-edge/dark-band seam down the middle of one stone
  // mass. Tier before merge, never after — see `mergeWallRuns` for why same-tier-only is
  // load-bearing rather than caution.
  const runs: WallRun[] = [];
  for (const wall of s.walls) {
    if (doorAabbs.has(wall)) continue;
    const rect: RectPx = { x: fpToPx(wall.x), y: fpToPx(wall.y), w: fpToPx(wall.w), h: fpToPx(wall.h) };
    runs.push({ rect, tier: wallTier(rect, roomsPx) });
  }
  // ...then, on the merged set, work out which edges are buried in an L/T corner. An L cannot
  // be merged (its union is not a rectangle), so without this every corner drew two blocks'
  // worth of "I end here" cues across one continuous stone top — see `wallJoins`.
  const merged = mergeWallRuns(runs);
  // The crown line a corner stops under is per-ELEMENT: the shipped face swatches disagree, ice
  // most of all (see `FACE_CROWN_ROWS`), so this has to come from the room's own biome.
  const joins = wallJoins(merged, faceCrownFraction(element));
  for (const [i, run] of merged.entries()) {
    if (bordersDoorNorth(run.rect, passageRectsPx)) joins[i] = { ...joins[i]!, doorClip: true };
  }
  // ...and which of their east/west sides end at NOTHING, which `wallJoins` cannot answer
  // because it only ever sees other walls: the question is about the floor as well as the
  // stone (`wallVoidEdge.ts`). Fed the regions the ground layer actually PAINTS rather than
  // `roomsPx`, since the two diverge in the fallback case — a mode with no usable room model
  // paints the whole world box and therefore has no interior void for a return to face.
  const mergedRects = merged.map((run) => run.rect);
  const floorsPx = floorRegionsPx(s, w, h);
  const voids = mergedRects.map((rect) => voidEdges(rect, mergedRects, floorsPx));
  return { roomsPx, floorsPx, doorRectsPx, passageRectsPx, merged, joins, voids };
}
