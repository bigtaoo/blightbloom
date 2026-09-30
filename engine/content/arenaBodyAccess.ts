/**
 * The body-reach half of the arena quality gate (2026-09-30): per room, the floor a player's
 * body can stand on (`arenaBodyReach.ts`), split into the pieces a body can walk between
 * without leaving the room, and every piece of content checked against the room's largest one.
 *
 * Why per room and not over the whole map: `measureBodyReach` floods from the map's largest
 * region, which asks whether the doors really open. The gate's own fixture maps give their
 * doors only in the graph and wall every room solid, so a whole-map flood strands all but one
 * room of each. What shipped wrong on `arena_launch` was inside the rooms: floor sealed off by a
 * free-standing block's brim with mobs spawned in it, and rooms whose floor was two halves joined
 * only through other rooms (volumes 116 and 118). Both are visible from the room alone. A door is
 * asked the same way, one door at a time: can a body from each room walk into its passage.
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
  /** Doors a body cannot walk through: no path from one room's largest floor piece to the
   *  other's inside the two rooms and the passage, in map order. */
  shutDoors: { roomA: string; roomB: string }[];
}

export function measureBodyAccess(map: ArenaMap): ArenaBodyAccess {
  const reach = measureBodyReach(buildArenaGeometry(map));
  const { w, h, standable } = reach;
  const splitRooms: ArenaBodyAccess['splitRooms'] = [];
  const unreached: UnreachedContent[] = [];
  const largest = new Map<string, Uint8Array>();
  // A grid rect's closed extent in cells, so a doorway cell on its edge counts with it.
  const cellsOf = (r: { x: number; y: number; w: number; h: number }) => ({
    x0: Math.max(0, r.x * CELLS_PER_GRID),
    y0: Math.max(0, r.y * CELLS_PER_GRID),
    x1: Math.min(w - 1, (r.x + r.w) * CELLS_PER_GRID),
    y1: Math.min(h - 1, (r.y + r.h) * CELLS_PER_GRID),
  });

  for (const room of map.rooms) {
    const { x0, y0, x1, y1 } = cellsOf(room.rectGrid);
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

  // A door is open when a body on each room's floor can walk into the door's own passage, each
  // without entering the other room, and the two meet there. Asking about the passage and not
  // the pair is what keeps a second gap between the same two rooms from opening a walled one.
  // A door naming a room the map lacks is the graph rules' finding.
  type Box = ReturnType<typeof cellsOf>;
  const flood = (seed: Uint8Array, boxes: Box[]): Uint8Array => {
    const inside = (x: number, y: number) => boxes.some((r) => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1);
    const seen = new Uint8Array(w * h);
    const stack: number[] = [];
    for (let k = 0; k < seed.length; k++) if (seed[k]) { seen[k] = 1; stack.push(k); }
    while (stack.length > 0) {
      const c = stack.pop()!;
      const px = c % w;
      const py = (c - px) / w;
      for (const [nx, ny] of [[px + 1, py], [px - 1, py], [px, py + 1], [px, py - 1]] as const) {
        if (!inside(nx, ny)) continue;
        const n = ny * w + nx;
        if (!standable[n] || seen[n]) continue;
        seen[n] = 1;
        stack.push(n);
      }
    }
    return seen;
  };
  const shutDoors: ArenaBodyAccess['shutDoors'] = [];
  const byId = new Map(map.rooms.map((r) => [r.id, r]));
  for (const door of map.doors) {
    const a = byId.get(door.roomA);
    const b = byId.get(door.roomB);
    if (!a || !b) continue;
    const p = cellsOf(door.passageGrid);
    const fromA = flood(largest.get(a.id)!, [cellsOf(a.rectGrid), p]);
    const fromB = flood(largest.get(b.id)!, [cellsOf(b.rectGrid), p]);
    // Two battery mutants are equivalent (2026-09-30): dropping the passage from one side's
    // flood (two floods that meet in the passage also meet where one side's path entered it,
    // on its own room's edge), and scanning the passage's box open-ended (a meeting only on its
    // far edge line would need a passage no body stands inside).
    let open = false;
    for (let y = p.y0; y <= p.y1 && !open; y++) for (let x = p.x0; x <= p.x1; x++) if (fromA[y * w + x] && fromB[y * w + x]) open = true;
    if (!open) shutDoors.push({ roomA: a.id, roomB: b.id });
  }
  return { splitRooms, unreached, shutDoors };
}
