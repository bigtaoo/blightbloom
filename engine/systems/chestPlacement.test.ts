/**
 * Where a floor's chests come from — `SpawnSystem`'s placement half (design/05 "Chest rooms",
 * ENGINE_VERSION 63). `systems/chests.test.ts` owns what a chest DOES once it exists; this
 * file owns everything that happens before that, and the reason it exists is a shipped
 * regression that every gate in the repo was blind to.
 *
 * ## The id-space regression, and why nothing caught it
 *
 * Chests were built with `GameState.nextId()`, which reads as obviously correct. But a floor's
 * chests are built when the floor is PLACED, before any of its enemies spawn, so three chests
 * on level 1 shifted every later enemy id by three — and an enemy id is not inert:
 * `noticeDelayTicks(e.id)` is what staggers a woken garrison's opening volley. The re-staggered
 * first volley took `client/sim/pveLevelSim.sim.ts` from "at least 2 of 8 careful runs descend
 * off floor 0" to 8 of 8 dying there.
 *
 * Every gate was green, and one of them was actively misleading:
 *
 *   - **coverage** — `nextChestId()` runs on every floor placement, so the line was covered
 *     from the first test that placed a floor with a chest in it;
 *   - **the golden hash** — it DID move, and it read as the floor getting *easier* (170 shots
 *     to 167, the player finishing on 4.2 HP instead of 2.4), so the version entry written
 *     from it called the shift "pure bookkeeping". It is one 1500-tick scripted run that never
 *     leaves its spawn room;
 *   - **`systems/chests.test.ts`** — it hand-builds its chests with `s.nextId()` in a helper,
 *     precisely because it is about the system and not the placement. Nothing there could ever
 *     have noticed.
 *
 * Only the PvE bot sim disagreed, and it was right. A sim is not a gate (it is minutes, and it
 * reports a distribution rather than a pass), so the rule it discovered is pinned here instead:
 * **adding a prop to a room must not retune the room's difficulty.** The strongest available
 * form of that is a twin — the same floor, the same seed, placed once with chests and once
 * without — because it asserts the property directly rather than asserting today's id numbers,
 * which any legitimate spawn-order change is allowed to move.
 */
import { describe, it, expect } from 'vitest';
import { createGameEngine } from '@dd/engine/GameEngine';
import type { EngineConfig } from '@dd/engine/state/GameState';
import { makeCommand } from '@dd/engine/state/input';
import type { Brad } from '@dd/engine/math/trig';
import { toFpGrid } from '@dd/engine/content/convert';
import { noticeDelayTicks } from '@dd/engine/balance/encounter';
import { dropClearance } from '@dd/engine/state/actorRadius';
import { clampToWalkable } from '@dd/engine/systems/geom';
import type { ChestPlacement, RoomPiece } from '@dd/engine/content/rooms';
import type { DungeonConfig, DungeonFloorMap } from '@dd/engine/world/dungeon';

const idle = (tick: number) =>
  makeCommand({ owner: 0, tick, moveBrad: 0 as Brad, moveMag: 0, buttons: 0 });

/**
 * A hall with a real garrison and three chests, and an enemy-free capstone. The garrison is
 * what the twin below is measured on: a piece with no enemies has no id to shift and would
 * make the whole comparison vacuous.
 *
 * The wall at x=5 is load-bearing for the clamp cases at the bottom of this file — the big
 * chest is authored hard against it, which is a thing a level author may legitimately do.
 */
const HALL_CHESTS: ChestPlacement[] = [
  { kind: 'small', x: 3, y: 3 },
  { kind: 'big', x: 6.5, y: 8 },
  { kind: 'small', x: 16, y: 12 },
];

function hall(chests: ChestPlacement[] | undefined): RoomPiece {
  return {
    id: 'c_hall',
    tags: ['c'],
    sizeGrid: { w: 20, h: 16 },
    solids: [{ x: 5, y: 6, w: 1, h: 4 }],
    spawns: {
      player: [{ x: 2, y: 8 }, { x: 2, y: 10 }],
      enemy: [
        { x: 12, y: 4, type: 'basic' },
        { x: 14, y: 8, type: 'basic' },
        { x: 12, y: 12, type: 'basic' },
      ],
    },
    exits: [{ edge: 'east' }],
    ...(chests ? { chests } : {}),
  };
}

/** The capstone, with its one chest or without it — same switch as the hall's. */
function capstone(withChest: boolean): RoomPiece {
  return {
    id: 'c_extract',
    role: 'extraction',
    tags: ['c'],
    sizeGrid: { w: 10, h: 10 },
    solids: [],
    spawns: { player: [{ x: 5, y: 8 }], enemy: [] },
    exits: [{ edge: 'west' }],
    ...(withChest ? { chests: [{ kind: 'small' as const, x: 5, y: 3 }] } : {}),
  };
}

const BOSS: RoomPiece = {
  id: 'c_boss',
  role: 'boss',
  sizeGrid: { w: 12, h: 12 },
  solids: [],
  spawns: { player: [{ x: 6, y: 10 }], enemy: [] },
  exits: [{ edge: 'west' }],
};

const floorMap = (hallId: string, capId: string): DungeonFloorMap => ({
  id: 'c_f0',
  rooms: [
    { id: 'r_hall', pieceId: hallId, offsetXGrid: 0, offsetYGrid: 0 },
    { id: 'r_cap', pieceId: capId, offsetXGrid: 20, offsetYGrid: 0 },
  ],
  doors: [{ roomA: 'r_hall', roomB: 'r_cap', passageGrid: { x: 19, y: 7, w: 2, h: 2 } }],
});

/** The same dungeon twice over: `withChests` decides only whether its pieces author any. */
function config(withChests: boolean, seats = 1): EngineConfig {
  const piece = hall(withChests ? HALL_CHESTS : undefined);
  const cap = capstone(withChests);
  const dungeon: DungeonConfig = {
    biomeId: 'c',
    nameKey: 'c',
    floorCount: 2,
    roomsPerFloor: { min: 2, max: 2 },
    pieceTags: ['c'],
    layout: 'linear',
    extractionPieceId: cap.id,
    bossPieceId: BOSS.id,
    difficultyCurve: { base: 1, perFloor: 1 },
    floorMaps: { 0: floorMap(piece.id, cap.id) },
  };
  return {
    seed: 11,
    worldW: 640,
    worldH: 640,
    waves: [],
    // One seat per entry, in order — the seat COUNT is what a big chest's plate ring is
    // derived from, so it is a parameter of these tests rather than a constant.
    players: Array.from({ length: seats }, () => ({})),
    dungeon: { config: dungeon, library: [piece, cap, BOSS] },
  };
}

/** Place the floor and walk far enough for the hall's garrison to have spawned. */
function run(withChests: boolean, ticks = 8, seats = 1) {
  const eng = createGameEngine(config(withChests, seats));
  for (let t = 1; t <= ticks; t++) eng.step([idle(t)]);
  return eng;
}

describe('chest ids live in their own space (ENGINE_VERSION 63 regression)', () => {
  it('places the same floor with and without chests and gets the SAME enemy ids', () => {
    const withChests = run(true);
    const without = run(false);

    // The premise, not the assertion: both runs really did spawn a garrison, and only one
    // of them really did build chests. Without these two the comparison below passes on a
    // pair of empty arrays.
    expect(withChests.state.enemies.length).toBeGreaterThan(0);
    expect(withChests.state.chests.length).toBe(HALL_CHESTS.length + 1); // + the capstone's
    expect(without.state.chests.length).toBe(0);

    expect(withChests.state.enemies.map((e) => e.id)).toEqual(without.state.enemies.map((e) => e.id));
  });

  it('leaves the opening volley unmoved — the consequence the id shift actually had', () => {
    // `noticeDelayTicks` is the function that turned "three chests" into "8 of 8 runs die on
    // floor 0". Asserting the derived delays as well as the ids says WHY the ids matter, so a
    // future reader cannot mistake this file for tidiness about numbering.
    const withChests = run(true);
    const without = run(false);
    const delays = (eng: typeof withChests) => eng.state.enemies.map((e) => noticeDelayTicks(e.id));
    expect(delays(withChests)).toEqual(delays(without));
  });

  it('hands the players themselves the same ids too — the chest space starts before they do', () => {
    expect(run(true).state.players.map((p) => p.id)).toEqual(run(false).state.players.map((p) => p.id));
  });

  it('numbers chests from 1 in their own space, densely and without collision', () => {
    const s = run(true).state;
    // Dense from 1: the space is fresh, so the first chest of the run is chest 1 — which is
    // also a live entity id, and that overlap is the point (the two spaces never meet).
    expect(s.chests.map((c) => c.id)).toEqual([1, 2, 3, 4]);
    expect(new Set(s.chests.map((c) => c.id)).size).toBe(s.chests.length);
  });
});

describe('a floor owns its chests for exactly as long as it exists', () => {
  it('places none at all for a library that predates the field', () => {
    // Every piece in the shipped library was authored without `chests` before v63; an absent
    // field has to mean "no chests", not "undefined.length".
    const s = run(false).state;
    expect(s.chests).toEqual([]);
  });

  it('gives every chest the id of the room it was authored into', () => {
    const s = run(true).state;
    const hallRoom = s.dungeonRooms.find((r) => r.piece.id === 'c_hall')!;
    const capRoom = s.dungeonRooms.find((r) => r.piece.id === 'c_extract')!;
    // `ChestSystem.roomActive` looks its chest up by this id — a chest carrying the wrong
    // room's id is either permanently dead or openable from outside its own room.
    expect(s.chests.filter((c) => c.roomId === hallRoom.id)).toHaveLength(HALL_CHESTS.length);
    expect(s.chests.filter((c) => c.roomId === capRoom.id)).toHaveLength(1);
  });

  it('offsets each chest into its room’s placement in the shared floor', () => {
    const s = run(true).state;
    const cap = s.dungeonRooms.find((r) => r.piece.id === 'c_extract')!;
    const chest = s.chests.find((c) => c.roomId === cap.id)!;
    // The capstone is placed 20 grid east, so its chest is too. Authoring is piece-local and
    // the floor is one stitched world: a chest that forgot the offset would sit in the hall.
    expect(chest.gx).toBe(toFpGrid(5 + cap.offsetXGrid));
    expect(chest.gy).toBe(toFpGrid(3 + cap.offsetYGrid));
  });

  it('clears the previous floor’s chests on a descend, and keeps the ids unique anyway', () => {
    const eng = run(true);
    const before = eng.state.chests.map((c) => c.id);
    expect(before.length).toBeGreaterThan(0);

    // Force floor 1 the way the rest of the dungeon suite does — empty the sentinel the
    // descend resets, rather than fighting a whole floor's garrison for it.
    eng.state.floorIndex++;
    eng.state.dungeonRooms.length = 0;
    eng.state.dungeonDoors.length = 0;
    eng.state.dungeonRoomRuntime.length = 0;
    eng.state.dungeonRoomRects.length = 0;
    eng.state.dungeonRoomIndexById.clear();
    eng.state.dungeonBaseWalls.length = 0;
    for (let t = 9; t <= 16; t++) eng.step([idle(t)]);

    // Same rule as the pickups cleared beside them: an unopened chest is unreachable the
    // moment its room stops existing, so it must not be carried forward.
    for (const c of eng.state.chests) expect(before).not.toContain(c.id);
  });
});

describe('a chest is placed onto ground a player can actually stand on', () => {
  it('leaves a chest authored in the open exactly where the author put it', () => {
    // The control for the clamp cases below. If the clamp moved every chest a little, the
    // assertions there would pass while telling a level author nothing.
    const s = run(true).state;
    const open = s.chests.find((c) => c.gx === toFpGrid(16) && c.gy === toFpGrid(12));
    expect(open).toBeDefined();
  });

  it('clamps a big chest’s plates out of the stone it was authored against', () => {
    const s = run(true).state;
    const big = s.chests.find((c) => c.kind === 'big')!;
    expect(big.mechanisms.length).toBeGreaterThan(0);
    for (const m of big.mechanisms) {
      // A plate a player cannot stand on is a chest that can never open. `clampToWalkable`
      // being a FIXED POINT here is the test: the placement already resolved it, so applying
      // it again may not move the plate.
      const again = clampToWalkable(m.gx, m.gy, dropClearance(), s);
      expect({ gx: again.gx, gy: again.gy }).toEqual({ gx: m.gx, gy: m.gy });
    }
  });

  it('rings a big chest with one plate per SEAT, which a room piece cannot author', () => {
    // Two seats is the smallest party for which a big chest is a coordination gate rather
    // than a step, and the count comes from the run, never from the piece.
    expect(run(true, 8, 1).state.chests.find((c) => c.kind === 'big')!.mechanisms).toHaveLength(1);
    expect(run(true, 8, 2).state.chests.find((c) => c.kind === 'big')!.mechanisms).toHaveLength(2);
  });

  it('gives a small chest no plates at all, whatever the party size', () => {
    for (const c of run(true, 8, 2).state.chests.filter((q) => q.kind === 'small')) {
      expect(c.mechanisms).toEqual([]);
    }
  });

  it('starts every chest closed and every plate cold', () => {
    for (const c of run(true, 8, 2).state.chests) {
      expect(c.opened).toBe(false);
      for (const m of c.mechanisms) expect(m.occupied).toBe(false);
    }
  });
});
