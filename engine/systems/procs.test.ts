/**
 * k_* on-hit procs (design/03/09, ENGINE_VERSION 28 — the first concrete batch:
 * k_lifesteal, k_ricochet, plus wiring the long-authored-but-dead `piercing` field
 * found while building ricochet). Exercises the real HitResolveSystem/WeaponFireSystem,
 * not just hand-called helpers, so the actual fire→hit→fate pipeline is covered.
 *
 * Bullets are snapped onto the target's exact position after firing (like several
 * other test files' `enemyOnPlayer`-style fixtures) — this isolates HitResolveSystem's
 * own logic from muzzle-offset/travel-time arithmetic, which isn't what these tests
 * are about.
 */
import { describe, it, expect } from 'vitest';
import { toFp } from '@dd/engine/math/fixed';
import type { Brad } from '@dd/engine/math/trig';
import { createGameState } from '@dd/engine/state/GameState';
import type { GameState } from '@dd/engine/state/GameState';
import { ENEMY_TEAM_ID, type EnemyActor, type RangedSimSpec } from '@dd/engine/state/entities';
import { pxToFp } from '@dd/engine/content/convert';
import { freshStatus } from '@dd/engine/content/damage';
import { BASIC_ENEMY } from '@dd/engine/content/enemies';
import { makeWeapon, openSwing, CAROM_SIM, LEECH_SIM } from '@dd/engine/content/weapons';
import { HitResolveSystem, WeaponFireSystem } from '@dd/engine/systems';

const CFG = { seed: 17, worldW: 1600, worldH: 1200, playerStart: [400, 400] as const, waves: [] as const };
const state = (): GameState => createGameState(CFG);

function addEnemy(s: GameState, xpx: number, ypx: number, hp: number = BASIC_ENEMY.maxHp): EnemyActor {
  const e: EnemyActor = {
    id: s.nextId(), faction: 'enemy', teamId: ENEMY_TEAM_ID,
    gx: pxToFp(xpx), gy: pxToFp(ypx), z: toFp(0), vx: toFp(0), vy: toFp(0),
    knockVx: toFp(0), knockVy: toFp(0),
    facing: 0 as Brad, hp, maxHp: BASIC_ENEMY.maxHp, shield: 0, maxShield: 0,
    ticksSinceHit: 0, radius: BASIC_ENEMY.radius,
    footprintRadius: BASIC_ENEMY.footprintRadius, solidRadius: BASIC_ENEMY.radius,
    alive: true, weapon: null, firing: false, status: freshStatus(), enraged: false, armorBroken: false, aggroed: false, holding: false,
  };
  s.enemies.push(e);
  return e;
}

/** Fire once with `spec` and snap the resulting bullet exactly onto `target` — a
 * guaranteed overlap next HitResolveSystem tick, independent of muzzle/travel math. */
function fireOnto(s: GameState, spec: RangedSimSpec, target: EnemyActor) {
  const p = s.players[0]!;
  p.weapon = makeWeapon(spec);
  p.firing = true;
  new WeaponFireSystem().tick(s);
  const b = s.projectiles[s.projectiles.length - 1]!;
  b.gx = target.gx;
  b.gy = target.gy;
  return b;
}

describe('k_lifesteal (design/03/09)', () => {
  it('ranged: heals the firing player, clamped to maxHp', () => {
    const s = state();
    const p = s.players[0]!;
    p.hp = 1; // room to heal into
    const e = addEnemy(s, 460, 400);
    const spec: RangedSimSpec = { ...CAROM_SIM, damage: 10, lifestealPermille: 500, ricochetCount: 0 };
    fireOnto(s, spec, e);
    new HitResolveSystem().tick(s);
    expect(e.hp).toBeLessThan(BASIC_ENEMY.maxHp); // the hit actually landed
    expect(p.hp).toBe(Math.min(p.maxHp, 1 + Math.trunc((10 * 500) / 1000))); // +5, clamped
  });

  it('melee: heals on every target hit within the same swing', () => {
    const s = state();
    const p = s.players[0]!;
    p.hp = 1;
    p.weapon = makeWeapon(LEECH_SIM);
    openSwing(p.weapon); // latches justSwung AND opens the active window (design/07 step 7)
    p.facing = 0 as Brad;
    const e1 = addEnemy(s, 430, 400); // in arc
    const e2 = addEnemy(s, 440, 400); // also in arc
    new HitResolveSystem().tick(s);
    expect(e1.hp).toBeLessThan(BASIC_ENEMY.maxHp);
    expect(e2.hp).toBeLessThan(BASIC_ENEMY.maxHp);
    expect(p.hp).toBeGreaterThan(1); // healed at least once (both hits, if unclamped, would heal twice)
  });

  it('a weapon with no lifesteal never changes the attacker HP', () => {
    const s = state();
    const p = s.players[0]!;
    p.hp = 1;
    const e = addEnemy(s, 460, 400);
    const spec: RangedSimSpec = { ...CAROM_SIM, lifestealPermille: undefined, ricochetCount: 0 };
    fireOnto(s, spec, e);
    new HitResolveSystem().tick(s);
    expect(p.hp).toBe(1);
  });
});

describe('k_ricochet (design/03/09)', () => {
  it('retargets to the nearest OTHER hostile within range instead of expiring, decrementing ricochetsLeft', () => {
    const s = state();
    const first = addEnemy(s, 460, 400);
    const second = addEnemy(s, 460, 420); // nearby — the ricochet target
    const spec: RangedSimSpec = { ...CAROM_SIM, ricochetCount: 1, lifestealPermille: undefined };
    const bullet = fireOnto(s, spec, first);
    new HitResolveSystem().tick(s);
    expect(first.hp).toBeLessThan(BASIC_ENEMY.maxHp); // first hit landed
    expect(bullet.alive).toBe(true); // survived — bounced, didn't expire
    expect(bullet.ricochetsLeft).toBe(0); // consumed its one bounce
    // Redirected toward `second` (below first on the y-axis), not still along
    // whatever direction it was originally travelling.
    expect(bullet.vy).toBeGreaterThan(0);
    expect(second.hp).toBe(BASIC_ENEMY.maxHp); // not hit YET — the retarget just aims it there
  });

  it('a retargeted bullet never re-hits the SAME body it just bounced off, even while still overlapping it (caught live)', () => {
    const s = state();
    // Deliberately close together — large enough combined radii that the bullet is
    // still inside `first`'s circle for a tick or two after the bounce, the exact
    // scenario a real Chrome session caught: without the hitIds guard, ricochet would
    // burn both its bounces re-hitting `first` and never actually reach `second`.
    const first = addEnemy(s, 460, 400);
    addEnemy(s, 470, 410); // `second` — the retarget's only valid destination
    const spec: RangedSimSpec = { ...CAROM_SIM, ricochetCount: 2, lifestealPermille: undefined };
    const bullet = fireOnto(s, spec, first);
    const hitResolve = new HitResolveSystem();
    hitResolve.tick(s); // first hit + retarget toward `second`
    const hpAfterFirstBounce = first.hp;
    expect(bullet.ricochetsLeft).toBe(1);
    expect(bullet.hitIds).toContain(first.id);
    // The bullet hasn't moved (position untouched here, isolating the resolver) — if
    // it were still tested against `first`, this tick would wrongly hit it again.
    hitResolve.tick(s);
    expect(first.hp).toBe(hpAfterFirstBounce); // NOT hit again
  });

  it('with no bounces left, the bullet expires normally on hit', () => {
    const s = state();
    const first = addEnemy(s, 460, 400);
    addEnemy(s, 460, 420); // in range, but no bounces to spend
    const spec: RangedSimSpec = { ...CAROM_SIM, ricochetCount: 0, lifestealPermille: undefined };
    const bullet = fireOnto(s, spec, first);
    new HitResolveSystem().tick(s);
    expect(bullet.alive).toBe(false);
  });

  it('with bounces left but no OTHER target in range, it expires instead of looping forever', () => {
    const s = state();
    const first = addEnemy(s, 460, 400); // the only enemy — nothing else to bounce to
    const spec: RangedSimSpec = { ...CAROM_SIM, ricochetCount: 3, lifestealPermille: undefined };
    const bullet = fireOnto(s, spec, first);
    new HitResolveSystem().tick(s);
    expect(bullet.alive).toBe(false);
  });
});

describe('piercing (authored since Stage C, wired ENGINE_VERSION 28)', () => {
  it('a piercing bullet survives its first hit and remembers the target (never re-hits it)', () => {
    const s = state();
    const e = addEnemy(s, 460, 400);
    const spec: RangedSimSpec = { ...CAROM_SIM, piercing: true, ricochetCount: 0, lifestealPermille: undefined };
    const bullet = fireOnto(s, spec, e);
    new HitResolveSystem().tick(s);
    const hpAfterFirstHit = e.hp;
    expect(bullet.alive).toBe(true); // pierced through, didn't expire
    expect(bullet.hitIds).toContain(e.id);
    // Still overlapping the SAME body next tick (bullet position untouched here, to
    // isolate the resolver from movement) — must NOT deal a second hit.
    new HitResolveSystem().tick(s);
    expect(e.hp).toBe(hpAfterFirstHit);
  });

  it('a non-piercing bullet expires on its first hit, unchanged from the pre-existing behavior', () => {
    const s = state();
    const e = addEnemy(s, 460, 400);
    const spec: RangedSimSpec = { ...CAROM_SIM, piercing: false, ricochetCount: 0, lifestealPermille: undefined };
    const bullet = fireOnto(s, spec, e);
    new HitResolveSystem().tick(s);
    expect(bullet.alive).toBe(false);
  });
});

describe('ownerId is now set on every bullet (ENGINE_VERSION 28), not just orbit', () => {
  it("a plain straight-ballistic shot carries the firing actor's id", () => {
    const s = state();
    const p = s.players[0]!;
    p.firing = true;
    new WeaponFireSystem().tick(s);
    expect(s.projectiles[0]!.ownerId).toBe(p.id);
  });
});
