// Walking to a point without walking into the solid in between — the PvP bot's movement once
// seats spawned apart (2026-09-29). The arena's pillars stand across the straight lines the
// bot walked (a square one sits dead on the axis of the barracks-to-catacombs door, and two
// round ones touch to close off a terraces corner), and `MovementSystem` stops a body pushed
// flat into a face instead of sliding it off. Seats stood pressed against a pillar for whole
// matches while mobs and the zone decided them.
//
// A straight line when one is clear; otherwise an A* search over half-grid cells in
// a box round the bot and its goal, walked by aiming at the furthest cell on the path that is
// in a straight line from here, and skipped outright when the goal lies in another connected
// region of the map (labelled once per geometry). Pure function of GameState, like everything
// the bot does: the caches below only remember what the static geometry answered.
import { FP_SCALE, quantizeMove, type Brad, type GameState } from '@dd/engine';
import type { Point } from './engage';
import { lineOfFireClear, pointClear } from './lineOfFire';

/** The body a walk has to clear: a player's solid circle (`solidRadius`, half a grid), less a
 *  hair so a bot sliding along a face is not judged inside it. At 400 a line the check passed
 *  still clipped a corner the real body caught on, and the seat stood there. */
export const BODY_CLEAR_FP = 490;
/** Search cell size, and how far past the bot and its goal the search box reaches. */
const CELL_FP = FP_SCALE / 2;
const MARGIN_CELLS = 16;
/** Searches remembered per geometry before the memo starts over. */
const PATH_MEMO_SIZE = 4096;
/** Path cells ahead the walk aims along (4 grid). */
const LOOKAHEAD_CELLS = 8;
/** A goal inside a solid (a mob against a wall) is reached at any free cell this close to it. */
const GOAL_SLACK_CELLS = 2;

export type Move = { moveBrad: Brad; moveMag: number };

/** Standing still. */
export const HOLD: Move = { moveBrad: 0 as Brad, moveMag: 0 };

/**
 * The move toward the first of `goals` a body can walk to in a straight line; with none, along
 * the shortest cell path to the nearest of them, or, when none is reachable inside the search
 * box, to the reachable cell closest to one (where a shot may well get through: bullets fly over
 * the brim that walls a body out); null once it stands there. The caller decides what to do
 * then: walking straight at the goal is what pinned seats to a face.
 */
export function steer(s: GameState, me: Point, goals: readonly Point[]): Move | null {
  for (const g of goals) if (walkable(s, me, g)) return toward(me, g);
  const path = cellPath(s, me, goals);
  if (!path || path.length === 0) return null;
  // The furthest of the next few path cells in a straight line from here. Only a few: the path
  // is planned again next tick, and testing the line to every cell of a long one from its far
  // end made this the most expensive thing the bot did.
  for (let i = Math.min(path.length, LOOKAHEAD_CELLS) - 1; i >= 0; i--) if (walkable(s, me, path[i]!)) return toward(me, path[i]!);
  return toward(me, path[0]!);
}

/** Whether a body at `me` can get to `goal` at all, by any route across the map. Some mobs
 *  spawn where no body can follow: a free-standing block's brim can close an authored
 *  one-grid corridor behind it. */
export function reachable(s: GameState, me: Point, goal: Point): boolean {
  return walkable(s, me, goal) || connected(s, me, goal);
}

function walkable(s: GameState, a: Point, b: Point): boolean {
  return lineOfFireClear(s, a, b, BODY_CLEAR_FP, true);
}

function toward(me: Point, g: Point): Move {
  return quantizeMove(g.gx - me.gx, g.gy - me.gy);
}

// Cells are CENTRED on half-grid points, so the centre of a one-grid gap is a cell: a body is
// half a grid wide and fits one exactly, and a cell grid offset by a quarter never did.
const cell = (v: number) => Math.round(v / CELL_FP);

interface Grid {
  stamp: string;
  w: number;
  h: number;
  /** 0 not yet asked, 1 free, 2 blocked. */
  free: Uint8Array;
  /** Connected-region label per free cell, computed the first time a question needs it. */
  region: Int32Array | null;
  /** Searches already run, by start and goal cells: a seat held up behind a solid asks the
   *  same question tick after tick. Cleared when full. */
  paths: Map<string, Point[]>;
}

/**
 * The cell answers for a geometry. Keyed by the arena map when there is one, since every match
 * on it has the same solids (the balance sim plays hundreds), else by the state; either way
 * rebuilt when the solids change count (a PvE door lock). They are only ever what the static
 * geometry answered, so the bot stays a pure function of state.
 */
const grids = new WeakMap<object, Grid>();

function gridOf(s: GameState): Grid {
  const key: object = s.arenaMap ?? s;
  const stamp = `${s.walls.length}:${s.obstacles.length}:${s.worldW}:${s.worldH}`;
  let g = grids.get(key);
  if (!g || g.stamp !== stamp) {
    const w = Math.max(0, cell(s.worldW ?? 0) + 1);
    const h = Math.max(0, cell(s.worldH ?? 0) + 1);
    g = { stamp, w, h, free: new Uint8Array(w * h), region: null, paths: new Map() };
    grids.set(key, g);
  }
  return g;
}

function cellFree(s: GameState, g: Grid, cx: number, cy: number): boolean {
  if (cx < 0 || cy < 0 || cx >= g.w || cy >= g.h) return false;
  const k = cy * g.w + cx;
  let v = g.free[k]!;
  if (v === 0) {
    v = pointClear(s, cx * CELL_FP, cy * CELL_FP, BODY_CLEAR_FP, true) ? 1 : 2;
    g.free[k] = v;
  }
  return v === 1;
}

/** Label every free cell with its connected region (4-neighbour, which is what the 8-neighbour
 *  search with no corner cutting can traverse). Once per geometry. */
function regions(s: GameState, g: Grid): Int32Array {
  if (g.region) return g.region;
  const region = new Int32Array(g.w * g.h).fill(-1);
  const stack: number[] = [];
  let next = 0;
  for (let k = 0; k < region.length; k++) {
    if (region[k] !== -1 || !cellFree(s, g, k % g.w, Math.floor(k / g.w))) continue;
    region[k] = next;
    stack.push(k);
    while (stack.length > 0) {
      const c = stack.pop()!;
      const x = c % g.w;
      const y = Math.floor(c / g.w);
      for (const [dx, dy] of NEIGHBOURS.slice(0, 4)) {
        const nx = x + dx;
        const ny = y + dy;
        const n = ny * g.w + nx;
        if (!cellFree(s, g, nx, ny) || region[n] !== -1) continue;
        region[n] = next;
        stack.push(n);
      }
    }
    next++;
  }
  g.region = region;
  return region;
}

/** The regions of the free cells within `GOAL_SLACK_CELLS` of a point: a body pressed to a face
 *  stands on a cell the clearance test calls blocked, and so can a mob. */
function regionsNear(s: GameState, g: Grid, p: Point): Set<number> {
  const region = regions(s, g);
  const out = new Set<number>();
  const cx = cell(p.gx);
  const cy = cell(p.gy);
  for (let dy = -GOAL_SLACK_CELLS; dy <= GOAL_SLACK_CELLS; dy++) {
    for (let dx = -GOAL_SLACK_CELLS; dx <= GOAL_SLACK_CELLS; dx++) {
      if (cellFree(s, g, cx + dx, cy + dy)) out.add(region[(cy + dy) * g.w + cx + dx]!);
    }
  }
  return out;
}

function connected(s: GameState, a: Point, b: Point): boolean {
  const g = gridOf(s);
  const ra = regionsNear(s, g, a);
  for (const r of regionsNear(s, g, b)) if (ra.has(r)) return true;
  return false;
}

/** Scratch buffers for the search, grown as needed and reused: allocating and clearing a
 *  box-sized array per call was a large share of what the search cost. */
let seen = new Int32Array(0);
let prev = new Int32Array(0);
let cost = new Float64Array(0);
let stampNow = 0;

/**
 * Cell centres from the first step after `me` to a cell at a goal, or, with no path to one in
 * the search box, to the reachable cell nearest a goal. A* over 8-neighbour cells (a diagonal only where both orthogonals are free: never
 * a corner cut), octile distance to the nearest goal as the estimate.
 */
function cellPath(s: GameState, me: Point, goals: readonly Point[]): Point[] {
  const grid = gridOf(s);
  const key = [me, ...goals].map((p) => `${cell(p.gx)},${cell(p.gy)}`).join(';');
  const known = grid.paths.get(key);
  if (known !== undefined) return known;
  if (grid.paths.size >= PATH_MEMO_SIZE) grid.paths.clear();
  const found = search(s, grid, me, goals);
  grid.paths.set(key, found);
  return found;
}

function search(s: GameState, grid: Grid, me: Point, goals: readonly Point[]): Point[] {
  const pts = [me, ...goals];
  const x0 = Math.min(...pts.map((p) => cell(p.gx))) - MARGIN_CELLS;
  const y0 = Math.min(...pts.map((p) => cell(p.gy))) - MARGIN_CELLS;
  const w = Math.max(...pts.map((p) => cell(p.gx))) + MARGIN_CELLS - x0 + 1;
  const h = Math.max(...pts.map((p) => cell(p.gy))) + MARGIN_CELLS - y0 + 1;
  if (seen.length < w * h) {
    seen = new Int32Array(w * h);
    prev = new Int32Array(w * h);
    cost = new Float64Array(w * h);
    stampNow = 0;
  }
  stampNow++;
  const goalCells = goals.map((g) => [cell(g.gx), cell(g.gy)] as const);
  const isGoal = (x: number, y: number) => goalCells.some(([gx, gy]) => Math.abs(gx - x) <= GOAL_SLACK_CELLS && Math.abs(gy - y) <= GOAL_SLACK_CELLS);
  const estimate = (x: number, y: number) => {
    let best = Infinity;
    for (const [gx, gy] of goalCells) {
      const ex = Math.max(0, Math.abs(gx - x) - GOAL_SLACK_CELLS);
      const ey = Math.max(0, Math.abs(gy - y) - GOAL_SLACK_CELLS);
      best = Math.min(best, Math.max(ex, ey) + (Math.SQRT2 - 1) * Math.min(ex, ey));
    }
    return best;
  };

  const start = (cell(me.gy) - y0) * w + (cell(me.gx) - x0);
  seen[start] = stampNow;
  prev[start] = start;
  cost[start] = 0;
  const open = new MinHeap();
  open.push(start, estimate(cell(me.gx), cell(me.gy)));
  let end = -1;
  let closest = start;
  let closestLeft = estimate(cell(me.gx), cell(me.gy));
  while (open.size > 0) {
    const cur = open.pop();
    const x = x0 + (cur % w);
    const y = y0 + Math.floor(cur / w);
    if (cur !== start && isGoal(x, y)) {
      end = cur;
      break;
    }
    const left = estimate(x, y);
    // Strictly closer only: on a tie the bot stays where it stands rather than drifting along
    // the face to a cell no nearer the goal.
    if (left < closestLeft) {
      closest = cur;
      closestLeft = left;
    }
    for (const [dx, dy] of NEIGHBOURS) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < x0 || ny < y0 || nx >= x0 + w || ny >= y0 + h || !cellFree(s, grid, nx, ny)) continue;
      if (dx !== 0 && dy !== 0 && (!cellFree(s, grid, x + dx, y) || !cellFree(s, grid, x, y + dy))) continue;
      const n = (ny - y0) * w + (nx - x0);
      const c = cost[cur]! + (dx !== 0 && dy !== 0 ? Math.SQRT2 : 1);
      if (seen[n] === stampNow && cost[n]! <= c) continue;
      seen[n] = stampNow;
      prev[n] = cur;
      cost[n] = c;
      open.push(n, c + estimate(nx, ny));
    }
  }
  // No way to a goal inside the box: the way to the reachable cell nearest one (empty when the
  // bot already stands on it).
  if (end < 0) end = closest;
  const path: Point[] = [];
  for (let c = end; c !== start; c = prev[c]!) {
    path.push({ gx: (x0 + (c % w)) * CELL_FP, gy: (y0 + Math.floor(c / w)) * CELL_FP });
  }
  return path.reverse();
}

/** A binary min-heap of cell indices by priority; ties go to the lower index, so the search
 *  expands in the same order on every machine. */
class MinHeap {
  private readonly items: number[] = [];
  private readonly keys: number[] = [];
  get size(): number {
    return this.items.length;
  }
  push(item: number, key: number): void {
    const { items, keys } = this;
    let i = items.length;
    items.push(item);
    keys.push(key);
    while (i > 0) {
      const up = (i - 1) >> 1;
      if (!this.less(i, up)) break;
      this.swap(i, up);
      i = up;
    }
  }
  pop(): number {
    const { items, keys } = this;
    const top = items[0]!;
    const lastItem = items.pop()!;
    const lastKey = keys.pop()!;
    if (items.length > 0) {
      items[0] = lastItem;
      keys[0] = lastKey;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < items.length && this.less(l, m)) m = l;
        if (r < items.length && this.less(r, m)) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }
  private less(a: number, b: number): boolean {
    return this.keys[a]! < this.keys[b]! || (this.keys[a] === this.keys[b] && this.items[a]! < this.items[b]!);
  }
  private swap(a: number, b: number): void {
    [this.items[a], this.items[b]] = [this.items[b]!, this.items[a]!];
    [this.keys[a], this.keys[b]] = [this.keys[b]!, this.keys[a]!];
  }
}

const NEIGHBOURS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
] as const;
