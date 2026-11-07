/**
 * Line of sight for auto-aim (ENGINE_VERSION 91): is the straight segment between two points
 * free of every wall and pillar? Integer orientation tests only — no division, no sqrt — so it
 * is exact and identical on every client (design/06). Fp coordinates stay under ~10^6, so every
 * cross product below stays under ~10^12, far inside a double's exact-integer range.
 *
 * A pillar is tested as its bounding square, not its circle: the circle test needs a squared
 * cross product (~10^24, past exact range) or a sqrt, and the square only errs toward "blocked"
 * by a sliver at the pillar's corners, which for choosing a target is harmless.
 */
import type { Fp } from '../math/fixed';
import type { AABB } from '../state/entities';
import type { GameState } from '../state/GameState';

/** Sign of the cross product (b - a) × (c - a): which side of line a→b point c lies on. */
function orient(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  return Math.sign((bx - ax) * (cy - ay) - (by - ay) * (cx - ax));
}

/** Does segment p→q cross segment r→s (touching counts)? Collinear overlaps count too. */
function segmentsCross(px: number, py: number, qx: number, qy: number, rx: number, ry: number, sx: number, sy: number): boolean {
  const o1 = orient(px, py, qx, qy, rx, ry);
  const o2 = orient(px, py, qx, qy, sx, sy);
  const o3 = orient(rx, ry, sx, sy, px, py);
  const o4 = orient(rx, ry, sx, sy, qx, qy);
  if (o1 !== o2 && o3 !== o4) return true;
  const onSeg = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number): boolean =>
    Math.min(ax, bx) <= cx && cx <= Math.max(ax, bx) && Math.min(ay, by) <= cy && cy <= Math.max(ay, by);
  return (
    (o1 === 0 && onSeg(px, py, qx, qy, rx, ry)) ||
    (o2 === 0 && onSeg(px, py, qx, qy, sx, sy)) ||
    (o3 === 0 && onSeg(rx, ry, sx, sy, px, py)) ||
    (o4 === 0 && onSeg(rx, ry, sx, sy, qx, qy))
  );
}

/** Does segment a→b touch the rectangle [x, x+w] × [y, y+h]? */
export function segmentHitsRect(ax: number, ay: number, bx: number, by: number, x: number, y: number, w: number, h: number): boolean {
  const x2 = x + w;
  const y2 = y + h;
  // Bounding-box reject first: the common case, and it makes the edge tests below exhaustive.
  if (Math.max(ax, bx) < x || Math.min(ax, bx) > x2 || Math.max(ay, by) < y || Math.min(ay, by) > y2) return false;
  if (ax >= x && ax <= x2 && ay >= y && ay <= y2) return true; // an endpoint inside
  return (
    segmentsCross(ax, ay, bx, by, x, y, x2, y) ||
    segmentsCross(ax, ay, bx, by, x2, y, x2, y2) ||
    segmentsCross(ax, ay, bx, by, x2, y2, x, y2) ||
    segmentsCross(ax, ay, bx, by, x, y2, x, y)
  );
}

/** True when no wall and no pillar stands between (ax, ay) and (bx, by). */
export function hasLineOfSight(state: GameState, ax: Fp, ay: Fp, bx: Fp, by: Fp): boolean {
  for (const w of state.walls as readonly AABB[]) {
    if (segmentHitsRect(ax, ay, bx, by, w.x, w.y, w.w, w.h)) return false;
  }
  for (const o of state.obstacles) {
    if (segmentHitsRect(ax, ay, bx, by, o.gx - o.radius, o.gy - o.radius, o.radius * 2, o.radius * 2)) return false;
  }
  return true;
}
