/**
 * Shop content rules (design/05 "Shops") — what a shop room puts on its counter, and what
 * each line costs. The pure half, kept out of the system that applies it for the same reason
 * `content/chests.ts` is: both can then be tested without a `GameState`, and neither can be
 * re-derived slightly differently at a second call site.
 *
 * Split as CLAUDE.md form ① (independent function module): free functions, no shared state,
 * no class, no `GameState` import.
 *
 * ## The composition is FIXED; only the contents roll
 *
 * Every shop stocks exactly three lines, in this order: a **weapon**, a **buff**, and a
 * **supply** (heal, energy, shield, or emp — Task 4 widened the pool once the last two instant
 * items existed). The alternative — three independent draws from one pool — was
 * rejected, and the reason is the job the shop was given: it is the recoverable half of a
 * design that took weapons off the kill table (`content/drops.ts`, 2026-09-14). A floor whose
 * chests rolled badly is meant to be fixable by buying, and a shop that can roll three potions
 * cannot fix it. Fixing the SLOTS also means each line has one price rather than a price band,
 * which is what lets the numbers below be set against measured per-floor coin income instead
 * of against a distribution.
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
import { BUFF_DROP_POOL, WEAPON_DROP_POOL } from './drops';
import type { ShopOffer } from '../state/entities';

/** The slice of `Prng` stocking a shop needs — narrowed like `DropPrng` next door, so a test
 *  can hand it a recording stub and assert the exact draw sequence. */
export interface ShopPrng {
  nextInt(max: number): number;
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

/** The supply slot's own pool (Task 4, `ENGINE_VERSION` 71) — widened from a heal/energy
 *  coin flip to the full set of instant items once `shield`/`emp` existed, so both are
 *  reachable from a shop and not just from a kill. Kept as its own list (not derived from
 *  `SHOP_PRICES`, which also carries `weapon`/`buff`) for the same reason `WEAPON_DROP_POOL`
 *  is its own list rather than every `WEAPON_SPECS` key. */
const SUPPLY_KINDS: readonly ShopOffer['kind'][] = ['heal', 'energy', 'shield', 'emp'];

/**
 * Roll one shop's stock.
 *
 * **Draw count is FIXED at three regardless of what comes up** — one for the weapon id, one
 * for the buff id, one to pick the supply kind — which is the same discipline `rollFloorCardOffer`
 * follows and for the same reason (design/06: a PRNG's draw COUNT is as load-bearing as its
 * values). A shop that spent a variable number of draws would make every later loot roll on
 * the floor depend on what its own shelves happened to contain. The supply draw's DOMAIN grew
 * from 2 to 4 (Task 4) — still one draw, but `nextInt(4)` is a different call than `nextInt(2)`,
 * so any recorded replay whose stream ever reaches a shop diverges from here on.
 *
 * `mkId` mints each offer's id. It is passed in rather than taken off a `GameState` so this
 * stays pure — and the caller passes `GameState.nextShopId`, a SEPARATE id space from
 * `nextId()`, for exactly the reason chests have one: stock is rolled when a floor is placed,
 * before that floor's enemies spawn, and an entity id there would shift every later enemy id
 * — which sets its opening-volley delay (`AIDecideSystem.noticeDelayTicks`). Adding a prop to
 * a room must not retune the room's difficulty.
 */
export function rollShopStock(prng: ShopPrng, mkId: () => number): ShopOffer[] {
  const weaponId = WEAPON_DROP_POOL[prng.nextInt(WEAPON_DROP_POOL.length)]!;
  const buffId = BUFF_DROP_POOL[prng.nextInt(BUFF_DROP_POOL.length)]!;
  const supply = SUPPLY_KINDS[prng.nextInt(SUPPLY_KINDS.length)]!;
  return [
    { id: mkId(), kind: 'weapon', weaponId, price: SHOP_PRICES.weapon, sold: false },
    { id: mkId(), kind: 'buff', buffId, price: SHOP_PRICES.buff, sold: false },
    { id: mkId(), kind: supply, price: SHOP_PRICES[supply], sold: false },
  ];
}

/** Compile-time proof that the fixed composition above and the configured stock size agree.
 *  `SHOP_STOCK_SIZE` is what the render layer sizes its panel from, so the two disagreeing
 *  would be a shop with a row nobody can see or an empty row nobody can buy. */
export const SHOP_STOCK_SIZE_CHECK: 3 = SHOP_STOCK_SIZE;
