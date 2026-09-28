import { Container, Graphics } from 'pixi.js';
import type { ArenaMap, RoomId } from '@dd/engine/content/arenas';
import { computeMinimapLayout, type RoomStatus } from './minimapLayout';

const STATUS_COLOR: Record<RoomStatus, number> = {
  safe: 0x2a3140,
  closing: 0xf6ad55, // WARN telegraph tint (matches CONFIG's amber-family fx colours)
  danger: 0x9b2c2c, // already poison
  unvisited: 0x384258, // PvE-only (dungeonRoomStatus) — dim/muted, never a zone read
};

export interface MinimapPlayer {
  roomId: RoomId | undefined;
  alive: boolean;
  isLocal: boolean;
}

/** Shared room-graph minimap for both PvP arenas and PvE dungeon floors (design/10
 * "room progress"; PvE wiring 2026-08-05, retiring the old `FloorProgress` track), a
 * thin Pixi wrapper over the pure `computeMinimapLayout` (minimapLayout.ts). Mode-
 * specific room-status logic (PvP zone read vs PvE activation/combat) lives entirely
 * in the caller's `statusOf` resolver — this widget doesn't know which mode it's
 * drawing, only that every room has SOME `RoomStatus`. */
export class Minimap {
  readonly view = new Container();
  private bg = new Graphics();
  private doors = new Graphics();
  private rooms = new Graphics();
  private dots = new Graphics();
  private box: { w: number; h: number };
  // What each layer last drew, flattened — see update().
  private drawnDoors: number[] | null = null;
  private drawnRooms: number[] | null = null;
  private drawnDots: number[] | null = null;

  constructor(box: { w: number; h: number }) {
    this.box = box;
    this.bg.roundRect(0, 0, box.w, box.h, 6).fill({ color: 0x0b0e14, alpha: 0.7 });
    this.view.addChild(this.bg, this.doors, this.rooms, this.dots);
  }

  update(map: ArenaMap, statusOf: (roomId: RoomId) => RoomStatus, players: readonly MinimapPlayer[]) {
    const layout = computeMinimapLayout(map, this.box);
    const byId = new Map(layout.rooms.map((r) => [r.id, r]));

    // Each layer is redrawn only when what it would draw changed. The HUD calls this every
    // frame (and PvE hands in a freshly converted map every frame), but a cleared Graphics is
    // re-triangulated by the renderer on its next draw — three of them per frame were a real
    // share of the run's garbage for a picture that changes a few times per room.
    const doors: number[] = [];
    for (const d of layout.doors) doors.push(d.x1, d.y1, d.x2, d.y2);
    if (changed(this.drawnDoors, doors)) {
      this.drawnDoors = doors;
      this.doors.clear();
      for (const d of layout.doors) {
        this.doors.moveTo(d.x1, d.y1).lineTo(d.x2, d.y2).stroke({ width: 1, color: 0x4c566a, alpha: 0.8 });
      }
    }

    const rooms: number[] = [];
    for (const r of layout.rooms) {
      const status = statusOf(r.id);
      rooms.push(r.x, r.y, Math.max(1, r.w), Math.max(1, r.h), STATUS_COLOR[status], status === 'danger' ? 0.5 : status === 'unvisited' ? 0.4 : 0.9);
    }
    if (changed(this.drawnRooms, rooms)) {
      this.drawnRooms = rooms;
      this.rooms.clear();
      for (let i = 0; i < rooms.length; i += 6) {
        this.rooms.rect(rooms[i]!, rooms[i + 1]!, rooms[i + 2]!, rooms[i + 3]!).fill({ color: rooms[i + 4]!, alpha: rooms[i + 5]! });
      }
    }

    const dots: number[] = [];
    for (const p of players) {
      if (!p.roomId) continue;
      const r = byId.get(p.roomId);
      if (!r) continue;
      dots.push(r.x + r.w / 2, r.y + r.h / 2, p.isLocal ? 4 : 3, p.isLocal ? 0x68d391 : p.alive ? 0xe2e8f0 : 0x718096);
    }
    if (changed(this.drawnDots, dots)) {
      this.drawnDots = dots;
      this.dots.clear();
      for (let i = 0; i < dots.length; i += 4) this.dots.circle(dots[i]!, dots[i + 1]!, dots[i + 2]!).fill({ color: dots[i + 3]! });
    }
  }
}

/** Whether `next` differs from what was last drawn (`null` = never drawn). */
function changed(prev: readonly number[] | null, next: readonly number[]): boolean {
  if (prev === null || prev.length !== next.length) return true;
  for (let i = 0; i < next.length; i++) if (prev[i] !== next[i]) return true;
  return false;
}
