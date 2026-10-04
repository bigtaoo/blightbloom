/**
 * `walkTo` (2026-10-03): `roomRoute.ts`'s door-graph walk over a dungeon floor's placed rooms.
 * The floor here is three rooms in an L with no walls drawn, so a straight `steer` would cut the
 * corner: only the door route turns the walk east first.
 *
 *   A (0..10, 0..10) -door x10..12, y4..6- B (12..22, 0..10)
 *                                          |  door x16..18, y10..12
 *                                          C (12..22, 12..22)
 */
import { describe, it, expect } from 'vitest';
import { createGameState, FP_SCALE, type AABB, type GameState, type RoomRect } from '@dd/engine';
import { BRAD_FULL } from '@dd/engine/math/trig';
import { walkTo } from './dungeonRoute';

const fp = (grid: number) => grid * FP_SCALE;
const rect = (x: number, y: number, w: number, h: number) => ({ x: fp(x), y: fp(y), w: fp(w), h: fp(h) }) as AABB;

function floor(): GameState {
  const s = createGameState({ seed: 1, worldW: 800, worldH: 800, waves: [] });
  s.dungeonRoomRects.push(...([
    { id: 'A', rect: rect(0, 0, 10, 10) },
    { id: 'B', rect: rect(12, 0, 10, 10) },
    { id: 'C', rect: rect(12, 12, 10, 10) },
  ] as RoomRect[]));
  const door = (roomA: string, roomB: string, x: number, y: number, w: number, h: number) =>
    ({ door: { roomA, roomB, passageGrid: { x, y, w, h } }, passageAabb: rect(x, y, w, h), locked: false }) as never;
  s.dungeonDoors.push(door('A', 'B', 10, 4, 2, 2), door('B', 'C', 16, 10, 2, 2));
  return s;
}

/** The move's heading as a unit vector (+y is south). */
function heading(m: { moveBrad: number } | null): { x: number; y: number } {
  const a = (m!.moveBrad / BRAD_FULL) * 2 * Math.PI;
  return { x: Math.cos(a), y: Math.sin(a) };
}

describe('walkTo — a dungeon floor’s door graph', () => {
  const inA = { gx: fp(5), gy: fp(5) };
  const inC = { gx: fp(17), gy: fp(17) };

  it('walks to the door into the next room on the route, not straight at a goal rooms away', () => {
    const h = heading(walkTo(floor(), inA, inC));
    expect(h.x).toBeGreaterThan(0.95); // east, to the A–B door; straight at C is south-east
  });

  it('walks straight at a goal in its own room', () => {
    const h = heading(walkTo(floor(), inA, { gx: fp(5), gy: fp(9) }));
    expect(h.y).toBeGreaterThan(0.95);
  });

  it('steers straight from a doorway, which no room’s rect covers', () => {
    const h = heading(walkTo(floor(), { gx: fp(11), gy: fp(5) }, inC));
    // Straight at it: (6, 12) grid off, so (0.45, 0.89). The route would head east, into B.
    expect(h.x).toBeLessThan(0.6);
    expect(h.y).toBeGreaterThan(0.85);
  });

  it('rebuilds its map when a descend replaces the floor', () => {
    const s = floor();
    expect(heading(walkTo(s, inA, inC)).x).toBeGreaterThan(0.95);
    // The next floor: the same room ids, but A now opens straight onto C to its south-east.
    s.dungeonDoors.length = 0;
    s.dungeonDoors.push({ door: { roomA: 'A', roomB: 'C', passageGrid: { x: 10, y: 10, w: 2, h: 2 } }, passageAabb: rect(10, 10, 2, 2), locked: false } as never);
    s.floorIndex = 1;
    const h = heading(walkTo(s, inA, inC));
    expect(h.x).toBeGreaterThan(0.5);
    expect(h.y).toBeGreaterThan(0.5);
  });

  it('steers straight when no door path joins the two rooms', () => {
    const s = floor();
    s.dungeonDoors.length = 0; // A, B and C stand apart
    s.floorIndex = 2;
    const h = heading(walkTo(s, inA, inC));
    expect(h.x).toBeGreaterThan(0.5);
    expect(h.y).toBeGreaterThan(0.5); // straight at it, not east to a door that is gone
  });
});
