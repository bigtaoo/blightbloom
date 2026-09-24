/**
 * Frame library beyond `straight` (design/03/09 Frame axis, ROADMAP 1.1): spread
 * emission (WeaponFireSystem) and the homing/lob/beam/boomerang ballistics
 * (ProjectileStepSystem step 5 + HitResolveSystem step 7). Melee hammer/spear need
 * no new mechanic — MeleeSimSpec is already generic — so they are not re-tested
 * here beyond confirming the catalog resolves (weapons.test.ts-style coverage
 * would be redundant with the existing WEAPON_SIM_BY_ID shape).
 */
import { describe, it, expect } from 'vitest';
import { toFp } from '@dd/engine/math/fixed';
import type { Brad } from '@dd/engine/math/trig';
import { createGameState } from '@dd/engine/state/GameState';
import type { GameState } from '@dd/engine/state/GameState';
import { ENEMY_TEAM_ID, type EnemyActor, type Faction, type Projectile } from '@dd/engine/state/entities';
import { pxToFp } from '@dd/engine/content/convert';
import { freshStatus } from '@dd/engine/content/damage';
import { BASIC_ENEMY } from '@dd/engine/content/enemies';
import {
  makeWeapon,
  SCATTERGUN_SIM,
  SEEKER_SIM,
  MORTAR_SIM,
  LASERCUTTER_SIM,
  TOMAHAWK_SIM,
  BLASTER_SIM,
  NOVABURST_SIM,
  GYRE_SIM,
} from '@dd/engine/content/weapons';
import { addFp } from '@dd/engine/math/fixed';
import { HitResolveSystem, ProjectileStepSystem, WeaponFireSystem } from '@dd/engine/systems';
import { createGameEngine } from '@dd/engine/GameEngine';
import { Button } from '@dd/engine/state/commands';
import { makeCommand } from '@dd/engine/state/input';

const CFG = { seed: 11, worldW: 1600, worldH: 1200, waves: [] as const };
const state = (): GameState => createGameState(CFG);

function addEnemy(s: GameState, xpx: number, ypx: number): EnemyActor {
  const e: EnemyActor = {
    id: s.nextId(), faction: 'enemy', teamId: ENEMY_TEAM_ID,
    gx: pxToFp(xpx), gy: pxToFp(ypx), z: toFp(0), vx: toFp(0), vy: toFp(0),
    knockVx: toFp(0), knockVy: toFp(0),
    facing: 0 as Brad, hp: BASIC_ENEMY.maxHp, maxHp: BASIC_ENEMY.maxHp,
    shield: 0, maxShield: 0, ticksSinceHit: 0,
    radius: BASIC_ENEMY.radius, footprintRadius: BASIC_ENEMY.footprintRadius, solidRadius: BASIC_ENEMY.radius,
    alive: true, weapon: null, firing: false, status: freshStatus(), enraged: false, armorBroken: false, aggroed: false, holding: false,
  };
  s.enemies.push(e);
  return e;
}

function addBullet(
  s: GameState,
  xpx: number,
  ypx: number,
  overrides: Partial<Projectile>,
  faction: Faction = 'player',
): Projectile {
  const b: Projectile = {
    id: s.nextId(), faction, teamId: faction === 'enemy' ? ENEMY_TEAM_ID : 0,
    gx: pxToFp(xpx), gy: pxToFp(ypx), z: toFp(0),
    vx: toFp(0), vy: toFp(0), radius: pxToFp(5), damage: 2,
    damageType: 'physical', lifeTicks: 90, alive: true,
    ...overrides,
  };
  s.projectiles.push(b);
  return b;
}

describe('Emission — spread (WeaponFireSystem)', () => {
  it('a single-pellet weapon fires exactly one bullet with no jitter (unchanged baseline)', () => {
    const s = state();
    const p = s.players[0]!;
    p.weapon = makeWeapon(BLASTER_SIM);
    p.firing = true;
    p.facing = 0 as Brad;
    new WeaponFireSystem().tick(s);
    expect(s.projectiles).toHaveLength(1);
    expect(s.projectiles[0]!.vy).toBe(toFp(0)); // straight along facing — no vertical jitter
  });

  it('a spread weapon fires `bullets` pellets, each jittered within the cone', () => {
    const s = state();
    const p = s.players[0]!;
    p.weapon = makeWeapon(SCATTERGUN_SIM);
    p.firing = true;
    p.facing = 0 as Brad;
    new WeaponFireSystem().tick(s);
    expect(s.projectiles).toHaveLength(SCATTERGUN_SIM.bullets);
    // Every pellet's fire direction stays within ±spreadHalf of facing (0).
    for (const b of s.projectiles) {
      const dir = Math.atan2(b.vy as number, b.vx as number);
      expect(Math.abs(dir)).toBeLessThanOrEqual((SCATTERGUN_SIM.spreadHalf / 65536) * 2 * Math.PI + 0.05);
    }
  });

  it('spread jitter is deterministic for a given seed', () => {
    const fire = () => {
      const s = state();
      const p = s.players[0]!;
      p.weapon = makeWeapon(SCATTERGUN_SIM);
      p.firing = true;
      p.facing = 0 as Brad;
      new WeaponFireSystem().tick(s);
      return s.projectiles.map((b) => [b.vx, b.vy]);
    };
    expect(fire()).toEqual(fire());
  });
});

/**
 * `bullet_fired.ownerId` (2026-08-30). The render layer needs to know WHO fired, not just
 * where: the muzzle fx are anchored on the shooter's drawn barrel tip and the recoil has to
 * play on that one rig (`client/game/controllers/EventReactor`). fx-only and never read back
 * by a later system, exactly like the rest of the event queue (design/08) — so this is the
 * kind of additive field that ships without an ENGINE_VERSION bump, and what has to be pinned
 * is that it names the real shooter on every emission path rather than defaulting to 0.
 */
describe('Emission — every bullet_fired names its shooter', () => {
  const fired = (s: GameState) => s.events.filter((e) => e.type === 'bullet_fired');

  it('reports the firing PLAYER, not a bullet id or a default', () => {
    const s = state();
    const p = s.players[0]!;
    p.weapon = makeWeapon(BLASTER_SIM);
    p.firing = true;
    new WeaponFireSystem().tick(s);
    expect(fired(s)).toHaveLength(1);
    expect(fired(s)[0]!.ownerId).toBe(p.id);
    // Same id the projectile itself carries, so `Scene` and `EventReactor` resolve the same
    // actor view for the same shot.
    expect(s.projectiles[0]!.ownerId).toBe(p.id);
  });

  it('reports the firing ENEMY — a mob’s shots recoil the same way', () => {
    const s = state();
    const e = addEnemy(s, 100, 100);
    e.weapon = makeWeapon(BLASTER_SIM);
    e.firing = true;
    new WeaponFireSystem().tick(s);
    expect(fired(s)).toHaveLength(1);
    expect(fired(s)[0]!.ownerId).toBe(e.id);
  });

  it('stamps EVERY pellet of a multi-pellet shot, not just the first', () => {
    const s = state();
    const p = s.players[0]!;
    p.weapon = makeWeapon(SCATTERGUN_SIM);
    p.firing = true;
    const events = (new WeaponFireSystem().tick(s), fired(s));
    expect(events).toHaveLength(SCATTERGUN_SIM.bullets);
    for (const e of events) expect(e.ownerId).toBe(p.id);
  });

  it('tells two simultaneous shooters apart in the same frame', () => {
    const s = state();
    const p = s.players[0]!;
    p.weapon = makeWeapon(BLASTER_SIM);
    p.firing = true;
    const e = addEnemy(s, 300, 300);
    e.weapon = makeWeapon(BLASTER_SIM);
    e.firing = true;
    new WeaponFireSystem().tick(s);
    expect(fired(s).map((ev) => ev.ownerId).sort((a, b) => a - b)).toEqual([p.id, e.id].sort((a, b) => a - b));
    expect(p.id).not.toBe(e.id);
  });
});

describe('Emission — radial (WeaponFireSystem)', () => {
  it('fires `bullets` pellets in an even ring, deterministically, drawing NO combat PRNG', () => {
    const s = state();
    const p = s.players[0]!;
    p.weapon = makeWeapon(NOVABURST_SIM);
    p.firing = true;
    p.facing = 0 as Brad;
    const prngBefore = s.combatPrng.peek(); // radial must not advance the combat stream
    new WeaponFireSystem().tick(s);
    expect(s.projectiles).toHaveLength(NOVABURST_SIM.bullets);
    expect(s.combatPrng.peek()).toBe(prngBefore); // no jitter draw at all (unlike spread)
    // Pellet 0 flies straight along facing; the rest fan around the full circle, so the
    // set of directions spans well past a single cone — a genuine ring, not a spread.
    const dirs = s.projectiles.map((b) => Math.atan2(b.vy as number, b.vx as number));
    expect(Math.max(...dirs) - Math.min(...dirs)).toBeGreaterThan(Math.PI); // > 180° of coverage
  });

  it('the ring is identical run-to-run (no PRNG → pure function of facing)', () => {
    const fire = () => {
      const s = state();
      const p = s.players[0]!;
      p.weapon = makeWeapon(NOVABURST_SIM);
      p.firing = true;
      p.facing = 4000 as Brad;
      new WeaponFireSystem().tick(s);
      return s.projectiles.map((b) => [b.vx, b.vy]);
    };
    expect(fire()).toEqual(fire());
  });
});

describe('Ballistic — orbit', () => {
  it('circles the owner at a fixed radius, advancing its angle each tick', () => {
    const s = state();
    const owner = s.players[0]!;
    const r = GYRE_SIM.orbitRadius!;
    const b = addBullet(s, 0, 0, {
      vx: toFp(0), vy: toFp(0), lifeTicks: 999,
      ballistic: 'orbit', ownerId: owner.id, orbitRadius: r,
      orbitAngleBrad: 0 as Brad, orbitAngularVelBrad: GYRE_SIM.orbitAngularVelBrad,
    });
    new ProjectileStepSystem().tick(s);
    // Sits on the orbit circle around the owner (± fp-trig table rounding).
    const dx = (b.gx - owner.gx) as number;
    const dy = (b.gy - owner.gy) as number;
    const dist = Math.round(Math.sqrt(dx * dx + dy * dy));
    expect(Math.abs(dist - (r as number))).toBeLessThan(20);
    expect(b.orbitAngleBrad).not.toBe(0); // the angle advanced
    expect(b.alive).toBe(true);
  });

  it('tracks a MOVING owner — re-centres on the owner every tick', () => {
    const s = state();
    const owner = s.players[0]!;
    const b = addBullet(s, 0, 0, {
      vx: toFp(0), vy: toFp(0), lifeTicks: 999,
      ballistic: 'orbit', ownerId: owner.id, orbitRadius: GYRE_SIM.orbitRadius!,
      orbitAngleBrad: 0 as Brad, orbitAngularVelBrad: GYRE_SIM.orbitAngularVelBrad,
    });
    new ProjectileStepSystem().tick(s);
    const off1x = (b.gx - owner.gx) as number;
    owner.gx = addFp(owner.gx, toFp(200)); // the wielder walks +x
    new ProjectileStepSystem().tick(s);
    const off2x = (b.gx - owner.gx) as number;
    // The bullet stays close to the owner after the move (offset is the orbit radius,
    // NOT the 200-unit displacement it would show if it flew straight).
    expect(Math.abs(off2x)).toBeLessThanOrEqual((GYRE_SIM.orbitRadius as number) + 20);
    expect(off1x).not.toBe(undefined);
  });

  it('dies when its owner is gone (nothing left to circle)', () => {
    const s = state();
    const b = addBullet(s, 0, 0, {
      vx: toFp(0), vy: toFp(0), lifeTicks: 999,
      ballistic: 'orbit', ownerId: 99999, orbitRadius: GYRE_SIM.orbitRadius!,
      orbitAngleBrad: 0 as Brad, orbitAngularVelBrad: GYRE_SIM.orbitAngularVelBrad,
    });
    new ProjectileStepSystem().tick(s);
    expect(b.alive).toBe(false);
  });

  it('fired via the weapon, a gyre bullet is tagged orbit and owned by the shooter', () => {
    const s = state();
    const p = s.players[0]!;
    p.weapon = makeWeapon(GYRE_SIM);
    p.firing = true;
    new WeaponFireSystem().tick(s);
    const b = s.projectiles[0]!;
    expect(b.ballistic).toBe('orbit');
    expect(b.ownerId).toBe(p.id);
    expect(b.orbitRadius).toBe(GYRE_SIM.orbitRadius);
  });
});

describe('Ballistic — homing', () => {
  it('turns toward the nearest enemy, clamped by turnRateBrad', () => {
    const s = state();
    addEnemy(s, 900, 700); // off to the side, not directly ahead
    const b = addBullet(s, 800, 600, {
      vx: toFp(11), vy: toFp(0), // currently flying +x
      ballistic: 'homing', turnRateBrad: SEEKER_SIM.turnRateBrad, speed: toFp(11),
    });
    const before = Math.atan2(b.vy as number, b.vx as number);
    new ProjectileStepSystem().tick(s);
    const after = Math.atan2(b.vy as number, b.vx as number);
    expect(after).not.toBe(before); // it turned
    // Speed (magnitude) is preserved while turning (± fp-trig table rounding).
    const mag = Math.round(Math.sqrt((b.vx as number) ** 2 + (b.vy as number) ** 2));
    expect(Math.abs(mag - 11000)).toBeLessThan(20);
  });

  it('fired via the weapon, a seeker bullet is tagged homing with a frozen speed', () => {
    const s = state();
    const p = s.players[0]!;
    p.weapon = makeWeapon(SEEKER_SIM);
    p.firing = true;
    new WeaponFireSystem().tick(s);
    const b = s.projectiles[0]!;
    expect(b.ballistic).toBe('homing');
    expect(b.speed).toBe(SEEKER_SIM.bulletSpeed);
  });
});

describe('Ballistic — lob', () => {
  it('flies straight, then on lifespan end is flagged landed instead of dying', () => {
    const s = state();
    const b = addBullet(s, 800, 600, {
      vx: toFp(1), vy: toFp(0), lifeTicks: 1,
      ballistic: 'lob', blastRadius: MORTAR_SIM.blastRadius,
    });
    new ProjectileStepSystem().tick(s);
    expect(b.alive).toBe(true); // still alive — HitResolve resolves the blast
    expect(b.landed).toBe(true);
  });

  it('a landed lob damages every opposite-faction actor within blastRadius, then dies', () => {
    const s = state();
    const close = addEnemy(s, 820, 600); // inside the blast
    const far = addEnemy(s, 1200, 600); // outside
    const b = addBullet(s, 800, 600, {
      vx: toFp(0), vy: toFp(0), landed: true, damage: 2,
      blastRadius: MORTAR_SIM.blastRadius,
    });
    new HitResolveSystem().tick(s);
    expect(close.hp).toBe(BASIC_ENEMY.maxHp - 2);
    expect(far.hp).toBe(BASIC_ENEMY.maxHp);
    expect(b.alive).toBe(false);
  });
});

describe('Ballistic — beam', () => {
  it('does not move; ProjectileStepSystem only counts down its own duration', () => {
    const s = state();
    const b = addBullet(s, 800, 600, {
      vx: toFp(0), vy: toFp(0), lifeTicks: 999,
      ballistic: 'beam', beamTicksLeft: 3, beamTickInterval: 2,
    });
    new ProjectileStepSystem().tick(s);
    expect(b.gx).toBe(pxToFp(800)); // frozen in place
    expect(b.beamTicksLeft).toBe(2);
    expect(b.alive).toBe(true);
    new ProjectileStepSystem().tick(s);
    new ProjectileStepSystem().tick(s);
    expect(b.alive).toBe(false); // beamTicksLeft hit 0
  });

  it('damages every opposite-faction actor along its line, on the beamTickInterval cadence', () => {
    const s = state();
    s.tick = 4; // multiple of beamTickInterval below
    const inLine = addEnemy(s, 850, 600); // ahead, in the frozen facing (0 brad = +x)
    const offLine = addEnemy(s, 800, 650); // same range, but perpendicular — outside the narrow line
    addBullet(s, 800, 600, {
      vx: toFp(0), vy: toFp(0), damage: 1,
      ballistic: 'beam', beamDir: 0 as Brad, beamRange: LASERCUTTER_SIM.beamRange,
      beamTicksLeft: 4, beamTickInterval: 2,
    });
    new HitResolveSystem().tick(s);
    expect(inLine.hp).toBe(BASIC_ENEMY.maxHp - 1);
    expect(offLine.hp).toBe(BASIC_ENEMY.maxHp);
  });

  it('deals no damage off the cadence tick', () => {
    const s = state();
    s.tick = 5; // NOT a multiple of interval 2
    const e = addEnemy(s, 850, 600);
    addBullet(s, 800, 600, {
      vx: toFp(0), vy: toFp(0), damage: 1,
      ballistic: 'beam', beamDir: 0 as Brad, beamRange: LASERCUTTER_SIM.beamRange,
      beamTicksLeft: 4, beamTickInterval: 2,
    });
    new HitResolveSystem().tick(s);
    expect(e.hp).toBe(BASIC_ENEMY.maxHp);
  });
});

describe('Ballistic — boomerang', () => {
  it('reverses velocity exactly at returnAfterTicks', () => {
    const s = state();
    const b = addBullet(s, 800, 600, {
      vx: toFp(10), vy: toFp(0),
      ballistic: 'boomerang', returnAfterTicks: 2, ticksAlive: 0,
    });
    new ProjectileStepSystem().tick(s); // ticksAlive → 1
    expect(b.vx).toBe(toFp(10));
    new ProjectileStepSystem().tick(s); // ticksAlive → 2 === returnAfterTicks
    expect(b.vx).toBe(toFp(-10));
  });

  it('fired via the weapon, a tomahawk bullet is tagged boomerang with ticksAlive 0', () => {
    const s = state();
    const p = s.players[0]!;
    p.weapon = makeWeapon(TOMAHAWK_SIM);
    p.firing = true;
    new WeaponFireSystem().tick(s);
    const b = s.projectiles[0]!;
    expect(b.ballistic).toBe('boomerang');
    expect(b.ticksAlive).toBe(0);
    expect(b.returnAfterTicks).toBe(TOMAHAWK_SIM.returnAfterTicks);
  });
});

describe('Integration — each new frame survives the full engine step() pipeline', () => {
  it.each([
    ['scattergun', SCATTERGUN_SIM],
    ['seeker', SEEKER_SIM],
    ['mortar', MORTAR_SIM],
    ['lasercutter', LASERCUTTER_SIM],
    ['tomahawk', TOMAHAWK_SIM],
    ['novaburst', NOVABURST_SIM],
    ['gyre', GYRE_SIM],
  ] as const)('%s equips, fires, and damages an enemy over several ticks without throwing', (_name, sim) => {
    const eng = createGameEngine({ seed: 1, worldW: 1600, worldH: 1200, playerStart: [400, 400], waves: [] });
    const p = eng.state.players[0]!;
    p.weapon = makeWeapon(sim);
    p.weapons = [p.weapon];
    const e: EnemyActor = {
      id: eng.state.nextId(), faction: 'enemy', teamId: ENEMY_TEAM_ID,
      gx: pxToFp(450), gy: pxToFp(400), z: toFp(0), vx: toFp(0), vy: toFp(0),
      knockVx: toFp(0), knockVy: toFp(0),
      facing: 0 as Brad, hp: 30, maxHp: 30, shield: 0, maxShield: 0, ticksSinceHit: 0,
      radius: BASIC_ENEMY.radius, footprintRadius: BASIC_ENEMY.footprintRadius, solidRadius: BASIC_ENEMY.radius,
      alive: true, weapon: null, firing: false, status: freshStatus(), enraged: false, armorBroken: false, aggroed: false, holding: false,
    };
    eng.state.enemies.push(e);
    for (let t = 1; t <= 90; t++) {
      expect(() =>
        eng.step([makeCommand({ owner: 0, tick: t, moveBrad: 0 as Brad, moveMag: 0, buttons: Button.FIRE })]),
      ).not.toThrow();
    }
    expect(e.hp).toBeLessThan(30);
  });
});
