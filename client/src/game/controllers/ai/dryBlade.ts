// The PvP bot's blade when its gun runs dry (2026-10-03): holster a gun the pool cannot pay for
// and fight with the blade until `REARM_SHOTS` pulls are back. Moved here from the sim-only
// `ArenaBotController` (volume 117), where it took a looting seat's dry ticks from 9% to under
// 0.1%. Stateless: whether the blade is out "for the dry gun" is read off the pool itself.
import type { PlayerActor } from '@dd/engine';

/**
 * Pulls that must be affordable before a blade drawn for a dry gun goes back. A count of
 * SHOTS, not the PvE bot's share of the pool (`REARM_FRAC`): a pool-share threshold makes a
 * deeper bar wait longer on the blade, which read in the first sweep as "the 130 pool loses"
 * when it was this rule sending the most fragile seat into melee for longest.
 */
export const REARM_SHOTS = 3;

/**
 * Should the seat swap slots for the dry rule now? To the blade: the gun in hand cannot pay
 * for a pull and what it aims at is in range. Back to the gun: `REARM_SHOTS` pulls are affordable
 * (or a full bar, if that holds fewer). False for a seat without both a gun and a blade.
 */
export function drySwapDue(me: PlayerActor, targetInRange: boolean): boolean {
  const active = me.weapon?.spec;
  const gun = me.weapons.find((w) => w.spec.kind === 'ranged')?.spec;
  if (!active || gun?.kind !== 'ranged' || !me.weapons.some((w) => w.spec.kind === 'melee')) return false;
  if (active.kind === 'ranged') return me.energy < gun.energyCost && targetInRange;
  return rearmed(me);
}

/** The pool holds `REARM_SHOTS` pulls of the carried gun (or is full). True with no gun. */
export function rearmed(me: PlayerActor): boolean {
  const gun = me.weapons.find((w) => w.spec.kind === 'ranged')?.spec;
  const cost = gun?.kind === 'ranged' ? gun.energyCost : 0;
  return me.energy >= Math.min(me.maxEnergy, cost * REARM_SHOTS);
}
