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
  GUIDE_FOE_FADE_PX,
  GUIDE_FOE_NEAR_PX,
  GuideClock,
  nextRoomGuide,
  type GuideTarget,
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

/** The door index of a door target, else undefined. */
const doorOf = (t: GuideTarget | null | undefined) => (t?.kind === 'door' ? t.door : undefined);

/** Mark `id` entered and still being fought, with enemies at the given grid points. */
function fighting(s: GameState, id: string, foes: { id: number; x: number; y: number; alive?: boolean; room?: string }[]): void {
  s.dungeonRoomRuntime[s.dungeonRoomIndexById.get(id)!] = runtime({ activated: true, hasLiveEnemy: true });
  for (const f of foes) {
    s.enemies.push({ id: f.id, gx: fp(f.x), gy: fp(f.y), alive: f.alive ?? true, roomId: f.room ?? id } as never);
  }
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
    expect(nextRoomGuide(s, 'A')).toEqual({ kind: 'door', door: 0, x: px(11), y: px(5) });
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
    expect(doorOf(nextRoomGuide(s, 'A'))).toBe(0);
    expect(doorOf(nextRoomGuide(s, 'B'))).toBe(1);
  });

  it('with every room entered, heads for the extraction room — and stops there', () => {
    const s = floor(['extraction', undefined, undefined]);
    done(s, 'A');
    done(s, 'B');
    done(s, 'C');
    expect(doorOf(nextRoomGuide(s, 'C'))).toBe(1); // back toward A, the extraction room
    expect(nextRoomGuide(s, 'A')).toBeNull(); // already there: the floor ends here
  });

  it('never routes through a locked door, and re-reads the doors when a lock changes', () => {
    const s = floor();
    done(s, 'A');
    (s.dungeonDoors[0] as { locked: boolean }).locked = true;
    expect(nextRoomGuide(s, 'A')).toBeNull();
    (s.dungeonDoors[0] as { locked: boolean }).locked = false;
    expect(doorOf(nextRoomGuide(s, 'A'))).toBe(0);
  });
});

describe('nextRoomGuide — while the room is fought', () => {
  const at = { gx: fp(1), gy: fp(5) };

  it('points at the nearest live enemy of the player’s own room', () => {
    const s = floor();
    fighting(s, 'A', [
      { id: 7, x: 9, y: 9 },
      { id: 8, x: 8, y: 5 }, // nearest
      { id: 9, x: 2, y: 5, alive: false }, // nearer, but dead
    ]);
    s.enemies.push({ id: 10, gx: fp(13), gy: fp(5), alive: true, roomId: 'B' } as never); // nearer than 7, other room
    expect(nextRoomGuide(s, 'A', at)).toEqual({ kind: 'foe', id: 8, x: px(8), y: px(5) });
  });

  it('says nothing without the player’s position, or with no live enemy found', () => {
    const s = floor();
    fighting(s, 'A', [{ id: 8, x: 8, y: 5 }]);
    expect(nextRoomGuide(s, 'A')).toBeNull();
    s.enemies[0]!.alive = false;
    expect(nextRoomGuide(s, 'A', at)).toBeNull();
  });

  it('a lull between waves still points nowhere, position or not', () => {
    const s = floor();
    s.dungeonRoomRuntime[0] = runtime({
      activated: true,
      schedule: [{ atTick: 0, spawnPoint: 0 }, { atTick: 99, spawnPoint: 0 }],
      cursor: 1,
    });
    expect(nextRoomGuide(s, 'A', at)).toBeNull();
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

describe('arrowPose — a foe target', () => {
  const player = { x: 0, y: 0 };
  const late = GUIDE_DELAY_MS + 10_000;

  it('is gone within the near line, where a door arrow would still show', () => {
    const near = { x: GUIDE_FOE_NEAR_PX, y: 0 };
    expect(arrowPose(near, player, late, true).visible).toBe(false);
    expect(arrowPose(near, player, late, false).visible).toBe(true);
  });

  it('fades in over the band beyond the line, rather than blinking at it', () => {
    const mid = arrowPose({ x: GUIDE_FOE_NEAR_PX + GUIDE_FOE_FADE_PX / 2, y: 0 }, player, late, true);
    expect(mid.visible).toBe(true);
    expect(mid.alpha).toBeCloseTo(0.5);
    expect(arrowPose({ x: GUIDE_FOE_NEAR_PX + GUIDE_FOE_FADE_PX, y: 0 }, player, late, true).alpha).toBe(1);
  });
});

describe('GuideClock', () => {
  const t = { kind: 'door', door: 0, x: 400, y: 0 } as const;
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
    c.set({ kind: 'door', door: 1, x: 0, y: 400 });
    const p = c.pose(0, at);
    expect(p.visible).toBe(true);
    expect(p.rotation).toBeCloseTo(Math.PI / 2);
  });

  it('keeps its clock from one foe to the next, restarts it from a foe to a door', () => {
    const c = new GuideClock();
    expect(c.kind).toBeNull();
    c.set({ kind: 'foe', id: 1, x: 400, y: 0 });
    c.pose(GUIDE_DELAY_MS, at);
    c.set({ kind: 'foe', id: 2, x: 0, y: 400 });
    expect(c.pose(0, at).visible).toBe(true);
    c.set(t);
    expect(c.kind).toBe('door');
    expect(c.pose(GUIDE_DELAY_MS - 1, at).visible).toBe(false);
    expect(c.pose(1, at).visible).toBe(true);
  });

  it('aims a foe arrow at the drawn position foeAt gives, falling back to the sim’s', () => {
    const c = new GuideClock();
    c.set({ kind: 'foe', id: 1, x: 400, y: 0 });
    const drawn = c.pose(GUIDE_DELAY_MS + 1000, at, (id) => (id === 1 ? { x: 0, y: 400 } : null));
    expect(drawn.rotation).toBeCloseTo(Math.PI / 2);
    expect(c.pose(0, at, () => null).rotation).toBeCloseTo(0);
    expect(c.pose(0, at).rotation).toBeCloseTo(0);
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
