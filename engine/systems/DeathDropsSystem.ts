/**
 * Step 9 — Death & drops. Any actor at hp<=0 dies (death event); a dead enemy
 * rolls the dropPrng against the DROP_TABLE (design/05/09) for a coin / health /
 * weapon pickup, tagged with this tick so the next step's Pickup pass can't
 * auto-vacuum it the same frame (design/08 note on ordering). Players don't drop.
 * Dead enemies are compacted out in place.
 *
 * Ports Game.ts onEnemyKilled() — Math.random() → dropPrng (a real determinism
 * fix), float px → fp. Score is not tracked in the engine; render derives it from
 * the death/pickup/wave_clear events (design/08 "events are the only channel").
 */
import { rollDrop, rollArenaDrop } from '../content/drops';
import { buildEnemyActor } from '../content/enemies';
import { DOWNED_BLEEDOUT_TICKS } from '../config';
import { toFp, addFp, mulFp } from '../math/fixed';
import { cosFp, sinFp, BRAD_FULL } from '../math/trig';
import type { GameState } from '../state/GameState';
import type { EnemyActor, PickupItem } from '../state/entities';
import { blockingRadius, dropClearance } from '../state/actorRadius';
import { clampToWalkable, retainAlive } from './geom';
import { payFloorWeaponShortfall } from './floorLoot';
import { resolveFloorCards } from '../balance/floorCards';
import { EARNABLE_BLUEPRINTS } from '../content/blueprints';
import { BLUEPRINT_DROP_PERMILLE } from '../config';

export class DeathDropsSystem {
  tick(state: GameState): void {
    for (const e of state.enemies) {
      if (!e.alive || e.hp > 0) continue;
      e.alive = false;
      state.events.push({ type: 'death', id: e.id, faction: 'enemy', gx: e.gx, gy: e.gy, r: e.radius });
      this.rollBlueprint(state, e);
      // Boss adds (design/09 aspirational `onDeathSpawn`, ENGINE_VERSION 27, funny's
      // own onDeathSpawn design/07 already named as the intended home for this).
      // Ringed evenly around the dying boss's own body radius — PRNG-free, same even-
      // ring convention as `radialDir`'s emission pattern — then clamped into walkable
      // space (a boss can die flush against a wall, same reasoning as v24's pickup
      // clamp). Pushing into state.enemies mid-loop is safe: a freshly spawned minion
      // has hp>0, so this SAME loop's own guard skips it as a no-op on the iteration
      // it's visited (never double-processed, never contributes a second death/drop).
      if (e.onDeathSpawn) {
        for (let i = 0; i < e.onDeathSpawn.count; i++) {
          const ang = Math.round((i * BRAD_FULL) / e.onDeathSpawn.count);
          const rawGx = addFp(e.gx, mulFp(cosFp(ang), e.radius));
          const rawGy = addFp(e.gy, mulFp(sinFp(ang), e.radius));
          const minion = buildEnemyActor(state, rawGx, rawGy, e.onDeathSpawn.type);
          // Clamp by the minion's own SOLID clearance — the radius `MovementSystem` will push
          // it out by — not by the `dropClearance()` the pickups below use, and not
          // by its feet circle. This said `minion.footprintRadius` through v48, under a comment
          // that already claimed "a spawned actor needs its own solid clearance": the intent was
          // right and the radius was wrong, because solids stopped pushing `footprintRadius` in
          // v43 (players) / v48 (enemies) and nothing re-checked the comment. The consequence
          // was a guaranteed first-tick teleport for any minion clamped tight — placed with a
          // 9 px feet circle against a wall that then displaced its 20 px body. Fixed in v49;
          // `clearanceParity.test.ts` measures it rather than restating the radii.
          const pos = clampToWalkable(rawGx, rawGy, blockingRadius(minion), state);
          minion.gx = pos.gx;
          minion.gy = pos.gy;
          // Inherit the dying boss's own roomId DIRECTLY (never left to next tick's
          // EnvironmentSystem inference) — same reasoning as SpawnSystem's
          // dispatchDungeonSpawns (engine/systems/SpawnSystem.ts). Without this,
          // DoorSystem's hasLiveEnemy scan (step 11.5, this SAME tick) skips the
          // minion as roomId===undefined and sees the boss room as cleared for one
          // tick — the door briefly unlocks, then re-locks (and force-regroups the
          // player back) the instant EnvironmentSystem catches up next tick.
          minion.roomId = e.roomId;
          state.enemies.push(minion);
        }
      }
      // Arena mode rolls its own table (design/15, ROADMAP 4.3) — never `material`,
      // zero connection to the PvE account/materials economy. Depth signal for the
      // PvE material tier (design/09 materialTierByDepth, ROADMAP 1.5): state.floorIndex
      // is 0 for every config without floors, so this is identical to the old no-arg
      // call for every existing config.
      const drop = state.zoneEnabled
        ? rollArenaDrop(state.dropPrng)
        : rollDrop(state.dropPrng, state.floorIndex, {
            weaponAllowed: this.weaponAllowed(state, e),
            // The `potion_flow` floor card, re-derived from the run's picked cards
            // rather than mirrored into a counter (design/05, ENGINE_VERSION 58).
            // `effectiveWeights` clamps it to HEAL_DROP_MULT_CAP and pays for it out
            // of `material`, so stacking the card never changes the weapon odds.
            healMult: resolveFloorCards(state.floorCards).healDropMult,
          });
      // Clamp off the dying enemy's own position — a knockback or a large
      // footprint can leave that position on/behind a wall, which would otherwise
      // drop the pickup somewhere the player can't reach (design/07 pickups).
      //
      // By the PLAYER'S OWN clearance, not the pickup's collect padding (`dropClearance`,
      // ENGINE_VERSION 50): the thing that has to reach this spot is a player's body, so the
      // spot has to be one a player's body can occupy. See `state/actorRadius.ts` for the
      // report and for the measurement that says the old radius was tight rather than broken.
      const pos = clampToWalkable(e.gx, e.gy, dropClearance(), state);
      const item: PickupItem = {
        id: state.nextId(),
        kind: drop.kind,
        gx: pos.gx,
        gy: pos.gy,
        spawnTick: state.tick,
        alive: true,
      };
      if (drop.kind === 'weapon') {
        item.weaponId = drop.weaponId;
        this.noteWeaponDropped(state, e.roomId);
      }
      if (drop.kind === 'buff') item.buffId = drop.buffId;
      if (drop.kind === 'material') {
        item.materialId = drop.materialId;
        item.qty = drop.qty;
        item.tier = drop.tier;
      }
      state.pickups.push(item);
      this.payFloorShortfall(state, e);
    }

    // A player at 0 HP goes DOWNED, not dead (design/05/07, ROADMAP 3.2): frozen and
    // revivable by a teammate. Permanent death (alive=false) only happens later, in
    // ReviveSystem, if the bleedout timer expires unrevived. Skip already-downed players
    // (their hp is already 0) so we don't re-trigger the transition every tick.
    for (const p of state.players) {
      if (!p.alive || p.downed || p.hp > 0) continue;
      p.downed = true;
      p.hp = 0; // clamp any overkill to 0
      p.bleedoutTicks = DOWNED_BLEEDOUT_TICKS;
      p.reviveProgressTicks = 0;
      p.vx = toFp(0);
      p.vy = toFp(0); // frozen in place (design/07)
      p.firing = false;
      state.events.push({ type: 'downed', id: p.id, gx: p.gx, gy: p.gy });
    }

    retainAlive(state.enemies);
  }

  // ── Per-floor weapon allowance (design/05, 2026-09-05) ──────────────────────
  //
  // The drop table decides WHEN a weapon shows up; these three decide HOW MANY a
  // floor ends up with. The target is 2-3, and a weight alone cannot hold it: at
  // ~60-77 enemies per floor, 5/84 per kill produced 0 to 5 weapons across the 16
  // measured bot runs in `client/sim/pveLevelSim.sim.ts`.
  //
  // Dungeon configs only. A flat `waves`/`floors` config has no floor to allocate
  // against and no rooms to spread across, so it stays on the plain table — which is
  // also what keeps every golden scenario's weapon odds untouched by this pass.

  /**
   * May this kill yield a weapon? Two independent gates, both of which have to be
   * open: the floor's remaining quota (the COUNT) and this room's own flag (the
   * CONCENTRATION — one weapon per room, so a floor's whole allowance cannot land on
   * the first garrison and leave five rooms bare).
   *
   * An enemy with no `roomId` (a flat config, or one that died before
   * EnvironmentSystem placed it) is quota-gated but not room-gated: there is no room
   * to charge it to, and refusing the drop outright would silently make the allowance
   * unfillable.
   */
  private weaponAllowed(state: GameState, e: EnemyActor): boolean {
    if (!state.dungeonEnabled || state.floorWeaponQuota < 0) return true;
    if (state.floorWeaponsDropped >= state.floorWeaponQuota) return false;
    if (e.roomId === undefined) return true;
    const rt = state.dungeonRoomRuntime[state.dungeonRoomIndexById.get(e.roomId) ?? -1];
    return rt === undefined || !rt.weaponDropped;
  }

  /** Charge a granted weapon against the floor's quota and its room's flag. */
  private noteWeaponDropped(state: GameState, roomId: string | undefined): void {
    if (!state.dungeonEnabled || state.floorWeaponQuota < 0) return;
    state.floorWeaponsDropped++;
    if (roomId === undefined) return;
    const rt = state.dungeonRoomRuntime[state.dungeonRoomIndexById.get(roomId) ?? -1];
    if (rt) rt.weaponDropped = true;
  }

  /**
   * Pay an under-filled floor on the capstone kill, so 2-3 is a guarantee and not a
   * ceiling with a bad tail. Fires the tick the capstone (boss / extraction) room's
   * last live enemy dies, dropping the remainder on the body — the owner's call over
   * stacking them at the portal.
   *
   * This is only ONE of the two ways a floor gets finished; a capstone with no enemy
   * spawns at all (four of the shipped level's five floors end in one) never reaches
   * here, and `ExtractionSystem` pays those at the checkpoint instead. Both go through
   * `payFloorWeaponShortfall`.
   *
   * "Last live enemy" is measured as no OTHER enemy in the room with `hp > 0`, not as
   * `!rt.hasLiveEnemy` — that flag is DoorSystem's, recomputed at step 11.5, two steps
   * after this one, so it still describes the room as it was before this tick's deaths.
   * The `hp > 0` test is exact regardless of iteration order: an enemy already processed
   * this tick is `alive === false`, and one not yet reached is at `hp <= 0` and will die
   * on its own iteration. A boss's `onDeathSpawn` minions are pushed with full HP before
   * this runs, so a boss that splits into adds correctly does NOT count as the room's
   * last enemy — the make-up drop waits for the adds.
   */
  /**
   * A boss kill rolls a blueprint at `BLUEPRINT_DROP_PERMILLE` (design/14, 2026-09-14) — the
   * earn-by-playing half of the meta, and `ROADMAP` B5's answer.
   *
   * **Why it lands on the carry-out bag instead of on the floor.** A blueprint is
   * ACCOUNT-level: it must survive the run, which the "weapons are ephemeral" rule forbids
   * for a pickup, and it is not a material so `bankedMaterials` cannot carry it either. Since
   * 2026-09-14 the boss kill IS the extraction (design/05 "the boss is the only exit"), so the
   * roll lands at the one moment a run is already handing its carry-out to the meta layer, and
   * `state.runBlueprint` rides that same handover. It is forfeited by a death exactly like the
   * materials are, for the same reason and by the same mechanism: nothing hands it over unless
   * the run is WON.
   *
   * **`EnemyActor.boss` becomes a field the sim reads.** It was render-only ("like `tint`"),
   * and this is the change that ends that — see its own doc comment in `state/entities/actors.ts`.
   *
   * **What this deliberately does NOT know: what the player already owns.** That is account
   * state, and account state may never enter the sim (design/06) — so the roll picks from the
   * whole earnable pool and the meta layer's `unlockBlueprint` is idempotent. A player who
   * already owns all three earnable blueprints can therefore win a roll that grants nothing.
   * That is a real (and known) dud, filed rather than fixed: fixing it means either telling the
   * sim about the account or re-rolling outside it, and both are worse than a rare no-op on a
   * pool this small.
   */
  private rollBlueprint(state: GameState, e: EnemyActor): void {
    if (e.boss !== true || state.runBlueprint !== null) return;
    // Guard BEFORE the draw, not after: an empty pool must cost zero `dropPrng` draws, or the
    // stream would depend on content that awards nothing. (`validateBlueprints` refuses an
    // empty pool outright, so this is belt-and-braces for a hand-built test catalog.)
    if (EARNABLE_BLUEPRINTS.length === 0) return;
    if (state.dropPrng.nextInt(1000) >= BLUEPRINT_DROP_PERMILLE) return;
    state.runBlueprint = EARNABLE_BLUEPRINTS[state.dropPrng.nextInt(EARNABLE_BLUEPRINTS.length)]!;
    state.events.push({ type: 'blueprint_drop', weaponId: state.runBlueprint, gx: e.gx, gy: e.gy });
  }

  private payFloorShortfall(state: GameState, e: EnemyActor): void {
    if (!state.dungeonEnabled || state.floorWeaponQuota < 0) return;
    if (state.floorWeaponsDropped >= state.floorWeaponQuota) return;
    // The capstone is always the LAST placed room (generateFloor/placeAuthoredFloor
    // both append it last) — the same room ExtractionSystem opens the portal on.
    const capstone = state.dungeonRooms[state.dungeonRooms.length - 1];
    if (capstone === undefined || e.roomId !== capstone.id) return;
    if (state.enemies.some((o) => o.alive && o.hp > 0 && o.roomId === capstone.id)) return;
    payFloorWeaponShortfall(state, e.gx, e.gy);
  }
}
