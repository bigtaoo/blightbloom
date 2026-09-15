/**
 * Chest prompt proximity (design/05 "Chest rooms", 2026-09-15).
 *
 * Same agreement `shopProximity.test.ts` exists for, with one extra kind: **the ring the
 * caption appears from and the ring `ChestSystem` accepts INTERACT from are the same ring** for
 * a small chest, and for a big one the caption has to survive the player standing on a plate,
 * which is well outside that ring. Both are numbers this package and the engine each own half
 * of, so only a test reading both can prove they agree — and the symptom when they stop is
 * "I stood on it and nothing happened", which is exactly the report this module was written
 * for.
 */
import { describe, it, expect } from 'vitest';
import {
  CHEST_INTERACT_RANGE_GRID,
  CHEST_MECHANISM_RADIUS_GRID,
  CHEST_MECHANISM_RING_GRID,
  toFpGrid,
} from '@dd/engine';
import type { Chest, Fp } from '@dd/engine';
import { nearbyChest, CHEST_BIG_PROMPT_RANGE_GRID, CHEST_PROMPT_RANGE_GRID } from './chestProximity';

const chest = (id: number, gx: number, gy: number, kind: 'small' | 'big' = 'small', opened = false): Chest => ({
  id,
  roomId: 'r1',
  kind,
  gx: toFpGrid(gx),
  gy: toFpGrid(gy),
  mechanisms: kind === 'big' ? [{ gx: toFpGrid(gx + CHEST_MECHANISM_RING_GRID), gy: toFpGrid(gy), occupied: false }] : [],
  opened,
});

const at = (gx: number, gy: number) => ({ gx: toFpGrid(gx) as Fp, gy: toFpGrid(gy) as Fp });

const SMALL_R = toFpGrid(CHEST_PROMPT_RANGE_GRID) as number;
const BIG_R = toFpGrid(CHEST_BIG_PROMPT_RANGE_GRID) as number;

describe('the caption ring IS the sim ring (small chest)', () => {
  it('is exactly CHEST_INTERACT_RANGE_GRID, not a wider "you can see it" ring', () => {
    expect(CHEST_PROMPT_RANGE_GRID).toBe(CHEST_INTERACT_RANGE_GRID);
  });
});

describe('the big chest ring covers the plates it is talking about', () => {
  it('reaches a player standing on the far edge of a mechanism plate', () => {
    // A big chest has no button: it opens when every plate is occupied. Standing on one puts
    // the player CHEST_MECHANISM_RING_GRID from the chest's centre — more than double the
    // small chest's reach — so a caption using the interact range would vanish at the exact
    // moment it is explaining what to do.
    expect(CHEST_BIG_PROMPT_RANGE_GRID).toBeGreaterThanOrEqual(CHEST_MECHANISM_RING_GRID + CHEST_MECHANISM_RADIUS_GRID);
    const p = at(10 + CHEST_MECHANISM_RING_GRID + CHEST_MECHANISM_RADIUS_GRID, 10);
    expect(nearbyChest([chest(1, 10, 10, 'big')], p.gx, p.gy, SMALL_R, BIG_R)?.id).toBe(1);
  });

  it('does NOT widen the small chest with it', () => {
    // The two ranges are separate numbers on purpose. A small chest whose caption showed from
    // four grids away would teach a reach the sim refuses.
    const p = at(10 + CHEST_MECHANISM_RING_GRID, 10);
    expect(nearbyChest([chest(1, 10, 10)], p.gx, p.gy, SMALL_R, BIG_R)).toBeUndefined();
  });
});

describe('nearbyChest', () => {
  it('finds a chest the player is standing on', () => {
    const p = at(10, 10);
    expect(nearbyChest([chest(1, 10, 10)], p.gx, p.gy, SMALL_R, BIG_R)?.id).toBe(1);
  });

  it('returns undefined with nothing in reach', () => {
    const p = at(10, 10);
    expect(nearbyChest([chest(1, 40, 40)], p.gx, p.gy, SMALL_R, BIG_R)).toBeUndefined();
  });

  it('is inclusive AT the radius and exclusive past it', () => {
    // `ChestSystem.openWanted`'s own test is `d2 <= r2`, so this one must be too, or a player
    // on the rim reads a caption the sim refuses — the failure this whole module is about.
    const p = at(10, 10);
    expect(nearbyChest([chest(1, 10 + CHEST_INTERACT_RANGE_GRID, 10)], p.gx, p.gy, SMALL_R, BIG_R)?.id).toBe(1);
    expect(nearbyChest([chest(1, 10 + CHEST_INTERACT_RANGE_GRID + 0.01, 10)], p.gx, p.gy, SMALL_R, BIG_R)).toBeUndefined();
  });

  it('never returns an OPENED chest, even one the player is standing on', () => {
    // An opened chest stays in the world as a landmark (`scene/ChestLayer` draws it emptied).
    // A caption over it would be a prompt for an action that no longer exists.
    const p = at(10, 10);
    expect(nearbyChest([chest(1, 10, 10, 'small', true)], p.gx, p.gy, SMALL_R, BIG_R)).toBeUndefined();
    expect(nearbyChest([chest(2, 10, 10, 'big', true)], p.gx, p.gy, SMALL_R, BIG_R)).toBeUndefined();
  });

  it('picks the NEAREST when two overlap, not the first in the array', () => {
    const p = at(10, 10);
    const far = chest(1, 11, 10);
    const near = chest(2, 10.2, 10);
    expect(nearbyChest([far, near], p.gx, p.gy, SMALL_R, BIG_R)?.id).toBe(2);
    expect(nearbyChest([near, far], p.gx, p.gy, SMALL_R, BIG_R)?.id).toBe(2);
  });

  it('is undefined for an empty chest list', () => {
    const p = at(10, 10);
    expect(nearbyChest([], p.gx, p.gy, SMALL_R, BIG_R)).toBeUndefined();
  });
});
