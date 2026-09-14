/**
 * Chest rooms (design/05 "Chest rooms", ENGINE_VERSION 63) — the unit half.
 *
 * The golden gate's `chest-room` scenario proves a chest of each kind opens during a real
 * run and that its payout lands in the hash. It cannot prove the REFUSALS: that a small
 * chest ignores a player with no button, that a big chest with half its plates occupied
 * stays shut, that a revive out-ranks a chest for the same INTERACT, that a chest in a room
 * nobody has entered is unreachable through the wall. Every one of those is a branch whose
 * line runs on every tick while only the taken side is ever exercised — the column CLAUDE.md
 * says is the one that bites — so they are pinned here, one assertion per refusal, against a
 * state built to make the refusal the only thing that could have caused the outcome.
 */
import { describe, it, expect } from 'vitest';
import { toFp } from '@dd/engine/math/fixed';
import type { Fp } from '@dd/engine/math/fixed';
import type { Brad } from '@dd/engine/math/trig';
import { toFpGrid } from '@dd/engine/content/convert';
import { freshStatus } from '@dd/engine/content/damage';
import { PLAYER_BASE } from '@dd/engine/content/players';
import { BASE_MAX_ENERGY } from '@dd/engine/balance/energy';
import { makeWeapon, BLASTER_SIM } from '@dd/engine/content/weapons';
import { createGameState } from '@dd/engine/state/GameState';
import type { GameState } from '@dd/engine/state/GameState';
import type { Chest, PlayerActor } from '@dd/engine/state/entities';
import { ChestSystem } from '@dd/engine/systems';
import { chestWeaponCount, mechanismRing } from '@dd/engine/content/chests';
import { WEAPON_DROP_POOL } from '@dd/engine/content/drops';
import { dropClearance } from '@dd/engine/state/actorRadius';
import { clampToWalkable } from '@dd/engine/systems/geom';
import {
  CHEST_MECHANISM_RADIUS_GRID,
  CHEST_MECHANISM_RING_GRID,
  CHEST_SMALL_WEAPONS,
} from '@dd/engine/config';

const CFG = { seed: 11, worldW: 2400, worldH: 2400, waves: [] as const };

/**
 * A state with NO seats. `createGameState` always builds one player, and a big chest's rules
 * are all about how many there are — leaving the default seat in would mean every `addPlayer`
 * below silently made the party one larger than the test reads as, which is exactly the shape
 * of a test that passes while pinning a different number than it names.
 */
const state = (): GameState => {
  const s = createGameState(CFG);
  s.players.length = 0;
  return s;
};

/** A player at a GRID position — chests are authored in grid units, so the tests are too. */
function addPlayer(s: GameState, gx: number, gy: number): PlayerActor {
  const w = makeWeapon(BLASTER_SIM);
  const p: PlayerActor = {
    id: s.nextId(), faction: 'player', teamId: 0,
    gx: toFpGrid(gx), gy: toFpGrid(gy), z: toFp(0), vx: toFp(0), vy: toFp(0),
    knockVx: toFp(0), knockVy: toFp(0),
    facing: 0 as Brad, hp: 6, maxHp: 6, shield: 0, maxShield: 0, ticksSinceHit: 0,
    radius: PLAYER_BASE.radius, footprintRadius: PLAYER_BASE.footprintRadius,
    solidRadius: PLAYER_BASE.solidRadius,
    alive: true, weapon: w, weapons: [w], activeSlot: 0, buffs: [],
    energy: BASE_MAX_ENERGY, maxEnergy: BASE_MAX_ENERGY, coins: 0, shopBuyId: 0,
    firing: false, interacting: false, pickupTargetId: 0, cardVote: 0,
    confirmExtract: false, confirmDescend: false,
    downed: false, bleedoutTicks: 0, reviveProgressTicks: 0,
    bandages: 0, prevButtons: 0, status: freshStatus(),
  };
  s.players.push(p);
  return p;
}

/** A chest at a GRID position. `roomId` is deliberately one no `dungeonRoomIndexById` knows,
 *  so these cases run through `roomActive`'s "no room runtime" arm — the activation gate has
 *  its own case below, built with a real runtime. */
function addChest(s: GameState, kind: 'small' | 'big', gx: number, gy: number, seats = 0): Chest {
  const c: Chest = {
    id: s.nextId(),
    roomId: 'no_such_room',
    kind,
    gx: toFpGrid(gx),
    gy: toFpGrid(gy),
    mechanisms: kind === 'big' ? mechanismRing(toFpGrid(gx), toFpGrid(gy), seats) : [],
    opened: false,
  };
  s.chests.push(c);
  return c;
}

const sys = new ChestSystem();

describe('mechanismRing — derived, never authored', () => {
  it('produces one plate per seat, all at the ring radius', () => {
    const cx = toFpGrid(20);
    const cy = toFpGrid(20);
    for (const seats of [1, 2, 3, 4, 8]) {
      const ring = mechanismRing(cx, cy, seats);
      expect(ring).toHaveLength(seats);
      for (const m of ring) {
        const dx = (m.gx as number) - (cx as number);
        const dy = (m.gy as number) - (cy as number);
        // Integer trig, so the radius is right to within a rounding unit rather than exactly.
        expect(Math.abs(Math.hypot(dx, dy) - (toFpGrid(CHEST_MECHANISM_RING_GRID) as number))).toBeLessThan(3);
        expect(m.occupied).toBe(false);
      }
    }
  });

  it('puts two seats on exact opposite sides — the property the golden fixture stands on', () => {
    // `chestRoomFloor.ts` authors its two player spawns AT these points. If the ring ever
    // stopped being east/west for two seats, that fixture would silently stop opening its big
    // chest while still recording a hash, so the relationship is asserted here rather than
    // left implicit in a comment over there.
    const [east, west] = mechanismRing(toFpGrid(10), toFpGrid(10), 2);
    expect(east!.gx).toBe(toFpGrid(10 + CHEST_MECHANISM_RING_GRID));
    expect(east!.gy).toBe(toFpGrid(10));
    expect(west!.gx).toBe(toFpGrid(10 - CHEST_MECHANISM_RING_GRID));
    expect(west!.gy).toBe(toFpGrid(10));
  });

  it('is a pure function of its inputs — no PRNG, no call-order dependence', () => {
    // If this ever drew from a stream, placing a chest would shift every later loot roll on
    // the floor. Two identical calls with a whole other ring built in between is the cheapest
    // statement of "nothing here has memory".
    const a = mechanismRing(toFpGrid(7), toFpGrid(9), 3);
    mechanismRing(toFpGrid(99), toFpGrid(1), 5);
    const b = mechanismRing(toFpGrid(7), toFpGrid(9), 3);
    expect(b).toEqual(a);
  });

  it('returns an empty ring for a zero-seat config instead of throwing', () => {
    expect(mechanismRing(toFpGrid(3), toFpGrid(3), 0)).toEqual([]);
    expect(mechanismRing(toFpGrid(3), toFpGrid(3), -2)).toEqual([]);
  });
});

describe('chestWeaponCount — flat per capita', () => {
  it('pays a small chest the same whatever the party size', () => {
    for (const seats of [1, 2, 4, 8]) expect(chestWeaponCount('small', seats)).toBe(CHEST_SMALL_WEAPONS);
  });

  it('pays a big chest one per seat', () => {
    expect(chestWeaponCount('big', 1)).toBe(1);
    expect(chestWeaponCount('big', 4)).toBe(4);
  });

  it('never pays a big chest nothing, even for a malformed zero-seat state', () => {
    expect(chestWeaponCount('big', 0)).toBe(1);
  });
});

describe('ChestSystem — a small chest', () => {
  it('opens for a player holding INTERACT in reach, and pays exactly one weapon', () => {
    const s = state();
    const p = addPlayer(s, 10, 10);
    const c = addChest(s, 'small', 10.5, 10);
    p.interacting = true;
    sys.tick(s);
    expect(c.opened).toBe(true);
    expect(s.pickups.filter((q) => q.kind === 'weapon')).toHaveLength(CHEST_SMALL_WEAPONS);
    expect(s.events.filter((e) => e.type === 'chest_open')).toEqual([
      { type: 'chest_open', id: c.id, kind: 'small', gx: c.gx, gy: c.gy, weapons: 1 },
    ]);
  });

  it('stays shut for a player standing on it with no button', () => {
    const s = state();
    addPlayer(s, 10, 10);
    const c = addChest(s, 'small', 10, 10);
    sys.tick(s);
    expect(c.opened).toBe(false);
    expect(s.pickups).toHaveLength(0);
  });

  it('stays shut for a player pressing INTERACT out of reach', () => {
    const s = state();
    const p = addPlayer(s, 10, 10);
    const c = addChest(s, 'small', 20, 10);
    p.interacting = true;
    sys.tick(s);
    expect(c.opened).toBe(false);
  });

  it('stays shut for a DOWNED player pressing INTERACT on top of it', () => {
    const s = state();
    const p = addPlayer(s, 10, 10);
    const c = addChest(s, 'small', 10, 10);
    p.interacting = true;
    p.downed = true;
    sys.tick(s);
    expect(c.opened).toBe(false);
  });

  it('pays once and only once, however long the button is held', () => {
    const s = state();
    const p = addPlayer(s, 10, 10);
    addChest(s, 'small', 10, 10);
    p.interacting = true;
    for (let i = 0; i < 20; i++) sys.tick(s);
    expect(s.pickups).toHaveLength(1);
  });
});

describe('ChestSystem — a big chest', () => {
  it('stays shut while only some of its plates are occupied', () => {
    const s = state();
    addPlayer(s, 20, 20);
    addPlayer(s, 40, 40); // far away, not on its plate
    const c = addChest(s, 'big', 20, 20, 2);
    // Put seat 0 exactly on the east plate; seat 1 is nowhere near the west one.
    s.players[0]!.gx = c.mechanisms[0]!.gx;
    s.players[0]!.gy = c.mechanisms[0]!.gy;
    sys.tick(s);
    expect(c.mechanisms[0]!.occupied).toBe(true);
    expect(c.mechanisms[1]!.occupied).toBe(false);
    expect(c.opened).toBe(false);
  });

  it('opens the tick every plate is occupied, and pays one weapon per seat', () => {
    const s = state();
    addPlayer(s, 20, 20);
    addPlayer(s, 40, 40);
    const c = addChest(s, 'big', 20, 20, 2);
    for (let i = 0; i < 2; i++) {
      s.players[i]!.gx = c.mechanisms[i]!.gx;
      s.players[i]!.gy = c.mechanisms[i]!.gy;
    }
    sys.tick(s);
    expect(c.opened).toBe(true);
    expect(s.pickups).toHaveLength(2);
    expect(s.events.filter((e) => e.type === 'chest_open')).toHaveLength(1);
  });

  it('wants no button at all — standing on the plates is the whole gesture', () => {
    const s = state();
    addPlayer(s, 20, 20);
    const c = addChest(s, 'big', 20, 20, 1);
    s.players[0]!.gx = c.mechanisms[0]!.gx;
    s.players[0]!.gy = c.mechanisms[0]!.gy;
    expect(s.players[0]!.interacting).toBe(false);
    sys.tick(s);
    expect(c.opened).toBe(true);
  });

  it('ignores a DOWNED player lying on a plate', () => {
    const s = state();
    addPlayer(s, 20, 20);
    const c = addChest(s, 'big', 20, 20, 1);
    s.players[0]!.gx = c.mechanisms[0]!.gx;
    s.players[0]!.gy = c.mechanisms[0]!.gy;
    s.players[0]!.downed = true;
    sys.tick(s);
    expect(c.mechanisms[0]!.occupied).toBe(false);
    expect(c.opened).toBe(false);
  });

  it('can never open with no plates at all', () => {
    // The degenerate `mechanismRing(..., 0)` case reaching a live state: `every` on an empty
    // array is vacuously true, so without the explicit length check this chest would open on
    // its first tick with nobody anywhere near it.
    const s = state();
    addPlayer(s, 20, 20);
    const c = addChest(s, 'big', 20, 20, 0);
    expect(c.mechanisms).toHaveLength(0);
    for (let i = 0; i < 5; i++) sys.tick(s);
    expect(c.opened).toBe(false);
    expect(s.pickups).toHaveLength(0);
  });

  it('clears a plate again once the player steps off, even after the chest has opened', () => {
    const s = state();
    addPlayer(s, 20, 20);
    const c = addChest(s, 'big', 20, 20, 1);
    s.players[0]!.gx = c.mechanisms[0]!.gx;
    s.players[0]!.gy = c.mechanisms[0]!.gy;
    sys.tick(s);
    expect(c.opened).toBe(true);
    expect(c.mechanisms[0]!.occupied).toBe(true);
    s.players[0]!.gx = toFpGrid(60);
    sys.tick(s);
    // An opened chest is skipped for OPENING, not for bookkeeping — a plate that stayed lit
    // after everyone walked away is a render bug with an engine-state cause.
    expect(c.mechanisms[0]!.occupied).toBe(false);
  });

  it('counts a plate as occupied out to CHEST_MECHANISM_RADIUS_GRID and not beyond', () => {
    const s = state();
    addPlayer(s, 20, 20);
    const c = addChest(s, 'big', 20, 20, 1);
    const inside = ((c.mechanisms[0]!.gx as number) + (toFpGrid(CHEST_MECHANISM_RADIUS_GRID) as number) - 1) as Fp;
    const outside = ((c.mechanisms[0]!.gx as number) + (toFpGrid(CHEST_MECHANISM_RADIUS_GRID) as number) + 1) as Fp;
    s.players[0]!.gy = c.mechanisms[0]!.gy;
    s.players[0]!.gx = outside;
    sys.tick(s);
    expect(c.opened).toBe(false);
    s.players[0]!.gx = inside;
    sys.tick(s);
    expect(c.opened).toBe(true);
  });
});

describe('ChestSystem — the rules that are about something other than the chest', () => {
  it('lets a revive win the INTERACT: a valid reviver cannot also open a chest', () => {
    const s = state();
    const rescuer = addPlayer(s, 10, 10);
    const downed = addPlayer(s, 10, 10);
    downed.downed = true;
    const c = addChest(s, 'small', 10, 10);
    rescuer.interacting = true;
    sys.tick(s);
    expect(c.opened).toBe(false);
  });

  it('does open the chest once the teammate is back up — the block is the revive, not the teammate', () => {
    // The control for the case above. Without it, "a chest beside a second player never
    // opens" would pass it just as well, and that is a different (wrong) rule.
    const s = state();
    const rescuer = addPlayer(s, 10, 10);
    const mate = addPlayer(s, 10, 10);
    mate.downed = false;
    const c = addChest(s, 'small', 10, 10);
    rescuer.interacting = true;
    sys.tick(s);
    expect(c.opened).toBe(true);
  });

  it('lets a PvP player with no bandage open the chest instead — they are not a valid reviver', () => {
    // `ReviveSystem` refuses a bandage-less reviver in arena mode, so their INTERACT is NOT
    // spoken for and the chest is the honest thing for it to mean.
    const s = state();
    Object.defineProperty(s, 'zoneEnabled', { value: true });
    const rescuer = addPlayer(s, 10, 10);
    const downed = addPlayer(s, 10, 10);
    downed.downed = true;
    rescuer.bandages = 0;
    const c = addChest(s, 'small', 10, 10);
    rescuer.interacting = true;
    sys.tick(s);
    expect(c.opened).toBe(true);
  });

  it('refuses a chest in a room that has not been entered', () => {
    const s = state();
    const p = addPlayer(s, 10, 10);
    const c = addChest(s, 'small', 10, 10);
    c.roomId = 'r1';
    s.dungeonRoomIndexById.set('r1', 0);
    s.dungeonRoomRuntime.push({
      activated: false, roomTick: 0, schedule: [], cursor: 0, hasLiveEnemy: false,
    });
    p.interacting = true;
    sys.tick(s);
    expect(c.opened).toBe(false);
    s.dungeonRoomRuntime[0]!.activated = true;
    sys.tick(s);
    expect(c.opened).toBe(true);
  });

  it('pays its weapons onto the floor and charges them against nothing', () => {
    // The counterpart of the deleted "counts its payout against the floor allowance" test.
    // A chest used to add to `state.floorWeaponsDropped` so the capstone owed less; both
    // the counter and the make-up payment are gone (2026-09-14), so a chest's payout IS
    // the floor's weapon supply. Asserted on the pickups rather than on the absence of a
    // field, because a field that no longer exists cannot be asserted about — what has to
    // stay true is that opening one still puts exactly `CHEST_SMALL_WEAPONS` guns down.
    const s = state();
    const p = addPlayer(s, 10, 10);
    addChest(s, 'small', 10, 10);
    p.interacting = true;
    sys.tick(s);
    expect(s.pickups.filter((i) => i.kind === 'weapon')).toHaveLength(CHEST_SMALL_WEAPONS);
  });

  it('is a strict no-op for a state with no chests', () => {
    const s = state();
    addPlayer(s, 10, 10).interacting = true;
    const before = s.dropPrng.peek();
    sys.tick(s);
    expect(s.events).toHaveLength(0);
    expect(s.pickups).toHaveLength(0);
    // The cursor matters more than the two above: a system that drew even once for a config
    // with no chests would shift every later roll in every pre-chest replay.
    expect(s.dropPrng.peek()).toBe(before);
  });
});

/**
 * What a chest actually PAYS. Everything above counts the payout (`toHaveLength`) and never
 * looks at it, which leaves the pile itself unpinned: a chest could hand out a weapon nobody
 * can pick up, a weapon that is not in the drop pool, or one that lands inside the stone the
 * chest was authored against, and every assertion in this file would still be green.
 */
describe('ChestSystem — the pile a chest leaves behind', () => {
  it('pays weapons from the shared drop pool, alive and ready to be collected', () => {
    const s = state();
    const p = addPlayer(s, 10, 10);
    addChest(s, 'small', 10, 10);
    p.interacting = true;
    sys.tick(s);

    const pile = s.pickups;
    expect(pile).toHaveLength(CHEST_SMALL_WEAPONS);
    for (const q of pile) {
      expect(q.kind).toBe('weapon');
      expect(WEAPON_DROP_POOL).toContain(q.weaponId);
      expect(q.alive).toBe(true);
      // `PickupSystem` skips anything whose `spawnTick` is the current tick, which is the
      // one-tick gap that keeps a chest from being hoovered by the same frame that opened it.
      // Stamping this wrong is invisible until a player walks away with the payout early.
      expect(q.spawnTick).toBe(s.tick);
      expect(q.id).toBeGreaterThan(0);
    }
  });

  it('gives every weapon in one payout its own id', () => {
    const s = state();
    addPlayer(s, 10, 10);
    addPlayer(s, 10, 10);
    addPlayer(s, 10, 10);
    const c = addChest(s, 'big', 10, 10, 3);
    for (const m of c.mechanisms) {
      m.gx = toFpGrid(10);
      m.gy = toFpGrid(10);
    }
    sys.tick(s);
    expect(s.pickups).toHaveLength(3);
    expect(new Set(s.pickups.map((q) => q.id)).size).toBe(3);
  });

  it('draws exactly one weapon per payout from dropPrng, and no more', () => {
    // The stream is a shared resource (design/06): a chest that drew twice per weapon, or drew
    // for a chest that stayed shut, would move every later loot roll on the floor.
    const s = state();
    const p = addPlayer(s, 10, 10);
    addChest(s, 'small', 10, 10);
    const reference = createGameState(CFG);
    p.interacting = true;
    sys.tick(s);
    reference.dropPrng.nextInt(WEAPON_DROP_POOL.length);
    expect(s.dropPrng.peek()).toBe(reference.dropPrng.peek());
  });

  it('pays the same weapons for the same seed — a chest is not a second source of divergence', () => {
    const payout = () => {
      const s = state();
      const p = addPlayer(s, 10, 10);
      addChest(s, 'small', 10, 10);
      p.interacting = true;
      sys.tick(s);
      return s.pickups.map((q) => q.weaponId);
    };
    expect(payout()).toEqual(payout());
  });

  it('drops the pile clear of the stone a chest was authored against', () => {
    // A chest may legitimately sit flush against a wall, and the pile is clamped by the
    // PLAYER's clearance rather than the pickup's — the thing that has to reach it is a body.
    const s = state();
    s.walls.push({ x: toFpGrid(10), y: toFpGrid(8), w: toFpGrid(2), h: toFpGrid(4) });
    s.rebuildSpatialIndex();
    const p = addPlayer(s, 9, 10);
    addChest(s, 'small', 10.5, 10); // inside the wall above
    p.interacting = true;
    sys.tick(s);

    expect(s.pickups).toHaveLength(CHEST_SMALL_WEAPONS);
    const at = s.pickups[0]!;
    const again = clampToWalkable(at.gx, at.gy, dropClearance(), s);
    // The clamp is a fixed point on the result: the pile is already somewhere a player can
    // stand, so re-clamping it may not move it. Asserting that rather than a literal position
    // keeps this from re-deriving the clamp's own arithmetic.
    expect({ gx: again.gx, gy: again.gy }).toEqual({ gx: at.gx, gy: at.gy });
    expect(at.gx).not.toBe(toFpGrid(10.5)); // and it really did have to move
  });

  it('piles every weapon of one payout on the same point', () => {
    // One pile, where the players are already standing and already looking — not a scatter.
    const s = state();
    addPlayer(s, 10, 10);
    addPlayer(s, 10, 10);
    const c = addChest(s, 'big', 10, 10, 2);
    for (const m of c.mechanisms) {
      m.gx = toFpGrid(10);
      m.gy = toFpGrid(10);
    }
    sys.tick(s);
    expect(s.pickups).toHaveLength(2);
    expect(new Set(s.pickups.map((q) => `${q.gx},${q.gy}`)).size).toBe(1);
  });
});

/**
 * The remaining arms of the two "about something other than the chest" rules. Each is a side
 * of a branch whose other side is already covered above, and each would be taken by a real
 * run — the first in every PvP match, the second on any floor whose room runtime has not
 * caught up with its room list.
 */
describe('ChestSystem — the arbitration branches nothing else reaches', () => {
  it('ignores a downed ENEMY beside you — a revive you could not perform blocks nothing', () => {
    const s = state();
    const rescuer = addPlayer(s, 10, 10);
    const enemy = addPlayer(s, 10, 10);
    enemy.teamId = rescuer.teamId + 1;
    enemy.downed = true;
    const c = addChest(s, 'small', 10, 10);
    rescuer.interacting = true;
    sys.tick(s);
    // `ReviveSystem.findReviver` only ever matches a downed player on the SAME team, so this
    // player's INTERACT is not spoken for and the chest is the honest thing for it to mean.
    expect(c.opened).toBe(true);
  });

  it('still lets the revive win in PvP when the rescuer IS carrying a bandage', () => {
    // The control for "a PvP player with no bandage opens the chest instead" above. Without
    // it, "arena mode ignores the revive rule entirely" would pass that test just as well.
    const s = state();
    Object.defineProperty(s, 'zoneEnabled', { value: true });
    const rescuer = addPlayer(s, 10, 10);
    const downed = addPlayer(s, 10, 10);
    downed.downed = true;
    rescuer.bandages = 1;
    const c = addChest(s, 'small', 10, 10);
    rescuer.interacting = true;
    sys.tick(s);
    expect(c.opened).toBe(false);
  });

  it('refuses a chest whose room is known but has no runtime row yet', () => {
    // `dungeonRoomIndexById` and `dungeonRoomRuntime` are two arrays kept in step by
    // `SpawnSystem`; a chest that read an index past the end of the runtime list would open
    // through a wall on the strength of an `undefined`.
    const s = state();
    const p = addPlayer(s, 10, 10);
    const c = addChest(s, 'small', 10, 10);
    c.roomId = 'r_ghost';
    s.dungeonRoomIndexById.set('r_ghost', 3); // no runtime row at 3
    p.interacting = true;
    sys.tick(s);
    expect(c.opened).toBe(false);
  });

  it('ignores a DEAD player holding the button, not only a downed one', () => {
    const s = state();
    const p = addPlayer(s, 10, 10);
    const c = addChest(s, 'small', 10, 10);
    p.alive = false;
    p.interacting = true;
    sys.tick(s);
    expect(c.opened).toBe(false);
  });

  it('ignores a DEAD player lying on a big chest’s plate', () => {
    const s = state();
    const p = addPlayer(s, 10, 10);
    const c = addChest(s, 'big', 10, 10, 1);
    p.gx = c.mechanisms[0]!.gx;
    p.gy = c.mechanisms[0]!.gy;
    p.alive = false;
    sys.tick(s);
    expect(c.mechanisms[0]!.occupied).toBe(false);
    expect(c.opened).toBe(false);
  });
});
