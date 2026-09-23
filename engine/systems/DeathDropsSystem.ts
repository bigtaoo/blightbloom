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
import { rollWeaponId } from '../content/weaponRarityByDepth';
import { buildEnemyActor } from '../content/enemies';
import { BOSS_WEAPON_DROPS, DOWNED_BLEEDOUT_TICKS } from '../config';
import { toFp, addFp, mulFp } from '../math/fixed';
import { cosFp, sinFp, BRAD_FULL } from '../math/trig';
import type { GameState } from '../state/GameState';
import type { EnemyActor, PickupItem } from '../state/entities';
import { blockingRadius, dropClearance } from '../state/actorRadius';
import { clampToWalkable, retainAlive } from './geom';
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
      const cards = state.zoneEnabled ? undefined : resolveFloorCards(state.floorCards);
      const drop = state.zoneEnabled
        ? rollArenaDrop(state.dropPrng)
        : rollDrop(state.dropPrng, state.floorIndex, {
            // The `potion_flow` floor card, re-derived from the run's picked cards
            // rather than mirrored into a counter (design/05, ENGINE_VERSION 58).
            // `effectiveWeights` clamps it to HEAL_DROP_MULT_CAP and pays for it out
            // of `material`, so stacking the card never changes the other odds.
            healMult: cards!.healDropMult,
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
      // Arena only — PvE's table has had no weapon entry since 2026-09-14.
      if (drop.kind === 'weapon') item.weaponId = drop.weaponId;
      if (drop.kind === 'buff') item.buffId = drop.buffId;
      if (drop.kind === 'material') {
        item.materialId = drop.materialId;
        item.qty = drop.qty;
        item.tier = drop.tier;
      }
      // The `windfall` floor card is applied HERE rather than inside `rollDrop`, which is
      // the one structural difference between it and `potion_flow` above: that card changes
      // the table's WEIGHTS and so has to be inside the draw, while this one changes a
      // payload and must stay outside it. A multiplier folded into the roll would make the
      // card's presence part of the dropPrng stream for no reason at all.
      if (drop.kind === 'coin') item.qty = drop.qty * (cards?.coinMult ?? 1);
      state.pickups.push(item);
      this.dropBossWeapons(state, e);
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

  /**
   * A boss kill rolls a one-time blueprint SCHEMATIC at `BLUEPRINT_DROP_PERMILLE` (design/14,
   * 2026-09-14, reworked ENGINE_VERSION 68) — the earn-by-playing half of the meta, and
   * `ROADMAP` B5's answer.
   *
   * **A physical ground pickup, like `dropBossWeapons` two methods down** — no longer a
   * state-wide flag every seat's client applied to its own account identically. Whichever
   * seat's actor walks over it is the one who carries it out (design/14, "a one-time
   * schematic, first to touch keeps it" — same per-seat rule `material` now follows), so in
   * a squad a seat that already owns every earnable blueprint can simply leave it for a
   * teammate who does not. `PickupSystem`'s `'schematic'` case sets the collector's own
   * `PlayerActor.blueprintPickup`, forfeited on a run-ending death exactly like
   * `bankedMaterials`, because nothing hands either to the meta layer unless the run is WON.
   *
   * **`EnemyActor.boss` becomes a field the sim reads.** It was render-only ("like `tint`"),
   * and this is the change that ends that — see its own doc comment in `state/entities/actors.ts`.
   *
   * **What this deliberately does NOT know: what any account already owns.** That is account
   * state, and account state may never enter the sim (design/06) — so the roll picks from the
   * whole earnable pool regardless of who is playing, and the meta layer's craft transaction
   * (`meta/forge.ts`) is what actually spends the resulting schematic. A player who already
   * owns every earnable blueprint permanently can still pick this up and bank a schematic
   * that duplicates it — by design (see `meta/forge.ts`'s own doc comment): the roll cannot
   * see the account, so a genuinely wasted pickup (or a squad passing it to whoever needs it)
   * is the mechanism, not a bug.
   */
  private rollBlueprint(state: GameState, e: EnemyActor): void {
    if (e.boss !== true || state.schematicRolled) return;
    // Guard BEFORE the draw, not after: an empty pool must cost zero `dropPrng` draws, or the
    // stream would depend on content that awards nothing. (`validateBlueprints` refuses an
    // empty pool outright, so this is belt-and-braces for a hand-built test catalog.)
    if (EARNABLE_BLUEPRINTS.length === 0) return;
    state.schematicRolled = true;
    if (state.dropPrng.nextInt(1000) >= BLUEPRINT_DROP_PERMILLE) return;
    const weaponId = EARNABLE_BLUEPRINTS[state.dropPrng.nextInt(EARNABLE_BLUEPRINTS.length)]!;
    const pos = clampToWalkable(e.gx, e.gy, dropClearance(), state);
    state.pickups.push({
      id: state.nextId(),
      kind: 'schematic',
      weaponId,
      gx: pos.gx,
      gy: pos.gy,
      spawnTick: state.tick,
      alive: true,
    });
  }

  /**
   * A boss kill puts `BOSS_WEAPON_DROPS` weapons on the ground, over and above whatever its
   * ordinary table roll produced (design/05, 2026-09-14).
   *
   * This is the guarantee that replaced the per-floor allowance, and it is deliberately a
   * much smaller one. The allowance paid every floor, at the capstone, whether or not the
   * player had done anything to earn it; this pays once, on the run's last room, to a player
   * who beat the thing gating the exit. Same reasoning as the shortfall payment it replaces
   * for WHERE it lands — on the body, because the player is already standing there and
   * already looking, and loot that appears where the fight ended reads as loot rather than as
   * a vending machine.
   *
   * Gated on `e.boss` like the blueprint roll above, and it runs in BOTH modes on purpose: an
   * arena has no boss actor, so the flag is simply never set there and this costs a field
   * read. It spends `dropPrng` (one draw per weapon) — the same stream and the same
   * rarity-by-depth roll (`rollWeaponId`, Task 7) a chest pays from, so a boss and a chest
   * cannot disagree about what a weapon find is. The boss room is always the deepest floor,
   * so this is where the depth shift toward higher tiers reads most.
   */
  private dropBossWeapons(state: GameState, e: EnemyActor): void {
    if (e.boss !== true) return;
    for (let i = 0; i < BOSS_WEAPON_DROPS; i++) {
      // Clamped by the PLAYER's clearance, like every other drop — a boss can die flush
      // against a wall (see `state/actorRadius.ts`).
      const pos = clampToWalkable(e.gx, e.gy, dropClearance(), state);
      state.pickups.push({
        id: state.nextId(),
        kind: 'weapon',
        weaponId: rollWeaponId(state.dropPrng, state.floorIndex),
        gx: pos.gx,
        gy: pos.gy,
        spawnTick: state.tick,
        alive: true,
      });
    }
  }
}
