/**
 * Fills a room's sealed pockets with stone (2026-09-30, volume 118) — split out of
 * `launchArena.ts` as a free function (CLAUDE.md form (1)): it reads a room's solids and the
 * map's body flood, and returns the extra solids, with no state of its own.
 *
 * A pocket is floor a body could stand on but never get to (`arenaBodyReach.ts`'s stranded
 * cells). The map still painted it as floor, and until the same day content was placed in it.
 * Filling it makes what the renderer draws agree with where a player can go.
 *
 * Which cells turn to stone:
 *   - a CANDIDATE is a free cell (no solid, no pillar, no hazard) whose stone, brim included,
 *     would take no position away from any body in the main region (`wouldBlockMain`). That is
 *     what keeps the fill from changing a single route, and it is why the band of floor just
 *     north of every block, which a body cannot be centred on but still overlaps, stays floor;
 *   - a SEED is a candidate holding a stranded lattice point, i.e. real pocket floor;
 *   - the fill is every candidate 4-connected to a seed inside the room. That takes in the
 *     pocket cells no body centre fits on either (brim shadow, corners), so the pocket closes
 *     as one block instead of leaving floor islands in the stone.
 *
 * The fill is `freeStanding`: the renderer draws it at interior height like the block it grows
 * out of, so it needs the same north brim, and the candidate test already counted that brim.
 */
import type { AabbGrid, PillarGrid } from '../../content/rooms';
import type { CellTrait } from '../../content/arenas';
import type { BodyReach } from '../../content/arenaBodyReach';
import { blockingRect } from '../../systems/solidBounds';
import { FP_SCALE, type Fp } from '../../math/fixed';
import type { Rect } from './slotGrid';

const G = FP_SCALE;
const HALF = G / 2;

/** Room-relative solids that fill `rect`'s pockets, merged into as few rects as the shape allows. */
export function pocketFill(
  rect: Rect,
  solids: readonly AabbGrid[],
  pillars: readonly PillarGrid[],
  traits: readonly CellTrait[],
  reach: BodyReach,
): AabbGrid[] {
  const { w, h } = rect;
  const taken = new Uint8Array(w * h);
  const mark = (x0: number, y0: number, x1: number, y1: number) => {
    for (let y = Math.max(0, y0); y < Math.min(h, y1); y++) for (let x = Math.max(0, x0); x < Math.min(w, x1); x++) taken[y * w + x] = 1;
  };
  for (const s of solids) mark(s.x, s.y, s.x + s.w, s.y + s.h);
  for (const t of traits) mark(t.rectGrid.x, t.rectGrid.y, t.rectGrid.x + t.rectGrid.w, t.rectGrid.y + t.rectGrid.h);
  // A pillar keeps the cells its disc stands on (its centre is a grid corner): stone is never
  // laid over a pillar, only round it.
  for (const p of pillars) {
    const r = Math.ceil(p.radius);
    mark(p.center.x - r, p.center.y - r, p.center.x + r, p.center.y + r);
  }

  const candidate = new Uint8Array(w * h);
  const seeds: number[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const k = y * w + x;
      if (taken[k]) continue;
      const ax = rect.x + x;
      const ay = rect.y + y;
      const stone = blockingRect({ x: (ax * G) as Fp, y: (ay * G) as Fp, w: G as Fp, h: G as Fp, freeStanding: true });
      if (reach.wouldBlockMain(stone)) continue;
      candidate[k] = 1;
      if (holdsStranded(reach, ax, ay)) seeds.push(k);
    }
  }

  const fill = new Uint8Array(w * h);
  for (const k of seeds) fill[k] = 1;
  const stack = [...seeds];
  while (stack.length > 0) {
    const c = stack.pop()!;
    const x = c % w;
    const y = (c - x) / w;
    for (const n of [x + 1 < w ? c + 1 : -1, x > 0 ? c - 1 : -1, y + 1 < h ? c + w : -1, y > 0 ? c - w : -1]) {
      if (n < 0 || !candidate[n] || fill[n]) continue;
      fill[n] = 1;
      stack.push(n);
    }
  }
  return mergeCells(fill, w, h);
}

/** A stranded lattice point on the closed cell whose top-left grid corner is (ax, ay). */
function holdsStranded(reach: BodyReach, ax: number, ay: number): boolean {
  const per = G / HALF;
  for (let ly = ay * per; ly <= (ay + 1) * per; ly++) {
    for (let lx = ax * per; lx <= (ax + 1) * per; lx++) {
      const k = ly * reach.w + lx;
      if (reach.standable[k] && !reach.main[k]) return true;
    }
  }
  return false;
}

/** Row runs, then runs stacked where the rows below repeat them exactly. Deterministic. */
function mergeCells(cells: Uint8Array, w: number, h: number): AabbGrid[] {
  const used = new Uint8Array(w * h);
  const out: AabbGrid[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!cells[y * w + x] || used[y * w + x]) continue;
      let rw = 1;
      while (x + rw < w && cells[y * w + x + rw] && !used[y * w + x + rw]) rw++;
      let rh = 1;
      const rowFits = (yy: number) => {
        for (let i = 0; i < rw; i++) if (!cells[yy * w + x + i] || used[yy * w + x + i]) return false;
        return true;
      };
      while (y + rh < h && rowFits(y + rh)) rh++;
      for (let yy = y; yy < y + rh; yy++) for (let i = 0; i < rw; i++) used[yy * w + x + i] = 1;
      out.push({ x, y, w: rw, h: rh, freeStanding: true });
    }
  }
  return out;
}
