/**
 * Shop panel proximity (design/05 "Shops", ENGINE_VERSION 64).
 *
 * This module exists because of one agreement that neither package's suite can see on its own:
 * **the ring the panel opens from and the ring `ShopSystem` accepts a tap from are the same
 * ring.** The engine test proves a purchase out of range is refused; the client test proves the
 * panel is shown; only a test that reads BOTH numbers can prove they are the same number — and
 * if they ever diverge the symptom is "I tapped it and nothing happened", which is the hardest
 * class of bug to get a useful report about.
 */
import { describe, it, expect } from 'vitest';
import { SHOP_INTERACT_RANGE_GRID, toFpGrid } from '@dd/engine';
import type { Fp, Shop } from '@dd/engine';
import { nearbyShop, SHOP_PROMPT_RANGE_GRID } from './shopProximity';

const shop = (id: number, gx: number, gy: number): Shop => ({
  id,
  roomId: 'r1',
  gx: toFpGrid(gx),
  gy: toFpGrid(gy),
  stock: [],
});

const at = (gx: number, gy: number) => ({ gx: toFpGrid(gx) as Fp, gy: toFpGrid(gy) as Fp });

describe('the panel ring IS the sim ring', () => {
  it('is exactly SHOP_INTERACT_RANGE_GRID, not a wider "you can see it" ring', () => {
    // The weapon panel deliberately uses the WIDER `SIM.lootRevealRadius` so a list has a beat
    // to appear before it is clickable. A shop cannot afford that gap: every row costs coins,
    // so a row you can see but not buy is indistinguishable from one you cannot afford.
    expect(SHOP_PROMPT_RANGE_GRID).toBe(SHOP_INTERACT_RANGE_GRID);
  });
});

describe('nearbyShop', () => {
  const R = toFpGrid(SHOP_INTERACT_RANGE_GRID) as number;

  it('finds a counter the player is standing on', () => {
    const p = at(10, 10);
    expect(nearbyShop([shop(1, 10, 10)], p.gx, p.gy, R)?.id).toBe(1);
  });

  it('returns undefined with no counter in reach', () => {
    const p = at(10, 10);
    expect(nearbyShop([shop(1, 40, 40)], p.gx, p.gy, R)).toBeUndefined();
  });

  it('is inclusive AT the radius and exclusive past it', () => {
    // The boundary, not a round number — the same reason `shops.test.ts` tests the price at
    // exactly one coin short. `ShopSystem`'s own reach test is `d2 <= r2`, so this one must be
    // too, or a player standing on the rim sees a panel the sim refuses.
    const p = at(10, 10);
    expect(nearbyShop([shop(1, 10 + SHOP_INTERACT_RANGE_GRID, 10)], p.gx, p.gy, R)?.id).toBe(1);
    expect(nearbyShop([shop(1, 10 + SHOP_INTERACT_RANGE_GRID + 0.01, 10)], p.gx, p.gy, R)).toBeUndefined();
  });

  it('picks the NEAREST when two overlap, not the first in the array', () => {
    // Array order would make the panel flicker between two counters as the player walked — and
    // an array-order test would pass today purely because the fixture happens to be sorted.
    const p = at(10, 10);
    const far = shop(1, 11, 10);
    const near = shop(2, 10.2, 10);
    expect(nearbyShop([far, near], p.gx, p.gy, toFpGrid(4) as number)?.id).toBe(2);
    expect(nearbyShop([near, far], p.gx, p.gy, toFpGrid(4) as number)?.id).toBe(2);
  });

  it('is undefined for an empty shop list', () => {
    const p = at(10, 10);
    expect(nearbyShop([], p.gx, p.gy, R)).toBeUndefined();
  });
});
