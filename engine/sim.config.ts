/**
 * Sim tuning — the cross-cutting simulation constants that are neither weapon nor
 * actor content. Weapons + actor stats moved to content/ in Stage C (weapons.ts /
 * players.ts / enemies.ts); the drop table + heal amount moved to content/drops.ts
 * in Stage F. What remains here is the wave-director cadence and the
 * projectile/pickup padding.
 *
 * SPATIAL UNIT (Stage C): grid — 1 fp = 1/1000 grid, 1 grid = 32 px. Ported
 * Stage-B px paddings cross via pxToFp (÷32). Any change here that alters outcomes
 * bumps ENGINE_VERSION.
 */
import { pxToFp, toFpGrid } from './content/convert';

export const SIM = {
  bullet: {
    oobMargin: pxToFp(50), // despawn once this far outside the world
  },
  waveBreakTicks: 24, // 48 frames pause between cleared wave and next spawn
  pickupRadius: pxToFp(15), // collect padding beyond player radius
  // Arena 'crate' reveal ring (design/15) — PickupSystem rolls an unresolved crate's
  // contents the tick any player first comes within this range, same distance as the
  // client's own ground-compare-card ring (game/HudView.ts reads this same constant)
  // so the card never lags a step behind an already-resolved pickup.
  lootRevealRadius: toFpGrid(2.5),
  // EMP grenade instant item (Task 4, ENGINE_VERSION 71) — burst radius from the
  // COLLECTOR's own position, centred on them rather than on the pickup (it is
  // consumed instantly on overlap, so by the time it fires the two positions are the
  // same anyway). ~3.5 grid: wider than any weapon's engage range in this roster
  // (STALKER's 32px/1 grid is the closest, RAVAGER's 40px/1.25 grid the widest) so it
  // reliably catches whatever the player was about to be swarmed by, without reaching
  // clear across a whole authored room (12-24 grid span).
  empRadius: toFpGrid(3.5),
} as const;
