import type { ArenaMap, RoomId } from '@dd/engine/content/arenas';
import type { Chest, Shop, ZoneState } from '@dd/engine';
import type { PlacedRoom } from '@dd/engine/world/dungeon';
import type { DoorRuntime, DungeonRoomRuntime } from '@dd/engine/state/GameState';

// Pure minimap math (design/10 "room progress"), decoupled from Pixi so it's unit-
// testable the same way the engine's own content converters are (content/arenas.ts
// buildArenaGeometry). `computeMinimapLayout`/`roomStatus` are PvP's own math, fed
// straight from `state.arenaMap`/`state.zone` (already the exact `ArenaMap`/`Door`
// shape). `dungeonToArenaMap`/`dungeonRoomStatus` (design/05 "fully-realized
// branching" follow-up, 2026-08-05) are the PvE-side adapter this file used to just
// name as a future follow-up: PvE's placed-room data (`PlacedRoom`/`DoorRuntime`,
// `world/dungeon.ts`/`GameState.ts`) is structurally similar but a distinct type from
// `ArenaMap`, so it converts once here rather than teaching `computeMinimapLayout` two
// input shapes. Both modes now share the exact same `Minimap` Pixi widget
// (`Minimap.ts`) — PvE retired its own separate progress-track widget
// (`FloorProgress.ts`/`floorProgressMath.ts`, deleted this pass) in favor of the real
// spatial map, which a floor with a real fork (siblings placed off the spine's y=0)
// genuinely needs: a linear array-index track can't represent an untaken sibling
// (it'd show as a phantom step, or read "done" once its index is passed).

export interface MinimapRoomLayout {
  id: RoomId;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface MinimapDoorLayout {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface MinimapLayout {
  rooms: MinimapRoomLayout[];
  doors: MinimapDoorLayout[];
}

/** Fit every room's `rectGrid` into `box` (aspect-preserving, centred) — a pure
 * coordinate transform, same offset/scale for rooms and the doors built from them. */
export function computeMinimapLayout(map: ArenaMap, box: { w: number; h: number }): MinimapLayout {
  const { w: mapW, h: mapH } = map.sizeGrid;
  const scale = mapW > 0 && mapH > 0 ? Math.min(box.w / mapW, box.h / mapH) : 0;
  const offX = (box.w - mapW * scale) / 2;
  const offY = (box.h - mapH * scale) / 2;

  const roomsById = new Map<RoomId, MinimapRoomLayout>();
  const rooms = map.rooms.map((r) => {
    const layout: MinimapRoomLayout = {
      id: r.id,
      x: offX + r.rectGrid.x * scale,
      y: offY + r.rectGrid.y * scale,
      w: r.rectGrid.w * scale,
      h: r.rectGrid.h * scale,
    };
    roomsById.set(r.id, layout);
    return layout;
  });

  const doors: MinimapDoorLayout[] = [];
  for (const door of map.doors) {
    const a = roomsById.get(door.roomA);
    const b = roomsById.get(door.roomB);
    if (!a || !b) continue; // malformed door (unknown room id) — content bug, skip rather than throw
    doors.push({ x1: a.x + a.w / 2, y1: a.y + a.h / 2, x2: b.x + b.w / 2, y2: b.y + b.h / 2 });
  }
  return { rooms, doors };
}

// `'cleared'`, `'frontier'` and `'unvisited'` (PvE-only — see `dungeonRoomStatus` below) are
// buckets `roomStatus` (PvP) never produces: a zone has no "haven't been there yet" concept,
// every room is either safe, about to close, or already outside the safe set from the first
// tick. PvE's cleared room is its own bucket rather than PvP's `'safe'` so it can be drawn
// LIT against the dark unexplored rooms without repainting the PvP arena (2026-10-03).
export type RoomStatus = 'safe' | 'closing' | 'danger' | 'cleared' | 'frontier' | 'unvisited';

/** A room's current zone read, for minimap tinting. No `zone` yet (the first tick
 * before ZoneSystem draws the eye, or simply not an arena match) → nothing is unsafe.
 * `closing` only carries meaning during the 'warn' phase (ZoneSystem) — the announced
 * telegraph before those rooms actually go poison at the next 'hold'. */
export function roomStatus(zone: ZoneState | undefined, roomId: RoomId): RoomStatus {
  if (!zone) return 'safe';
  if (zone.phase === 'warn' && zone.closing.includes(roomId)) return 'closing';
  return zone.safe.includes(roomId) ? 'safe' : 'danger';
}

/**
 * Convert PvE's placed-room/door data into the same `ArenaMap` shape
 * `computeMinimapLayout` already consumes for PvP — this file's own header used to
 * name this as the only missing piece, and design/05's "fully-realized branching"
 * pass (2026-08-05) is what made it worth actually writing: a fork's siblings have
 * real, non-zero `offsetYGrid` (stacked off the spine), so a PvE floor is genuinely
 * 2D now, not just a 1D spine a plain progress track could already represent.
 * `Door{roomA,roomB,passageGrid}` is already the exact type PvP uses (design/09
 * "reused verbatim") — `dr.door` needs no field remapping at all.
 *
 * Room offsets can be negative (a fork's siblings are stacked centered on the fork
 * point, so one sibling typically lands above y=0) — `computeMinimapLayout` assumes
 * every room's `rectGrid` sits within `[0,sizeGrid.w] x [0,sizeGrid.h]` (the
 * invariant every hand-authored PvP `ArenaMap` already satisfies), so this shifts
 * every room by the floor's own minimum x/y before handing it off, rather than
 * teaching the layout function about negative offsets. `id`/`spawns`/`eyeCandidates`
 * are inert for minimap purposes (unread by `computeMinimapLayout`) — filled with a
 * placeholder/empty value rather than left to invent meaning that isn't there.
 */
export function dungeonToArenaMap(rooms: readonly PlacedRoom[], doors: readonly DoorRuntime[]): ArenaMap {
  if (rooms.length === 0) {
    return { id: 'dungeon', sizeGrid: { w: 0, h: 0 }, rooms: [], doors: [], spawns: [], eyeCandidates: [] };
  }
  const minX = Math.min(...rooms.map((r) => r.offsetXGrid));
  const minY = Math.min(...rooms.map((r) => r.offsetYGrid));
  const maxX = Math.max(...rooms.map((r) => r.offsetXGrid + r.piece.sizeGrid.w));
  const maxY = Math.max(...rooms.map((r) => r.offsetYGrid + r.piece.sizeGrid.h));
  return {
    id: 'dungeon',
    sizeGrid: { w: maxX - minX, h: maxY - minY },
    rooms: rooms.map((r) => ({
      id: r.id,
      rectGrid: { x: r.offsetXGrid - minX, y: r.offsetYGrid - minY, w: r.piece.sizeGrid.w, h: r.piece.sizeGrid.h },
      solids: r.piece.solids,
    })),
    doors: doors.map((dr) => dr.door),
    spawns: [],
    eyeCandidates: [],
  };
}

/** A PvE room's minimap tint — the same palette `roomStatus` (PvP) already defines,
 * plus the PvE-only buckets (2026-10-03 rework: "unexplored rooms don't read as different,
 * I never know which room to head for next"):
 *   - `'cleared'` = activated, no live enemy — drawn lit.
 *   - `'danger'`  = activated and in combat (`hasLiveEnemy`, the same signal `DoorSystem`
 *     itself locks doors on).
 *   - `'frontier'` = never activated, but one door away from a room that has been — the
 *     rooms a player can walk into NEXT, drawn with a bright outline so the answer to
 *     "where now?" is on the map rather than in the player's memory.
 *   - `'unvisited'` = never activated and not adjacent to anywhere been — dark, outlined
 *     only. Also what an unknown/malformed `roomId` resolves to (same "content bug, don't
 *     crash the widget" tolerance `computeMinimapLayout`'s own door-skip already has).
 * `doors` is optional so a caller with no door data still gets the three-way read; without
 * it nothing is ever `'frontier'`. */
export function dungeonRoomStatus(
  runtimes: readonly DungeonRoomRuntime[],
  indexById: ReadonlyMap<RoomId, number>,
  roomId: RoomId,
  doors: readonly DoorRuntime[] = [],
): RoomStatus {
  const activated = (id: RoomId): boolean => {
    const idx = indexById.get(id);
    return idx !== undefined && runtimes[idx]?.activated === true;
  };
  if (activated(roomId)) {
    const rt = runtimes[indexById.get(roomId)!]!;
    return rt.hasLiveEnemy ? 'danger' : 'cleared';
  }
  if (!indexById.has(roomId)) return 'unvisited';
  for (const { door } of doors) {
    const other = door.roomA === roomId ? door.roomB : door.roomB === roomId ? door.roomA : undefined;
    if (other !== undefined && activated(other)) return 'frontier';
  }
  return 'unvisited';
}

/** What a room HOLDS, as far as the minimap tells it (2026-10-03): the floor's boss, its exit
 * to the next floor, a shop with something still for sale, an unopened chest. */
export type RoomMarker = 'boss' | 'exit' | 'shop' | 'chest';

/**
 * One marker per room, for every room that has one. Priority when a room qualifies twice
 * is boss > exit > shop > chest — the room's reason to exist wins over what it also contains
 * (the big chest the extraction capstone used to carry is the case this was written for).
 *
 * The exit is the floor's capstone: `role: 'extraction'`, or the LAST placed room on a floor
 * whose capstone carries no role — `ExtractionSystem` gates on `dungeonRoomRuntime[length - 1]`
 * whatever the piece says, so the minimap follows the same index. The last floor's boss room
 * "doubles as its own extraction" (design/05) and is marked as the boss. A chest stops
 * counting once opened and a shop once every line is sold: the marker is a reason to walk
 * there, and a spent one is not.
 */
export function dungeonRoomMarkers(
  rooms: readonly PlacedRoom[],
  chests: readonly Pick<Chest, 'roomId' | 'opened'>[],
  shops: readonly Pick<Shop, 'roomId' | 'stock'>[],
): Map<RoomId, RoomMarker> {
  const out = new Map<RoomId, RoomMarker>();
  for (const c of chests) if (!c.opened) out.set(c.roomId, 'chest');
  for (const sh of shops) if (sh.stock.some((o) => !o.sold)) out.set(sh.roomId, 'shop');
  rooms.forEach((r, i) => {
    if (r.piece.role === 'boss') out.set(r.id, 'boss');
    else if (r.piece.role === 'extraction' || i === rooms.length - 1) out.set(r.id, 'exit');
  });
  return out;
}
