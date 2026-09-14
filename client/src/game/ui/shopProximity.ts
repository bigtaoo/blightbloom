import { SHOP_INTERACT_RANGE_GRID } from '@dd/engine';
import type { Fp, Shop } from '@dd/engine';

/**
 * Which shop counter, if any, a seat is standing at (design/05 "Shops", ENGINE_VERSION 64).
 *
 * Lives here rather than in `HudView` for the reason `pickupProximity.ts` next door records
 * about itself: the agreement between what the panel SHOWS and what the sim ACCEPTS is the one
 * *"tapped it and nothing happened"* mechanism neither package's suite can see on its own, and
 * the test that pins it has to read the real number rather than restate it. Reaching into
 * `HudView` for it would drag Pixi into a pure test.
 *
 * **The radius is the sim's own gate, exactly** — unlike the weapon panel, which deliberately
 * shows from the wider `SIM.lootRevealRadius` so a list has a beat to appear before it is
 * clickable. A shop cannot afford that gap: every row on it costs coins, and a row you can see
 * and tap but not buy is indistinguishable from one you cannot afford. Same ring, same answer.
 */
export const SHOP_PROMPT_RANGE_GRID = SHOP_INTERACT_RANGE_GRID;

/**
 * The nearest shop within reach of (px, py), or `undefined`.
 *
 * `radiusFp` is passed in rather than derived here because the sim's reach test adds the
 * PLAYER'S OWN body radius to it (`ShopSystem.buy`), and this module knows nothing about
 * actors — the caller, which has the seat in hand, does that sum. Squared distance, no sqrt,
 * the same convention the engine's own `geom.ts` follows.
 *
 * Nearest rather than first: two counters could in principle overlap reach, and a panel that
 * picked by array order would flicker between them as the player walked.
 */
export function nearbyShop(
  shops: readonly Shop[],
  px: Fp,
  py: Fp,
  radiusFp: number,
): Shop | undefined {
  const r2 = radiusFp * radiusFp;
  let best: Shop | undefined;
  let bestD2 = Infinity;
  for (const shop of shops) {
    const dx = (shop.gx as number) - (px as number);
    const dy = (shop.gy as number) - (py as number);
    const d2 = dx * dx + dy * dy;
    if (d2 <= r2 && d2 < bestD2) {
      best = shop;
      bestD2 = d2;
    }
  }
  return best;
}
