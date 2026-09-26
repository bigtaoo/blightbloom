/**
 * entities/ split: the SIM-FACING weapon shapes — already converted to ticks / Fp /
 * Brad — plus one weapon's per-actor runtime. The human-unit `WEAPON_SPECS` catalog
 * that produces these lives in content/weapons.ts; systems only ever see these.
 */

import type { Fp } from '../../math/fixed';
import type { Brad } from '../../math/trig';
import type { DamageType } from '../../content/damage';
import type { RarityTier } from '../../balance/rarity';
import type { BallisticId, EmissionPattern } from '../../content/ballistics';

// ── Weapon specs (sim-facing, already converted to ticks / Fp / Brad) ─────────

export interface RangedSimSpec {
  kind: 'ranged';
  name: string; // render/asset id (weaponSkins.ts texture key) — NOT display text
  nameKey: string; // i18n KEY for the player-facing name (design/09); client resolves via tName()
  rarity: RarityTier; // intrinsic tier (design/14); render reads it for the compare-card colour, the sim never does
  fireRateTicks: number; // cooldown between shots, whole ticks
  // Emission (design/03 "orthogonal to ballistic") — pellets per trigger + the cone
  // half-angle each pellet jitters within (0 = pinpoint, single bullet, no PRNG draw).
  // `pattern` picks the LAYOUT: 'spread' = the jittered cone (default, baseline weapons);
  // 'radial' = an even PRNG-free ring (WeaponFireSystem). See content/ballistics.ts.
  bullets: number;
  spreadHalf: Brad;
  pattern: EmissionPattern;
  bulletSpeed: Fp; // fp displacement per tick
  bulletLifeTicks: number;
  bulletRadius: Fp;
  muzzleOffset: Fp; // spawn distance from actor centre along facing
  bulletZ: Fp; // muzzle height band (design/07 z-gating; cosmetic until then)
  damage: number; // integer
  damageType: DamageType; // physical or an element (on-hit status, design/03/07)
  // Energy one trigger pull costs the FIRING PLAYER (design/03/05, balance/energy.ts).
  // Copied straight through by toSimSpec — already an integer in pool units, so unlike
  // every other field here it needs no conversion. Read by WeaponFireSystem only, and
  // only for a player: an enemy is never charged, so `enemygun`'s 0 is inert.
  energyCost: number;
  // Ballistic (design/03/09 Frame axis, ROADMAP 1.1) — the per-tick motion rule;
  // 'straight' reads none of the params below. Frozen onto the Projectile at fire
  // time (WeaponFireSystem), read by ProjectileStepSystem (motion) / HitResolveSystem
  // (beam's damage-over-window).
  ballistic: BallisticId;
  turnRateBrad?: number; // homing: max turn toward the nearest foe, per tick
  blastRadius?: Fp; // lob: AoE radius on landing (lifespan-end detonation)
  returnAfterTicks?: number; // boomerang: tick (since fire) velocity reverses
  beamTicks?: number; // beam: total damage-window length, whole ticks
  beamTickInterval?: number; // beam: ticks between damage applications
  beamRange?: Fp; // beam: max reach along the frozen facing (does not use bulletSpeed)
  orbitRadius?: Fp; // orbit: circling distance from the owner's centre
  orbitAngularVelBrad?: number; // orbit: brad the angle advances per tick (revolution speed)
  // Authored on WeaponSpec since Stage C but never converted/read until now (ENGINE_VERSION
  // 28 — found while wiring ricochet, the exact same "bullet fate after a hit" branch
  // point): design/07 "continues and may hit further actors" instead of expiring on
  // its first hit. Omitted/false = every existing weapon's behavior, unchanged.
  piercing?: boolean;
  // k_* on-hit procs (design/03/09, ENGINE_VERSION 28 — the first concrete batch;
  // "never specified beyond a placeholder id prefix" until now). Both omitted =
  // every existing weapon, byte-identical. Frozen onto the Projectile at fire time,
  // like damageType above — HitResolveSystem reads them from there, never the spec.
  lifestealPermille?: number; // heal the FIRING player by this ‰ of damage dealt on hit
  ricochetCount?: number; // bullet retargets to the nearest OTHER hostile instead of expiring, this many times
}

export interface MeleeSimSpec {
  kind: 'melee';
  name: string; // render/asset id (weaponSkins.ts texture key) — NOT display text
  nameKey: string; // i18n KEY for the player-facing name (design/09); client resolves via tName()
  rarity: RarityTier; // intrinsic tier (design/14); render reads it for the compare-card colour, the sim never does
  swingCooldownTicks: number; // recovery between swings
  // ACTIVE hit window, whole ticks ⊂ swingCooldownTicks (design/07 step 7). Converted from the
  // authored `swingSec` and clamped into [1, cooldown] by `toSimSpec`. Authored since Stage C,
  // wired in ENGINE_VERSION 53 — before that the arc resolved instantly on the swing tick.
  swingTicks: number;
  damage: number; // integer, per enemy in arc, once per swing (across the WHOLE window)
  arcHalf: number; // swing sector half-angle, brad — used for BOTH damage and deflect
  range: Fp; // swing sector radius (reach from actor centre)
  deflect: boolean; // does the swing deflect bullets caught in its arc (design/03/05 parry)
  deflectSpeed: Fp; // fp per tick for a redirected bullet
  damageType: DamageType; // physical or an element (on-hit status, design/03/07)
  // Impulse magnitude (fp/tick, converted from the authored grid/s — design/07 "lands
  // once z/knockback lands"): HitResolveSystem's meleeArc adds this outward, along the
  // attacker→target direction, into the target's knockVx/knockVy on every connecting hit.
  knockback: Fp;
  // k_* on-hit proc (design/03/09, ENGINE_VERSION 28) — see RangedSimSpec's matching
  // field. Melee has no ricochet (it doesn't travel), only lifesteal.
  lifestealPermille?: number;
}

export type WeaponSimSpec = RangedSimSpec | MeleeSimSpec;

// ── Shield-break passive (sim-facing, converted; design/02/07/14) ─────────────
// A character's `shield_break` reaction, fired by combat when its shield empties.
// Tagged data: 'aoe' bursts damage to foes in radius; 'knock' shoves them out. The
// authored (human-unit) form lives in content/skins.ts; this is the fp shape.
export type ShieldBreakSim =
  | { kind: 'aoe'; radius: Fp; damage: number }
  | { kind: 'knock'; radius: Fp; impulse: Fp }; // impulse = fp displacement per tick

/** Per-actor weapon runtime. cooldown counted in whole ticks (design/08). */
export interface WeaponState {
  spec: WeaponSimSpec; // the sim spec systems read
  cooldownTicks: number; // counts down each tick, 0 = ready
  justSwung: boolean; // melee: swing STARTED this tick — the one-tick latch that opens the window below
  // ── Melee swing runtime: the ACTIVE hit window (design/07 step 7, ENGINE_VERSION 53) ──
  // A swing spans several ticks now. `openSwing`/`closeSwing` (content/weapons.ts) are the only
  // legal transitions and carry the full rationale; `WeaponFireSystem` counts the window down.
  // All three are 0/empty on every ranged weapon and on a melee weapon at rest.
  swingTicksLeft: number; // > 0 = ACTIVE; the gate BOTH DeflectSystem (6) and HitResolve (7) read
  swingHitIds: number[]; // bodies already hit — design/07's "at most once per swing", not per tick
  swingDamage: number; // buffs + crit frozen on the START tick, reused all window (07 "one frozen payload")
  // Whether `swingDamage` carries a crit — the melee twin of `Projectile.crit`, and like it read
  // only to mark the swing's `hit` events. Optional so a WeaponState built anywhere else still
  // type-checks; unhashed for the same reason `Projectile.crit` is.
  swingCrit?: boolean;
}
