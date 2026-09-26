/**
 * Shared damage application (design/07 two-pool `takeDamage`). Every damage source —
 * a direct bullet/melee hit, a lightning chain, a burn/poison DoT tick — routes
 * through here so the shield-first absorb, the idle-regen timer reset, and the
 * shield-break event are defined in ONE place (HitResolveSystem + StatusEffectSystem
 * both call it).
 *
 * Absorb order (design/07): shield soaks first, overflow spills to hp. ANY damage
 * resets `ticksSinceHit` to 0 (a lingering DoT therefore keeps shield regen
 * suppressed — "clear your status to recover"). If the hit emptied a previously
 * non-empty shield, a `shield_break` event fires (render fx + the 0.5 break passive).
 * Death is still decided later (step 9), matching the rest of combat — this only
 * lowers pools. All arithmetic is integer (design/06).
 */
import { addFp, mulFp } from '../math/fixed';
import { atan2Brad, cosFp, sinFp } from '../math/trig';
import type { GameState } from '../state/GameState';
import type { Actor, DamageSrc, ShieldBreakSim } from '../state/entities';
import type { DamageType } from '../content/damage';
import { hostileTargets } from './targeting';

/**
 * Apply `dmg` (already resisted) to `target`, shield-first. `src` is the attacker
 * faction (drives the hit fx colour); the hit event is emitted at the target's
 * position with the remaining shield attached. On depletion emits `shield_break`
 * and — for a character carrying one — fires its shield-break passive.
 *
 * `firePassive` guards against recursive break (design/07): the passive's own AoE
 * damage calls back in with `false`, so a break can never trigger another passive.
 */
export function takeDamage(
  state: GameState,
  target: Actor,
  dmg: number,
  src: DamageSrc,
  type: DamageType,
  firePassive = true,
  crit = false,
): void {
  target.ticksSinceHit = 0;
  const hadShield = target.shield > 0;
  if (target.shield >= dmg) {
    target.shield -= dmg;
  } else {
    target.hp -= dmg - target.shield;
    target.shield = 0;
  }
  state.events.push({
    type: 'hit',
    target: target.id,
    faction: src,
    gx: target.gx,
    gy: target.gy,
    damage: dmg,
    damageType: type,
    shieldRemaining: target.shield,
    ...(crit ? { crit: true as const } : {}),
  });
  if (hadShield && target.shield === 0) {
    state.events.push({ type: 'shield_break', id: target.id, gx: target.gx, gy: target.gy });
    if (firePassive && target.shieldBreak) fireShieldBreak(state, target, target.shieldBreak);
  }
}

/**
 * Top up `target`'s health by up to `amount`, clamped to `maxHp`, and announce what actually went
 * in as a `heal` event (design/10 "Damage numbers"). Returns that amount; 0 means nothing changed
 * and nothing was announced. The one legal way for a player-visible heal to land, so the number
 * over a head can never disagree with the bar under it.
 */
export function restoreHp(state: GameState, target: Actor, amount: number): number {
  const gained = Math.max(0, Math.min(target.maxHp, target.hp + amount) - target.hp);
  if (gained <= 0) return 0;
  target.hp += gained;
  state.events.push({ type: 'heal', target: target.id, gx: target.gx, gy: target.gy, amount: gained, pool: 'hp' });
  return gained;
}

/** `restoreHp`'s twin for the shield pool (a battery or a shop's shield line). Not used by the
 *  idle regen in `StatusEffectSystem`, which is ambient rather than something the player did. */
export function restoreShield(state: GameState, target: Actor, amount: number): number {
  const gained = Math.max(0, Math.min(target.maxShield, target.shield + amount) - target.shield);
  if (gained <= 0) return 0;
  target.shield += gained;
  state.events.push({ type: 'heal', target: target.id, gx: target.gx, gy: target.gy, amount: gained, pool: 'shield' });
  return gained;
}

/**
 * A character's shield shattered → its bound passive resolves in-sim (design/02/07).
 * `aoe` bursts integer damage to every actor HOSTILE to the owner whose body is
 * within reach (design/15 — routed through takeDamage with firePassive=false, the
 * recursion guard); `knock` adds an outward impulse into the target's knockVx/knockVy
 * (design/07 v25 — a channel MovementSystem decays with friction, independent of the
 * target's own vx/vy). Foes are iterated in array order (ties by push order) so it
 * stays deterministic (design/08). Distances are squared integers.
 */
function fireShieldBreak(state: GameState, owner: Actor, passive: ShieldBreakSim): void {
  const foes = hostileTargets(state, owner);
  for (const f of foes) {
    const dx = f.gx - owner.gx;
    const dy = f.gy - owner.gy;
    const reach = passive.radius + f.radius;
    if (dx * dx + dy * dy > reach * reach) continue;
    if (passive.kind === 'aoe') {
      takeDamage(state, f, passive.damage, owner.faction, 'physical', false); // guard: no re-trigger
    } else {
      const ang = atan2Brad(dy, dx); // outward, from owner to foe
      f.knockVx = addFp(f.knockVx, mulFp(cosFp(ang), passive.impulse));
      f.knockVy = addFp(f.knockVy, mulFp(sinFp(ang), passive.impulse));
    }
  }
}
