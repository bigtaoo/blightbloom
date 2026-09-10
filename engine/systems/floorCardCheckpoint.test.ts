/**
 * Floor cards end-to-end (design/05, ENGINE_VERSION 58) — the offer opening with the
 * portal, a descend holding until the squad picks, the majority rule deciding which
 * card lands, and the reward reaching every seat.
 *
 * Driven through a real `createGameEngine` and real `PlayerCommand`s rather than by
 * poking `ExtractionSystem` directly, because the parts most worth pinning are the
 * seams between systems: `ApplyInputSystem` has to make a vote STICK across idle ticks
 * (it is not a one-tick latch like the confirm buttons), and the tally has to see every
 * seat rather than the one that pressed descend.
 *
 * The flat `floors` config is used for most of it — it reaches a checkpoint the moment
 * its waves are exhausted, with no rooms to walk through, which keeps each test about
 * the card and not about navigation. `dungeonrun.test.ts` owns the dungeon path.
 */
import { describe, it, expect } from 'vitest';
import { createGameEngine } from '@dd/engine/GameEngine';
import type { EngineConfig, GameState } from '@dd/engine/state/GameState';
import { makeCommand } from '@dd/engine/state/input';
import { Button } from '@dd/engine/state/commands';
import type { Brad } from '@dd/engine/math/trig';
import { FLOOR_CARDS, FLOOR_CARD_OFFER_SIZE, cardBuffId, resolveFloorCards } from '@dd/engine/balance/floorCards';
import { HEAL_DROP_MULT_CAP, rollDrop } from '@dd/engine/content/drops';

/** Two floors of empty waves: floor 0's checkpoint opens on tick 1, and there is a
 *  floor 1 to descend to (so an offer is rolled). */
const FLOORS_CFG: EngineConfig = {
  seed: 9,
  worldW: 800,
  worldH: 600,
  waves: [],
  floors: [[]],
};

function cmd(owner: number, tick: number, o: { buttons?: number; cardVote?: number } = {}) {
  return makeCommand({
    owner,
    tick,
    moveBrad: 0 as Brad,
    moveMag: 0,
    buttons: o.buttons ?? 0,
    cardVote: o.cardVote ?? 0,
  });
}

/** An engine parked at floor 0's checkpoint, with `seats` players. */
function atCheckpoint(seats = 1) {
  const eng = createGameEngine({
    ...FLOORS_CFG,
    players: Array.from({ length: seats }, () => ({ start: [100, 100] as [number, number] })),
  });
  eng.step(Array.from({ length: seats }, (_, i) => cmd(i, 1)));
  return eng;
}

const descend = (owner: number, tick: number, cardVote = 0) =>
  cmd(owner, tick, { buttons: Button.CONFIRM_DESCEND, cardVote });

describe('the offer opens with the portal', () => {
  it('rolls three distinct cards the tick the checkpoint becomes available', () => {
    const s = atCheckpoint().state;
    expect(s.floorCardOffer).toHaveLength(FLOOR_CARD_OFFER_SIZE);
    expect(new Set(s.floorCardOffer).size).toBe(FLOOR_CARD_OFFER_SIZE);
    for (const id of s.floorCardOffer) expect(FLOOR_CARDS[id]).toBeDefined();
  });

  it('rolls it ONCE, not once per tick the portal stays open', () => {
    const eng = atCheckpoint();
    const first = [...eng.state.floorCardOffer];
    const cursor = eng.state.cardPrng.peek();
    for (let i = 0; i < 20; i++) eng.step([cmd(0, eng.state.tick + 1)]);
    expect(eng.state.floorCardOffer).toEqual(first);
    expect(eng.state.cardPrng.peek()).toBe(cursor); // not a single extra draw
  });

  it('never offers a card on the LAST floor — there is nothing to spend it on', () => {
    // One floor, so floor 0 IS the last: its checkpoint offers EXTRACT only, and
    // rolling three cards there would spend cardPrng on a choice with no consequence.
    const eng = createGameEngine({ ...FLOORS_CFG, floors: [] });
    eng.step([cmd(0, 1)]);
    expect(eng.state.floorCardOffer).toEqual([]);
    expect(eng.state.cardPrng.peek()).toBe(createGameEngine({ ...FLOORS_CFG, floors: [] }).state.cardPrng.peek());
  });

  it('opens a FRESH offer at the next floor’s checkpoint', () => {
    const eng = createGameEngine({ ...FLOORS_CFG, floors: [[], []] });
    eng.step([cmd(0, 1)]);
    const first = [...eng.state.floorCardOffer];
    eng.step([descend(0, 2, 1)]);
    expect(eng.state.floorIndex).toBe(1);
    // The descend consumed the offer; the next checkpoint rolls another one.
    eng.step([cmd(0, 3)]);
    expect(eng.state.floorCardOffer).toHaveLength(FLOOR_CARD_OFFER_SIZE);
    expect(eng.state.floorCardOffer).not.toBe(first); // a new array, freshly drawn
  });
});

describe('a descend holds until somebody picks', () => {
  it('does not descend on a CONFIRM_DESCEND with no vote behind it', () => {
    const eng = atCheckpoint();
    for (let i = 0; i < 5; i++) eng.step([descend(0, eng.state.tick + 1)]);
    expect(eng.state.floorIndex).toBe(0);
    expect(eng.state.phase).not.toBe('gameover'); // held, not ended
    expect(eng.state.floorCards).toEqual([]);
  });

  it('descends on the press AFTER a vote, and applies that card', () => {
    const eng = atCheckpoint();
    const chosen = eng.state.floorCardOffer[1]!;
    eng.step([descend(0, eng.state.tick + 1, 2)]);
    expect(eng.state.floorIndex).toBe(1);
    expect(eng.state.floorCards).toEqual([chosen]);
  });

  it('remembers a vote cast on an EARLIER tick — it is state, not a one-tick pulse', () => {
    // The seam that would break silently: `confirmExtract`/`confirmDescend` are latches
    // cleared every tick, and a vote copied the same way would be gone by the time the
    // player reached the descend button.
    const eng = atCheckpoint();
    const chosen = eng.state.floorCardOffer[2]!;
    eng.step([cmd(0, eng.state.tick + 1, { cardVote: 3 })]);
    for (let i = 0; i < 10; i++) eng.step([cmd(0, eng.state.tick + 1)]); // idle, no vote sent
    expect(eng.state.players[0]!.cardVote).toBe(3);
    eng.step([descend(0, eng.state.tick + 1)]);
    expect(eng.state.floorCards).toEqual([chosen]);
  });

  it('lets a player change their mind right up to the descend', () => {
    const eng = atCheckpoint();
    const chosen = eng.state.floorCardOffer[0]!;
    eng.step([cmd(0, eng.state.tick + 1, { cardVote: 3 })]);
    eng.step([cmd(0, eng.state.tick + 1, { cardVote: 2 })]);
    eng.step([cmd(0, eng.state.tick + 1, { cardVote: 1 })]);
    eng.step([descend(0, eng.state.tick + 1)]);
    expect(eng.state.floorCards).toEqual([chosen]);
  });

  it('clears the offer and every seat’s vote once a descend consumes it', () => {
    const eng = atCheckpoint(2);
    eng.step([cmd(0, eng.state.tick + 1, { cardVote: 1 }), cmd(1, eng.state.tick + 1, { cardVote: 1 })]);
    eng.step([descend(0, eng.state.tick + 1), cmd(1, eng.state.tick + 1)]);
    expect(eng.state.floorCardOffer).toEqual([]);
    for (const seat of eng.state.players) expect(seat.cardVote).toBe(0);
  });

  it('an EXTRACT press cannot spend the offer, because it cannot resolve here at all', () => {
    // Rewritten for ENGINE_VERSION 61 (design/05 "Only the boss floor ends a run"). This
    // used to assert that EXTRACT ended the run without applying the voted card — a real
    // rule while an interior checkpoint could end a run. It no longer can, and the two
    // facts are now the same fact: an offer is only ever OPEN on a floor there is
    // somewhere to descend to, which is exactly a floor where EXTRACT is ignored. So the
    // assertion worth keeping is that the press leaves the whole offer standing —
    // nothing banked, no vote consumed, the portal still waiting on a descend.
    const eng = atCheckpoint();
    const offer = [...eng.state.floorCardOffer];
    eng.step([cmd(0, eng.state.tick + 1, { cardVote: 1 })]);
    eng.step([cmd(0, eng.state.tick + 1, { buttons: Button.CONFIRM_EXTRACT })]);
    expect(eng.state.phase).not.toBe('gameover');
    expect(eng.state.floorCards).toEqual([]);
    expect(eng.state.floorCardOffer).toEqual(offer); // still open, unrolled again
    expect(eng.state.players[0]!.cardVote).toBe(1); // and the vote still stands
  });
});

describe('multiplayer — the most-voted card wins', () => {
  it('takes the majority, not the card the descending player voted for', () => {
    // The whole point of the rule: seat 0 presses descend but is outvoted 2-1.
    const eng = atCheckpoint(3);
    const chosen = eng.state.floorCardOffer[2]!;
    const t = eng.state.tick + 1;
    eng.step([cmd(0, t, { cardVote: 1 }), cmd(1, t, { cardVote: 3 }), cmd(2, t, { cardVote: 3 })]);
    eng.step([descend(0, eng.state.tick + 1), cmd(1, eng.state.tick + 1), cmd(2, eng.state.tick + 1)]);
    expect(eng.state.floorCards).toEqual([chosen]);
  });

  it('descends on one teammate’s vote when the others never chose', () => {
    // Holding on ">= 1 vote" rather than "everyone voted" is what stops a downed or
    // disconnected teammate stranding the squad on a cleared floor.
    const eng = atCheckpoint(3);
    const chosen = eng.state.floorCardOffer[1]!;
    const t = eng.state.tick + 1;
    eng.step([cmd(0, t), cmd(1, t, { cardVote: 2 }), cmd(2, t)]);
    eng.step([descend(0, eng.state.tick + 1), cmd(1, eng.state.tick + 1), cmd(2, eng.state.tick + 1)]);
    expect(eng.state.floorIndex).toBe(1);
    expect(eng.state.floorCards).toEqual([chosen]);
  });

  it('breaks a two-way tie toward the leftmost card', () => {
    const eng = atCheckpoint(2);
    const chosen = eng.state.floorCardOffer[0]!;
    const t = eng.state.tick + 1;
    eng.step([cmd(0, t, { cardVote: 2 }), cmd(1, t, { cardVote: 1 })]);
    eng.step([descend(0, eng.state.tick + 1), cmd(1, eng.state.tick + 1)]);
    expect(eng.state.floorCards).toEqual([chosen]);
  });
});

describe('the reward is team-wide', () => {
  /** Drive a two-seat run to descend having picked whichever offered slot is `cardId`. */
  function pickCard(eng: ReturnType<typeof createGameEngine>, cardId: string): void {
    const slot = eng.state.floorCardOffer.indexOf(cardId) + 1;
    expect(slot).toBeGreaterThan(0); // the caller must have checked the offer contains it
    const t = eng.state.tick + 1;
    eng.step(eng.state.players.map((_, i) => cmd(i, t, { cardVote: slot })));
    eng.step(eng.state.players.map((_, i) => (i === 0 ? descend(0, eng.state.tick + 1) : cmd(i, eng.state.tick + 1))));
  }

  /** An engine whose floor-0 offer is guaranteed to contain `cardId`, by seed search. */
  function checkpointOffering(cardId: string, seats = 1) {
    for (let seed = 1; seed < 400; seed++) {
      const eng = createGameEngine({
        ...FLOORS_CFG,
        seed,
        players: Array.from({ length: seats }, () => ({ start: [100, 100] as [number, number] })),
      });
      eng.step(Array.from({ length: seats }, (_, i) => cmd(i, 1)));
      if (eng.state.floorCardOffer.includes(cardId)) return eng;
    }
    throw new Error(`no seed under 400 offered '${cardId}' at floor 0`);
  }

  it('gives a buff card to EVERY seat, not just the one that voted for it', () => {
    const eng = checkpointOffering('edge', 2);
    const before = eng.state.players.map((p) => p.buffs.length);
    pickCard(eng, 'edge');
    eng.state.players.forEach((p, i) => {
      expect(p.buffs).toHaveLength(before[i]! + 1);
      expect(p.buffs).toContain(cardBuffId('edge'));
    });
  });

  it('gives it to a DOWNED seat too — they are still on the team', () => {
    const eng = checkpointOffering('edge', 2);
    const downed = eng.state.players[1]!;
    downed.downed = true;
    downed.hp = 0;
    pickCard(eng, 'edge');
    expect(downed.buffs).toContain(cardBuffId('edge'));
  });

  it('records a run-scoped card in the picked list without touching anyone’s buffs', () => {
    const eng = checkpointOffering('potion_flow', 2);
    const before = eng.state.players.map((p) => [...p.buffs]);
    pickCard(eng, 'potion_flow');
    expect(eng.state.floorCards).toEqual(['potion_flow']);
    eng.state.players.forEach((p, i) => expect(p.buffs).toEqual(before[i]));
  });
});

describe('a picked card actually changes the sim', () => {
  const healRate = (s: GameState, samples: number) => {
    // Rolls the REAL drop table through the REAL state, so this measures what the card
    // did rather than re-deriving the weights the card was supposed to change.
    let heals = 0;
    for (let i = 0; i < samples; i++) if (rollFromState(s).kind === 'heal') heals++;
    return heals / samples;
  };

  it('doubles the potion rate for the rest of the run', () => {
    const plain = createGameEngine(FLOORS_CFG).state;
    const boosted = createGameEngine(FLOORS_CFG).state;
    boosted.floorCards.push('potion_flow');
    const base = healRate(plain, 30_000);
    const doubled = healRate(boosted, 30_000);
    expect(base).toBeGreaterThan(0.015);
    expect(doubled / base).toBeGreaterThan(1.6); // ~2x, sampled
    expect(doubled / base).toBeLessThan(2.4);
  });

  it('stacks to the table cap and no further', () => {
    const capped = createGameEngine(FLOORS_CFG).state;
    for (let i = 0; i < 3; i++) capped.floorCards.push('potion_flow');
    const overCapped = createGameEngine(FLOORS_CFG).state;
    for (let i = 0; i < 6; i++) overCapped.floorCards.push('potion_flow');
    const a = healRate(capped, 30_000);
    const b = healRate(overCapped, 30_000);
    expect(a / healRate(createGameEngine(FLOORS_CFG).state, 30_000)).toBeGreaterThan(5);
    expect(Math.abs(a - b)).toBeLessThan(0.02); // six picks buy nothing past three
    expect(HEAL_DROP_MULT_CAP).toBe(8);
  });
});

/** One drop rolled through the state's own dropPrng and card list — the exact call
 *  `DeathDropsSystem` makes for a kill, minus the enemy. */
function rollFromState(s: GameState) {
  return rollDrop(s.dropPrng, s.floorIndex, { healMult: resolveFloorCards(s.floorCards).healDropMult });
}
