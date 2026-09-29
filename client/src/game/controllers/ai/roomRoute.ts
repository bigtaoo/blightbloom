// Walking the arena's door graph — shared by the PvP bot's two room-level rules, leaving the
// closing zone (`zoneRetreat.ts`) and reaching an opponent in another room (`PvpBotController`).
// Split out of `zoneRetreat.ts` on 2026-09-29 when the second rule needed the same search.
//
// Pure functions of the map and a position, like everything the bot does.
import { FP_SCALE, quantizeMove, type Brad } from '@dd/engine';
import type { ArenaMap } from '@dd/engine/content/arenas';
import type { Point } from './engage';

/** A passage centre this close counts as reached, and the bot aims at the next room's centre. */
const GATE_REACHED_FP = FP_SCALE;

/** Each room's neighbours in `map.doors` order. Derived once per map: the bot asks every tick
 *  for every seat, and rescanning every door for every room it expands made the balance sim
 *  eight times slower. */
const neighbours = new WeakMap<ArenaMap, Map<string, string[]>>();

function adjacency(map: ArenaMap): Map<string, string[]> {
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
  map: ArenaMap,
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

/** The move from `me` (in room `from`) into the adjacent room `step`: to the shared door's
 *  passage centre, then on to that room's centre once the passage is reached. */
export function walkIntoRoom(map: ArenaMap, me: Point, from: string, step: string): { moveBrad: Brad; moveMag: number } {
  const door = map.doors.find((d) => (d.roomA === from && d.roomB === step) || (d.roomB === from && d.roomA === step))!;
  const gate = centre(door.passageGrid);
  const room = map.rooms.find((r) => r.id === step);
  const atGate = Math.hypot(gate.gx - me.gx, gate.gy - me.gy) <= GATE_REACHED_FP;
  const aim = atGate && room ? centre(room.rectGrid) : gate;
  return quantizeMove(aim.gx - me.gx, aim.gy - me.gy);
}

function centre(r: { x: number; y: number; w: number; h: number }): Point {
  return { gx: Math.round((r.x + r.w / 2) * FP_SCALE), gy: Math.round((r.y + r.h / 2) * FP_SCALE) };
}
