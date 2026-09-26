/**
 * Shop content rules (design/05 "Shops") — what a shop room puts on its counter, and what
 * each line costs. The pure half, kept out of the system that applies it for the same reason
 * `content/chests.ts` is: both can then be tested without a `GameState`, and neither can be
 * re-derived slightly differently at a second call site.
 *
 * Split as CLAUDE.md form ① (independent function module): free functions, no shared state,
 * no class, no `GameState` import.
 *
 * ## Three slots, each an INDEPENDENT weighted draw (Task 5, `ENGINE_VERSION` 72)
 *
 * Through `ENGINE_VERSION` 71 the three lines were fixed by POSITION — always weapon, buff,
 * supply, in that order, one draw each. Task 5 replaces that with three slots, each drawn
 * independently from the SAME three categories at **60% weapon / 30% item / 10% buff**
 * (`SHOP_SLOT_WEIGHTS`) — so a shop can just as easily come up all weapons as one of each, and
 * three items in a row is rare (0.3³ ≈ 2.7%) but not excluded; a shop is never re-rolled or
 * padded to avoid it. "item" is `heal`/`energy`/`shield`/`emp` together (Task 4's four instant
 * items) — a second, INDEPENDENT draw within the slot decides which. The weights favor weapons
 * because the shop's original job stands: it is the recoverable half of a design that took
 * weapons off the kill table (`content/drops.ts`, 2026-09-14), and a floor whose chests rolled
 * badly still needs buying a gun to be the likely outcome, not a coin flip against a potion.
 *
 * What is deliberately NOT fixed is whether you can afford all three. At the first-pass prices
 * a measured floor's income buys roughly one line and a bit, so the shop is a choice — which
 * is the thing `ROADMAP` B2 says the run-buff layer has never been.
 */
import {
  SHOP_PRICE_BUFF,
  SHOP_PRICE_EMP,
  SHOP_PRICE_SUPPLY,
  SHOP_PRICE_WEAPON,
  SHOP_STOCK_SIZE,
} from '../config';
import { BUFF_DROP_POOL, CARD_ONLY_BUFF_IDS } from './drops';
import { rollWeaponId, type RarityWeightRow } from './weaponRarityByDepth';
import type { ShopOffer } from '../state/entities';

/** The slice of `Prng` stocking a shop needs — narrowed like `DropPrng` next door, so a test
 *  can hand it a recording stub and assert the exact draw sequence. `weightedIndex` was added
 *  alongside `nextInt` for Task 7's `rollWeaponId` (weapon rarity by floor depth) — still one
 *  draw either way, so the "always two draws per slot" shape below is unaffected. */
export interface ShopPrng {
  nextInt(max: number): number;
  weightedIndex(weights: readonly number[]): number;
}

/**
 * The prices, as a lookup rather than a `switch`, so that `SHOP_PRICE_*` and the offer kinds
 * cannot drift apart silently — adding a fourth kind fails to compile here rather than
 * quietly selling for zero.
 */
export const SHOP_PRICES: Record<ShopOffer['kind'], number> = {
  weapon: SHOP_PRICE_WEAPON,
  buff: SHOP_PRICE_BUFF,
  heal: SHOP_PRICE_SUPPLY,
  energy: SHOP_PRICE_SUPPLY,
  shield: SHOP_PRICE_SUPPLY,
  emp: SHOP_PRICE_EMP,
};

/** The item slot's own pool (Task 4's four instant items) — kept as its own list (not derived
 *  from `SHOP_PRICES`, which also carries `weapon`/`buff`) for the same reason `WEAPON_DROP_POOL`
 *  is its own list rather than every `WEAPON_SPECS` key. */
const ITEM_KINDS: readonly ShopOffer['kind'][] = ['heal', 'energy', 'shield', 'emp'];

/** The three category weights, as integer PERCENT points out of `SHOP_SLOT_WEIGHT_TOTAL`
 *  (design/06 "a content weight is an integer permille/percent, never a fraction hiding in a
 *  comment") — `shops.test.ts` pins that the three below still sum to it. */
export const SHOP_SLOT_WEIGHT_WEAPON = 60;
export const SHOP_SLOT_WEIGHT_ITEM = 30;
export const SHOP_SLOT_WEIGHT_BUFF = 10;
const SHOP_SLOT_WEIGHT_TOTAL = SHOP_SLOT_WEIGHT_WEAPON + SHOP_SLOT_WEIGHT_ITEM + SHOP_SLOT_WEIGHT_BUFF;

/** One `nextInt(SHOP_SLOT_WEIGHT_TOTAL)` draw, bucketed by cumulative range — always exactly
 *  one draw regardless of which category comes up (design/06: draw COUNT is as load-bearing
 *  as the values it produces). The last bucket is the unconditional remainder rather than a
 *  third explicit range check: the three weights are pinned to sum to the total, so whatever
 *  the first two ranges do not claim is buff's by construction, with nothing left over to
 *  fall through to. */
function rollSlotCategory(prng: ShopPrng): 'weapon' | 'item' | 'buff' {
  const roll = prng.nextInt(SHOP_SLOT_WEIGHT_TOTAL);
  if (roll < SHOP_SLOT_WEIGHT_WEAPON) return 'weapon';
  if (roll < SHOP_SLOT_WEIGHT_WEAPON + SHOP_SLOT_WEIGHT_ITEM) return 'item';
  return 'buff';
}

/**
 * The buff line's pick-one-of-three (ROADMAP B2, decided and built 2026-09-26): the line offers
 * three DISTINCT buffs and the buyer takes one at the line's single price — the floor card's
 * shape, at a counter. The pool is every run buff, card-only `cell_up` included: it was kept
 * off the kill table because +max energy is worthless to a player on the starter blaster, and
 * `balance/floorCards.ts` names a pick-one-of-three as exactly where such a conditional reward
 * belongs. This is one.
 */
export const SHOP_BUFF_POOL: readonly string[] = [...BUFF_DROP_POOL, ...CARD_ONLY_BUFF_IDS];
export const SHOP_BUFF_CHOICES = 3;

function binomial(n: number, k: number): number {
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return Math.round(r);
}

/** How many distinct three-buff lines the pool can produce — the range of the ONE draw below. */
export const SHOP_BUFF_COMBINATIONS = binomial(SHOP_BUFF_POOL.length, SHOP_BUFF_CHOICES);

/**
 * The `index`-th `k`-subset of `pool`, in lexicographic order of positions, `0 <= index <
 * C(pool.length, k)`. How the three choices come out of a SINGLE draw: every slot still costs
 * exactly two draws whatever its category (see `rollSlot`), which three independent picks with
 * re-draws on a repeat could never promise. Pure integer arithmetic, so every platform agrees.
 */
export function combinationAt<T>(pool: readonly T[], k: number, index: number): T[] {
  const out: T[] = [];
  let rest = index;
  let start = 0;
  for (let slot = 0; slot < k; slot++) {
    for (let i = start; i < pool.length; i++) {
      const block = binomial(pool.length - i - 1, k - slot - 1);
      if (rest < block) {
        out.push(pool[i]!);
        start = i + 1;
        break;
      }
      rest -= block;
    }
  }
  return out;
}

/**
 * One slot: a category draw, then a SECOND draw picking the specific id/kind within it —
 * always two draws, whichever category comes up, so a shop's total draw count never depends
 * on what its own shelves happened to roll (same discipline `rollFloorCardOffer` follows, and
 * for the same reason: a variable draw count would make every later loot roll on the floor
 * depend on what this shop's stock happened to be).
 */
function rollSlot(prng: ShopPrng, mkId: () => number, floorIndex: number, byDepth?: readonly RarityWeightRow[]): ShopOffer {
  const category = rollSlotCategory(prng);
  if (category === 'weapon') {
    const weaponId = rollWeaponId(prng, floorIndex, byDepth);
    return { id: mkId(), kind: 'weapon', weaponId, price: SHOP_PRICES.weapon, sold: false };
  }
  if (category === 'buff') {
    const id = mkId();
    const picked = combinationAt(SHOP_BUFF_POOL, SHOP_BUFF_CHOICES, prng.nextInt(SHOP_BUFF_COMBINATIONS));
    const choices = picked.map((buffId) => ({ id: mkId(), buffId }));
    return { id, kind: 'buff', choices, price: SHOP_PRICES.buff, sold: false };
  }
  const kind = ITEM_KINDS[prng.nextInt(ITEM_KINDS.length)]!;
  return { id: mkId(), kind, price: SHOP_PRICES[kind], sold: false };
}

/**
 * Roll one shop's stock — three independent `rollSlot` calls, six `Prng` draws total, always
 * (`SHOP_STOCK_SIZE_CHECK` pins the slot count against the render layer's own).
 *
 * `mkId` mints each offer's id. It is passed in rather than taken off a `GameState` so this
 * stays pure — and the caller passes `GameState.nextShopId`, a SEPARATE id space from
 * `nextId()`, for exactly the reason chests have one: stock is rolled when a floor is placed,
 * before that floor's enemies spawn, and an entity id there would shift every later enemy id
 * — which sets its opening-volley delay (`AIDecideSystem.noticeDelayTicks`). Adding a prop to
 * a room must not retune the room's difficulty.
 *
 * `floorIndex` (Task 7, weapon rarity by depth) only ever reaches a weapon slot's
 * `rollWeaponId` — passing it through for buff/item slots that never read it costs
 * nothing and keeps `rollSlot`'s signature uniform across categories.
 */
export function rollShopStock(
  prng: ShopPrng,
  mkId: () => number,
  floorIndex: number,
  byDepth?: readonly RarityWeightRow[],
): ShopOffer[] {
  return [rollSlot(prng, mkId, floorIndex, byDepth), rollSlot(prng, mkId, floorIndex, byDepth), rollSlot(prng, mkId, floorIndex, byDepth)];
}

/** Compile-time proof that the slot count above and the configured stock size agree.
 *  `SHOP_STOCK_SIZE` is what the render layer sizes its panel from, so the two disagreeing
 *  would be a shop with a row nobody can see or an empty row nobody can buy. */
export const SHOP_STOCK_SIZE_CHECK: 3 = SHOP_STOCK_SIZE;
