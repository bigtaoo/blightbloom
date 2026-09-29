// Whether a straight shot between two points would reach — the PvP bot's check before it
// fires (2026-09-29). Bullets stop on pillars and walls (`ProjectileStepSystem`), and the
// engine faces a seat at its nearest hostile through any wall, so a bot that fired whenever it
// was in range spent whole matches shooting the pillar between it and its opponent. Tested the
// way the engine tests a bullet: points along the path, each against the solids near it.
//
// Pure function of GameState, like everything the bot does.
import { FP_SCALE, type Fp, type GameState } from '@dd/engine';
import type { Point } from './engage';

/** Spacing of the points tested along a shot — under every gun's per-tick travel. */
const STEP_FP = FP_SCALE / 4;
/** The body a shot has to clear: a typical bullet's radius. */
const SHOT_RADIUS_FP = 150;

/** True when nothing solid lies between `from` and `to` (both ends excluded). */
export function lineOfFireClear(s: GameState, from: Point, to: Point): boolean {
  const dx = to.gx - from.gx;
  const dy = to.gy - from.gy;
  const steps = Math.floor(Math.hypot(dx, dy) / STEP_FP);
  for (let i = 1; i < steps; i++) {
    if (!pointClear(s, from.gx + (dx * i) / steps, from.gy + (dy * i) / steps)) return false;
  }
  return true;
}

/** True when a shot-sized circle at (gx, gy) touches no pillar and no wall. */
export function pointClear(s: GameState, gx: number, gy: number): boolean {
  const x = Math.round(gx) as Fp;
  const y = Math.round(gy) as Fp;
  const r = SHOT_RADIUS_FP as Fp;
  for (const idx of s.spatialIndex.queryObstacles(x, y, r)) {
    const o = s.obstacles[idx]!;
    if ((o.gx - x) ** 2 + (o.gy - y) ** 2 <= (o.radius + r) ** 2) return false;
  }
  for (const idx of s.spatialIndex.queryWalls(x, y, r)) {
    const w = s.walls[idx]!;
    const cx = Math.max(w.x, Math.min(x, w.x + w.w));
    const cy = Math.max(w.y, Math.min(y, w.y + w.h));
    if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) return false;
  }
  return true;
}
