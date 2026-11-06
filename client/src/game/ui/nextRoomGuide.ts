// Where to go once a room is cleared (2026-11-06, the "a room is done and nobody knows what to do
// next" report from the Playgama sandbox): the door to head for, and how the arrow pointing at it
// is posed. Pure functions of the state and a position; the drawn half is `scene/NextRoomArrow.ts`.
//
// The rule, in the order a player meets it:
//  - Only in a room that is DONE: entered, every wave of its schedule spawned, nothing alive. A
//    lull between two waves is not done (the schedule has more to send).
//  - While the room is still being FOUGHT, toward its nearest live enemy instead, in the enemy
//    colour (2026-11-06, the follow-up report "I spawn and there is nothing around me, no idea
//    what to do"). The entry room puts its two mobs ten grid from the spawn, off the edge of an
//    800 px portal frame, so a first-time player stood in an empty-looking room. `arrowPose`
//    fades this arrow out as that enemy comes within `GUIDE_FOE_NEAR_PX`: a foe on screen is its
//    own cue, and an arrow at it would only be clutter.
//  - Toward the nearest room nobody has entered yet, through open doors only, on the shortest door
//    path (`ai/roomRoute.ts`, the same breadth-first search the co-op ally walks).
//  - With every room entered, toward the floor's exit — its extraction room, else its last placed
//    room, the same reading the minimap's exit marker uses (`minimapLayout.dungeonRoomMarkers`).
//  - Otherwise nothing: the player is where the floor ends.
import { FP_SCALE, type GameState } from '@dd/engine';
import type { RoomId } from '@dd/engine/content/arenas';
import { fpToPx } from '../coords';
import { nextRoomToward, type RouteMap } from '../controllers/ai/roomRoute';

/** What the arrow points at, centre in world px: the door to walk through next (its index in
 *  `state.dungeonDoors`), or the nearest enemy still alive in the room (its entity id). */
export type GuideTarget =
  | { kind: 'door'; door: number; x: number; y: number }
  | { kind: 'foe'; id: number; x: number; y: number };

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
 * Where the player in `roomId`, standing at `from`, should head: the nearest live enemy while the
 * room is fought, the next door once it is done. `null` when there is nothing to point at (not a
 * dungeon, a room not entered, a lull between waves, nowhere left to go), and `undefined` when
 * this frame cannot say — the player is in a doorway, in no room's rect, and the arrow should hold
 * what it showed a moment ago rather than blink off and restart its delay.
 */
export function nextRoomGuide(
  s: GameState,
  roomId: RoomId | undefined,
  from?: { gx: number; gy: number },
): GuideTarget | null | undefined {
  if (s.dungeonRooms.length === 0) return null;
  if (roomId === undefined) return undefined;
  const idx = s.dungeonRoomIndexById.get(roomId);
  const rt = idx === undefined ? undefined : s.dungeonRoomRuntime[idx];
  if (!rt || !rt.activated) return null;
  if (rt.hasLiveEnemy) return from ? nearestFoe(s, roomId, from) : null;
  if (rt.cursor < rt.schedule.length) return null;

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
  return { kind: 'door', door, x: fpToPx(a.x) + fpToPx(a.w) / 2, y: fpToPx(a.y) + fpToPx(a.h) / 2 };
}

/** The live enemy of `roomId` nearest to `from`, by the sim's own positions; the arrow re-reads
 *  the DRAWN one each frame (`GuideClock.pose`'s `foeAt`). */
function nearestFoe(s: GameState, roomId: RoomId, from: { gx: number; gy: number }): GuideTarget | null {
  let best: GuideTarget | null = null;
  let bestD = Infinity;
  for (const e of s.enemies) {
    if (!e.alive || e.roomId !== roomId) continue;
    const d = Math.hypot(e.gx - from.gx, e.gy - from.gy);
    if (d < bestD) {
      bestD = d;
      best = { kind: 'foe', id: e.id, x: fpToPx(e.gx), y: fpToPx(e.gy) };
    }
  }
  return best;
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
/** Within this of the nearest enemy the foe arrow is gone: 7 grid, which an 800 x 600 frame at
 *  the room camera's zoom still shows. It fades in over the `GUIDE_FOE_FADE_PX` beyond, so a foe
 *  pacing at the line dims the arrow rather than blinking it. */
export const GUIDE_FOE_NEAR_PX = 224;
export const GUIDE_FOE_FADE_PX = 64;
/** How fast the aim swings to a new bearing, ms (the time constant of an exponential ease). A
 *  target can change in a frame — the fight's nearest enemy flips as the player crosses between
 *  two, the room clears and the door takes over — and an instant swing of the arrow round the
 *  body reads as a jolt; ~0.3 s to settle reads as the arrow turning. */
export const GUIDE_TURN_TAU_MS = 90;
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

/** Where the arrow sits this frame, given how long the current target has been shown (`age`, ms).
 *  `foe` marks an enemy target, which fades out on approach instead of stepping aside at a door.
 *  `aim` (radians) overrides the bearing it points along — `GuideClock`'s eased one. */
export function arrowPose(
  target: { x: number; y: number } | null,
  player: { x: number; y: number } | null,
  age: number,
  foe = false,
  aim?: number,
): ArrowPose {
  if (!target || !player || age < GUIDE_DELAY_MS) return HIDDEN;
  const dx = target.x - player.x;
  const dy = target.y - player.y;
  const d = Math.hypot(dx, dy);
  if (d <= (foe ? GUIDE_FOE_NEAR_PX : GUIDE_ARRIVE_PX)) return HIDDEN;
  const rotation = aim ?? Math.atan2(dy, dx);
  const ux = Math.cos(rotation);
  const uy = Math.sin(rotation);
  const shown = age - GUIDE_DELAY_MS;
  const r = GUIDE_ORBIT_PX + GUIDE_PULSE_PX * Math.sin((shown / GUIDE_PULSE_MS) * Math.PI * 2);
  return {
    visible: true,
    x: player.x + ux * r,
    y: player.y + uy * r,
    rotation,
    alpha: Math.min(1, shown / GUIDE_FADE_MS, foe ? (d - GUIDE_FOE_NEAR_PX) / GUIDE_FOE_FADE_PX : 1),
  };
}

/**
 * The arrow's clock: holds the target and how long it has been shown. A new target of the same
 * kind (another door of the same done room, another enemy of the same fight) keeps the clock
 * running; losing the target, or switching between a foe and a door (the room just cleared),
 * restarts the delay, so the cleared room's drops get their look before the door arrow comes.
 */
export class GuideClock {
  private target: GuideTarget | null = null;
  private age = 0;
  /** The bearing the arrow points along, eased toward the target's; null while hidden, so the
   *  arrow appears already pointing the right way rather than swinging in. */
  private aim: number | null = null;

  /** Feed one reconcile's verdict (`nextRoomGuide`). `undefined` holds the current target. */
  set(next: GuideTarget | null | undefined): void {
    if (next === undefined) return;
    if (next === null) {
      this.target = null;
      this.age = 0;
      return;
    }
    if (this.target && this.target.kind !== next.kind) this.age = 0;
    this.target = next;
  }

  /** The current target's kind, or null with none: what colour the arrow is drawn in. */
  get kind(): GuideTarget['kind'] | null {
    return this.target?.kind ?? null;
  }

  /**
   * Advance by `dt` ms and pose the arrow for a player drawn at `player`. `foeAt` resolves an
   * enemy's DRAWN position: the target's own `x/y` is the sim's, which steps at the tick rate, and
   * an arrow aimed at it would twitch against a smoothly drawn world.
   */
  pose(
    dt: number,
    player: { x: number; y: number } | null,
    foeAt?: (id: number) => { x: number; y: number } | null,
  ): ArrowPose {
    const t = this.target;
    if (t) this.age += dt;
    const at = t?.kind === 'foe' ? (foeAt?.(t.id) ?? t) : t;
    const foe = t?.kind === 'foe';
    const shown = arrowPose(at, player, this.age, foe);
    if (!shown.visible || !at || !player) {
      this.aim = null;
      return shown;
    }
    const want = Math.atan2(at.y - player.y, at.x - player.x);
    if (this.aim === null) this.aim = want;
    else {
      // The shortest way round, so a bearing crossing ±π does not spin the long way.
      const diff = Math.atan2(Math.sin(want - this.aim), Math.cos(want - this.aim));
      this.aim += diff * (1 - Math.exp(-dt / GUIDE_TURN_TAU_MS));
    }
    return arrowPose(at, player, this.age, foe, this.aim);
  }

  clear(): void {
    this.target = null;
    this.age = 0;
    this.aim = null;
  }
}
