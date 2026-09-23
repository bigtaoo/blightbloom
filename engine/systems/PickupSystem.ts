/**
 * Step 10 — Pickup. A player overlapping a collectable pickup applies it and the
 * pickup is consumed. Pickups dropped THIS tick are skipped (spawnTick guard) so a
 * kill in step 9 isn't vacuumed the same frame (design/08 ordering note). Collected
 * pickups are compacted out in place.
 *
 * Effects (design/05 the in-run power ramp):
 *   heal     — restore up to maxHp. Auto, on overlap — but ONLY while it would
 *              actually heal (`wouldApply`): a full-HP player walks over it and
 *              leaves it lying there to grab later. That is design/05's locked
 *              "consumables auto-apply, but only when useful" rule, which exists
 *              because there is no item bag to hold one in; it went unimplemented
 *              until `ENGINE_VERSION` 54, so the ONE item that restores the one
 *              pool nothing else restores was silently binned at full HP.
 *   material — added to the COLLECTOR's own un-banked buffer (PlayerActor.floorMaterials,
 *              design/05/14, ROADMAP 1.4/1.5, per-seat since ENGINE_VERSION 68); banked
 *              at an extraction checkpoint (ExtractionSystem), forfeited on a run-ending
 *              death. Auto, on overlap.
 *   weapon   — design/03 "NOT auto-picked-up... click-driven" (ENGINE_VERSION 32,
 *              replacing v21's INTERACT gesture): overlap alone does nothing; the
 *              player must have clicked this exact item this tick (`pickupTargetId`
 *              matches the item's id — set by the render-side weapon-pickup panel,
 *              CommandBuilder.requestPickup) while within `SIM.lootRevealRadius` —
 *              wider than the tight overlap every other kind uses, since the panel
 *              already showed it from that range. Swaps it into the slot holding the
 *              same KIND of weapon (ENGINE_VERSION 46; `slotFor`) AND drops the
 *              outgoing weapon back onto the floor as a new pickup at the player's
 *              position (`applyWeapon`) — "no manual drop button," the drop is only
 *              ever a side effect of a swap.
 *   buff     — added to the run-scoped stack. Auto, on overlap.
 *   bandage  — PvP-arena-only (design/05/15's squad follow-up): +1 to the player's
 *              squad-revive currency, spent by ReviveSystem. Auto, on overlap.
 *   energy   — weapon-energy refill (design/03/05, ENGINE_VERSION 59): restore up to
 *              maxEnergy. Auto, on overlap, and under the SAME `wouldApply` gate `heal`
 *              is under, for the same reason — it is an instant item with no bag to
 *              hold it in, so a full player must leave it on the floor for later.
 *   schematic — a boss's one-time blueprint drop (design/14, ENGINE_VERSION 68). Into
 *              the COLLECTOR's own `blueprintPickup`, not a shared bag — same per-seat
 *              rule `material` follows now, replacing the old squad-wide auto-grant.
 *              Auto, on overlap; at most one exists per run.
 *
 * Ports Game.ts updatePickups(): float px → fp, squared-distance overlap. The
 * render-only hover bob is dropped (visual, not sim).
 */
import { SIM } from '../sim.config';
import { HEAL_PICKUP_AMOUNT, rollArenaDrop } from '../content/drops';
import { ENERGY_PICKUP_AMOUNT } from '../balance/energy';
import { bankKey } from '../content/materials';
import { WEAPON_SIM_BY_ID, makeWeapon } from '../content/weapons';
import { PLAYER_BASE } from '../content/players';
import { PVP_SCALE_FACTOR, scaleWeaponDamage } from '../balance/build';
import { applyRunBuff } from './runBuffApply';
import { toFp } from '../math/fixed';
import type { GameState } from '../state/GameState';
import type { PickupItem, PlayerActor, WeaponSimSpec } from '../state/entities';
import { dropClearance } from '../state/actorRadius';
import { circlesOverlap, clampToWalkable, retainAlive } from './geom';

/**
 * Would collecting `item` change `p`'s state at all? design/05's *"consumables —
 * auto-apply, but only when useful"*: with no item bag, an instant item collected at
 * full effect is destroyed for nothing, so the pickup radius must not trigger for it.
 *
 * **Only the two INSTANT items — `heal` and `energy` — have a condition, deliberately.**
 * `material`/`bandage` accumulate with no cap, so they always do something. `buff` looks like a candidate and is not one: the
 * `mult_*` families are Σ-then-clamped at USE time (`sumBuffs`, read by WeaponFire /
 * HitResolve), so "is this buff already at its cap" is not a question this call site can
 * answer without duplicating that arithmetic — and a run buff is a permanent stack entry,
 * not the "instant item" design/05's rule is about. `weapon` is click-driven and never
 * auto-collected in the first place. Any future instant item belongs here too — this is
 * the one place it needs a clause.
 *
 * Per-PLAYER, not per-item: it is called inside the player loop, so a full-HP teammate
 * standing on a heal does not block a hurt one from taking it on the same tick.
 *
 * **Exported because the `?pickupDebug=1` overlay has to agree with it.** That tool's whole
 * contract is "a green dot means the sim would collect this" (`PickupDebugOverlay.ts`), and
 * its own parity test runs the real `PickupSystem` beside the readout — so a second copy of
 * this predicate would be exactly the drift design/18's G6 is about. It called this out by
 * failing the moment the gate landed.
 */
export function pickupWouldApply(p: PlayerActor, item: PickupItem): boolean {
  if (item.kind === 'heal') return p.hp < p.maxHp;
  // Weapon energy (ENGINE_VERSION 59) is the second instant item, and the first one
  // this rule was written in anticipation of ("if a shield/temp-buff instant item is
  // ever added, this is the one place it needs a clause"). Same shape as heal: it
  // restores a capped pool, so at the cap it would be destroyed for nothing.
  if (item.kind === 'energy') return p.energy < p.maxEnergy;
  return true;
}

export class PickupSystem {
  tick(state: GameState): void {
    // Reveal pass FIRST, same tick, so a crate a player is already standing inside
    // (e.g. right as its room activates) can resolve AND be collected below without
    // waiting an extra tick.
    this.resolveCrates(state);

    for (const item of state.pickups) {
      if (!item.alive || item.spawnTick === state.tick) continue;
      // Never directly collectible — resolveCrates above always turns a crate into a
      // real kind before a player gets this close (lootRevealRadius > pickupRadius),
      // but guard explicitly rather than relying on that margin implicitly.
      if (item.kind === 'crate') continue;
      const isWeapon = item.kind === 'weapon';
      // Weapon-kind uses the wider "can see it" ring (SIM.lootRevealRadius) since
      // collection is now a click on the render-side panel that showed it from that
      // range (design/03, ENGINE_VERSION 32) — every other kind keeps the tight
      // auto-overlap radius.
      const radius = isWeapon ? SIM.lootRevealRadius : SIM.pickupRadius;
      for (let i = 0; i < state.players.length; i++) {
        const p = state.players[i]!;
        if (!p.alive) continue;
        if (isWeapon && p.pickupTargetId !== item.id) continue; // must have clicked THIS item this tick
        if (!pickupWouldApply(p, item)) continue; // design/05: no-op consumables stay on the floor
        if (!circlesOverlap(item.gx, item.gy, radius, p.gx, p.gy, p.radius)) continue;
        this.apply(state, p, item);
        item.alive = false;
        state.events.push({
          type: 'pickup',
          kind: item.kind,
          by: p.id, // the collector — render-only, see the event's own doc comment
          gx: item.gx,
          gy: item.gy,
          weaponId: item.weaponId,
          buffId: item.buffId,
          materialId: item.materialId,
          qty: item.qty,
          tier: item.tier,
        });
        break;
      }
    }
    retainAlive(state.pickups);
  }

  /**
   * Roll an unresolved arena 'crate' (design/15) into a real weapon/buff/heal pickup
   * the first tick any player comes within `SIM.lootRevealRadius` — deferred from
   * spawn time (SpawnSystem.spawnArenaLoot) specifically so the value doesn't sit in
   * shared GameState, readable by a map-wide state/camera cheat, before a legitimate
   * player could plausibly have seen it. Iterates pickups then players in their
   * existing array order so the dropPrng draw sequence stays deterministic across
   * clients regardless of which player's loop iteration happens to trigger it.
   */
  private resolveCrates(state: GameState): void {
    for (const item of state.pickups) {
      if (!item.alive || item.kind !== 'crate') continue;
      for (const p of state.players) {
        if (!p.alive) continue;
        if (!circlesOverlap(item.gx, item.gy, SIM.lootRevealRadius, p.gx, p.gy, toFp(0))) continue;
        const drop = rollArenaDrop(state.dropPrng);
        item.kind = drop.kind;
        if (drop.kind === 'weapon') item.weaponId = drop.weaponId;
        if (drop.kind === 'buff') item.buffId = drop.buffId;
        break;
      }
    }
  }

  private apply(state: GameState, p: PlayerActor, item: PickupItem): void {
    switch (item.kind) {
      case 'heal':
        p.hp = Math.min(p.maxHp, p.hp + HEAL_PICKUP_AMOUNT);
        break;
      case 'material':
        if (item.materialId) {
          // Key by (material, rolled tier) so a recipe's minTier can gate it later
          // (design/14). Tier 0 keeps the flat key — byte-identical to pre-tier drops.
          // Into the COLLECTOR's own floor buffer (ENGINE_VERSION 68) — a per-seat bag
          // like `coins`, not a shared one every seat's client used to apply in full.
          const key = bankKey(item.materialId, item.tier ?? 0);
          p.floorMaterials[key] = (p.floorMaterials[key] ?? 0) + (item.qty ?? 0);
        }
        break;
      case 'schematic':
        // A boss's one-time blueprint drop (design/14, ENGINE_VERSION 68) — the collector's
        // own carry-out, exactly like `material` above. At most one exists per run
        // (`DeathDropsSystem.rollBlueprint`), so a plain overwrite is safe; the `if` guard
        // is defensive rather than load-bearing.
        if (item.weaponId && p.blueprintPickup === null) p.blueprintPickup = item.weaponId;
        break;
      case 'coin':
        // In-run currency (design/05 "Shops"). Into the COLLECTOR's own wallet, not a
        // shared floor buffer like `material` two cases up — that difference is the whole
        // per-seat-purse decision, and it is why a coin needs no checkpoint merge and no
        // forfeit path: nothing outside the run ever sees one. Uncapped, like `bandages`.
        p.coins += item.qty ?? 0;
        break;
      case 'weapon':
        if (item.weaponId) this.applyWeapon(state, p, item.weaponId);
        break;
      case 'buff':
        if (item.buffId) applyRunBuff(p, item.buffId);
        break;
      case 'bandage':
        // PvP squad revive currency (design/05/15) — no cap; ReviveSystem is the only
        // spender, one per completed revive.
        p.bandages = (p.bandages ?? 0) + 1;
        break;
      case 'energy':
        // Weapon-energy refill (design/03/05). Clamped to the pool, like heal's clamp to
        // maxHp — the `wouldApply` gate above already refused a full player, so the
        // clamp here only ever trims a partial top-up.
        p.energy = Math.min(p.maxEnergy, p.energy + ENERGY_PICKUP_AMOUNT);
        break;
    }
  }

  private applyWeapon(state: GameState, p: PlayerActor, weaponId: string): void {
    const base = WEAPON_SIM_BY_ID[weaponId];
    if (!base) return; // forward-compat: unknown weapon id → no-op (design/09)
    // PvP arena floor pickups are "the real power curve" (design/15) and must scale
    // exactly like the landing kit (balance/build.ts buildArenaSpecs) — re-deriving
    // from the canonical unscaled spec every equip (never compounding) so drop→re-pickup
    // cycles stay byte-identical regardless of how many hands a weapon passes through.
    const spec = state.zoneEnabled ? scaleWeaponDamage(base, PVP_SCALE_FACTOR) : base;
    const slot = this.slotFor(p, spec.kind);
    // The outgoing weapon drops back to the floor (design/03:126) BEFORE the slot is
    // overwritten — a fresh PickupItem at the player's own position, same spawn-tick
    // convention as DeathDropsSystem so the just-created item isn't immediately
    // re-collected this same tick. Absent for a pickup that filled an EMPTY slot
    // (`slotFor` below), where there is nothing to displace.
    const outgoing = p.weapons[slot];
    if (outgoing) {
      // Same `dropClearance()` every other drop site uses (ENGINE_VERSION 50) — a swapped-out
      // weapon has to be re-collectable on the same terms as one a mob dropped, and the player
      // it falls from is standing on a legal spot already, so in practice this is a no-op that
      // exists to keep the three sites from drifting apart again.
      const pos = clampToWalkable(p.gx, p.gy, dropClearance(), state);
      state.pickups.push({
        id: state.nextId(),
        kind: 'weapon',
        gx: pos.gx,
        gy: pos.gy,
        spawnTick: state.tick,
        alive: true,
        weaponId: outgoing.spec.name,
      });
    }
    // Swap that slot for a fresh runtime of the picked-up weapon, and hold it: the player
    // clicked this item, so the weapon they chose is the one in their hands.
    const w = makeWeapon(spec);
    p.weapons[slot] = w;
    p.activeSlot = slot;
    p.weapon = w;
  }

  /**
   * Which slot a picked-up weapon lands in: the one already holding a weapon of the SAME
   * kind (ENGINE_VERSION 46, live report — *"不能拾取一把刀，却把枪换掉了，导致玩家拿着
   * 两把刀"*).
   *
   * Until v46 this was unconditionally `p.activeSlot`, which is a real defect and not a
   * preference: design/03's ranged-vs-melee trade-off rests on "both halves are always
   * OWNED, neither is ever both-at-once", and `resolveLoadout` / `buildArenaSpecs` go out
   * of their way to guarantee one weapon of each kind at spawn. Overwriting whichever slot
   * happened to be active threw that invariant away on the first pickup — grab a melee
   * weapon while the gun is in hand and you carry two melee weapons, with no gun and no
   * way back to one. The swap verb then toggles between two of the same thing.
   *
   * Matching by kind restores exactly the invariant `resolveLoadout` builds, by the same
   * test (`w.kind === kind`), so a loadout that spawns one-of-each keeps one-of-each for
   * the whole run however many weapons pass through it.
   *
   * The two fallbacks, in order:
   *   - a FREE slot, if this player is carrying fewer than `weaponSlots`. A seat built from
   *     a config that skipped `resolveLoadout` can hold one weapon; filling the gap beats
   *     overwriting the only weapon it has.
   *   - `p.activeSlot`, if both slots are the other kind. Not reachable through any shipped
   *     spawn path, but a total function is one less thing to reason about than a guarantee
   *     enforced somewhere else.
   */
  private slotFor(p: PlayerActor, kind: WeaponSimSpec['kind']): number {
    const same = p.weapons.findIndex((w) => w.spec.kind === kind);
    if (same >= 0) return same;
    if (p.weapons.length < PLAYER_BASE.weaponSlots) return p.weapons.length;
    return p.activeSlot;
  }
}
