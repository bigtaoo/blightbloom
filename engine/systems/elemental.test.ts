/**
 * Elemental damage types & status effects (design/03/07). Exercises the on-hit
 * status HitResolve starts, the DoT/chill StatusEffectSystem ticks, the lightning
 * chain, and the per-type resist/weakness multiplier. Physical is covered as the
 * unchanged baseline. All integer/fp — the determinism surface these add is the
 * status math and the chain nearest-search (no PRNG, no trig).
 */
import { describe, it, expect } from 'vitest';
import { toFp } from '@dd/engine/math/fixed';
import type { Brad } from '@dd/engine/math/trig';
import { createGameState } from '@dd/engine/state/GameState';
import type { GameState } from '@dd/engine/state/GameState';
import type { DamageType, ResistMap } from '@dd/engine/content/damage';
import {
  CHILL_SLOW,
  DOT_INTERVAL,
  POISON_MAX_STACKS,
  POISON_STACK_DMG,
  freshStatus,
} from '@dd/engine/content/damage';
import { ENEMY_TEAM_ID, type EnemyActor, type Faction, type Projectile } from '@dd/engine/state/entities';
import { BASIC_ENEMY, EMBERLING } from '@dd/engine/content/enemies';
import { pxToFp } from '@dd/engine/content/convert';
import { createGameEngine } from '@dd/engine/GameEngine';
import { HitResolveSystem, MovementSystem, StatusEffectSystem } from '@dd/engine/systems';

const CFG = { seed: 3, worldW: 1600, worldH: 1200, waves: [] as const };
const state = (): GameState => createGameState(CFG);

function addEnemy(s: GameState, xpx: number, ypx: number, resist?: ResistMap): EnemyActor {
  const e: EnemyActor = {
    id: s.nextId(), faction: 'enemy', teamId: ENEMY_TEAM_ID,
    gx: pxToFp(xpx), gy: pxToFp(ypx), z: toFp(0), vx: toFp(0), vy: toFp(0),
    knockVx: toFp(0), knockVy: toFp(0),
    facing: 0 as Brad, hp: BASIC_ENEMY.maxHp, maxHp: BASIC_ENEMY.maxHp,
    shield: 0, maxShield: 0, ticksSinceHit: 0,
    radius: BASIC_ENEMY.radius, footprintRadius: BASIC_ENEMY.footprintRadius, solidRadius: BASIC_ENEMY.radius,
    alive: true, weapon: null, firing: false, status: freshStatus(), resist, enraged: false, armorBroken: false, aggroed: false, holding: false,
  };
  s.enemies.push(e);
  return e;
}

function addBullet(s: GameState, xpx: number, ypx: number, type: DamageType, dmg: number, faction: Faction = 'player'): Projectile {
  const b: Projectile = {
    id: s.nextId(), faction, teamId: faction === 'enemy' ? ENEMY_TEAM_ID : 0,
    gx: pxToFp(xpx), gy: pxToFp(ypx), z: toFp(0),
    vx: toFp(0), vy: toFp(0), radius: pxToFp(5), damage: dmg, damageType: type,
    lifeTicks: 90, alive: true,
  };
  s.projectiles.push(b);
  return b;
}

describe('HitResolve — physical baseline (unchanged)', () => {
  it('deals raw damage and applies no status', () => {
    const s = state();
    const e = addEnemy(s, 400, 400);
    addBullet(s, 400, 400, 'physical', 2);
    new HitResolveSystem().tick(s);
    expect(e.hp).toBe(BASIC_ENEMY.maxHp - 2);
    expect(e.status.burnTicks).toBe(0);
    expect(e.status.chillTicks).toBe(0);
    expect(e.status.poison.length).toBe(0);
  });
});

describe('Fire — burn DoT', () => {
  it('a fire hit starts a burn that ticks damage on the DoT cadence', () => {
    const s = state();
    const e = addEnemy(s, 400, 400);
    addBullet(s, 400, 400, 'fire', 4); // burnDmg = max(1, 4>>1) = 2
    new HitResolveSystem().tick(s);
    expect(e.hp).toBe(BASIC_ENEMY.maxHp - 4); // direct hit
    expect(e.status.burnTicks).toBeGreaterThan(0);
    expect(e.status.burnDmg).toBe(2);

    // On a DoT-cadence tick the burn deals its per-interval damage.
    const before = e.hp;
    s.tick = DOT_INTERVAL; // multiple of the interval
    new StatusEffectSystem().tick(s);
    expect(e.hp).toBe(before - 2);
  });

  it('reapplying refreshes duration and keeps the stronger tick', () => {
    const s = state();
    const e = addEnemy(s, 400, 400);
    e.status.burnTicks = 3;
    e.status.burnDmg = 1;
    addBullet(s, 400, 400, 'fire', 6); // burnDmg = 3 > 1
    new HitResolveSystem().tick(s);
    expect(e.status.burnDmg).toBe(3);
    expect(e.status.burnTicks).toBeGreaterThan(3); // refreshed to full duration
  });
});

describe('Ice — chill slows movement', () => {
  it('a chilled actor moves slower; MovementSystem scales displacement by CHILL_SLOW', () => {
    const s = state();
    const p = s.players[0]!;
    const startGx = p.gx;
    p.vx = toFp(1); // 1000 fp / tick
    p.status.chillTicks = 10;
    p.status.chillSlow = CHILL_SLOW; // 400 ‰ → keep 600 ‰
    new MovementSystem().tick(s);
    const moved = (p.gx - startGx) as number;
    expect(moved).toBe(Math.trunc((1000 * (1000 - CHILL_SLOW)) / 1000)); // 600
  });

  it('a fire hit does NOT slow movement (only ice chills)', () => {
    const s = state();
    const p = s.players[0]!;
    const startGx = p.gx;
    p.vx = toFp(1);
    new MovementSystem().tick(s);
    expect((p.gx - startGx) as number).toBe(1000); // full speed
  });
});

describe('Poison — independent stacks', () => {
  it('each hit adds a stack (capped) and every stack ticks together', () => {
    const s = state();
    const e = addEnemy(s, 400, 400);
    const hr = new HitResolveSystem();
    // Three poison hits → three stacks.
    for (let i = 0; i < 3; i++) {
      addBullet(s, 400, 400, 'poison', 1);
      hr.tick(s);
    }
    expect(e.status.poison.length).toBe(3);

    const before = e.hp;
    s.tick = DOT_INTERVAL;
    new StatusEffectSystem().tick(s);
    expect(e.hp).toBe(before - 3 * POISON_STACK_DMG); // all stacks tick at once
  });

  it('stacks are capped at POISON_MAX_STACKS', () => {
    const s = state();
    const e = addEnemy(s, 400, 400);
    const hr = new HitResolveSystem();
    for (let i = 0; i < POISON_MAX_STACKS + 3; i++) {
      addBullet(s, 400, 400, 'poison', 1);
      hr.tick(s);
    }
    expect(e.status.poison.length).toBe(POISON_MAX_STACKS);
  });
});

describe('Lightning — chain to a neighbour', () => {
  it('the hit arcs to the nearest other enemy in range for reduced damage', () => {
    const s = state();
    const primary = addEnemy(s, 400, 400);
    const neighbour = addEnemy(s, 440, 400); // ~1.25 grid away (< CHAIN_RANGE = 3 grid)
    addBullet(s, 400, 400, 'lightning', 2);
    new HitResolveSystem().tick(s);
    expect(primary.hp).toBe(BASIC_ENEMY.maxHp - 2); // direct
    expect(neighbour.hp).toBe(BASIC_ENEMY.maxHp - 1); // chain = 50% of 2 = 1
  });

  it('does not chain when no other enemy is in range', () => {
    const s = state();
    const primary = addEnemy(s, 400, 400);
    const faraway = addEnemy(s, 1200, 400); // way beyond CHAIN_RANGE
    addBullet(s, 400, 400, 'lightning', 2);
    new HitResolveSystem().tick(s);
    expect(primary.hp).toBe(BASIC_ENEMY.maxHp - 2);
    expect(faraway.hp).toBe(BASIC_ENEMY.maxHp); // untouched
  });
});

describe('Resist / weakness', () => {
  it('a resistant enemy takes reduced damage (floored at 1)', () => {
    const s = state();
    const e = addEnemy(s, 400, 400, { fire: 500 }); // ×0.5
    addBullet(s, 400, 400, 'fire', 2);
    new HitResolveSystem().tick(s);
    expect(e.hp).toBe(BASIC_ENEMY.maxHp - 1); // 2 × 0.5 = 1
  });

  it('a weak enemy takes amplified damage', () => {
    const s = state();
    const e = addEnemy(s, 400, 400, { fire: 2000 }); // ×2
    addBullet(s, 400, 400, 'fire', 2);
    new HitResolveSystem().tick(s);
    expect(e.hp).toBe(BASIC_ENEMY.maxHp - 4); // 2 × 2 = 4
  });

  it('a weakness rounds a low-base hit up so the bonus is visible (not truncated to 1)', () => {
    const s = state();
    const e = addEnemy(s, 400, 400, { fire: 1800 }); // ×1.8
    addBullet(s, 400, 400, 'fire', 1); // 1 × 1.8 = 1.8 → rounds to 2 (trunc would give 1)
    new HitResolveSystem().tick(s);
    expect(e.hp).toBe(BASIC_ENEMY.maxHp - 2);
  });

  it('resist to one type does not affect another', () => {
    const s = state();
    const e = addEnemy(s, 400, 400, { fire: 500 });
    addBullet(s, 400, 400, 'ice', 2); // ice unaffected by fire resist
    new HitResolveSystem().tick(s);
    expect(e.hp).toBe(BASIC_ENEMY.maxHp - 2);
  });
});

describe('Enemy variants — SpawnSystem resolves a blueprint by wave type', () => {
  it("a typed wave entry spawns that variant with its hp / resist / tint", () => {
    const eng = createGameEngine({
      seed: 5, worldW: 800, worldH: 600, playerStart: [400, 300],
      waves: [[[600, 300, 'emberling']]],
    });
    eng.step([]); // tick 1 → SpawnSystem dispatches wave 0
    const e = eng.state.enemies[0]!;
    expect(e.maxHp).toBe(EMBERLING.maxHp);
    expect(e.resist).toEqual(EMBERLING.resist);
    expect(e.tint).toBe(EMBERLING.tint);
  });

  it('a bare [x, y] entry still spawns the basic (neutral) mob', () => {
    const eng = createGameEngine({
      seed: 5, worldW: 800, worldH: 600, playerStart: [400, 300],
      waves: [[[600, 300]]],
    });
    eng.step([]);
    const e = eng.state.enemies[0]!;
    expect(e.maxHp).toBe(BASIC_ENEMY.maxHp);
    expect(e.resist).toBeUndefined();
  });
});
