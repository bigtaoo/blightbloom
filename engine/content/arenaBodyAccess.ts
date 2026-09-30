/**
 * The body-reach half of the arena quality gate (2026-09-30): per room, the floor a player's
 * body can stand on (`arenaBodyReach.ts`), split into the pieces a body can walk between
 * without leaving the room, and every piece of content checked against the room's largest one.
 *
 * Why per room and not over the whole map: `measureBodyReach` floods from the map's largest
 * region, which asks whether the doors really open. The gate's own fixture maps give their
 * doors only in the graph and wall every room solid, so a whole-map flood strands all but one
 * room of each. Whether a door is open is the door graph's question (`door_gates_nothing`,
 * `undoored_leak`); what shipped wrong on `arena_launch` was inside the rooms: floor sealed off
 * by a free-standing block's brim with mobs spawned in it, and rooms whose floor was two halves
 * joined only through other rooms (volumes 116 and 118). Both are visible from the room alone.
 *
 * Construction-time only, like `arenaBodyReach.ts`.
 */
import type { ArenaMap } from './arenas';
import { buildArenaGeometry } from './arenas';
import { measureBodyReach } from './arenaBodyReach';

/** Lattice cells per grid (`arenaBodyReach.ts` spaces them half a grid). */
const CELLS_PER_GRID = 2;
/** How near a piece of content a room's floor has to come: one grid, the slack
 *  `BodyReach.reaches` allows, for the same reason (a corner spawn sits flush on the wall). */
const SLACK_CELLS = 2;

export interface UnreachedContent {
  room: string;
  feature: 'loot' | 'enemySpawn' | 'drop';
  /** Absolute grid point. */
  at: { x: number; y: number };
}

export interface ArenaBodyAccess {
  /** Rooms whose standable floor is more than one piece, with the count, in map order. */
  splitRooms: { room: string; pieces: number }[];
  /** Content no body on its room's largest floor piece gets within one grid of. */
  unreached: UnreachedContent[];
}

export function measureBodyAccess(map: ArenaMap): ArenaBodyAccess {
  const reach = measureBodyReach(buildArenaGeometry(map));
  const { w, h, standable } = reach;
  const splitRooms: ArenaBodyAccess['splitRooms'] = [];
  const unreached: UnreachedContent[] = [];
  const largest = new Map<string, Uint8Array>();

  for (const room of map.rooms) {
    // The room's closed rect in cells, so a doorway cell on its edge counts with it.
    const x0 = Math.max(0, room.rectGrid.x * CELLS_PER_GRID);
    const y0 = Math.max(0, room.rectGrid.y * CELLS_PER_GRID);
    const x1 = Math.min(w - 1, (room.rectGrid.x + room.rectGrid.w) * CELLS_PER_GRID);
    const y1 = Math.min(h - 1, (room.rectGrid.y + room.rectGrid.h) * CELLS_PER_GRID);
    const piece = new Int32Array(w * h).fill(-1);
    const sizes: number[] = [];
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        const k = cy * w + cx;
        if (!standable[k] || piece[k] !== -1) continue;
        const id = sizes.length;
        let size = 0;
        piece[k] = id;
        const stack = [k];
        while (stack.length > 0) {
          const c = stack.pop()!;
          size++;
          const px = c % w;
          const py = (c - px) / w;
          for (const [nx, ny] of [[px + 1, py], [px - 1, py], [px, py + 1], [px, py - 1]] as const) {
            if (nx < x0 || nx > x1 || ny < y0 || ny > y1) continue;
            const n = ny * w + nx;
            if (!standable[n] || piece[n] !== -1) continue;
            piece[n] = id;
            stack.push(n);
          }
        }
        sizes.push(size);
      }
    }
    if (sizes.length > 1) splitRooms.push({ room: room.id, pieces: sizes.length });
    // Ties go to the first found, so the answer depends on the geometry alone.
    let best = -1;
    for (let i = 0; i < sizes.length; i++) if (best < 0 || sizes[i]! > sizes[best]!) best = i;
    const floor = new Uint8Array(w * h);
    for (let k = 0; k < floor.length; k++) if (best >= 0 && piece[k] === best) floor[k] = 1;
    largest.set(room.id, floor);
  }

  const near = (floor: Uint8Array, gx: number, gy: number): boolean => {
    const cx = Math.round(gx * CELLS_PER_GRID);
    const cy = Math.round(gy * CELLS_PER_GRID);
    for (let dy = -SLACK_CELLS; dy <= SLACK_CELLS; dy++) {
      for (let dx = -SLACK_CELLS; dx <= SLACK_CELLS; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && y >= 0 && x < w && y < h && floor[y * w + x]) return true;
      }
    }
    return false;
  };
  const inRect = (r: ArenaMap['rooms'][number], x: number, y: number) =>
    x >= r.rectGrid.x && y >= r.rectGrid.y && x < r.rectGrid.x + r.rectGrid.w && y < r.rectGrid.y + r.rectGrid.h;
  // Content outside its own room is `content_outside_room`'s finding, not this one's.
  const check = (room: ArenaMap['rooms'][number], feature: UnreachedContent['feature'], x: number, y: number) => {
    if (inRect(room, x, y) && !near(largest.get(room.id)!, x, y)) unreached.push({ room: room.id, feature, at: { x, y } });
  };

  for (const room of map.rooms) {
    const { x: ox, y: oy } = room.rectGrid;
    for (const m of room.lootMarkers ?? []) check(room, 'loot', m.point.x + ox, m.point.y + oy);
    for (const s of room.spawns ?? []) check(room, 'enemySpawn', s.x + ox, s.y + oy);
  }
  // A drop point belongs to the room whose rect holds it; one outside every room is
  // `spawn_outside_room`'s finding.
  for (const p of map.spawns) {
    const room = map.rooms.find((r) => inRect(r, p.x, p.y));
    if (room) check(room, 'drop', p.x, p.y);
  }
  return { splitRooms, unreached };
}
