/**
 * balance/encounter.ts — the room encounter budget's two constants and the one pure
 * function derived from them (ENGINE_VERSION 41). The behavioural half is tested
 * where it lives (`systems/AIDecideSystem.test.ts`'s v41 describe block, plus the
 * end-to-end pass in `systems/dungeonrun.test.ts`); this file pins the properties
 * those tests — and the level's difficulty tuning — silently rely on.
 */
import { describe, expect, it } from 'vitest';
import {
  NOTICE_DELAY_TICKS,
  NOTICE_SPREAD_TICKS,
  ROOM_FIRE_BUDGET,
  noticeDelayTicks,
  roomFireBudget,
} from './encounter';
import { EMBER_DUNGEON } from '../world/rooms/ember';
import { DEFAULT_ENEMY_ENGAGE_RANGE_FP } from '../content/enemies';
import { WEAPON_SPECS } from '../content/weapons';
import { SKIN_DEFS } from '../content/skins';

describe('ROOM_FIRE_BUDGET', () => {
  it('is at least 1 — a room with a garrison has to be able to shoot back at all', () => {
    expect(ROOM_FIRE_BUDGET).toBeGreaterThanOrEqual(1);
  });

  it('INVARIANT: the sustained damage it allows cannot kill the frailest character inside 3 seconds', () => {
    // The actual survivability arithmetic the budget was sized on, recomputed from
    // content rather than restated as a magic number — so a change to the enemy gun's
    // cooldown/damage, or to a character's pools, fails HERE instead of silently
    // reintroducing the alpha strike this constant exists to prevent.
    const gun = WEAPON_SPECS.enemygun!;
    const damagePerSecond = (ROOM_FIRE_BUDGET * gun.damage) / gun.cooldownSec;
    const frailest = Math.min(...Object.values(SKIN_DEFS).map((s) => s.maxHp + s.maxShield));
    expect(damagePerSecond * 3).toBeLessThan(frailest);
  });
});

describe('roomFireBudget (ENGINE_VERSION 90)', () => {
  it("reads the floor's own entry, and ROOM_FIRE_BUDGET with no entry or no table", () => {
    expect(roomFireBudget([1, 3], 0)).toBe(1);
    expect(roomFireBudget([1, 3], 1)).toBe(3);
    expect(roomFireBudget([1, 3], 2)).toBe(ROOM_FIRE_BUDGET);
    expect(roomFireBudget(undefined, 0)).toBe(ROOM_FIRE_BUDGET);
  });

  it("chapter 1 is one shooter at a time on every floor but the boss's (ENGINE_VERSION 91)", () => {
    // The 2026-11-06 report: a first-time player died walking into floor 1's second room. v90
    // made only floor 1 a one-shooter floor, and the 2026-11-07 first-run pass found the wall had
    // moved to floor 2, where the second shooter arrived; every floor before the boss is one now.
    const last = EMBER_DUNGEON.floorCount - 1;
    for (let f = 0; f < last; f++) expect(roomFireBudget(EMBER_DUNGEON.fireBudgetByFloor, f), `floor ${f}`).toBe(1);
    expect(roomFireBudget(EMBER_DUNGEON.fireBudgetByFloor, last)).toBe(ROOM_FIRE_BUDGET);
  });

  it('every authored entry is a whole number from 1 up to ROOM_FIRE_BUDGET — an opener is never the harder floor', () => {
    for (const b of EMBER_DUNGEON.fireBudgetByFloor ?? []) {
      expect(Number.isInteger(b)).toBe(true);
      expect(b).toBeGreaterThanOrEqual(1);
      expect(b).toBeLessThanOrEqual(ROOM_FIRE_BUDGET);
    }
  });
});

describe('noticeDelayTicks', () => {
  it('never returns less than the floor, nor more than floor + spread', () => {
    for (let id = 0; id < 500; id++) {
      const d = noticeDelayTicks(id);
      expect(d).toBeGreaterThanOrEqual(NOTICE_DELAY_TICKS);
      expect(d).toBeLessThan(NOTICE_DELAY_TICKS + NOTICE_SPREAD_TICKS);
    }
  });

  it('is a floor of ~0.5s and a spread of ~1s at 30Hz — the reaction window on room entry', () => {
    expect(NOTICE_DELAY_TICKS).toBeGreaterThanOrEqual(15);
    expect(NOTICE_SPREAD_TICKS).toBeGreaterThanOrEqual(15);
  });

  it('staggers consecutive ids — a room’s spawn order must not land on one synchronised volley', () => {
    // Consecutive ids are exactly what a room's garrison gets (`GameState.nextId` in
    // spawn order), so this is the case that matters, not a random sample.
    const delays = Array.from({ length: 14 }, (_, i) => noticeDelayTicks(100 + i));
    expect(new Set(delays).size).toBe(delays.length);
  });

  it('is a pure function of the id — same id, same delay, no hidden state or PRNG draw', () => {
    expect(noticeDelayTicks(7)).toBe(noticeDelayTicks(7));
    expect(noticeDelayTicks(12345)).toBe(noticeDelayTicks(12345));
  });

  it('gives the mob time to be seen closing before it can shoot, even from point-blank', () => {
    // A mob authored inside engage range is the case the delay exists for: it cannot
    // shoot for at least NOTICE_DELAY_TICKS regardless of how close it starts.
    expect(DEFAULT_ENEMY_ENGAGE_RANGE_FP).toBeGreaterThan(0);
    expect(noticeDelayTicks(0)).toBe(NOTICE_DELAY_TICKS);
  });
});
