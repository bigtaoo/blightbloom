import { describe, it, expect } from 'vitest';
import { toFp, addFp, isqrt } from '@dd/engine/math/fixed';
import type { Fp } from '@dd/engine/math/fixed';
import type { Brad } from '@dd/engine/math/trig';
import { createGameState } from '@dd/engine/state/GameState';
import type { GameState } from '@dd/engine/state/GameState';
import { ENEMY_TEAM_ID, type EnemyActor, type Faction, type Projectile } from '@dd/engine/state/entities';
import { makeWeapon, openSwing, SABER_SIM } from '@dd/engine/content/weapons';
import { freshStatus } from '@dd/engine/content/damage';
import { PLAYER_BASE } from '@dd/engine/content/players';
import { resolveSkin } from '@dd/engine/content/skins';
import { BASIC_ENEMY, buildEnemyActor } from '@dd/engine/content/enemies';
import { WALL_NORTH_BRIM } from '@dd/engine/config';
import { SIM } from '@dd/engine/sim.config';

// The default character's defensive stats (systems tests spawn the default player).
const DEFAULT_SKIN = resolveSkin();
import { pxToFp } from '@dd/engine/content/convert';
import {
  DeathDropsSystem,
  DeflectSystem,
  HitResolveSystem,
  MovementSystem,
  PickupSystem,
  ProjectileStepSystem,
} from '@dd/engine/systems';

const CFG = { seed: 7, worldW: 1600, worldH: 1200, waves: [] as const };

function state(): GameState {
  return createGameState(CFG);
}

function addEnemy(s: GameState, xpx: number, ypx: number, hp: number = BASIC_ENEMY.maxHp): EnemyActor {
  const e: EnemyActor = {
    id: s.nextId(), faction: 'enemy', teamId: ENEMY_TEAM_ID,
    gx: pxToFp(xpx), gy: pxToFp(ypx), z: toFp(0), vx: toFp(0), vy: toFp(0),
    knockVx: toFp(0), knockVy: toFp(0),
    facing: 0 as Brad, hp, maxHp: BASIC_ENEMY.maxHp, shield: 0, maxShield: 0,
    ticksSinceHit: 0, radius: BASIC_ENEMY.radius,
    // solidRadius === radius, matching buildEnemyActor (ENGINE_VERSION 48) — this fixture builds
    // an EnemyActor by hand rather than through buildEnemyActor (for direct control over spawn
    // position), so it has to track that formula itself rather than silently drifting from it.
    footprintRadius: BASIC_ENEMY.footprintRadius, solidRadius: BASIC_ENEMY.radius,
    alive: true, weapon: null, firing: false, status: freshStatus(), enraged: false, armorBroken: false, aggroed: false, holding: false,
  };
  s.enemies.push(e);
  return e;
}

// vx is a per-tick grid-fp displacement; magnitudes here are exaggerated so the
// direction/advance is obvious — realism (≈330 fp/tick) is covered end-to-end.
function addBullet(s: GameState, xpx: number, ypx: number, vx: Fp, faction: Faction): Projectile {
  const b: Projectile = {
    id: s.nextId(), faction, teamId: faction === 'enemy' ? ENEMY_TEAM_ID : 0,
    gx: pxToFp(xpx), gy: pxToFp(ypx), z: pxToFp(12),
    vx, vy: toFp(0), radius: pxToFp(5), damage: faction === 'player' ? 2 : 1,
    damageType: 'physical', lifeTicks: 90, alive: true,
  };
  s.projectiles.push(b);
  return b;
}

describe('MovementSystem (step 4)', () => {
  it('integrates velocity and clamps the player inside the world', () => {
    const s = state();
    s.players[0]!.vx = toFp(10000); // absurd → must clamp, not escape
    new MovementSystem().tick(s);
    expect(s.players[0]!.gx).toBe((pxToFp(1600) - PLAYER_BASE.margin) as Fp); // worldW - margin
  });

  it('pushes an actor out of a round solid it overlaps', () => {
    // Solid just left of the player's spawn (world centre 800,600) → they overlap.
    const s = createGameState({ ...CFG, obstacles: [[790, 600, 30]] as const });
    const p = s.players[0]!;
    new MovementSystem().tick(s);
    const dx = p.gx - pxToFp(790);
    const dy = p.gy - pxToFp(600);
    const minDist = (p.solidRadius + pxToFp(30)) as number; // solid clearance (v43), not the feet circle
    // Pushed out along +x (away from the solid centre) to just-touching (±rounding).
    expect(dx).toBeGreaterThan(0);
    expect(Math.abs(dy)).toBeLessThan(2);
    expect(Math.abs(isqrt(dx * dx + dy * dy) - minDist)).toBeLessThanOrEqual(2);
  });

  it('resolves a concentric overlap deterministically (+x nudge)', () => {
    const s = createGameState({ ...CFG, obstacles: [[800, 600, 30]] as const });
    const p = s.players[0]!; // spawns exactly on the solid centre
    new MovementSystem().tick(s);
    expect(p.gx).toBe(addFp(pxToFp(800), (p.solidRadius + pxToFp(30)) as Fp));
    expect(p.gy).toBe(pxToFp(600));
  });

  it('pushes an overlapping player and enemy apart, splitting the penetration between them', () => {
    const s = state();
    const p = s.players[0]!;
    p.gx = pxToFp(100);
    p.gy = pxToFp(100);
    const e = addEnemy(s, 110, 100); // 10px apart; combined footprint overlaps
    const startMid = (p.gx + e.gx) / 2;
    new MovementSystem().tick(s);
    const dx = e.gx - p.gx;
    const minDist = (p.footprintRadius + e.footprintRadius) as number;
    // Separated to just-touching along the original axis, and symmetric about the
    // original midpoint (equal footprint radii → equal split either side).
    expect(dx).toBeGreaterThan(0); // e stays to the right of p (sign preserved)
    expect(Math.abs(dx - minDist)).toBeLessThanOrEqual(2);
    expect(Math.abs((p.gx + e.gx) / 2 - startMid)).toBeLessThanOrEqual(2);
    expect(p.gy).toBe(pxToFp(100));
    expect(e.gy).toBe(pxToFp(100));
  });

  it('pushes an overlapping player and enemy apart (not gated by faction)', () => {
    const s = state();
    const p = s.players[0]!; // spawns at world centre, 800,600 (CFG worldW/H 1600/1200)
    const e = addEnemy(s, 805, 600); // 5px away — well inside their combined footprint
    new MovementSystem().tick(s);
    const dist = isqrt((p.gx - e.gx) * (p.gx - e.gx) + (p.gy - e.gy) * (p.gy - e.gy));
    const minDist = (p.footprintRadius + e.footprintRadius) as number;
    expect(Math.abs(dist - minDist)).toBeLessThanOrEqual(2);
  });

  it('pushes two overlapping enemies apart too — no faction exception left (ENGINE_VERSION 42)', () => {
    const s = state();
    const a = addEnemy(s, 100, 100);
    const b = addEnemy(s, 105, 100); // well inside their combined footprint
    const startMid = (a.gx + b.gx) / 2;
    new MovementSystem().tick(s);
    const dist = isqrt((a.gx - b.gx) * (a.gx - b.gx) + (a.gy - b.gy) * (a.gy - b.gy));
    const minDist = (a.footprintRadius + b.footprintRadius) as number;
    expect(Math.abs(dist - minDist)).toBeLessThanOrEqual(2);
    expect(b.gx).toBeGreaterThan(a.gx); // sign preserved — neither one teleports past the other
    expect(Math.abs((a.gx + b.gx) / 2 - startMid)).toBeLessThanOrEqual(2); // split evenly
    expect(a.gy).toBe(pxToFp(100));
    expect(b.gy).toBe(pxToFp(100));
  });

  it('resolves a concentric actor–actor overlap deterministically (+x split)', () => {
    const s = state();
    const p = s.players[0]!;
    p.gx = pxToFp(100);
    p.gy = pxToFp(100);
    const e = addEnemy(s, 100, 100); // exactly on top of each other
    new MovementSystem().tick(s);
    const minDist = (p.footprintRadius + e.footprintRadius) as number;
    const half = Math.trunc(minDist / 2);
    expect(p.gx).toBe(addFp(pxToFp(100), half as Fp));
    expect(e.gx).toBe(addFp(pxToFp(100), -(minDist - half) as Fp));
    expect(p.gy).toBe(pxToFp(100));
    expect(e.gy).toBe(pxToFp(100));
  });

  it('leaves non-overlapping actors untouched', () => {
    const s = state();
    const a = addEnemy(s, 100, 100);
    const b = addEnemy(s, 500, 500); // far apart
    new MovementSystem().tick(s);
    expect(a.gx).toBe(pxToFp(100));
    expect(a.gy).toBe(pxToFp(100));
    expect(b.gx).toBe(pxToFp(500));
    expect(b.gy).toBe(pxToFp(500));
  });

  it('knockback (design/07 v25): displaces the actor, decays by friction, and snaps to exactly 0', () => {
    const s = state();
    const e = addEnemy(s, 100, 100); // far from any solid/other actor — isolates the decay
    e.knockVx = toFp(1); // 1000 fp/tick, well above KNOCKBACK_SNAP_FP
    const mv = new MovementSystem();
    const gx0 = e.gx;
    mv.tick(s);
    expect(e.gx).toBeGreaterThan(gx0); // the impulse actually moved it this tick
    expect(e.knockVx).toBeGreaterThan(0);
    expect(e.knockVx).toBeLessThan(toFp(1)); // decayed, not held or amplified
    const v1 = e.knockVx;
    mv.tick(s);
    expect(e.knockVx).toBeLessThan(v1); // keeps decaying tick over tick
    for (let i = 0; i < 50; i++) mv.tick(s); // run it out
    expect(e.knockVx).toBe(toFp(0)); // snapped to EXACTLY 0, not a tiny residual forever
  });

  it("knockback on an ENEMY doesn't drift forever (the exact gap design/07 flagged: AI never resets an enemy's vx/vy)", () => {
    const s = state();
    const e = addEnemy(s, 100, 100);
    e.knockVx = toFp(2);
    const mv = new MovementSystem();
    for (let i = 0; i < 200; i++) mv.tick(s); // far more ticks than the decay needs
    expect(e.knockVx).toBe(toFp(0));
    const gxAfterStop = e.gx;
    mv.tick(s); // one more tick once already at rest
    expect(e.gx).toBe(gxAfterStop); // stayed put — no permanent residual velocity
  });

  it("knockback on a PLAYER isn't erased by the next tick's input-driven vx/vy", () => {
    const s = state();
    const p = s.players[0]!;
    p.knockVx = toFp(1);
    p.vx = toFp(0); // idle — ApplyInputSystem would zero this every tick, but Movement runs standalone here
    const gx0 = p.gx;
    new MovementSystem().tick(s);
    expect(p.gx).toBeGreaterThan(gx0); // knockback alone displaced the player
  });
});

describe('ProjectileStepSystem (step 5)', () => {
  it('advances a bullet by its per-tick velocity', () => {
    const s = state();
    const b = addBullet(s, 100, 100, toFp(11), 'enemy');
    new ProjectileStepSystem().tick(s);
    expect(b.gx).toBe(addFp(pxToFp(100), toFp(11))); // start + per-tick velocity
    expect(b.lifeTicks).toBe(89);
  });

  it('expires a bullet that leaves the world margin', () => {
    const s = state();
    const b = addBullet(s, 1700, 100, toFp(11), 'enemy'); // past worldW + oobMargin
    new ProjectileStepSystem().tick(s);
    expect(b.alive).toBe(false);
  });

  it('expires a bullet when its lifespan runs out', () => {
    const s = state();
    const b = addBullet(s, 100, 100, toFp(0), 'enemy');
    b.lifeTicks = 1;
    new ProjectileStepSystem().tick(s);
    expect(b.alive).toBe(false);
  });

  it('expires a bullet that flies into a solid (pillar)', () => {
    const s = createGameState({ ...CFG, obstacles: [[816, 100, 14]] as const });
    const b = addBullet(s, 800, 100, toFp(0.5), 'enemy'); // ~16px step lands in the pillar
    new ProjectileStepSystem().tick(s);
    expect(b.alive).toBe(false);
  });

  it('lets a bullet pass where there is no solid', () => {
    const s = createGameState({ ...CFG, obstacles: [[816, 400, 14]] as const });
    const b = addBullet(s, 800, 100, toFp(0.5), 'enemy'); // pillar is far away on y
    new ProjectileStepSystem().tick(s);
    expect(b.alive).toBe(true);
  });
});

describe('DeflectSystem (step 6) — parry is the melee swing arc', () => {
  it('a swing flips an enemy bullet in its arc to player faction and redirects it at a target', () => {
    const s = state();
    const p = s.players[0]!;
    p.weapon = makeWeapon(SABER_SIM);
    openSwing(p.weapon); // swung THIS tick — the swing IS the parry (no block key)
    p.facing = 0 as Brad; // facing +x
    addEnemy(s, 900, 600); // redirect target to the +x side
    const b = addBullet(s, 830, 600, toFp(-11), 'enemy'); // 30px in front, incoming, in-arc
    new DeflectSystem().tick(s);
    expect(b.faction).toBe('player');
    expect(b.vx).toBeGreaterThan(0); // redirected back toward the enemy
    expect(s.events.some((e) => e.type === 'deflect')).toBe(true);
  });

  it('does not deflect while not swinging (no passive block)', () => {
    const s = state();
    const p = s.players[0]!;
    p.weapon = makeWeapon(SABER_SIM); // holding still — no swing, no parry (window never opened)
    p.facing = 0 as Brad;
    const b = addBullet(s, 830, 600, toFp(-11), 'enemy'); // in-arc but the saber isn't swinging
    new DeflectSystem().tick(s);
    expect(b.faction).toBe('enemy');
  });

  it('ignores a bullet outside the swing arc', () => {
    const s = state();
    const p = s.players[0]!;
    p.weapon = makeWeapon(SABER_SIM);
    openSwing(p.weapon);
    p.facing = 0 as Brad; // facing +x
    const b = addBullet(s, 800, 700, toFp(0), 'enemy'); // 100px below → out of range + arc
    new DeflectSystem().tick(s);
    expect(b.faction).toBe('enemy');
  });
});

describe('HitResolveSystem (step 7)', () => {
  it('a player bullet overlapping an enemy deals damage and is consumed', () => {
    const s = state();
    const e = addEnemy(s, 830, 600);
    addBullet(s, 830, 600, toFp(11), 'player');
    new HitResolveSystem().tick(s);
    expect(e.hp).toBe(1); // 3 - 2
    expect(s.projectiles).toHaveLength(0); // consumed + compacted
  });

  it('an enemy bullet overlapping the player is absorbed by the shield first (two-pool)', () => {
    const s = state();
    const p = s.players[0]!;
    addBullet(s, 800, 600, toFp(0), 'enemy'); // on top of the player
    new HitResolveSystem().tick(s);
    expect(p.hp).toBe(DEFAULT_SKIN.maxHp); // hp untouched while shield remains
    expect(p.shield).toBe(DEFAULT_SKIN.maxShield - 1); // shield soaked the hit
    expect(p.ticksSinceHit).toBe(0); // taking damage reset the regen timer
  });

  it('damage overflows to hp once the shield is gone, and fires shield_break on depletion', () => {
    const s = state();
    const p = s.players[0]!;
    p.shield = 1; // one point of shield left
    addBullet(s, 800, 600, toFp(0), 'enemy'); // dmg 1 → empties the shield exactly
    new HitResolveSystem().tick(s);
    expect(p.shield).toBe(0);
    expect(p.hp).toBe(DEFAULT_SKIN.maxHp); // exactly absorbed, no overflow
    expect(s.events.some((e) => e.type === 'shield_break' && e.id === p.id)).toBe(true);
  });

  it('opposing-faction bullets that overlap cancel each other out', () => {
    const s = state();
    const pb = addBullet(s, 800, 600, toFp(0), 'player');
    const eb = addBullet(s, 800, 600, toFp(0), 'enemy'); // same spot → overlap
    new HitResolveSystem().tick(s);
    expect(pb.alive).toBe(false);
    expect(eb.alive).toBe(false);
    expect(s.projectiles).toHaveLength(0); // both consumed + compacted
    expect(s.events.some((e) => e.type === 'clash')).toBe(true);
  });

  it('same-faction bullets pass through each other (no self-clash)', () => {
    const s = state();
    addBullet(s, 200, 200, toFp(0), 'enemy'); // empty space (no actor to hit)
    addBullet(s, 200, 200, toFp(0), 'enemy'); // overlapping, same faction
    new HitResolveSystem().tick(s);
    expect(s.projectiles).toHaveLength(2); // untouched
    expect(s.events.some((e) => e.type === 'clash')).toBe(false);
  });

  it('a clashing bullet is spent before it can also hit an actor', () => {
    const s = state();
    const p = s.players[0]!;
    const before = p.hp;
    addBullet(s, 800, 600, toFp(0), 'enemy'); // on top of the player…
    addBullet(s, 800, 600, toFp(0), 'player'); // …but cancelled by a player bullet first
    new HitResolveSystem().tick(s);
    expect(p.hp).toBe(before); // clash consumed the enemy bullet before the hit loop
    expect(s.projectiles).toHaveLength(0);
  });

  it('a melee swing hits every enemy inside its arc, once', () => {
    const s = state();
    const p = s.players[0]!;
    p.weapon = makeWeapon(SABER_SIM);
    openSwing(p.weapon);
    p.facing = 0 as Brad;
    const inArc = addEnemy(s, 830, 600); // 30px ahead, in the arc
    const behind = addEnemy(s, 770, 600); // behind → outside the forward arc
    new HitResolveSystem().tick(s);
    expect(inArc.hp).toBe(1); // 3 - 2
    expect(behind.hp).toBe(BASIC_ENEMY.maxHp); // untouched
    // Melee knockback (design/07 v25): the saber's knockback shoves a connected
    // target outward (+x here, since the enemy is directly ahead) into knockVx —
    // never vx/vy directly (that channel gets overwritten/never-decays, see the
    // field's doc comment) — and leaves an untouched target's knockback at 0.
    expect(inArc.knockVx).toBeGreaterThan(0);
    expect(inArc.vx).toBe(toFp(0));
    expect(behind.knockVx).toBe(toFp(0));
  });
});

describe('DeathDropsSystem (step 8)', () => {
  it('removes a dead enemy, emits death, and rolls a pickup via dropPrng', () => {
    const s = state();
    s.tick = 5;
    const e = addEnemy(s, 830, 600, 0); // already at 0 hp
    new DeathDropsSystem().tick(s);
    expect(s.enemies).toHaveLength(0);
    expect(s.events.some((ev) => ev.type === 'death' && ev.id === e.id)).toBe(true);
    expect(s.pickups).toHaveLength(1);
    expect(s.pickups[0]!.spawnTick).toBe(5); // tagged this tick → not collectable yet
  });

  it('the death event carries the DRAWN body radius, not a collision radius', () => {
    // The render layer sizes the death burst off this (design/08: events are the only
    // engine→render channel, and there is nothing left to read it off — the enemy is compacted
    // out of `state.enemies` on this same tick, asserted above). Which of the four radii
    // (`state/actorRadius.ts`) it is matters: `footprintRadius` is deliberately SMALLER than
    // the silhouette so a crowd reads as a crowd, so a burst sized off it would be smaller
    // than the corpse it came out of — and it is the exact substitution that has already gone
    // wrong twice in this file's neighbours (`DoorSystem`, `DeathDropsSystem`'s own minion
    // clamp, both fixed in v49). It cannot be read off a hand-built fixture either: this
    // asserts against `buildEnemyActor`'s own body, via a boss, so a roster change that moves
    // the radius moves the expectation with it.
    const s = state();
    const boss = buildEnemyActor(s, pxToFp(830), pxToFp(600), 'boss');
    boss.hp = 0;
    s.enemies.push(boss);
    new DeathDropsSystem().tick(s);
    const death = s.events.find((ev) => ev.type === 'death' && ev.id === boss.id);
    expect(death).toBeDefined();
    expect(death!.type === 'death' && death!.r).toBe(boss.radius);
    // ...and a boss's silhouette is the one place the three radii visibly disagree.
    expect(boss.radius).not.toBe(boss.footprintRadius);
  });

  it('drop kind is deterministic for a given seed', () => {
    const kindFor = () => {
      const s = state();
      addEnemy(s, 830, 600, 0);
      new DeathDropsSystem().tick(s);
      return s.pickups[0]!.kind;
    };
    expect(kindFor()).toBe(kindFor());
  });

  it('clamps a drop out of a wall the dying enemy died inside/behind (v24)', () => {
    // A wall spanning 700..850 x, 550..650 y — the enemy dies dead-centre inside it
    // (e.g. a knockback shove, or a big footprint flush against geometry), which
    // pre-v24 would drop the pickup right there, unreachable behind the wall. The
    // clamp pushes the point OUT to the nearest edge (may end up exactly touching
    // it, same as MovementSystem's own wall push-out — that's still collectable,
    // just no longer embedded), so assert the centre point itself cleared the
    // rect rather than re-running the padded overlap test the push target ties.
    const s = createGameState({ ...CFG, walls: [[700, 550, 150, 100]] as const });
    addEnemy(s, 775, 600, 0);
    new DeathDropsSystem().tick(s);
    expect(s.pickups).toHaveLength(1);
    const item = s.pickups[0]!;
    const wall = s.walls[0]!;
    const outsideRect =
      item.gx < wall.x || item.gx > ((wall.x + wall.w) as number) || item.gy < wall.y || item.gy > ((wall.y + wall.h) as number);
    expect(outsideRect).toBe(true);
  });

  it('a drop next to a FREE-STANDING block\'s north face is collectible from the CLOSEST legal stance (v48)', () => {
    // End-to-end companion to `geom.test.ts`'s unit coverage of the clamp itself: kill an enemy
    // pressed against the block's own footprint, walk a player to the closest position
    // MovementSystem will EVER let them stand (footprint north edge, minus the brim, minus the
    // player's own solid clearance), and tick PickupSystem for real — the item must actually be
    // collected, not merely "outside the rect" (the property the pre-v48 clamp only checked).
    //
    // What this does NOT prove: at the shipped constants (`WALL_NORTH_BRIM` 23 px,
    // `PLAYER_BASE.solidRadius` 16 px, `SIM.pickupRadius` 15 px), the pre-v48 clamp already
    // landed a drop within `SIM.pickupRadius + PLAYER_BASE.radius` (31 px) of this exact closest
    // stance for a single free-standing block with no neighbour — the margin below is why. This
    // test is a live characterization of the fixed behaviour, not a reproduction of a case that
    // was provably broken at today's numbers; the margin test below is what actually guards
    // against the numbers drifting into broken territory.
    const s = createGameState({ ...CFG });
    s.walls.push({ x: pxToFp(700), y: pxToFp(610), w: pxToFp(200), h: pxToFp(64), freeStanding: true });
    s.rebuildSpatialIndex();
    // The enemy dies pressed against the block's own footprint (a knockback shove, or simply
    // having chased the player right up to it) — well inside the band a bare-footprint clamp
    // would have called "clear".
    addEnemy(s, 800, 615, 0);
    new DeathDropsSystem().tick(s);
    expect(s.pickups).toHaveLength(1);

    s.tick = 6; // past the drop's spawnTick guard
    const p = s.players[0]!;
    p.gx = pxToFp(800);
    // The closest legal north approach for ANY actor (MovementSystem.resolveWalls): the
    // footprint's north edge, minus the brim, minus the player's own solid clearance.
    p.gy = (pxToFp(610) - WALL_NORTH_BRIM - PLAYER_BASE.solidRadius) as Fp;
    new PickupSystem().tick(s);
    expect(s.pickups).toHaveLength(0); // collected, not left behind
    expect(s.events.some((ev) => ev.type === 'pickup')).toBe(true);
  });

  it('the reachability margin against a free-standing block\'s brim is real, not a coincidence of today\'s numbers', () => {
    // The invariant that makes the test above pass, stated directly so it fails loudly (rather
    // than as a mysterious PickupSystem miss two layers away) the day someone widens
    // `WALL_NORTH_BRIM` further, shrinks `SIM.pickupRadius`, or shrinks `PLAYER_BASE.solidRadius`
    // enough to erode it. `WALL_NORTH_BRIM`'s own doc comment already flags 23 px as a CEILING set
    // by the shipped map's tightest corridor, not a target — the natural next move if the report
    // reopens is to raise it further once room geometry allows, and that is exactly the change
    // this guards.
    //
    // Derivation: the worst case for a drop pushed out of a free-standing block's brimmed north
    // edge lands `SIM.pickupRadius` short of the brimmed edge; the closest any actor may ever
    // stand is `solidRadius + WALL_NORTH_BRIM` short of the true footprint edge. The gap between
    // those two points must stay under the collect reach (`SIM.pickupRadius + PLAYER_BASE.radius`)
    // — i.e. `WALL_NORTH_BRIM < 2 * SIM.pickupRadius + PLAYER_BASE.radius - PLAYER_BASE.solidRadius`,
    // which simplifies (solidRadius === radius for the player) to `WALL_NORTH_BRIM < 2 * pickupRadius`.
    expect((WALL_NORTH_BRIM as number)).toBeLessThan(2 * (SIM.pickupRadius as number));
  });
});

describe('PickupSystem (step 9)', () => {
  it('heals the player on overlap and consumes the pickup', () => {
    const s = state();
    s.tick = 10;
    const p = s.players[0]!;
    p.hp = 3;
    s.pickups.push({ id: s.nextId(), kind: 'heal', gx: p.gx, gy: p.gy, spawnTick: 0, alive: true });
    new PickupSystem().tick(s);
    expect(p.hp).toBe(4);
    expect(s.pickups).toHaveLength(0);
  });

  it('does not collect a pickup dropped on the same tick (design/08 8→9 ordering)', () => {
    const s = state();
    s.tick = 10;
    const p = s.players[0]!;
    s.pickups.push({ id: s.nextId(), kind: 'material', gx: p.gx, gy: p.gy, spawnTick: 10, alive: true });
    new PickupSystem().tick(s);
    expect(s.pickups).toHaveLength(1); // still there
  });
});
