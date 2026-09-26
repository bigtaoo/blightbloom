/**
 * zoneRetreat — the PvP bot leaving the closing zone (design/15, 2026-09-26). A three-room
 * corridor A | B | C, so "nearest safe room", "one hop vs two" and "the gate vs the room
 * centre" each have a single right answer the command's heading can be read against.
 */
import { describe, it, expect } from 'vitest';
import { Button, FP_SCALE, type GameState, type ZoneState } from '@dd/engine';
import type { ArenaMap } from '@dd/engine/content/arenas';
import { BRAD_FULL } from '@dd/engine/math/trig';
import { FIRE_RANGE_FP } from './engage';
import { roomIsUnsafe, zoneRetreatCommand } from './zoneRetreat';

const MAP: ArenaMap = {
  id: 'corridor_test',
  sizeGrid: { w: 30, h: 10 },
  rooms: [
    { id: 'A', rectGrid: { x: 0, y: 0, w: 10, h: 10 }, solids: [] },
    { id: 'B', rectGrid: { x: 10, y: 0, w: 10, h: 10 }, solids: [] },
    { id: 'C', rectGrid: { x: 20, y: 0, w: 10, h: 10 }, solids: [] },
  ],
  doors: [
    { roomA: 'A', roomB: 'B', passageGrid: { x: 10, y: 4, w: 1, h: 2 } },
    { roomA: 'B', roomB: 'C', passageGrid: { x: 20, y: 4, w: 1, h: 2 } },
  ],
  spawns: [{ x: 5, y: 5 }],
  eyeCandidates: [{ roomId: 'A' }],
};

function state(zone: Partial<ZoneState> | undefined, map: ArenaMap = MAP): GameState {
  const z = zone && { eye: 'A', stage: 1, phase: 'hold', ticksToPhaseEnd: 100, safe: [], closing: [], escalation: 0, ...zone };
  return { zone: z, arenaMap: map } as unknown as GameState;
}

const at = (gx: number, gy: number, roomId?: string) => ({ gx: gx * FP_SCALE, gy: gy * FP_SCALE, roomId });

/** The command's heading as a unit vector (y grows downward, as in the sim). */
function heading(moveBrad: number): { x: number; y: number } {
  const a = (moveBrad / BRAD_FULL) * Math.PI * 2;
  return { x: Math.cos(a), y: Math.sin(a) };
}

describe('zoneRetreatCommand — when it stays out of the way', () => {
  it('returns null with no zone, no arena map, or no known room', () => {
    expect(zoneRetreatCommand(state(undefined), 0, 1, at(25, 5, 'C'), [])).toBeNull();
    const noMap = { ...state({ safe: ['A'] }), arenaMap: undefined } as GameState;
    expect(zoneRetreatCommand(noMap, 0, 1, at(25, 5, 'C'), [])).toBeNull();
    expect(zoneRetreatCommand(state({ safe: ['A'] }), 0, 1, at(25, 5), [])).toBeNull();
  });

  it('returns null in a room that is safe and not closing', () => {
    expect(zoneRetreatCommand(state({ safe: ['A', 'B', 'C'] }), 0, 1, at(25, 5, 'C'), [])).toBeNull();
  });

  it('returns null when nothing is safe, or no door leads anywhere safe', () => {
    expect(zoneRetreatCommand(state({ safe: [] }), 0, 1, at(25, 5, 'C'), [])).toBeNull();
    const islands = { ...MAP, doors: [MAP.doors[1]!] }; // A cut off from B and C
    expect(zoneRetreatCommand(state({ safe: ['A'] }, islands), 0, 1, at(25, 5, 'C'), [])).toBeNull();
  });
});

describe('zoneRetreatCommand — walking out', () => {
  it('heads for the passage into the nearest safe room', () => {
    const cmd = zoneRetreatCommand(state({ safe: ['A', 'B'] }), 0, 1, at(25, 5, 'C'), [])!;
    expect(cmd.moveMag).toBeGreaterThan(0);
    expect(heading(cmd.moveBrad).x).toBeLessThan(-0.99); // due west to the C|B gate at (20.5, 5)
  });

  it("aims at the gate first, then — once within a grid of it — at the next room's centre", () => {
    // Two hops out (only A is safe), so the next room is B, centre (15, 5).
    const s = state({ safe: ['A'] });
    const far = zoneRetreatCommand(s, 0, 1, at(20.5, 8, 'C'), [])!;
    expect(heading(far.moveBrad).y).toBeLessThan(-0.99); // straight up to the gate at (20.5, 5)
    const near = zoneRetreatCommand(s, 0, 1, at(20.5, 5.9, 'C'), [])!;
    expect(heading(near.moveBrad).x).toBeLessThan(-0.9); // past the gate, on toward B's centre
  });

  it('during a WARN, leaves a room that is still safe but about to close', () => {
    const s = state({ phase: 'warn', safe: ['A', 'B'], closing: ['B'] });
    const cmd = zoneRetreatCommand(s, 0, 1, at(15, 5, 'B'), [])!;
    expect(cmd).not.toBeNull();
    expect(heading(cmd.moveBrad).x).toBeLessThan(-0.99); // west into A
    // `closing` outside a WARN is stale data and is ignored.
    expect(zoneRetreatCommand(state({ phase: 'hold', safe: ['A', 'B'], closing: ['B'] }), 0, 1, at(15, 5, 'B'), [])).toBeNull();
  });

  it('fires on the way out only at an opponent inside fire range', () => {
    const s = state({ safe: ['A', 'B'] });
    const me = at(25, 5, 'C');
    const inRange = { gx: me.gx, gy: me.gy + FIRE_RANGE_FP };
    const outOfRange = { gx: me.gx, gy: me.gy + FIRE_RANGE_FP + 1 };
    expect(zoneRetreatCommand(s, 3, 7, me, [inRange])!.buttons & Button.FIRE).toBe(Button.FIRE);
    expect(zoneRetreatCommand(s, 3, 7, me, [outOfRange])!.buttons).toBe(0);
    const cmd = zoneRetreatCommand(s, 3, 7, me, [])!;
    expect(cmd.owner).toBe(3);
    expect(cmd.tick).toBe(7);
  });
});

describe('roomIsUnsafe', () => {
  it('is false with no zone or no room, true outside the safe set, and true for a closing room in a WARN', () => {
    expect(roomIsUnsafe(state(undefined), 'C')).toBe(false);
    expect(roomIsUnsafe(state({ safe: ['A'] }), undefined)).toBe(false);
    expect(roomIsUnsafe(state({ safe: ['A'] }), 'C')).toBe(true);
    expect(roomIsUnsafe(state({ safe: ['A', 'C'] }), 'C')).toBe(false);
    expect(roomIsUnsafe(state({ phase: 'warn', safe: ['A', 'C'], closing: ['C'] }), 'C')).toBe(true);
    expect(roomIsUnsafe(state({ phase: 'hold', safe: ['A', 'C'], closing: ['C'] }), 'C')).toBe(false);
  });
});
