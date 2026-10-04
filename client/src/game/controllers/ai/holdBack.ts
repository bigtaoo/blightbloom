// The co-op ally's fight, held back (2026-10-04). Until now the ally fought with `engageNearest`:
// the nearest live enemy anywhere on the floor, closed to 4 grid. That walked it into rooms its
// player had not entered and into the mob's own reach, so it went down first in 30 of 40 careful
// co-op runs against the leader's 5 (volume 124), and its revive rule seldom got a turn.
//
// Two changes, both the careful level-sim bot's (`sim/pve/PveBotController`):
//   - who: only an enemy in the ally's own room or its leader's. A mob two rooms on is left alone
//     until the leader gets there. Nothing in a third room can shoot it meanwhile: a room whose
//     fight starts pulls every standing seat inside and locks its doors (`DoorSystem`);
//   - where: hold 7.5 grid off the target, outside every mob's own engage range (5.6 grid), and
//     back off when it closes in. A blade has no business at 7.5 grid, so a melee weapon in hand
//     keeps the old close-in shape.
//
// Pure function of GameState, like everything the bot does.
import { Button, FP_SCALE, makeCommand, quantizeMove, type GameState, type PlayerActor, type PlayerCommand } from '@dd/engine';
import { engageNearest, gridFp, FIRE_RANGE_FP, type Point } from './engage';
import { walkTo } from './dungeonRoute';
import { HOLD, type Move } from './steer';

/** Distance held off the target: the careful profile's standoff. */
export const HOLD_BACK_FP = Math.round(7.5 * FP_SCALE);
/** Half-width of the band round `HOLD_BACK_FP` in which the ally stands still. */
const BAND_FP = gridFp(1);

/** The room whose rect contains `p`, or undefined outside every rect. Array order decides ties. */
function roomAt(s: GameState, p: Point): string | undefined {
  for (const r of s.dungeonRoomRects) {
    const { x, y, w, h } = r.rect;
    if (p.gx >= x && p.gx <= x + w && p.gy >= y && p.gy <= y + h) return r.id;
  }
  return undefined;
}

/**
 * The enemies the ally may fight this tick: those in its own room or its leader's. With no room
 * layout at all (an arena), every enemy, as before. It had a third arm until 2026-10-04: in a
 * doorway, any enemy in fire range. Generated rooms share their edges, so every point is in some
 * rect and the arm never fired outside a test floor.
 */
export function enemiesInReach(s: GameState, me: Point, leader: Point | undefined, enemies: readonly Point[]): Point[] {
  if (s.dungeonRoomRects.length === 0) return [...enemies];
  const mine = roomAt(s, me);
  const theirs = leader ? roomAt(s, leader) : undefined;
  return enemies.filter((e) => {
    const room = roomAt(s, e);
    return room !== undefined && (room === mine || room === theirs);
  });
}

/**
 * The held-back fight command, or null with no enemy in reach (the caller regroups). Fires once
 * within `FIRE_RANGE_FP`; walks to a target in another room through the doors.
 */
export function holdBackFight(s: GameState, owner: number, tick: number, me: PlayerActor, leader: Point | undefined, enemies: readonly Point[]): PlayerCommand | null {
  const pool = enemiesInReach(s, me, leader, enemies);
  if (me.weapon?.spec.kind === 'melee') return engageNearest(owner, tick, me, pool);
  let target: Point | undefined;
  let best = Infinity;
  for (const e of pool) {
    const d = Math.hypot(e.gx - me.gx, e.gy - me.gy);
    if (d < best) (best = d), (target = e);
  }
  if (!target) return null;
  const dx = target.gx - me.gx;
  const dy = target.gy - me.gy;
  let move: Move = HOLD;
  if (best > HOLD_BACK_FP + BAND_FP) move = walkTo(s, me, target) ?? HOLD;
  else if (best < HOLD_BACK_FP - BAND_FP) move = quantizeMove(-dx, -dy);
  return makeCommand({ owner, tick, ...move, buttons: best <= FIRE_RANGE_FP ? Button.FIRE : 0 });
}
