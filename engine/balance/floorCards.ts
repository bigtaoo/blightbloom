/**
 * Floor cards — the "pick one of three" reward at a floor's checkpoint (design/05,
 * ENGINE_VERSION 58). Asked for by the game's owner on 2026-09-05, in the shape Soul
 * Knight established: clear a floor, get offered three upgrades, take one.
 *
 * It is the counterweight to the same day's loot pass. Potions went from 21% of kills
 * to 2.4% and a floor's weapons were capped at 2-3, which makes a run scarcer but does
 * not give the player anything to steer. These do: the power a run gains is now mostly
 * a sequence of choices at four checkpoints rather than whatever happened to drop.
 *
 * ## Plain data + pure functions
 *
 * Same contract as `runbuffs.ts` next door (design/09 "content is plain data"): a
 * catalogue keyed by id, i18n KEYS only and never display text, and every function here
 * pure. Nothing in this file knows what a `GameState` is — `ExtractionSystem` owns the
 * checkpoint that offers a card and the descend that applies one.
 *
 * ## Three effect kinds, and why they are not all buffs
 *
 * `buff` cards are deliberately a thin wrapper over the EXISTING `RUN_BUFFS` catalogue
 * rather than a parallel one: a card that grants `dmg_up` should be exactly as strong as
 * the `dmg_up` that drops off the floor, and the Sigma-then-clamp caps in `BUFF_CAPS`
 * should bound both together. A second damage-scaling path is precisely the drift
 * design/18's consistency gates exist to catch.
 *
 * The other two kinds exist because they are NOT player stats. `heal_drop_mult` changes
 * the drop table's weights, and `coin_mult` changes what one coin drop is worth; neither
 * has anywhere to live on a `PlayerActor`, and both are properties of the RUN rather
 * than of a person in it. That distinction is also why they are re-derived from the
 * picked-card list on read (`resolveFloorCards`) instead of being copied into a mutable
 * counter: there is one place a card's effect is written down, and it is this file.
 *
 * ## Team-wide, on the owner's call
 *
 * A card benefits the whole squad, not the seat that voted for it (2026-09-05). The vote
 * is collective — most votes wins, `tallyCardVote` — so the reward is collective too;
 * a per-voter reward would turn a shared decision into four private ones and make the
 * majority rule actively unfair to whoever lost it.
 */
import { RUN_BUFFS, type RunBuffId } from './runbuffs';

/**
 * What a card does. `buff` reuses `RUN_BUFFS`; every other kind is run-scoped, in the
 * same sense `heal_drop_mult`/`coin_mult` already were (design/05 header above): a
 * property of the RUN, not of a person in it, re-derived on read rather than mirrored
 * into a mutable counter.
 *
 * Task 8 (catalogue expansion, 2026-09-23) adds three more PAYLOAD multipliers —
 * `energy_pickup_mult`/`shield_pickup_mult`/`material_drop_mult` — each the same shape
 * as `coin_mult`: they scale a flat pickup amount at the point of collection, never a
 * drop TABLE weight, so picking one changes no other kind's odds. `chest_bonus_weapons`
 * is the one genuinely different shape: a flat additive count added to every chest's
 * payout for the rest of the run, applied in `ChestSystem.open()`.
 */
export type FloorCardEffect =
  | { kind: 'buff'; buffId: RunBuffId }
  | { kind: 'heal_drop_mult'; factor: number }
  | { kind: 'coin_mult'; factor: number }
  | { kind: 'energy_pickup_mult'; factor: number }
  | { kind: 'shield_pickup_mult'; factor: number }
  | { kind: 'material_drop_mult'; factor: number }
  | { kind: 'chest_bonus_weapons'; count: number };

interface FloorCardDef {
  effect: FloorCardEffect;
  nameKey: string; // i18n KEY only, never display text (design/09)
  descKey: string;
}

/**
 * The catalogue. Fixed insertion order — `FLOOR_CARD_IDS` derives from it, and the
 * offer draw indexes into that, so re-ordering these entries changes what a given seed
 * offers and is an ENGINE_VERSION-bumping change like any other content re-order.
 */
export const FLOOR_CARDS: Record<string, FloorCardDef> = {
  // The card the 2026-09-05 request named explicitly: "one of them doubles the monster
  // health-potion drop rate". It is the pressure valve on the same pass's potion nerf —
  // a player who finds the run too dry can spend picks on getting the potions back,
  // three of them to reach `HEAL_DROP_MULT_CAP` and roughly the old flood.
  potion_flow: {
    effect: { kind: 'heal_drop_mult', factor: 2 },
    nameKey: 'card.potion_flow.name',
    descKey: 'card.potion_flow.desc',
  },
  // Coins are worth double for the rest of the run (2026-09-14). This slot used to be
  // `arsenal` — "+1 weapon on every remaining floor" — and it died with the per-floor
  // weapon allowance it added to: with weapons behind chests, the boss and a shop
  // counter, there is no allowance for a card to raise.
  //
  // A coin multiplier is its closest honest successor rather than a new idea, because it
  // buys the same thing by the same route: `arsenal` spent a pick to loosen the run's
  // weapon scarcity, and so does this — through the shop, which is now where a run turns
  // a bad chest roll back into a gun. What changes is that the loosening is no longer
  // automatic. The card hands you income, and you still have to find a counter and decide
  // what to spend it on.
  //
  // It multiplies the coin PAYLOAD (`DeathDropsSystem`), not the table weight, which is
  // the one structural difference from `potion_flow` below it — see `COIN_DROP_QTY`.
  windfall: {
    effect: { kind: 'coin_mult', factor: 2 },
    nameKey: 'card.windfall.name',
    descKey: 'card.windfall.desc',
  },
  // The stat cards, one per RUN_BUFFS family, so the offer can always fill three slots
  // with something meaningful and the Sigma-clamps in BUFF_CAPS bound cards and floor
  // drops together.
  edge: { effect: { kind: 'buff', buffId: 'dmg_up' }, nameKey: 'card.edge.name', descKey: 'card.edge.desc' },
  cadence: { effect: { kind: 'buff', buffId: 'rof_up' }, nameKey: 'card.cadence.name', descKey: 'card.cadence.desc' },
  bulwark: { effect: { kind: 'buff', buffId: 'vit_up' }, nameKey: 'card.bulwark.name', descKey: 'card.bulwark.desc' },
  precision: { effect: { kind: 'buff', buffId: 'crit_up' }, nameKey: 'card.precision.name', descKey: 'card.precision.desc' },
  // ENGINE_VERSION 60 — the ammo economy's card, and the reason `cell_up` exists as a
  // buff family at all. It is deliberately card-only rather than a fifth entry in
  // `BUFF_DROP_POOL`: +max energy is worth NOTHING to a player still on the starter
  // blaster (sustainable on regen alone, so its pool never empties), and a floor drop
  // that is null for a fresh save would dilute the four unconditional buffs to pay for
  // a reward most players cannot use yet. A pick-one-of-three offer is exactly the
  // place a CONDITIONAL reward belongs — the player holding a 26-cost frame takes it,
  // the player holding a blaster takes `edge` instead, and neither pick is wasted.
  capacitor: { effect: { kind: 'buff', buffId: 'cell_up' }, nameKey: 'card.capacitor.name', descKey: 'card.capacitor.desc' },
  // Task 8 (catalogue expansion, 2026-09-23) — three more payload multipliers, same
  // shape as `windfall` above (never a table weight, so none of them touches another
  // kind's odds), and one flat additive card. Each answers a scarcity `potion_flow`/
  // `windfall` do not: the ammo economy, the shield-sustain items (Task 4), the forge's
  // only carry-out currency, and the run's only weapon source that isn't luck-gated.
  surge: {
    effect: { kind: 'energy_pickup_mult', factor: 2 },
    nameKey: 'card.surge.name',
    descKey: 'card.surge.desc',
  },
  aegis: {
    effect: { kind: 'shield_pickup_mult', factor: 2 },
    nameKey: 'card.aegis.name',
    descKey: 'card.aegis.desc',
  },
  stockpile: {
    effect: { kind: 'material_drop_mult', factor: 2 },
    nameKey: 'card.stockpile.name',
    descKey: 'card.stockpile.desc',
  },
  // +1 extra weapon out of every chest for the rest of the run (ChestSystem.open()) —
  // the one card here that is a flat count rather than a multiplier, because a chest's
  // payout (`chestWeaponCount`) is itself already a small integer (1, or 1-per-seat) that
  // a MULTIPLIER would round back down to unchanged at the common 1-seat case.
  bounty: {
    effect: { kind: 'chest_bonus_weapons', count: 1 },
    nameKey: 'card.bounty.name',
    descKey: 'card.bounty.desc',
  },
};

/** Catalogue ids in a FIXED order — the pool `rollFloorCardOffer` draws from. */
export const FLOOR_CARD_IDS: readonly string[] = Object.keys(FLOOR_CARDS);

/** How many cards a checkpoint offers. Three, per the request. */
export const FLOOR_CARD_OFFER_SIZE = 3;

/**
 * Draw the checkpoint's offer: `count` DISTINCT ids, in draw order.
 *
 * A partial Fisher-Yates over a copy of the pool, so the cost is exactly `count` draws
 * regardless of what comes up — a rejection loop would spend a seed-dependent number of
 * draws and make the rest of the stream depend on which cards happened to collide
 * (design/06: a PRNG's draw COUNT is as load-bearing as its values).
 */
export function rollFloorCardOffer(
  prng: { nextInt(max: number): number },
  count = FLOOR_CARD_OFFER_SIZE,
): string[] {
  const pool = [...FLOOR_CARD_IDS];
  const out: string[] = [];
  for (let i = 0; i < count && pool.length > 0; i++) {
    out.push(pool.splice(prng.nextInt(pool.length), 1)[0]!);
  }
  return out;
}

/**
 * Resolve a squad's votes into the winning offer SLOT (1-based), or 0 when nobody
 * voted.
 *
 * The rule the owner asked for, 2026-09-05: *"in a multiplayer level, whichever card the
 * most people chose takes effect."* Two things it has to settle that the sentence does
 * not, both resolved toward determinism (design/06 — every client tallies this
 * independently and must reach the same answer):
 *
 *   - **A tie goes to the LOWEST slot.** Arbitrary, but it has to be *something*, and
 *     "the leftmost card" is at least visible on screen. Never a re-roll, never a
 *     coin flip: neither would survive being computed on four machines at once.
 *   - **An abstention is not a vote.** `0` (nobody has tapped a card in this seat) is
 *     skipped rather than counted for slot 1 — a downed or AFK teammate must not drag
 *     the squad's pick, and a solo player who has not chosen yet gets 0 back, which is
 *     what holds the portal (`ExtractionSystem`).
 */
export function tallyCardVote(votes: readonly number[], offerSize: number): number {
  const counts = new Array<number>(offerSize + 1).fill(0);
  for (const v of votes) if (v >= 1 && v <= offerSize) counts[v]!++;
  let best = 0;
  let bestCount = 0;
  // Strict `>` walking upward is what makes a tie fall to the lowest slot.
  for (let slot = 1; slot <= offerSize; slot++) {
    if (counts[slot]! > bestCount) {
      best = slot;
      bestCount = counts[slot]!;
    }
  }
  return best;
}

/** The run-scoped (non-buff) effects of every card picked so far. */
export interface FloorCardMods {
  /** Product of every `heal_drop_mult` factor. 1 with no such card. Clamped by
   *  `content/drops.ts`'s own `HEAL_DROP_MULT_CAP` at the point of use, not here —
   *  the cap belongs with the table it bounds. */
  healDropMult: number;
  /** Product of every `coin_mult` factor. 1 with no such card. Applied to a coin drop's
   *  `qty` at the point of use (`DeathDropsSystem`), never to a table weight. */
  coinMult: number;
  /** Product of every `energy_pickup_mult` factor (`surge`). 1 with no such card.
   *  Applied to `ENERGY_PICKUP_AMOUNT` at the point of collection (`PickupSystem`). */
  energyPickupMult: number;
  /** Product of every `shield_pickup_mult` factor (`aegis`). 1 with no such card.
   *  Applied to `SHIELD_PICKUP_AMOUNT` at the point of collection (`PickupSystem`). */
  shieldPickupMult: number;
  /** Product of every `material_drop_mult` factor (`stockpile`). 1 with no such card.
   *  Applied to a material drop's `qty` at the point of use (`DeathDropsSystem`), same
   *  payload-not-table-weight shape as `coinMult`. */
  materialDropMult: number;
  /** Sum of every `chest_bonus_weapons` count (`bounty`). 0 with no such card. Added to
   *  `chestWeaponCount`'s own result in `ChestSystem.open()`. */
  chestBonusWeapons: number;
}

/**
 * Re-derive the run's card modifiers from the picked-card list. Called at the point of
 * use rather than cached in a counter, deliberately: the list IS the state (hashed,
 * replayed, one source of truth), and a mirrored counter is a second one that can drift
 * from it. The list is at most one entry per floor, so this is a handful of iterations.
 *
 * An unknown id is skipped, matching `sumBuffs`' forward-compatibility rule (design/09).
 */
export function resolveFloorCards(picked: readonly string[]): FloorCardMods {
  const mods: FloorCardMods = {
    healDropMult: 1,
    coinMult: 1,
    energyPickupMult: 1,
    shieldPickupMult: 1,
    materialDropMult: 1,
    chestBonusWeapons: 0,
  };
  for (const id of picked) {
    const def = FLOOR_CARDS[id];
    if (!def) continue;
    switch (def.effect.kind) {
      case 'heal_drop_mult':
        mods.healDropMult *= def.effect.factor;
        break;
      case 'coin_mult':
        mods.coinMult *= def.effect.factor;
        break;
      case 'energy_pickup_mult':
        mods.energyPickupMult *= def.effect.factor;
        break;
      case 'shield_pickup_mult':
        mods.shieldPickupMult *= def.effect.factor;
        break;
      case 'material_drop_mult':
        mods.materialDropMult *= def.effect.factor;
        break;
      case 'chest_bonus_weapons':
        mods.chestBonusWeapons += def.effect.count;
        break;
      default:
        break; // 'buff' — resolved by sumBuffs/applyRunBuff instead, not this function
    }
  }
  return mods;
}

/**
 * The numbers a card's description interpolates, e.g. `{value}` in "+{value}% damage".
 *
 * Derived from the catalogues rather than written into the locale strings, because a
 * hardcoded "+50%" in eight locale files is eight copies of a number that lives in
 * `RUN_BUFFS` — and design/18's consistency gates exist because that is exactly the
 * shape of drift nothing catches: the buff gets retuned, the card keeps promising the
 * old figure, and every test still passes.
 *
 * Units follow the buff's own kind: `mult_*` and `crit_chance` are stored per-mille and
 * shown as a percentage; `flat_*` is already absolute.
 */
export function floorCardDescVars(cardId: string): Record<string, number> {
  const def = FLOOR_CARDS[cardId];
  if (!def) return {};
  switch (def.effect.kind) {
    case 'heal_drop_mult':
    case 'coin_mult':
    case 'energy_pickup_mult':
    case 'shield_pickup_mult':
    case 'material_drop_mult':
      return { factor: def.effect.factor };
    case 'chest_bonus_weapons':
      return { count: def.effect.count };
    case 'buff': {
      const buff = RUN_BUFFS[def.effect.buffId];
      if (!buff) return {};
      // `flat_*` is already an absolute amount; every other family is stored per-mille
      // and shown as a percentage. Keyed on the PREFIX rather than on `'flat_hp'` by
      // name (ENGINE_VERSION 60, when `flat_energy` joined it) — a per-id list here is
      // one more place a sixth family has to be remembered, and forgetting it would show
      // "+3 max energy" for a 30-point buff without failing anything.
      return { value: buff.kind.startsWith('flat_') ? buff.value : buff.value / 10 };
    }
  }
}

/** The `RUN_BUFFS` id a card grants, or undefined for the two run-scoped kinds. */
export function cardBuffId(cardId: string): RunBuffId | undefined {
  const def = FLOOR_CARDS[cardId];
  return def?.effect.kind === 'buff' ? def.effect.buffId : undefined;
}
