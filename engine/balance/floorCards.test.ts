/**
 * Floor cards (design/05, ENGINE_VERSION 58) — the pure half: the catalogue, the offer
 * draw, and the vote tally. The end-to-end half (the offer opening with the portal, a
 * descend holding for a pick, the reward reaching every seat) lives in
 * `systems/floorCardCheckpoint.test.ts`, driven through a real engine.
 *
 * The tally is where most of these assertions sit, because it is the piece with a
 * genuine correctness surface: it runs INDEPENDENTLY on every client in a lockstep
 * match (design/06), so a rule that resolves differently on two machines — a re-roll, a
 * coin flip, an iteration over an unordered map — desyncs the run rather than merely
 * picking a different card.
 */
import { describe, it, expect } from 'vitest';
import { Prng } from '@dd/engine/math/prng';
import { RUN_BUFFS } from '@dd/engine/balance/runbuffs';
import { HEAL_DROP_MULT_CAP } from '@dd/engine/content/drops';
import {
  FLOOR_CARDS,
  FLOOR_CARD_IDS,
  FLOOR_CARD_OFFER_SIZE,
  cardBuffId,
  floorCardDescVars,
  resolveFloorCards,
  rollFloorCardOffer,
  tallyCardVote,
} from '@dd/engine/balance/floorCards';

describe('the catalogue', () => {
  it('offers at least as many cards as a checkpoint shows, or an offer cannot fill', () => {
    expect(FLOOR_CARD_IDS.length).toBeGreaterThanOrEqual(FLOOR_CARD_OFFER_SIZE);
  });

  it('names every buff card against a REAL entry in the run-buff catalogue', () => {
    // The anti-drift check: a buff card is a wrapper over RUN_BUFFS precisely so a card
    // and a floor drop of the same buff cannot diverge. A typo'd id would be silently
    // ignored by `sumBuffs`' forward-compat rule and the card would just do nothing.
    for (const id of FLOOR_CARD_IDS) {
      const buffId = cardBuffId(id);
      if (buffId !== undefined) expect(RUN_BUFFS[buffId], `card ${id}`).toBeDefined();
    }
  });

  it('carries i18n KEYS, never display text (design/09)', () => {
    for (const id of FLOOR_CARD_IDS) {
      expect(FLOOR_CARDS[id]!.nameKey).toMatch(/^card\.[a-z_]+\.name$/);
      expect(FLOOR_CARDS[id]!.descKey).toMatch(/^card\.[a-z_]+\.desc$/);
    }
  });

  it('includes the card the request actually named — doubling the potion drop rate', () => {
    expect(FLOOR_CARDS.potion_flow!.effect).toEqual({ kind: 'heal_drop_mult', factor: 2 });
  });
});

describe('rollFloorCardOffer', () => {
  it('draws exactly three DISTINCT cards', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const offer = rollFloorCardOffer(new Prng(seed));
      expect(offer).toHaveLength(FLOOR_CARD_OFFER_SIZE);
      expect(new Set(offer).size).toBe(FLOOR_CARD_OFFER_SIZE);
      for (const id of offer) expect(FLOOR_CARD_IDS).toContain(id);
    }
  });

  it('is reproducible from the same stream and diverges on a different one (design/06)', () => {
    expect(rollFloorCardOffer(new Prng(77))).toEqual(rollFloorCardOffer(new Prng(77)));
    const a = [rollFloorCardOffer(new Prng(1)), rollFloorCardOffer(new Prng(2))];
    expect(a[0]).not.toEqual(a[1]);
  });

  it('costs exactly one draw per card, whatever comes up', () => {
    // Load-bearing for design/06: a rejection loop would spend a seed-dependent number
    // of draws, so which cards happened to collide would shift every later cardPrng
    // draw in the run. Counted against a stub rather than inferred.
    let draws = 0;
    const counting = {
      nextInt(max: number) {
        draws++;
        return max - 1; // always the last remaining entry — a worst case for collisions
      },
    };
    const offer = rollFloorCardOffer(counting);
    expect(draws).toBe(FLOOR_CARD_OFFER_SIZE);
    expect(new Set(offer).size).toBe(FLOOR_CARD_OFFER_SIZE);
  });

  it('reaches every card in the catalogue across enough seeds', () => {
    // A draw that structurally could never offer some card would make that card dead
    // content while every test above still passed.
    const seen = new Set<string>();
    for (let seed = 1; seed <= 300; seed++) for (const id of rollFloorCardOffer(new Prng(seed))) seen.add(id);
    expect([...seen].sort()).toEqual([...FLOOR_CARD_IDS].sort());
  });

  it('cannot ask for more cards than the catalogue holds', () => {
    const offer = rollFloorCardOffer(new Prng(3), FLOOR_CARD_IDS.length + 5);
    expect(offer).toHaveLength(FLOOR_CARD_IDS.length);
    expect(new Set(offer).size).toBe(FLOOR_CARD_IDS.length);
  });
});

describe('tallyCardVote — "whichever card the most people chose"', () => {
  it('takes the slot with the most votes', () => {
    expect(tallyCardVote([2, 2, 3, 1], 3)).toBe(2);
    expect(tallyCardVote([3, 3, 3], 3)).toBe(3);
  });

  it('breaks a tie toward the LOWEST slot, every time', () => {
    // Deterministic by construction, which is the requirement: four clients tally this
    // independently and a rule that "picks one" non-deterministically desyncs the match.
    expect(tallyCardVote([1, 2], 3)).toBe(1);
    expect(tallyCardVote([2, 1], 3)).toBe(1); // vote ORDER must not matter either
    expect(tallyCardVote([3, 2], 3)).toBe(2);
    expect(tallyCardVote([1, 1, 2, 2, 3, 3], 3)).toBe(1);
  });

  it('skips abstentions rather than counting them as slot 1', () => {
    // A downed or AFK teammate must not drag the squad's pick.
    expect(tallyCardVote([0, 0, 3], 3)).toBe(3);
    expect(tallyCardVote([0, 0, 2, 2, 3], 3)).toBe(2);
  });

  it('returns 0 when nobody has voted — the signal that holds the portal', () => {
    expect(tallyCardVote([], 3)).toBe(0);
    expect(tallyCardVote([0, 0, 0, 0], 3)).toBe(0);
  });

  it('ignores a vote outside the offer, low or high', () => {
    // Forward/backward compatibility with a client that sends a slot this offer does
    // not have (a stale UI, a smaller offer than it rendered) — the same
    // silently-skip rule `sumBuffs` uses for an unknown buff id.
    expect(tallyCardVote([9, 9, 9], 3)).toBe(0);
    expect(tallyCardVote([-1, 4, 2], 3)).toBe(2);
    expect(tallyCardVote([1, 1, 1], 0)).toBe(0); // no offer open at all
  });

  it('is order-independent — the same multiset always resolves the same way', () => {
    const votes = [3, 1, 2, 2, 0, 3, 2];
    const rotated = [...votes.slice(3), ...votes.slice(0, 3)];
    const reversed = [...votes].reverse();
    expect(tallyCardVote(rotated, 3)).toBe(tallyCardVote(votes, 3));
    expect(tallyCardVote(reversed, 3)).toBe(tallyCardVote(votes, 3));
  });
});

// The identity FloorCardMods for a run that picked nothing of a given kind — every
// multiplier at 1, every additive count at 0 (Task 8 added four more fields).
const IDENTITY_MODS = {
  healDropMult: 1,
  coinMult: 1,
  energyPickupMult: 1,
  shieldPickupMult: 1,
  materialDropMult: 1,
  chestBonusWeapons: 0,
};

describe('resolveFloorCards — the run-scoped effects', () => {
  it('is the identity for a run that has picked nothing', () => {
    expect(resolveFloorCards([])).toEqual(IDENTITY_MODS);
  });

  it('doubles the heal multiplier per potion card, multiplicatively', () => {
    expect(resolveFloorCards(['potion_flow']).healDropMult).toBe(2);
    expect(resolveFloorCards(['potion_flow', 'potion_flow']).healDropMult).toBe(4);
    expect(resolveFloorCards(['potion_flow', 'potion_flow', 'potion_flow']).healDropMult).toBe(8);
  });

  it('lets a run reach the table cap in three picks, and no sooner', () => {
    // The cap lives with the table it bounds (`content/drops.ts`), not here — this only
    // pins that the two agree about how many picks it takes to reach it, which is the
    // number the card's own description promises.
    expect(resolveFloorCards(['potion_flow', 'potion_flow']).healDropMult).toBeLessThan(HEAL_DROP_MULT_CAP);
    expect(resolveFloorCards(Array(3).fill('potion_flow')).healDropMult).toBe(HEAL_DROP_MULT_CAP);
  });

  it('COMPOUNDS coin cards rather than adding them', () => {
    // The one behavioural difference from the `arsenal` card this replaced, and it is the
    // difference between the two effect kinds rather than a tuning choice: a quota bonus
    // was a count and added, a multiplier multiplies. Two picks are x4, not x3.
    expect(resolveFloorCards(['windfall']).coinMult).toBe(2);
    expect(resolveFloorCards(['windfall', 'windfall']).coinMult).toBe(4);
  });

  it('leaves the coin multiplier at 1 when no coin card was picked', () => {
    // The identity matters more than it looks: `DeathDropsSystem` multiplies a coin's qty
    // by this on EVERY kill, so a 0 here would silently delete the currency from the game
    // and a test that only ever checks the x2 case would not notice.
    expect(resolveFloorCards([]).coinMult).toBe(1);
    expect(resolveFloorCards(['potion_flow', 'edge']).coinMult).toBe(1);
  });

  it('leaves buff cards entirely out of the run-scoped derivation', () => {
    // Buff cards are pushed onto each seat's own `buffs` at pick time, so counting them
    // here as well would apply them twice through two different paths.
    const mods = resolveFloorCards(['edge', 'cadence', 'bulwark', 'precision']);
    expect(mods).toEqual(IDENTITY_MODS);
  });

  it('skips an unknown id instead of throwing (design/09 forward-compat)', () => {
    expect(resolveFloorCards(['not_a_card', 'potion_flow'])).toEqual({ ...IDENTITY_MODS, healDropMult: 2 });
  });

  it('mixes kinds without either interfering with the other', () => {
    expect(resolveFloorCards(['potion_flow', 'windfall', 'edge'])).toEqual({ ...IDENTITY_MODS, healDropMult: 2, coinMult: 2 });
  });

  it('doubles the energy-pickup multiplier per surge card, multiplicatively', () => {
    expect(resolveFloorCards(['surge']).energyPickupMult).toBe(2);
    expect(resolveFloorCards(['surge', 'surge']).energyPickupMult).toBe(4);
  });

  it('doubles the shield-pickup multiplier per aegis card, multiplicatively', () => {
    expect(resolveFloorCards(['aegis']).shieldPickupMult).toBe(2);
    expect(resolveFloorCards(['aegis', 'aegis']).shieldPickupMult).toBe(4);
  });

  it('doubles the material-drop multiplier per stockpile card, multiplicatively', () => {
    expect(resolveFloorCards(['stockpile']).materialDropMult).toBe(2);
    expect(resolveFloorCards(['stockpile', 'stockpile']).materialDropMult).toBe(4);
  });

  it('ADDS bounty cards rather than multiplying them — a flat count, not a rate', () => {
    expect(resolveFloorCards(['bounty']).chestBonusWeapons).toBe(1);
    expect(resolveFloorCards(['bounty', 'bounty']).chestBonusWeapons).toBe(2);
  });

  it('keeps every new Task 8 mod independent of every other kind', () => {
    const mods = resolveFloorCards(['surge', 'aegis', 'stockpile', 'bounty', 'windfall']);
    expect(mods).toEqual({
      ...IDENTITY_MODS,
      energyPickupMult: 2,
      shieldPickupMult: 2,
      materialDropMult: 2,
      chestBonusWeapons: 1,
      coinMult: 2,
    });
  });
});

describe('cardBuffId', () => {
  it('reports the buff a stat card grants', () => {
    expect(cardBuffId('edge')).toBe('dmg_up');
    expect(cardBuffId('precision')).toBe('crit_up');
  });

  it('reports nothing for a run-scoped card or an unknown id', () => {
    expect(cardBuffId('potion_flow')).toBeUndefined();
    expect(cardBuffId('windfall')).toBeUndefined();
    expect(cardBuffId('not_a_card')).toBeUndefined();
  });
});

describe('floorCardDescVars — the numbers a card description interpolates', () => {
  it('reads a percentage family out of per-mille, and an absolute family as-is', () => {
    // The unit split is the whole point of this function: `mult_*`/`crit_chance` are
    // stored per-mille and shown as a percentage, `flat_*` is already absolute. Both
    // arms asserted against the CATALOGUE value rather than a literal, so a retune moves
    // the expectation with the buff instead of failing here.
    expect(floorCardDescVars('edge')).toEqual({ value: RUN_BUFFS.dmg_up!.value / 10 });
    expect(floorCardDescVars('bulwark')).toEqual({ value: RUN_BUFFS.vit_up!.value });
  });

  it('shows the SECOND flat_* family at full size too, not a tenth of it', () => {
    // The regression this exists for (ENGINE_VERSION 60): the absolute arm used to be
    // keyed on the literal `'flat_hp'`, so `cell_up` — the second family in that unit —
    // fell through to the per-mille branch and a 30-point buff read as "+3 max energy".
    // Nothing else in the tree would have failed; the card simply lied on screen.
    expect(floorCardDescVars('capacitor')).toEqual({ value: RUN_BUFFS.cell_up!.value });
    expect(floorCardDescVars('capacitor').value).toBeGreaterThan(10); // not the /10 arm
  });

  it('reports the run-scoped kinds by their own field name', () => {
    expect(floorCardDescVars('potion_flow')).toEqual({ factor: 2 });
    expect(floorCardDescVars('windfall')).toEqual({ factor: 2 });
  });

  it("reports Task 8's three new multiplier cards as {factor}, and bounty as {count}", () => {
    expect(floorCardDescVars('surge')).toEqual({ factor: 2 });
    expect(floorCardDescVars('aegis')).toEqual({ factor: 2 });
    expect(floorCardDescVars('stockpile')).toEqual({ factor: 2 });
    expect(floorCardDescVars('bounty')).toEqual({ count: 1 });
  });

  it('returns nothing for an unknown card, or a card naming an unknown buff', () => {
    expect(floorCardDescVars('not_a_card')).toEqual({});
  });

  it('every stat card in the catalogue interpolates a real number, none of them NaN', () => {
    // The sweep that makes a NEW card fail here rather than ship a description with an
    // empty `{value}` hole in eight locales.
    for (const id of FLOOR_CARD_IDS) {
      const vars = floorCardDescVars(id);
      expect(Object.keys(vars).length, `${id} interpolates nothing`).toBeGreaterThan(0);
      for (const [k, v] of Object.entries(vars)) {
        expect(Number.isFinite(v), `${id}.${k} is not a finite number`).toBe(true);
      }
    }
  });
});
