/**
 * Level 1's content gate — holds `world/dungeons/ember/`'s JSON to the level spec
 * (5 floors of 6/7/8/8/6 rooms, every room 15x15..20x20, enemy count ramping with
 * cell count from 8 to 14) and, most importantly, proves every door is PHYSICALLY
 * PASSABLE.
 *
 * "Passable" is deliberately checked the expensive way. `tools/map-editor`'s
 * `validateDungeonFloorMap` already covers the structural half (no overlaps, doors
 * on a real shared wall, every room reachable through the door GRAPH, capstone
 * last), but a door can satisfy all of that and still be unwalkable — it can open
 * onto an interior solid, or be carved so that only one of the two abutting
 * perimeter walls is actually cut. So the traversability suite below runs the REAL
 * engine path (`placeAuthoredFloor` → `buildFloorGeometry`, the same two calls
 * `SpawnSystem.generateAndPlaceFloor` makes), rasterises the resulting Fp wall list
 * back onto the grid, and flood-fills from the spawn room. Every room's entrance
 * and every authored spawn point has to come out reachable.
 *
 * These files are meant to be tuned in the map editor, so this suite is the safety
 * net for that tuning: drag a room out of alignment or nudge a door off its wall
 * and it fails here rather than in a run.
 */
import { describe, expect, it } from 'vitest';
import { EMBER_L1_FLOORS, EMBER_L1_ROOMS, EMBER_L1_FLOOR_2_BRANCH, EMBER_L1_FLOOR_3_BRANCH, EMBER_L1_FLOOR_4_BRANCH } from './emberLevel1';
import { EMBER_DUNGEON } from './ember';
import type { DungeonFloorMap } from '../dungeon';
import { describeFloorPassability, reachesCapstoneWithout } from '../../fixtures/floorPassability';
import type { RoomPiece } from '../../content/rooms';
import { FP_SCALE } from '../../math/fixed';
import { toFpGrid } from '../../content/convert';
import { mechanismRing } from '../../content/chests';
import { CHEST_MECHANISM_RING_GRID, CHEST_OPEN_RANGE_GRID, SHOP_INTERACT_RANGE_GRID } from '../../config';

const FLOOR_INDICES = [0, 1, 2, 3, 4] as const;
const EXPECTED_ROOM_COUNTS = [6, 7, 8, 8, 6];

/**
 * The enemy-free SIDE rooms (design/05 "Chest rooms": *"a floor mixes combat rooms with chest
 * rooms. Not every room has enemies in it"*, 2026-09-14). Named here rather than derived from
 * `spawns.enemy.length === 0`, because a derived list would swallow exactly the mistake this
 * suite exists to catch — a combat piece that loses its garrison in an editor drag would join
 * the exempt set instead of failing the ramp below. The two halves are cross-checked: the
 * roster has to be exactly the pieces with no enemy spawns, capstone aside.
 */
const SIDE_PIECES = new Set(['ember_l1_cache', 'ember_l1_vault', 'ember_l1_market']);
const isFight = (p: RoomPiece): boolean => p.role !== 'extraction' && !SIDE_PIECES.has(p.id);
const MIN_SIDE = 15;
const MAX_SIDE = 20;
const MIN_ENEMIES = 8;
const MAX_ENEMIES = 14;

const floorAt = (i: number): DungeonFloorMap => {
  const map = EMBER_L1_FLOORS[i];
  if (!map) throw new Error(`no authored floor at index ${i}`);
  return map;
};
const pieceById = new Map(EMBER_L1_ROOMS.map((p) => [p.id, p] as const));
const pieceFor = (id: string): RoomPiece => {
  const piece = pieceById.get(id);
  if (!piece) throw new Error(`unknown pieceId '${id}'`);
  return piece;
};

describe('EMBER_DUNGEON is the authored 5-floor level 1', () => {
  it('declares 5 floors and carries an authored map for every one of them', () => {
    expect(EMBER_DUNGEON.floorCount).toBe(5);
    expect(Object.keys(EMBER_DUNGEON.floorMaps ?? {}).sort()).toEqual(['0', '1', '2', '3', '4']);
    // Every floor authored ⇒ SpawnSystem never reaches generateFloor for a real run,
    // so a run costs zero roomgenPrng draws on layout.
    for (const i of FLOOR_INDICES) expect(EMBER_DUNGEON.floorMaps?.[i]).toBe(floorAt(i));
  });

  it('resolves its capstone piece ids against the level-1 library, not the legacy ember pool', () => {
    expect(pieceFor(EMBER_DUNGEON.extractionPieceId).role).toBe('extraction');
    expect(pieceFor(EMBER_DUNGEON.bossPieceId).role).toBe('boss');
  });

  it("halves the curve's ceiling again now that the room-authored type gradient shoulders part of the depth scaling (Task 2, ENGINE_VERSION 69)", () => {
    // Was `perFloor: 0.5` / ceiling ×3 — see `world/rooms/ember.ts`'s own doc comment
    // on why stacking the flat HP curve on top of an ALREADY depth-scaled room
    // roster (ironclad/galvanist arriving floor 2+, ravager count climbing with
    // depth) double-counted "harder deeper" onto the same enemies.
    const { base, perFloor } = EMBER_DUNGEON.difficultyCurve;
    expect(base + perFloor * (EMBER_DUNGEON.floorCount - 1)).toBe(2);
  });
});

describe('level 1 floor shape', () => {
  it('has 6 / 7 / 8 / 8 / 6 rooms', () => {
    expect(FLOOR_INDICES.map((i) => floorAt(i).rooms.length)).toEqual(EXPECTED_ROOM_COUNTS);
  });

  it('caps floors 0-3 with the extraction room and floor 4 with the boss room', () => {
    for (const i of FLOOR_INDICES) {
      const rooms = floorAt(i).rooms;
      const last = pieceFor(rooms[rooms.length - 1]!.pieceId);
      expect(last.role).toBe(i === 4 ? 'boss' : 'extraction');
      // Only the capstone may carry a role — a mid-floor extraction portal would
      // give the floor two exits (ExtractionSystem reads placement order, not role).
      for (const r of rooms.slice(0, -1)) expect(pieceFor(r.pieceId).role).toBeUndefined();
    }
  });

  it('never repeats a piece within a floor', () => {
    for (const i of FLOOR_INDICES) {
      const ids = floorAt(i).rooms.map((r) => r.pieceId);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('references only pieces that exist in the shipped library', () => {
    for (const i of FLOOR_INDICES) {
      for (const room of floorAt(i).rooms) expect(() => pieceFor(room.pieceId)).not.toThrow();
    }
  });
});

describe('level 1 room pieces', () => {
  it('every room is between 15x15 and 20x20 grid cells', () => {
    for (const piece of EMBER_L1_ROOMS) {
      expect(piece.sizeGrid.w).toBeGreaterThanOrEqual(MIN_SIDE);
      expect(piece.sizeGrid.h).toBeGreaterThanOrEqual(MIN_SIDE);
      expect(piece.sizeGrid.w).toBeLessThanOrEqual(MAX_SIDE);
      expect(piece.sizeGrid.h).toBeLessThanOrEqual(MAX_SIDE);
    }
  });

  it('enemy count scales with cell count, 8 at 15x15 up to 14 at 20x20', () => {
    for (const piece of EMBER_L1_ROOMS) {
      if (!isFight(piece)) continue; // the checkpoint room and the three side rooms are deliberately empty
      const area = piece.sizeGrid.w * piece.sizeGrid.h;
      const expected = Math.max(MIN_ENEMIES, Math.min(MAX_ENEMIES, Math.round(8 + (6 * (area - 225)) / 175)));
      expect(piece.spawns.enemy.length, piece.id).toBe(expected);
    }
  });

  it('the enemy count is monotonic in cell count — a bigger room is never a lighter fight', () => {
    const fights = EMBER_L1_ROOMS.filter(isFight)
      .map((p) => ({ area: p.sizeGrid.w * p.sizeGrid.h, n: p.spawns.enemy.length }))
      .sort((a, b) => a.area - b.area);
    for (let i = 1; i < fights.length; i++) expect(fights[i]!.n).toBeGreaterThanOrEqual(fights[i - 1]!.n);
  });

  it('no enemy spawns inside its own room’s player-spawn clearance — the entrance room can’t open pre-aimed', () => {
    // Must stay above DEFAULT_ENEMY_ENGAGE_RANGE_FP (5.6 grid — content/enemies.ts,
    // the distance a mob stops and shoots from), or a room places mobs already in
    // firing position on the tick the player appears there, which the engine-side
    // notice delay + fire budget (balance/encounter.ts) can only soften, never undo.
    // Level 1's first pass authored 3 grid and `ember_l1_cell` duly put its nearest
    // mob 3.2 grid from the spawn point; the generator now uses 6.
    for (const piece of EMBER_L1_ROOMS) {
      for (const e of piece.spawns.enemy) {
        for (const p of piece.spawns.player) {
          const d = Math.hypot(e.x - p.x, e.y - p.y);
          expect(d, `${piece.id}: enemy (${e.x},${e.y}) vs player spawn (${p.x},${p.y})`).toBeGreaterThan(6);
        }
      }
    }
  });

  it('the extraction capstone stays enemy-free — it is the checkpoint, not a second boss fight', () => {
    expect(pieceFor('ember_l1_extraction').spawns.enemy).toEqual([]);
  });

  it('the enemy-free pieces are exactly the capstone and the three named side rooms', () => {
    // The other half of `SIDE_PIECES`' own comment: the exemption above is an allowlist, so
    // this is what stops it being a place to quietly park a combat room that stopped spawning.
    expect(EMBER_L1_ROOMS.filter((p) => p.spawns.enemy.length === 0).map((p) => p.id).sort()).toEqual([
      'ember_l1_cache', 'ember_l1_extraction', 'ember_l1_market', 'ember_l1_vault',
    ]);
    for (const id of SIDE_PIECES) expect(pieceFor(id).role, id).toBeUndefined(); // a side room is a NORMAL room
  });

  it("the boss room opens with the random-boss sentinel at spawn point 0 (Task 2, ENGINE_VERSION 70)", () => {
    // Was a fixed 'blightlord' through v69 — SpawnSystem now resolves this sentinel to
    // one of BOSS_POOL's three bosses (`resolveSpawnType`), one `aiPrng` draw the tick
    // the room activates.
    expect(pieceFor('ember_l1_boss').spawns.enemy[0]?.type).toBe('boss_random');
  });

  it('every piece authors at least two player spawns (a co-op run seats two) and all four exits', () => {
    for (const piece of EMBER_L1_ROOMS) {
      expect(piece.spawns.player.length, piece.id).toBeGreaterThanOrEqual(2);
      expect(new Set(piece.exits.map((e) => e.edge))).toEqual(new Set(['north', 'south', 'east', 'west']));
    }
  });

  it('has no `encounter` script anywhere — an absent one is the engine\'s "all spawn points at tick 0" default, which is what makes a room genuinely cleared the moment it is empty (DoorSystem\'s unlock rule)', () => {
    for (const piece of EMBER_L1_ROOMS) expect(piece.encounter, piece.id).toBeUndefined();
  });
});

/**
 * The chests level 1 authors (design/05 "Chest rooms", ENGINE_VERSION 63). The suite above
 * has held every other authored placement to a rule since the level shipped; these arrived
 * afterwards and were held to none, which is the whole reason this block exists — a chest is
 * a placement like any other, and the one thing that makes it *less* safe than a spawn point
 * is that `SpawnSystem` clamps it rather than failing on it (see `traversability`).
 */
describe('level 1 chests', () => {
  const withChests = EMBER_L1_ROOMS.filter((p) => (p.chests?.length ?? 0) > 0);
  const everyChest = EMBER_L1_ROOMS.flatMap((p) => (p.chests ?? []).map((c) => ({ piece: p, c })));

  it('exactly two pieces carry one — the cache its small chest, the vault the big one', () => {
    // The shipped content decision, stated so a third chest piece cannot arrive unnoticed.
    // Until 2026-09-14 the chests rode the COMBAT pieces (alcove/court/gallery/rampart, plus
    // the big one on the extraction capstone), which meant a floor's rewards were decided by
    // which pieces it happened to draw. They now ride two dedicated enemy-free side rooms, so
    // a floor's chest budget is a floor-map decision — see `emberLevel1.ts`'s own header.
    expect(withChests.map((p) => p.id).sort()).toEqual(['ember_l1_cache', 'ember_l1_vault']);
    expect(everyChest.filter(({ c }) => c.kind === 'big').map(({ piece }) => piece.id)).toEqual(['ember_l1_vault']);
    expect(everyChest.filter(({ c }) => c.kind === 'small').map(({ piece }) => piece.id)).toEqual(['ember_l1_cache']);
  });

  it('puts every chest inside its own piece, clear of the perimeter wall', () => {
    // A piece's outermost ring of cells is its wall (`buildFloorGeometry` stitches it), so a
    // chest authored at x=0 is inside stone. Piece-local, so this catches the authoring
    // mistake in the editor's own coordinates rather than in the stitched floor.
    for (const { piece, c } of everyChest) {
      expect(c.x, `${piece.id} chest x`).toBeGreaterThanOrEqual(1);
      expect(c.y, `${piece.id} chest y`).toBeGreaterThanOrEqual(1);
      expect(c.x, `${piece.id} chest x`).toBeLessThanOrEqual(piece.sizeGrid.w - 1);
      expect(c.y, `${piece.id} chest y`).toBeLessThanOrEqual(piece.sizeGrid.h - 1);
    }
  });

  it('never puts one within reach of a player spawn — opening it has to be a walk', () => {
    // `ChestSystem` opens a small chest for any live player within CHEST_OPEN_RANGE_GRID, with
    // no button at all since `ENGINE_VERSION` 66 — so this authoring rule stopped being a nicety
    // and became the only thing between a chest and a payout on TICK 1, to a player who has not
    // moved. That is the opposite of the verb chests exist for ("search"-fight-extract).
    // Closest today: ember_l1_alcove at 2.69 grid.
    for (const { piece, c } of everyChest) {
      for (const p of piece.spawns.player) {
        const d = Math.hypot(c.x - p.x, c.y - p.y);
        expect(d, `${piece.id}: chest (${c.x},${c.y}) vs player spawn (${p.x},${p.y})`).toBeGreaterThan(CHEST_OPEN_RANGE_GRID);
      }
    }
  });

  it('leaves a big chest’s whole plate ring inside its own room, at every seat count', () => {
    // The ring is derived from the run's SEAT count, so the room has to hold the widest one a
    // party can ask for — plus the radius a player has to stand within. The vault is 17x17 and
    // the ring is CHEST_MECHANISM_RING_GRID (3) from its centre, so this has real margin; the
    // test is here for the next big chest, authored into a room that may not.
    for (const { piece, c } of everyChest.filter((e) => e.c.kind === 'big')) {
      for (const seats of [1, 2, 3, 4]) {
        for (const m of mechanismRing(toFpGrid(c.x), toFpGrid(c.y), seats)) {
          const gx = (m.gx as number) / FP_SCALE;
          const gy = (m.gy as number) / FP_SCALE;
          expect(gx, `${piece.id} plate x @ ${seats} seats`).toBeGreaterThanOrEqual(1);
          expect(gy, `${piece.id} plate y @ ${seats} seats`).toBeGreaterThanOrEqual(1);
          expect(gx, `${piece.id} plate x @ ${seats} seats`).toBeLessThanOrEqual(piece.sizeGrid.w - 1);
          expect(gy, `${piece.id} plate y @ ${seats} seats`).toBeLessThanOrEqual(piece.sizeGrid.h - 1);
        }
      }
    }
    // Anti-vacuity: the loop above is over a filtered list, and an empty one passes it.
    expect(everyChest.filter((e) => e.c.kind === 'big')).toHaveLength(1);
    expect(CHEST_MECHANISM_RING_GRID).toBeGreaterThan(0);
  });

  it('spreads the chests one per floor — a small one on four floors, the big one on floor 2', () => {
    // The 2026-09-14 distribution, decided by the game's owner: the co-op chest sits on ONE
    // floor (2), every other floor carries a single small chest, and no floor carries two.
    // Measured per floor rather than per piece, because that is the thing a player meets.
    const kindsOn = (i: number): string[] =>
      floorAt(i).rooms.flatMap((r) => (pieceFor(r.pieceId).chests ?? []).map((c) => c.kind)).sort();
    expect(FLOOR_INDICES.map(kindsOn)).toEqual([['small'], ['small'], ['big'], ['small'], ['small']]);
  });

  it('puts every chest in a room that is a SEARCH, not a fight — and off the chain to the capstone', () => {
    // design/05 "Chest rooms": *"a floor mixes combat rooms with chest rooms. Not every room
    // has enemies in it."* Two halves, and the second is the one a topology test can see: a
    // chest room is a DEAD END (exactly one door), so reaching the capstone never requires
    // walking through it — opening a chest is a detour the player chooses to take.
    for (const i of FLOOR_INDICES) {
      const map = floorAt(i);
      for (const room of map.rooms) {
        if ((pieceFor(room.pieceId).chests?.length ?? 0) === 0) continue;
        expect(pieceFor(room.pieceId).spawns.enemy, `floor ${i} ${room.id}`).toEqual([]);
        const doors = map.doors.filter((d) => d.roomA === room.id || d.roomB === room.id);
        expect(doors.length, `floor ${i} ${room.id} door count`).toBe(1);
        expect(room.id, `floor ${i} chest room is not the capstone`).not.toBe(map.rooms[map.rooms.length - 1]!.id);
      }
    }
  });
});

/**
 * The shop counters level 1 authors (design/05 "Shops", ENGINE_VERSION 64). Shops shipped a
 * version after the chests and were held to no content rule at all — the block above was
 * written for chests alone — so this is the same gate, for the same reason: `SpawnSystem`
 * CLAMPS a counter to walkable ground rather than failing on one authored into stone, which
 * makes a placement mistake silent everywhere except here.
 */
describe('level 1 shops', () => {
  const withShops = EMBER_L1_ROOMS.filter((p) => (p.shops?.length ?? 0) > 0);
  const everyShop = EMBER_L1_ROOMS.flatMap((p) => (p.shops ?? []).map((sh) => ({ piece: p, sh })));

  it('two pieces carry one counter each — the vault and the market side rooms (Task 5)', () => {
    // Until 2026-09-14 the counter rode `forge` (floors 0-1) and `crucible` (floors 2-4), so
    // every floor had one because every floor drew one of those two pieces. The owner's call
    // that day put the run's shop on ONE floor, which a per-piece placement cannot express.
    // Task 5's "改为两个商店可以的" reopened it: `ember_l1_vault` (already a big-chest room on
    // floor 3) gained a second, independent counter — no new room, no new door, so the run's
    // existing connectivity is untouched.
    expect(withShops.map((p) => p.id).sort()).toEqual(['ember_l1_market', 'ember_l1_vault']);
    expect(everyShop).toHaveLength(2);
  });

  it('stocks exactly two floors — index 2 (the vault) and index 3 (the market, the floor before the boss)', () => {
    // Coins are run-scoped and never banked (design/05 "Coins"), so two counters spread
    // across the back half of the run is the whole economy's pressure: everything saved by
    // floor 2 is spendable there, and everything saved after is spendable once more before
    // the run's only exit.
    const shopsOn = (i: number): number =>
      floorAt(i).rooms.reduce((n, r) => n + (pieceFor(r.pieceId).shops?.length ?? 0), 0);
    expect(FLOOR_INDICES.map(shopsOn)).toEqual([0, 0, 1, 1, 0]);
  });

  it('puts the counter inside its own piece, clear of the perimeter wall', () => {
    for (const { piece, sh } of everyShop) {
      expect(sh.x, `${piece.id} shop x`).toBeGreaterThanOrEqual(1);
      expect(sh.y, `${piece.id} shop y`).toBeGreaterThanOrEqual(1);
      expect(sh.x, `${piece.id} shop x`).toBeLessThanOrEqual(piece.sizeGrid.w - 1);
      expect(sh.y, `${piece.id} shop y`).toBeLessThanOrEqual(piece.sizeGrid.h - 1);
    }
  });

  it('never puts one within reach of a player spawn — the panel has to be walked to', () => {
    // `ShopSystem` refuses a purchase from outside SHOP_INTERACT_RANGE_GRID and the panel
    // opens on exactly that ring (`ui/shopProximity.ts`). A counter on top of a spawn point
    // would open the shop panel on the tick the room is entered.
    for (const { piece, sh } of everyShop) {
      for (const pl of piece.spawns.player) {
        const d = Math.hypot(sh.x - pl.x, sh.y - pl.y);
        expect(d, `${piece.id}: shop (${sh.x},${sh.y}) vs player spawn (${pl.x},${pl.y})`).toBeGreaterThan(SHOP_INTERACT_RANGE_GRID);
      }
    }
  });

  it('leaves the whole mat walkable — a refusal the player cannot predict reads as a broken button', () => {
    // The mat is drawn at exactly SHOP_INTERACT_RANGE_GRID (design/05 "The range gate is
    // drawn"), so every cell of it has to be standable inside the piece's own geometry. A
    // free-standing block authored across the mat would draw a ring a player cannot reach
    // half of — checked piece-locally against `solids`, since the stitched floor cannot say
    // which block was the author's mistake.
    for (const { piece, sh } of everyShop) {
      for (const solid of piece.solids) {
        const nx = Math.max(solid.x, Math.min(sh.x, solid.x + solid.w));
        const ny = Math.max(solid.y, Math.min(sh.y, solid.y + solid.h));
        const d = Math.hypot(sh.x - nx, sh.y - ny);
        expect(d, `${piece.id}: solid (${solid.x},${solid.y},${solid.w}x${solid.h}) vs shop mat`).toBeGreaterThan(SHOP_INTERACT_RANGE_GRID);
      }
    }
  });

  it('puts the counter in a dead-end side room, like the chests — shopping is a detour, not a toll', () => {
    for (const i of FLOOR_INDICES) {
      const map = floorAt(i);
      for (const room of map.rooms) {
        if ((pieceFor(room.pieceId).shops?.length ?? 0) === 0) continue;
        expect(pieceFor(room.pieceId).spawns.enemy, `floor ${i} ${room.id}`).toEqual([]);
        expect(map.doors.filter((d) => d.roomA === room.id || d.roomB === room.id).length, `floor ${i} ${room.id}`).toBe(1);
      }
    }
  });
});

// ── Door passability (the suite itself lives in `fixtures/floorPassability.ts`) ─────

/**
 * Every layout a run can draw — the five plain floors and each branch variant — goes through
 * the same passability suite. A variant is a separately authored file, so "the plain floor
 * passes" says nothing about it; until 2026-09-26 the one variant carried a hand-copied subset
 * of these checks (no wall-thickness, shop-ring or extent check).
 */
const BRANCH_VARIANTS = [
  { index: 1, map: EMBER_L1_FLOOR_2_BRANCH, skippable: ['r3_span'] },
  { index: 2, map: EMBER_L1_FLOOR_3_BRANCH, skippable: ['r5_bastion'] },
  { index: 3, map: EMBER_L1_FLOOR_4_BRANCH, skippable: ['r4_rampart', 'b1_cache'] },
] as const;
const LAYOUTS = [
  ...FLOOR_INDICES.map((i) => ({ name: `floor ${i}`, map: floorAt(i) })),
  ...BRANCH_VARIANTS.map((v) => ({ name: `floor ${v.index} branch`, map: v.map as DungeonFloorMap })),
];

describeFloorPassability(LAYOUTS, EMBER_L1_ROOMS);


describe.each(BRANCH_VARIANTS)("floor $index's branching layout variant (Task 6 2026-09-23; floors 2-3 ROADMAP B3 2026-09-26)", ({ index, map: branch, skippable }) => {
  const linear = floorAt(index);
  // The side rooms each plain floor already hangs off its chain (design/05 "Chest rooms") —
  // never mandatory on either layout, so they say nothing about whether a FIGHT is skippable.
  const sideRooms = new Set(linear.rooms.filter((r) => SIDE_PIECES.has(r.pieceId)).map((r) => r.id));

  it("is wired into EMBER_DUNGEON as this floor index's variant pool, plain layout first", () => {
    expect(EMBER_DUNGEON.floorLayoutVariants?.[index]).toEqual([linear, branch]);
  });

  it('keeps the exact same room roster and door count, in the same order, as the plain layout — so enemy-id allocation and notice-delay tuning never depend on which variant a run draws', () => {
    expect(branch.rooms.map((r) => r.id)).toEqual(linear.rooms.map((r) => r.id));
    expect(branch.rooms.map((r) => r.pieceId)).toEqual(linear.rooms.map((r) => r.pieceId));
    expect(branch.doors.length).toBe(linear.doors.length);
  });

  it('genuinely lets a FIGHT be skipped — the capstone stays reachable with that room and its doors removed', () => {
    const fights = skippable.filter((id) => !sideRooms.has(id));
    expect(fights.length).toBeGreaterThan(0); // a skippable side room alone would prove nothing
    for (const id of skippable) expect(reachesCapstoneWithout(branch, id), `${id} should be skippable`).toBe(true);
  });

  it('skips nothing else — every other room between spawn and capstone is still on the only path', () => {
    const mandatory = branch.rooms
      .map((r) => r.id)
      .filter((id) => id !== branch.rooms[0]!.id && id !== branch.rooms[branch.rooms.length - 1]!.id)
      .filter((id) => !sideRooms.has(id) && !(skippable as readonly string[]).includes(id));
    for (const id of mandatory) expect(reachesCapstoneWithout(branch, id), `${id} should be mandatory`).toBe(false);
  });

  it('the plain layout has no such skip — removing any single chain room (not a side room) disconnects the capstone', () => {
    const mandatory = linear.rooms.map((r) => r.id).filter((id) => !sideRooms.has(id) && id !== linear.rooms[0]!.id);
    for (const id of mandatory) {
      expect(reachesCapstoneWithout(linear, id), `${id} should not be skippable on the plain layout`).toBe(false);
    }
  });

  it("keeps the plain layout's capstone last", () => {
    expect(pieceFor(branch.rooms[branch.rooms.length - 1]!.pieceId).role).toBe('extraction');
  });
});
