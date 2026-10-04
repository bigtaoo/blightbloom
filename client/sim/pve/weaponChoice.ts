/**
 * Which weapon the PvE bot wants in hand — split out of `PveBotController.ts` (2026-09-29,
 * CLAUDE.md 500-line convention, form 1: pure functions over the seat, no bot state). Two
 * rules: how a floor gun is ranked against the one held, and when to swap between the gun and
 * the blade (`BotProfile.meleeWhenDry`).
 */
import type { PlayerActor } from '@dd/engine';

/** Share of the pool that must be back before a blade-holding bot re-draws its gun. A
 *  threshold of one pull would re-draw, fire once and holster again every few ticks; half a
 *  bar is a volley, and it is the hysteresis that stops the thrash. */
export const REARM_FRAC = 0.5;

/** How much the bot wants a gun: shared with the shipped PvP bot since 2026-10-03. */
export { gunWorth } from '../../src/game/controllers/ai/loot';

/**
 * Should the seat swap slots now? To the blade: the active slot is a gun the pool cannot pay
 * for, and `enemyInRoom` (a quiet room is no reason to holster). Back to the gun: the blade is
 * out and the pool holds `REARM_FRAC` of its size, or one pull if that is more. False for a
 * seat without both a gun and a blade.
 */
export function bladeSwapDue(me: Pick<PlayerActor, 'weapon' | 'weapons' | 'energy' | 'maxEnergy'>, enemyInRoom: boolean): boolean {
  const active = me.weapon?.spec;
  const gun = me.weapons.find((w) => w.spec.kind === 'ranged')?.spec;
  const blade = me.weapons.some((w) => w.spec.kind === 'melee');
  if (!active || !gun || gun.kind !== 'ranged' || !blade) return false;
  if (active.kind === 'ranged') return me.energy < gun.energyCost && enemyInRoom;
  return me.energy >= Math.max(gun.energyCost, Math.ceil(me.maxEnergy * REARM_FRAC));
}
