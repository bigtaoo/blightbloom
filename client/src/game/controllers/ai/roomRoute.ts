// Walking the arena's door graph — shared by the PvP bot's two room-level rules, leaving the
// closing zone (`zoneRetreat.ts`) and reaching an opponent in another room (`PvpBotController`).
// Split out of `zoneRetreat.ts` on 2026-09-29 when the second rule needed the same search.
//
// Pure functions of the map and a position, like everything the bot does.
import { FP_SCALE, quantizeMove, type GameState } from '@dd/engine';
import type { Door } from '@dd/engine/content/arenas';
import type { Point } from './engage';
import { steer, type Move } from './steer';

/** The part of a map the route reads: its doors, and each room's rect in grid units. An
 *  `ArenaMap` is one; a dungeon floor is adapted to one by `dungeonRoute.ts` (2026-10-03). */
export interface RouteMap {
  readonly doors: readonly Door[];
  readonly rooms: readonly { readonly id: string; readonly rectGrid: { x: number; y: number; w: number; h: number } }[];
}

/** Each room's neighbours in `map.doors` order. Derived once per map: the bot asks every tick
 *  for every seat, and rescanning every door for every room it expands made the balance sim
 *  eight times slower. */
const neighbours = new WeakMap<RouteMap, Map<string, string[]>>();

function adjacency(map: RouteMap): Map<string, string[]> {
  let adj = neighbours.get(map);
  if (!adj) {
    adj = new Map();
    for (const d of map.doors) {
      for (const [a, b] of [[d.roomA, d.roomB], [d.roomB, d.roomA]] as const) {
        const list = adj.get(a) ?? [];
        list.push(b);
        adj.set(a, list);
      }
    }
    neighbours.set(map, adj);
  }
  return adj;
}

/**
 * The room to walk into next on a shortest door path from `from` to the first room `isGoal`
 * accepts, or undefined when none is reachable. `canEnter` limits the rooms the path may pass
 * through (the goal itself included). Breadth-first in `map.doors` order, so ties resolve the
 * same way on every machine.
 */
export function nextRoomToward(
  map: RouteMap,
  from: string,
  isGoal: (id: string) => boolean,
  canEnter: (id: string) => boolean = () => true,
): string | undefined {
  const adj = adjacency(map);
  const prev = new Map<string, string>([[from, from]]);
  const queue = [from];
  let goal: string | undefined;
  for (let head = 0; head < queue.length && goal === undefined; head++) {
    const cur = queue[head]!;
    for (const next of adj.get(cur) ?? []) {
      if (prev.has(next) || !canEnter(next)) continue;
      prev.set(next, cur);
      if (isGoal(next)) {
        goal = next;
        break;
      }
      queue.push(next);
    }
  }
  if (goal === undefined) return undefined;
  let step = goal;
  while (prev.get(step) !== from) step = prev.get(step)!;
  return step;
}

/**
 * The move from `me` (in room `from`) into the adjacent room `step` through their shared door:
 * to whichever point across the passage's width it can walk to (centre first, `ai/steer.ts`),
 * then, once inside the passage, straight on through it to a grid past its far side.
 */
export function walkIntoRoom(s: GameState, map: RouteMap, me: Point, from: string, step: string): Move {
  const door = map.doors.find((d) => (d.roomA === from && d.roomB === step) || (d.roomB === from && d.roomA === step))!;
  const p = door.passageGrid;
  const room = map.rooms.find((r) => r.id === step)!;
  // The passage cuts across the wall between the two rooms: its short side is the way through.
  const acrossX = p.w <= p.h;
  const into = Math.sign(acrossX ? centre(room.rectGrid).gx - centre(p).gx : centre(room.rectGrid).gy - centre(p).gy) || 1;
  const inPassage = me.gx >= (p.x - 0.5) * FP_SCALE && me.gx <= (p.x + p.w + 0.5) * FP_SCALE && me.gy >= (p.y - 0.5) * FP_SCALE && me.gy <= (p.y + p.h + 0.5) * FP_SCALE;
  if (inPassage) {
    const beyond = into > 0 ? (acrossX ? p.x + p.w : p.y + p.h) + 1 : (acrossX ? p.x : p.y) - 1;
    const on = acrossX ? { gx: beyond * FP_SCALE, gy: me.gy } : { gx: me.gx, gy: beyond * FP_SCALE };
    return steer(s, me, [on]) ?? toward(me, on);
  }
  const gates = gatePoints(p, acrossX);
  return steer(s, me, gates) ?? toward(me, gates[0]!);
}

/** Points along the passage's long side at every grid, centre first, then outward; each kept
 *  half a grid inside its ends so a body there clears the jambs. */
function gatePoints(p: { x: number; y: number; w: number; h: number }, acrossX: boolean): Point[] {
  const c = centre(p);
  const lo = (acrossX ? p.y : p.x) + 0.5;
  const hi = (acrossX ? p.y + p.h : p.x + p.w) - 0.5;
  const mid = (lo + hi) / 2;
  const at: number[] = [mid];
  for (let d = 1; mid - d >= lo || mid + d <= hi; d++) {
    if (mid - d >= lo) at.push(mid - d);
    if (mid + d <= hi) at.push(mid + d);
  }
  return at.map((v) => (acrossX ? { gx: c.gx, gy: Math.round(v * FP_SCALE) } : { gx: Math.round(v * FP_SCALE), gy: c.gy }));
}

function toward(me: Point, g: Point): Move {
  return quantizeMove(g.gx - me.gx, g.gy - me.gy);
}

function centre(r: { x: number; y: number; w: number; h: number }): Point {
  return { gx: Math.round((r.x + r.w / 2) * FP_SCALE), gy: Math.round((r.y + r.h / 2) * FP_SCALE) };
}
