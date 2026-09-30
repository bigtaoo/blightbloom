/**
 * Where a player's BODY can go on an arena map: the standable floor, flooded from the largest
 * connected piece of it (2026-09-30).
 *
 * `launchArena.ts` places spawns, loot and drop points on cells no solid covers, one room at a
 * time. That is a bullet-sized question, and on the shipped map it had a body-sized answer it
 * never asked about: five pockets no player can walk into (volume 116), two of them sealed only
 * by a free-standing block's north brim, and mobs spawned inside them. A player cannot reach a
 * mob there and the mob cannot reach the player, so the room's encounter never ends and the bot
 * had to learn to walk away from it. This module lets the map builder ask the body question.
 *
 * The test is the one `MovementSystem` enforces: a circle of the player's solid radius against
 * every wall's COLLISION rect (`blockingRect`, so the brim counts) and every pillar. The radius
 * is less a hair (`BODY_CLEARANCE_FP`) so a body sliding along a face is not judged inside it.
 * That is the same figure the PvP bot's `ai/steer.ts` uses, so the bot and the map agree on
 * what is reachable. Cells sit on half-grid points, so the centre of a one-grid gap is a cell.
 *
 * Construction-time only, like every authoring converter (design/09): plain numbers, no PRNG,
 * never called from a system at match time.
 */
import { FP_SCALE } from '../math/fixed';
import { blockingRect, type Bounds } from '../systems/solidBounds';
import type { AABB, Obstacle } from '../state/entities';
import { PLAYER_BASE } from './players';

/** A player's solid radius less a hair (see the header). */
export const BODY_CLEARANCE_FP = (PLAYER_BASE.solidRadius as number) - 10;
/** Lattice spacing: half a grid. */
const CELL_FP = FP_SCALE / 2;
/** How far from a point the nearest reachable cell may be for the point to count as reached:
 *  one grid. A spawn cell's corner sits flush against the wall it was placed next to, where no
 *  body centre fits, and a body one grid away still meets whatever spawns or lands there. */
const SLACK_CELLS = 2;

export interface BodyReach {
  /** Lattice width and height in cells. */
  readonly w: number;
  readonly h: number;
  /** 1 where a body centred on the cell touches no solid. */
  readonly standable: Uint8Array;
  /** 1 where the cell is in the largest connected region of standable cells. */
  readonly main: Uint8Array;
  /** Standable cells outside the main region, counted. */
  readonly strandedCells: number;
  /** Whether a body in the main region can get within one grid of an absolute fp point. */
  reaches(gx: number, gy: number): boolean;
  /** Whether a solid with this collision rect (absolute fp, brim already applied) would take a
   *  cell away from the main region. False means stone there costs no body a place it stood.
   *  (`blockingRect`'s output.) */
  wouldBlockMain(b: Bounds): boolean;
}

/** A body centred at (px, py) touches the rect. */
function touchesRect(b: Bounds, px: number, py: number, r: number): boolean {
  const dx = px - Math.max(b.left, Math.min(px, b.right));
  const dy = py - Math.max(b.top, Math.min(py, b.bottom));
  return dx * dx + dy * dy <= r * r;
}

/** Flood the standable floor of a map's assembled geometry (`buildArenaGeometry`). */
export function measureBodyReach(geo: {
  walls: readonly AABB[];
  obstacles: readonly Obstacle[];
  worldW: number;
  worldH: number;
}): BodyReach {
  const w = Math.floor(geo.worldW / CELL_FP) + 1;
  const h = Math.floor(geo.worldH / CELL_FP) + 1;
  const r = BODY_CLEARANCE_FP;
  const blocked = new Uint8Array(w * h);

  // Each solid visits only the cells near it, tested exactly: the whole-map product is ~30M
  // pairs, and this runs at module load in the client. `visit` stops at the first `true`.
  const near = (x0: number, y0: number, x1: number, y1: number, visit: (k: number, px: number, py: number) => boolean): boolean => {
    const cx0 = Math.max(0, Math.floor((x0 - r) / CELL_FP));
    const cy0 = Math.max(0, Math.floor((y0 - r) / CELL_FP));
    const cx1 = Math.min(w - 1, Math.ceil((x1 + r) / CELL_FP));
    const cy1 = Math.min(h - 1, Math.ceil((y1 + r) / CELL_FP));
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) if (visit(cy * w + cx, cx * CELL_FP, cy * CELL_FP)) return true;
    }
    return false;
  };
  const box = (x0: number, y0: number, x1: number, y1: number, hit: (px: number, py: number) => boolean): void => {
    near(x0, y0, x1, y1, (k, px, py) => {
      if (hit(px, py)) blocked[k] = 1;
      return false;
    });
  };
  for (const wall of geo.walls) {
    const b = blockingRect(wall);
    box(b.left, b.top, b.right, b.bottom, (px, py) => touchesRect(b, px, py, r));
  }
  for (const o of geo.obstacles) {
    box(o.gx - o.radius, o.gy - o.radius, o.gx + o.radius, o.gy + o.radius, (px, py) => {
      return (px - o.gx) ** 2 + (py - o.gy) ** 2 <= (o.radius + r) ** 2;
    });
  }

  const standable = new Uint8Array(w * h);
  for (let k = 0; k < standable.length; k++) standable[k] = blocked[k] ? 0 : 1;

  // 4-neighbour regions; keep the largest. Ties go to the first found, so the answer never
  // depends on anything but the geometry.
  const region = new Int32Array(w * h).fill(-1);
  const sizes: number[] = [];
  const stack: number[] = [];
  for (let k = 0; k < region.length; k++) {
    if (!standable[k] || region[k] !== -1) continue;
    const id = sizes.length;
    let size = 0;
    region[k] = id;
    stack.push(k);
    while (stack.length > 0) {
      const c = stack.pop()!;
      size++;
      const x = c % w;
      const y = (c - x) / w;
      for (const n of [x + 1 < w ? c + 1 : -1, x > 0 ? c - 1 : -1, y + 1 < h ? c + w : -1, y > 0 ? c - w : -1]) {
        if (n < 0 || !standable[n] || region[n] !== -1) continue;
        region[n] = id;
        stack.push(n);
      }
    }
    sizes.push(size);
  }
  let best = -1;
  for (let i = 0; i < sizes.length; i++) if (best < 0 || sizes[i]! > sizes[best]!) best = i;

  const main = new Uint8Array(w * h);
  let strandedCells = 0;
  for (let k = 0; k < main.length; k++) {
    if (region[k] === best) main[k] = 1;
    else if (standable[k]) strandedCells++;
  }

  const reaches = (gx: number, gy: number): boolean => {
    const cx = Math.round(gx / CELL_FP);
    const cy = Math.round(gy / CELL_FP);
    for (let dy = -SLACK_CELLS; dy <= SLACK_CELLS; dy++) {
      for (let dx = -SLACK_CELLS; dx <= SLACK_CELLS; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && y >= 0 && x < w && y < h && main[y * w + x]) return true;
      }
    }
    return false;
  };

  const wouldBlockMain = (b: Bounds): boolean =>
    near(b.left, b.top, b.right, b.bottom, (k, px, py) => main[k] === 1 && touchesRect(b, px, py, r));

  return { w, h, standable, main, strandedCells, reaches, wouldBlockMain };
}
