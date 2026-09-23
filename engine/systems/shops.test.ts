/**
 * Shops (design/05 "Shops", 2026-09-14) — the unit half.
 *
 * Every assertion here is a REFUSAL or a payment, and they are here rather than in the golden
 * gate for the reason `chests.test.ts` states next door: a refusal is a branch whose line runs
 * on every tick while only the taken side is ever exercised, which CLAUDE.md names as the
 * column that bites. `ShopSystem.buy` is four refusals in a row (sold / room / range / price)
 * plus a fifth for an instant item that would do nothing, and a golden run that simply never
 * taps a counter leaves all five green.
 *
 * The controls matter as much as the cases: every refusal test asserts the wallet is UNCHANGED
 * as well as the offer unsold, because "did not deliver" and "did not charge" are two different
 * bugs, and a test that only checked the first would pass for a shop that takes your money and
 * hands you nothing.
 */
import { describe, it, expect } from 'vitest';
import { toFp } from '@dd/engine/math/fixed';
import type { Brad } from '@dd/engine/math/trig';
import { toFpGrid } from '@dd/engine/content/convert';
import { freshStatus } from '@dd/engine/content/damage';
import { PLAYER_BASE } from '@dd/engine/content/players';
import { BASE_MAX_ENERGY, ENERGY_PICKUP_AMOUNT } from '@dd/engine/balance/energy';
import { makeWeapon, BLASTER_SIM } from '@dd/engine/content/weapons';
import { createGameState } from '@dd/engine/state/GameState';
import type { GameState } from '@dd/engine/state/GameState';
import type { PlayerActor, Shop, ShopOffer } from '@dd/engine/state/entities';
import { ShopSystem } from '@dd/engine/systems';
import {
  rollShopStock,
  SHOP_PRICES,
  SHOP_SLOT_WEIGHT_WEAPON,
  SHOP_SLOT_WEIGHT_ITEM,
  type ShopPrng,
} from '@dd/engine/content/shops';
import { WEAPON_DROP_POOL, BUFF_DROP_POOL, HEAL_PICKUP_AMOUNT, SHIELD_PICKUP_AMOUNT } from '@dd/engine/content/drops';
import { WEAPON_SPECS } from '@dd/engine/content/weaponSpecs';
import { SHOP_INTERACT_RANGE_GRID, SHOP_STOCK_SIZE } from '@dd/engine/config';
import { Prng } from '@dd/engine/math/prng';
import { buildEnemyActor } from '@dd/engine/content/enemies';

const CFG = { seed: 11, worldW: 2400, worldH: 2400, waves: [] as const };
const sys = new ShopSystem();

/** Sequential id minter, the shape `rollShopStock` takes for `mkId`. */
const ids = () => {
  let n = 1;
  return () => n++;
};

/** A state with NO seats — same reasoning as `chests.test.ts`: `createGameState` always builds
 *  one, and a test that reads as "one player" while running with two pins a different number
 *  than it names. */
const state = (): GameState => {
  const s = createGameState(CFG);
  s.players.length = 0;
  return s;
};

function addPlayer(s: GameState, gx: number, gy: number, coins = 1000): PlayerActor {
  const w = makeWeapon(BLASTER_SIM);
  const p: PlayerActor = {
    id: s.nextId(), faction: 'player', teamId: 0,
    gx: toFpGrid(gx), gy: toFpGrid(gy), z: toFp(0), vx: toFp(0), vy: toFp(0),
    knockVx: toFp(0), knockVy: toFp(0),
    facing: 0 as Brad, hp: 3, maxHp: 6, shield: 0, maxShield: 0, ticksSinceHit: 0,
    radius: PLAYER_BASE.radius, footprintRadius: PLAYER_BASE.footprintRadius,
    solidRadius: PLAYER_BASE.solidRadius,
    alive: true, weapon: w, weapons: [w], activeSlot: 0, buffs: [],
    energy: 0, maxEnergy: BASE_MAX_ENERGY, coins, shopBuyId: 0,
    firing: false, interacting: false, pickupTargetId: 0, cardVote: 0,
    confirmExtract: false, confirmDescend: false,
    downed: false, bleedoutTicks: 0, reviveProgressTicks: 0,
    bandages: 0, prevButtons: 0, status: freshStatus(),
    floorMaterials: {}, bankedMaterials: {}, blueprintPickup: null,
  };
  s.players.push(p);
  return p;
}

/** A shop at a GRID position, stocked by hand. `roomId` is one no `dungeonRoomIndexById`
 *  knows, so these run through `roomActive`'s "no room runtime" arm — the activation gate has
 *  its own case below, built with a real runtime. */
function addShop(s: GameState, gx: number, gy: number, stock: Partial<ShopOffer>[]): Shop {
  const shop: Shop = {
    id: s.nextShopId(),
    roomId: 'no_such_room',
    gx: toFpGrid(gx),
    gy: toFpGrid(gy),
    stock: stock.map((o) => ({
      id: s.nextShopId(),
      kind: o.kind ?? 'heal',
      weaponId: o.weaponId,
      buffId: o.buffId,
      price: o.price ?? 10,
      sold: o.sold ?? false,
    })),
  };
  s.shops.push(shop);
  return shop;
}

/** A controllable stand-in for `Prng` — returns exactly the values it is given, in order,
 *  regardless of `max` (every call site here only ever needs the value, never the modulus
 *  it was drawn against). Lets the category-boundary test below assert the EXACT roll each
 *  bucket edge belongs to, deterministically, rather than hoping a seed sweep happens to
 *  land on it. */
class FixedRoll implements ShopPrng {
  private i = 0;
  constructor(private readonly values: readonly number[]) {}
  nextInt(): number {
    const v = this.values[this.i++];
    if (v === undefined) throw new Error('FixedRoll: ran out of scripted draws');
    return v;
  }
  // Mirrors the real Prng.weightedIndex exactly, but consumes the next SCRIPTED value
  // as the roll rather than drawing nextInt(total) internally — a test can still script
  // an exact "roll" and see exactly which weight bucket it lands in.
  weightedIndex(weights: readonly number[]): number {
    let roll = this.nextInt();
    for (let i = 0; i < weights.length; i++) {
      roll -= weights[i]!;
      if (roll < 0) return i;
    }
    return weights.length - 1;
  }
}

describe('rollShopStock — three independently-weighted slots (Task 5, ENGINE_VERSION 72)', () => {
  it('draws each slot independently — all three can land on the same category', () => {
    // Roll 0 is inside every category's own range at its low edge, so three (category,
    // sub-pick) pairs of (0, 0) forces all three slots to weapon — the case the OLD fixed
    // weapon/buff/supply composition could never produce at all.
    const stock = rollShopStock(new FixedRoll([0, 0, 0, 0, 0, 0]), ids(), 0);
    expect(stock.map((o) => o.kind)).toEqual(['weapon', 'weapon', 'weapon']);
  });

  it("the category boundaries are exactly 0-59 weapon / 60-89 item / 90-99 buff", () => {
    // Only slot 0 is inspected; slots 1-2 are scripted identically so `rollShopStock`'s fixed
    // six-draw shape has values to consume without affecting what is being asserted.
    const categoryOf = (roll: number): string => rollShopStock(new FixedRoll([roll, 0, roll, 0, roll, 0]), ids(), 0)[0]!.kind;
    expect(categoryOf(0)).toBe('weapon');
    expect(categoryOf(SHOP_SLOT_WEIGHT_WEAPON - 1)).toBe('weapon'); // 59
    expect(['heal', 'energy', 'shield', 'emp']).toContain(categoryOf(SHOP_SLOT_WEIGHT_WEAPON)); // 60 — first item roll
    expect(['heal', 'energy', 'shield', 'emp']).toContain(
      categoryOf(SHOP_SLOT_WEIGHT_WEAPON + SHOP_SLOT_WEIGHT_ITEM - 1), // 89 — last item roll
    );
    expect(categoryOf(SHOP_SLOT_WEIGHT_WEAPON + SHOP_SLOT_WEIGHT_ITEM)).toBe('buff'); // 90 — first buff roll
    expect(categoryOf(99)).toBe('buff'); // 99 — last possible roll
  });

  it('rolls all three categories, and all four item kinds within the item category, across seeds', () => {
    // Across many seeds, because the claim is about the draw itself and not about one lucky
    // shop. A category or item kind that never appears is a silently deleted branch.
    const categories = new Set<string>();
    const itemKinds = new Set<string>();
    for (let seed = 0; seed < 200; seed++) {
      for (const offer of rollShopStock(new Prng(seed), ids(), 0)) {
        categories.add(offer.kind === 'weapon' || offer.kind === 'buff' ? offer.kind : 'item');
        if (offer.kind !== 'weapon' && offer.kind !== 'buff') itemKinds.add(offer.kind);
      }
    }
    expect(categories).toEqual(new Set(['weapon', 'item', 'buff']));
    expect(itemKinds).toEqual(new Set(['heal', 'energy', 'shield', 'emp']));
  });

  it('spends exactly six draws whatever it rolls — two per slot, three slots', () => {
    // design/06: a PRNG's draw COUNT is as load-bearing as its values. A shop that spent a
    // variable number would make every later loot roll on the floor depend on its shelves.
    for (const seed of [1, 7, 99, 12345]) {
      const p = new Prng(seed);
      rollShopStock(p, ids(), 0);
      const control = new Prng(seed);
      for (let i = 0; i < 6; i++) control.nextInt(2);
      expect(p.peek()).toBe(control.peek());
    }
  });

  it('prices each line from SHOP_PRICES, so no number is written twice', () => {
    const stock = rollShopStock(new Prng(3), ids(), 0);
    for (const o of stock) expect(o.price).toBe(SHOP_PRICES[o.kind]);
  });

  it('gives every line a DISTINCT id', () => {
    // The id is what a tap addresses. Two lines sharing one would make a tap ambiguous, and
    // `Array.find` would silently resolve it to whichever came first.
    const stock = rollShopStock(new Prng(5), ids(), 0);
    expect(new Set(stock.map((o) => o.id)).size).toBe(stock.length);
  });

  it('always stocks exactly SHOP_STOCK_SIZE lines, whatever the categories', () => {
    for (let seed = 0; seed < 20; seed++) {
      expect(rollShopStock(new Prng(seed), ids(), 0)).toHaveLength(SHOP_STOCK_SIZE);
    }
  });

  it('a weapon slot draws from WEAPON_DROP_POOL and a buff slot from BUFF_DROP_POOL', () => {
    const weaponOffer = rollShopStock(new FixedRoll([0, 3, 0, 3, 0, 3]), ids(), 0)[0]!;
    expect(WEAPON_DROP_POOL).toContain(weaponOffer.weaponId);
    const buffOffer = rollShopStock(new FixedRoll([99, 1, 99, 1, 99, 1]), ids(), 0)[0]!;
    expect(BUFF_DROP_POOL).toContain(buffOffer.buffId);
  });

  it("a weapon slot's rarity shifts with floorIndex (Task 7, weapon rarity by floor depth)", () => {
    // Roll 0 forces the category to 'weapon' every slot; only the second value of each
    // pair (the weightedIndex roll) varies across seeds, forcing the category roll fixed
    // so every sample is a weapon whose TIER is what's actually under test.
    const rank: Record<string, number> = { common: 0, fine: 1, epic: 2, legend: 3, legendary: 4 };
    const pooledAverage = (floorIndex: number, rolls: number): number => {
      let total = 0;
      for (let roll = 0; roll < rolls; roll++) {
        const offer = rollShopStock(new FixedRoll([0, roll, 0, roll, 0, roll]), ids(), floorIndex)[0]!;
        total += rank[WEAPON_SPECS[offer.weaponId!]!.rarity]!;
      }
      return total / rolls;
    };
    const avg0 = pooledAverage(0, 1800);
    const avg4 = pooledAverage(4, 1800);
    expect(avg4).toBeGreaterThan(avg0 + 0.5); // comfortably outside sampling noise
  });
});

describe('ShopSystem — what a tap buys', () => {
  it('charges the price and puts a bought WEAPON on the floor, not in a slot', () => {
    // design/05's pickup rules call weapons click-driven because WHICH slot to overwrite is a
    // decision. Buying one must therefore not make that decision for the player.
    const s = state();
    const p = addPlayer(s, 10, 10, 100);
    const shop = addShop(s, 10, 10, [{ kind: 'weapon', weaponId: 'repeater', price: 45 }]);
    p.shopBuyId = shop.stock[0]!.id;
    const slotsBefore = p.weapons.map((w) => w.spec.name);
    sys.tick(s);
    expect(p.coins).toBe(55);
    expect(shop.stock[0]!.sold).toBe(true);
    expect(s.pickups.filter((i) => i.kind === 'weapon' && i.weaponId === 'repeater')).toHaveLength(1);
    expect(p.weapons.map((w) => w.spec.name)).toEqual(slotsBefore);
  });

  it('applies a bought BUFF to the buyer directly, never as a pickup anyone could take', () => {
    const s = state();
    const buyer = addPlayer(s, 10, 10, 100);
    const bystander = addPlayer(s, 10, 10, 100);
    const shop = addShop(s, 10, 10, [{ kind: 'buff', buffId: 'dmg_up', price: 30 }]);
    buyer.shopBuyId = shop.stock[0]!.id;
    sys.tick(s);
    expect(buyer.buffs).toEqual(['dmg_up']);
    expect(bystander.buffs).toEqual([]);
    expect(s.pickups).toHaveLength(0);
    expect(buyer.coins).toBe(70);
    expect(bystander.coins).toBe(100); // a purchase charges exactly ONE wallet
  });

  it('heals and refuels the buyer, clamped to the pool', () => {
    const s = state();
    const p = addPlayer(s, 10, 10, 100);
    const shop = addShop(s, 10, 10, [
      { kind: 'heal', price: 12 },
      { kind: 'energy', price: 12 },
    ]);
    p.shopBuyId = shop.stock[0]!.id;
    sys.tick(s);
    expect(p.hp).toBe(3 + HEAL_PICKUP_AMOUNT);
    p.shopBuyId = shop.stock[1]!.id;
    sys.tick(s);
    expect(p.energy).toBe(Math.min(p.maxEnergy, ENERGY_PICKUP_AMOUNT));
    expect(p.coins).toBe(76);
  });

  it('recharges the shield and bursts every enemy in range (Task 4), clamped/gated the same way', () => {
    const s = state();
    const p = addPlayer(s, 10, 10, 100);
    p.maxShield = 8; // the fixture's own default is 0 — give it a real pool to restore into
    p.shield = p.maxShield - 5;
    const near = buildEnemyActor(s, p.gx, p.gy, 'basic');
    s.enemies.push(near);
    const startingHp = near.hp;
    const shop = addShop(s, 10, 10, [
      { kind: 'shield', price: SHOP_PRICES.shield },
      { kind: 'emp', price: SHOP_PRICES.emp },
    ]);
    p.shopBuyId = shop.stock[0]!.id;
    sys.tick(s);
    expect(p.shield).toBe(Math.min(p.maxShield, p.maxShield - 5 + SHIELD_PICKUP_AMOUNT));
    p.shopBuyId = shop.stock[1]!.id;
    sys.tick(s);
    expect(near.hp).toBeLessThan(startingHp);
    expect(p.coins).toBe(100 - SHOP_PRICES.shield - SHOP_PRICES.emp);
  });

  it('emits shop_buy naming the BUYER, so a client can tell a confirmation from an explanation', () => {
    const s = state();
    const p = addPlayer(s, 10, 10, 100);
    const shop = addShop(s, 10, 10, [{ kind: 'heal', price: 12 }]);
    p.shopBuyId = shop.stock[0]!.id;
    sys.tick(s);
    const ev = s.events.filter((e) => e.type === 'shop_buy');
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ id: shop.stock[0]!.id, buyer: p.id, kind: 'heal', price: 12 });
  });
});

describe('ShopSystem — the refusals', () => {
  /** Every refusal asserts BOTH halves: nothing delivered AND nothing charged. */
  const refused = (s: GameState, p: PlayerActor, shop: Shop, coins: number) => {
    sys.tick(s);
    expect(shop.stock[0]!.sold).toBe(false);
    expect(p.coins).toBe(coins);
    expect(s.pickups).toHaveLength(0);
    expect(s.events.filter((e) => e.type === 'shop_buy')).toHaveLength(0);
  };

  it('refuses a line that is already sold', () => {
    const s = state();
    const p = addPlayer(s, 10, 10, 100);
    const shop = addShop(s, 10, 10, [{ kind: 'heal', price: 12, sold: true }]);
    p.shopBuyId = shop.stock[0]!.id;
    sys.tick(s);
    expect(p.coins).toBe(100);
    expect(s.events.filter((e) => e.type === 'shop_buy')).toHaveLength(0);
  });

  it('refuses a player standing out of reach', () => {
    const s = state();
    const p = addPlayer(s, 10 + SHOP_INTERACT_RANGE_GRID + 4, 10, 100);
    const shop = addShop(s, 10, 10, [{ kind: 'heal', price: 12 }]);
    p.shopBuyId = shop.stock[0]!.id;
    refused(s, p, shop, 100);
  });

  it('refuses a player who cannot afford it, to the coin', () => {
    // Boundary, not a round number: one short refuses, exactly enough buys. An `<=` where the
    // `<` belongs is the classic version of this bug, and a test at 0 coins would not see it.
    const s = state();
    const p = addPlayer(s, 10, 10, 11);
    const shop = addShop(s, 10, 10, [{ kind: 'heal', price: 12 }]);
    p.shopBuyId = shop.stock[0]!.id;
    refused(s, p, shop, 11);

    p.coins = 12;
    p.shopBuyId = shop.stock[0]!.id;
    sys.tick(s);
    expect(shop.stock[0]!.sold).toBe(true);
    expect(p.coins).toBe(0);
  });

  it('refuses a shop in a room nobody has entered', () => {
    const s = state();
    const p = addPlayer(s, 10, 10, 100);
    const shop = addShop(s, 10, 10, [{ kind: 'heal', price: 12 }]);
    shop.roomId = 'r1';
    s.dungeonRoomIndexById.set('r1', 0);
    s.dungeonRoomRuntime.push({ activated: false, roomTick: 0, schedule: [], cursor: 0, hasLiveEnemy: false });
    p.shopBuyId = shop.stock[0]!.id;
    refused(s, p, shop, 100);

    s.dungeonRoomRuntime[0]!.activated = true;
    p.shopBuyId = shop.stock[0]!.id;
    sys.tick(s);
    expect(shop.stock[0]!.sold).toBe(true);
  });

  it('refuses an instant item that would do nothing, BEFORE taking the coins', () => {
    // The rule design/05 already applies to a dropped potion at full HP, reused here through
    // the same `pickupWouldApply` predicate so the floor and the counter cannot disagree.
    // Without it, a full-HP player pays 12 coins to destroy a potion.
    const s = state();
    const p = addPlayer(s, 10, 10, 100);
    p.hp = p.maxHp;
    const shop = addShop(s, 10, 10, [{ kind: 'heal', price: 12 }]);
    p.shopBuyId = shop.stock[0]!.id;
    refused(s, p, shop, 100);

    p.hp = 1;
    p.shopBuyId = shop.stock[0]!.id;
    sys.tick(s);
    expect(p.coins).toBe(88);
  });

  it('applies the same instant-item refusal to shield (full) and emp (nothing in range)', () => {
    const s = state();
    const p = addPlayer(s, 10, 10, 100);
    p.maxShield = 8; // the fixture's own default is 0 — give it a real pool to gate on
    p.shield = p.maxShield;
    const shop = addShop(s, 10, 10, [
      { kind: 'shield', price: SHOP_PRICES.shield },
      { kind: 'emp', price: SHOP_PRICES.emp },
    ]);
    p.shopBuyId = shop.stock[0]!.id;
    refused(s, p, shop, 100);
    p.shopBuyId = shop.stock[1]!.id;
    sys.tick(s);
    expect(shop.stock[1]!.sold).toBe(false); // no enemy anywhere yet
    expect(p.coins).toBe(100);

    p.shield = 0;
    p.shopBuyId = shop.stock[0]!.id;
    sys.tick(s);
    expect(shop.stock[0]!.sold).toBe(true);
    s.enemies.push(buildEnemyActor(s, p.gx, p.gy, 'basic'));
    p.shopBuyId = shop.stock[1]!.id;
    sys.tick(s);
    expect(shop.stock[1]!.sold).toBe(true);
  });

  it('does NOT apply that rule to a weapon or a buff', () => {
    // The exception design/05's pickup rules already make for a buff: its cap is applied
    // Sigma-then-clamp at USE time, so "already wasted" is not a question this site can
    // answer. A weapon is likewise a pickup the player may still decline. Both must remain
    // buyable by a player at full health and full energy.
    const s = state();
    const p = addPlayer(s, 10, 10, 100);
    p.hp = p.maxHp;
    p.energy = p.maxEnergy;
    const shop = addShop(s, 10, 10, [
      { kind: 'buff', buffId: 'dmg_up', price: 30 },
      { kind: 'weapon', weaponId: 'repeater', price: 45 },
    ]);
    p.shopBuyId = shop.stock[0]!.id;
    sys.tick(s);
    p.shopBuyId = shop.stock[1]!.id;
    sys.tick(s);
    expect(shop.stock.map((o) => o.sold)).toEqual([true, true]);
    expect(p.coins).toBe(25);
  });

  it('refuses a downed or dead buyer', () => {
    const s = state();
    const p = addPlayer(s, 10, 10, 100);
    const shop = addShop(s, 10, 10, [{ kind: 'heal', price: 12 }]);
    p.downed = true;
    p.shopBuyId = shop.stock[0]!.id;
    refused(s, p, shop, 100);

    p.downed = false;
    p.alive = false;
    p.shopBuyId = shop.stock[0]!.id;
    refused(s, p, shop, 100);
  });
});

describe('ShopSystem — shared stock, separate wallets', () => {
  it('lets the FIRST seat take the only weapon and leaves the second nothing to buy', () => {
    // The rule a small chest already runs on. Both taps land on the same tick, so this also
    // pins that resolution goes by seat ORDER and not by a race — two clients must agree.
    const s = state();
    const a = addPlayer(s, 10, 10, 100);
    const b = addPlayer(s, 10, 10, 100);
    const shop = addShop(s, 10, 10, [{ kind: 'weapon', weaponId: 'repeater', price: 45 }]);
    a.shopBuyId = shop.stock[0]!.id;
    b.shopBuyId = shop.stock[0]!.id;
    sys.tick(s);
    expect(a.coins).toBe(55);
    expect(b.coins).toBe(100);
    expect(s.pickups.filter((i) => i.kind === 'weapon')).toHaveLength(1);
  });
});

describe('ShopSystem — the no-op guarantee', () => {
  it('is a strict no-op for a state with no shops', () => {
    // What makes step 10.6 free for every config that predates it (`GameEngine`'s header).
    const s = state();
    addPlayer(s, 10, 10).shopBuyId = 7;
    const before = s.dropPrng.peek();
    sys.tick(s);
    expect(s.events).toEqual([]);
    expect(s.pickups).toEqual([]);
    expect(s.dropPrng.peek()).toBe(before);
  });

  it('ignores a tap that names no offer', () => {
    const s = state();
    const p = addPlayer(s, 10, 10, 100);
    const shop = addShop(s, 10, 10, [{ kind: 'heal', price: 12 }]);
    p.shopBuyId = shop.stock[0]!.id + 999;
    sys.tick(s);
    expect(shop.stock[0]!.sold).toBe(false);
    expect(p.coins).toBe(100);
  });
});
