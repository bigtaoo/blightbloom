/**
 * Step 8 — Status effects (design/03/07 elements). Ticks the lingering on-hit
 * statuses that HitResolve (step 7) STARTED: burn and poison deal damage-over-time,
 * chill counts down (MovementSystem reads it to slow the actor). Runs AFTER hit
 * resolution and BEFORE death & drops (step 9) so a DoT kill is swept — and rolls a
 * drop — the same tick, exactly like a direct-hit kill.
 *
 * DoT lands on the global `state.tick % DOT_INTERVAL` cadence, so every burning /
 * poisoned actor ticks in lockstep — no per-actor clock field, fully deterministic
 * (design/06). Burn is one refreshing timer; poison is independent stacks, each
 * aged and expired on its own. All damage is integer and only lowers hp (death is
 * step 9's call, matching HitResolve). Applies to players and enemies uniformly.
 */
import { DOT_INTERVAL } from '../content/damage';
import { SHIELD_REGEN_DELAY, SHIELD_REGEN_INTERVAL } from '../config';
import { ENERGY_REGEN_INTERVAL, regenEnergy } from '../balance/energy';
import { takeDamage } from './combat';
import type { GameState } from '../state/GameState';
import type { Actor, PlayerActor } from '../state/entities';

export class StatusEffectSystem {
  tick(state: GameState): void {
    const dotTick = state.tick % DOT_INTERVAL === 0;
    // Weapon energy regen (design/03/05, ENGINE_VERSION 59) on the same GLOBAL-cadence
    // pattern as the DoT above and the beam's damage window (design/07/08): every
    // player refills on the same tick boundary, so there is no per-actor clock field to
    // keep in step across clients (design/06).
    const energyTick = state.tick % ENERGY_REGEN_INTERVAL === 0;
    for (const p of state.players) {
      if (!p.alive || p.downed) continue; // downed = invulnerable (3.2), and cannot shoot
      this.actor(state, p, dotTick);
      if (energyTick) this.regen(p);
    }
    for (const e of state.enemies) if (e.alive) this.actor(state, e, dotTick);
  }

  /**
   * Refill a player's weapon-energy pool. UNCONDITIONAL, unlike the shield's idle
   * timer below: the starter gun is priced just under the regen line
   * (`balance/energy.ts`), so a regen that stopped while you were being shot at would
   * take the one weapon you always have below break-even in exactly the moments it is
   * the only thing you have. The shield stays the pool that rewards disengaging; this
   * one is the pool that keeps the baseline gun honest.
   */
  private regen(p: PlayerActor): void {
    if (p.energy < p.maxEnergy) p.energy = regenEnergy(p.energy, p.maxEnergy);
  }

  private actor(state: GameState, a: Actor, dotTick: boolean): void {
    const st = a.status;
    // The DoT source faction (fx colour) is the opposite of the sufferer's.
    const src = a.faction === 'enemy' ? 'player' : 'enemy';

    if (dotTick) {
      // DoT is shield-first too (design/07): a shield can soak a burn, and a DoT that
      // empties it breaks like any hit — takeDamage also resets ticksSinceHit, so a
      // lingering status keeps regen suppressed.
      if (st.burnTicks > 0 && st.burnDmg > 0) {
        takeDamage(state, a, st.burnDmg, src, 'fire');
        state.events.push({ type: 'status', effect: 'burn', target: a.id, gx: a.gx, gy: a.gy });
      }
      let poisonDmg = 0;
      for (const s of st.poison) poisonDmg += s.dmg;
      if (poisonDmg > 0) {
        takeDamage(state, a, poisonDmg, src, 'poison');
        state.events.push({ type: 'status', effect: 'poison', target: a.id, gx: a.gx, gy: a.gy });
      }
    }

    // Age every timer by one tick. Burn/chill reset their magnitude at expiry so a
    // later, weaker application can't inherit a stale value (HitResolve keeps the
    // MAX burn tick while active).
    if (st.burnTicks > 0 && --st.burnTicks === 0) st.burnDmg = 0;
    if (st.chillTicks > 0 && --st.chillTicks === 0) st.chillSlow = 0;
    if (st.poison.length > 0) {
      for (const s of st.poison) s.ticks--;
      // Remove expired stacks in place, preserving push order (deterministic).
      let w = 0;
      for (let r = 0; r < st.poison.length; r++) {
        const s = st.poison[r]!;
        if (s.ticks > 0) st.poison[w++] = s;
      }
      st.poison.length = w;
    }

    // Shield regen (idle timer, design/07). Runs AFTER the DoT sub-pass: advance the
    // idle counter, then — once past the delay — refill +1 on each interval boundary,
    // capped at maxShield. Because a DoT tick this frame already zeroed ticksSinceHit
    // (takeDamage), an actor still burning/poisoned can't regen — the "clear your
    // status to recover" rule falls out for free. maxShield 0 → nothing to regen.
    //
    // The delay is per-dungeon since 2026-11-11 (`DungeonConfig.shieldRegenDelay`), because
    // "stay unhit for 3 s" is a rule a learning player in their first room never satisfies
    // — they are hit about once a second and collect nothing back. A config without the
    // field reads `SHIELD_REGEN_DELAY`, i.e. every run outside chapter 1 is unchanged.
    // Only the delay moves: `SHIELD_REGEN_INTERVAL` still sets the refill rate everywhere.
    const regenDelay = state.dungeonConfig?.shieldRegenDelay ?? SHIELD_REGEN_DELAY;
    a.ticksSinceHit++;
    if (
      a.maxShield > 0 &&
      a.shield < a.maxShield &&
      a.ticksSinceHit >= regenDelay &&
      (a.ticksSinceHit - regenDelay) % SHIELD_REGEN_INTERVAL === 0
    ) {
      a.shield = Math.min(a.maxShield, a.shield + 1);
    }
  }
}
