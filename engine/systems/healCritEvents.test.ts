/**
 * The two facts the floating number layer needs and the sim used to keep to itself (design/10
 * "Damage numbers", 2026-09-26): whether a hit was a CRIT, and how much a heal actually RESTORED.
 *
 * Crit: the roll is frozen onto the payload at fire/swing time (design/07 "one frozen payload"),
 * so the flag is frozen beside it — `Projectile.crit` / `WeaponState.swingCrit` — and copied onto
 * the `hit` event. The property pinned below is the one a number can be wrong about: a hit is
 * marked crit exactly when its damage carries the crit multiplier, never otherwise. Pinned by
 * sweeping real rolls rather than forcing one, so the flag and the multiplier cannot drift apart.
 *
 * Heal: `restoreHp` / `restoreShield` are the one way a player-visible restore lands, and each
 * reports what went in AFTER the clamp — a potion at 9/10 HP says 1, and a restore that changed
 * nothing says nothing.
 *
 * Neither is in `serializeState`, and neither is read by a later system: the golden hashes did
 * not move when this landed, which is why there is no ENGINE_VERSION bump.
 */
import { describe, it, expect } from 'vitest';
import { toFp, type Fp } from '@dd/engine/math/fixed';
import type { Brad } from '@dd/engine/math/trig';
import { createGameState, type GameState } from '@dd/engine/state/GameState';
import type { GameEvent } from '@dd/engine/state/events';
import { ENEMY_TEAM_ID, type EnemyActor, type Projectile, type RangedSimSpec } from '@dd/engine/state/entities';
import { pxToFp } from '@dd/engine/content/convert';
import { freshStatus } from '@dd/engine/content/damage';
import { BASIC_ENEMY } from '@dd/engine/content/enemies';
import { makeWeapon, openSwing, BLASTER_SIM, CAROM_SIM, SABER_SIM } from '@dd/engine/content/weapons';
import { buffedDamage, critDamage, sumBuffs } from '@dd/engine/balance/runbuffs';
import { DeflectSystem, HitResolveSystem, WeaponFireSystem } from '@dd/engine/systems';
import { restoreHp, restoreShield, takeDamage } from './combat';

const CFG = { seed: 29, worldW: 1600, worldH: 1200, playerStart: [400, 400] as const, waves: [] as const };
const state = (): GameState => createGameState(CFG);

type Hit = Extract<GameEvent, { type: 'hit' }>;
type Heal = Extract<GameEvent, { type: 'heal' }>;
const hits = (s: GameState): Hit[] => s.events.filter((e): e is Hit => e.type === 'hit');
const heals = (s: GameState): Heal[] => s.events.filter((e): e is Heal => e.type === 'heal');

function addEnemy(s: GameState, xpx: number, ypx: number, hp = 9999): EnemyActor {
  const e: EnemyActor = {
    id: s.nextId(), faction: 'enemy', teamId: ENEMY_TEAM_ID,
    gx: pxToFp(xpx), gy: pxToFp(ypx), z: toFp(0), vx: toFp(0), vy: toFp(0),
    knockVx: toFp(0), knockVy: toFp(0),
    facing: 0 as Brad, hp, maxHp: hp, shield: 0, maxShield: 0,
    ticksSinceHit: 0, radius: BASIC_ENEMY.radius,
    footprintRadius: BASIC_ENEMY.footprintRadius, solidRadius: BASIC_ENEMY.radius,
    alive: true, weapon: null, firing: false, status: freshStatus(), enraged: false, armorBroken: false, aggroed: false, holding: false,
  };
  s.enemies.push(e);
  return e;
}

/** Four crit buffs: over the 50% cap, so a short sweep sees plenty of both outcomes. */
const CRIT_BUILD = ['crit_up', 'crit_up', 'crit_up', 'crit_up'];

describe('restoreHp / restoreShield', () => {
  it('restores up to the cap and reports only what actually went in', () => {
    const s = state();
    const p = s.players[0]!;
    p.hp = p.maxHp - 1;
    expect(restoreHp(s, p, 5)).toBe(1);
    expect(p.hp).toBe(p.maxHp);
    expect(heals(s)).toEqual([{ type: 'heal', target: p.id, gx: p.gx, gy: p.gy, amount: 1, pool: 'hp' }]);
  });

  it('a restore into a full pool changes nothing and announces nothing', () => {
    const s = state();
    const p = s.players[0]!;
    p.hp = p.maxHp;
    p.shield = p.maxShield;
    expect(restoreHp(s, p, 3)).toBe(0);
    expect(restoreShield(s, p, 3)).toBe(0);
    expect(heals(s)).toEqual([]);
  });

  it('the shield twin clamps to maxShield and names its pool', () => {
    const s = state();
    const p = s.players[0]!;
    expect(p.maxShield).toBeGreaterThan(2); // the default character has a real pool to fill
    p.shield = 1;
    expect(restoreShield(s, p, 1)).toBe(1);
    expect(restoreShield(s, p, 999)).toBe(p.maxShield - 2);
    expect(p.shield).toBe(p.maxShield);
    expect(heals(s).map((e) => [e.amount, e.pool])).toEqual([[1, 'shield'], [p.maxShield - 2, 'shield']]);
  });

  it('lifesteal announces its heal through the same event', () => {
    const s = state();
    const p = s.players[0]!;
    p.hp = 1;
    const e = addEnemy(s, 460, 400);
    p.weapon = makeWeapon({ ...CAROM_SIM, damage: 10, lifestealPermille: 500, ricochetCount: 0 } as RangedSimSpec);
    p.firing = true;
    new WeaponFireSystem().tick(s);
    const b = s.projectiles[s.projectiles.length - 1]!;
    b.gx = e.gx;
    b.gy = e.gy;
    new HitResolveSystem().tick(s);
    const gained = Math.min(p.maxHp, 1 + 5) - 1;
    expect(p.hp).toBe(1 + gained);
    expect(heals(s)).toEqual([expect.objectContaining({ target: p.id, amount: gained, pool: 'hp' })]);
  });
});

describe('the crit flag on hit events', () => {
  it('takeDamage marks a crit hit, and leaves the key off every other hit', () => {
    const s = state();
    const e = addEnemy(s, 600, 600);
    takeDamage(s, e, 4, 'player', 'physical');
    takeDamage(s, e, 8, 'player', 'physical', true, true);
    const [plain, crit] = hits(s);
    expect('crit' in plain!).toBe(false); // absent, not `false`: an uncritted build's events are unchanged
    expect(crit!.crit).toBe(true);
  });

  it('ranged: a bullet is flagged crit exactly when its damage carries the multiplier', () => {
    const s = state();
    const p = s.players[0]!;
    p.buffs = [...CRIT_BUILD];
    p.weapon = makeWeapon(BLASTER_SIM);
    p.weapons[0] = p.weapon;
    p.firing = true;
    const base = buffedDamage(BLASTER_SIM.damage, sumBuffs(p.buffs));
    const big = critDamage(base, true);
    expect(big).toBeGreaterThan(base); // the two outcomes are distinguishable at all
    const fire = new WeaponFireSystem();
    const seen: Projectile[] = [];
    for (let i = 0; i < 80; i++) {
      p.weapon.cooldownTicks = 0;
      p.energy = p.maxEnergy;
      s.projectiles.length = 0;
      fire.tick(s);
      seen.push(...s.projectiles);
    }
    const crits = seen.filter((b) => b.crit === true);
    expect(crits.length).toBeGreaterThan(10);
    expect(seen.length - crits.length).toBeGreaterThan(10);
    for (const b of seen) expect(b.damage).toBe(b.crit ? big : base);
    for (const b of seen.filter((x) => !x.crit)) expect('crit' in b).toBe(false);
  });

  it('ranged: the resolver copies the bullet flag onto its hit', () => {
    const s = state();
    const p = s.players[0]!;
    p.buffs = [...CRIT_BUILD];
    p.weapon = makeWeapon(BLASTER_SIM);
    p.firing = true;
    const e = addEnemy(s, 700, 700);
    const fire = new WeaponFireSystem();
    const resolve = new HitResolveSystem();
    const marks = new Set<boolean>();
    for (let i = 0; i < 40; i++) {
      p.weapon.cooldownTicks = 0;
      p.energy = p.maxEnergy;
      s.events.length = 0;
      fire.tick(s);
      const b = s.projectiles[s.projectiles.length - 1]!;
      b.gx = e.gx;
      b.gy = e.gy;
      resolve.tick(s);
      const [h] = hits(s);
      expect(h!.crit === true).toBe(b.crit === true);
      marks.add(b.crit === true);
    }
    expect(marks).toEqual(new Set([true, false])); // both arms ran
  });

  it('melee: every hit of one swing carries that swing\'s one roll', () => {
    const s = state();
    const p = s.players[0]!;
    p.buffs = [...CRIT_BUILD];
    p.weapon = makeWeapon(SABER_SIM);
    p.weapons[0] = p.weapon;
    p.facing = 0 as Brad;
    addEnemy(s, 430, 400);
    addEnemy(s, 440, 400);
    const resolve = new HitResolveSystem();
    const base = buffedDamage(SABER_SIM.damage, sumBuffs(p.buffs));
    const marks = new Set<boolean>();
    for (let i = 0; i < 40; i++) {
      s.events.length = 0;
      openSwing(p.weapon);
      resolve.tick(s);
      const crit = p.weapon.swingCrit === true;
      expect(p.weapon.swingDamage).toBe(critDamage(base, crit));
      const hs = hits(s);
      expect(hs).toHaveLength(2);
      for (const h of hs) expect(h.crit === true).toBe(crit);
      marks.add(crit);
    }
    expect(marks).toEqual(new Set([true, false]));
  });

  it('a deflect clears the flag: the deflector rolled nothing', () => {
    const s = state();
    const p = s.players[0]!;
    p.weapon = makeWeapon(SABER_SIM);
    p.weapons[0] = p.weapon;
    p.facing = 0 as Brad;
    openSwing(p.weapon);
    const b: Projectile = {
      id: s.nextId(), faction: 'enemy', teamId: ENEMY_TEAM_ID,
      gx: pxToFp(425), gy: pxToFp(400), z: pxToFp(12),
      vx: toFp(-11) as Fp, vy: toFp(0), radius: pxToFp(5), damage: 6,
      damageType: 'physical', lifeTicks: 90, alive: true, crit: true,
    };
    s.projectiles.push(b);
    new DeflectSystem().tick(s);
    expect(b.faction).toBe('player'); // it really was deflected
    expect('crit' in b).toBe(false);
  });
});
