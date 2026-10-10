// New 2026-09-03 (CLAUDE.md form 1 — an independent function module): WHICH doors get a frame of
// motion, and how close the player is to each. `doorFx.ts` owns how one door moves; this owns the
// two questions a fixture cannot answer about itself. Split out of `RoomBuilder.tickFixtures` so
// that class stayed under the 500-line convention, and because both rules below are pure geometry
// that is worth testing without building a room.
import type { RectPx } from './wallGeometry';
import type { TorchLightSink } from './torches';

/** This frame's visible world rect, in world px — `FxController.worldView`. */
export interface CameraRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * How far outside the visible rect a door still gets ticked.
 *
 * The rect `tickDoors` is handed is one frame STALE: `GameLoop` steps the fx before it updates the
 * camera (the camera needs this frame's interpolation alpha, the fx do not), so at a scroll speed
 * of s px/frame the true rect has already moved s px past it. A door that pops onto screen with
 * its clock at t = 0 starts mid-transition on its flame scroll and its pulse ring, which reads as
 * a fixture switching on. One tile of the world is plenty of slack for a one-frame lag.
 */
const TICK_MARGIN_PX = 96;

/**
 * The proximity ramp's two radii, in world px from the door's own footprint (not its centre — a
 * kerb door is 128 px wide and a distance-to-centre rule would call one jamb twice as far away as
 * the other).
 *
 * `NEAR_FULL_PX` is about a body's width, i.e. "standing at it"; `NEAR_FADE_PX` is roughly a
 * quarter of level 1's ~500 px room, so a door lifts as the player commits to crossing the room
 * toward it rather than only once they arrive. Smoothstepped between the two: a linear ramp's
 * corner at the outer radius is visible as a kink when a player walks past a doorway.
 */
const NEAR_FULL_PX = 34;
const NEAR_FADE_PX = 130;

/**
 * Step every door that is on screen, at its own proximity to the player.
 *
 * `fixtures` and `rects` are index-aligned (`RoomBuilder`'s two lists, both index-aligned with
 * `state.dungeonDoors`). A null `view` ticks everything — the caller has no camera yet, which
 * happens on the first frame after a room build and in tests. A null `playerPx` ticks at
 * `near = 0` rather than skipping: a door on screen has to keep breathing whether or not there is
 * anyone in the room to see it (menu, replay before the first tick, the moment after a death).
 */
export function tickDoors(
  dt: number,
  fixtures: readonly { tick(dt: number, near: number): void }[],
  rects: readonly RectPx[],
  view: CameraRect | null,
  playerPx: { x: number; y: number } | null,
): void {
  for (let i = 0; i < fixtures.length; i++) {
    const rect = rects[i];
    if (!rect) continue; // a fixture with no recorded footprint cannot be culled or ranged
    if (view && !overlapsView(rect, view)) continue;
    fixtures[i]!.tick(dt, playerPx ? nearness(rect, playerPx) : 0);
  }
}

/** Does `rect` meet the visible world rect, grown by `TICK_MARGIN_PX` on every side? Exported for
 *  tests. */
export function overlapsView(rect: RectPx, view: CameraRect): boolean {
  return (
    rect.x < view.x + view.w + TICK_MARGIN_PX &&
    rect.x + rect.w > view.x - TICK_MARGIN_PX &&
    rect.y < view.y + view.h + TICK_MARGIN_PX &&
    rect.y + rect.h > view.y - TICK_MARGIN_PX
  );
}

/** 1 within `NEAR_FULL_PX` of `rect`, 0 beyond `NEAR_FADE_PX`, smoothstepped between. Distance is
 *  to the RECT, so a point inside it is 0 away. Exported for tests. */
export function nearness(rect: RectPx, p: { x: number; y: number }): number {
  const dx = Math.max(rect.x - p.x, 0, p.x - (rect.x + rect.w));
  const dy = Math.max(rect.y - p.y, 0, p.y - (rect.y + rect.h));
  const d = Math.hypot(dx, dy);
  if (d <= NEAR_FULL_PX) return 1;
  if (d >= NEAR_FADE_PX) return 0;
  const t = 1 - (d - NEAR_FULL_PX) / (NEAR_FADE_PX - NEAR_FULL_PX);
  return t * t * (3 - 2 * t);
}

/**
 * Is the player being REFUSED by the door at `rect` — the client-side derivation behind
 * `DoorFixture.reject`.
 *
 * Deliberately not an engine event. A `door_blocked` event would be the cleaner signal and costs
 * an `ENGINE_VERSION` bump plus a golden-hash re-run for something that changes no simulation
 * state, so this reads what the client already has. Three conditions, and all three are load-
 * bearing:
 *
 * - `locked` — an open door refuses nobody.
 * - the player is pressed against the passage (`REJECT_REACH_PX` of the footprint) AND their input
 *   points into it. Without the input test a player merely standing beside a doorway triggers it.
 * - they are not actually moving (`REJECT_SPEED_PX` per frame). This is the condition that tells
 *   "walked into it and stopped" from "walking past it": the sim has already resolved the
 *   collision, so a blocked player's position simply stops changing, and that is the whole signal.
 *
 * `moveMag` is the command's own 0..255 stick deflection and `moveRad` its direction, so this is
 * the input the sim was actually given for the tick being drawn, not a re-read of the keyboard.
 */
export function isRefused(
  rect: RectPx,
  locked: boolean,
  p: { x: number; y: number; dx: number; dy: number },
  move: { rad: number; mag: number },
): boolean {
  if (!locked || move.mag < REJECT_MOVE_MAG) return false;
  if (Math.hypot(p.dx, p.dy) > REJECT_SPEED_PX) return false;
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const dx = Math.max(rect.x - p.x, 0, p.x - (rect.x + rect.w));
  const dy = Math.max(rect.y - p.y, 0, p.y - (rect.y + rect.h));
  if (Math.hypot(dx, dy) > REJECT_REACH_PX) return false;
  // Pressing INTO the door: the input direction and the direction to the door's centre agree to
  // better than 90 degrees. A dot product, so no angle wrap to get wrong.
  const toX = cx - p.x;
  const toY = cy - p.y;
  const len = Math.hypot(toX, toY);
  if (len < 0.001) return true; // standing exactly on the centre — already in the passage
  return (Math.cos(move.rad) * toX + Math.sin(move.rad) * toY) / len > 0.25;
}

/** Within this much of a locked door's footprint to count as pressed against it. A body is ~16 px
 *  in radius (`Actor`'s own silhouette), so this is "touching, plus a pixel of slack for the
 *  interpolated draw position running a fraction of a tick ahead of the resolved one". */
const REJECT_REACH_PX = 20;
/** Faster than this (world px between render frames) and the player is walking, not stuck. */
const REJECT_SPEED_PX = 0.35;
/** Below this stick deflection there is no intent to push through anything. `moveMag` is 0..255. */
const REJECT_MOVE_MAG = 40;

/** What the reject scan needs from `RoomBuilder`, narrowed to the two methods it calls (CLAUDE.md:
 *  "narrow that dependency to a small interface declaring just those methods"). */
export interface DoorFxTarget {
  tickFixtures(
    dt: number,
    view: CameraRect | null,
    playerPx: { x: number; y: number } | null,
    lights?: TorchLightSink,
  ): void;
  doorFootprint(index: number): RectPx | null;
  rejectDoor(index: number): void;
}

/** The local player, as this driver reads them: where they are DRAWN, and how far the sim moved
 *  them on the tick being drawn (`Entity`'s cur/prev buffers — a blocked player's `cur` simply
 *  stops leaving `prev`, which is the whole refusal signal). */
export interface DoorFxPlayer {
  curX: number;
  curY: number;
  prevX: number;
  prevY: number;
}

/** How long a refused door waits before it may flash again. Holding a direction into a locked door
 *  should read as pushing at it — one shove, then another — not as a strobe. */
const REJECT_COOLDOWN_MS = 450;

/** Camera-shake trauma one refusal is worth. Felt, never mistaken for damage — and deliberately
 *  NOT paired with `addHitStop`: freezing the sim over a navigation mistake punishes one. */
const REJECT_SHAKE = 0.05;

/** What this driver needs from `FxController`: this frame's visible world rect to cull against,
 *  and the shake a refusal adds. Narrowed to those two so the scene layer never imports the fx
 *  controller itself (CLAUDE.md: "narrow that dependency to a small interface"). */
export interface DoorFxCamera {
  readonly worldView: { x: number; y: number; width: number; height: number };
  addShake(amount: number): void;
  /** Where the room's torches register their lights (`torches.ts`) — `FxController.lights`. */
  readonly lights?: TorchLightSink;
}

/**
 * The whole per-frame door-fx pass, in one object so `GameLoop` carries one call rather than the
 * cull, the proximity ramp, the refusal scan and its debounce clocks.
 *
 * Stateful only in the debounce clocks, which is why this is a class and `tickDoors`/`isRefused`
 * above are free functions: everything else here is a pure function of this frame.
 */
export class DoorFxDriver {
  /** Remaining cooldown per door index; absent/0 means it may flash. */
  private readonly cooldown: number[] = [];

  /**
   * Step every visible door, scan for a refusal, and shake the camera if one fired.
   *
   * `doors` is `state.dungeonDoors` — the authority on which doors are locked. It is index-aligned
   * with the fixtures, and an arena (whose doors live in `arenaMap`, never `dungeonDoors`) simply
   * presents an empty list, so this is a no-op there rather than a special case.
   *
   * `cam.worldView` is one frame STALE (the caller updates the camera after the fx pass, because
   * only the camera needs this frame's interpolation alpha) — `TICK_MARGIN_PX` is the slack for it.
   */
  frame(
    dt: number,
    doors: readonly { locked: boolean }[],
    target: DoorFxTarget,
    cam: DoorFxCamera,
    player: DoorFxPlayer | null,
    move: { rad: number; mag: number },
  ): void {
    const v = cam.worldView;
    const playerPx = player ? { x: player.curX, y: player.curY } : null;
    target.tickFixtures(dt, { x: v.x, y: v.y, w: v.width, h: v.height }, playerPx, cam.lights);
    for (let i = 0; i < this.cooldown.length; i++) {
      if (this.cooldown[i]! > 0) this.cooldown[i] = Math.max(0, this.cooldown[i]! - dt);
    }
    if (!player) return;
    const pose = {
      x: player.curX,
      y: player.curY,
      dx: player.curX - player.prevX,
      dy: player.curY - player.prevY,
    };
    let refused = false;
    for (let i = 0; i < doors.length; i++) {
      if ((this.cooldown[i] ?? 0) > 0) continue;
      const rect = target.doorFootprint(i);
      if (!rect || !isRefused(rect, doors[i]!.locked, pose, move)) continue;
      target.rejectDoor(i);
      this.cooldown[i] = REJECT_COOLDOWN_MS;
      refused = true;
    }
    if (refused) cam.addShake(REJECT_SHAKE);
  }
}
