// Whether a straight shot between two points would reach — the PvP bot's check before it
// fires (2026-09-29). Bullets stop on pillars and walls (`ProjectileStepSystem`), and the
// engine faces a seat at its nearest hostile through any wall, so a bot that fired whenever it
// was in range spent whole matches shooting the pillar between it and its opponent. Tested the
// way the engine tests a bullet: the path, swept, against the solids near it.
//
// Pure function of GameState, like everything the bot does.
import { FP_SCALE, type Fp, type GameState } from '@dd/engine';
import { blockingRect, queryRadiusFor } from '@dd/engine/systems/solidBounds';
import type { Point } from './engage';

/** Spacing of the points tested along a shot — under every gun's per-tick travel. */
const STEP_FP = FP_SCALE / 4;
/** The body a shot has to clear: a typical bullet's radius. */
const SHOT_RADIUS_FP = 150;

/**
 * True when nothing solid lies between `from` and `to`, for a circle of `radius` swept along
 * the line: a shot by default, a body for `ai/steer.ts` (`body`, which also tests walls the way
 * `MovementSystem` does, see `pointClear`). The first and last `STEP_FP` of the line are not
 * tested, so a bot pressed against a face can still walk away from it and a target standing
 * against one can still be shot.
 *
 * One broadphase query for the whole segment and an exact distance per solid. It was a point
 * test every `STEP_FP`, two spatial queries each, and that made the line test the bot's
 * biggest cost once it steered (2026-09-29).
 */
export function lineOfFireClear(s: GameState, from: Point, to: Point, radius = SHOT_RADIUS_FP, body = false): boolean {
  const dx = to.gx - from.gx;
  const dy = to.gy - from.gy;
  const len = Math.hypot(dx, dy);
  if (len <= 2 * STEP_FP) return true;
  const trim = STEP_FP / len;
  const ax = from.gx + dx * trim;
  const ay = from.gy + dy * trim;
  const bx = to.gx - dx * trim;
  const by = to.gy - dy * trim;
  const mx = Math.round((ax + bx) / 2) as Fp;
  const my = Math.round((ay + by) / 2) as Fp;
  const reach = Math.ceil(len / 2 - STEP_FP + radius) as Fp;
  for (const idx of s.spatialIndex.queryObstacles(mx, my, reach)) {
    const o = s.obstacles[idx]!;
    if (segmentPointDist2(ax, ay, bx, by, o.gx, o.gy) <= (o.radius + radius) ** 2) return false;
  }
  for (const idx of s.spatialIndex.queryWalls(mx, my, body ? queryRadiusFor(reach) : reach)) {
    const w = s.walls[idx]!;
    const top = body ? blockingRect(w).top : w.y;
    if (segmentRectDist2(ax, ay, bx, by, w.x, top, w.x + w.w, w.y + w.h) <= radius * radius) return false;
  }
  return true;
}

/** Squared distance from point (px, py) to the segment a-b. */
function segmentPointDist2(ax: number, ay: number, bx: number, by: number, px: number, py: number): number {
  const vx = bx - ax;
  const vy = by - ay;
  const l2 = vx * vx + vy * vy;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / l2));
  const cx = ax + vx * t - px;
  const cy = ay + vy * t - py;
  return cx * cx + cy * cy;
}

/** Squared distance from the segment a-b to the rect [x0,x1]×[y0,y1]: 0 when it crosses the
 *  rect, else the least of the endpoints' distances to the rect and the corners' to the
 *  segment (two disjoint convex shapes are nearest at a vertex of one of them). */
function segmentRectDist2(ax: number, ay: number, bx: number, by: number, x0: number, y0: number, x1: number, y1: number): number {
  if (segmentCrossesRect(ax, ay, bx, by, x0, y0, x1, y1)) return 0;
  const toRect = (px: number, py: number) => (px - Math.max(x0, Math.min(px, x1))) ** 2 + (py - Math.max(y0, Math.min(py, y1))) ** 2;
  return Math.min(
    toRect(ax, ay),
    toRect(bx, by),
    segmentPointDist2(ax, ay, bx, by, x0, y0),
    segmentPointDist2(ax, ay, bx, by, x1, y0),
    segmentPointDist2(ax, ay, bx, by, x0, y1),
    segmentPointDist2(ax, ay, bx, by, x1, y1),
  );
}

/** Liang-Barsky: does the segment a-b pass through the rect? */
function segmentCrossesRect(ax: number, ay: number, bx: number, by: number, x0: number, y0: number, x1: number, y1: number): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = bx - ax;
  const dy = by - ay;
  for (const [p, q] of [[-dx, ax - x0], [dx, x1 - ax], [-dy, ay - y0], [dy, y1 - ay]] as const) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const r = q / p;
    if (p < 0) t0 = Math.max(t0, r);
    else t1 = Math.min(t1, r);
    if (t0 > t1) return false;
  }
  return true;
}

/**
 * True when a circle of `radius` (a shot's, by default) at (gx, gy) touches no pillar and no
 * wall. With `body`, a wall is its COLLISION rect (`blockingRect`): a free-standing block
 * stops a body most of a grid north of its authored edge, where a bullet flies on. Without
 * that, every straight line past a block's north face read clear and seats stood against it.
 */
export function pointClear(s: GameState, gx: number, gy: number, radius = SHOT_RADIUS_FP, body = false): boolean {
  const x = Math.round(gx) as Fp;
  const y = Math.round(gy) as Fp;
  const r = radius as Fp;
  for (const idx of s.spatialIndex.queryObstacles(x, y, r)) {
    const o = s.obstacles[idx]!;
    if ((o.gx - x) ** 2 + (o.gy - y) ** 2 <= (o.radius + r) ** 2) return false;
  }
  for (const idx of s.spatialIndex.queryWalls(x, y, body ? queryRadiusFor(r) : r)) {
    const w = s.walls[idx]!;
    const top = body ? blockingRect(w).top : w.y;
    const cx = Math.max(w.x, Math.min(x, w.x + w.w));
    const cy = Math.max(top, Math.min(y, w.y + w.h));
    if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) return false;
  }
  return true;
}
