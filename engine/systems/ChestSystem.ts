/**
 * Step 10.5 — Chests (design/05 "Chest rooms", ENGINE_VERSION 63). Runs AFTER Pickup (10),
 * so a chest's payout is always collectable on a LATER tick than the one it opened on — the
 * same one-tick gap DeathDropsSystem (9) → PickupSystem (10) already relies on, and the
 * reason `PickupItem.spawnTick` exists at all. Runs BEFORE Spawns (11) / Doors (11.5)
 * because opening a chest spawns no actor and locks no door: it is loot machinery, and it
 * sits with the loot machinery.
 *
 * A strict no-op for any config with no authored chests — `state.chests` is empty for every
 * config that predates them, so this system iterates nothing and pushes no event, exactly as
 * ExtractionSystem / ZoneSystem are for a config that never opts in.
 *
 * ## The two open rules, and what each one refuses
 *
 * **A small chest opens for any live player within `CHEST_OPEN_RANGE_GRID`** — no button, no
 * hold, nothing to press. **Changed 2026-09-15** (`ENGINE_VERSION` 66) on the owner's call:
 * *"opening an ordinary chest should take no extra action — it opens when the player comes
 * near"*. What it replaced, and the argument that was made for it, is worth keeping visible: a
 * held INTERACT was chosen so that spending a floor's loot was *a decision*, on the reasoning
 * that a chest opened by being walked past is not a search. That argument lost to a simpler measurement — the button was undiscoverable. A chest
 * has no art and no sound, INTERACT is taught by no tutorial hint, and the first report from
 * real play was a chest that *"cannot be opened"* by a player standing on it (2026-09-15,
 * `client/src/game/ui/ChestPrompt.ts`'s own header). The decision a small chest still carries
 * is whether to walk into its dead-end room at all (design/05: the side rooms are optional),
 * which is the choice that was actually costing something.
 *
 * **A big chest wants every one of its mechanisms occupied on the SAME tick**, and wanted no
 * button even when the small one did. Requiring INTERACT as well would mean four players
 * pressing a button simultaneously, a coordination task of a completely different (and worse)
 * kind than standing in the right place. A mechanism is occupied by any player who is alive,
 * not downed, and within `CHEST_MECHANISM_RADIUS_GRID` of its centre.
 *
 * ## No INTERACT, and therefore no arbitration
 *
 * Until v66 this system mirrored `ReviveSystem.findReviver` so that a player who was a valid
 * REVIVER could not also work a chest with the same held button — the revive being the
 * time-critical one. Neither chest kind reads a button now, so there is nothing left to
 * arbitrate and that mirror is gone rather than kept "in case": a rule that cannot fire is a
 * rule nobody can test. The one behaviour it used to buy is now simply different, and
 * deliberately so — a small chest beside a downed teammate opens while you revive them.
 *
 * ## The payout is the floor's weapon supply, not a share of it
 *
 * A chest pays `chestWeaponCount` weapons (design/05: one for a small chest, one per seat for
 * a big one) and that is now simply how many weapons exist — there is nothing to charge it
 * against. Until 2026-09-14 this added to `state.floorWeaponsDropped` so that a chest opened
 * mid-floor left the capstone's make-up payment correspondingly smaller; that allowance is
 * gone along with the kill-table weapon entry that motivated it, so what used to be a
 * re-routing of loot a floor already owed is now the loot itself. A skipped chest room is a
 * floor with fewer weapons in it, which is the whole point of putting them behind a search.
 */
import { CHEST_MECHANISM_RADIUS_GRID, CHEST_OPEN_RANGE_GRID } from '../config';
import { chestWeaponCount } from '../content/chests';
import { rollWeaponId } from '../content/weaponRarityByDepth';
import { resolveFloorCards } from '../balance/floorCards';
import { toFpGrid } from '../content/convert';
import { dropClearance } from '../state/actorRadius';
import type { GameState } from '../state/GameState';
import type { Chest, PlayerActor } from '../state/entities';
import { clampToWalkable } from './geom';

const OPEN_RANGE_FP = toFpGrid(CHEST_OPEN_RANGE_GRID) as number;
const MECHANISM_RADIUS_FP = toFpGrid(CHEST_MECHANISM_RADIUS_GRID) as number;

export class ChestSystem {
  tick(state: GameState): void {
    if (state.chests.length === 0) return;
    for (const chest of state.chests) {
      if (chest.kind === 'big') this.markMechanisms(state, chest);
      if (chest.opened) continue;
      if (!this.roomActive(state, chest)) continue;
      if (!this.openWanted(state, chest)) continue;
      this.open(state, chest);
    }
  }

  /**
   * Refresh every mechanism's `occupied` flag from scratch. Done for an OPENED chest too:
   * the plates stay in the world and the render layer keeps drawing them, so letting the
   * flags freeze at whatever they held on the opening tick would leave a lit plate lit
   * forever after everyone had walked away.
   */
  private markMechanisms(state: GameState, chest: Chest): void {
    for (const m of chest.mechanisms) {
      m.occupied = state.players.some(
        (p) => p.alive && !p.downed && within(p, m.gx as number, m.gy as number, MECHANISM_RADIUS_FP),
      );
    }
  }

  /**
   * Is the chest's room live? A chest may only be worked from inside its own activated room
   * — a floor is co-resident (design/05 "Room & door model"), so without this a player could
   * stand against a shared wall and work a chest in the room next door, through the stone.
   *
   * A config with chests but no room runtime for them has no activation concept at all;
   * there, the chest is live. That is the honest answer rather than a defensive `false`: a
   * flat `waves` config authoring a chest has nothing that could ever activate it.
   */
  private roomActive(state: GameState, chest: Chest): boolean {
    const idx = state.dungeonRoomIndexById.get(chest.roomId);
    if (idx === undefined) return true;
    return state.dungeonRoomRuntime[idx]?.activated === true;
  }

  /**
   * A DOWNED player still does not open a small chest, and that is the one condition left on
   * the approach rule worth stating: a downed body is carried into reach by wherever it fell,
   * not by a decision, and `ChestSystem` running before `ReviveSystem` would otherwise let a
   * teammate's collapse spend the room. Dead players are excluded for the same reason
   * everything else in this engine excludes them.
   */
  private openWanted(state: GameState, chest: Chest): boolean {
    if (chest.kind === 'big') {
      return chest.mechanisms.length > 0 && chest.mechanisms.every((m) => m.occupied);
    }
    return state.players.some(
      (p) =>
        p.alive &&
        !p.downed &&
        within(p, chest.gx as number, chest.gy as number, OPEN_RANGE_FP + (p.radius as number)),
    );
  }

  /**
   * Pay the chest out and close it. Every weapon lands on the chest's own clamped point —
   * one pile, where the players are already standing and already looking.
   */
  private open(state: GameState, chest: Chest): void {
    chest.opened = true;
    // The `bounty` floor card (Task 8, "chest_bonus_weapons") adds a flat count on top —
    // re-derived from the run's picked cards, not mirrored into a counter, same as every
    // other floor-card mod (`balance/floorCards.ts`'s own header).
    const bonus = resolveFloorCards(state.floorCards).chestBonusWeapons;
    const count = chestWeaponCount(chest.kind, state.players.length) + bonus;
    // Clamped by the PLAYER's clearance, not the pickup's — the thing that has to reach this
    // spot is a player's body (`state/actorRadius.ts dropClearance`), and a chest can
    // legitimately be authored flush against a wall.
    const pos = clampToWalkable(chest.gx, chest.gy, dropClearance(), state);
    for (let i = 0; i < count; i++) {
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
    state.events.push({
      type: 'chest_open',
      id: chest.id,
      kind: chest.kind,
      gx: chest.gx,
      gy: chest.gy,
      weapons: count,
    });
  }
}

/** Squared-distance reach test, the same shape every other system in here uses. */
function within(p: PlayerActor, gx: number, gy: number, reach: number): boolean {
  const dx = (p.gx as number) - gx;
  const dy = (p.gy as number) - gy;
  return dx * dx + dy * dy <= reach * reach;
}
