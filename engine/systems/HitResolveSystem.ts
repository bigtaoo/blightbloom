/**
 * Step 7 — Hit resolution. Hostile bullets that overlap cancel each other
 * (mutual destruction, resolved first so a cancelled bullet can't also hit an actor
 * this tick). Then bullet–actor overlap deals damage to any actor hostile to the
 * bullet (design/15 team model — no longer "the other array": a player's bullet
 * can hit a rival player, not just enemies) and consumes the bullet; a melee swing whose
 * ACTIVE window is open this tick (`swingTicksLeft > 0`, design/07 step 7) re-tests its arc
 * against every hostile actor in the sector, hitting each at most once for the whole swing.
 * Damage only lowers hp here — death is decided in step 9,
 * matching design/08's separation. The projectiles array is compacted in place at
 * the end, after clash/step/block/hit have all resolved.
 *
 * Every hit funnels through one resolver, `applyHit` (design/07 "one shared
 * resolver"): apply the target's per-type resist, subtract integer damage, then —
 * by the hit's DamageType — layer the on-hit status (burn/chill/poison) or arc to a
 * neighbour (lightning). The lingering DoT/chill is ticked later by
 * StatusEffectSystem (step 8); `applyHit` only *starts* the effect. All status math
 * is integer (design/06); the chain uses squared-distance nearest, no trig.
 *
 * Ports the hit branches of Game.ts updateBullets()/resolveMeleeHit(); radians →
 * brad, float px → fp, squared-distance overlap tests. Knockback / armor / i-frames
 * are design/07 and land later. (The demo's per-frame multi-hit melee is corrected
 * to once-per-swing, per design/07 — which is a different claim from once-per-TICK, and the
 * distinction is the whole point of `swingHitIds`: the swing spans several ticks now, and
 * the cap is per swing.)
 */
import { addFp, isqrt, mulFp, type Fp } from '../math/fixed';
import { atan2Brad, bradDiff, cosFp, sinFp, type Brad } from '../math/trig';
import { inBeamLine } from '../content/ballistics';
import { RICOCHET_RANGE_FP } from '../config';
import type { GameState } from '../state/GameState';
import type { Actor, Faction, MeleeSimSpec, Projectile, WeaponState } from '../state/entities';
import { isHostile } from '../state/entities';
import { hostileTargets } from './targeting';
import { nearestByPosition } from './nearest';
import type { DamageType } from '../content/damage';
import {
  BURN_DURATION,
  CHAIN_DMG_PERMILLE,
  CHAIN_RANGE,
  CHILL_DURATION,
  CHILL_SLOW,
  POISON_MAX_STACKS,
  POISON_STACK_DMG,
  POISON_STACK_DURATION,
  applyResist,
  burnDamageFor,
} from '../content/damage';
import { buffedDamage, critDamage, enrageBuffs, rollCrit, sumBuffs, type BuffSums } from '../balance/runbuffs';
import { restoreHp, takeDamage } from './combat';
import { circlesOverlap, retainAlive } from './geom';

/** Alive members of `group` other than `exclude`, in original array order — the
 *  shared candidate filter `retarget` (ricochet) and `chain` (lightning) both need
 *  before handing off to `nearestByPosition`. */
function* aliveExcluding(group: readonly Actor[], exclude: Actor): Generator<Actor> {
  for (const a of group) if (a.alive && a !== exclude) yield a;
}

export class HitResolveSystem {
  tick(state: GameState): void {
    // Lob landings + beam channels (design/03/09, ROADMAP 1.1) resolve first: a
    // landed lob is about to die this tick regardless, and a beam bullet never
    // moves/clashes/direct-hits like a normal bullet — both are handled entirely
    // through these dedicated passes, then excluded below.
    this.resolveLandedLobs(state);
    this.resolveBeams(state);
    this.resolveBulletClash(state);

    for (const b of state.projectiles) {
      if (!b.alive || b.ballistic === 'beam' || b.landed) continue;
      // design/15: every actor hostile to this bullet, regardless of which
      // array it lives in — a player's bullet can now hit a rival player, not
      // just enemies (hostileTargets excludes downed players in PvE, 3.2; PvP
      // targets them too, design/05/15).
      const targets = hostileTargets(state, b);
      for (const t of targets) {
        // Never re-hit a body this bullet already connected with — needed for BOTH
        // piercing (the original reason) AND ricochet: a retarget only changes
        // VELOCITY, and a large-radius target can stay inside the bullet's overlap
        // circle for a tick or two after the bounce, which would otherwise re-trigger
        // a hit against the very body it just bounced off (caught live: a browser
        // test showed a ricochet burning both its bounces on the SAME enemy instead
        // of ever reaching the second one 20px away — this guard is why it doesn't).
        if (b.hitIds?.includes(t.id)) continue;
        if (!circlesOverlap(b.gx, b.gy, b.radius, t.gx, t.gy, t.radius)) continue;
        this.applyHit(state, t, b.damage, b.damageType, b.faction, targets, b.ownerId, b.lifestealPermille, b.crit === true);
        // Bullet fate after a connecting hit (design/07): ricochet retargets first if
        // it has bounces left (ENGINE_VERSION 28) and another target is in range; else
        // piercing keeps it flying past this body; else it expires — the original,
        // still-default behavior. Both surviving cases remember `t.id`.
        if (b.ricochetsLeft !== undefined && b.ricochetsLeft > 0 && this.retarget(b, t, targets)) {
          b.ricochetsLeft--;
          (b.hitIds ??= []).push(t.id);
        } else if (b.piercing) {
          (b.hitIds ??= []).push(t.id);
        } else {
          b.alive = false;
        }
        break;
      }
    }

    // Melee: every actor whose swing window is OPEN this tick, not just the tick it started
    // (design/07 step 7, ENGINE_VERSION 53). The alive/downed gate is re-checked per tick on
    // purpose — an attacker killed or downed part-way through its own swing stops swinging.
    //
    // Enemies were added to this loop in ENGINE_VERSION 59, with the melee mobs
    // (content/enemies.ts STALKER/RAVAGER). Until then only players could swing, which is
    // why `EnemyBlueprint.weapon` was typed ranged-only: the two constraints held each
    // other up, and a melee mob authored without this loop would have walked up to the
    // player, played its swing animation, and dealt nothing.
    //
    // Players first, then enemies — the same players-then-enemies order every other
    // multi-array pass in the engine uses (design/06: array order IS the tie-break), so
    // two simultaneous killing blows resolve identically on every client.
    for (const p of state.players) {
      const w = p.weapon;
      if (!p.alive || p.downed || !w || w.spec.kind !== 'melee' || w.swingTicksLeft <= 0) continue;
      // Player run buffs scale outgoing arc damage (design/14).
      this.meleeArc(state, p, w, sumBuffs(p.buffs));
    }
    for (const e of state.enemies) {
      const w = e.weapon;
      if (!e.alive || !w || w.spec.kind !== 'melee' || w.swingTicksLeft <= 0) continue;
      // A mob carries no run buffs; the one thing that scales its output is enrage, read
      // off the latch WeaponFireSystem set at step 3 (balance/runbuffs.ts `enrageBuffs`).
      // No melee boss exists today, so this is identity for every shipped mob — wired
      // anyway, because the alternative is a melee boss that enrages its swing SPEED and
      // not its damage, which is a bug that only appears the day someone authors one.
      this.meleeArc(state, e, w, enrageBuffs(e));
    }

    retainAlive(state.projectiles);
  }

  /** Lob landing (design/03/09): a bullet ProjectileStepSystem flagged `landed` this
   * tick detonates through the normal resist/status hit path against every
   * HOSTILE actor within `blastRadius` (design/15), then dies — no direct-hit special
   * case (a lob that connects mid-flight already consumed itself as a normal hit,
   * above, before ever reaching landed). */
  private resolveLandedLobs(state: GameState): void {
    for (const b of state.projectiles) {
      if (!b.alive || !b.landed || b.blastRadius === undefined) continue;
      const targets = hostileTargets(state, b); // excludes downed players in PvE (3.2); PvP targets them too (05/15)
      for (const t of targets) {
        const dx = (t.gx - b.gx) as number;
        const dy = (t.gy - b.gy) as number;
        const reach = (b.blastRadius + t.radius) as number;
        if (dx * dx + dy * dy > reach * reach) continue;
        this.applyHit(state, t, b.damage, b.damageType, b.faction, targets, b.ownerId, b.lifestealPermille, b.crit === true);
      }
      b.alive = false;
    }
  }

  /**
   * Beam channels (design/03/09): a beam bullet never moves (frozen at its fire-time
   * origin/direction); on the global `state.tick % beamTickInterval` cadence — the
   * same lockstep pattern StatusEffectSystem uses for DoT (design/07: no per-instance
   * clock) — it damages every hostile actor (design/15) along its line, once per
   * cadence tick, for as long as it stays alive (ProjectileStepSystem counts down
   * `beamTicksLeft` and kills it at 0).
   */
  private resolveBeams(state: GameState): void {
    for (const b of state.projectiles) {
      if (!b.alive || b.ballistic !== 'beam') continue;
      if (!b.beamTickInterval || state.tick % b.beamTickInterval !== 0) continue;
      const targets = hostileTargets(state, b); // excludes downed players in PvE (3.2); PvP targets them too (05/15)
      const dir = b.beamDir ?? (0 as Brad);
      const range = b.beamRange ?? (0 as Projectile['radius']);
      for (const t of targets) {
        if (!inBeamLine(b.gx, b.gy, dir, range, t.gx, t.gy, t.radius)) continue;
        this.applyHit(state, t, b.damage, b.damageType, b.faction, targets, b.ownerId, b.lifestealPermille, b.crit === true);
      }
    }
  }

  /**
   * The single shared hit resolver (design/07). `attacker` is the bullet/swinger's
   * own faction (drives the 'hit' fx colour — not re-derived, since it's already
   * exactly this); `group` is the hostile-target pool the hit was drawn from
   * (design/15's `hostileTargets`, not a hardcoded array), used as the lightning
   * chain's candidate pool. Applies resist → integer damage → on-hit status, then
   * k_lifesteal (ENGINE_VERSION 28) if `sourceOwnerId` names a real player and
   * `lifestealPermille` is set — both optional so every non-procced hit is unaffected.
   * Death is NOT decided here (step 9). All arithmetic is integer.
   */
  private applyHit(
    state: GameState,
    target: Actor,
    rawDamage: number,
    type: DamageType,
    attacker: Faction,
    group: readonly Actor[],
    sourceOwnerId?: number,
    lifestealPermille?: number,
    crit = false,
  ): void {
    const dmg = applyResist(rawDamage, type, target.resist);
    // Shield-first absorb + hit event + shield_break (design/07 two-pool takeDamage).
    takeDamage(state, target, dmg, attacker, type, true, crit);
    if (lifestealPermille) this.applyLifesteal(state, sourceOwnerId, dmg, lifestealPermille);
    // Status magnitude keys off the resisted hit, independent of how it split shield/hp.
    this.applyStatus(state, target, dmg, type, group);
  }

  /** k_lifesteal (design/03/09, ENGINE_VERSION 28): heal `sourceOwnerId`'s player by a
   * ‰ of the damage just dealt, clamped to maxHp. A no-op if `sourceOwnerId` doesn't
   * name a live player (an enemy weapon with lifesteal, or a bullet whose owner died
   * mid-flight) — enemies aren't in `state.players`, so this can never accidentally
   * heal one. Min 1 so a low-damage lifesteal weapon still visibly ticks HP up. */
  private applyLifesteal(state: GameState, sourceOwnerId: number | undefined, dmg: number, permille: number): void {
    if (sourceOwnerId === undefined) return;
    const owner = state.players.find((p) => p.id === sourceOwnerId);
    if (!owner || !owner.alive) return;
    restoreHp(state, owner, Math.max(1, Math.trunc((dmg * permille) / 1000)));
  }

  /** k_ricochet (design/03/09, ENGINE_VERSION 28): redirect `b` toward the nearest
   * OTHER alive hostile in `group` within RICOCHET_RANGE_FP, preserving its current
   * speed magnitude (never accelerates/decelerates a bounce). Nearest by squared
   * distance, ties by array order (design/08) — same shape as the lightning chain's
   * own nearest-search. Returns false (bullet should just expire) if no target
   * qualifies, so the caller doesn't have to duplicate the "no bounce possible" case. */
  private retarget(b: Projectile, hit: Actor, group: readonly Actor[]): boolean {
    const reachSq = (RICOCHET_RANGE_FP * RICOCHET_RANGE_FP) as number;
    const best = nearestByPosition(b.gx, b.gy, aliveExcluding(group, hit), { reachSq });
    if (!best) return false;
    const ang = atan2Brad(best.gy - b.gy, best.gx - b.gx);
    const speed = isqrt(((b.vx * b.vx + b.vy * b.vy) as number)) as Fp;
    b.vx = mulFp(cosFp(ang), speed);
    b.vy = mulFp(sinFp(ang), speed);
    return true;
  }

  /** Layer the element's on-hit effect. `dmg` is the post-resist damage just dealt. */
  private applyStatus(
    state: GameState,
    target: Actor,
    dmg: number,
    type: DamageType,
    group: readonly Actor[],
  ): void {
    const st = target.status;
    switch (type) {
      case 'fire': {
        // Burn REFRESHES: reset the timer, keep the stronger tick (design: fire is a
        // topped-up DoT, not a stacking one).
        st.burnTicks = BURN_DURATION;
        st.burnDmg = Math.max(st.burnDmg, burnDamageFor(dmg));
        state.events.push({ type: 'status', effect: 'burn', target: target.id, gx: target.gx, gy: target.gy });
        break;
      }
      case 'ice': {
        st.chillTicks = CHILL_DURATION;
        st.chillSlow = CHILL_SLOW;
        state.events.push({ type: 'status', effect: 'chill', target: target.id, gx: target.gx, gy: target.gy });
        break;
      }
      case 'poison': {
        // STACKING DoT: each hit adds an independent stack (up to the cap). Oldest
        // stacks age out on their own timers (StatusEffectSystem). Cap by dropping
        // the new hit when full — the oldest keeps ticking (deterministic).
        if (st.poison.length < POISON_MAX_STACKS) {
          st.poison.push({ ticks: POISON_STACK_DURATION, dmg: POISON_STACK_DMG });
        }
        state.events.push({ type: 'status', effect: 'poison', target: target.id, gx: target.gx, gy: target.gy });
        break;
      }
      case 'lightning': {
        // CHAIN: arc to the nearest OTHER alive actor in the target's own group,
        // within range, for a fraction of the hit. One hop, no further status (no
        // recursion). Nearest by squared distance; ties broken by array order (08).
        this.chain(state, target, dmg, group);
        state.events.push({ type: 'status', effect: 'shock', target: target.id, gx: target.gx, gy: target.gy });
        break;
      }
      case 'physical':
        break; // raw damage only
    }
  }

  /** Lightning arc: deal a fraction of `dmg` to the nearest other in-group actor in range. */
  private chain(state: GameState, from: Actor, dmg: number, group: readonly Actor[]): void {
    const reachSq = CHAIN_RANGE * CHAIN_RANGE;
    const best = nearestByPosition(from.gx, from.gy, aliveExcluding(group, from), { reachSq });
    if (!best) return;
    const chainDmg = Math.max(1, Math.trunc((dmg * CHAIN_DMG_PERMILLE) / 1000));
    // A chained hit is a hit: shield-first, and it can break a shield too (design/07).
    takeDamage(state, best, chainDmg, from.faction === 'enemy' ? 'player' : 'enemy', 'lightning');
    state.events.push({ type: 'status', effect: 'shock', target: best.id, gx: best.gx, gy: best.gy });
  }

  /**
   * Hostile bullets that overlap annihilate each other (design/15 — was a
   * `faction` equality check, so two rival PLAYERS' bullets never used to clash;
   * two SAME-team bullets, including a squad's own, still pass through). O(n²)
   * over the live bullets, i<j so each pair is tested once; ties/order are the
   * array's push order, so the outcome is deterministic (design/08). A bullet
   * cancels at most one other per tick (marked dead on first clash), which is
   * enough — anything still alive falls through to the actor-hit loop below.
   */
  private resolveBulletClash(state: GameState): void {
    const ps = state.projectiles;
    for (let i = 0; i < ps.length; i++) {
      const a = ps[i]!;
      if (!a.alive || a.ballistic === 'beam' || a.landed) continue;
      for (let j = i + 1; j < ps.length; j++) {
        const b = ps[j]!;
        if (!b.alive || !isHostile(a, b) || b.ballistic === 'beam' || b.landed) continue;
        if (!circlesOverlap(a.gx, a.gy, a.radius, b.gx, b.gy, b.radius)) continue;
        a.alive = false;
        b.alive = false;
        state.events.push({ type: 'clash', gx: a.gx, gy: a.gy });
        break; // a is gone — move to the next bullet
      }
    }
  }

  /**
   * One ACTIVE tick of a melee swing (design/07 step 7). Called on every tick of the
   * weapon's `swingTicks` window, not once per swing, which is what makes the arc a window
   * rather than a snapshot: the test re-runs against the LIVE facing and the LIVE positions,
   * so a target that walks into the sector, or one the player turns onto mid-swing, is caught
   * — the sweep. What does NOT re-run is the payload: damage and the crit roll are frozen on
   * the start tick (`justSwung`) into `w.swingDamage`, and `w.swingHitIds` keeps each body to
   * one hit for the whole swing. Both are design/07's "one frozen payload, one swing" —
   * without them a 6-tick hammer would deal its damage six times over and draw `combatPrng`
   * six times for one attack.
   */
  private meleeArc(state: GameState, p: Actor, w: WeaponState, buffs: BuffSums): void {
    const spec = w.spec as MeleeSimSpec;
    if (w.justSwung) {
      // `buffs` comes from the caller (ENGINE_VERSION 59) rather than being read off the
      // attacker here: a player's is its run-buff stack, a mob's is its enrage state, and
      // the two live on different types. Reaches any hostile actor (design/15) — a rival
      // player included, not just state.enemies, and for an enemy attacker that means the
      // players, by the same predicate.
      // Crit (design/07 "one frozen payload"): rolled ONCE per swing, at swing time —
      // not re-rolled per target OR per active tick — so every enemy caught in one arc
      // either all crit or none do, matching "one swing, one attack" rather than a
      // lottery per body hit. This is still the same single draw per swing it was before
      // the window existed, on the same tick, so the `combatPrng` cursor is untouched.
      const isCrit = rollCrit(buffs, state.combatPrng);
      w.swingDamage = critDamage(buffedDamage(spec.damage, buffs), isCrit);
      w.swingCrit = isCrit;
    }
    const damage = w.swingDamage;
    const targets = hostileTargets(state, p);
    for (const t of targets) {
      // Once per swing per body, across the WHOLE window (design/07). Checked before the
      // geometry so a target that stays parked inside the arc costs one test, not a hit.
      if (w.swingHitIds.includes(t.id)) continue;
      const dx = t.gx - p.gx;
      const dy = t.gy - p.gy;
      const reach = spec.range + t.radius;
      if (dx * dx + dy * dy > reach * reach) continue;
      const ang = atan2Brad(dy, dx);
      if (Math.abs(bradDiff(ang, p.facing)) > spec.arcHalf) continue;
      w.swingHitIds.push(t.id);
      // The damage SOURCE faction is the attacker's own (ENGINE_VERSION 59) — it was
      // hardcoded 'player' while players were the only thing that could swing, which
      // would have coloured a mob's own hit fx as if the player had dealt it.
      this.applyHit(state, t, damage, spec.damageType, p.faction, targets, p.id, spec.lifestealPermille, w.swingCrit === true);
      // Melee knockback (design/07 v25): shove the target outward along the same
      // attacker→target direction already computed for the arc test, into its
      // knockVx/knockVy (MovementSystem integrates + decays it; never vx/vy directly —
      // see that field's doc comment for why). 0 for any weapon with knockback: 0.
      if (spec.knockback > 0) {
        t.knockVx = addFp(t.knockVx, mulFp(cosFp(ang), spec.knockback));
        t.knockVy = addFp(t.knockVy, mulFp(sinFp(ang), spec.knockback));
      }
    }
  }
}
