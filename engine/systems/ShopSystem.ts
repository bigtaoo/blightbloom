/**
 * Step 10.6 — Shops (design/05 "Shops", 2026-09-14). The counter a run spends its coins at,
 * and the half of the economy that makes taking weapons off the kill table survivable: a
 * floor whose chests rolled badly is recoverable by BUYING.
 *
 * ## The gesture is a tap on a row, not a held INTERACT
 *
 * `INTERACT` already has two consumers (the revive channel and a chest), and a third would
 * need a third arbitration rule. It does not get one, because a purchase is not that shape of
 * verb anyway: buying is choosing WHICH line, and the game already has a vocabulary for
 * "choose one of the things in reach" — the ground-weapon panel's click-to-collect
 * (`PlayerCommand.pickupTargetId`, ENGINE_VERSION 32). A shop tap is the same one-tick latch
 * on its own field (`shopBuyId`), read here with no edge detection, and no modal: lockstep
 * cannot stop for one player (design/06), so the counter is a non-blocking panel exactly like
 * the weapon one.
 *
 * ## What a purchase actually does, and why the four kinds split two ways
 *
 * A bought **weapon** lands on the floor as an ordinary `weapon` pickup. Not swapped straight
 * into a slot: which of the two slots to overwrite is a decision (design/05's pickup rules
 * call weapons "click-driven" for exactly this reason), and the panel that makes it already
 * exists. Buying it puts it on the counter; picking it up is still a second, separate choice.
 *
 * A bought **buff / heal / energy** applies directly to the BUYER. These are design/05's
 * "pure upside, no choice" class, and dropping them as pickups would have made a paid reward
 * collectable by whoever walked past first — tolerable for a chest's free pile, not for
 * something a teammate spent their own coins on.
 *
 * That split is also what makes the refusal rule below possible: an instant item that would
 * do nothing is refused BEFORE the coins move, so a full-HP player cannot buy a potion they
 * are about to waste. `pickupWouldApply` is reused rather than re-stated, so the shop and the
 * floor can never disagree about what "would do something" means.
 *
 * ## Shared stock, per-seat wallets
 *
 * `ShopOffer.sold` is on the shop, `coins` is on the player. First come, first served — the
 * same rule a small chest runs on, and the reason a party cannot each buy the one weapon.
 */
import { ENERGY_PICKUP_AMOUNT } from '../balance/energy';
import { HEAL_PICKUP_AMOUNT } from '../content/drops';
import { SHOP_INTERACT_RANGE_GRID } from '../config';
import { toFpGrid } from '../content/convert';
import { dropClearance } from '../state/actorRadius';
import type { GameState } from '../state/GameState';
import type { PlayerActor, Shop, ShopOffer } from '../state/entities';
import { clampToWalkable } from './geom';
import { pickupWouldApply } from './PickupSystem';
import { applyRunBuff } from './runBuffApply';

const INTERACT_RANGE_FP = toFpGrid(SHOP_INTERACT_RANGE_GRID) as number;

export class ShopSystem {
  tick(state: GameState): void {
    if (state.shops.length === 0) return;
    for (const p of state.players) {
      if (p.shopBuyId === 0 || !p.alive || p.downed) continue;
      for (const shop of state.shops) {
        const offer = shop.stock.find((o) => o.id === p.shopBuyId);
        if (offer === undefined) continue;
        this.buy(state, shop, p, offer);
        break; // an offer id belongs to exactly one shop
      }
    }
  }

  /**
   * Resolve one tap. Every refusal is silent and leaves the wallet untouched — the render
   * layer knows the same three facts (range, price, sold) and is what tells the player why,
   * through `ui.denied`. Ordered cheapest-check-first, and affordability LAST of the three
   * so that "you cannot reach it" never reads as "you cannot afford it".
   */
  private buy(state: GameState, shop: Shop, p: PlayerActor, offer: ShopOffer): void {
    if (offer.sold) return;
    if (!this.roomActive(state, shop)) return;
    if (!within(p, shop.gx as number, shop.gy as number, INTERACT_RANGE_FP + (p.radius as number))) return;
    if (p.coins < offer.price) return;
    // An instant item that would do nothing is refused before the coins move — see the
    // header. A weapon and a buff are never refused on these grounds: a weapon is a pickup
    // the player may still decline, and a buff's cap is applied Sigma-then-clamp at USE time,
    // so "already wasted" is not a question this site can answer (design/05's pickup rules
    // make exactly this exception for the buff drop).
    if ((offer.kind === 'heal' || offer.kind === 'energy') && !pickupWouldApply(p, { kind: offer.kind } as never)) {
      return;
    }

    p.coins -= offer.price;
    offer.sold = true;
    this.deliver(state, shop, p, offer);
    state.events.push({
      type: 'shop_buy',
      id: offer.id,
      buyer: p.id,
      kind: offer.kind,
      price: offer.price,
      gx: shop.gx,
      gy: shop.gy,
    });
  }

  /** Hand over what was bought. See the header for why the weapon goes on the floor and the
   *  other three go straight onto the buyer. */
  private deliver(state: GameState, shop: Shop, p: PlayerActor, offer: ShopOffer): void {
    switch (offer.kind) {
      case 'weapon': {
        // Clamped by the PLAYER's clearance, like every other thing this engine puts on the
        // ground — a counter can be authored flush against a wall (`state/actorRadius.ts`).
        const pos = clampToWalkable(shop.gx, shop.gy, dropClearance(), state);
        state.pickups.push({
          id: state.nextId(),
          kind: 'weapon',
          weaponId: offer.weaponId,
          gx: pos.gx,
          gy: pos.gy,
          spawnTick: state.tick,
          alive: true,
        });
        break;
      }
      case 'buff':
        if (offer.buffId) applyRunBuff(p, offer.buffId);
        break;
      case 'heal':
        p.hp = Math.min(p.maxHp, p.hp + HEAL_PICKUP_AMOUNT);
        break;
      case 'energy':
        p.energy = Math.min(p.maxEnergy, p.energy + ENERGY_PICKUP_AMOUNT);
        break;
    }
  }

  /**
   * Is the shop's room live? Same rule and same reason as `ChestSystem.roomActive`: a floor's
   * rooms are co-resident (design/05 "Room & door model"), so without this a player could
   * trade with a counter in the room next door through the wall. A config with no room
   * runtime has no activation concept at all, and there the shop is live.
   */
  private roomActive(state: GameState, shop: Shop): boolean {
    const idx = state.dungeonRoomIndexById.get(shop.roomId);
    if (idx === undefined) return true;
    return state.dungeonRoomRuntime[idx]?.activated === true;
  }
}

/** Squared-distance reach test, the same shape every other system in here uses. */
function within(p: PlayerActor, gx: number, gy: number, reach: number): boolean {
  const dx = (p.gx as number) - gx;
  const dy = (p.gy as number) - gy;
  return dx * dx + dy * dy <= reach * reach;
}
