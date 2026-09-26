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
/** One floor's tier weights, in `RARITY_ORDER`: common, fine, epic, legend, legendary. */
export type RarityWeightRow = readonly [number, number, number, number, number];

export const DEFAULT_WEAPON_RARITY_BY_DEPTH: readonly RarityWeightRow[] = [
  [25, 35, 25, 12, 3], // floor 0 — common, fine, epic, legend, legendary
  [18, 32, 30, 16, 4], // floor 1
  [12, 26, 33, 22, 7], // floor 2
  [6, 18, 34, 30, 12], // floor 3
  [2, 10, 28, 38, 22], // floor 4
];

/** A tier-weight table expanded into per-floor, per-`WEAPON_DROP_POOL`-index weight arrays
 *  for `weightedIndex`. Every weapon in a tier shares that tier's per-weapon weight, so the
 *  pick is uniform WITHIN a tier and shaped BETWEEN tiers by the table. */
function expand(byDepth: readonly RarityWeightRow[]): readonly (readonly number[])[] {
  return byDepth.map((tierWeights) => {
    const perTierWeaponWeight = RARITY_ORDER.map((tier, i) => {
      const size = WEAPON_POOL_BY_RARITY[tier].length;
      return size > 0 ? (tierWeights[i]! * TIER_POOL_SCALE) / size : 0;
    });
    return WEAPON_DROP_POOL.map((id) => perTierWeaponWeight[RARITY_ORDER.indexOf(WEAPON_SPECS[id]!.rarity)]!);
  });
}

/** Expansions keyed by table IDENTITY, so a `DungeonConfig`'s table (ROADMAP B4, 2026-09-26)
 *  is expanded once per config rather than on every roll. Pure cache — the expansion is a
 *  function of the table alone, so it cannot change what any roll returns. */
const EXPANDED = new WeakMap<readonly RarityWeightRow[], readonly (readonly number[])[]>();

function weightsForFloor(byDepth: readonly RarityWeightRow[], floorIndex: number): readonly number[] {
  let weights = EXPANDED.get(byDepth);
  if (!weights) {
    weights = expand(byDepth);
    EXPANDED.set(byDepth, weights);
  }
  const clamped = Math.max(0, Math.min(weights.length - 1, floorIndex));
  return weights[clamped]!;
}

/**
 * Why a rarity table is unusable, in words — empty when it is fine. For a config's own
 * `weaponRarityByDepth` (ROADMAP B4): at least one row, every weight a non-negative integer
 * (design/06), each row summing to 100 so the table reads as the percentages it claims, and
 * no row that could only roll from an empty tier.
 */
export function rarityTableProblems(byDepth: readonly RarityWeightRow[]): string[] {
  const out: string[] = [];
  if (byDepth.length === 0) out.push('no rows');
  byDepth.forEach((row, floor) => {
    if (row.some((w) => !Number.isInteger(w) || w < 0)) out.push(`floor ${floor}: weights must be non-negative integers`);
    const sum = row.reduce((a, b) => a + b, 0);
    if (sum !== 100) out.push(`floor ${floor}: weights sum to ${sum}, not 100`);
    const live = RARITY_ORDER.some((tier, i) => row[i]! > 0 && WEAPON_POOL_BY_RARITY[tier].length > 0);
    if (!live) out.push(`floor ${floor}: every weighted tier is empty`);
  });
  return out;
}

/** Slice of `Prng` this needs — same narrowing convention as `DropPrng`/`ShopPrng`. */
export interface WeaponRollPrng {
  weightedIndex(weights: readonly number[]): number;
}

/**
 * Roll one weapon id, weighted toward higher rarity tiers the deeper the floor — a
 * single `weightedIndex` draw, same draw cost as the flat pick this replaces.
 * `floorIndex` is clamped to the table's range, so a config with more or fewer floors
 * than rows still gets a sane (first- or last-row) weighting rather than an
 * out-of-bounds read.
 *
 * `byDepth` is the dungeon's own curve (`DungeonConfig.weaponRarityByDepth`, ROADMAP B4,
 * 2026-09-26); a config without one — and every non-dungeon caller — gets the level-1 table.
 */
export function rollWeaponId(
  prng: WeaponRollPrng,
  floorIndex: number,
  byDepth: readonly RarityWeightRow[] = DEFAULT_WEAPON_RARITY_BY_DEPTH,
): string {
  return WEAPON_DROP_POOL[prng.weightedIndex(weightsForFloor(byDepth, floorIndex))]!;
}
