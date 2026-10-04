// Walking a dungeon floor's door graph (2026-10-03): `roomRoute.ts`'s arena search, run over the
// floor's placed rooms and doors. Built for the co-op ally's walk to a big chest's plate
// (`chestPlate.ts`). `steer` alone searches a box round the bot and its goal, and a vault is a
// dead end off one room: from the next room along, the way in is several rooms round, outside
// any box, so the ally stood against the vault's wall while its player waited on the other plate.
//
// Pure function of GameState, like everything the bot does: the memo only remembers the shape of
// the floor it was built from.
import { FP_SCALE, type GameState } from '@dd/engine';
import type { Point } from './engage';
import { nextRoomToward, walkIntoRoom, type RouteMap } from './roomRoute';
import { steer, type Move } from './steer';

const floors = new WeakMap<GameState, { stamp: string; map: RouteMap }>();

/** This floor as a `RouteMap`, rebuilt when a descend replaces the rooms. */
function floorMap(s: GameState): RouteMap {
  const stamp = `${s.floorIndex}:${s.dungeonRoomRects.length}:${s.dungeonDoors.length}`;
  const memo = floors.get(s);
  if (memo && memo.stamp === stamp) return memo.map;
  const map: RouteMap = {
    doors: s.dungeonDoors.map((d) => d.door),
    rooms: s.dungeonRoomRects.map((r) => ({
      id: r.id,
      rectGrid: { x: r.rect.x / FP_SCALE, y: r.rect.y / FP_SCALE, w: r.rect.w / FP_SCALE, h: r.rect.h / FP_SCALE },
    })),
  };
  floors.set(s, { stamp, map });
  return map;
}

function roomAt(map: RouteMap, p: Point): string | undefined {
  const x = p.gx / FP_SCALE;
  const y = p.gy / FP_SCALE;
  return map.rooms.find((r) => x >= r.rectGrid.x && x <= r.rectGrid.x + r.rectGrid.w && y >= r.rectGrid.y && y <= r.rectGrid.y + r.rectGrid.h)?.id;
}

/**
 * The move toward `goal`: through the next door on the shortest door path when the two stand in
 * different rooms, else `steer` straight at it. Null once `steer` has nowhere closer to go. A
 * body in a doorway (in no room's rect) steers: the room it is stepping into is a grid away.
 */
export function walkTo(s: GameState, me: Point, goal: Point): Move | null {
  const map = floorMap(s);
  const from = roomAt(map, me);
  const to = roomAt(map, goal);
  if (from !== undefined && to !== undefined && from !== to) {
    const step = nextRoomToward(map, from, (id) => id === to);
    if (step !== undefined) return walkIntoRoom(s, map, me, from, step);
  }
  return steer(s, me, [goal]);
}
