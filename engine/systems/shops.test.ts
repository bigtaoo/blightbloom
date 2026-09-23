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
import { rollShopStock, SHOP_PRICES } from '@dd/engine/content/shops';
import { WEAPON_DROP_POOL, BUFF_DROP_POOL, HEAL_PICKUP_AMOUNT, SHIELD_PICKUP_AMOUNT } from '@dd/engine/content/drops';
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

describe('rollShopStock — the counter is composed, not rolled', () => {
  it('always stocks weapon / buff / supply, in that order', () => {
    // Across many seeds, because the claim is about every shop and not about a lucky one.
    for (let seed = 0; seed < 50; seed++) {
      const stock = rollShopStock(new Prng(seed), ids());
      expect(stock).toHaveLength(SHOP_STOCK_SIZE);
      expect(stock[0]!.kind).toBe('weapon');
      expect(stock[1]!.kind).toBe('buff');
      expect(['heal', 'energy', 'shield', 'emp']).toContain(stock[2]!.kind);
      expect(WEAPON_DROP_POOL).toContain(stock[0]!.weaponId);
      expect(BUFF_DROP_POOL).toContain(stock[1]!.buffId);
    }
  });

  it('rolls all FOUR supply kinds across seeds (Task 4 widened the slot from a coin flip)', () => {
    // The control on the test above: `toContain([...])` passes for a shop that only ever
    // stocks one kind, which is what a mistyped `nextInt` would still be — and a supply
    // slot that never rolls one of its four kinds is a silently deleted quarter.
    const kinds = new Set<string>();
    for (let seed = 0; seed < 50; seed++) kinds.add(rollShopStock(new Prng(seed), ids())[2]!.kind);
    expect(kinds).toEqual(new Set(['heal', 'energy', 'shield', 'emp']));
  });

  it('spends exactly three draws whatever it rolls', () => {
    // design/06: a PRNG's draw COUNT is as load-bearing as its values. A shop that spent a
    // variable number would make every later loot roll on the floor depend on its shelves.
    for (const seed of [1, 7, 99, 12345]) {
      const p = new Prng(seed);
      rollShopStock(p, ids());
      const control = new Prng(seed);
      control.nextInt(2);
      control.nextInt(2);
      control.nextInt(2);
      expect(p.peek()).toBe(control.peek());
    }
  });

  it('prices each line from SHOP_PRICES, so no number is written twice', () => {
    const stock = rollShopStock(new Prng(3), ids());
    for (const o of stock) expect(o.price).toBe(SHOP_PRICES[o.kind]);
  });

  it('gives every line a DISTINCT id', () => {
    // The id is what a tap addresses. Two lines sharing one would make a tap ambiguous, and
    // `Array.find` would silently resolve it to whichever came first.
    const stock = rollShopStock(new Prng(5), ids());
    expect(new Set(stock.map((o) => o.id)).size).toBe(stock.length);
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
