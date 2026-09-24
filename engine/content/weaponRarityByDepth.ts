/**
 * Weapon rarity distribution shifting toward higher tiers with floor depth (Task 7,
 * "weapon rarity distribution", 2026-09-23) — a hand-authored per-floor-index rarity-
 * tier weight table, expanded into a per-weapon `weightedIndex` weight array, replacing
 * `WEAPON_DROP_POOL`'s old flat, depth-blind `nextInt(pool.length)` pick used by both
 * `ChestSystem`'s chest payout and `content/shops.ts`'s weapon slot. A single
 * `weightedIndex` draw (design/06 draw-count discipline: one draw, whatever the
 * weights), so swapping this in for the old one-draw pick changes no caller's own
 * draw-count contract — `content/shops.ts rollSlot`'s "every category costs exactly one
 * draw after the category pick" shape in particular is exactly why this is built as one
 * weighted draw over all 23 weapons rather than a tier draw plus a within-tier draw.
 *
 * Split out of drops.ts (CLAUDE.md form ① — independent lookup table + roll function,
 * no shared state with the rest of the drop table).
 */
import { RARITY_ORDER, type RarityTier } from '../balance/rarity';
import { WEAPON_SPECS } from './weaponSpecs';
import { WEAPON_DROP_POOL } from './drops';

/** `WEAPON_DROP_POOL` partitioned by its weapons' own intrinsic `rarity`
 *  (`balance/rarity.ts`) — DERIVED from `WEAPON_SPECS`, never hand-duplicated, so a pool
 *  weapon's tier here can never drift from what the catalog actually says. */
export const WEAPON_POOL_BY_RARITY: Readonly<Record<RarityTier, readonly string[]>> = (() => {
  const byTier: Record<RarityTier, string[]> = { common: [], fine: [], epic: [], legend: [], legendary: [] };
  for (const id of WEAPON_DROP_POOL) byTier[WEAPON_SPECS[id]!.rarity]!.push(id);
  return byTier;
})();

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}
function lcm(a: number, b: number): number {
  return (a / gcd(a, b)) * b;
}

/** LCM of every non-empty tier's pool size (derived, not hardcoded), so a per-weapon
 *  weight (`tierWeight * TIER_POOL_SCALE / tierPoolSize`) is always an exact integer —
 *  robust to the pool's composition changing later, not just to its current 1/6/9/6/1
 *  split. */
const TIER_POOL_SCALE = RARITY_ORDER.reduce((scale, tier) => {
  const size = WEAPON_POOL_BY_RARITY[tier].length;
  return size > 0 ? lcm(scale, size) : scale;
}, 1);

/**
 * Per-floor-index rarity-tier weights, floor 0 → floor 4, integer percent points
 * summing to 100 (design/06 "a content weight is an integer permille/percent, never a
 * fraction hiding in a comment"). Hand-authored rather than a formula, the same call as
 * the room-authored enemy-type gradient (Task 2): five floors is few enough to tune
 * directly, and a smooth formula over 5 categorical buckets would read less clearly
 * than five short rows. `common`/`fine` fall and `legend`/`legendary` climb
 * monotonically end to end; `epic` (the pool's biggest bucket, 9 of 23 weapons) rises
 * through the middle floors and gives ground back at floor 4 as `legend`/`legendary`
 * take its share — a moving distribution, not every column climbing at once.
 */
const RARITY_WEIGHTS_BY_FLOOR: readonly (readonly [number, number, number, number, number])[] = [
  [25, 35, 25, 12, 3], // floor 0 — common, fine, epic, legend, legendary
  [18, 32, 30, 16, 4], // floor 1
  [12, 26, 33, 22, 7], // floor 2
  [6, 18, 34, 30, 12], // floor 3
  [2, 10, 28, 38, 22], // floor 4
];

/** Per-floor, per-`WEAPON_DROP_POOL`-index weight arrays for `weightedIndex`, built
 *  once at module load. Every weapon in a tier shares that tier's per-weapon weight, so
 *  the pick is uniform WITHIN a tier and shaped BETWEEN tiers by the table above. */
const WEAPON_WEIGHTS_BY_FLOOR: readonly (readonly number[])[] = RARITY_WEIGHTS_BY_FLOOR.map((tierWeights) => {
  const perTierWeaponWeight = RARITY_ORDER.map((tier, i) => {
    const size = WEAPON_POOL_BY_RARITY[tier].length;
    return size > 0 ? (tierWeights[i]! * TIER_POOL_SCALE) / size : 0;
  });
  return WEAPON_DROP_POOL.map((id) => perTierWeaponWeight[RARITY_ORDER.indexOf(WEAPON_SPECS[id]!.rarity)]!);
});

function weightsForFloor(floorIndex: number): readonly number[] {
  const clamped = Math.max(0, Math.min(WEAPON_WEIGHTS_BY_FLOOR.length - 1, floorIndex));
  return WEAPON_WEIGHTS_BY_FLOOR[clamped]!;
}

/** Slice of `Prng` this needs — same narrowing convention as `DropPrng`/`ShopPrng`. */
export interface WeaponRollPrng {
  weightedIndex(weights: readonly number[]): number;
}

/**
 * Roll one weapon id, weighted toward higher rarity tiers the deeper the floor — a
 * single `weightedIndex` draw, same draw cost as the flat pick this replaces.
 * `floorIndex` is clamped to the authored table's range, so a config with more or
 * fewer floors than level 1's five still gets a sane (floor-0 or floor-4) weighting
 * rather than an out-of-bounds read.
 */
export function rollWeaponId(prng: WeaponRollPrng, floorIndex: number): string {
  return WEAPON_DROP_POOL[prng.weightedIndex(weightsForFloor(floorIndex))]!;
}
