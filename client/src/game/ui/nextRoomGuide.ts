// Where to go once a room is cleared (2026-11-06, the "a room is done and nobody knows what to do
// next" report from the Playgama sandbox): the door to head for, and how the arrow pointing at it
// is posed. Pure functions of the state and a position; the drawn half is `scene/NextRoomArrow.ts`.
//
// The rule, in the order a player meets it:
//  - Only in a room that is DONE: entered, every wave of its schedule spawned, nothing alive. A
//    lull between two waves is not done (the schedule has more to send), and a room still being
//    fought owns the player's attention outright.
//  - Toward the nearest room nobody has entered yet, through open doors only, on the shortest door
//    path (`ai/roomRoute.ts`, the same breadth-first search the co-op ally walks).
//  - With every room entered, toward the floor's exit — its extraction room, else its last placed
//    room, the same reading the minimap's exit marker uses (`minimapLayout.dungeonRoomMarkers`).
//  - Otherwise nothing: the player is where the floor ends.
import { FP_SCALE, type GameState } from '@dd/engine';
import type { RoomId } from '@dd/engine/content/arenas';
import { fpToPx } from '../coords';
import { nextRoomToward, type RouteMap } from '../controllers/ai/roomRoute';

/** The door to walk through next: its index in `state.dungeonDoors`, and its centre in world px. */
export interface GuideTarget {
  door: number;
  x: number;
  y: number;
}

const maps = new WeakMap<GameState, { stamp: string; map: RouteMap }>();

/** This floor's OPEN doors as a `RouteMap`, rebuilt when a descend or a lock changes them. */
function openMap(s: GameState): RouteMap {
  let stamp = `${s.floorIndex}:${s.dungeonRoomRects.length}:`;
  for (const d of s.dungeonDoors) stamp += d.locked ? '1' : '0';
  const memo = maps.get(s);
  if (memo && memo.stamp === stamp) return memo.map;
  const map: RouteMap = {
    doors: s.dungeonDoors.filter((d) => !d.locked).map((d) => d.door),
    rooms: s.dungeonRoomRects.map((r) => ({
      id: r.id,
      rectGrid: { x: r.rect.x / FP_SCALE, y: r.rect.y / FP_SCALE, w: r.rect.w / FP_SCALE, h: r.rect.h / FP_SCALE },
    })),
  };
  maps.set(s, { stamp, map });
  return map;
}

/** The floor's way out: its extraction room, else the last room placed. */
export function exitRoomId(s: GameState): RoomId | undefined {
  const rooms = s.dungeonRooms;
  return (rooms.find((r) => r.piece.role === 'extraction') ?? rooms[rooms.length - 1])?.id;
}

/**
 * The door the player in `roomId` should head for, `null` when there is none (not a dungeon, the
 * room is not done, nowhere left to go), and `undefined` when this frame cannot say — the player is
 * in a doorway, in no room's rect, and the arrow should hold what it showed a moment ago rather
 * than blink off and restart its delay.
 */
export function nextRoomGuide(s: GameState, roomId: RoomId | undefined): GuideTarget | null | undefined {
  if (s.dungeonRooms.length === 0) return null;
  if (roomId === undefined) return undefined;
  const idx = s.dungeonRoomIndexById.get(roomId);
  const rt = idx === undefined ? undefined : s.dungeonRoomRuntime[idx];
  if (!rt || !rt.activated || rt.hasLiveEnemy || rt.cursor < rt.schedule.length) return null;

  const map = openMap(s);
  const unentered = (id: RoomId): boolean => {
    const i = s.dungeonRoomIndexById.get(id);
    return i !== undefined && s.dungeonRoomRuntime[i]?.activated === false;
  };
  let step = nextRoomToward(map, roomId, unentered);
  if (step === undefined) {
    const exit = exitRoomId(s);
    if (exit !== undefined && exit !== roomId) step = nextRoomToward(map, roomId, (id) => id === exit);
  }
  if (step === undefined) return null;
  const door = s.dungeonDoors.findIndex(
    (d) => !d.locked && ((d.door.roomA === roomId && d.door.roomB === step) || (d.door.roomB === roomId && d.door.roomA === step)),
  );
  const a = s.dungeonDoors[door]!.passageAabb;
  return { door, x: fpToPx(a.x) + fpToPx(a.w) / 2, y: fpToPx(a.y) + fpToPx(a.h) / 2 };
}

/** How long a room has to have been done before the arrow appears, ms: long enough for the last
 *  kill's drops to land and be looked at, short enough that standing still is answered. */
export const GUIDE_DELAY_MS = 1200;
/** The arrow's fade-in after that delay, ms. */
const GUIDE_FADE_MS = 300;
/** How far from the player's centre the arrow rides, world px — outside a body's ~16 px radius
 *  and its weapon, close enough to read as the player's own. */
export const GUIDE_ORBIT_PX = 44;
/** Within this of the door's centre the player has found it, and the arrow steps aside. */
export const GUIDE_ARRIVE_PX = 72;
/** The pulse along the pointing direction: amplitude in px and period in ms. */
const GUIDE_PULSE_PX = 5;
const GUIDE_PULSE_MS = 900;

export interface ArrowPose {
  visible: boolean;
  x: number;
  y: number;
  /** Radians, 0 = pointing +x (screen right), y down. */
  rotation: number;
  alpha: number;
}

const HIDDEN: ArrowPose = { visible: false, x: 0, y: 0, rotation: 0, alpha: 0 };

/** Where the arrow sits this frame, given how long the current target has been shown (`age`, ms). */
export function arrowPose(
  target: { x: number; y: number } | null,
  player: { x: number; y: number } | null,
  age: number,
): ArrowPose {
  if (!target || !player || age < GUIDE_DELAY_MS) return HIDDEN;
  const dx = target.x - player.x;
  const dy = target.y - player.y;
  const d = Math.hypot(dx, dy);
  if (d <= GUIDE_ARRIVE_PX) return HIDDEN;
  const ux = dx / d;
  const uy = dy / d;
  const shown = age - GUIDE_DELAY_MS;
  const r = GUIDE_ORBIT_PX + GUIDE_PULSE_PX * Math.sin((shown / GUIDE_PULSE_MS) * Math.PI * 2);
  return {
    visible: true,
    x: player.x + ux * r,
    y: player.y + uy * r,
    rotation: Math.atan2(dy, dx),
    alpha: Math.min(1, shown / GUIDE_FADE_MS),
  };
}

/**
 * The arrow's clock: holds the target and how long it has been shown. A new target that is just a
 * different door of the same done room (the player walked past one exit toward another) keeps the
 * clock running; only losing the target — a fight, the floor's end — resets the delay.
 */
export class GuideClock {
  private target: GuideTarget | null = null;
  private age = 0;

  /** Feed one reconcile's verdict (`nextRoomGuide`). `undefined` holds the current target. */
  set(next: GuideTarget | null | undefined): void {
    if (next === undefined) return;
    if (next === null) {
      this.target = null;
      this.age = 0;
      return;
    }
    this.target = next;
  }

  /** Advance by `dt` ms and pose the arrow for a player drawn at `player`. */
  pose(dt: number, player: { x: number; y: number } | null): ArrowPose {
    if (this.target) this.age += dt;
    return arrowPose(this.target, player, this.age);
  }

  clear(): void {
    this.target = null;
    this.age = 0;
  }
}
