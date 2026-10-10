import { describe, it, expect } from 'vitest';
import {
  planTorches,
  spaced,
  TORCH_MIN_STRETCH,
  TORCH_PASSAGE_CLEAR,
  TORCH_SIDE_NORTH_CLEAR,
  TORCH_SIDE_SOUTH_CLEAR,
  TORCH_SPACING,
  type TorchSpot,
} from './torchPlacement';
import type { RectPx } from './wallGeometry';
import type { WallRun } from './wallRuns';

/** A 640x480 room whose perimeter walls stand inside its own rect, the way rooms are authored. */
const ROOM: RectPx = { x: 0, y: 0, w: 640, h: 480 };
const NORTH: WallRun = { rect: { x: 0, y: 0, w: 640, h: 64 }, tier: 'perimeter' };
const WEST: WallRun = { rect: { x: 0, y: 0, w: 32, h: 480 }, tier: 'perimeter' };
const EAST: WallRun = { rect: { x: 608, y: 0, w: 32, h: 480 }, tier: 'perimeter' };
const SOUTH_KERB: WallRun = { rect: { x: 0, y: 448, w: 640, h: 32 }, tier: 'kerb' };

const sides = (spots: TorchSpot[], side: TorchSpot['side']) => spots.filter((s) => s.side === side);

describe('planTorches — a plain room', () => {
  const spots = planTorches([ROOM], [NORTH, WEST, EAST, SOUTH_KERB], []);

  it('spaces the north wall evenly between its corner clearances, on the wall foot', () => {
    // 56..584 is 528 px: two torches at the quarter points, symmetric about the middle.
    const north = sides(spots, 'north');
    expect(north.map((s) => s.x)).toEqual([188, 452]);
    expect(north.every((s) => s.y === 64 && s.sortY === 64)).toBe(true);
  });

  it("hangs a side torch on the wall's INNER edge, sorted with the wall it hangs on", () => {
    // 120..408 is 288 px: one torch, at its middle. A side wall is one entity sorted on its south
    // edge, so the torch takes that depth — sorted on its own y it would draw under the whole wall.
    expect(sides(spots, 'west')).toEqual([{ x: 32, y: 264, sortY: 480, side: 'west' }]);
    expect(sides(spots, 'east')).toEqual([{ x: 608, y: 264, sortY: 480, side: 'east' }]);
  });

  it('puts nothing on a kerb or an interior wall — only the enclosure carries torches', () => {
    expect(spots).toHaveLength(4);
    const interior: WallRun = { rect: { x: 0, y: 0, w: 640, h: 64 }, tier: 'interior' };
    expect(planTorches([ROOM], [interior, SOUTH_KERB], [])).toEqual([]);
  });

  it('keeps the side torches clear of the north wall and of the low south edge', () => {
    for (const s of [...sides(spots, 'west'), ...sides(spots, 'east')]) {
      expect(s.y).toBeGreaterThanOrEqual(ROOM.y + TORCH_SIDE_NORTH_CLEAR);
      expect(s.y).toBeLessThanOrEqual(ROOM.y + ROOM.h - TORCH_SIDE_SOUTH_CLEAR);
    }
  });
});

describe('planTorches — which wall belongs to which room', () => {
  it("gives a run merged across two rooms' north walls to BOTH rooms", () => {
    // `mergeWallRuns` joins neighbouring north walls into one run; crediting it to the room its
    // centre falls in left the other room's north wall bare (found live, 2026-10-10).
    const b: RectPx = { x: 640, y: 0, w: 640, h: 480 };
    const merged: WallRun = { rect: { x: 0, y: 0, w: 1280, h: 64 }, tier: 'perimeter' };
    expect(sides(planTorches([ROOM, b], [merged], []), 'north').map((s) => s.x)).toEqual([188, 452, 828, 1092]);
  });

  it('hangs a shared divider from both faces: the east wall of one room, the west of the next', () => {
    const b: RectPx = { x: 640, y: 0, w: 640, h: 480 };
    const divider: WallRun = { rect: { x: 608, y: 0, w: 64, h: 480 }, tier: 'perimeter' };
    const spots = planTorches([ROOM, b], [divider], []);
    expect(spots.map((s) => [s.side, s.x])).toEqual([
      ['east', 608],
      ['west', 672],
    ]);
  });

  it("ignores a wall that is not on this room's edge", () => {
    const midNorth: WallRun = { rect: { x: 0, y: 200, w: 640, h: 64 }, tier: 'perimeter' };
    const midSide: WallRun = { rect: { x: 300, y: 0, w: 32, h: 480 }, tier: 'perimeter' };
    const lowNorth: WallRun = { rect: { x: 0, y: 0, w: 640, h: 300 }, tier: 'perimeter' }; // ends past the middle
    const elsewhere: WallRun = { rect: { x: 2000, y: 0, w: 640, h: 64 }, tier: 'perimeter' };
    expect(planTorches([ROOM], [midNorth, midSide, lowNorth, elsewhere], [])).toEqual([]);
  });

  it('is deterministic from the plan alone — every client hangs the same torches', () => {
    const a = planTorches([ROOM], [NORTH, WEST, EAST], []);
    expect(planTorches([ROOM], [NORTH, WEST, EAST], [])).toEqual(a);
  });
});

describe('planTorches — passages', () => {
  it('clears a doorway in the north wall on both sides, and lights each stretch on its own', () => {
    const door: RectPx = { x: 288, y: 0, w: 64, h: 64 };
    const xs = sides(planTorches([ROOM], [NORTH], [door]), 'north').map((s) => s.x);
    // 56..248 and 392..584: one torch at the middle of each, mirrored about the door.
    expect(xs).toEqual([152, 488]);
    for (const x of xs) expect(Math.abs(x - 320)).toBeGreaterThanOrEqual(32 + TORCH_PASSAGE_CLEAR);
  });

  it('clears a doorway in a side wall, and drops a stretch too short to dress', () => {
    const door: RectPx = { x: 0, y: 200, w: 32, h: 64 };
    // 120..160 survives above the door (40 px, under the minimum) and 304..408 below it.
    expect(sides(planTorches([ROOM], [WEST], [door]), 'west').map((s) => s.y)).toEqual([356]);
  });

  it("ignores a passage that is not in this wall's line", () => {
    const farDoor: RectPx = { x: 288, y: 400, w: 64, h: 64 };
    expect(sides(planTorches([ROOM], [NORTH], [farDoor]), 'north').map((s) => s.x)).toEqual([188, 452]);
  });
});

describe('spaced', () => {
  it('fills a span at the spacing, symmetric about its middle', () => {
    expect(spaced(0, TORCH_SPACING * 3, [])).toEqual([TORCH_SPACING * 0.5, TORCH_SPACING * 1.5, TORCH_SPACING * 2.5]);
  });

  it('gives a stretch of at least the minimum one torch at its middle, and a shorter one none', () => {
    expect(spaced(100, 100 + TORCH_MIN_STRETCH, [])).toEqual([100 + TORCH_MIN_STRETCH / 2]);
    expect(spaced(100, 100 + TORCH_MIN_STRETCH - 1, [])).toEqual([]);
  });

  it('returns nothing for an empty or inverted span', () => {
    expect(spaced(10, 10, [])).toEqual([]);
    expect(spaced(10, 0, [])).toEqual([]);
  });

  it('cuts every blocked interval out, and ignores one that misses the span', () => {
    expect(spaced(0, 400, [[150, 250]])).toEqual([75, 325]);
    expect(spaced(0, 400, [[500, 600]])).toEqual(spaced(0, 400, []));
    expect(spaced(0, 400, [[-10, 410]])).toEqual([]);
  });
});
