/**
 * entities/ split: projectiles — everything the sim has in flight between an actor
 * that fired and whatever it is going to reach.
 */

import type { Fp } from '../../math/fixed';
import type { Brad } from '../../math/trig';
import type { DamageType } from '../../content/damage';
import type { BallisticId } from '../../content/ballistics';
import type { Faction } from './teams';

// ── Projectiles / pickups ──────────────────────────────────────────────────────

export interface Projectile {
  id: number;
  faction: Faction;
  // Frozen from the firing actor at spawn (WeaponFireSystem), like `faction`
  // above — design/15's targeting predicate reads this, not faction, to decide
  // what a bullet can hit. Deflect (DeflectSystem) reassigns it to the
  // deflector's own team, same as it already reassigns `faction`.
  teamId: number;
  gx: Fp;
  gy: Fp;
  z: Fp;
  vx: Fp; // fp per tick
  vy: Fp;
  radius: Fp;
  damage: number;
  damageType: DamageType; // frozen from the firing weapon's spec (design/07 payload)
  lifeTicks: number;
  alive: boolean;
  // Ballistic runtime (design/03/09 Frame axis, ROADMAP 1.1). Frozen from the firing
  // spec at fire time (WeaponFireSystem), like damageType above. Undefined/'straight'
  // = the original plain `pos += vel` path — every existing bullet is unaffected.
  ballistic?: BallisticId;
  turnRateBrad?: number; // homing
  speed?: Fp; // homing: magnitude to preserve while turning toward a target
  returnAfterTicks?: number; // boomerang: tick (since fire) velocity reverses
  ticksAlive?: number; // boomerang: ticks elapsed since fire (this system's own counter)
  blastRadius?: Fp; // lob: AoE radius applied once, on landing (lifespan end)
  landed?: boolean; // lob: set by ProjectileStepSystem when lifespan ends; HitResolveSystem
  // (step 7) resolves the AoE blast through the normal resist/status path, then kills it
  beamTicksLeft?: number; // beam: remaining duration ticks (independent of lifeTicks)
  beamTickInterval?: number; // beam: ticks between damage applications
  beamDir?: Brad; // beam: frozen facing at fire time (beam does not move or track the shooter)
  beamRange?: Fp; // beam: max reach along beamDir
  // orbit: unlike every ballistic above, this one TRACKS its owner — position is set from
  // the owner's live centre each tick, so the bullet needs to find that actor by id.
  // ALSO used by k_lifesteal below (ENGINE_VERSION 28) — WeaponFireSystem now sets this
  // on EVERY bullet, not just orbit's, so HitResolveSystem can find who to heal; every
  // other read site still only branches on `ballistic === 'orbit'`, never on ownerId's
  // mere presence, so this is additive (no behavior change for any non-orbit ballistic).
  ownerId?: number; // orbit: the actor this bullet circles (dies if the owner is gone)
  orbitRadius?: Fp; // orbit: circling distance from the owner
  orbitAngleBrad?: Brad; // orbit: current angle around the owner (advances each tick)
  orbitAngularVelBrad?: number; // orbit: brad the angle advances per tick
  // Frozen from RangedSimSpec.piercing (ENGINE_VERSION 28) — see that field's doc
  // comment. Undefined/false = every existing bullet's behavior, unchanged.
  piercing?: boolean;
  // k_* on-hit procs (design/03/09, ENGINE_VERSION 28), frozen from the firing spec at
  // fire time like damageType. lifestealPermille heals `ownerId`'s player on this
  // bullet's next hit; ricochetsLeft counts down each successful retarget (HitResolveSystem).
  lifestealPermille?: number;
  ricochetsLeft?: number;
  // A piercing bullet stays alive after a hit (design/07) instead of expiring — this
  // is its own cross-tick memory of who it's already hit, so a slow pierce shot that's
  // still overlapping a body it just hit doesn't hit it again every subsequent tick
  // (mirrors why a melee swing tracks "hit ids on the swing", same root cause).
  hitIds?: number[];
  // The crit roll that went into `damage` came up (design/07 "one frozen payload"). Only ever
  // `true` or absent; read by nothing in the sim — `HitResolveSystem` copies it onto the `hit`
  // event so the damage number can print it as a crit. Not in `serializeState`, like `damageType`:
  // the roll's outcome is already hashed through `damage` and the `combatPrng` cursor. Cleared
  // on a deflect, because the deflector rolled nothing.
  crit?: true;
}
