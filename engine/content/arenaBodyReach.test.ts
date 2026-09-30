/**
 * `measureBodyReach` on geometry built to separate its answers: a pocket behind a one-grid gap
 * that a body passes through, the same gap closed by a free-standing block's north brim, and
 * the one-grid slack that lets a spawn cell's wall-flush corner count as reached.
 */
import { describe, it, expect } from 'vitest';
import type { AABB } from '../state/entities';
import type { Fp } from '../math/fixed';
import { FP_SCALE } from '../math/fixed';
import { measureBodyReach } from './arenaBodyReach';

const G = FP_SCALE;
const rect = (x: number, y: number, w: number, h: number, freeStanding = false): AABB => ({
  x: (x * G) as Fp, y: (y * G) as Fp, w: (w * G) as Fp, h: (h * G) as Fp, ...(freeStanding ? { freeStanding: true } : {}),
});

/**
 * A 20x10 box split at x 10 by a wall with a one-grid gap at y 2..3. West of it is the larger
 * half (the main region); east is the pocket. `brimmed` marks the wall's lower segment
 * free-standing, so its brim reaches north across the gap.
 */
function split(brimmed: boolean) {
  return {
    walls: [
      rect(0, 0, 20, 1), rect(0, 9, 20, 1), rect(0, 0, 1, 10), rect(19, 0, 1, 10),
      rect(10, 0, 1, 2),
      rect(10, 3, 1, 7, brimmed),
    ],
    obstacles: [],
    worldW: 20 * G,
    worldH: 10 * G,
  };
}

describe('measureBodyReach', () => {
  it('lets a body through a one-grid gap', () => {
    const reach = measureBodyReach(split(false));
    expect(reach.reaches(5 * G, 5 * G)).toBe(true);
    expect(reach.reaches(15 * G, 5 * G)).toBe(true);
  });

  it('seals the same gap when the brim of a free-standing block closes it', () => {
    const reach = measureBodyReach(split(true));
    expect(reach.reaches(5 * G, 5 * G)).toBe(true);
    expect(reach.reaches(15 * G, 5 * G)).toBe(false);
    // The pocket is standable floor, just not connected: counted, not merged into the walls.
    expect(reach.strandedCells).toBeGreaterThan(100);
  });

  it('keeps the LARGER half as the main region', () => {
    // Mirror the split so the pocket is west: the answer follows size, not scan order.
    const g = split(true);
    const mirrored = { ...g, walls: g.walls.map((w) => ({ ...w, x: (20 * G - w.x - w.w) as Fp })) };
    mirrored.walls[4] = rect(9, 0, 1, 2);
    mirrored.walls[5] = rect(9, 3, 1, 7, true);
    const reach = measureBodyReach(mirrored);
    // West half is now x 1..9 (8 wide), east 10..19 (9 wide).
    expect(reach.reaches(15 * G, 5 * G)).toBe(true);
    expect(reach.reaches(5 * G, 5 * G)).toBe(false);
  });

  it('counts a point flush against a wall as reached, and one deep inside a solid as not', () => {
    const reach = measureBodyReach(split(false));
    // (1,1): where a room's corner spawn sits, touching the ring. No body centre fits there.
    expect(reach.standable[2 * reach.w + 2]).toBe(0);
    expect(reach.reaches(1 * G, 1 * G)).toBe(true);
    const solid = { ...split(false), walls: [...split(false).walls, rect(3, 3, 5, 5)] };
    expect(measureBodyReach(solid).reaches(5.5 * G, 5.5 * G)).toBe(false);
  });

  it('keeps a body clear of a pillar by the pillar radius plus its own', () => {
    const g = { ...split(false), obstacles: [{ gx: (5 * G) as Fp, gy: (5 * G) as Fp, radius: (G / 2) as Fp }] };
    const reach = measureBodyReach(g);
    // The cell on the pillar and the one half a grid off it are blocked; a full grid off is not.
    expect(reach.standable[10 * reach.w + 10]).toBe(0);
    expect(reach.standable[10 * reach.w + 11]).toBe(0);
    expect(reach.standable[10 * reach.w + 12]).toBe(1);
  });
});
