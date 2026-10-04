// When the PvP bot draws its blade to bat a bullet back (2026-10-03). Every loadout carries a
// deflecting melee weapon (ENGINE_VERSION 45), and a swing turns any hostile bullet inside its
// arc (`DeflectSystem`), but until now the shipped bot never swapped off its gun, so no real
// match ever saw a parry and `PVP_DEFLECT_DAMAGE_PERMILLE` was never in play. The sim-only
// `ArenaBotController` measured the behaviour first (volume 117); this is its rule, without
// memory and without the frame-perfect timing.
//
// The rule, each tick:
//   - a bullet coming at it that it picked to parry, inside the arc it faces: swap to the blade
//     (a ready one) and swing;
//   - blade out for a parry and nothing coming: swing only at a body inside the blade's reach,
//     and swap back to the gun once the blade has recovered (a holstered weapon's cooldown is
//     frozen, so a blade put away mid-recovery could not parry the next bullet).
//
// It picks about one bullet in two (`PARRY_SHARE_PERCENT`), by bullet id, so the choice holds
// over the ticks the bullet flies and differs between seats. A bot that turned every shot
// back would be a wall for anyone learning to fight; one that never did taught nothing.
//
// Pure function of GameState, like everything the bot does: the swap is pressed only when the
// last tick's buttons did not hold it (`PlayerActor.prevButtons`), which is the engine's own
// press edge, so no memory of its own last swap is needed.
import { Button, type GameState, type PlayerActor } from '@dd/engine';
import { atan2Brad, bradDiff } from '@dd/engine/math/trig';
import { nearestHostile } from '@dd/engine/systems/targeting';

/** Share of incoming bullets the bot tries to parry. */
export const PARRY_SHARE_PERCENT = 50;

/** Ticks ahead a bullet is judged against the blade's reach. A swap and a swing start on the
 *  same tick, so this covers a bullet crossing the reach between two commands. Online the bot
 *  reads the confirmed stream 1-3 frames behind the frame its command lands on, and parried as
 *  often with this widened by up to 4 ticks as without (measured 2026-10-03), so there is no lead. */
export const PARRY_LOOKAHEAD = 4;

/** What the parry rule wants this tick, layered over the bot's own command. */
export interface ParryMove {
  swap: boolean;
  fire: boolean;
}

/** The parry rule's override for `me` this tick, or null to leave the command alone.
 *  `keepBlade`: the blade is out for a dry gun (`ai/dryBlade.ts`), so with nothing coming it is
 *  that rule's, not this one's, to swing or put back. */
export function parryMove(s: GameState, me: PlayerActor, owner: number, keepBlade = false): ParryMove | null {
  const blade = me.weapons.find((w) => w.spec.kind === 'melee' && w.spec.deflect);
  if (!blade || blade.spec.kind !== 'melee') return null;
  const bladeOut = me.weapon === blade;
  const gun = me.weapons.find((w) => w !== blade && w.spec.kind === 'ranged');
  const canSwap = (me.prevButtons & Button.SWAP_WEAPON) === 0;
  const ready = bladeOut ? blade.cooldownTicks === 0 || blade.swingTicksLeft > 0 : blade.cooldownTicks === 0;

  if (ready && bulletToParry(s, me, owner, blade.spec.range, blade.spec.arcHalf)) {
    if (bladeOut) return { swap: false, fire: true };
    return canSwap ? { swap: true, fire: true } : null;
  }
  // Only a blade the bot drew can be put back: with no gun, the blade is all it has.
  if (!bladeOut || !gun || keepBlade) return null;
  const aim = nearestHostile(s, me, me.gx, me.gy);
  const bodyInReach = aim !== null && Math.hypot(aim.gx - me.gx, aim.gy - me.gy) <= blade.spec.range;
  const recovered = blade.cooldownTicks === 0 && blade.swingTicksLeft === 0;
  if (recovered && canSwap && !bodyInReach) return { swap: true, fire: false };
  return { swap: false, fire: bodyInReach };
}

/**
 * Is a bullet hostile to `me`, picked for a parry, inside the reach within `PARRY_LOOKAHEAD`
 * ticks from now? Straight-line, on the bullet's current velocity.
 * Not a bullet moving away (it has passed), a still one (a beam or a landed lob, which no swing
 * turns), a rebound (it turns back once, ENGINE_VERSION 85), or one outside the swing's arc:
 * the engine faces the seat at its nearest hostile, and a swing only turns what lies within
 * `arcHalf` of that facing.
 */
export function bulletToParry(s: GameState, me: PlayerActor, owner: number, reach: number, arcHalf: number): boolean {
  const aim = nearestHostile(s, me, me.gx, me.gy);
  if (!aim) return false;
  const facing = atan2Brad(aim.gy - me.gy, aim.gx - me.gx);
  for (const b of s.projectiles) {
    if (!b.alive || b.deflected || b.teamId === me.teamId || !picked(b.id, owner)) continue;
    const v2 = b.vx * b.vx + b.vy * b.vy;
    if (v2 === 0) continue;
    const rx = b.gx - me.gx;
    const ry = b.gy - me.gy;
    const along = rx * b.vx + ry * b.vy;
    if (along >= 0) continue; // moving away: already past, or never coming
    // The tick it enters the reach: the first root of |r + v t| = reach. A closing bullet's
    // second root is always ahead, so it cannot have left already.
    const disc = along * along - v2 * (rx * rx + ry * ry - reach * reach);
    if (disc < 0) continue; // passes wide
    if ((-along - Math.sqrt(disc)) / v2 > PARRY_LOOKAHEAD) continue;
    if (Math.abs(bradDiff(atan2Brad(ry, rx), facing)) > arcHalf) continue;
    return true;
  }
  return false;
}

/** Whether seat `owner` tries to parry bullet `id`: a fixed hash, so the pick holds for the
 *  bullet's whole flight and two seats facing one volley do not pick alike. */
export function picked(id: number, owner: number): boolean {
  // Fibonacci hashing, read from the high bits, which are the well-mixed ones.
  const h = Math.imul(Math.imul(id, 0x9e3779b1) ^ Math.imul(owner + 1, 0x85ebca6b), 0x9e3779b1) >>> 0;
  return Math.floor((h / 2 ** 32) * 100) < PARRY_SHARE_PERCENT;
}
