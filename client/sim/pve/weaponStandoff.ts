/**
 * Where a bot should stand to use a given weapon — split out of `weaponSweep.sim.ts`
 * (2026-09-26) when `PveBotController` learned to pick up better guns, because a bot that
 * swaps into a mortar or a laser cutter needs the same answer the sweep already paid for.
 *
 * The standoff is the TIGHTEST of three bounds: the profile's own spacing, a fraction of the
 * weapon's reach envelope, and half a second of projectile flight. The sweep's header has
 * the two false readings the latter two each fixed (a 1.3-grid blade scored zero from a
 * 7.5-grid standoff; a mortar that does not lead its shots scored zero until the flight bound
 * pulled it in).
 */
import { FP_SCALE, WEAPON_SPECS, reachGrid } from '@dd/engine';
import type { BotProfile } from './PveBotController';

/** Seconds of projectile flight the bot can afford before the target has walked out of the
 *  blast/bullet radius — the bot does not lead its shots. */
export const FLIGHT_BUDGET_SEC = 0.5;
/** Never closer than this, whatever the numbers say — solid push-out makes anything tighter a
 *  wrestling match. */
export const MIN_STANDOFF_GRID = 0.8;

const g = (grid: number): number => Math.round(grid * FP_SCALE);

/**
 * `base`, re-spaced for a weapon of `reachGrid` whose projectile travels at `speedGridPerSec`
 * (0 for a weapon that does not travel: a hitscan beam, an orbit). A weapon already played at
 * the base spacing gets `base` back byte-for-byte, so the starter pistol's numbers stay
 * directly comparable with every earlier sweep.
 */
export function profileForWeapon(base: BotProfile, reachGrid: number, speedGridPerSec: number): BotProfile {
  const bounds = [base.standoffFp / FP_SCALE, reachGrid * 0.55];
  if (speedGridPerSec > 0) bounds.push(speedGridPerSec * FLIGHT_BUDGET_SEC);
  const standoff = Math.max(MIN_STANDOFF_GRID, Math.min(...bounds));
  if (standoff >= base.standoffFp / FP_SCALE) return base;
  return { ...base, standoffFp: g(standoff), hysteresisFp: g(0.4), fireRangeFp: g(reachGrid) };
}

/** `profileForWeapon` for a catalogued RANGED weapon id; `base` for anything else. */
export function profileForWeaponId(base: BotProfile, weaponId: string): BotProfile {
  const spec = WEAPON_SPECS[weaponId];
  if (!spec || spec.kind !== 'ranged') return base;
  return profileForWeapon(base, reachGrid(spec), spec.bulletSpeed);
}
