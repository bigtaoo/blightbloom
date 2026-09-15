/**
 * Big-chest caption proximity (design/05 "Chest rooms", 2026-09-15, `ENGINE_VERSION` 66).
 *
 * Two agreements neither package's suite can see on its own:
 *
 *   - **the range covers the plates the caption is about.** A big chest opens from its
 *     mechanism ring, not from arm's length, so a range borrowed from the small chest's old
 *     interact gate would hide the panel at the exact moment the player walked out to a plate.
 *   - **a small chest never prompts at all.** It opens on approach now, so a caption for one
 *     could only appear on the frame it opened. The case below is what stops the deleted
 *     "Press E" prompt from creeping back in through this function.
 */
import { describe, it, expect } from 'vitest';
import { CHEST_MECHANISM_RADIUS_GRID, CHEST_MECHANISM_RING_GRID, toFpGrid } from '@dd/engine';
import type { Chest, Fp } from '@dd/engine';
import { nearbyBigChest, CHEST_PLATE_PROMPT_RANGE_GRID } from './chestProximity';

const chest = (id: number, gx: number, gy: number, kind: 'small' | 'big' = 'big', opened = false): Chest => ({
  id,
  roomId: 'r1',
  kind,
  gx: toFpGrid(gx),
  gy: toFpGrid(gy),
  mechanisms: kind === 'big' ? [{ gx: toFpGrid(gx + CHEST_MECHANISM_RING_GRID), gy: toFpGrid(gy), occupied: false }] : [],
  opened,
});

const at = (gx: number, gy: number) => ({ gx: toFpGrid(gx) as Fp, gy: toFpGrid(gy) as Fp });

const R = toFpGrid(CHEST_PLATE_PROMPT_RANGE_GRID) as number;

describe('the range covers the plates it is talking about', () => {
  it('is the mechanism ring plus a plate radius', () => {
    expect(CHEST_PLATE_PROMPT_RANGE_GRID).toBe(CHEST_MECHANISM_RING_GRID + CHEST_MECHANISM_RADIUS_GRID);
  });

  it('still shows for a player standing on the far edge of a plate', () => {
    const p = at(10 + CHEST_MECHANISM_RING_GRID + CHEST_MECHANISM_RADIUS_GRID, 10);
    expect(nearbyBigChest([chest(1, 10, 10)], p.gx, p.gy, R)?.id).toBe(1);
  });
});

describe('nearbyBigChest', () => {
  it('finds a chest the player is standing on', () => {
    const p = at(10, 10);
    expect(nearbyBigChest([chest(1, 10, 10)], p.gx, p.gy, R)?.id).toBe(1);
  });

  it('returns undefined with nothing in range', () => {
    const p = at(10, 10);
    expect(nearbyBigChest([chest(1, 40, 40)], p.gx, p.gy, R)).toBeUndefined();
  });

  it('is inclusive AT the radius and exclusive past it', () => {
    const p = at(10, 10);
    expect(nearbyBigChest([chest(1, 10 + CHEST_PLATE_PROMPT_RANGE_GRID, 10)], p.gx, p.gy, R)?.id).toBe(1);
    expect(nearbyBigChest([chest(1, 10 + CHEST_PLATE_PROMPT_RANGE_GRID + 0.01, 10)], p.gx, p.gy, R)).toBeUndefined();
  });

  it('never returns a SMALL chest, even one the player is standing on', () => {
    // A small chest opens on approach (`ENGINE_VERSION` 66): by the time a caption for it could
    // be drawn, it is open. This is the assertion that keeps the deleted prompt deleted.
    const p = at(10, 10);
    expect(nearbyBigChest([chest(1, 10, 10, 'small')], p.gx, p.gy, R)).toBeUndefined();
  });

  it('never returns an OPENED chest, even one the player is standing on', () => {
    // An opened chest stays in the world as a landmark (`scene/ChestLayer` draws it emptied),
    // and its plates keep updating — but there is nothing left to coordinate.
    const p = at(10, 10);
    expect(nearbyBigChest([chest(1, 10, 10, 'big', true)], p.gx, p.gy, R)).toBeUndefined();
  });

  it('never returns a big chest with no plates at all', () => {
    // `ChestSystem` cannot open one (its `every` over an empty ring is vacuously true, which is
    // why the length check exists there too), so a caption would be counting toward a gate that
    // never opens: "Plates held 0/0" forever.
    const p = at(10, 10);
    const plateless = { ...chest(1, 10, 10), mechanisms: [] };
    expect(nearbyBigChest([plateless], p.gx, p.gy, R)).toBeUndefined();
  });

  it('picks the NEAREST when two overlap, not the first in the array', () => {
    const p = at(10, 10);
    const far = chest(1, 13, 10);
    const near = chest(2, 10.2, 10);
    expect(nearbyBigChest([far, near], p.gx, p.gy, R)?.id).toBe(2);
    expect(nearbyBigChest([near, far], p.gx, p.gy, R)?.id).toBe(2);
  });

  it('is undefined for an empty chest list', () => {
    const p = at(10, 10);
    expect(nearbyBigChest([], p.gx, p.gy, R)).toBeUndefined();
  });
});
