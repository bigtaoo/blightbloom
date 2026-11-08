/**
 * Step 2 — AI decide (both modes). Each enemy sets its own intent from state +
 * aiPrng: face the (first alive) player, close the distance toward it until
 * within gun range, then fire once actually in range; the weapon cooldown gates
 * the actual shot in WeaponFire. Enemies used to be fully stationary in the
 * slice (turn + shoot only, see ENGINE_VERSION_HISTORY.md v37) — reported as
 * "the AI doesn't move".
 *
 * Ports client/src/game/Enemy.ts tick() (atan2 facing + fire request), radians →
 * brad. The demo's `gx % 1` fire-phase jitter is replaced by an aiPrng-seeded
 * initial cooldown set in SpawnSystem — a real determinism fix.
 *
 * Fire-range gate (ENGINE_VERSION 40, design/05): a live player report — "the
 * instant I walk into a room, dozens of enemies gun me down before I can react"
 * — traced to `firing` being set unconditionally true the moment a room
 * activates, regardless of how far the enemy actually was from the player;
 * `engageRangeFp` only ever gated `chase()`'s stop-moving decision (v37), never
 * whether the mob was allowed to shoot. With level 1's hand-authored rooms
 * holding 15-30 enemies each (v38) and `ENEMY_GUN_SIM`'s bullet travel (~30
 * grid) comfortably covering a room's full diagonal, that meant every enemy in
 * an activated room opened fire on tick 1 no matter where it spawned — a
 * whole-room alpha strike with zero reaction time, the opposite of how a room
 * full of enemies plays in Soul Knight/Enter the Gungeon: enemies notice you
 * across the whole room (the room stays the aggro unit, unchanged), but only
 * the ones already close enough actually shoot; the rest have to visibly close
 * distance first, which is exactly the reaction window the report was missing.
 * Fixed: `firing` is now true only once the enemy is within its own
 * `engageRangeFp` (the same distance `chase()` already used to decide when to
 * stop closing) — "stop and shoot" is now literal instead of "shoot from
 * anywhere and also stop once close".
 *
 * Room fire budget (ENGINE_VERSION 41, design/05 "Room encounter budget"): the
 * v40 fix above turned out to buy only about half a second. `client/sim/
 * pveLevelSim.sim.ts` — a bot-driven level simulator written specifically to put
 * a number on the same recurring report — measured 14 of a 15-enemy room's mobs
 * firing on the same tick, a first hit 0.6s after activation, and death in ~2s
 * in 100% of runs at both bot skill profiles: enemies simply CLOSED to engage
 * range as one blob and opened up together, which the range gate does nothing
 * about. Two additions, both per-ROOM rather than per-mob, since the room is
 * already this game's aggro unit (design/05):
 *   - `grantFireSlots` — at most `ROOM_FIRE_BUDGET` (balance/encounter.ts) mobs
 *     per room may have `firing` set on a tick, awarded to the NEAREST
 *     contenders. The rest hold position in range with `firing` false, taking a
 *     slot as soon as a shooter dies or the player moves and reorders the queue.
 *   - `hasNoticed` — a freshly-activated room's mobs may move immediately but
 *     hold fire for a per-enemy staggered delay (`noticeDelayTicks`, derived
 *     from the enemy id, no PRNG draw), so entering a room is never an instant
 *     volley from whichever mobs were authored nearest the door.
 * `chaseAndEngage` no longer sets `firing` at all — it reports "in range" and
 * `grantFireSlots` is the single writer of `firing = true`.
 *
 * Perception radius (ENGINE_VERSION 42, live play report 2026-08-17 — "怪物的感知
 * 范围弄小一些"): room activation is the OUTER aggro gate and stays exactly as it was,
 * but a woken room's mobs now only react once the player is within their own
 * `aggroRangeFp` (`hasAggro`). Before this, activating a room set its entire garrison
 * — up to 14 mobs on level 1 — walking at the player from wherever they were authored,
 * so a room read as one converging blob rather than as a space with pockets of threat
 * in it. An un-noticed mob is fully inert: it does not move, fire, OR turn to face the
 * player. The flag is a one-way latch, so this is a wake-up trigger and never a leash.
 *
 * Room activation gate (design/05 "Room & door model", 2026-08-04): in dungeon
 * mode, an enemy whose room hasn't activated yet (no player has ever reached it)
 * runs NO decision logic at all — `firing`/`vx`/`vy` are simply left at whatever
 * they already were (false/0 for a freshly-spawned enemy, since `SpawnSystem`
 * never sets them), i.e. inert. This is the one and only place "AI behavior" is
 * gated, movement included.
 */
import { isqrt } from '../math/fixed';
import type { Fp } from '../math/fixed';
import { atan2Brad } from '../math/trig';
import {
  DEFAULT_ENEMY_MOVE_SPEED_PER_TICK,
  DEFAULT_ENEMY_ENGAGE_RANGE_FP,
  DEFAULT_ENEMY_AGGRO_RANGE_FP,
} from '../content/enemies';
import { HOLD_RELEASE_PERMILLE, noticeDelayTicks, roomFireBudget } from '../balance/encounter';
import type { GameState } from '../state/GameState';
import type { Actor, EnemyActor } from '../state/entities';
import { standoffRadius } from '../state/actorRadius';
import { assignApproachSlots, type ApproachSlot } from './approachSlots';

/** A mob that is in range, has noticed the player, and is therefore competing for
 *  one of its room's fire slots. `distSq` is what the slots are awarded by. */
interface FireContender {
  e: EnemyActor;
  distSq: number;
}

/** Bucket key for a mob with no `roomId` (a flat `waves`/tutorial config, or the
 *  one tick before EnvironmentSystem assigns one) — such mobs share a single
 *  budget, since "the room" is the whole arena for them. */
const NO_ROOM = '#unroomed';

export class AIDecideSystem {
  // Refilled every tick, never read across ticks: the mobs actually chasing this tick, and the
  // point each one is walking to. Scratch rather than fresh arrays because this runs at 30 Hz
  // for every activated room (same reasoning as MovementSystem's own pair scratch).
  private readonly chasers: EnemyActor[] = [];
  private readonly slots: ApproachSlot[] = [];

  tick(state: GameState): void {
    // Enemies ignore downed players (design/07, 3.2) — no camping a body that can't fight back.
    const target = state.players.find((p) => p.alive && !p.downed) ?? null;
    const chasers = this.chasers;
    chasers.length = 0;

    for (const e of state.enemies) {
      if (!e.alive) continue;
      if (state.dungeonEnabled && !this.isActivated(state, e.roomId)) continue;
      if (!target) {
        e.firing = false;
        e.holding = false; // nothing to stand off from — stop reserving space (v55)
        e.vx = 0 as Fp;
        e.vy = 0 as Fp;
        continue;
      }
      const dx = target.gx - e.gx;
      const dy = target.gy - e.gy;
      if (!this.hasAggro(e, dx, dy)) {
        // Hasn't noticed the player yet: fully inert, and deliberately NOT turned to
        // face them either — a mob that tracks you with its gun barrel from across the
        // room while standing still reads as "aware but passive", which is the opposite
        // of what the perception radius is for.
        // No `holding = false` here, deliberately: `aggroed` is a one-way latch whose writers
        // (`hasAggro` below, and `takeDamage` for a `wakeOnHurt` mob since v92) only ever set
        // it, and `holding` can only ever be set AFTER that latch is on, so a mob reaching
        // this branch has never held. A mutation battery (v55) found the reset dead — it was
        // the only mutant of the three survivors that wanted deleting rather than testing.
        e.firing = false;
        e.vx = 0 as Fp;
        e.vy = 0 as Fp;
        continue;
      }
      e.facing = atan2Brad(dy, dx);
      chasers.push(e);
    }

    if (target !== null) this.steerChasers(state, target);
  }

  /**
   * Give every chasing mob its own standing spot around the target and walk it there
   * (ENGINE_VERSION 56, `approachSlots.ts`), then hand out the room's fire slots.
   *
   * The two-pass shape is the whole change: v55 and earlier decided each mob's velocity in the
   * same loop that looked at it, which meant the only destination a mob could be given was the
   * one thing it knew about — the player — so a garrison converged on one point and was pulled
   * apart afterwards by `MovementSystem.resolveStandingSpacing`. Choosing where each mob is
   * GOING needs to see the other mobs, so the walk decision now happens after the whole
   * garrison has been collected.
   */
  private steerChasers(state: GameState, target: Actor): void {
    const chasers = this.chasers;
    if (chasers.length === 0) return;
    assignApproachSlots(state, chasers, target.gx, target.gy, this.slots);
    // Insertion-ordered (spawn order) — see grantFireSlots' determinism note.
    const contenders = new Map<string, FireContender[]>();
    for (let i = 0; i < chasers.length; i++) {
      const e = chasers[i]!;
      const distSq = this.chaseAndEngage(e, target.gx - e.gx, target.gy - e.gy, this.slots[i]!);
      // In range (chaseAndEngage left `firing` false) and past its notice delay → it wants to
      // shoot, pending a slot.
      if (distSq !== null && this.hasNoticed(state, e)) {
        const key = e.roomId ?? NO_ROOM;
        const list = contenders.get(key);
        if (list) list.push({ e, distSq });
        else contenders.set(key, [{ e, distSq }]);
      }
    }
    this.grantFireSlots(contenders, roomFireBudget(state.dungeonConfig?.fireBudgetByFloor, state.floorIndex));
  }

  /**
   * Has this mob noticed the player (ENGINE_VERSION 42)? The INNER aggro gate, inside
   * design/05's room-as-the-aggro-unit outer one: a woken room's far side stays idle
   * until the player is within `aggroRangeFp`, instead of the entire garrison marching
   * across the room the tick the door opens (live play report, 2026-08-17).
   *
   * One-way latch (`e.aggroed`): a mob at the exact boundary would otherwise flip
   * between chasing and idling every tick, since chasing carries it back inside the
   * radius and idling leaves it outside. Latched means the radius is a wake-up trigger,
   * not a leash — nothing here ever puts a mob back to sleep.
   */
  private hasAggro(e: EnemyActor, dx: number, dy: number): boolean {
    if (e.aggroed) return true;
    const range = e.aggroRangeFp ?? DEFAULT_ENEMY_AGGRO_RANGE_FP;
    if (dx * dx + dy * dy > range * range) return false;
    e.aggroed = true;
    return true;
  }

  /**
   * Walk the mob to its own standing spot around the target, and report whether it is in
   * range to shoot (v37 first pass for the movement half — no kiting yet, see the module's
   * matching content/enemies.ts default constants for the tuning rationale; v40 added the
   * firing gate, v41 the room budget — see the module doc comment). Still a straight-line
   * pursuit, just at a point rather than at the player: MovementSystem's push-out keeps a
   * chasing mob from clipping through a wall or another actor, it does not route AROUND one,
   * so a mob can still stall against a concave wall.
   *
   * The destination is what changed in ENGINE_VERSION 56 (`approachSlots.ts`). Through v55
   * every mob aimed at the player itself and stopped on its engage ring wherever it happened
   * to get there, so a garrison arrived as one silhouette and `resolveStandingSpacing` pulled
   * it apart over the next half second (live report: *"现在的做法是怪先跑到一起，然后再分散开。
   * 我希望的是一步到位"*). Now the spot each mob walks to already accounts for the standing
   * volume of every other mob heading in, so the garrison arrives spread.
   *
   * Returns the squared distance to the TARGET when the mob is in range (i.e. eligible to
   * fire, if it gets a slot), else null. Distance to the target, not to the spot: what a gun
   * cares about is how far away the player is. `firing` is left false here in every case;
   * only `grantFireSlots` ever sets it true.
   *
   * `e.holding` is that same in-range answer, published as state so
   * `MovementSystem.resolveStandingSpacing` can space arrived mobs out (ENGINE_VERSION
   * 55) — and the reason "in range" is HYSTERETIC rather than a bare threshold: that spacing
   * pushes a standing mob outward, so a mob that stopped on the ring can be nudged just past
   * it, and a bare test would send it straight back into a chase-push-chase shuffle with its
   * gun stuttering on and off. Entered at `engageRangeFp`, left only past
   * `HOLD_RELEASE_PERMILLE` of it.
   */
  private chaseAndEngage(e: EnemyActor, dx: number, dy: number, slot: ApproachSlot): number | null {
    const range = e.engageRangeFp ?? DEFAULT_ENEMY_ENGAGE_RANGE_FP;
    const distSq = dx * dx + dy * dy;
    e.firing = false;
    const stopAt = e.holding ? this.holdReleaseRange(range) : range;
    const inRange = distSq <= stopAt * stopAt;
    e.holding = inRange;
    this.stepToward(e, slot);
    // "Stop and shoot" stays literal (v40): a mob may only contend for a fire slot on a tick
    // it is not walking. In range is no longer the same thing as stopped since v56 — a mob
    // can be inside its engage range and still sliding round to the spot it was given — and
    // if that counted as engaged, a garrison would open fire while it was still arranging
    // itself, which is the alpha strike v40/v41 exist to prevent, in a new costume.
    return inRange && e.vx === 0 && e.vy === 0 ? distSq : null;
  }

  /**
   * One tick of walking toward `slot`, or a full stop once there.
   *
   * "There" is within one of the mob's own steps, because a step is the finest move it has:
   * a tighter tolerance would only buy a permanent one-tick-out, one-tick-back jitter around
   * the spot. The spot itself is placed `RING_MARGIN_STEPS` inside the engage range
   * (`approachSlots.ts`) precisely so that stopping a step short of it still leaves the mob
   * in range to shoot.
   *
   * The stop is NOT gated on being in range, unlike the one it replaces: a mob sent to an
   * outer ring by a crowded inner one has to be able to park there too. And a mob that is in
   * range but not yet at its spot keeps walking, sliding round the ring into place rather
   * than stopping in someone else's spot and waiting to be shoved out of it.
   *
   * ## Why an arrived mob has a much wider deadband than a walking one
   *
   * A spot is anchored to the target, so it MOVES when the player does — and with a single
   * one-step tolerance that turns every arrived mob into a mob that shadows the player step
   * for step at its engage range, which is a different game (and measurably a harder one:
   * `test:pve-sim` put the careful bot's average floor at 0.5 against 1.3 before this
   * deadband went in). Standing still is the behaviour v37 shipped and nothing in this pass
   * is meant to change it; what this pass changes is WHERE a mob stands, not whether it
   * stays there.
   *
   * So arrival is hysteretic, keyed off the mob's own current velocity — no new state field:
   * a mob that is already stopped and in range only sets off again once its spot has moved a
   * whole standing volume away (`standoffRadius`, ~30 px), while a mob already walking
   * carries on to within a step of it. A mob still out of range always closes, deadband or
   * not — that is the chase, and it is what `engageRangeFp` already bounds.
   */
  private stepToward(e: EnemyActor, slot: ApproachSlot): void {
    const speed = e.moveSpeedPerTick ?? DEFAULT_ENEMY_MOVE_SPEED_PER_TICK;
    const dx = (slot.x as number) - e.gx;
    const dy = (slot.y as number) - e.gy;
    const distSq = dx * dx + dy * dy;
    const settled = e.holding && e.vx === 0 && e.vy === 0;
    const deadband = settled ? Math.max(standoffRadius(e) as number, speed) : speed;
    if (distSq <= deadband * deadband) {
      e.vx = 0 as Fp;
      e.vy = 0 as Fp;
      return;
    }
    const dist = isqrt(distSq); // > deadband >= 0, so never a divide by zero
    e.vx = Math.trunc((dx * speed) / dist) as Fp;
    e.vy = Math.trunc((dy * speed) / dist) as Fp;
  }

  /**
   * The wider radius a mob already holding position is allowed to be pushed out to
   * before it counts as out of range again (`HOLD_RELEASE_PERMILLE`). Integer per-mille
   * scale, truncated — the same shape as every other per-mille dial in the sim
   * (design/06: no floats reach state).
   */
  private holdReleaseRange(range: number): number {
    return Math.trunc((range * HOLD_RELEASE_PERMILLE) / 1000);
  }

  /**
   * Hand each room's `budget` fire slots (`roomFireBudget`: `ROOM_FIRE_BUDGET` unless the
   * dungeon sets one for this floor) to its NEAREST contenders
   * (balance/encounter.ts — the anti-alpha-strike rule). Everyone else stays in
   * range with `firing` false: present, closing off nothing, waiting for a slot to
   * free up when a shooter dies or the player moves and reorders the queue.
   *
   * Determinism (design/06): the bucket Map is keyed by roomId in first-seen =
   * spawn order, and `Array.prototype.sort` is specified stable, so equal-distance
   * mobs keep `state.enemies` order — the same array-order tie-break convention the
   * rest of the engine uses. Distances are exact integer products of Fp, never
   * floats.
   */
  private grantFireSlots(contenders: Map<string, FireContender[]>, budget: number): void {
    for (const list of contenders.values()) {
      if (list.length > budget) list.sort((a, b) => a.distSq - b.distSq);
      const slots = Math.min(budget, list.length);
      for (let i = 0; i < slots; i++) list[i]!.e.firing = true;
    }
  }

  /**
   * Has this mob finished noticing the player? A freshly-activated room's garrison
   * moves at once but holds fire for a per-enemy stagger (balance/encounter.ts), so
   * the player gets a reaction window on entry instead of an instant volley from
   * whichever mobs happened to be authored close to the door.
   *
   * Dungeon mode only: `roomTick` (ticks since activation) is the clock this measures
   * against, and a flat `waves`/tutorial config has no room runtime at all. Those
   * configs keep v40 behaviour for the delay (they still get the fire budget) —
   * their enemies stream in mid-fight rather than sitting pre-placed in a room the
   * player walks into, so there is no "walked into an ambush" moment to soften.
   */
  private hasNoticed(state: GameState, e: EnemyActor): boolean {
    if (!state.dungeonEnabled || e.roomId === undefined) return true;
    const idx = state.dungeonRoomIndexById.get(e.roomId);
    const rt = idx === undefined ? undefined : state.dungeonRoomRuntime[idx];
    return rt === undefined || rt.roomTick >= noticeDelayTicks(e.id);
  }

  private isActivated(state: GameState, roomId: string | undefined): boolean {
    if (roomId === undefined) return false;
    const idx = state.dungeonRoomIndexById.get(roomId);
    if (idx === undefined) return false;
    return state.dungeonRoomRuntime[idx]?.activated ?? false;
  }
}
