import { describe, it, expect } from 'vitest';
import type { ArenaMap, Door } from '@dd/engine/content/arenas';
import type { ZoneState } from '@dd/engine';
import type { PlacedRoom } from '@dd/engine/world/dungeon';
import type { DoorRuntime, DungeonRoomRuntime } from '@dd/engine/state/GameState';
import { toFpGrid } from '@dd/engine/content/convert';
import { computeMinimapLayout, dungeonRoomStatus, dungeonToArenaMap, roomStatus } from './minimapLayout';

// Mirrors engine/content/arenas.test.ts's fixture shape (three rooms far
// apart) so this pure layout math is exercised against the same kind of ArenaMap the
// engine-side tests already trust.
const ARENA: ArenaMap = {
  id: 'test_arena',
  sizeGrid: { w: 200, h: 200 },
  rooms: [
    { id: 'A', rectGrid: { x: 0, y: 0, w: 10, h: 10 }, solids: [] },
    { id: 'B', rectGrid: { x: 100, y: 0, w: 10, h: 10 }, solids: [] },
    { id: 'C', rectGrid: { x: 0, y: 100, w: 20, h: 20 }, solids: [] },
  ],
  doors: [
    { roomA: 'A', roomB: 'B', passageGrid: { x: 10, y: 4, w: 1, h: 2 } },
    { roomA: 'A', roomB: 'C', passageGrid: { x: 4, y: 10, w: 2, h: 1 } },
  ],
  spawns: [],
  eyeCandidates: [{ roomId: 'A' }],
};

describe('computeMinimapLayout', () => {
  it('fits every room into the box at a uniform, aspect-preserving scale', () => {
    const { rooms } = computeMinimapLayout(ARENA, { w: 100, h: 100 });
    expect(rooms).toHaveLength(3);
    const a = rooms.find((r) => r.id === 'A')!;
    const b = rooms.find((r) => r.id === 'B')!;
    const c = rooms.find((r) => r.id === 'C')!;
    // scale = min(100/200, 100/200) = 0.5, no letterboxing offset for a square map.
    expect(a).toEqual({ id: 'A', x: 0, y: 0, w: 5, h: 5 });
    expect(b).toEqual({ id: 'B', x: 50, y: 0, w: 5, h: 5 });
    expect(c).toEqual({ id: 'C', x: 0, y: 50, w: 10, h: 10 });
  });

  it('letterboxes (centres) a non-square map inside a square box', () => {
    const wide: ArenaMap = { ...ARENA, sizeGrid: { w: 400, h: 200 } };
    const { rooms } = computeMinimapLayout(wide, { w: 100, h: 100 });
    // scale = min(100/400, 100/200) = 0.25 → mapH*scale = 50, centred: offY = 25.
    const a = rooms.find((r) => r.id === 'A')!;
    expect(a.x).toBeCloseTo(0);
    expect(a.y).toBeCloseTo(25);
  });

  it('draws a line between every door\'s two room centres, skipping malformed doors', () => {
    const { doors } = computeMinimapLayout(ARENA, { w: 100, h: 100 });
    expect(doors).toHaveLength(2);
    // A's centre (2.5,2.5) — B's centre (52.5,2.5) at this scale.
    expect(doors[0]).toEqual({ x1: 2.5, y1: 2.5, x2: 52.5, y2: 2.5 });

    const withBadDoor: ArenaMap = { ...ARENA, doors: [...ARENA.doors, { roomA: 'A', roomB: 'ghost', passageGrid: { x: 0, y: 0, w: 1, h: 1 } }] };
    const { doors: doors2 } = computeMinimapLayout(withBadDoor, { w: 100, h: 100 });
    expect(doors2).toHaveLength(2); // the malformed door referencing 'ghost' is skipped, not thrown
  });

  it('collapses to zero-scale (not NaN/Infinity) for a degenerate zero-size map', () => {
    const degenerate: ArenaMap = { ...ARENA, sizeGrid: { w: 0, h: 0 } };
    const { rooms } = computeMinimapLayout(degenerate, { w: 100, h: 100 });
    expect(rooms.every((r) => Number.isFinite(r.x) && Number.isFinite(r.w))).toBe(true);
  });
});

describe('roomStatus', () => {
  const baseZone: ZoneState = { eye: 'A', stage: 1, phase: 'hold', ticksToPhaseEnd: 100, safe: ['A'], closing: [], escalation: 0 };

  it('is "safe" when no zone has been drawn yet (pre-match / non-arena)', () => {
    expect(roomStatus(undefined, 'A')).toBe('safe');
  });

  it('is "safe" when the room is in the current safe set', () => {
    expect(roomStatus(baseZone, 'A')).toBe('safe');
  });

  it('is "danger" when outside the safe set and not currently closing', () => {
    expect(roomStatus(baseZone, 'B')).toBe('danger');
  });

  it('is "closing" only during the warn phase, for rooms in `closing`', () => {
    const warning: ZoneState = { ...baseZone, phase: 'warn', closing: ['B'] };
    expect(roomStatus(warning, 'B')).toBe('closing');
    expect(roomStatus(warning, 'A')).toBe('safe');
    // The same `closing` list during 'hold' (already resolved) no longer marks a warn.
    const held: ZoneState = { ...warning, phase: 'hold', safe: ['A'] };
    expect(roomStatus(held, 'B')).toBe('danger');
  });
});

/** Minimal, well-typed `PlacedRoom` fixture — only the fields `dungeonToArenaMap`
 * actually reads. `entranceGrid` is irrelevant here (force-regroup only). */
function placedRoom(id: string, offsetXGrid: number, offsetYGrid: number, w = 20, h = 16): PlacedRoom {
  return {
    id,
    piece: { id, sizeGrid: { w, h }, solids: [{ x: 0, y: 0, w: 1, h: 1 }], spawns: { player: [], enemy: [] }, exits: [] },
    offsetXGrid,
    offsetYGrid,
    entranceGrid: { x: 0, y: 0 },
  };
}

/** `passageAabb` is never read by `dungeonToArenaMap` (only `dr.door` is) — still a
 * real, correctly-converted `AABB` rather than a throwaway cast, matching how
 * `SpawnSystem` itself builds a `DoorRuntime` (`toFpAabbGrid`). */
function doorRuntime(door: Door, locked = false): DoorRuntime {
  const g = door.passageGrid;
  return { door, passageAabb: { x: toFpGrid(g.x), y: toFpGrid(g.y), w: toFpGrid(g.w), h: toFpGrid(g.h) }, locked };
}

describe('dungeonToArenaMap (design/05 "fully-realized branching" follow-up, 2026-08-05)', () => {
  it('converts placed rooms + doors into a matching ArenaMap, doors passed through unchanged', () => {
    const hub = placedRoom('hub#0', 0, 0, 20, 16);
    const merge = placedRoom('merge#1', 20, 0, 14, 16);
    const door: Door = { roomA: hub.id, roomB: merge.id, passageGrid: { x: 19, y: 6, w: 2, h: 4 } };
    const map = dungeonToArenaMap([hub, merge], [doorRuntime(door)]);

    expect(map.rooms).toEqual([
      { id: 'hub#0', rectGrid: { x: 0, y: 0, w: 20, h: 16 }, solids: hub.piece.solids },
      { id: 'merge#1', rectGrid: { x: 20, y: 0, w: 14, h: 16 }, solids: merge.piece.solids },
    ]);
    expect(map.doors).toEqual([door]);
    expect(map.sizeGrid).toEqual({ w: 34, h: 16 });
  });

  it('normalizes negative offsetY from a fork\'s stacked siblings so every rect stays within [0,sizeGrid]', () => {
    // Mirrors world/dungeon.ts placeFloor's own fork stacking: siblings centered on
    // the hub's vertical center land with a negative offsetYGrid.
    const hub = placedRoom('hub#0', 0, 0, 14, 30);
    const sibA = placedRoom('sib_a#1', 14, -6, 20, 10);
    const sibB = placedRoom('sib_b#1', 14, 16, 20, 10);
    const map = dungeonToArenaMap([hub, sibA, sibB], []);

    // minY = -6 → every room shifted +6; nothing left negative.
    expect(map.rooms.every((r) => r.rectGrid.y >= 0)).toBe(true);
    const hubOut = map.rooms.find((r) => r.id === 'hub#0')!;
    const sibAOut = map.rooms.find((r) => r.id === 'sib_a#1')!;
    const sibBOut = map.rooms.find((r) => r.id === 'sib_b#1')!;
    expect(hubOut.rectGrid.y).toBe(6); // 0 - (-6)
    expect(sibAOut.rectGrid.y).toBe(0); // -6 - (-6)
    expect(sibBOut.rectGrid.y).toBe(22); // 16 - (-6)
    // sizeGrid spans the normalized extent: maxY is the hub's own bottom (0+30=30,
    // taller than either sibling's own bottom) - minY (-6) = 36.
    expect(map.sizeGrid).toEqual({ w: 34, h: 36 });
  });

  it('returns an empty ArenaMap-shaped map for an empty floor, no crash', () => {
    const map = dungeonToArenaMap([], []);
    expect(map).toEqual({ id: 'dungeon', sizeGrid: { w: 0, h: 0 }, rooms: [], doors: [], spawns: [], eyeCandidates: [] });
  });

  it('normalizes negative offsetX symmetrically to Y, even though placeFloor never actually produces one today', () => {
    // The spine's own cursorXGrid only ever increases (world/dungeon.ts placeFloor),
    // so no real floor has a negative offsetXGrid yet — but this function has no such
    // assumption baked in, and shouldn't silently mis-normalize if that ever changes.
    const a = placedRoom('a#0', -10, 0, 10, 10);
    const b = placedRoom('b#1', 0, 0, 10, 10);
    const map = dungeonToArenaMap([a, b], []);
    expect(map.rooms.every((r) => r.rectGrid.x >= 0)).toBe(true);
    expect(map.rooms.find((r) => r.id === 'a#0')!.rectGrid.x).toBe(0); // -10 - (-10)
    expect(map.rooms.find((r) => r.id === 'b#1')!.rectGrid.x).toBe(10); // 0 - (-10)
    expect(map.sizeGrid.w).toBe(20);
  });

  it('carries every one of a room\'s solids through unchanged, not just the first', () => {
    const hub: PlacedRoom = {
      id: 'hub#0',
      piece: {
        id: 'hub', sizeGrid: { w: 20, h: 16 },
        solids: [{ x: 0, y: 0, w: 1, h: 16 }, { x: 19, y: 0, w: 1, h: 16 }, { x: 0, y: 0, w: 20, h: 1 }],
        spawns: { player: [], enemy: [] }, exits: [],
      },
      offsetXGrid: 0, offsetYGrid: 0, entranceGrid: { x: 0, y: 0 },
    };
    const map = dungeonToArenaMap([hub], []);
    expect(map.rooms[0]!.solids).toEqual(hub.piece.solids);
    expect(map.rooms[0]!.solids).toHaveLength(3);
  });

  it('converts a floor with rooms but no doors yet (a fresh single-room floor)', () => {
    const hub = placedRoom('hub#0', 0, 0, 20, 16);
    const map = dungeonToArenaMap([hub], []);
    expect(map.rooms).toHaveLength(1);
    expect(map.doors).toEqual([]);
  });
});

describe('dungeonRoomStatus (design/05 "fully-realized branching" follow-up, 2026-08-05)', () => {
  const runtime = (activated: boolean, hasLiveEnemy: boolean): DungeonRoomRuntime => ({
    activated, roomTick: 0, schedule: [], cursor: 0, hasLiveEnemy,
  });

  it('is "unvisited" when the room has never activated', () => {
    const runtimes = [runtime(false, false)];
    const indexById = new Map([['a', 0]]);
    expect(dungeonRoomStatus(runtimes, indexById, 'a')).toBe('unvisited');
  });

  it('is "safe" when activated and cleared', () => {
    const runtimes = [runtime(true, false)];
    const indexById = new Map([['a', 0]]);
    expect(dungeonRoomStatus(runtimes, indexById, 'a')).toBe('safe');
  });

  it('is "danger" when activated and has a live enemy — the same signal DoorSystem locks doors on', () => {
    const runtimes = [runtime(true, true)];
    const indexById = new Map([['a', 0]]);
    expect(dungeonRoomStatus(runtimes, indexById, 'a')).toBe('danger');
  });

  it('is "unvisited" for an unknown roomId — a content bug, not a crash', () => {
    const runtimes = [runtime(true, true)];
    const indexById = new Map([['a', 0]]);
    expect(dungeonRoomStatus(runtimes, indexById, 'ghost')).toBe('unvisited');
  });

  it('is "unvisited" when the index map points past the end of a (stale) runtimes array — never a crash', () => {
    // A malformed/stale combination — indexById pointing at an index the runtimes
    // array no longer has (e.g. a leftover map from a previous floor) — should read
    // the same as "never activated," not throw on an out-of-bounds array read.
    const runtimes: DungeonRoomRuntime[] = [];
    const indexById = new Map([['a', 2]]);
    expect(dungeonRoomStatus(runtimes, indexById, 'a')).toBe('unvisited');
  });
});
