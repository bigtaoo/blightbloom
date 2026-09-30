/**
 * `pocketFill` on one room built to separate its answers: a pocket sealed only by a
 * free-standing block's north brim is filled, the same room without the brim is not, the floor
 * band north of a block in open floor stays floor, and pillars and hazards are never covered.
 */
import { describe, it, expect } from 'vitest';
import type { AabbGrid, PillarGrid } from '../../content/rooms';
import type { CellTrait } from '../../content/arenas';
import type { Fp } from '../../math/fixed';
import { FP_SCALE } from '../../math/fixed';
import { measureBodyReach } from '../../content/arenaBodyReach';
import { pocketFill } from './pocketFill';

const G = FP_SCALE;
const ROOM = { x: 0, y: 0, w: 20, h: 10 };

/** Room-relative grid solids and pillars as the geometry `measureBodyReach` floods. The room
 *  sits at the origin, so relative and absolute agree. */
function reachOf(solids: readonly AabbGrid[], pillars: readonly PillarGrid[] = []) {
  return measureBodyReach({
    walls: solids.map((s) => ({
      x: (s.x * G) as Fp, y: (s.y * G) as Fp, w: (s.w * G) as Fp, h: (s.h * G) as Fp,
      ...(s.freeStanding ? { freeStanding: true as const } : {}),
    })),
    obstacles: pillars.map((p) => ({ gx: (p.center.x * G) as Fp, gy: (p.center.y * G) as Fp, radius: (p.radius * G) as Fp })),
    worldW: ROOM.w * G,
    worldH: ROOM.h * G,
  });
}

const RING: AabbGrid[] = [
  { x: 0, y: 0, w: 20, h: 1 }, { x: 0, y: 9, w: 20, h: 1 }, { x: 0, y: 0, w: 1, h: 10 }, { x: 19, y: 0, w: 1, h: 10 },
];

/** A wall at x 10 with a one-grid gap at y 2..3; the east half (8 wide) is the smaller one.
 *  `brimmed` marks the lower segment free-standing, so its brim closes the gap to a body. */
function split(brimmed: boolean): AabbGrid[] {
  return [...RING, { x: 10, y: 0, w: 1, h: 2 }, { x: 10, y: 3, w: 1, h: 7, ...(brimmed ? { freeStanding: true } : {}) }];
}

const cells = (fill: readonly AabbGrid[]) => {
  const out = new Set<string>();
  for (const s of fill) for (let y = s.y; y < s.y + s.h; y++) for (let x = s.x; x < s.x + s.w; x++) out.add(`${x},${y}`);
  return out;
};

const strandedIn = (reach: ReturnType<typeof reachOf>) => {
  let n = 0;
  for (let k = 0; k < reach.standable.length; k++) if (reach.standable[k] && !reach.main[k]) n++;
  return n;
};

describe('pocketFill', () => {
  it('fills a pocket the brim seals, and leaves no stranded floor and no lost standing place', () => {
    const solids = split(true);
    const reach = reachOf(solids);
    expect(strandedIn(reach)).toBeGreaterThan(100);
    const fill = pocketFill(ROOM, solids, [], [], reach);
    const filled = cells(fill);
    // The pocket's middle is stone, the main half's middle is not.
    expect(filled.has('15,5')).toBe(true);
    expect(filled.has('5,5')).toBe(false);
    const after = reachOf([...solids, ...fill]);
    expect(strandedIn(after)).toBe(0);
    expect(after.main).toEqual(reach.main);
    // Merged: the pocket's open rectangle is one rect, not a row per line of cells.
    expect(fill.length).toBeLessThanOrEqual(3);
    expect(fill.every((s) => s.freeStanding)).toBe(true);
  });

  it('lays no stone whose own brim would take a standing place', () => {
    // A pocket (x 14..18, y 5..8) sealed by a free-standing column's brim at x 13, beside a
    // block whose brim band (row 4) a body stands just north of. Cell (13,5) joins the pocket,
    // and its bare footprint misses the body at (13.5, 4.5); its brim, which the fill carries,
    // does not. So it stays floor.
    const solids: AabbGrid[] = [
      ...RING,
      { x: 1, y: 5, w: 12, h: 4, freeStanding: true },
      { x: 14, y: 4, w: 5, h: 1 },
      { x: 13, y: 6, w: 1, h: 3, freeStanding: true },
    ];
    const reach = reachOf(solids);
    expect(strandedIn(reach)).toBeGreaterThan(20);
    const fill = pocketFill(ROOM, solids, [], [], reach);
    expect(cells(fill).has('13,5')).toBe(false);
    expect(cells(fill).has('16,7')).toBe(true);
    expect(reachOf([...solids, ...fill]).main).toEqual(reach.main);
  });

  it('fills nothing when the same gap lets a body through', () => {
    const solids = split(false);
    expect(pocketFill(ROOM, solids, [], [], reachOf(solids))).toEqual([]);
  });

  it('leaves the floor band north of a block in open floor alone', () => {
    // No body centre fits on the row just north of a free-standing block, but a body standing
    // further north still overlaps it: stone there would cost that place. Not a pocket.
    const solids = [...RING, { x: 8, y: 5, w: 4, h: 2, freeStanding: true }];
    expect(pocketFill(ROOM, solids, [], [], reachOf(solids))).toEqual([]);
  });

  it('never lays stone over a pillar or a hazard in the pocket', () => {
    const solids = split(true);
    const pillars: PillarGrid[] = [{ center: { x: 15, y: 5 }, radius: 1 }];
    const traits: CellTrait[] = [{ id: 't', rectGrid: { x: 12, y: 7, w: 2, h: 1 }, kind: 'spike', timed: false, damage: 2, damageType: 'physical' }];
    const filled = cells(pocketFill(ROOM, solids, pillars, traits, reachOf(solids, pillars)));
    for (const c of ['14,4', '15,4', '14,5', '15,5', '12,7', '13,7']) expect(filled.has(c)).toBe(false);
    // ...and the pocket round them is still filled.
    expect(filled.has('17,5')).toBe(true);
    expect(filled.has('13,5')).toBe(true);
  });
});
