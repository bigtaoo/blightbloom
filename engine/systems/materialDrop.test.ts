/**
 * The `stockpile` floor card (Task 8, "catalogue expansion", 2026-09-23) — same shape,
 * and the same reason for existing, as `coinDrop.test.ts`'s own `windfall` suite next
 * door: `material_drop_mult` is applied in `DeathDropsSystem`, outside `rollDrop`
 * (a card that changes a PAYLOAD must stay outside the draw), so `drops.test.ts` cannot
 * see it and `floorCards.test.ts` only sees the number it resolves to.
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
import { MATERIAL_DROP_QTY } from '@dd/engine/content/drops';
import { COIN_DROP_QTY } from '@dd/engine/config';

const sys = new DeathDropsSystem();

function state(seed: number): GameState {
  return createGameState({ seed, worldW: 1600, worldH: 1600, waves: [] });
}

/** Same hand-built corpse shape as `coinDrop.test.ts`/`blueprintDrop.test.ts` next door —
 *  two disagreeing copies would be two tests pretending to be the same one. */
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

/** Kill enemies on successive seeds until one rolls a material, same "hunt rather than
 *  hand-pick a seed" reasoning as `coinDrop.test.ts firstCoinDrop`. */
function firstMaterialDrop(cards: string[] = []): { s: GameState; qty: number } {
  for (let seed = 1; seed < 200; seed++) {
    const s = state(seed);
    s.floorCards.push(...cards);
    addCorpse(s);
    sys.tick(s);
    const material = s.pickups.find((i) => i.kind === 'material');
    if (material) return { s, qty: material.qty ?? 0 };
  }
  throw new Error('no material drop in 200 seeds — the table has stopped producing materials');
}

describe('the stockpile card', () => {
  it('doubles a material drop’s payload', () => {
    expect(firstMaterialDrop(['stockpile']).qty).toBe(MATERIAL_DROP_QTY * 2);
  });

  it('compounds across two picks', () => {
    expect(firstMaterialDrop(['stockpile', 'stockpile']).qty).toBe(MATERIAL_DROP_QTY * 4);
  });

  it('does NOT change which drop comes up — it is a payload card, not a table card', () => {
    for (let seed = 1; seed < 25; seed++) {
      const plain = state(seed);
      addCorpse(plain);
      sys.tick(plain);

      const carded = state(seed);
      carded.floorCards.push('stockpile');
      addCorpse(carded);
      sys.tick(carded);

      expect(carded.pickups.map((i) => i.kind)).toEqual(plain.pickups.map((i) => i.kind));
      expect(carded.dropPrng.peek()).toBe(plain.dropPrng.peek());
    }
  });

  it('leaves every OTHER drop kind’s payload alone', () => {
    // The control on the three above: a multiplier applied to `qty` unconditionally would
    // also double a coin's payload, which is in-run currency and not carry-out value.
    for (let seed = 1; seed < 60; seed++) {
      const s = state(seed);
      s.floorCards.push('stockpile', 'stockpile');
      addCorpse(s);
      sys.tick(s);
      for (const item of s.pickups) {
        if (item.kind === 'coin') expect(item.qty).toBe(COIN_DROP_QTY);
      }
    }
  });
});
