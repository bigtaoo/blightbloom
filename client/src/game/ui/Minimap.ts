import { Container, Graphics } from 'pixi.js';
import type { ArenaMap, RoomId } from '@dd/engine/content/arenas';
import { drawHudIcon } from './hudIcons';
import { computeMinimapLayout, type RoomMarker, type RoomStatus } from './minimapLayout';

/** How each status paints its room: a fill, and for the PvE buckets an outline.
 * The PvE trio is built to be told apart at a glance (2026-10-03 — before it, a cleared room
 * and an unexplored one were two dark slates 0x2a3140/0x384258 a player could not separate):
 * been-there is LIT, can-go-next is dark with a BRIGHT outline, everything else is dark with
 * a dim outline. No pulsing on the frontier outline — this player is motion-sensitive, and a
 * static contrast step answers "where next" without anything moving on screen. */
const STATUS_STYLE: Record<RoomStatus, { fill: number; alpha: number; stroke?: { color: number; alpha: number; width: number } }> = {
  safe: { fill: 0x2a3140, alpha: 0.9 },
  closing: { fill: 0xf6ad55, alpha: 0.9 }, // WARN telegraph tint (matches CONFIG's amber-family fx colours)
  danger: { fill: 0x9b2c2c, alpha: 0.5 }, // already poison / PvE in combat
  // The dark edge keeps two touching cleared rooms from merging into one lit band.
  cleared: { fill: 0x5a6b8c, alpha: 0.95, stroke: { color: 0x0b0e14, alpha: 0.8, width: 1 } },
  frontier: { fill: 0x1a2030, alpha: 0.85, stroke: { color: 0xe2e8f0, alpha: 0.95, width: 1.5 } },
  unvisited: { fill: 0x10141c, alpha: 0.6, stroke: { color: 0x4c566a, alpha: 0.7, width: 1 } },
};

/** Marker glyph colours. The boss is a hot red; the exit reuses the HUD's own
 * 'floor' glyph (stacked slabs, "deeper") in the portal teal; the shop is the coin chip's own
 * disc, so the map, the wallet chip and the counter all read as one thing; the chest is the
 * chest's wood-and-brass. */
const MARKER_COLOR: Record<RoomMarker, number> = {
  boss: 0xf56565,
  exit: 0x4fd1c5,
  shop: 0xecc94b,
  chest: 0xd69e2e,
};

/** The local player's dot radius, and how far a marker's backing disc reaches past its glyph. */
const LOCAL_DOT_R = 4;
const MARKER_BACKING = 1.5;

const ROOM_STATUSES = Object.keys(STATUS_STYLE) as RoomStatus[];
const MARKERS = Object.keys(MARKER_COLOR) as RoomMarker[];

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
  private markers = new Graphics();
  private box: { w: number; h: number };
  // What each layer last drew, flattened — see update().
  private drawnDoors: number[] | null = null;
  private drawnRooms: number[] | null = null;
  private drawnDots: number[] | null = null;
  private drawnMarkers: number[] | null = null;

  constructor(box: { w: number; h: number }) {
    this.box = box;
    this.bg.roundRect(0, 0, box.w, box.h, 6).fill({ color: 0x0b0e14, alpha: 0.7 });
    // Markers sit under the dots: "where am I" outranks "what is in here". A room roomy
    // enough moves its marker to the corner so the two never meet (see update()).
    this.view.addChild(this.bg, this.doors, this.rooms, this.markers, this.dots);
  }

  update(
    map: ArenaMap,
    statusOf: (roomId: RoomId) => RoomStatus,
    players: readonly MinimapPlayer[],
    markerOf: (roomId: RoomId) => RoomMarker | undefined = () => undefined,
  ) {
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

    // Flattened as x, y, w, h, status index — the style is looked up again at draw time.
    const rooms: number[] = [];
    for (const r of layout.rooms) {
      rooms.push(r.x, r.y, Math.max(1, r.w), Math.max(1, r.h), ROOM_STATUSES.indexOf(statusOf(r.id)));
    }
    if (changed(this.drawnRooms, rooms)) {
      this.drawnRooms = rooms;
      this.rooms.clear();
      for (let i = 0; i < rooms.length; i += 5) {
        const style = STATUS_STYLE[ROOM_STATUSES[rooms[i + 4]!]!];
        const [x, y, w, h] = [rooms[i]!, rooms[i + 1]!, rooms[i + 2]!, rooms[i + 3]!];
        this.rooms.rect(x, y, w, h).fill({ color: style.fill, alpha: style.alpha });
        // Inset by half the stroke so neighbouring rooms' outlines never paint over each other.
        if (style.stroke && w > 2 && h > 2) {
          const k = style.stroke.width / 2;
          this.rooms.rect(x + k, y + k, w - 2 * k, h - 2 * k).stroke(style.stroke);
        }
      }
    }

    // x, y, radius, marker index. The glyph goes in the room's top-right corner when that
    // keeps its backing disc clear of a centred player dot (the local dot, the largest);
    // otherwise it is centred, under the dot. Shipped level-1 rooms land at ~24px here, so
    // both branches are live in a real run, not just in a test.
    const markers: number[] = [];
    for (const r of layout.rooms) {
      const marker = markerOf(r.id);
      if (!marker) continue;
      const radius = Math.max(3, Math.min(6, Math.min(r.w, r.h) * 0.17));
      const cx = r.x + r.w - radius - 1;
      const cy = r.y + radius + 1;
      const clear = Math.hypot(cx - (r.x + r.w / 2), cy - (r.y + r.h / 2)) > radius + MARKER_BACKING + LOCAL_DOT_R;
      markers.push(clear ? cx : r.x + r.w / 2, clear ? cy : r.y + r.h / 2, radius, MARKERS.indexOf(marker));
    }
    if (changed(this.drawnMarkers, markers)) {
      this.drawnMarkers = markers;
      this.markers.clear();
      for (let i = 0; i < markers.length; i += 4) {
        drawMarker(this.markers, MARKERS[markers[i + 3]!]!, markers[i]!, markers[i + 1]!, markers[i + 2]!);
      }
    }

    const dots: number[] = [];
    for (const p of players) {
      if (!p.roomId) continue;
      const r = byId.get(p.roomId);
      if (!r) continue;
      dots.push(r.x + r.w / 2, r.y + r.h / 2, p.isLocal ? LOCAL_DOT_R : 3, p.isLocal ? 0x68d391 : p.alive ? 0xe2e8f0 : 0x718096);
    }
    if (changed(this.drawnDots, dots)) {
      this.drawnDots = dots;
      this.dots.clear();
      for (let i = 0; i < dots.length; i += 4) this.dots.circle(dots[i]!, dots[i + 1]!, dots[i + 2]!).fill({ color: dots[i + 3]! });
    }
  }
}

/** One room marker, inside (cx±r, cy±r), on a dark backing disc so it reads over a lit
 * cleared room and a dark unexplored one alike. */
function drawMarker(g: Graphics, marker: RoomMarker, cx: number, cy: number, r: number): void {
  const color = MARKER_COLOR[marker];
  g.circle(cx, cy, r + MARKER_BACKING).fill({ color: 0x0b0e14, alpha: 0.75 });
  switch (marker) {
    case 'boss':
      // A horned crown — not a skull: the skull is POISON's locked glyph (design/13, see
      // hudIcons' 'enemies' note), and two meanings for one silhouette is the collision to avoid.
      g.poly([
        cx - r, cy + r * 0.7,
        cx - r, cy - r * 0.6,
        cx - r * 0.45, cy - r * 0.05,
        cx, cy - r,
        cx + r * 0.45, cy - r * 0.05,
        cx + r, cy - r * 0.6,
        cx + r, cy + r * 0.7,
      ]).fill({ color });
      break;
    case 'exit':
      drawHudIcon(g, 'floor', cx, cy, r, color);
      break;
    case 'shop':
      drawHudIcon(g, 'coins', cx, cy, r, color);
      break;
    case 'chest':
      // Box with a darker lid band and a brass latch.
      g.rect(cx - r, cy - r * 0.6, r * 2, r * 1.4).fill({ color });
      g.rect(cx - r, cy - r * 0.6, r * 2, r * 0.45).fill({ color: 0x8a5a1c });
      g.rect(cx - r * 0.2, cy - r * 0.3, r * 0.4, r * 0.5).fill({ color: 0xfff6d5 });
      break;
  }
}

/** Whether `next` differs from what was last drawn (`null` = never drawn). */
function changed(prev: readonly number[] | null, next: readonly number[]): boolean {
  if (prev === null || prev.length !== next.length) return true;
  for (let i = 0; i < next.length; i++) if (prev[i] !== next[i]) return true;
  return false;
}
