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
  GUIDE_TURN_TAU_MS,
  GUIDE_FOE_FADE_PX,
  GUIDE_FOE_NEAR_PX,
  GUIDE_HIDE_PX,
  GuideClock,
  nextRoomGuide,
  type GuideTarget,
} from './nextRoomGuide';
import { fpToPx } from '../coords';
import { PORTAL_PROMPT_RADIUS_PX } from '../controllers/checkpointOverlays';

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
    expect(arrowPose(near, player, late, 'foe').visible).toBe(false);
    expect(arrowPose(near, player, late, 'door').visible).toBe(true);
  });

  it('fades in over the band beyond the line, rather than blinking at it', () => {
    const mid = arrowPose({ x: GUIDE_FOE_NEAR_PX + GUIDE_FOE_FADE_PX / 2, y: 0 }, player, late, 'foe');
    expect(mid.visible).toBe(true);
    expect(mid.alpha).toBeCloseTo(0.5);
    expect(arrowPose({ x: GUIDE_FOE_NEAR_PX + GUIDE_FOE_FADE_PX, y: 0 }, player, late, 'foe').alpha).toBe(1);
  });
});

describe('the portal target (2026-11-07, the first-run report)', () => {
  /** The floor as a dungeon: what makes `checkpointReached` read the capstone's runtime. */
  const dungeon = (roles?: (string | undefined)[]) => {
    const s = floor(roles);
    (s as { dungeonEnabled: boolean }).dungeonEnabled = true;
    return s;
  };

  it('points at the portal, the capstone room centre, once the capstone is done', () => {
    const s = dungeon();
    done(s, 'A');
    done(s, 'B');
    done(s, 'C');
    expect(nextRoomGuide(s, 'C')).toEqual({ kind: 'portal', x: px(29), y: px(5) });
  });

  it('wins over a side room nobody has entered: the portal is the goal', () => {
    const s = dungeon();
    done(s, 'B');
    done(s, 'C'); // A never entered
    expect(nextRoomGuide(s, 'C')?.kind).toBe('portal');
    expect(doorOf(nextRoomGuide(s, 'B'))).toBe(0); // outside the capstone, the old rule
  });

  it('says nothing about the portal before the checkpoint, or outside a dungeon', () => {
    const s = dungeon();
    done(s, 'A');
    done(s, 'B');
    fighting(s, 'C', [{ id: 9, x: 30, y: 5 }]);
    expect(nextRoomGuide(s, 'C')).toBeNull(); // no `from`: a fight with nowhere to measure from
    expect(nextRoomGuide(s, 'C', { gx: fp(25), gy: fp(5) })?.kind).toBe('foe');
    const flat = floor();
    done(flat, 'A');
    done(flat, 'B');
    done(flat, 'C');
    expect(nextRoomGuide(flat, 'C')).toBeNull(); // not a dungeon run: `checkpointReached` is the waves rule
  });

  it('steps aside where the portal panels open, not at a door distance', () => {
    expect(GUIDE_HIDE_PX.portal).toBe(PORTAL_PROMPT_RADIUS_PX);
    const player = { x: 0, y: 0 };
    expect(arrowPose({ x: PORTAL_PROMPT_RADIUS_PX, y: 0 }, player, 5000, 'portal').visible).toBe(false);
    expect(arrowPose({ x: PORTAL_PROMPT_RADIUS_PX + 1, y: 0 }, player, 5000, 'portal').visible).toBe(true);
    expect(arrowPose({ x: PORTAL_PROMPT_RADIUS_PX + 1, y: 0 }, player, 5000, 'portal').alpha).toBe(1);
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
    expect(c.pose(0, at).visible).toBe(true);
    expect(c.pose(2000, at).rotation).toBeCloseTo(Math.PI / 2); // turned there, not restarted
  });

  it('keeps its clock from a door to a foe: through a doorway into the next fight (2026-11-07)', () => {
    const c = new GuideClock();
    c.set(t);
    c.pose(GUIDE_DELAY_MS, at);
    c.set({ kind: 'foe', id: 1, x: 0, y: 400 });
    expect(c.kind).toBe('foe');
    expect(c.pose(0, at).visible).toBe(true);
  });

  it('restarts it from a foe to the portal, like a door', () => {
    const c = new GuideClock();
    c.set({ kind: 'foe', id: 1, x: 400, y: 0 });
    c.pose(GUIDE_DELAY_MS, at);
    c.set({ kind: 'portal', x: 400, y: 0 });
    expect(c.pose(GUIDE_DELAY_MS - 1, at).visible).toBe(false);
    expect(c.pose(1, at).visible).toBe(true);
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
    expect(c.pose(2000, at, () => null).rotation).toBeCloseTo(0);
    expect(c.pose(2000, at).rotation).toBeCloseTo(0);
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

  // 2026-11-06: the foe arrow flipped round the body in one frame as the player crossed between
  // the entry room's two mobs (a 32 px jump of the chevron, measured in the live game).
  describe('the aim eases to a new bearing', () => {
    const east = { kind: 'foe', id: 1, x: 400, y: 0 } as const;
    const south = { kind: 'foe', id: 2, x: 0, y: 400 } as const;

    it('appears already pointing at its target', () => {
      const c = new GuideClock();
      c.set(south);
      expect(c.pose(GUIDE_DELAY_MS, at).rotation).toBeCloseTo(Math.PI / 2);
    });

    it('turns by an exponential ease, not in one frame', () => {
      const c = new GuideClock();
      c.set(east);
      c.pose(GUIDE_DELAY_MS, at);
      c.set(south);
      const step = c.pose(16, at);
      expect(step.rotation).toBeCloseTo((Math.PI / 2) * (1 - Math.exp(-16 / GUIDE_TURN_TAU_MS)), 6);
      expect(Math.hypot(step.x, step.y)).toBeCloseTo(GUIDE_ORBIT_PX, -1); // still on the orbit
      expect(c.pose(1000, at).rotation).toBeCloseTo(Math.PI / 2, 3);
    });

    it('turns the short way across ±π', () => {
      const c = new GuideClock();
      c.set({ kind: 'foe', id: 1, x: -400, y: -10 }); // just above west: bearing ≈ -π
      c.pose(GUIDE_DELAY_MS, at);
      c.set({ kind: 'foe', id: 2, x: -400, y: 10 }); // just below west: bearing ≈ +π
      const r = c.pose(16, at).rotation;
      expect(Math.abs(Math.cos(r) + 1)).toBeLessThan(0.01); // still pointing west, no spin through east
    });

    it('forgets the bearing while hidden, so it reappears pointing straight', () => {
      const c = new GuideClock();
      c.set(east);
      c.pose(GUIDE_DELAY_MS, at);
      c.pose(0, null); // no drawn player this frame: hidden
      c.set(south);
      expect(c.pose(0, at).rotation).toBeCloseTo(Math.PI / 2);
      c.clear();
      c.set(east);
      expect(c.pose(GUIDE_DELAY_MS, at).rotation).toBeCloseTo(0);
    });
  });
});
