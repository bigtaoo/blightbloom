/**
 * Step 3 — Weapon fire. For every actor whose fire flag is set and whose weapon
 * cooldown is ready: ranged spawns Projectile(s) at the muzzle; melee OPENS a swing —
 * `justSwung` latches the start tick and `swingTicksLeft` holds the spec's active hit
 * window open for `swingTicks` ticks (design/07 step 7, ENGINE_VERSION 53), which is what
 * HitResolve (step 7) re-tests its arc against and DeflectSystem (step 6) parries inside.
 * Both clocks — cooldown and window — count down here, in whole ticks. Runs BEFORE movement
 * (design/08) so a bullet spawns at this tick's muzzle, then everything moves.
 *
 * Ports RangedWeapon.use() / MeleeWeapon.use() and the enemy-fire block of
 * Game.ts updateEnemies(): float cos/sin → fp-trig, px → grid-fp.
 *
 * Emission (design/03 "orthogonal to ballistic", ROADMAP 1.1): `bullets` pellets
 * fire per trigger; for bullets > 1 each pellet's angle jitters within ±spreadHalf,
 * drawn from combatPrng (a single-pellet pinpoint shot draws nothing — the baseline
 * guns advance no new PRNG stream). The ballistic id + its params are frozen onto
 * each spawned Projectile, exactly like damageType (design/07 payload) — motion
 * (ProjectileStepSystem) and the beam's damage-over-window (HitResolveSystem) read
 * them from there, never re-reading the spec.
 *
 * Weapon energy (design/03/05, ENGINE_VERSION 59): a PLAYER's ranged pull is charged
 * `spec.energyCost` from its shared pool before anything is spawned, and refused
 * outright when the pool cannot cover it — with the cooldown left untouched, so the
 * trigger retries rather than burning a recovery on a shot that never happened. Melee
 * is free, which is what makes the always-owned melee half of the loadout the fallback
 * at empty. Enemies have no pool and are never charged. See `balance/energy.ts` for
 * why the price is indexed on the weapon's MECHANIC and how the numbers were measured.
 */
import { addFp, mulFp } from '../math/fixed';
import { cosFp, sinFp, normBrad, type Brad } from '../math/trig';
import { radialDir } from '../content/ballistics';
import {
  buffedCooldown,
  buffedDamage,
  critDamage,
  enrageBuffs,
  rollCrit,
  sumBuffs,
  NO_BUFFS,
  type BuffSums,
} from '../balance/runbuffs';
import { closeSwing, openSwing } from '../content/weapons';
import { spendEnergy } from '../balance/energy';
import type { GameState } from '../state/GameState';
import type { Actor, EnemyActor, PlayerActor, RangedSimSpec } from '../state/entities';

export class WeaponFireSystem {
  tick(state: GameState): void {
    // Run buffs are player-level (design/14): a player's summed-clamped stack scales
    // its damage + attack speed; enemies carry none (NO_BUFFS = identity) UNLESS
    // enraged (design/09 `traits`, ENGINE_VERSION 27) — see enrageBuffs below.
    for (const p of state.players) this.actor(state, p, sumBuffs(p.buffs));
    for (const e of state.enemies) {
      this.latchArmorBreak(state, e);
      this.actor(state, e, this.latchEnrage(state, e));
    }
  }

  /**
   * Boss armor break (design/09 traits, ENGINE_VERSION 70) — the defensive mirror of
   * `latchEnrage` below: the instant hp first crosses the blueprint's threshold,
   * REPLACE `resist` with `armorBreak.resist` (one-way, same "enemies never self-heal"
   * reasoning `latchEnrage` gives) and emit a fx-only event. Runs before `latchEnrage`
   * so a boss that carried both traits would have its post-break resist already active
   * for the SAME tick's enrage check — not that any shipped blueprint carries both
   * (`enemies.test.ts` pins that as a deliberate axis separation, not an oversight).
   */
  private latchArmorBreak(state: GameState, e: EnemyActor): void {
    if (!e.armorBreak || e.armorBroken) return;
    if (e.hp * 1000 > e.maxHp * e.armorBreak.hpThresholdPermille) return;
    e.armorBroken = true;
    e.resist = e.armorBreak.resist;
    state.events.push({ type: 'armor_break', id: e.id, gx: e.gx, gy: e.gy });
  }

  /**
   * Boss enrage (design/09 aspirational `traits`, ENGINE_VERSION 27): the instant hp
   * first crosses the blueprint's threshold, latch `enraged` (one-way — enemies never
   * self-heal today, so re-checking every tick would be pure waste) and emit a fx-only
   * event. Reuses the EXACT SAME BuffSums/buffedDamage/buffedCooldown composition a
   * player's run buffs go through — no separate damage-scaling code path for enemies.
   */
  private latchEnrage(state: GameState, e: EnemyActor): BuffSums {
    if (!e.enrage) return NO_BUFFS;
    if (!e.enraged && e.hp * 1000 <= e.maxHp * e.enrage.hpThresholdPermille) {
      e.enraged = true;
      state.events.push({ type: 'enrage', id: e.id, gx: e.gx, gy: e.gy });
    }
    // The COMPOSITION moved to balance/runbuffs.ts in ENGINE_VERSION 59 so
    // HitResolveSystem's melee arc can read the identical numbers off the latch this
    // method sets; what stays here is the latch and its event, which are step 3's alone.
    return enrageBuffs(e);
  }

  private actor(state: GameState, a: Actor, buffs: BuffSums): void {
    const w = a.weapon;
    if (!w) return;
    w.justSwung = false;
    // Age the melee active hit window (design/07 step 7, ENGINE_VERSION 53) alongside the
    // cooldown, and for the same reason it sits above the early return: both are clocks that
    // have to advance on a tick where the actor never gets to act. Decrementing HERE, at step
    // 3, before the swing below can reload it, is what makes the window exactly `swingTicks`
    // ticks long — the swing tick sees the full value, and each of the following `swingTicks-1`
    // turns knocks one off before steps 6/7 read it.
    if (w.swingTicksLeft > 0) {
      w.swingTicksLeft--;
      // The window just closed — drop the swing's bookkeeping so a weapon at rest holds no
      // stale hit list (and so `swingHitIds` can't grow across swings).
      if (w.swingTicksLeft === 0) closeSwing(w);
    }
    if (w.cooldownTicks > 0) w.cooldownTicks--;
    if (!a.alive || !a.firing || w.cooldownTicks > 0) return;

    if (w.spec.kind === 'ranged') {
      // Energy (design/03/05, ENGINE_VERSION 59) — charged per TRIGGER PULL, before a
      // single pellet exists, so a spread frame pays once for the decision it is.
      //
      // A refused pull leaves the cooldown UNTOUCHED, which is the whole behaviour of
      // running dry: the trigger keeps retrying every tick and fires the instant regen
      // covers the next shot, instead of eating a full recovery for a shot that never
      // happened. That also means an empty player is regen-PACED rather than disarmed —
      // an expensive frame degrades into a slow one, and the always-owned melee half
      // (design/03) is what you switch to if you don't want to wait.
      //
      // Enemies are structurally never charged: `asEnergyUser` returns null for anything
      // that is not a player, so `enemygun`'s price is inert and a mob can never be silenced by an
      // economy it has no pool for. That is a trust boundary, not an optimisation —
      // charging enemies would make a garrison stop shooting mid-fight for a reason
      // nothing on screen explains.
      const player = asEnergyUser(a);
      if (player !== null) {
        const left = spendEnergy(player.energy, w.spec.energyCost);
        if (left === null) return;
        player.energy = left;
      }
      this.fireRanged(state, a, w.spec, buffs);
      w.cooldownTicks = buffedCooldown(w.spec.fireRateTicks, buffs);
    } else {
      // Latch the START flag and open the ACTIVE hit window together (design/07 step 7) —
      // one call, because setting only one of them makes a broken swing. See `openSwing`.
      openSwing(w);
      // The melee half of design/08's one engine->render channel, and the exact counterpart of
      // `spawnBullet`'s `bullet_fired` push: the swing is otherwise invisible to the render
      // layer, since `justSwung` is a one-tick latch the online loop can drain straight past
      // (see the event's own doc comment in state/events.ts). Emitted for the SWING, not for
      // its hits -- a swing that connects with nothing still has to animate.
      // The event carries no weapon data (see its own doc comment): the render layer resolves
      // the spec -- and with it the active hit window it paces the swing off -- from the
      // GameState every client already holds.
      state.events.push({ type: 'melee_swing', ownerId: a.id, faction: a.faction, gx: a.gx, gy: a.gy, facing: a.facing });
      w.cooldownTicks = buffedCooldown(w.spec.swingCooldownTicks, buffs);
    }
  }

  private fireRanged(state: GameState, a: Actor, spec: RangedSimSpec, buffs: BuffSums): void {
    const pellets = Math.max(1, spec.bullets);
    for (let i = 0; i < pellets; i++) {
      // Radial emission (design/03): an even ring around facing, DETERMINISTIC — no PRNG
      // draw at all. Orthogonal to the ballistic each pellet then flies with.
      // Spread emission (the default / baseline): a single-pellet pinpoint shot draws
      // nothing (byte-identical to the pre-1.1 baseline); a >1-pellet spread weapon
      // jitters each pellet within ±spreadHalf from combatPrng.
      const dir: Brad =
        spec.pattern === 'radial' && pellets > 1
          ? radialDir(a.facing, i, pellets)
          : pellets > 1 && spec.spreadHalf > 0
            ? normBrad(a.facing + (state.combatPrng.nextInt(spec.spreadHalf * 2 + 1) - spec.spreadHalf))
            : a.facing;
      this.spawnBullet(state, a, spec, dir, buffs);
    }
  }

  private spawnBullet(state: GameState, a: Actor, spec: RangedSimSpec, dir: Brad, buffs: BuffSums): void {
    const cos = cosFp(dir);
    const sin = sinFp(dir);
    const gx = addFp(a.gx, mulFp(cos, spec.muzzleOffset));
    const gy = addFp(a.gy, mulFp(sin, spec.muzzleOffset));
    // Crit (design/07 "one frozen payload"): rolled once per pellet, at fire time,
    // frozen straight into the bullet's damage — never re-rolled on impact.
    const isCrit = rollCrit(buffs, state.combatPrng);
    state.projectiles.push({
      id: state.nextId(),
      faction: a.faction,
      teamId: a.teamId, // design/15 — the targeting predicate reads this, not faction
      gx,
      gy,
      z: spec.bulletZ,
      vx: mulFp(cos, spec.bulletSpeed),
      vy: mulFp(sin, spec.bulletSpeed),
      radius: spec.bulletRadius,
      damage: critDamage(buffedDamage(spec.damage, buffs), isCrit), // buffs + crit frozen at fire time
      damageType: spec.damageType, // frozen onto the bullet (design/07 payload)
      lifeTicks: spec.bulletLifeTicks,
      alive: true,
      // Ballistic runtime (design/03/09, ROADMAP 1.1) — frozen from the spec, like
      // damageType above. 'straight' reads none of the optional params.
      ballistic: spec.ballistic,
      turnRateBrad: spec.turnRateBrad,
      speed: spec.ballistic === 'homing' ? spec.bulletSpeed : undefined,
      returnAfterTicks: spec.returnAfterTicks,
      ticksAlive: spec.ballistic === 'boomerang' ? 0 : undefined,
      blastRadius: spec.blastRadius,
      beamTicksLeft: spec.beamTicks,
      beamTickInterval: spec.beamTickInterval,
      beamDir: spec.ballistic === 'beam' ? dir : undefined,
      beamRange: spec.beamRange,
      // Set on EVERY bullet now (ENGINE_VERSION 28), not just orbit's — k_lifesteal
      // (HitResolveSystem) needs to know who fired a bullet to heal them; every other
      // read site still gates on `ballistic === 'orbit'`, never on mere presence, so
      // this is additive for every non-orbit ballistic (see the field's doc comment).
      ownerId: a.id,
      orbitRadius: spec.orbitRadius,
      orbitAngleBrad: spec.ballistic === 'orbit' ? dir : undefined,
      orbitAngularVelBrad: spec.orbitAngularVelBrad,
      // Piercing (ENGINE_VERSION 28 — authored since Stage C, wired now).
      piercing: spec.piercing,
      // k_* on-hit procs (ENGINE_VERSION 28) — frozen from the spec like damageType.
      lifestealPermille: spec.lifestealPermille,
      ricochetsLeft: spec.ricochetCount,
    });
    state.events.push({ type: 'bullet_fired', ownerId: a.id, faction: a.faction, gx, gy, facing: dir });
  }
}

/**
 * The actor as an energy spender, or null if it does not have a pool (design/03/05).
 *
 * Keyed on `faction`, not on the presence of the field: `faction === 'player'` is the
 * same predicate every other player-only rule in the engine uses, it covers BOTH sides
 * of a PvP match (two hostile teams are both `player`), and it cannot be accidentally
 * satisfied by a hand-built enemy fixture that happens to carry an `energy` number.
 */
function asEnergyUser(a: Actor): PlayerActor | null {
  return a.faction === 'player' ? (a as PlayerActor) : null;
}
