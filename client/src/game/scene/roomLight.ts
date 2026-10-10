// New 2026-08-19 (volume pass): a static light pool per room, painted on the floor.
//
// WHY. Measured across a full-floor extract of the shipped level, the floor's luma is 39-53
// EVERYWHERE — every room, every corner, wall-adjacent or open. There is no room-scale lighting
// in the game at all, which has two consequences that no amount of per-object shading can fix:
// every room looks identically lit, so a floor of five rooms reads as one flat sheet with
// furniture on it; and a black cast shadow has nothing to be darker THAN, which is why a wall's
// shadow measured a 5% modulation on the near-black ember floor and simply could not be seen.
//
// design/01 parks a real lightmap layer (multiply-blended, between entities and fx) as a later
// milestone, and this is deliberately NOT that: no light sources, no dynamic contribution, no
// second render target. It is the cheap static half — a soft darkening toward each room's
// perimeter — which buys the two things the milestone was wanted for (a room has a centre and
// corners; a shadow has somewhere brighter to sit against) for a handful of stroked rects on the
// ground layer. The lightmap milestone stays open for the dynamic half.
import type { Graphics } from 'pixi.js';
import type { RectPx } from './wallGeometry';

/** How far the falloff reaches in from the room's edge, as a fraction of its SHORTER side, and
 *  the ceiling on that in world px so a large arena doesn't get an enormous gradient. */
const FALLOFF_FRACTION = 0.2;
const FALLOFF_MAX_PX = 110;
/** Bands, and the alpha the outermost one reaches. Non-overlapping strokes, so each band's alpha
 *  is exactly its ramp value — the same reason the cap gradient and the sphere shading are built
 *  this way. Kept moderate: a wall's base hug and its cast shadow both land in this same region,
 *  and three dark things stacked in one corner reads as a hole rather than as ambience. */
const BANDS = 12;
const EDGE_ALPHA = 0.26;
const LIGHT_COLOR = 0x000000;

/** How hard and how far a room's edges fall off. `wallInset` starts the falloff at the foot of the
 *  room's own walls rather than at its rect: walls are authored INSIDE the room rect, so on a 64 px
 *  north wall the darkest third of the ramp would be painted under stone nobody sees. */
export interface RoomLightStyle {
  readonly edgeAlpha: number;
  readonly fraction: number;
  readonly maxPx: number;
  readonly wallInset: boolean;
}

export const DEFAULT_ROOM_LIGHT: RoomLightStyle = {
  edgeAlpha: EDGE_ALPHA,
  fraction: FALLOFF_FRACTION,
  maxPx: FALLOFF_MAX_PX,
  wallInset: false,
};

/** The warm-stone direction (design/13, 2026-10-10): a light floor under torches, with edges that
 *  fall well into shadow. The key frame's room is lit in its middle and along its torch-hung walls
 *  and dark in its corners; on a light floor the old 0.26 edge barely registers, and the torch
 *  pools then have nothing darker to read against. Deeper and wider, but still a ramp (t²), so the
 *  room's centre is untouched. */
export const WARM_STONE_ROOM_LIGHT: RoomLightStyle = { edgeAlpha: 0.45, fraction: 0.32, maxPx: 180, wallInset: true };

/**
 * Paint one room's falloff into `g` (one shared Graphics for the whole floor, on
 * `layers.ground` above the floor tiling).
 *
 * Concentric stroked rects from the room's own bounds inward, fading to nothing by
 * `FALLOFF_*`. A rect rather than a radial pool because these rooms ARE rectangles and their
 * corners are where the enclosure should read; a circular pool in a square room lights the
 * corners least along the diagonal, which is the wrong axis.
 */
export function drawRoomLight(
  g: Graphics,
  rect: RectPx,
  style: RoomLightStyle = DEFAULT_ROOM_LIGHT,
  walls: readonly RectPx[] = [],
): void {
  const room = style.wallInset ? insetByWalls(rect, walls) : rect;
  const reach = Math.min(style.maxPx, Math.min(room.w, room.h) * style.fraction);
  if (reach <= 0) return;
  const width = reach / BANDS;
  for (let i = 0; i < BANDS; i++) {
    // t: 1 at the room's edge, → 0 at the inner end of the falloff.
    const t = 1 - (i + 0.5) / BANDS;
    const inset = i * width + width / 2;
    g.rect(room.x + inset, room.y + inset, room.w - inset * 2, room.h - inset * 2)
      .stroke({ color: LIGHT_COLOR, width, alpha: t * t * style.edgeAlpha });
  }
}

/** Slack for "this wall hugs this room edge" — the same 4 px `wallGeometry.wallTier` uses. */
const EDGE_TOLERANCE = 4;

/**
 * `room` shrunk, edge by edge, to the foot of the walls standing along it — the floor a player can
 * actually see. A wall counts for an edge when it touches that edge and runs along it (longer than it
 * is deep); the deepest such wall sets the inset. An edge with no wall (a room open onto the next)
 * is left where it is. Exported for tests.
 */
export function insetByWalls(room: RectPx, walls: readonly RectPx[]): RectPx {
  let top = 0;
  let bottom = 0;
  let left = 0;
  let right = 0;
  const x1 = room.x + room.w;
  const y1 = room.y + room.h;
  for (const w of walls) {
    const overlapsX = w.x < x1 && w.x + w.w > room.x;
    const overlapsY = w.y < y1 && w.y + w.h > room.y;
    if (!overlapsX || !overlapsY) continue;
    if (w.w >= w.h) {
      if (Math.abs(w.y - room.y) <= EDGE_TOLERANCE) top = Math.max(top, w.y + w.h - room.y);
      if (Math.abs(w.y + w.h - y1) <= EDGE_TOLERANCE) bottom = Math.max(bottom, y1 - w.y);
    } else {
      if (Math.abs(w.x - room.x) <= EDGE_TOLERANCE) left = Math.max(left, w.x + w.w - room.x);
      if (Math.abs(w.x + w.w - x1) <= EDGE_TOLERANCE) right = Math.max(right, x1 - w.x);
    }
  }
  return {
    x: room.x + left,
    y: room.y + top,
    w: Math.max(0, room.w - left - right),
    h: Math.max(0, room.h - top - bottom),
  };
}
