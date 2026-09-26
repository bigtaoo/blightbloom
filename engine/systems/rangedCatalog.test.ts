/**
 * Every RANGED weapon in the catalog, fired for real — the sweep the ranged half of the
 * roster did not have.
 *
 * ## Why this file exists
 *
 * The mechanics were tested; the WEAPONS were not. `systems/ballistics.test.ts` covers each
 * ballistic shape once, through one showcase weapon per shape, and its integration block
 * names its seven weapons by hand. `systems/procs.test.ts` proves lifesteal / ricochet /
 * piercing on synthetic projectiles it builds itself, never on a spec out of
 * `WEAPON_SPECS`. So a weapon could author a field, have it convert correctly (that half is
 * `content/weapons.test.ts`'s), and still never be fired by anything.
 *
 * Counted across the whole test tree on 2026-09-04, `carom` — the game's ONLY ricochet
 * weapon — appeared in exactly one test file: `client/src/render/muzzleParity.test.ts`, a
 * render sweep. Its `ricochetCount: 2` had no test anywhere that put it on a projectile.
 * `venomspit` was in the same position.
 *
 * `systems/meleeWindow.test.ts` already sweeps `WEAPON_SPECS`'s melee half the right way
 * ("driven off WEAPON_SPECS itself rather than a hand-listed set, so a new blade is covered
 * the day it is authored"). This is the ranged counterpart, plus the two on-hit procs whose
 * shipped carriers no behavioural test touched.
 *
 * ## Shape
 *
 * Four passes, all catalog-driven:
 *
 *   1. FREEZE   — one shot, and the whole payload on each pellet matches the spec it came
 *                 from, including that a weapon carries NO other shape's params.
 *   2. BEHAVE   — per ballistic, every shipped weapon of that shape moves per its OWN
 *                 authored numbers (so `frostseeker` is exercised beside `seeker`, and
 *                 `cinderscatter` beside `scattergun`, rather than one standing in for both).
 *   3. PROCS    — `carom`'s real `ricochetCount` bounces; `leech`'s real
 *                 `lifestealPermille` heals.
 *   4. PIPELINE — every ranged weapon, through the real `engine.step()`, damages an enemy
 *                 standing inside that weapon's OWN authored reach envelope.
 *
 * Every group assertion is guarded by a non-empty check on its own group, because a sweep
 * whose filter silently matches nothing is a green no-op (design/18).
 *
 * ## Mutation battery
 *
 * Recorded 2026-09-04 against `WeaponFireSystem.ts` / `ProjectileStepSystem.ts`. Every row
 * is a real edit, `npx vitest run systems/rangedCatalog.test.ts`, revert.
 *
 *   KILLED   `z: spec.bulletZ` → `toFp(0)` ......................................... 69
 *   KILLED   `radius: spec.bulletRadius` → `toFp(1)` ............................... 69
 *   KILLED   `ricochetsLeft: spec.ricochetCount` → `undefined` ....................... 2
 *   KILLED   `orbitAngularVelBrad` dropped from the spawn payload .................... 2
 *   KILLED   homing turn clamp widened (`b.turnRateBrad` → `· 4`) .................... 2
 *   KILLED   orbit steps at a constant radius instead of `b.orbitRadius` ............. 2
 *   KILLED   boomerang reverse moved one tick early ................................. 1
 *   KILLED   a landed lob dies instead of flagging `landed` .......................... 1
 *   SURVIVED `lifestealPermille: spec.lifestealPermille` → `undefined` .............. 0
 *   SURVIVED `beamDir` frozen to `a.facing` instead of the pellet `dir` ............. 0
 *
 * Both survivors are recorded rather than hidden, and both say something about the
 * CONTENT, not about the assertions:
 *
 *   - Lifesteal: no RANGED weapon in the catalog carries it (`leech` is melee, and melee
 *     lifesteal is read off the weapon spec in `HitResolveSystem`, never off a projectile).
 *     So the freeze sweep's lifesteal line compares `undefined` to `undefined` for all 17
 *     of them — a green assertion with nothing behind it. Pinned as its own named case
 *     below so it cannot stay quietly vacuous.
 *   - `beamDir`: every shipped beam weapon is single-pellet, so `dir === a.facing` and the
 *     two expressions agree on all real content. `WeaponFireSystem.test.ts` kills this one
 *     with a synthetic multi-pellet beam, which is the right place for it — a catalog sweep
 *     provably cannot.
 */
import { describe, it, expect } from 'vitest';
import { FP_SCALE, addFp, mulFp, toFp } from '../math/fixed';
import { cosFp, sinFp, normBrad, type Brad } from '../math/trig';
import { createGameState, type GameState } from '../state/GameState';
import { createGameEngine } from '../GameEngine';
import { Button } from '../state/commands';
import { makeCommand } from '../state/input';
import {
  ENEMY_TEAM_ID,
  type EnemyActor,
  type PlayerActor,
  type Projectile,
  type RangedSimSpec,
} from '../state/entities';
import { freshStatus } from '../content/damage';
import { BASIC_ENEMY } from '../content/enemies';
import { WEAPON_SPECS, toSimSpec, makeWeapon, openSwing, WEAPON_SIM_BY_ID } from '../content/weapons';
import type { MeleeSpec, RangedSpec } from '../content/weaponTypes';
import { HitResolveSystem, ProjectileStepSystem, WeaponFireSystem } from '.';

const CFG = { seed: 4242, worldW: 1600, worldH: 1200, waves: [] as const };
const state = (): GameState => createGameState(CFG);

/**
 * Every ranged weapon in the catalog, `enemygun` included — it is a real weapon fired in
 * every PvE match, and being excluded from `WEAPON_SIM_BY_ID` (not player-facing) is
 * exactly the reason it would otherwise slip out of a sweep built off that map.
 */
const RANGED: readonly (readonly [string, RangedSimSpec])[] = Object.entries(WEAPON_SPECS)
  .filter((e): e is [string, RangedSpec] => e[1].kind === 'ranged')
  .map(([id, spec]) => [id, toSimSpec(spec) as RangedSimSpec] as const);

/** Ranged weapons of one ballistic shape. Callers assert the group is non-empty. */
const ofShape = (b: RangedSimSpec['ballistic']) => RANGED.filter(([, s]) => s.ballistic === b);

function armed(s: GameState, spec: RangedSimSpec, facing = 0): PlayerActor {
  const p = s.players[0]!;
  p.weapon = makeWeapon(spec);
  p.weapons = [p.weapon];
  p.facing = normBrad(facing);
  p.firing = true;
  return p;
}

function addEnemy(s: GameState, gx: number, gy: number, hp = BASIC_ENEMY.maxHp): EnemyActor {
  const e: EnemyActor = {
    id: s.nextId(), faction: 'enemy', teamId: ENEMY_TEAM_ID,
    gx: gx as never, gy: gy as never, z: toFp(0), vx: toFp(0), vy: toFp(0),
    knockVx: toFp(0), knockVy: toFp(0),
    facing: 0 as Brad, hp, maxHp: hp, shield: 0, maxShield: 0, ticksSinceHit: 0,
    radius: BASIC_ENEMY.radius, footprintRadius: BASIC_ENEMY.footprintRadius, solidRadius: BASIC_ENEMY.radius,
    alive: true, weapon: null, firing: false, status: freshStatus(), enraged: false, armorBroken: false, aggroed: false, holding: false,
  };
  s.enemies.push(e);
  return e;
}

/** One shot from a fresh state, returning the pellets it produced. */
function fireOnce(spec: RangedSimSpec, facing = 0): { s: GameState; p: PlayerActor; shots: Projectile[] } {
  const s = state();
  const p = armed(s, spec, facing);
  new WeaponFireSystem().tick(s);
  return { s, p, shots: [...s.projectiles] };
}

// ── 1. FREEZE ─────────────────────────────────────────────────────────────────

/**
 * The params each ballistic shape legitimately puts on a projectile. A weapon must carry
 * its own and none of the others — the converter sets every field unconditionally from its
 * authored counterpart, so a stray authored param becomes a stray frozen param.
 */
const SHAPE_PARAMS: Record<RangedSimSpec['ballistic'], readonly (keyof Projectile)[]> = {
  straight: [],
  homing: ['turnRateBrad', 'speed'],
  lob: ['blastRadius'],
  boomerang: ['returnAfterTicks', 'ticksAlive'],
  beam: ['beamTicksLeft', 'beamTickInterval', 'beamDir', 'beamRange'],
  orbit: ['orbitRadius', 'orbitAngleBrad', 'orbitAngularVelBrad'],
};
const ALL_SHAPE_PARAMS = [...new Set(Object.values(SHAPE_PARAMS).flat())];

describe('FREEZE — one shot, and every pellet carries its own spec (design/07 frozen payload)', () => {
  it.each(RANGED.map(([id]) => id))('%s', (id) => {
    const spec = RANGED.find(([n]) => n === id)![1];
    const { p, shots } = fireOnce(spec);

    expect(shots.length, `${id} must fire its authored pellet count`).toBe(spec.bullets);
    for (const b of shots) {
      expect(b.ballistic, `${id} ballistic`).toBe(spec.ballistic);
      expect(b.damage, `${id} damage`).toBe(spec.damage);
      expect(b.damageType, `${id} damageType`).toBe(spec.damageType);
      expect(b.radius, `${id} bulletRadius`).toBe(spec.bulletRadius);
      expect(b.z, `${id} bulletZ`).toBe(spec.bulletZ);
      expect(b.lifeTicks, `${id} lifespan`).toBe(spec.bulletLifeTicks);
      expect(b.ownerId, `${id} ownerId`).toBe(p.id);
      expect(b.faction).toBe(p.faction);
      expect(b.alive).toBe(true);
      // Procs, frozen at fire time — undefined stays undefined, a value arrives verbatim.
      expect(b.lifestealPermille, `${id} lifesteal`).toBe(spec.lifestealPermille);
      expect(b.ricochetsLeft, `${id} ricochet`).toBe(spec.ricochetCount);
      expect(b.piercing, `${id} piercing`).toBe(spec.piercing);

      // Its own shape's params landed; no other shape's did.
      const own = SHAPE_PARAMS[spec.ballistic];
      for (const key of ALL_SHAPE_PARAMS) {
        const got = (b as unknown as Record<string, unknown>)[key as string];
        if (own.includes(key)) expect(got, `${id} (${spec.ballistic}) needs ${String(key)}`).not.toBeUndefined();
        else expect(got, `${id} (${spec.ballistic}) must not carry ${String(key)}`).toBeUndefined();
      }
    }
  });

  it('the sweep really did cover every shape and both emission patterns', () => {
    // Guard against the sweep above passing because the catalog quietly lost a shape.
    expect(new Set(RANGED.map(([, s]) => s.ballistic))).toEqual(
      new Set(['straight', 'homing', 'lob', 'beam', 'boomerang', 'orbit']),
    );
    expect(new Set(RANGED.map(([, s]) => s.pattern))).toEqual(new Set(['spread', 'radial']));
    expect(RANGED.length).toBeGreaterThanOrEqual(17);
  });

  it('a multi-pellet weapon spawns pellets that differ in direction, not clones', () => {
    const multi = RANGED.filter(([, s]) => s.bullets > 1);
    expect(multi.length, 'no multi-pellet weapon in the catalog').toBeGreaterThan(0);
    for (const [id, spec] of multi) {
      const { shots } = fireOnce(spec);
      const dirs = new Set(shots.map((b) => `${b.vx},${b.vy}`));
      expect(dirs.size, `${id} fired ${shots.length} identical pellets`).toBeGreaterThan(1);
    }
  });

  it('every pellet spawns at the weapon\'s OWN muzzle distance from the shooter', () => {
    // Stated as a DISTANCE, not an axis: a spread weapon's pellets each leave on their own
    // jittered heading, so only the radius from the shooter is common to all of them. The
    // axis form is asserted just below, for the weapons where it is well-defined.
    for (const [id, spec] of RANGED) {
      const { p, shots } = fireOnce(spec, 0);
      for (const b of shots) {
        const dx = (b.gx - p.gx) as number;
        const dy = (b.gy - p.gy) as number;
        const dist = Math.sqrt(dx * dx + dy * dy);
        // Derived, not picked: sinFp/cosFp are in 1/FP_SCALE units and err by up to ~1.5 of
        // them (table rounding plus interpolation truncation), scaled by the offset, and each
        // mulFp truncates up to 1 more per axis. The flat 2 this replaced held only until a
        // v78 PRNG stream jittered a cinderscatter pellet onto a heading 2.01 off.
        const offset = spec.muzzleOffset as number;
        const bound = Math.SQRT2 * (1 + (1.5 * offset) / FP_SCALE);
        expect(Math.abs(dist - offset), `${id} muzzle distance ${dist}`).toBeLessThan(bound);
      }
    }
  });

  it('a pinpoint weapon puts its pellet exactly on the facing axis', () => {
    const pinpoint = RANGED.filter(([, s]) => s.bullets === 1 || s.spreadHalf === 0);
    expect(pinpoint.length, 'no pinpoint weapon to check the axis form on').toBeGreaterThan(0);
    for (const [id, spec] of pinpoint) {
      const { p, shots } = fireOnce(spec, 0); // due east: the offset lands entirely on gx
      expect(shots[0]!.gx, `${id} muzzle gx`).toBe(addFp(p.gx, mulFp(cosFp(0 as Brad), spec.muzzleOffset)));
      expect(shots[0]!.gy, `${id} muzzle gy`).toBe(addFp(p.gy, mulFp(sinFp(0 as Brad), spec.muzzleOffset)));
    }
  });
});

// ── 2. BEHAVE ─────────────────────────────────────────────────────────────────

describe('BEHAVE — straight: every pellet advances by its own bulletSpeed, per tick', () => {
  const group = ofShape('straight');
  it('the group is non-empty', () => expect(group.length).toBeGreaterThan(0));

  it.each(group.map(([id]) => id))('%s — EVERY pellet, whatever heading it drew', (id) => {
    const spec = group.find(([n]) => n === id)![1];
    const { s, shots } = fireOnce(spec, 0);
    const before = shots.map((b) => ({ gx: b.gx as number, gy: b.gy as number }));
    new ProjectileStepSystem().tick(s);
    // A spread pellet's heading comes out of combatPrng, so the invariant is the STEP
    // LENGTH, per pellet, not a displacement on one axis.
    shots.forEach((b, i) => {
      const dx = (b.gx as number) - before[i]!.gx;
      const dy = (b.gy as number) - before[i]!.gy;
      const step = Math.sqrt(dx * dx + dy * dy);
      expect(Math.abs(step - (spec.bulletSpeed as number)), `${id} pellet ${i} stepped ${step}`).toBeLessThan(2);
    });
  });

  it.each(group.filter(([, s]) => s.bullets === 1 || s.spreadHalf === 0).map(([id]) => id))(
    '%s — a pinpoint/radial pellet advances exactly along the axis it left on',
    (id) => {
      const spec = group.find(([n]) => n === id)![1];
      const { s, shots } = fireOnce(spec, 0);
      // Pellet 0 of a radial ring fires straight along facing (content/ballistics.ts).
      const b = shots[0]!;
      const x0 = b.gx as number;
      const y0 = b.gy;
      new ProjectileStepSystem().tick(s);
      expect((b.gx as number) - x0, `${id} moved by its own bulletSpeed`).toBe(spec.bulletSpeed as number);
      expect(b.gy, `${id} drifted off-axis`).toBe(y0);
    },
  );
});

describe('BEHAVE — homing: turns toward a foe, clamped by its own turnRateBrad', () => {
  const group = ofShape('homing');
  it('the group is non-empty (seeker AND its elemental sibling)', () => {
    expect(group.map(([id]) => id).sort()).toEqual(['frostseeker', 'seeker']);
  });

  it.each(group.map(([id]) => id))('%s turns at most its own rate, and preserves speed', (id) => {
    const spec = group.find(([n]) => n === id)![1];
    const { s, shots } = fireOnce(spec, 0); // flying east
    const b = shots[0]!;
    // Due SOUTH of the shooter: the required turn is 90°, far more than one tick's clamp,
    // so the clamp is what decides the step — the case a "did it turn?" assertion misses.
    addEnemy(s, s.players[0]!.gx, addFp(s.players[0]!.gy, toFp(6)));
    const before = Math.atan2(b.vy as number, b.vx as number);
    new ProjectileStepSystem().tick(s);
    const after = Math.atan2(b.vy as number, b.vx as number);

    const turnedBrad = Math.abs(((after - before) / (2 * Math.PI)) * 65536);
    expect(turnedBrad, `${id} did not turn at all`).toBeGreaterThan(0);
    // Within one brad of its own authored clamp — the turn is saturated, not free.
    expect(turnedBrad, `${id} turned ${turnedBrad} brad, clamp is ${spec.turnRateBrad}`).toBeLessThanOrEqual(
      spec.turnRateBrad! + 1,
    );
    const mag = Math.sqrt((b.vx as number) ** 2 + (b.vy as number) ** 2);
    expect(Math.abs(mag - (spec.bulletSpeed as number)), `${id} speed drifted while turning`).toBeLessThan(20);
  });
});

describe('BEHAVE — lob: lands at its own lifespan and blasts its own radius', () => {
  const group = ofShape('lob');
  it('the group is non-empty', () => expect(group.length).toBeGreaterThan(0));

  it.each(group.map(([id]) => id))('%s', (id) => {
    const spec = group.find(([n]) => n === id)![1];
    const { s, shots } = fireOnce(spec, 0);
    const b = shots[0]!;
    s.projectiles.length = 0;
    s.projectiles.push(b); // fly it alone, away from anything it could hit en route

    for (let t = 1; t < spec.bulletLifeTicks; t++) {
      new ProjectileStepSystem().tick(s);
      expect(b.landed, `${id} landed early at tick ${t}`).toBeFalsy();
    }
    new ProjectileStepSystem().tick(s);
    expect(b.landed, `${id} did not land at its own bulletLifeTicks`).toBe(true);
    expect(b.alive, `${id} died instead of detonating`).toBe(true);

    // Just inside its own blast radius takes damage; just outside does not.
    const inner = addEnemy(s, addFp(b.gx, (spec.blastRadius! / 2) as never), b.gy, 99);
    const outer = addEnemy(s, addFp(b.gx, addFp(spec.blastRadius!, toFp(3))), b.gy, 99);
    new HitResolveSystem().tick(s);
    expect(inner.hp, `${id} blast missed a body inside blastRadius`).toBeLessThan(99);
    expect(outer.hp, `${id} blast reached past blastRadius`).toBe(99);
    expect(b.alive).toBe(false);
  });
});

describe('BEHAVE — beam: frozen in place, damaging on its own cadence within its own range', () => {
  const group = ofShape('beam');
  it('the group is non-empty', () => expect(group.length).toBeGreaterThan(0));

  it.each(group.map(([id]) => id))('%s does not move and keeps its own channel length', (id) => {
    const spec = group.find(([n]) => n === id)![1];
    const { s, shots } = fireOnce(spec, 0);
    const b = shots[0]!;
    const at = { gx: b.gx, gy: b.gy };
    new ProjectileStepSystem().tick(s);
    expect({ gx: b.gx, gy: b.gy }, `${id} beam travelled`).toEqual(at);
    expect(b.beamTicksLeft, `${id} channel did not count down`).toBe(spec.beamTicks! - 1);
    expect(b.beamRange).toBe(spec.beamRange);
  });

  it.each(group.map(([id]) => id))('%s reaches exactly as far as its own beamRange', (id) => {
    const spec = group.find(([n]) => n === id)![1];
    const { s, shots } = fireOnce(spec, 0);
    const b = shots[0]!;
    const inner = addEnemy(s, addFp(b.gx, (spec.beamRange! / 2) as never), b.gy, 99);
    const outer = addEnemy(s, addFp(b.gx, addFp(spec.beamRange!, toFp(3))), b.gy, 99);
    // The cadence is global (`state.tick % beamTickInterval`), so land on a firing tick.
    s.tick = spec.beamTickInterval! * 2;
    new HitResolveSystem().tick(s);
    expect(inner.hp, `${id} beam missed a body inside beamRange`).toBeLessThan(99);
    expect(outer.hp, `${id} beam reached past beamRange`).toBe(99);
  });
});

describe('BEHAVE — boomerang: reverses exactly at its own returnAfterTicks', () => {
  const group = ofShape('boomerang');
  it('the group is non-empty', () => expect(group.length).toBeGreaterThan(0));

  it.each(group.map(([id]) => id))('%s', (id) => {
    const spec = group.find(([n]) => n === id)![1];
    const { s, shots } = fireOnce(spec, 0);
    const b = shots[0]!;
    const outbound = b.vx as number;
    expect(outbound, `${id} outbound velocity`).toBeGreaterThan(0);
    for (let t = 1; t < spec.returnAfterTicks!; t++) {
      new ProjectileStepSystem().tick(s);
      expect(b.vx as number, `${id} reversed early at tick ${t}`).toBeGreaterThan(0);
    }
    new ProjectileStepSystem().tick(s);
    expect(b.vx as number, `${id} did not reverse at returnAfterTicks`).toBeLessThan(0);
    expect(b.vx as number).toBe(-outbound);
  });
});

describe('BEHAVE — orbit: circles the wielder at its own radius and angular velocity', () => {
  const group = ofShape('orbit');
  it('the group is non-empty', () => expect(group.length).toBeGreaterThan(0));

  it.each(group.map(([id]) => id))('%s', (id) => {
    const spec = group.find(([n]) => n === id)![1];
    const { s, p, shots } = fireOnce(spec, 0);
    const b = shots[0]!;
    const start = b.orbitAngleBrad!;
    new ProjectileStepSystem().tick(s);
    expect(b.orbitAngleBrad, `${id} angle did not advance by its own rate`).toBe(
      normBrad(start + spec.orbitAngularVelBrad!),
    );
    const dx = (b.gx - p.gx) as number;
    const dy = (b.gy - p.gy) as number;
    const dist = Math.sqrt(dx * dx + dy * dy);
    expect(Math.abs(dist - (spec.orbitRadius as number)), `${id} left its own orbit radius`).toBeLessThan(20);
  });
});

// ── 3. PROCS, on the weapons that actually ship them ──────────────────────────

describe('PROCS — the shipped carriers, on their own authored numbers', () => {
  it('carom is still the only ricochet weapon, and leech the only lifesteal one', () => {
    // If a second carrier lands, the cases below should grow to a sweep rather than stay
    // hand-named — this is the tripwire that says so.
    const rico = Object.entries(WEAPON_SPECS).filter(([, s]) => s.kind === 'ranged' && s.ricochetCount);
    const steal = Object.entries(WEAPON_SPECS).filter(([, s]) => s.lifestealPermille);
    expect(rico.map(([id]) => id)).toEqual(['carom']);
    expect(steal.map(([id]) => id)).toEqual(['leech']);
  });

  it('NO ranged weapon carries lifesteal — so the freeze sweep\'s lifesteal line is vacuous', () => {
    // Found by the mutation battery in this file's header: blanking `lifestealPermille` out
    // of `WeaponFireSystem`'s spawn payload kills nothing, because every ranged spec in the
    // catalog leaves it unset. The ranged half of the k_lifesteal wiring is therefore dead
    // content — `systems/procs.test.ts` proves the mechanic on a synthetic bullet, and
    // nothing ships it. Same class as `piercing` (see content/weapons.test.ts's
    // UNUSED_BY_CONTENT). The day a ranged weapon takes lifesteal, this flips and the freeze
    // sweep starts asserting something real.
    const carriers = RANGED.filter(([, s]) => s.lifestealPermille !== undefined).map(([id]) => id);
    expect(carriers).toEqual([]);
  });

  it('carom really bounces its authored 2 times: three bodies from one trigger pull', () => {
    const spec = WEAPON_SIM_BY_ID.carom as RangedSimSpec;
    expect(spec.ricochetCount, 'carom lost its authored bounces').toBe(2);
    const s = state();
    armed(s, spec, 0);
    new WeaponFireSystem().tick(s);
    const b = s.projectiles[0]!;
    expect(b.ricochetsLeft).toBe(2);

    // Three bodies in a line ahead, SPACED so each bounce's "nearest other hostile" is the
    // next one forward. Tight clustering does not work and the reason is worth recording:
    // `retarget` excludes only the body just hit, so from a bullet sitting on body 2 the
    // nearest other can be body 1 — already in `hitIds`, so the bullet turns back, hits
    // nothing, and burns the bounce. (That is the shape of the live bug HitResolveSystem's
    // own comment records, from the other side.) 1 / 4 / 5 grid keeps every hop forward and
    // every hop inside RICOCHET_RANGE_FP's 6 grid.
    // Damage is 2 and BASIC_ENEMY has 3 hp, so "was hit" is unambiguous.
    const bodies = [
      addEnemy(s, addFp(b.gx, toFp(1)), b.gy),
      addEnemy(s, addFp(b.gx, toFp(4)), b.gy),
      addEnemy(s, addFp(b.gx, toFp(5)), b.gy),
    ];
    for (let t = 0; t < 60 && b.alive; t++) {
      new HitResolveSystem().tick(s);
      new ProjectileStepSystem().tick(s);
    }
    const hit = bodies.filter((e) => e.hp < BASIC_ENEMY.maxHp).length;
    expect(hit, 'one carom pellet should reach 3 bodies (first hit + 2 bounces)').toBe(3);
    expect(b.ricochetsLeft, 'bounces should be spent, not still banked').toBe(0);
  });

  it('leech really heals its authored 300‰ of the damage it deals', () => {
    const spec = WEAPON_SIM_BY_ID.leech as never as { lifestealPermille?: number; damage: number };
    expect(spec.lifestealPermille, 'leech lost its authored lifesteal').toBe(300);
    const s = state();
    const p = s.players[0]!;
    p.weapon = makeWeapon(WEAPON_SIM_BY_ID.leech!);
    p.weapons = [p.weapon];
    p.facing = 0 as Brad;
    p.hp = 1; // hurt, so a heal is visible and not clamped away at full HP
    // In the arc, dead ahead, within leech's own 1.3-grid reach.
    addEnemy(s, addFp(p.gx, toFp(1)), p.gy, 99);
    openSwing(p.weapon);
    new HitResolveSystem().tick(s);
    // 300‰ of 2 damage = 0.6, and the proc floors at a minimum of 1 (design/03 k_*).
    expect(p.hp, 'leech swing healed nothing').toBeGreaterThan(1);
  });
});

// ── 4. PIPELINE ───────────────────────────────────────────────────────────────

/**
 * The reach envelope a weapon authors for itself, in grid — how far its damage can
 * actually get. Used only to place a target the weapon is SUPPOSED to be able to hit, so
 * the pipeline sweep tests each weapon inside its own design envelope rather than at one
 * distance that flatters the snipers and starves the flamethrower.
 */
function reachGrid(id: string): number {
  const a = WEAPON_SPECS[id] as RangedSpec;
  if (a.ballistic === 'beam') return a.beamRangeGrid!;
  if (a.ballistic === 'orbit') return a.orbitRadiusGrid!;
  if (a.ballistic === 'boomerang') return a.bulletSpeed * a.returnAfterSec!;
  return a.bulletSpeed * a.lifespanSec;
}

describe('PIPELINE — every ranged weapon damages a body inside its own reach, via engine.step()', () => {
  it.each(RANGED.map(([id]) => id))('%s', (id) => {
    // Orbit's damage happens ON the circle, not inside it; everything else is placed well
    // inside its envelope so travel time, not range, is what the sweep is waiting on.
    const spec = RANGED.find(([n]) => n === id)![1];
    const atGrid = spec.ballistic === 'orbit' ? reachGrid(id) : reachGrid(id) * 0.5;

    const eng = createGameEngine({ seed: 7, worldW: 3200, worldH: 2400, playerStart: [800, 600], waves: [] });
    const p = eng.state.players[0]!;
    p.weapon = makeWeapon(spec);
    p.weapons = [p.weapon];
    const target = addEnemy(eng.state, addFp(p.gx, toFp(atGrid)), p.gy, 500);

    for (let t = 1; t <= 150; t++) {
      eng.step([makeCommand({ owner: 0, tick: t, moveBrad: 0 as Brad, moveMag: 0, buttons: Button.FIRE })]);
      if (target.hp < 500) break;
    }
    expect(target.hp, `${id} never damaged a body at ${atGrid.toFixed(2)} grid (its own reach is ${reachGrid(id).toFixed(2)})`).toBeLessThan(500);
  });

  it('the melee half of the catalog is swept by meleeWindow.test.ts, and is still non-empty', () => {
    // A pointer, not a duplicate: if the melee sweep's own source ever empties out, this
    // says so from the ranged side rather than both files going quietly green.
    const melee = Object.entries(WEAPON_SPECS).filter((e): e is [string, MeleeSpec] => e[1].kind === 'melee');
    expect(melee.length).toBeGreaterThanOrEqual(7);
  });
});
