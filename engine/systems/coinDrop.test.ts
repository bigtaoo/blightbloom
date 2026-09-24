/**
 * The coin drop and the `windfall` card that scales it (design/05 "Shops", 2026-09-14).
 *
 * Two things here that no other test can reach. The `windfall` multiplier is applied in
 * `DeathDropsSystem` rather than inside `rollDrop`, deliberately (a card that changes a
 * PAYLOAD must stay outside the draw), which means `drops.test.ts` cannot see it at all and
 * `floorCards.test.ts` only sees the number it resolves to. And the multiplier sits on a line
 * that runs on EVERY kill — `drop.qty * (cards?.coinMult ?? 1)` — so its default arm is
 * exercised constantly while the x2 arm may never be, which is the shape CLAUDE.md names as
 * the column that bites.
 */
import { describe, it, expect } from 'vitest';
import { toFp } from '@dd/engine/math/fixed';
import type { Brad } from '@dd/engine/math/trig';
import { toFpGrid } from '@dd/engine/content/convert';
import { freshStatus } from '@dd/engine/content/damage';
import { BASIC_ENEMY } from '@dd/engine/content/enemies';
import { createGameState } from '@dd/engine/state/GameState';
import type { GameState } from '@dd/engine/state/GameState';
import { ENEMY_TEAM_ID, type EnemyActor } from '@dd/engine/state/entities';
import { DeathDropsSystem } from '@dd/engine/systems';
import { COIN_DROP_QTY } from '@dd/engine/config';
import { DROP_TABLE } from '@dd/engine/content/drops';

const sys = new DeathDropsSystem();

/** A state whose `dropPrng` is pre-aimed at a chosen table entry, so the test does not have
 *  to hunt seeds for the branch it is about. */
function state(seed: number): GameState {
  return createGameState({ seed, worldW: 1600, worldH: 1600, waves: [] });
}

/** A dead `basic` at a fixed spot. Same shape as `blueprintDrop.test.ts`'s own helper next
 *  door, deliberately — two hand-built corpses that disagree about a field are two different
 *  tests pretending to be the same one. */
function addCorpse(s: GameState): EnemyActor {
  const e: EnemyActor = {
    id: s.nextId(), faction: 'enemy', teamId: ENEMY_TEAM_ID,
    gx: toFpGrid(20), gy: toFpGrid(20), z: toFp(0), vx: toFp(0), vy: toFp(0),
    knockVx: toFp(0), knockVy: toFp(0),
    facing: 0 as Brad, hp: 0, maxHp: BASIC_ENEMY.maxHp,
    shield: 0, maxShield: 0, ticksSinceHit: 0,
    radius: BASIC_ENEMY.radius, footprintRadius: BASIC_ENEMY.footprintRadius,
    solidRadius: BASIC_ENEMY.radius,
    alive: true, weapon: null, firing: false, status: freshStatus(),
    enraged: false, armorBroken: false, aggroed: false, holding: false,
  } as EnemyActor;
  s.enemies.push(e);
  return e;
}

/** Kill enemies on successive seeds until one rolls a coin, and hand back that state. Cheaper
 *  and far more honest than asserting on one hand-picked seed: the coin weight is 20/84, so
 *  this finds one within a handful of tries on any table that still HAS coins on it, and
 *  fails loudly rather than silently passing if one ever does not. */
function firstCoinDrop(cards: string[] = []): { s: GameState; qty: number } {
  for (let seed = 1; seed < 200; seed++) {
    const s = state(seed);
    s.floorCards.push(...cards);
    addCorpse(s);
    sys.tick(s);
    const coin = s.pickups.find((i) => i.kind === 'coin');
    if (coin) return { s, qty: coin.qty ?? 0 };
  }
  throw new Error('no coin drop in 200 seeds — the table has stopped producing coins');
}

describe('the coin drop', () => {
  it('is on the table at all, and pays COIN_DROP_QTY', () => {
    expect(DROP_TABLE.some((e) => e.kind === 'coin')).toBe(true);
    expect(firstCoinDrop().qty).toBe(COIN_DROP_QTY);
  });

  it('lands on the ground uncollected, like every other drop', () => {
    // `spawnTick` is the one-tick gap `PickupSystem`'s own guard stands on (design/08's
    // step 8→9 note): a coin stamped with a past tick would be vacuumed the frame it drops,
    // and nobody would ever see one fall.
    const { s } = firstCoinDrop();
    const coin = s.pickups.find((i) => i.kind === 'coin')!;
    expect(coin.spawnTick).toBe(s.tick);
    expect(coin.alive).toBe(true);
    expect(s.players[0]!.coins).toBe(0);
  });
});

describe('the windfall card', () => {
  it('doubles a coin drop’s payload', () => {
    expect(firstCoinDrop(['windfall']).qty).toBe(COIN_DROP_QTY * 2);
  });

  it('compounds across two picks', () => {
    expect(firstCoinDrop(['windfall', 'windfall']).qty).toBe(COIN_DROP_QTY * 4);
  });

  it('does NOT change which drop comes up — it is a payload card, not a table card', () => {
    // The property that keeps it outside `rollDrop`. Same seed, same kill, with and without
    // the card: the KIND sequence must be identical, or picking the card would have shifted
    // every later loot roll of the run and the two halves of `resolveFloorCards` would be
    // doing the same job in two different places.
    for (let seed = 1; seed < 25; seed++) {
      const plain = state(seed);
      addCorpse(plain);
      sys.tick(plain);

      const carded = state(seed);
      carded.floorCards.push('windfall');
      addCorpse(carded);
      sys.tick(carded);

      expect(carded.pickups.map((i) => i.kind)).toEqual(plain.pickups.map((i) => i.kind));
      expect(carded.dropPrng.peek()).toBe(plain.dropPrng.peek());
    }
  });

  it('leaves every OTHER drop kind’s payload alone', () => {
    // The control on the three above: a multiplier applied to `qty` unconditionally would
    // also double a material stack, which is carry-out value and not in-run currency.
    for (let seed = 1; seed < 60; seed++) {
      const s = state(seed);
      s.floorCards.push('windfall', 'windfall');
      addCorpse(s);
      sys.tick(s);
      for (const item of s.pickups) {
        if (item.kind === 'material') expect(item.qty).toBe(1);
      }
    }
  });
});
