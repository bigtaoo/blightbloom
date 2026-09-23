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
import { EMBER_L1_FLOORS, EMBER_L1_ROOMS } from './emberLevel1';
import { EMBER_DUNGEON } from './ember';
import { buildFloorGeometry, placeAuthoredFloor, type DungeonFloorMap } from '../dungeon';
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

// ── Door passability ────────────────────────────────────────────────────────────

/** Rooms may share a wall but must never overlap — every downstream room-membership
 * test (`EnvironmentSystem`'s point-in-rect roomId lookup) assumes disjoint rects. */
function overlapping(map: DungeonFloorMap): string[] {
  const rects = map.rooms.map((r) => ({
    id: r.id,
    x: r.offsetXGrid,
    y: r.offsetYGrid,
    w: pieceFor(r.pieceId).sizeGrid.w,
    h: pieceFor(r.pieceId).sizeGrid.h,
  }));
  const bad: string[] = [];
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i]!;
      const b = rects[j]!;
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) bad.push(`${a.id}/${b.id}`);
    }
  }
  return bad;
}

/**
 * The real thing: run the engine's own placement + geometry stitching, rasterise
 * the stitched (already door-carved) Fp wall list back onto a 1-cell grid, and
 * flood-fill from the spawn room's first player spawn. Anything a player must be
 * able to stand on — every room's `entranceGrid` (DoorSystem's force-regroup
 * landing point), every player spawn, every enemy spawn — has to be in the
 * reachable set. A door that opens into a solid, or that only cut one of the two
 * abutting perimeter walls, fails here.
 */
function traversability(map: DungeonFloorMap) {
  const { placed, doors } = placeAuthoredFloor(map, EMBER_L1_ROOMS);
  const geo = buildFloorGeometry(placed, doors);
  const W = Math.round(geo.worldW / FP_SCALE);
  const H = Math.round(geo.worldH / FP_SCALE);

  // Start solid everywhere (outside the rooms IS solid), open each room's footprint,
  // then stamp the stitched wall list back on. `buildFloorGeometry` has already
  // carved the door gaps out of that list, so the openings appear for free.
  const solid = new Uint8Array(W * H).fill(1);
  const at = (x: number, y: number) => y * W + x;
  for (const room of placed) {
    for (let y = 0; y < room.piece.sizeGrid.h; y++) {
      for (let x = 0; x < room.piece.sizeGrid.w; x++) solid[at(room.offsetXGrid + x, room.offsetYGrid + y)] = 0;
    }
  }
  for (const wall of geo.walls) {
    const x0 = Math.round(wall.x / FP_SCALE);
    const y0 = Math.round(wall.y / FP_SCALE);
    const x1 = Math.round((wall.x + wall.w) / FP_SCALE);
    const y1 = Math.round((wall.y + wall.h) / FP_SCALE);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (x >= 0 && y >= 0 && x < W && y < H) solid[at(x, y)] = 1;
  }
  for (const o of geo.obstacles) {
    const cx = o.gx / FP_SCALE;
    const cy = o.gy / FP_SCALE;
    const r = o.radius / FP_SCALE;
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        if (x >= 0 && y >= 0 && x < W && y < H && Math.hypot(x + 0.5 - cx, y + 0.5 - cy) <= r + 0.5) solid[at(x, y)] = 1;
      }
    }
  }

  const first = placed[0]!;
  const startPt = first.piece.spawns.player[0]!;
  const start = at(Math.floor(first.offsetXGrid + startPt.x), Math.floor(first.offsetYGrid + startPt.y));
  const seen = new Uint8Array(W * H);
  const stack = [start];
  seen[start] = 1;
  while (stack.length > 0) {
    const cur = stack.pop()!;
    const cx = cur % W;
    const cy = (cur - cx) / W;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const n = at(nx, ny);
      if (seen[n] || solid[n]) continue;
      seen[n] = 1;
      stack.push(n);
    }
  }

  const unreachable: string[] = [];
  const check = (label: string, x: number, y: number) => {
    if (!seen[at(Math.floor(x), Math.floor(y))]) unreachable.push(`${label} @ (${x}, ${y})`);
  };
  for (const room of placed) {
    check(`${room.id} entrance`, room.entranceGrid.x, room.entranceGrid.y);
    room.piece.spawns.player.forEach((p, i) => check(`${room.id} player spawn ${i}`, room.offsetXGrid + p.x, room.offsetYGrid + p.y));
    room.piece.spawns.enemy.forEach((p, i) => check(`${room.id} enemy spawn ${i}`, room.offsetXGrid + p.x, room.offsetYGrid + p.y));
  }

  /**
   * The same question for this floor's CHESTS (design/05 "Chest rooms", ENGINE_VERSION 63),
   * kept in its own list so the suite above keeps meaning exactly what it meant.
   *
   * A chest gets a second chance that a spawn point does not: `SpawnSystem` clamps every
   * chest AND every derived plate to walkable ground, so one authored into a pillar does not
   * crash or vanish — it silently slides somewhere else, possibly out of the room it was
   * authored for. That makes the clamp a safety net that HIDES an authoring mistake, which is
   * exactly the kind of thing a content gate has to say out loud.
   *
   * Plates are checked at one through four seats because the ring is derived from the run's
   * seat count, not from the piece: a big chest that fits at two seats can still put a plate
   * in the stone at four, and no test that only ever seats two would see it.
   */
  const chestsUnreachable: string[] = [];
  const chestCheck = (label: string, x: number, y: number) => {
    if (!seen[at(Math.floor(x), Math.floor(y))]) chestsUnreachable.push(`${label} @ (${x}, ${y})`);
  };
  for (const room of placed) {
    for (const c of room.piece.chests ?? []) {
      const gx = room.offsetXGrid + c.x;
      const gy = room.offsetYGrid + c.y;
      chestCheck(`${room.id} ${c.kind} chest`, gx, gy);
      if (c.kind !== 'big') continue;
      for (const seats of [1, 2, 3, 4]) {
        mechanismRing(toFpGrid(gx), toFpGrid(gy), seats).forEach((m, i) =>
          chestCheck(`${room.id} big chest plate ${i}/${seats}`, (m.gx as number) / FP_SCALE, (m.gy as number) / FP_SCALE),
        );
      }
    }
  }

  // Which rooms the flood fill actually walked into — a door that is topologically
  // declared but physically sealed shows up as a room with zero reached cells.
  const roomsEntered = placed.filter((room) =>
    Array.from({ length: room.piece.sizeGrid.h }, (_, y) =>
      Array.from({ length: room.piece.sizeGrid.w }, (_, x) => seen[at(room.offsetXGrid + x, room.offsetYGrid + y)]),
    )
      .flat()
      .some(Boolean),
  ).length;

  /** The same question again for this floor's SHOP counters (design/05 "Shops"), and for the
   *  identical reason: `SpawnSystem` clamps a counter to walkable ground, so one authored into
   *  a pillar slides silently rather than failing. The mat is checked too, not just the centre
   *  point — the panel opens on that ring, so a counter whose mat is half inside stone is a
   *  shop a player can see and only sometimes trade with. */
  const shopsUnreachable: string[] = [];
  for (const room of placed) {
    for (const sh of room.piece.shops ?? []) {
      const gx = room.offsetXGrid + sh.x;
      const gy = room.offsetYGrid + sh.y;
      const probes: [string, number, number][] = [[`${room.id} shop`, gx, gy]];
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        probes.push([`${room.id} shop mat ${dx},${dy}`, gx + dx * SHOP_INTERACT_RANGE_GRID, gy + dy * SHOP_INTERACT_RANGE_GRID]);
      }
      for (const [label, x, y] of probes) {
        if (!seen[at(Math.floor(x), Math.floor(y))]) shopsUnreachable.push(`${label} @ (${x}, ${y})`);
      }
    }
  }

  return { unreachable, chestsUnreachable, shopsUnreachable, roomsEntered, roomCount: placed.length, doorCount: doors.length, W, H };
}

describe.each(FLOOR_INDICES)('floor %i door passability', (index) => {
  const map = floorAt(index);

  it('no two rooms overlap', () => {
    expect(overlapping(map)).toEqual([]);
  });

  it('every door sits on a real shared wall between the two rooms it names', () => {
    const rect = (id: string) => {
      const room = map.rooms.find((r) => r.id === id);
      if (!room) throw new Error(`door references unknown room '${id}'`);
      const piece = pieceFor(room.pieceId);
      return { x: room.offsetXGrid, y: room.offsetYGrid, w: piece.sizeGrid.w, h: piece.sizeGrid.h };
    };
    for (const door of map.doors) {
      expect(door.roomA).not.toBe(door.roomB);
      const a = rect(door.roomA);
      const b = rect(door.roomB);
      const p = door.passageGrid;
      // Whole cells, not half ones. Nine authored passages carried a `.5` until
      // `ENGINE_VERSION` 44 — see the "no wall run is thinner than one grid cell"
      // test below for what that actually cost.
      for (const [field, value] of Object.entries(p)) {
        expect(Number.isInteger(value), `${door.roomA}/${door.roomB} passageGrid.${field} = ${value}`).toBe(true);
      }
      const vertical = a.x + a.w === b.x || b.x + b.w === a.x;
      const horizontal = a.y + a.h === b.y || b.y + b.h === a.y;
      expect(vertical || horizontal, `${door.roomA}/${door.roomB} do not touch`).toBe(true);
      if (vertical) {
        const boundary = a.x + a.w === b.x ? b.x : a.x;
        // 2 deep, straddling the boundary — cuts BOTH rooms' 1-thick perimeter walls.
        expect(p.w).toBe(2);
        expect(p.x).toBe(boundary - 1);
        expect(p.y).toBeGreaterThanOrEqual(Math.max(a.y, b.y));
        expect(p.y + p.h).toBeLessThanOrEqual(Math.min(a.y + a.h, b.y + b.h));
      } else {
        const boundary = a.y + a.h === b.y ? b.y : a.y;
        expect(p.h).toBe(2);
        expect(p.y).toBe(boundary - 1);
        expect(p.x).toBeGreaterThanOrEqual(Math.max(a.x, b.x));
        expect(p.x + p.w).toBeLessThanOrEqual(Math.min(a.x + a.w, b.x + b.w));
      }
    }
  });

  it('every room is reachable through the door graph from the spawn room', () => {
    const adjacency = new Map<string, string[]>(map.rooms.map((r) => [r.id, []]));
    for (const door of map.doors) {
      adjacency.get(door.roomA)?.push(door.roomB);
      adjacency.get(door.roomB)?.push(door.roomA);
    }
    const reached = new Set([map.rooms[0]!.id]);
    const queue = [map.rooms[0]!.id];
    while (queue.length > 0) {
      for (const next of adjacency.get(queue.shift()!) ?? []) {
        if (!reached.has(next)) {
          reached.add(next);
          queue.push(next);
        }
      }
    }
    expect([...map.rooms.map((r) => r.id)].filter((id) => !reached.has(id))).toEqual([]);
  });

  /**
   * The gate the four 16 px-deep wall runs actually needed (`ENGINE_VERSION` 44).
   * Every check above passed while they shipped: the pieces' own `solids` are all
   * whole cells, every door sat on a real shared wall, and every room stayed
   * reachable — the sub-cell walls were BORN in `buildFloorGeometry`, where
   * `carveDoorGaps` cut a half-cell-misaligned hole and the tail of the wall run
   * past it came out 0.5 cells deep.
   *
   * So this asserts the property on the stitched output rather than on any input,
   * and asserts the CLASS (no wall thinner than one cell, none off-grid) rather
   * than the four instances — a hole misaligned some other way, or by some other
   * amount, fails here too. Why it matters past tidiness: a 16 px footprint under
   * a 104 px-tall perimeter run puts a cap band on a third of the depth every wall
   * tone was measured on (design/01-rendering.md "A north-south run is not an
   * east-west wall"), and it is the geometry that made the occlusion x-ray need
   * its second, face-fading pass at all.
   */
  it('no wall run in the stitched geometry is thinner than one grid cell, or lands off-grid', () => {
    const { placed, doors } = placeAuthoredFloor(map, EMBER_L1_ROOMS as readonly RoomPiece[]);
    const { walls } = buildFloorGeometry(placed, doors);
    const offenders = walls
      .filter((w) => w.w < FP_SCALE || w.h < FP_SCALE || [w.x, w.y, w.w, w.h].some((v) => v % FP_SCALE !== 0))
      .map((w) => `${w.w / FP_SCALE}x${w.h / FP_SCALE} @ (${w.x / FP_SCALE}, ${w.y / FP_SCALE})`);
    expect(offenders).toEqual([]);
    expect(walls.length).toBeGreaterThan(0); // the filter is only meaningful over real content
  });

  it('every entrance and every spawn point is physically walkable from the spawn room', () => {
    const { unreachable } = traversability(map);
    expect(unreachable).toEqual([]);
  });

  it('every chest and every derived plate stands on walkable ground the run can reach', () => {
    // The clamp in `SpawnSystem` means a chest authored into stone never fails loudly — it
    // just moves. This is where it fails loudly instead.
    const { chestsUnreachable } = traversability(map);
    expect(chestsUnreachable).toEqual([]);
  });

  it('every shop counter, and the whole ring its panel opens on, stands on reachable ground', () => {
    const { shopsUnreachable } = traversability(map);
    expect(shopsUnreachable).toEqual([]);
  });

  it('the flood fill physically walks into every room — no door is declared but sealed', () => {
    const { roomsEntered, roomCount } = traversability(map);
    expect(roomsEntered).toBe(roomCount);
  });

  it('the floor stays inside a sane world extent, starting at the origin', () => {
    expect(Math.min(...map.rooms.map((r) => r.offsetXGrid))).toBe(0);
    expect(Math.min(...map.rooms.map((r) => r.offsetYGrid))).toBe(0);
    const { W, H } = traversability(map);
    expect(W).toBeGreaterThan(0);
    expect(H).toBeGreaterThan(0);
  });
});
