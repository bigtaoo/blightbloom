// The co-op ally's own time (2026-10-08). With nothing to fight, revive or stand on, the ally
// used to close on its leader whenever it was more than 3 grid off — every step the player took,
// it took one after them. Live report: *"机器人不要像一个跟班一样老是跟随玩家，稍微有点自主行动"*.
//
// Now a quiet room is the ally's to wander: every `ROAM_PERIOD_TICKS` it picks a spot in its
// leader's room and strolls there, or rests where it stands, and only comes back when the leader
// leaves the room or gets past `LEASH_FP`. Two rules it does NOT bend, because each would cost
// the player rather than free the ally:
//   - it never picks a spot outside the leader's room. A room whose fight has not started pulls
//     every standing seat in when it starts (`DoorSystem`'s regroup), so an ally that wandered
//     into one would drag its player into a fight they had not chosen;
//   - it never goes after loot. Coins and materials go to the bag of whoever collects them
//     (`PickupSystem`), so a bot that fetched them would be taking them from its player.
//
// Pure function of GameState and the tick, like everything the bot does: the spot comes from a
// hash of the seat, the floor and the period, never from RNG, so a run stays reproducible.
import { TICK_RATE, type GameState } from '@dd/engine';
import { gridFp, type Point } from './engage';
import { walkTo } from './dungeonRoute';
import { roomAt } from './holdBack';
import { HOLD, type Move } from './steer';

/** Past this, or in another room, the ally walks back to its leader at full pace. */
export const LEASH_FP = gridFp(8);
/** A spot the ally picks is at most this far from its leader — inside the leash, so picking one
 *  never sends it straight back. */
export const POST_MAX_FP = gridFp(6);
/** ...and at least this far, so a spot is never on the leader's own feet. */
export const POST_MIN_FP = gridFp(2);
/** How long one spot (or one rest) lasts. */
export const ROAM_PERIOD_TICKS = Math.round(2.5 * TICK_RATE);
/** Close enough to its spot to stop and stand. */
const ARRIVE_FP = gridFp(1);
/** How far inside a room's walls a spot stays. */
const INSET_FP = gridFp(2);
/** A stroll is not a dash: 2/3 of full deflection. A regroup still runs. */
export const STROLL_MAG = 170;

/** A 32-bit integer mix (murmur3's finalizer) of three integers. */
function mix(a: number, b: number, c: number): number {
  let h = Math.imul(a + 1, 0x9e3779b1) ^ Math.imul(b + 1, 0x85ebca6b) ^ Math.imul(c + 1, 0xc2b2ae35);
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

function dist(a: Point, b: Point): number {
  return Math.hypot(a.gx - b.gx, a.gy - b.gy);
}

/** How many spots one period tries before it settles for a rest. */
const TRIES = 6;

/**
 * Where the ally means to be this period, or null to rest where it stands — one period in three,
 * and any period none of its `TRIES` spots fits. A spot fits when, pulled inside the leader's
 * room's walls, it lies between `POST_MIN_FP` and `POST_MAX_FP` of the leader. The tries
 * alternate between anywhere in the room and a hashed angle and distance round the leader: the
 * first spreads the ally over a big room, the second still finds a spot when the leader stands in
 * a corner, where most of the room is out of reach and a clamped ring spot lands on their feet.
 * With no room layout (an arena), only the ring.
 */
export function roamPost(s: GameState, owner: number, leader: Point, tick: number): Point | null {
  const period = Math.floor(tick / ROAM_PERIOD_TICKS);
  if (mix(owner, period, s.floorIndex) % 3 === 0) return null;
  const id = roomAt(s, leader);
  const rect = id === undefined ? undefined : s.dungeonRoomRects.find((r) => r.id === id)?.rect;
  const inner = rect && rect.w > 2 * INSET_FP && rect.h > 2 * INSET_FP
    ? { x: rect.x + INSET_FP, y: rect.y + INSET_FP, w: rect.w - 2 * INSET_FP, h: rect.h - 2 * INSET_FP }
    : undefined;
  for (let i = 0; i < TRIES; i++) {
    const a = mix(owner, period, s.floorIndex * TRIES + i + 1);
    const b = mix(a, owner, period);
    let gx: number;
    let gy: number;
    if (inner && i % 2 === 0) {
      gx = inner.x + (a % (inner.w + 1));
      gy = inner.y + (b % (inner.h + 1));
    } else {
      const angle = ((b % 360) * Math.PI) / 180;
      const r = POST_MIN_FP + (a % (POST_MAX_FP - POST_MIN_FP + 1));
      gx = Math.round(leader.gx + Math.cos(angle) * r);
      gy = Math.round(leader.gy + Math.sin(angle) * r);
    }
    if (inner) {
      gx = Math.min(inner.x + inner.w, Math.max(inner.x, gx));
      gy = Math.min(inner.y + inner.h, Math.max(inner.y, gy));
    }
    const d = Math.hypot(gx - leader.gx, gy - leader.gy);
    if (d >= POST_MIN_FP && d <= POST_MAX_FP) return { gx, gy };
  }
  return null;
}

/** The quiet-room move: back to the leader when out of its room or past the leash, else toward
 *  this period's spot at a stroll, else stand. */
export function roamMove(s: GameState, owner: number, me: Point, leader: Point, tick: number): Move {
  if (dist(me, leader) > LEASH_FP || roomAt(s, me) !== roomAt(s, leader)) return walkTo(s, me, leader) ?? HOLD;
  const post = roamPost(s, owner, leader, tick);
  if (!post || dist(me, post) <= ARRIVE_FP) return HOLD;
  const move = walkTo(s, me, post);
  return move ? { moveBrad: move.moveBrad, moveMag: Math.min(move.moveMag, STROLL_MAG) } : HOLD;
}
