/**
 * `nextRoomGuide` / `arrowPose` / `GuideClock` (2026-11-06): the door a done room points at.
 *
 * The floor is three rooms in a row, A → B → C, with C the extraction room:
 *
 *   A (0..10) -door x10..12- B (12..22) -door x22..24- C (24..34), all y 0..10, doors y4..6
 */
import { describe, it, expect } from 'vitest';
import { createGameState, FP_SCALE, type AABB, type GameState, type RoomRect } from '@dd/engine';
import type { DungeonRoomRuntime } from '@dd/engine/state/GameState';
import {
  arrowPose,
  exitRoomId,
  GUIDE_ARRIVE_PX,
  GUIDE_DELAY_MS,
  GUIDE_ORBIT_PX,
  GuideClock,
  nextRoomGuide,
} from './nextRoomGuide';
import { fpToPx } from '../coords';

const fp = (grid: number) => grid * FP_SCALE;
const rect = (x: number, y: number, w: number, h: number) => ({ x: fp(x), y: fp(y), w: fp(w), h: fp(h) }) as AABB;
const px = (grid: number) => fpToPx(fp(grid) as never);

function runtime(over: Partial<DungeonRoomRuntime> = {}): DungeonRoomRuntime {
  return { activated: false, roomTick: 0, schedule: [], cursor: 0, hasLiveEnemy: false, ...over };
}

function floor(roles: (string | undefined)[] = [undefined, undefined, 'extraction']): GameState {
  const s = createGameState({ seed: 1, worldW: 1200, worldH: 400, waves: [] });
  ['A', 'B', 'C'].forEach((id, i) => {
    s.dungeonRoomRects.push({ id, rect: rect(i * 12, 0, 10, 10) } as RoomRect);
    s.dungeonRooms.push({ id, piece: { role: roles[i] } } as never);
    s.dungeonRoomRuntime.push(runtime());
    s.dungeonRoomIndexById.set(id, i);
  });
  const door = (roomA: string, roomB: string, x: number) =>
    ({ door: { roomA, roomB, passageGrid: { x, y: 4, w: 2, h: 2 } }, passageAabb: rect(x, 4, 2, 2), locked: false }) as never;
  s.dungeonDoors.push(door('A', 'B', 10), door('B', 'C', 22));
  return s;
}

/** Mark `id` entered and finished: every scheduled wave out, nothing alive. */
function done(s: GameState, id: string): void {
  s.dungeonRoomRuntime[s.dungeonRoomIndexById.get(id)!] = runtime({
    activated: true,
    schedule: [{ atTick: 0, spawnPoint: 0 }],
    cursor: 1,
  });
}

describe('nextRoomGuide', () => {
  it('says nothing outside a dungeon', () => {
    const s = createGameState({ seed: 1, worldW: 400, worldH: 400, waves: [] });
    expect(nextRoomGuide(s, 'A')).toBeNull();
  });

  it('holds (undefined) in a doorway, where no room claims the player', () => {
    const s = floor();
    done(s, 'A');
    expect(nextRoomGuide(s, undefined)).toBeUndefined();
  });

  it('points at the centre of the door into the next unentered room once the room is done', () => {
    const s = floor();
    done(s, 'A');
    expect(nextRoomGuide(s, 'A')).toEqual({ door: 0, x: px(11), y: px(5) });
  });

  it.each<[string, Partial<DungeonRoomRuntime>]>([
    ['not entered yet', { activated: false }],
    ['still has a live enemy', { activated: true, hasLiveEnemy: true }],
    [
      'between two waves',
      { activated: true, schedule: [{ atTick: 0, spawnPoint: 0 }, { atTick: 99, spawnPoint: 0 }], cursor: 1 },
    ],
  ])('says nothing in a room that is %s', (_, rt) => {
    const s = floor();
    s.dungeonRoomRuntime[0] = runtime(rt);
    expect(nextRoomGuide(s, 'A')).toBeNull();
  });

  it('says nothing for a room id the floor does not know', () => {
    expect(nextRoomGuide(floor(), 'Z')).toBeNull();
  });

  it('routes through entered rooms toward the nearest unentered one', () => {
    const s = floor();
    done(s, 'A');
    done(s, 'B');
    // From A, C is the only unentered room; the first step is still the A–B door.
    expect(nextRoomGuide(s, 'A')?.door).toBe(0);
    expect(nextRoomGuide(s, 'B')?.door).toBe(1);
  });

  it('with every room entered, heads for the extraction room — and stops there', () => {
    const s = floor(['extraction', undefined, undefined]);
    done(s, 'A');
    done(s, 'B');
    done(s, 'C');
    expect(nextRoomGuide(s, 'C')?.door).toBe(1); // back toward A, the extraction room
    expect(nextRoomGuide(s, 'A')).toBeNull(); // already there: the floor ends here
  });

  it('never routes through a locked door, and re-reads the doors when a lock changes', () => {
    const s = floor();
    done(s, 'A');
    (s.dungeonDoors[0] as { locked: boolean }).locked = true;
    expect(nextRoomGuide(s, 'A')).toBeNull();
    (s.dungeonDoors[0] as { locked: boolean }).locked = false;
    expect(nextRoomGuide(s, 'A')?.door).toBe(0);
  });
});

describe('exitRoomId', () => {
  it('is the extraction room, else the last placed room, else nothing', () => {
    expect(exitRoomId(floor(['extraction', undefined, undefined]))).toBe('A');
    expect(exitRoomId(floor([undefined, undefined, undefined]))).toBe('C');
    expect(exitRoomId(createGameState({ seed: 1, worldW: 400, worldH: 400, waves: [] }))).toBeUndefined();
  });
});

describe('arrowPose', () => {
  const player = { x: 0, y: 0 };
  const east = { x: 400, y: 0 };

  it('is hidden with no target, no player, or before the delay', () => {
    expect(arrowPose(null, player, 5000).visible).toBe(false);
    expect(arrowPose(east, null, 5000).visible).toBe(false);
    expect(arrowPose(east, player, GUIDE_DELAY_MS - 1).visible).toBe(false);
  });

  it('is hidden once the player has reached the door', () => {
    expect(arrowPose({ x: GUIDE_ARRIVE_PX, y: 0 }, player, 5000).visible).toBe(false);
    expect(arrowPose({ x: GUIDE_ARRIVE_PX + 1, y: 0 }, player, 5000).visible).toBe(true);
  });

  it('rides the orbit toward the door, pointing at it, fading in', () => {
    expect(arrowPose(east, player, GUIDE_DELAY_MS)).toEqual({
      visible: true,
      x: GUIDE_ORBIT_PX,
      y: 0,
      rotation: 0,
      alpha: 0,
    });
    const south = arrowPose({ x: 0, y: 400 }, player, GUIDE_DELAY_MS + 10_000);
    expect(south.rotation).toBeCloseTo(Math.PI / 2);
    expect(south.x).toBeCloseTo(0);
    expect(Math.abs(south.y - GUIDE_ORBIT_PX)).toBeLessThanOrEqual(5);
    expect(south.alpha).toBe(1);
  });
});

describe('GuideClock', () => {
  const t = { door: 0, x: 400, y: 0 };
  const at = { x: 0, y: 0 };

  it('shows the arrow only after the target has been held for the delay', () => {
    const c = new GuideClock();
    c.set(t);
    expect(c.pose(GUIDE_DELAY_MS - 1, at).visible).toBe(false);
    expect(c.pose(1, at).visible).toBe(true);
  });

  it('keeps its clock through a doorway (undefined) and a switch of door', () => {
    const c = new GuideClock();
    c.set(t);
    c.pose(GUIDE_DELAY_MS, at);
    c.set(undefined);
    c.set({ door: 1, x: 0, y: 400 });
    const p = c.pose(0, at);
    expect(p.visible).toBe(true);
    expect(p.rotation).toBeCloseTo(Math.PI / 2);
  });

  it('restarts the delay when the target is lost, and on clear()', () => {
    const c = new GuideClock();
    c.set(t);
    c.pose(GUIDE_DELAY_MS, at);
    c.set(null);
    expect(c.pose(GUIDE_DELAY_MS, at).visible).toBe(false); // no target: the clock does not run
    c.set(t);
    expect(c.pose(GUIDE_DELAY_MS - 1, at).visible).toBe(false);
    c.clear();
    c.set(t);
    expect(c.pose(GUIDE_DELAY_MS - 1, at).visible).toBe(false);
  });
});
