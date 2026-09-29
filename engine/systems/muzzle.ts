/**
 * Where a bullet is born along its aim ray (WeaponFireSystem step 3), split out so the
 * point-blank rule has its own tests.
 *
 * A bullet spawns `muzzleOffset` ahead of the shooter's centre (1 grid for most guns), and
 * is only tested for hits after `ProjectileStepSystem` has moved it once more. A hostile body
 * closer than that was therefore BEHIND the muzzle: two players standing on each other could
 * empty their bars into the air (ENGINE_VERSION 79). Now, when a hostile body's hit circle
 * crosses the ray before the muzzle, the bullet is born far enough back that step 5 carries it
 * onto that body's closest point on the ray, and step 7 resolves the hit exactly as it
 * resolves any other. Nothing about the hit itself is special-cased.
 */
import { mulFp, type Fp } from '../math/fixed';
import type { GameState } from '../state/GameState';
import type { Actor, RangedSimSpec } from '../state/entities';
import { hostileTargets } from './targeting';

/**
 * Spawn distance along the ray (`cos`/`sin` are its fp unit vector). `muzzleOffset` unless
 * a hostile body the ray crosses sits before the point the bullet would first be tested at,
 * then pulled back to reach the nearest such body; never behind the shooter's centre. An
 * orbit is exempt: it circles its owner and never travels the ray.
 */
export function muzzleDistance(state: GameState, a: Actor, spec: RangedSimSpec, cos: Fp, sin: Fp): Fp {
  if (spec.ballistic === 'orbit') return spec.muzzleOffset;
  // A beam never moves; every other ballistic is stepped once before its first hit test.
  const travel = spec.ballistic === 'beam' ? 0 : spec.bulletSpeed;
  let d = spec.muzzleOffset as number;
  for (const t of hostileTargets(state, a)) {
    const rx = t.gx - a.gx;
    const ry = t.gy - a.gy;
    const along = mulFp(rx as Fp, cos) + mulFp(ry as Fp, sin);
    if (along < 0 || along - travel >= d) continue; // behind the shooter, or met in flight anyway
    const across = mulFp(rx as Fp, sin) - mulFp(ry as Fp, cos);
    const reach = t.radius + spec.bulletRadius;
    if (across * across > reach * reach) continue; // the ray passes it by
    d = Math.max(0, along - travel);
  }
  return d as Fp;
}
