// Where a room's wall torches hang (2026-10-10, design/13 "Environment: warm stone, dark edges,
// light pools"). Pure geometry over the wall plan `RoomBuilder` already computes — no Pixi, so the
// rule can be tested without a renderer; `torches.ts` turns these spots into fixtures and lights.
//
// The rule, and why it is this one:
//   - Only PERIMETER runs carry torches. A kerb is 22 px tall and stands between the camera and the
//     player; an interior block is furniture, not the room's enclosure. The perimeter is what the
//     key frame lights, and it is what a torch on a wall is FOR: it says where the room ends.
//   - A north wall hangs its torches on its standing face. An east or west wall shows no face in
//     this projection, so its torches hang on the wall's inner edge, at the same mount height.
//   - Torches are spaced evenly along whatever span is left after the corners and every passage are
//     cleared, so a run's torches are symmetric about its middle rather than packed at one end.
//
// Deterministic from the plan alone: the same floor always hangs the same torches, on every client.
import type { RectPx } from './wallGeometry';
import type { WallRun } from './wallRuns';

/** One torch: where its fixture stands and which wall it hangs on. `x`/`y` are the GROUND point —
 *  the floor line at the wall's foot. `sortY` is the depth it draws at: the ground point for a north
 *  torch, but the wall's own south end for a side torch — a side wall is one entity sorted on its
 *  south edge, so a torch sorted on its own y would draw under the whole wall and vanish. */
export interface TorchSpot {
  readonly x: number;
  readonly y: number;
  readonly sortY: number;
  readonly side: 'north' | 'west' | 'east';
}

/** Target distance between neighbouring torches on one run, world px. About two of the room's
 *  64 px grid cells per hero-width of light: close enough that the pools overlap into a lit band
 *  along the wall, far enough apart that each one still reads as its own source. */
export const TORCH_SPACING = 224;
/** Clear distance kept from a run's end (a room corner) and from either side of a passage. */
export const TORCH_END_CLEAR = 56;
export const TORCH_PASSAGE_CLEAR = 40;
/** A side wall's torches start this far below the room's north edge, so they do not crowd the
 *  north wall's own end torches into the corner. */
export const TORCH_SIDE_NORTH_CLEAR = 120;
/** ...and stop this far above its south edge, where the room is framed by the low kerb. */
export const TORCH_SIDE_SOUTH_CLEAR = 72;
/** The shortest stretch of wall, after clearances, that still gets a torch: two of the room's
 *  64 px cells. Shorter than that, a sconce wedged between a corner and a door reads as clutter. */
export const TORCH_MIN_STRETCH = 64;
/** Slack for "this wall is on this room's edge" — the same 4 px `wallGeometry.wallTier` uses. */
const EDGE_TOLERANCE = 4;

/**
 * Every torch on the floor, for every room at once (the co-resident model, design/05).
 *
 * A run is asked about EVERY room, not the one its centre falls in: `mergeWallRuns` joins two
 * neighbouring rooms' north walls into one run, and a boundary authored as two parallel rects into
 * one mass, so a single run can be the north wall of two rooms, or the east wall of one and the west
 * wall of the next. Each room takes the part of the run along its own edge.
 */
export function planTorches(
  rooms: readonly RectPx[],
  runs: readonly WallRun[],
  passages: readonly RectPx[],
): TorchSpot[] {
  const spots: TorchSpot[] = [];
  for (const run of runs) {
    if (run.tier !== 'perimeter') continue;
    const r = run.rect;
    for (const room of rooms) {
      if (r.w >= r.h) {
        // A north wall: it starts at (or above) the room's top edge and ends inside its upper half.
        const y = r.y + r.h;
        if (r.y > room.y + EDGE_TOLERANCE || y <= room.y || y >= room.y + room.h / 2) continue;
        const lo = Math.max(r.x, room.x) + TORCH_END_CLEAR;
        const hi = Math.min(r.x + r.w, room.x + room.w) - TORCH_END_CLEAR;
        const blocked = passages
          .filter((p) => p.y <= y + EDGE_TOLERANCE && p.y + p.h >= r.y - EDGE_TOLERANCE)
          .map((p) => [p.x - TORCH_PASSAGE_CLEAR, p.x + p.w + TORCH_PASSAGE_CLEAR] as const);
        for (const x of spaced(lo, hi, blocked)) spots.push({ x, y, sortY: y, side: 'north' });
        continue;
      }
      // A side wall: its outer edge on (or beyond) the room's, its inner edge inside the room's
      // own half on that side. The inner edge is where the torch hangs.
      const right = room.x + room.w;
      const west = r.x <= room.x + EDGE_TOLERANCE && r.x + r.w > room.x && r.x + r.w < room.x + room.w / 2;
      const east = r.x + r.w >= right - EDGE_TOLERANCE && r.x < right && r.x > room.x + room.w / 2;
      if (!west && !east) continue;
      const x = west ? r.x + r.w : r.x;
      const lo = Math.max(r.y, room.y + TORCH_SIDE_NORTH_CLEAR);
      const hi = Math.min(r.y + r.h, room.y + room.h - TORCH_SIDE_SOUTH_CLEAR);
      const blocked = passages
        .filter((p) => p.x <= r.x + r.w + EDGE_TOLERANCE && p.x + p.w >= r.x - EDGE_TOLERANCE)
        .map((p) => [p.y - TORCH_PASSAGE_CLEAR, p.y + p.h + TORCH_PASSAGE_CLEAR] as const);
      const sortY = r.y + r.h;
      for (const y of spaced(lo, hi, blocked)) spots.push({ x, y, sortY, side: west ? 'west' : 'east' });
    }
  }
  return spots;
}

/**
 * Evenly spaced positions along `[lo, hi]` with every `blocked` interval cut out, each surviving
 * piece filled on its own. A piece of at least `TORCH_MIN_STRETCH` gets at least one torch, at its
 * middle — the clearances have already been paid, so a short stretch of wall between a corner and
 * a door is a legitimate spot, and it is exactly where a single torch looks placed on purpose.
 * Exported for tests.
 */
export function spaced(lo: number, hi: number, blocked: readonly (readonly [number, number])[]): number[] {
  let pieces: [number, number][] = hi > lo ? [[lo, hi]] : [];
  for (const [b0, b1] of blocked) {
    pieces = pieces.flatMap(([a, b]): [number, number][] => {
      if (b1 <= a || b0 >= b) return [[a, b]];
      const out: [number, number][] = [];
      if (b0 > a) out.push([a, b0]);
      if (b1 < b) out.push([b1, b]);
      return out;
    });
  }
  const out: number[] = [];
  for (const [a, b] of pieces) {
    if (b - a < TORCH_MIN_STRETCH) continue;
    const n = Math.max(1, Math.round((b - a) / TORCH_SPACING));
    for (let k = 0; k < n; k++) out.push(a + ((b - a) * (k + 0.5)) / n);
  }
  return out;
}
