/**
 * The physical door-passability suite every authored PvE chapter runs (split out of
 * `world/rooms/emberLevel1.test.ts` 2026-10-06, when chapter 2 needed the same gate). See
 * that file's header for why "passable" is checked the expensive way: through the real
 * `placeAuthoredFloor` -> `buildFloorGeometry` path, rasterised and flood-filled.
 *
 * A fixture, not shipped logic — imported only by content tests, excluded from coverage like
 * the rest of `fixtures/`.
 */
import { describe, expect, it } from 'vitest';
import { buildFloorGeometry, placeAuthoredFloor, type DungeonFloorMap } from '../world/dungeon';
import type { RoomPiece } from '../content/rooms';
import { FP_SCALE } from '../math/fixed';
import { toFpGrid } from '../content/convert';
import { mechanismRing } from '../content/chests';
import { SHOP_INTERACT_RANGE_GRID } from '../config';

/** A by-id lookup over a chapter's piece library that fails loudly on an unknown id. */
export function pieceLookup(library: readonly RoomPiece[]): (id: string) => RoomPiece {
  const byId = new Map(library.map((p) => [p.id, p] as const));
  return (id) => {
    const piece = byId.get(id);
    if (!piece) throw new Error(`unknown pieceId '${id}'`);
    return piece;
  };
}

// ── Door passability ────────────────────────────────────────────────────────────

/** Rooms may share a wall but must never overlap — every downstream room-membership
 * test (`EnvironmentSystem`'s point-in-rect roomId lookup) assumes disjoint rects. */
export function overlapping(map: DungeonFloorMap, library: readonly RoomPiece[]): string[] {
  const pieceFor = pieceLookup(library);
  const rects = map.rooms.map((r) => ({
    id: r.id,
    x: r.offsetXGrid,
    y: r.offsetYGrid,
    w: pieceFor(r.pieceId).sizeGrid.w,
    h: pieceFor(r.pieceId).sizeGrid.h,
  }));
  const bad: string[] = [];
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i]!;
      const b = rects[j]!;
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) bad.push(`${a.id}/${b.id}`);
    }
  }
  return bad;
}

/**
 * The real thing: run the engine's own placement + geometry stitching, rasterise
 * the stitched (already door-carved) Fp wall list back onto a 1-cell grid, and
 * flood-fill from the spawn room's first player spawn. Anything a player must be
 * able to stand on — every room's `entranceGrid` (DoorSystem's force-regroup
 * landing point), every player spawn, every enemy spawn — has to be in the
 * reachable set. A door that opens into a solid, or that only cut one of the two
 * abutting perimeter walls, fails here.
 */
export function traversability(map: DungeonFloorMap, library: readonly RoomPiece[]) {
  const { placed, doors } = placeAuthoredFloor(map, library);
  const geo = buildFloorGeometry(placed, doors);
  const W = Math.round(geo.worldW / FP_SCALE);
  const H = Math.round(geo.worldH / FP_SCALE);

  // Start solid everywhere (outside the rooms IS solid), open each room's footprint,
  // then stamp the stitched wall list back on. `buildFloorGeometry` has already
  // carved the door gaps out of that list, so the openings appear for free.
  const solid = new Uint8Array(W * H).fill(1);
  const at = (x: number, y: number) => y * W + x;
  for (const room of placed) {
    for (let y = 0; y < room.piece.sizeGrid.h; y++) {
      for (let x = 0; x < room.piece.sizeGrid.w; x++) solid[at(room.offsetXGrid + x, room.offsetYGrid + y)] = 0;
    }
  }
  for (const wall of geo.walls) {
    const x0 = Math.round(wall.x / FP_SCALE);
    const y0 = Math.round(wall.y / FP_SCALE);
    const x1 = Math.round((wall.x + wall.w) / FP_SCALE);
    const y1 = Math.round((wall.y + wall.h) / FP_SCALE);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (x >= 0 && y >= 0 && x < W && y < H) solid[at(x, y)] = 1;
  }
  for (const o of geo.obstacles) {
    const cx = o.gx / FP_SCALE;
    const cy = o.gy / FP_SCALE;
    const r = o.radius / FP_SCALE;
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        if (x >= 0 && y >= 0 && x < W && y < H && Math.hypot(x + 0.5 - cx, y + 0.5 - cy) <= r + 0.5) solid[at(x, y)] = 1;
      }
    }
  }

  const first = placed[0]!;
  const startPt = first.piece.spawns.player[0]!;
  const start = at(Math.floor(first.offsetXGrid + startPt.x), Math.floor(first.offsetYGrid + startPt.y));
  const seen = new Uint8Array(W * H);
  const stack = [start];
  seen[start] = 1;
  while (stack.length > 0) {
    const cur = stack.pop()!;
    const cx = cur % W;
    const cy = (cur - cx) / W;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const n = at(nx, ny);
      if (seen[n] || solid[n]) continue;
      seen[n] = 1;
      stack.push(n);
    }
  }

  const unreachable: string[] = [];
  const check = (label: string, x: number, y: number) => {
    if (!seen[at(Math.floor(x), Math.floor(y))]) unreachable.push(`${label} @ (${x}, ${y})`);
  };
  for (const room of placed) {
    check(`${room.id} entrance`, room.entranceGrid.x, room.entranceGrid.y);
    room.piece.spawns.player.forEach((p, i) => check(`${room.id} player spawn ${i}`, room.offsetXGrid + p.x, room.offsetYGrid + p.y));
    room.piece.spawns.enemy.forEach((p, i) => check(`${room.id} enemy spawn ${i}`, room.offsetXGrid + p.x, room.offsetYGrid + p.y));
  }

  /**
   * The same question for this floor's CHESTS (design/05 "Chest rooms", ENGINE_VERSION 63),
   * kept in its own list so the suite above keeps meaning exactly what it meant.
   *
   * A chest gets a second chance that a spawn point does not: `SpawnSystem` clamps every
   * chest AND every derived plate to walkable ground, so one authored into a pillar does not
   * crash or vanish — it silently slides somewhere else, possibly out of the room it was
   * authored for. That makes the clamp a safety net that HIDES an authoring mistake, which is
   * exactly the kind of thing a content gate has to say out loud.
   *
   * Plates are checked at one through four seats because the ring is derived from the run's
   * seat count, not from the piece: a big chest that fits at two seats can still put a plate
   * in the stone at four, and no test that only ever seats two would see it.
   */
  const chestsUnreachable: string[] = [];
  const chestCheck = (label: string, x: number, y: number) => {
    if (!seen[at(Math.floor(x), Math.floor(y))]) chestsUnreachable.push(`${label} @ (${x}, ${y})`);
  };
  for (const room of placed) {
    for (const c of room.piece.chests ?? []) {
      const gx = room.offsetXGrid + c.x;
      const gy = room.offsetYGrid + c.y;
      chestCheck(`${room.id} ${c.kind} chest`, gx, gy);
      if (c.kind !== 'big') continue;
      for (const seats of [1, 2, 3, 4]) {
        mechanismRing(toFpGrid(gx), toFpGrid(gy), seats).forEach((m, i) =>
          chestCheck(`${room.id} big chest plate ${i}/${seats}`, (m.gx as number) / FP_SCALE, (m.gy as number) / FP_SCALE),
        );
      }
    }
  }

  // Which rooms the flood fill actually walked into — a door that is topologically
  // declared but physically sealed shows up as a room with zero reached cells.
  const roomsEntered = placed.filter((room) =>
    Array.from({ length: room.piece.sizeGrid.h }, (_, y) =>
      Array.from({ length: room.piece.sizeGrid.w }, (_, x) => seen[at(room.offsetXGrid + x, room.offsetYGrid + y)]),
    )
      .flat()
      .some(Boolean),
  ).length;

  /** The same question again for this floor's SHOP counters (design/05 "Shops"), and for the
   *  identical reason: `SpawnSystem` clamps a counter to walkable ground, so one authored into
   *  a pillar slides silently rather than failing. The mat is checked too, not just the centre
   *  point — the panel opens on that ring, so a counter whose mat is half inside stone is a
   *  shop a player can see and only sometimes trade with. */
  const shopsUnreachable: string[] = [];
  for (const room of placed) {
    for (const sh of room.piece.shops ?? []) {
      const gx = room.offsetXGrid + sh.x;
      const gy = room.offsetYGrid + sh.y;
      const probes: [string, number, number][] = [[`${room.id} shop`, gx, gy]];
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        probes.push([`${room.id} shop mat ${dx},${dy}`, gx + dx * SHOP_INTERACT_RANGE_GRID, gy + dy * SHOP_INTERACT_RANGE_GRID]);
      }
      for (const [label, x, y] of probes) {
        if (!seen[at(Math.floor(x), Math.floor(y))]) shopsUnreachable.push(`${label} @ (${x}, ${y})`);
      }
    }
  }

  return { unreachable, chestsUnreachable, shopsUnreachable, roomsEntered, roomCount: placed.length, doorCount: doors.length, W, H };
}

/**
 * The "every door sits on a real shared wall" check, factored out (Task 6) so the
 * branching-variant block below can run the exact same assertion the per-index
 * suite already runs, rather than duplicating it by hand for a map that isn't in
 * `FLOOR_INDICES`.
 */
export function assertDoorsOnSharedWalls(map: DungeonFloorMap, library: readonly RoomPiece[]): void {
  const pieceFor = pieceLookup(library);
  const rect = (id: string) => {
    const room = map.rooms.find((r) => r.id === id);
    if (!room) throw new Error(`door references unknown room '${id}'`);
    const piece = pieceFor(room.pieceId);
    return { x: room.offsetXGrid, y: room.offsetYGrid, w: piece.sizeGrid.w, h: piece.sizeGrid.h };
  };
  for (const door of map.doors) {
    expect(door.roomA).not.toBe(door.roomB);
    const a = rect(door.roomA);
    const b = rect(door.roomB);
    const p = door.passageGrid;
    // Whole cells, not half ones. Nine authored passages carried a `.5` until
    // `ENGINE_VERSION` 44 — see the "no wall run is thinner than one grid cell"
    // test below for what that actually cost.
    for (const [field, value] of Object.entries(p)) {
      expect(Number.isInteger(value), `${door.roomA}/${door.roomB} passageGrid.${field} = ${value}`).toBe(true);
    }
    const vertical = a.x + a.w === b.x || b.x + b.w === a.x;
    const horizontal = a.y + a.h === b.y || b.y + b.h === a.y;
    expect(vertical || horizontal, `${door.roomA}/${door.roomB} do not touch`).toBe(true);
    if (vertical) {
      const boundary = a.x + a.w === b.x ? b.x : a.x;
      // 2 deep, straddling the boundary — cuts BOTH rooms' 1-thick perimeter walls.
      expect(p.w).toBe(2);
      expect(p.x).toBe(boundary - 1);
      expect(p.y).toBeGreaterThanOrEqual(Math.max(a.y, b.y));
      expect(p.y + p.h).toBeLessThanOrEqual(Math.min(a.y + a.h, b.y + b.h));
    } else {
      const boundary = a.y + a.h === b.y ? b.y : a.y;
      expect(p.h).toBe(2);
      expect(p.y).toBe(boundary - 1);
      expect(p.x).toBeGreaterThanOrEqual(Math.max(a.x, b.x));
      expect(p.x + p.w).toBeLessThanOrEqual(Math.min(a.x + a.w, b.x + b.w));
    }
  }
}


export function describeFloorPassability(layouts: readonly { name: string; map: DungeonFloorMap }[], library: readonly RoomPiece[]): void {
describe.each(layouts)('$name door passability', ({ map }) => {

  it('no two rooms overlap', () => {
    expect(overlapping(map, library)).toEqual([]);
  });

  it('every door sits on a real shared wall between the two rooms it names', () => {
    assertDoorsOnSharedWalls(map, library);
  });

  it('every room is reachable through the door graph from the spawn room', () => {
    const adjacency = new Map<string, string[]>(map.rooms.map((r) => [r.id, []]));
    for (const door of map.doors) {
      adjacency.get(door.roomA)?.push(door.roomB);
      adjacency.get(door.roomB)?.push(door.roomA);
    }
    const reached = new Set([map.rooms[0]!.id]);
    const queue = [map.rooms[0]!.id];
    while (queue.length > 0) {
      for (const next of adjacency.get(queue.shift()!) ?? []) {
        if (!reached.has(next)) {
          reached.add(next);
          queue.push(next);
        }
      }
    }
    expect([...map.rooms.map((r) => r.id)].filter((id) => !reached.has(id))).toEqual([]);
  });

  /**
   * The gate the four 16 px-deep wall runs actually needed (`ENGINE_VERSION` 44).
   * Every check above passed while they shipped: the pieces' own `solids` are all
   * whole cells, every door sat on a real shared wall, and every room stayed
   * reachable — the sub-cell walls were BORN in `buildFloorGeometry`, where
   * `carveDoorGaps` cut a half-cell-misaligned hole and the tail of the wall run
   * past it came out 0.5 cells deep.
   *
   * So this asserts the property on the stitched output rather than on any input,
   * and asserts the CLASS (no wall thinner than one cell, none off-grid) rather
   * than the four instances — a hole misaligned some other way, or by some other
   * amount, fails here too. Why it matters past tidiness: a 16 px footprint under
   * a 104 px-tall perimeter run puts a cap band on a third of the depth every wall
   * tone was measured on (design/01-rendering.md "A north-south run is not an
   * east-west wall"), and it is the geometry that made the occlusion x-ray need
   * its second, face-fading pass at all.
   */
  it('no wall run in the stitched geometry is thinner than one grid cell, or lands off-grid', () => {
    const { placed, doors } = placeAuthoredFloor(map, library);
    const { walls } = buildFloorGeometry(placed, doors);
    const offenders = walls
      .filter((w) => w.w < FP_SCALE || w.h < FP_SCALE || [w.x, w.y, w.w, w.h].some((v) => v % FP_SCALE !== 0))
      .map((w) => `${w.w / FP_SCALE}x${w.h / FP_SCALE} @ (${w.x / FP_SCALE}, ${w.y / FP_SCALE})`);
    expect(offenders).toEqual([]);
    expect(walls.length).toBeGreaterThan(0); // the filter is only meaningful over real content
  });

  it('every entrance and every spawn point is physically walkable from the spawn room', () => {
    const { unreachable } = traversability(map, library);
    expect(unreachable).toEqual([]);
  });

  it('every chest and every derived plate stands on walkable ground the run can reach', () => {
    // The clamp in `SpawnSystem` means a chest authored into stone never fails loudly — it
    // just moves. This is where it fails loudly instead.
    const { chestsUnreachable } = traversability(map, library);
    expect(chestsUnreachable).toEqual([]);
  });

  it('every shop counter, and the whole ring its panel opens on, stands on reachable ground', () => {
    const { shopsUnreachable } = traversability(map, library);
    expect(shopsUnreachable).toEqual([]);
  });

  it('the flood fill physically walks into every room — no door is declared but sealed', () => {
    const { roomsEntered, roomCount } = traversability(map, library);
    expect(roomsEntered).toBe(roomCount);
  });

  it('the floor stays inside a sane world extent, starting at the origin', () => {
    expect(Math.min(...map.rooms.map((r) => r.offsetXGrid))).toBe(0);
    expect(Math.min(...map.rooms.map((r) => r.offsetYGrid))).toBe(0);
    const { W, H } = traversability(map, library);
    expect(W).toBeGreaterThan(0);
    expect(H).toBeGreaterThan(0);
  });
});
}

/**
 * Whether `map`'s capstone is still reachable from its spawn room through the door
 * GRAPH (topology only, not the physical geometry — `traversability` above already
 * covers that half) if `excludeRoomId` and every door touching it are removed. This
 * is the executable form of "some floors put the exit at the end so nothing is
 * skippable, some floors let a room in the middle be skipped" (Task 6): a room is
 * genuinely skippable exactly when the capstone stays reachable without it.
 */
export function reachesCapstoneWithout(map: DungeonFloorMap, excludeRoomId: string): boolean {
  const spawnId = map.rooms[0]!.id;
  const capstoneId = map.rooms[map.rooms.length - 1]!.id;
  const adjacency = new Map<string, string[]>(map.rooms.map((r) => [r.id, []]));
  for (const door of map.doors) {
    if (door.roomA === excludeRoomId || door.roomB === excludeRoomId) continue;
    adjacency.get(door.roomA)?.push(door.roomB);
    adjacency.get(door.roomB)?.push(door.roomA);
  }
  const reached = new Set([spawnId]);
  const queue = [spawnId];
  while (queue.length > 0) {
    for (const next of adjacency.get(queue.shift()!) ?? []) {
      if (!reached.has(next)) {
        reached.add(next);
        queue.push(next);
      }
    }
  }
  return reached.has(capstoneId);
}
