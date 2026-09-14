/**
 * Applying a run buff to a player — the one definition of it (design/14).
 *
 * Extracted from `PickupSystem.applyBuff` on 2026-09-14, when the shop counter became a
 * SECOND way to acquire a buff. Split as CLAUDE.md form ① (an independent free function),
 * and the reason is the one `balance/floorCards.ts` already states about its own `buff`
 * cards: a buff bought at a counter must be exactly as strong as the same buff picked up off
 * the floor, and a second implementation of the Sigma-then-clamp delta is precisely the drift
 * design/18's consistency gates exist to catch.
 */
import { RUN_BUFFS, sumBuffs } from '../balance/runbuffs';
import type { PlayerActor } from '../state/entities';

/**
 * Add a run buff to the player's stack (design/14). mult_* buffs take effect at use
 * time (WeaponFire / HitResolve read the summed stack); the two `flat_*` families are
 * cumulative actor state, so they are applied HERE — but Σ-then-clamp still holds: we
 * add only the *delta* each new buff contributes to its clamped total (0 once that
 * cap is reached), and grow both the ceiling and the current value by it. Unknown id →
 * no-op (forward-compat).
 *
 * `flat_energy` (ENGINE_VERSION 60) follows `flat_hp` exactly, INCLUDING the "+2 max HP
 * also heals +2" half: a capacity buff that raised the ceiling without filling it would
 * hand a player who took it mid-fight nothing at all until regen caught up, which is
 * the one moment they picked it for. Both are read back off the same `sumBuffs` call so
 * the two deltas cannot disagree about which stack they were computed from.
 */
export function applyRunBuff(p: PlayerActor, buffId: string): void {
  if (!RUN_BUFFS[buffId]) return;
  const before = sumBuffs(p.buffs);
  p.buffs.push(buffId);
  const after = sumBuffs(p.buffs);
  const hpDelta = after.flat_hp - before.flat_hp;
  if (hpDelta > 0) {
    p.maxHp += hpDelta;
    p.hp += hpDelta;
  }
  const energyDelta = after.flat_energy - before.flat_energy;
  if (energyDelta > 0) {
    p.maxEnergy += energyDelta;
    p.energy += energyDelta;
  }
}
