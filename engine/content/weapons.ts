/**
 * Weapon content (design/09) — the one-time conversion of the authored catalog into the
 * sim-facing WeaponSimSpec that systems consume. This is the single place the conversion
 * happens; edit the mechanics here, and the actual weapon numbers in weaponSpecs.ts.
 *
 * Split 2026-07-28 (was one 700+ line file): weaponTypes.ts holds the authored WeaponSpec
 * schema, weaponSpecs.ts the WEAPON_SPECS catalog data, and this file the conversion +
 * sim-facing lookups — both re-exported here so callers keep importing from `weapons`.
 *
 * Moved into @dd/engine in Stage C (was client/src/game/content/weapons.ts). The
 * hand-tuned WeaponSimSpec constants that lived in sim.config.ts during Stage B are
 * superseded by `toSimSpec()` applied to these authored specs — the numbers now
 * flow human-units → converter → sim once, at construction.
 *
 * Authored in HUMAN UNITS: seconds, grid-units/second, degrees, integer damage,
 * grid distances. Conversion (design/09):
 *   toTicks(sec)      = round(sec · 30)
 *   toFpGrid(grid)    = round(grid · 1000)
 *   toFpPerTick(g/s)  = ⌊round(g/s · 1000) · 33 / 1000⌋   // fp displacement / tick
 *   degToBrad(deg)    = round(deg / 360 · 65536)
 */
import type {
  MeleeSimSpec,
  RangedSimSpec,
  WeaponSimSpec,
  WeaponState,
} from '../state/entities';
import { degToBrad } from '../math/trig';
import { toTicks, toFpGrid, toFpPerTick } from './convert';
import { TICK_RATE } from '../math/fixed';
import { applyQuality } from '../balance/rarity';
import type { WeaponSpec } from './weaponTypes';
import { WEAPON_SPECS } from './weaponSpecs';

export type { WeaponBase, RangedSpec, MeleeSpec, WeaponSpec } from './weaponTypes';
export { WEAPON_SPECS } from './weaponSpecs';

// ── Conversion: authored WeaponSpec → sim-facing WeaponSimSpec (once) ──────────

/**
 * Convert one authored weapon into the fp/brad/tick shape systems consume. The
 * intrinsic rarity's quality multiplier is applied HERE, once (design/09 convert-
 * once): `damage` is scaled by the tier's small per-mille edge (`common` = ×1.0 =
 * identity, so a baseline weapon is byte-for-byte unchanged). The `rarity` field is
 * carried through for the render layer; no system reads it.
 */
export function toSimSpec(spec: WeaponSpec): WeaponSimSpec {
  if (spec.kind === 'ranged') {
    const sim: RangedSimSpec = {
      kind: 'ranged',
      name: spec.id,
      nameKey: spec.nameKey,
      rarity: spec.rarity,
      fireRateTicks: toTicks(spec.cooldownSec),
      bullets: spec.bullets,
      spreadHalf: degToBrad(spec.spreadDeg / 2),
      pattern: spec.pattern ?? 'spread',
      bulletSpeed: toFpPerTick(spec.bulletSpeed),
      bulletLifeTicks: toTicks(spec.lifespanSec),
      bulletRadius: toFpGrid(spec.bulletRadius),
      muzzleOffset: toFpGrid(spec.muzzleGrid),
      bulletZ: toFpGrid(spec.bulletZ),
      damage: applyQuality(spec.damage, spec.rarity),
      damageType: spec.damageType ?? 'physical',
      // Already in pool units and already an integer — the one authored field that
      // crosses this boundary unchanged (design/09's conversion table has no row for
      // it because there is nothing to convert). Deliberately NOT scaled by rarity:
      // `applyQuality` exists to give a rarer weapon a small damage edge, and running
      // the price through it too would make a legendary frame cost more for the same
      // mechanic, which is the damage-indexed pricing balance/energy.ts rejects.
      energyCost: spec.energyCost,
      ballistic: spec.ballistic,
      turnRateBrad: spec.turnRateDegPerSec !== undefined ? degToBrad(spec.turnRateDegPerSec / TICK_RATE) : undefined,
      blastRadius: spec.blastRadiusGrid !== undefined ? toFpGrid(spec.blastRadiusGrid) : undefined,
      returnAfterTicks: spec.returnAfterSec !== undefined ? toTicks(spec.returnAfterSec) : undefined,
      beamTicks: spec.beamSec !== undefined ? toTicks(spec.beamSec) : undefined,
      beamTickInterval: spec.beamTickIntervalSec !== undefined ? toTicks(spec.beamTickIntervalSec) : undefined,
      beamRange: spec.beamRangeGrid !== undefined ? toFpGrid(spec.beamRangeGrid) : undefined,
      orbitRadius: spec.orbitRadiusGrid !== undefined ? toFpGrid(spec.orbitRadiusGrid) : undefined,
      // A full revolution is 65536 brad over (periodSec · 30) ticks → brad/tick.
      orbitAngularVelBrad:
        spec.orbitPeriodSec !== undefined ? Math.round(65536 / (spec.orbitPeriodSec * TICK_RATE)) : undefined,
      // Authored since Stage C but never wired until ENGINE_VERSION 28 (found while
      // wiring ricochet below — see RangedSimSpec's doc comment).
      piercing: spec.piercing ?? false,
      // k_* on-hit procs (ENGINE_VERSION 28).
      lifestealPermille: spec.lifestealPermille,
      ricochetCount: spec.ricochetCount,
    };
    return sim;
  }
  const swingCooldownTicks = toTicks(spec.cooldownSec);
  const sim: MeleeSimSpec = {
    kind: 'melee',
    name: spec.id,
    nameKey: spec.nameKey,
    rarity: spec.rarity,
    swingCooldownTicks,
    // Active hit window (design/07 step 7, ENGINE_VERSION 53 — authored since Stage C, but
    // `toSimSpec` dropped it on the floor until now, so the window was one tick for every
    // weapon regardless of what its `swingSec` said). Clamped into [1, cooldown] rather than
    // trusted raw: a `swingSec` small enough to round to 0 ticks would silently disarm the
    // weapon entirely, and design/07 authors the window as a SUBSET of the recovery, so a
    // window longer than the cooldown is a content error, not a mechanic.
    swingTicks: Math.min(swingCooldownTicks, Math.max(1, toTicks(spec.swingSec))),
    damage: applyQuality(spec.damage, spec.rarity),
    arcHalf: degToBrad(spec.arcDeg / 2),
    range: toFpGrid(spec.rangeGrid),
    deflect: spec.deflect,
    deflectSpeed: toFpPerTick(spec.deflectSpeed),
    damageType: spec.damageType ?? 'physical',
    knockback: toFpPerTick(spec.knockback),
    lifestealPermille: spec.lifestealPermille, // k_* on-hit proc (ENGINE_VERSION 28)
  };
  return sim;
}

/**
 * Sim-spec lookup by weapon id — the resolution a weapon drop uses (content/drops.ts
 * WEAPON_DROP_POOL holds ids; PickupSystem resolves through this). Converted once at
 * module load (design/09 load-once), directly off WEAPON_SPECS's own keys — adding a
 * weapon only means adding a WEAPON_SPECS entry, not also a named const AND a map
 * entry (2026-07-28: the previous version kept 23 individually-named `*_SIM` consts
 * purely to relist them here one by one; 11 of them (repeater/cannon/flamer/
 * cryobolt/teslagun/venomspit/emberblade/frostbrand/stormglaive/hammer/spear) had no
 * other reference anywhere in the codebase). enemygun is excluded — not player-facing.
 */
/** Mob loadouts — authored in WEAPON_SPECS like everything else, but never
 *  player-facing: excluded from `WEAPON_SIM_BY_ID` so they can neither roll as a
 *  weapon drop (`WEAPON_DROP_POOL` resolves through that map) nor be crafted. */
export const MOB_WEAPON_IDS: readonly string[] = ['enemygun', 'enemyclaw', 'enemymaul', 'enemynova'];

export const WEAPON_SIM_BY_ID: Record<string, WeaponSimSpec> = Object.fromEntries(
  Object.entries(WEAPON_SPECS)
    .filter(([id]) => !MOB_WEAPON_IDS.includes(id))
    .map(([id, spec]) => [id, toSimSpec(spec)]),
);

// Named exports kept only for the ones actually referenced elsewhere (blueprints,
// enemy loadouts, tests) — pulled from the map above so there's exactly one
// conversion per weapon, not a second parallel one.
export const BLASTER_SIM = WEAPON_SIM_BY_ID.blaster as RangedSimSpec;
export const SABER_SIM = WEAPON_SIM_BY_ID.saber as MeleeSimSpec;
export const ENEMY_GUN_SIM = toSimSpec(WEAPON_SPECS.enemygun!) as RangedSimSpec;
// Enemy melee loadouts (ENGINE_VERSION 59) — the first melee weapons any mob has had.
export const ENEMY_CLAW_SIM = toSimSpec(WEAPON_SPECS.enemyclaw!) as MeleeSimSpec;
export const ENEMY_MAUL_SIM = toSimSpec(WEAPON_SPECS.enemymaul!) as MeleeSimSpec;
// Pyrefang's ring attack (Task 2, ENGINE_VERSION 70) — the boss roster's first radial loadout.
export const ENEMY_NOVA_SIM = toSimSpec(WEAPON_SPECS.enemynova!) as RangedSimSpec;
export const SCATTERGUN_SIM = WEAPON_SIM_BY_ID.scattergun as RangedSimSpec;
export const SEEKER_SIM = WEAPON_SIM_BY_ID.seeker as RangedSimSpec;
export const MORTAR_SIM = WEAPON_SIM_BY_ID.mortar as RangedSimSpec;
export const LASERCUTTER_SIM = WEAPON_SIM_BY_ID.lasercutter as RangedSimSpec;
export const TOMAHAWK_SIM = WEAPON_SIM_BY_ID.tomahawk as RangedSimSpec;
export const NOVABURST_SIM = WEAPON_SIM_BY_ID.novaburst as RangedSimSpec;
export const GYRE_SIM = WEAPON_SIM_BY_ID.gyre as RangedSimSpec;
export const CAROM_SIM = WEAPON_SIM_BY_ID.carom as RangedSimSpec;
export const LEECH_SIM = WEAPON_SIM_BY_ID.leech as MeleeSimSpec;

/** Fresh weapon runtime for a spec (design/08: cooldown in whole ticks). The melee
 *  swing-window fields start at rest — a weapon is never handed out mid-swing, including
 *  the one a mid-run weapon drop swaps in. */
export function makeWeapon(spec: WeaponSimSpec): WeaponState {
  return { spec, cooldownTicks: 0, justSwung: false, swingTicksLeft: 0, swingHitIds: [], swingDamage: 0 };
}

/**
 * Start a melee swing: latch the one-tick `justSwung` START flag AND open the spec's ACTIVE
 * hit window (design/07 step 7, ENGINE_VERSION 53). These two have to move together — the
 * latch is what freezes the swing's damage payload in HitResolve and what emits `melee_swing`,
 * the window is what steps 6 (deflect) and 7 (arc damage) actually gate on — and a caller that
 * set only one would produce a swing that either does no damage or re-rolls its crit every
 * tick. So there is exactly ONE definition of "a swing starts", here, called by
 * `WeaponFireSystem` and by every test that stages a swing without running step 3. A swing
 * that starts while a previous one is still active restarts both, hit list included: it is a
 * new attack.
 *
 * No-op for a ranged weapon, so a caller never has to narrow the spec first.
 */
export function openSwing(w: WeaponState): void {
  if (w.spec.kind !== 'melee') return;
  w.justSwung = true;
  w.swingTicksLeft = w.spec.swingTicks;
  w.swingHitIds.length = 0;
}

/** Close a melee swing early and drop its bookkeeping — the counterpart of `openSwing`, for
 *  the two places a window ends other than by running out: it reached 0 in `WeaponFireSystem`,
 *  or the blade was holstered mid-swing (`ApplyInputSystem.swap`). Leaves `justSwung` alone;
 *  that latch is cleared at the top of every turn regardless. */
export function closeSwing(w: WeaponState): void {
  w.swingTicksLeft = 0;
  w.swingHitIds.length = 0;
  w.swingDamage = 0;
  w.swingCrit = false;
}
