/**
 * Weapon balance profiles (design/03/05/14) — the authored catalog reduced to a small set
 * of COMPARABLE axes, so "is this weapon a real choice or a strictly worse one?" is a
 * question with an answer instead of a judgement call.
 *
 * This is the weapon counterpart of what `content/skins.ts` + `skins.test.ts` already do
 * for characters (Pareto non-domination, per-axis spread, equal-worth budget band). It is
 * deliberately NOT a clone of that shape, because weapons are not characters:
 *
 *   - Characters are meant to be EQUAL WORTH — design/14's "side-grades, no power ladder" —
 *     so a total-budget band is the right gate for them.
 *   - Weapons are explicitly NOT equal worth. design/05 names "finding a better weapon" as
 *     the in-run power axis, and rarity is an intrinsic tier on top of that. A rarer weapon
 *     is SUPPOSED to be better.
 *
 * So the numeric axes here answer a narrower question, and the module is honest about where
 * it stops: **it cannot price a mechanic.** Homing, an AoE blast, a hitscan beam, a bounce,
 * a chill — each is worth something, and nothing in this repo says how much. Every attempt
 * to fold them into one composite "worth" number would be inventing the exchange rate and
 * then testing the invention. What the axes below CAN do is separate weapons that differ
 * mechanically (where the trade is real, and unmeasurable from data alone) from weapons that
 * do not (where one being worse on every axis is just a worse weapon). The empirical
 * pricing lives elsewhere, in `client/sim/weaponSweep.sim.ts`, which plays each weapon
 * through a real level and measures what it actually clears.
 *
 * Every axis is "higher is better" and stays in AUTHORED HUMAN UNITS (seconds, grid,
 * degrees, integer damage) — the point is to compare design intent, so converting to
 * fp/brad/ticks first would only add rounding between two numbers being subtracted.
 */
import type { RarityTier } from './rarity';
import { WEAPON_SPECS } from '../content/weapons';
import type { MeleeSpec, RangedSpec, WeaponSpec } from '../content/weaponTypes';

/**
 * Not player-facing (mob loadouts) — never a choice, so never in a balance comparison.
 *
 * Kept as its own list rather than importing `MOB_WEAPON_IDS` from `content/weapons`,
 * because the two answer different questions and are allowed to diverge: that one asks
 * "may this roll as a drop", this one asks "is this a choice a player makes". A mob
 * weapon is both today; a hypothetical unlockable-but-undroppable weapon would be
 * neither, and collapsing them would hide that. `weaponBalance.test.ts` asserts the two
 * agree on the current roster, so the divergence has to be deliberate to survive.
 */
export const NON_PLAYER_WEAPON_IDS: readonly string[] = ['enemygun', 'enemyclaw', 'enemymaul', 'enemynova'];

export interface WeaponProfile {
  readonly id: string;
  readonly kind: 'ranged' | 'melee';
  readonly rarity: RarityTier;
  /**
   * MECHANICAL SIGNATURE — the qualitative axes, as one comparable key. Two weapons that
   * share a signature are mechanically interchangeable: they do the same kind of thing, and
   * only their numbers distinguish them. Two that differ have a trade no number here prices.
   */
  readonly signature: string;
  /** Numeric axes, higher-is-better, authored units. Same key set within a `kind`. */
  readonly axes: Readonly<Record<string, number>>;
}

/**
 * How far this weapon's damage can actually get, in grid — the authored reach envelope.
 * Each ballistic answers it differently, and reading `bulletSpeed · lifespanSec` for all of
 * them (as a naive metric would) reports 0 for a beam and for an orbiting blade, both of
 * which have a real reach that simply is not a function of travel.
 */
export function reachGrid(spec: RangedSpec): number {
  switch (spec.ballistic) {
    case 'beam':
      return spec.beamRangeGrid ?? 0; // hitscan: the frozen line's own length
    case 'orbit':
      return spec.orbitRadiusGrid ?? 0; // damage happens ON the circle
    case 'boomerang':
      return spec.bulletSpeed * (spec.returnAfterSec ?? 0); // the outbound leg, before it turns
    default:
      return spec.bulletSpeed * spec.lifespanSec;
  }
}

/** Damage applications one trigger pull produces — a beam channel ticks several times. */
export function hitsPerTrigger(spec: RangedSpec): number {
  if (spec.ballistic !== 'beam') return 1;
  const window = spec.beamSec ?? 0;
  const interval = spec.beamTickIntervalSec ?? 0;
  return interval > 0 ? Math.floor(window / interval) : 1;
}

function rangedProfile(id: string, spec: RangedSpec): WeaponProfile {
  const burst = spec.bullets * spec.damage * hitsPerTrigger(spec);
  return {
    id,
    kind: 'ranged',
    rarity: spec.rarity,
    signature: [
      spec.ballistic,
      spec.pattern ?? 'spread',
      spec.damageType ?? 'physical',
      spec.piercing ? 'pierce' : '-',
      spec.ricochetCount ? 'ricochet' : '-',
      spec.lifestealPermille ? 'lifesteal' : '-',
    ].join('/'),
    axes: {
      /** Sustained damage per second, pellets and beam ticks folded in. */
      dps: burst / spec.cooldownSec,
      /** Damage landed by ONE trigger pull — the burst/one-shot axis dps averages away. */
      burst,
      /** Damage of a single application — what a flat-armour subtract eats into (design/07). */
      hitDamage: spec.damage,
      reachGrid: reachGrid(spec),
      /** AoE radius on landing; 0 for everything but `lob`. */
      blastGrid: spec.blastRadiusGrid ?? 0,
    },
  };
}

function meleeProfile(id: string, spec: MeleeSpec): WeaponProfile {
  return {
    id,
    kind: 'melee',
    rarity: spec.rarity,
    signature: [
      'melee',
      spec.damageType ?? 'physical',
      spec.deflect ? 'deflect' : '-',
      spec.lifestealPermille ? 'lifesteal' : '-',
    ].join('/'),
    axes: {
      dps: spec.damage / spec.cooldownSec,
      hitDamage: spec.damage,
      reachGrid: spec.rangeGrid,
      /** The swing sector — crowd coverage AND parry width, which are the same arc (design/03). */
      arcDeg: spec.arcDeg,
      knockback: spec.knockback,
      /** Active hit window: a longer one sweeps onto targets that were not there on tick 1. */
      windowSec: spec.swingSec,
    },
  };
}

export function weaponProfile(id: string, spec: WeaponSpec): WeaponProfile {
  return spec.kind === 'ranged' ? rangedProfile(id, spec as RangedSpec) : meleeProfile(id, spec as MeleeSpec);
}

/** Every PLAYER-FACING weapon's profile, in catalog order. */
export function weaponProfiles(): WeaponProfile[] {
  return Object.entries(WEAPON_SPECS)
    .filter(([id]) => !NON_PLAYER_WEAPON_IDS.includes(id))
    .map(([id, spec]) => weaponProfile(id, spec));
}

/**
 * Does `a` Pareto-dominate `b`? At-least-as-good on every axis, strictly better on one.
 * Only meaningful between profiles of the same `kind` (they share an axis set); callers
 * are responsible for not comparing a sword to a shotgun.
 */
export function dominates(a: WeaponProfile, b: WeaponProfile): boolean {
  const keys = Object.keys(a.axes);
  return keys.every((k) => a.axes[k]! >= b.axes[k]!) && keys.some((k) => a.axes[k]! > b.axes[k]!);
}

/** Profiles grouped by mechanical signature — the sets whose members must not dominate. */
export function bySignature(profiles: readonly WeaponProfile[]): Map<string, WeaponProfile[]> {
  const out = new Map<string, WeaponProfile[]>();
  for (const p of profiles) {
    const key = `${p.kind} ${p.signature}`;
    out.set(key, [...(out.get(key) ?? []), p]);
  }
  return out;
}
