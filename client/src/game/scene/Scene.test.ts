/**
 * Scene.reconcile — the render-side mirror of engine state. Covers the two facing angles
 * it computes for the player view: `facingRad` (the weapon) is exactly the engine's
 * aim-derived `PlayerActor.facing`, and `bodyFacingRad` (the body/eye) TURNS TOWARD that
 * same aim at a bounded rate (`render/facing.ts`'s `turnToward`). It used to track the
 * player's velocity instead — a humanoid upper/lower-body split, replaced 2026-08-18
 * because the orb-core has no lower body. Enemies/bullets are unaffected — they keep a
 * single facing.
 */
import type { Graphics } from 'pixi.js';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createGameState } from '@dd/engine/state/GameState';
import { takeDamage } from '@dd/engine/systems/combat';
import type { GameState } from '@dd/engine/state/GameState';
import { pxToFp } from '@dd/engine/content/convert';
import { freshStatus } from '@dd/engine/content/damage';
import { BASIC_ENEMY } from '@dd/engine/content/enemies';
import { toFp } from '@dd/engine/math/fixed';
import type { Brad } from '@dd/engine/math/trig';
import { ENEMY_TEAM_ID, type EnemyActor, type Projectile, type PickupItem } from '@dd/engine/state/entities';
import type { GameEvent } from '@dd/engine/state/events';
import { Scene } from './Scene';
import { Pickup } from './Pickup';
import { FLIGHT_MS } from './pickupFlight';
import { Layers } from './layers';
import { bradToRad } from '../coords';
import { BODY_TURN_PER_TICK } from '../../render/facing';
import { resetActiveQuality, setActiveQuality } from '../../render/quality';
import { SHATTER_MS } from './actorFilters';
import { Actor } from './Actor';
import type { Entity } from './Entity';

// EnergyShieldFilter/OutlineFilter/DissolveFilter (Actor's setShield/onHurt/
// onDeath) all build a real WebGL GlProgram at construction time — unavailable
// under plain vitest, same reason Actor.test.ts/FxController.test.ts stub fx/filters.ts.
// Spread over `vi.importActual` (the convention RoomBuilder.test.ts/wechatRoomBuild.test.ts
// already use here): only the filter CLASSES touch GL, while the module also exports plain
// values the scene layer reads — `SHELL_ASPECT`, the shield shell's screen aspect, which sizes
// `Actor`'s `filterArea`. Restating one of those in a mock would let it drift away from the
// shipped number, and a mock that must be edited every time the real module gains an export is
// its own trap: adding that one constant broke every test in this file.
vi.mock('../fx/filters', async () => ({
  ...(await vi.importActual<typeof import('../fx/filters')>('../fx/filters')),
  EnergyShieldFilter: class {
    intensity = 0;
    /** The exit, 0..1 — `ActorFilters` drives it once the pool empties (2026-08-26). */
    shatter = 0;
    hit() {}
    tick() {}
  },
  OutlineFilter: class {
    alpha = 0;
  },
  DissolveFilter: class {
    progress = 0;
  },
  HeatHazeFilter: class {
    intensity = 1;
    tick() {}
  },
}));

const CFG = { seed: 1, worldW: 800, worldH: 600, waves: [] as const };

function addEnemy(s: GameState, xpx: number, ypx: number, facing: Brad): EnemyActor {
  const e: EnemyActor = {
    id: s.nextId(), faction: 'enemy', teamId: ENEMY_TEAM_ID,
    gx: pxToFp(xpx), gy: pxToFp(ypx), z: toFp(0), vx: toFp(0), vy: toFp(0),
    knockVx: toFp(0), knockVy: toFp(0),
    facing, hp: BASIC_ENEMY.maxHp, maxHp: BASIC_ENEMY.maxHp,
    shield: 0, maxShield: 0, ticksSinceHit: 0,
    radius: BASIC_ENEMY.radius, footprintRadius: BASIC_ENEMY.footprintRadius, solidRadius: BASIC_ENEMY.radius,
    alive: true, weapon: null, firing: false, status: freshStatus(), enraged: false, armorBroken: false, aggroed: false, holding: false,
  };
  s.enemies.push(e);
  return e;
}

function addBullet(s: GameState, xpx: number, ypx: number): Projectile {
  const b: Projectile = {
    id: s.nextId(), faction: 'enemy', teamId: ENEMY_TEAM_ID,
    gx: pxToFp(xpx), gy: pxToFp(ypx), z: toFp(0), vx: toFp(1), vy: toFp(0),
    radius: toFp(4), damage: 1, damageType: 'physical', lifeTicks: 60, alive: true,
  };
  s.projectiles.push(b);
  return b;
}

function addPickup(s: GameState, xpx: number, ypx: number): PickupItem {
  const it: PickupItem = {
    id: s.nextId(), kind: 'material', gx: pxToFp(xpx), gy: pxToFp(ypx),
    spawnTick: 0, alive: true, materialId: 'fire', qty: 1,
  };
  s.pickups.push(it);
  return it;
}

// The body used to face the MOVEMENT vector (a humanoid upper/lower split). Since
// 2026-08-18 it turns toward the AIM, rate-limited — the orb-core is an eye, and an eye
// looks at what it shoots (design/12/13, render/facing.ts's header).
describe('Scene.reconcile — body turns toward the aim', () => {
  it('faces the aim, not the movement direction', () => {
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
    const p = s.players[0]!;
    p.facing = 0 as Brad; // aim east
    p.vx = toFp(0);
    p.vy = toFp(-1); // moving north (up-screen, negative y)
    const scene = new Scene(new Layers());
    scene.reconcile(s, p.id);
    const view = scene.player!;
    expect(view.facingRad).toBeCloseTo(0, 5);
    expect(view.bodyFacingRad).toBeCloseTo(0, 5); // the aim, NOT atan2(vy, vx) = -PI/2
  });

  it('a fresh spawn starts already facing its aim (nothing to turn from)', () => {
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
    const p = s.players[0]!;
    p.facing = 16384 as Brad; // aim north
    const scene = new Scene(new Layers());
    scene.reconcile(s, p.id);
    expect(scene.player!.bodyFacingRad).toBeCloseTo(bradToRad(16384), 5);
  });

  it('turns by at most BODY_TURN_PER_TICK per tick, and arrives after enough of them', () => {
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
    const p = s.players[0]!;
    p.facing = 0 as Brad; // spawn aiming east
    const scene = new Scene(new Layers());
    scene.reconcile(s, p.id);
    expect(scene.player!.bodyFacingRad).toBeCloseTo(0, 5);

    p.facing = 16384 as Brad; // aim snaps 90° north (auto-aim switching target)
    scene.reconcile(s, p.id);
    // One tick moves exactly one step — NOT the whole 90°, which is the twitch this fixes.
    expect(Math.abs(scene.player!.bodyFacingRad)).toBeCloseTo(BODY_TURN_PER_TICK, 5);
    expect(scene.player!.facingRad).toBeCloseTo(bradToRad(16384), 5); // the weapon aim did snap

    // PI/2 / 0.27 ≈ 5.8 steps; 6 more ticks is comfortably enough to land exactly.
    for (let i = 0; i < 6; i++) scene.reconcile(s, p.id);
    expect(scene.player!.bodyFacingRad).toBeCloseTo(bradToRad(16384), 5);
  });
});

// ROADMAP: fixes the local player's walk animation never playing under online
// prediction — `positionLocal`'s snap() collapses prev onto cur every render frame, so
// Actor.interpolate's default curX/prevX-delta heuristic would always read "stationary"
// for the predicted local view. `moving` is threaded straight to `Entity.movingOverride`.
describe('Scene.positionLocal — moving flag survives the predicted-pose snap', () => {
  it('sets movingOverride from its `moving` argument (default false)', () => {
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
    const scene = new Scene(new Layers());
    scene.reconcile(s, s.players[0]!.id);

    scene.positionLocal(10, 10, 0, 0, true);
    expect(scene.player!.movingOverride).toBe(true);

    scene.positionLocal(10, 10, 0, 0, false);
    expect(scene.player!.movingOverride).toBe(false);

    scene.positionLocal(10, 10, 0, 0);
    expect(scene.player!.movingOverride).toBe(false); // omitted → defaults to idle, not "derive from buffer"
  });

  it('the very next reconcile() (a normal confirmed pushState) resets movingOverride to null again', () => {
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
    const scene = new Scene(new Layers());
    scene.reconcile(s, s.players[0]!.id);
    scene.positionLocal(10, 10, 0, 0, true);
    expect(scene.player!.movingOverride).toBe(true);

    scene.reconcile(s, s.players[0]!.id); // e.g. prediction deactivated — back to the confirmed path
    expect(scene.player!.movingOverride).toBeNull();
  });

  // The predicted-pose path runs at RENDER rate, so it must not re-derive body facing —
  // that would turn the body twice as fast as `reconcile`'s per-tick step (and, before
  // 2026-08-18, is where the predictor's movement direction leaked back in).
  it('carries the body facing reconcile() already set, instead of resetting it to the aim', () => {
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
    const p = s.players[0]!;
    p.facing = 0 as Brad;
    const scene = new Scene(new Layers());
    scene.reconcile(s, p.id); // spawns body-facing east
    p.facing = 16384 as Brad; // aim jumps north
    scene.reconcile(s, p.id); // one step of turn
    const afterOneStep = scene.player!.bodyFacingRad;

    scene.positionLocal(10, 10, 0, bradToRad(16384), true);
    expect(scene.player!.bodyFacingRad).toBeCloseTo(afterOneStep, 5); // NOT the aim
  });

  it('is a no-op before the local view exists (no crash)', () => {
    const scene = new Scene(new Layers());
    expect(() => scene.positionLocal(0, 0, 0, 0, true)).not.toThrow();
  });
});

describe('Scene.reconcile — local-seat marker (design/10 legibility)', () => {
  // The marker is now the health-bar teal outline alone (Actor.setLocal dropped the
  // separate ground ring 2026-08-14 — see design/10/ROADMAP), driven by Actor's private
  // `isLocal` flag; reach into it the same way Actor.test.ts does for other private state.
  function isLocal(view: unknown): boolean {
    return (view as { isLocal: boolean }).isLocal;
  }

  it('marks only the named local seat, not the other players', () => {
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }, { start: [200, 100] }] });
    const [me, other] = s.players;
    const scene = new Scene(new Layers());

    scene.reconcile(s, me!.id);

    const views = (scene as unknown as { views: Map<number, unknown> }).views;
    expect(isLocal(views.get(me!.id))).toBe(true);
    expect(isLocal(views.get(other!.id))).toBe(false);
  });

  it('keeps the single-player default (no localPlayerId) marked across later reconciles', () => {
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
    const scene = new Scene(new Layers());

    scene.reconcile(s);
    scene.reconcile(s); // the sticky-choice path: playerView is already set by now

    const views = (scene as unknown as { views: Map<number, unknown> }).views;
    expect(isLocal(views.get(s.players[0]!.id))).toBe(true);
    expect(scene.player).toBe(views.get(s.players[0]!.id));
  });
});

describe('Scene.reconcile — enemies keep a single facing (no body/aim split)', () => {
  it("an enemy's view bodyFacingRad always equals its facingRad", () => {
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
    const enemy = addEnemy(s, 300, 300, 16384 as Brad);
    const scene = new Scene(new Layers());
    scene.reconcile(s);
    const views = (scene as unknown as { views: Map<number, { facingRad: number; bodyFacingRad: number }> }).views;
    const view = views.get(enemy.id);
    expect(view).toBeDefined();
    expect(view!.bodyFacingRad).toBe(view!.facingRad);
    expect(view!.facingRad).toBeCloseTo(bradToRad(16384), 5);
  });
});

describe('Scene.enemies — every live enemy view (occlusion x-ray, GameLoop.updateFx)', () => {
  it('returns every live enemy, and excludes the player', () => {
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
    const e1 = addEnemy(s, 300, 300, 0 as Brad);
    const e2 = addEnemy(s, 400, 400, 0 as Brad);
    const scene = new Scene(new Layers());
    scene.reconcile(s);

    expect(scene.enemies.length).toBe(2);
    expect(scene.enemies).not.toContain(scene.player);
    // Order isn't meaningful, so compare against the actual views rather than array identity.
    expect(scene.enemies).toContain(scene.actorAt(e1.id));
    expect(scene.enemies).toContain(scene.actorAt(e2.id));
  });

  it('is empty when the room has no enemies', () => {
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
    const scene = new Scene(new Layers());
    scene.reconcile(s);
    expect(scene.enemies).toEqual([]);
  });

  it('excludes bullets and pickups — only Actor (player/enemy) views count', () => {
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
    addEnemy(s, 300, 300, 0 as Brad);
    addBullet(s, 50, 50);
    addPickup(s, 60, 60);
    const scene = new Scene(new Layers());
    scene.reconcile(s);
    expect(scene.enemies.length).toBe(1);
  });

  it('drops an enemy the tick it dies — a dissolving view is not a live one to protect', () => {
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
    const enemy = addEnemy(s, 300, 300, 0 as Brad);
    const scene = new Scene(new Layers());
    scene.reconcile(s);
    expect(scene.enemies.length).toBe(1);

    enemy.alive = false;
    scene.reconcile(s);
    expect(scene.enemies).toEqual([]);
  });
});

describe('Scene.pickups — every live pickup view (occlusion x-ray, GameLoop.updateFx, live report "被墙挡住的物品，只有角色走到墙下的时候才显示")', () => {
  it('returns every live pickup, positioned at its own drop', () => {
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
    addPickup(s, 60, 60);
    addPickup(s, 70, 70);
    const scene = new Scene(new Layers());
    scene.reconcile(s);

    expect(scene.pickups.length).toBe(2);
    // Order isn't meaningful, so compare the set of ground positions rather than array identity.
    const positions = scene.pickups.map((p) => [p.curX, p.curY]).sort((a, b) => a[0]! - b[0]!);
    expect(positions[0]![0]).toBeCloseTo(60, 1);
    expect(positions[0]![1]).toBeCloseTo(60, 1);
    expect(positions[1]![0]).toBeCloseTo(70, 1);
    expect(positions[1]![1]).toBeCloseTo(70, 1);
  });

  it('is empty when the room has no pickups', () => {
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
    const scene = new Scene(new Layers());
    scene.reconcile(s);
    expect(scene.pickups).toEqual([]);
  });

  it('excludes bullets and actors — only Pickup views count', () => {
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
    addEnemy(s, 300, 300, 0 as Brad);
    addBullet(s, 50, 50);
    addPickup(s, 60, 60);
    const scene = new Scene(new Layers());
    scene.reconcile(s);
    expect(scene.pickups.length).toBe(1);
  });
});

describe('Scene.actorAt — actor-lookup by id (EventReactor hit-flash, design/01 milestone 5)', () => {
  it('resolves a live enemy/player id to its Actor view', () => {
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
    const enemy = addEnemy(s, 300, 300, 0 as Brad);
    const scene = new Scene(new Layers());
    scene.reconcile(s);
    expect(scene.actorAt(enemy.id)).toBeDefined();
    expect(scene.actorAt(s.players[0]!.id)).toBeDefined();
  });

  it('is undefined for an id with no view (bullet/pickup ids, or one never spawned)', () => {
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
    const scene = new Scene(new Layers());
    scene.reconcile(s);
    expect(scene.actorAt(999999)).toBeUndefined();
  });
});

describe('Scene.reconcile — death-dissolve lingering view (design/01 fidelity roadmap milestone 5)', () => {
  it('keeps a dead enemy\'s view around (dissolving) instead of destroying it the same tick', () => {
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
    const enemy = addEnemy(s, 300, 300, 0 as Brad);
    const scene = new Scene(new Layers());
    scene.reconcile(s);
    const views = (scene as unknown as { views: Map<number, unknown> }).views;
    expect(views.has(enemy.id)).toBe(true);

    enemy.alive = false;
    scene.reconcile(s);
    // Gone from the live-views map (a fresh reconcile shouldn't try to push new state
    // into it), but not actually torn down yet — it's dissolving.
    expect(views.has(enemy.id)).toBe(false);
    const dying = (scene as unknown as { dying: Array<{ isDissolved: boolean }> }).dying;
    expect(dying.length).toBe(1);
    expect(dying[0].isDissolved).toBe(false);
  });

  it('destroys the dying view once its dissolve finishes interpolating', () => {
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
    const enemy = addEnemy(s, 300, 300, 0 as Brad);
    const scene = new Scene(new Layers());
    scene.reconcile(s);
    enemy.alive = false;
    scene.reconcile(s);

    scene.interpolate(1, 700); // the full 700ms dissolve duration in one step
    const dying = (scene as unknown as { dying: unknown[] }).dying;
    expect(dying.length).toBe(0);
  });

  it('clear() tears down any still-dissolving views along with the live ones', () => {
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
    const enemy = addEnemy(s, 300, 300, 0 as Brad);
    const scene = new Scene(new Layers());
    scene.reconcile(s);
    enemy.alive = false;
    scene.reconcile(s);

    expect(() => scene.clear()).not.toThrow();
    const dying = (scene as unknown as { dying: unknown[] }).dying;
    expect(dying.length).toBe(0);
  });

  it("a dead LOCAL player also dissolves, and playerView clears immediately (not after the dissolve)", () => {
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
    const p = s.players[0]!;
    const scene = new Scene(new Layers());
    scene.reconcile(s, p.id);
    expect(scene.player).not.toBeNull();

    p.alive = false;
    scene.reconcile(s, p.id);
    // The camera should stop following a dead player right away — it shouldn't wait
    // for the lingering dissolve view to finish playing out.
    expect(scene.player).toBeNull();
    const dying = (scene as unknown as { dying: Array<{ isDissolved: boolean }> }).dying;
    expect(dying.length).toBe(1);
    expect(dying[0].isDissolved).toBe(false);
  });

  it('a removed bullet is destroyed immediately — no dissolve for non-Actor views', () => {
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
    const bullet = addBullet(s, 300, 300);
    const scene = new Scene(new Layers());
    scene.reconcile(s);
    const views = (scene as unknown as { views: Map<number, unknown> }).views;
    expect(views.has(bullet.id)).toBe(true);

    bullet.alive = false;
    scene.reconcile(s);
    expect(views.has(bullet.id)).toBe(false);
    const dying = (scene as unknown as { dying: unknown[] }).dying;
    expect(dying.length).toBe(0); // gone outright, not queued to dissolve
  });

  it('a new bullet is DRAWN leaving the shooter\'s muzzle, easing onto the engine position', () => {
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
    const p = s.players[0]!;
    const scene = new Scene(new Layers());
    scene.reconcile(s, p.id); // the shooter's view has to exist before its bullet does
    // The placeholder skin these tests build has no rig-mounted module, so stub the muzzle the
    // way a preloaded weapon texture would report it: a barrel tip 30px further along the shot
    // than where the engine spawns the round, drawn at a gun height of 8px. The height half
    // matters since 2026-09-02 — `Scene` measures the offset against the round's own DRAWN
    // height (`muzzlePos().heightPx`), not against the sim's `bulletZ`.
    scene.actorAt(p.id)!.muzzlePos = () => ({ x: 330, y: 292, heightPx: 8 });

    const bullet = addBullet(s, 300, 300); // z 0, vx +x — so the shot runs due east
    bullet.ownerId = p.id;
    scene.reconcile(s, p.id);
    const view = (scene as unknown as { views: Map<number, Entity> }).views.get(bullet.id)!;

    // The engine's own position is untouched — only the drawn one is corrected.
    expect(view.curX).toBe(300);
    expect(view.curY).toBe(300);

    scene.interpolate(1, 0); // first drawn frame: fully at the muzzle
    expect(view.x).toBeCloseTo(330, 5);
    expect(view.y).toBeCloseTo(292, 5);

    // The correction is spent by DISTANCE TRAVELLED (Bullet.ts, retuned 2026-08-30), not by
    // elapsed time — advance the engine's own bullet position and reconcile so the view gets a
    // fresh pushState, the same way a real sim tick would move it.
    bullet.gx = pxToFp(320); // 20 of the 40px budget
    scene.reconcile(s, p.id);
    scene.interpolate(1, 16); // halfway through the 40px ease: 0.5^2 of the offset left
    expect(view.x).toBeCloseTo(320 + 30 * 0.25, 5);
    // The HEIGHT does not ease — the round is drawn at the gun's height for its whole life
    // (2026-09-02). It used to ease from 292 back down to the sim's own 300, and since that is
    // straight up the screen it was PERPENDICULAR to this due-east shot, i.e. the arc.
    expect(view.y).toBeCloseTo(292, 5);

    bullet.gx = pxToFp(340); // the other 20px — the whole 40px budget now spent
    scene.reconcile(s, p.id);
    scene.interpolate(1, 16); // past it: exactly the engine position, at the gun's height
    expect(view.x).toBeCloseTo(340, 5);
    expect(view.y).toBeCloseTo(292, 5);
  });

  // The wiring half of `Bullet.setMuzzleOrigin`'s projection: `Scene` hands it the shot
  // direction off the round's own velocity, so a drawn muzzle sitting off the shot's line
  // cannot bend the round. Here the stub is 12px off it — a disagreement that big is what
  // `muzzleParity.test.ts` actually bounds; this pins that the renderer draws no curve out of
  // one in the meantime.
  it('never bends a bullet, even when the reported muzzle is off the shot line', () => {
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
    const p = s.players[0]!;
    const scene = new Scene(new Layers());
    scene.reconcile(s, p.id);
    // 12px above the shot's line, at a gun height of 8px.
    scene.actorAt(p.id)!.muzzlePos = () => ({ x: 330, y: 280, heightPx: 8 });

    const bullet = addBullet(s, 300, 300); // due east again
    bullet.ownerId = p.id;
    scene.reconcile(s, p.id);
    const view = (scene as unknown as { views: Map<number, Entity> }).views.get(bullet.id)!;

    for (const [travelled, gx] of [[0, 300], [10, 310], [20, 320], [40, 340]] as const) {
      bullet.gx = pxToFp(gx);
      scene.reconcile(s, p.id);
      scene.interpolate(1, 16);
      // Dead flat at the gun's height on every frame of the ease — the 12px across the shot is
      // dropped, not spent, so there is no sideways motion to see.
      expect(view.y, `after ${travelled}px`).toBeCloseTo(292, 5);
    }
  });

  it('a bullet whose shooter reports no muzzle is drawn at the engine position from frame one (every enemy)', () => {
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
    const enemy = addEnemy(s, 200, 200, 0 as Brad);
    const scene = new Scene(new Layers());
    scene.reconcile(s);
    const bullet = addBullet(s, 300, 300);
    bullet.ownerId = enemy.id; // a critter-core enemy: muzzlePos() is null for it
    scene.reconcile(s);

    const view = (scene as unknown as { views: Map<number, Entity> }).views.get(bullet.id)!;
    scene.interpolate(1, 0);
    expect(view.x).toBe(300);
    expect(view.y).toBe(300);
  });

  it('a collected pickup is destroyed immediately — no dissolve for non-Actor views', () => {
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
    const pickup = addPickup(s, 300, 300);
    const scene = new Scene(new Layers());
    scene.reconcile(s);

    pickup.alive = false;
    scene.reconcile(s);
    const dying = (scene as unknown as { dying: unknown[] }).dying;
    expect(dying.length).toBe(0);
  });

  it('two enemies dying the same tick both dissolve independently — no array-splice off-by-one', () => {
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
    const a = addEnemy(s, 300, 300, 0 as Brad);
    const b = addEnemy(s, 400, 300, 0 as Brad);
    const scene = new Scene(new Layers());
    scene.reconcile(s);

    a.alive = false;
    b.alive = false;
    scene.reconcile(s);
    const dying = (scene as unknown as { dying: Array<{ isDissolved: boolean }> }).dying;
    expect(dying.length).toBe(2);

    // Finish only enough of the dissolve for both to complete, one interpolate() call —
    // exercises the reverse-iterating splice loop with more than one entry at once.
    scene.interpolate(1, 700);
    expect(dying.length).toBe(0);
  });
});

/**
 * Health bars ride `layers.hud`, not the Actor's own container (2026-08-21, live report
 * *"血条被墙挡住了"* — `scene/occlusion.ts`'s cap-only fade keeps a near-white BODY legible but
 * washes the bar's own dark contour/track into the same luma band as the wall behind it).
 * `Actor.ts` owns the position sync (`applyTransform`) and teardown (`destroy`); this covers
 * the half only `Scene` can see — that `spawn()` actually mounts it there for both factions,
 * keeps tracking it, and cleans it up on every removal path (immediate and dissolve-delayed).
 */
describe('Scene.spawn — the health bar rides layers.hud, never the actor\'s own container', () => {
  it('mounts a player\'s health bar on layers.hud, not as a child of the actor view', () => {
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
    const p = s.players[0]!;
    const layers = new Layers();
    const scene = new Scene(layers);
    scene.reconcile(s, p.id);
    const view = scene.player!;
    expect(layers.hud.children).toContain(view.healthBar);
    expect(view.children).not.toContain(view.healthBar);
  });

  it('mounts an enemy\'s health bar on layers.hud too', () => {
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
    addEnemy(s, 300, 300, 0 as Brad);
    const layers = new Layers();
    const scene = new Scene(layers);
    scene.reconcile(s);
    const view = (scene as unknown as { views: Map<number, Actor> }).views.get(s.enemies[0]!.id)!;
    expect(layers.hud.children).toContain(view.healthBar);
  });

  it('keeps the bar tracking the actor across ticks, offset from its own screen position', () => {
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
    const p = s.players[0]!;
    const scene = new Scene(new Layers());
    scene.reconcile(s, p.id);
    const view = scene.player!;
    scene.interpolate(1, 0);
    const offset = view.healthBar!.y - view.y;

    p.gx = pxToFp(250);
    p.gy = pxToFp(180);
    scene.reconcile(s, p.id);
    scene.interpolate(1, 0);
    expect(view.healthBar!.x).toBeCloseTo(view.x, 5);
    expect(view.healthBar!.y - view.y).toBeCloseTo(offset, 5); // same offset, new position
  });

  it('destroys and detaches the health bar when a bar-less view is torn down outright (bullet)', () => {
    // Not an Actor at all — confirms `spawn()`'s `instanceof Actor` guard doesn't choke on a
    // view with no `healthBar`.
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
    const bullet = addBullet(s, 300, 300);
    const layers = new Layers();
    const scene = new Scene(layers);
    expect(() => scene.reconcile(s)).not.toThrow();
    bullet.alive = false;
    expect(() => scene.reconcile(s)).not.toThrow();
  });

  it('detaches the health bar from layers.hud once a dissolving enemy actually finishes destroying', () => {
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
    const enemy = addEnemy(s, 300, 300, 0 as Brad);
    const layers = new Layers();
    const scene = new Scene(layers);
    scene.reconcile(s);
    const view = (scene as unknown as { views: Map<number, Actor> }).views.get(enemy.id)!;
    const bar = view.healthBar!;
    expect(layers.hud.children).toContain(bar);

    enemy.alive = false;
    scene.reconcile(s); // queued to dissolve, not destroyed yet — bar stays mounted
    expect(layers.hud.children).toContain(bar);

    scene.interpolate(1, 700); // finishes the dissolve → Actor.destroy()
    expect(layers.hud.children).not.toContain(bar);
  });

  it('clear() also detaches every still-mounted health bar (live views and dissolving ones)', () => {
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
    const live = addEnemy(s, 300, 300, 0 as Brad);
    const dying = addEnemy(s, 400, 300, 0 as Brad);
    const layers = new Layers();
    const scene = new Scene(layers);
    scene.reconcile(s);
    dying.alive = false;
    scene.reconcile(s);
    expect(layers.hud.children.length).toBe(3); // the fixture's own player + both enemies

    scene.clear();
    expect(layers.hud.children.length).toBe(0);
    void live; // only needed to keep the fixture's second enemy alive through the reconcile above
  });
});

// `Scene.applyLighting` is gone (2026-08-24). Shading a scene is no longer something the
// scene graph does per Actor — it is one screen-space pass over `Layers.lit`, driven from
// `FxController.updateCamera`, and its coverage lives in FxController.test.ts. What remains
// worth pinning HERE is the consequence for an Actor's own filter list: a plain actor now
// carries no filter at all, where it used to always carry the lit one.
function skinFiltersOf(a: Actor): unknown[] {
  return ((a as unknown as { skin: { view: { filters: unknown[] | null } } }).skin.view.filters ?? []);
}

/**
 * The batching half of the same "does it batch with its neighbours" question the filter tests below
 * ask (2026-08-24 draw-call pass). `RoomBuilder.test.ts` sweeps `layers.shadow` after a room build,
 * which covers the wall/pillar/prop shadows — but a player's, an enemy's and a bullet's shadow are
 * all mounted by `Scene.spawn`, so nothing over there can see them. On the measured start room those
 * were 22 of 165 draw calls, one per shadow, purely because a nested-ellipse penumbra is past Pixi's
 * 400-float auto-batch cutoff.
 */
describe('Scene.spawn — every shadow it mounts is batched', () => {
  it('batches the shadow of a player, an enemy and a bullet alike', () => {
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
    addEnemy(s, 300, 300, 0 as Brad);
    addBullet(s, 200, 200);
    const layers = new Layers();
    new Scene(layers).reconcile(s, s.players[0]!.id);
    const shadows = layers.shadow.children.filter(
      (c): c is Graphics => (c as Graphics).context !== undefined,
    );
    // Three distinct spawn paths, so a fix applied to only one of them fails here.
    expect(shadows.length).toBeGreaterThanOrEqual(3);
    for (const g of shadows) expect(g.context.batchMode).toBe('batch');
  });

  it('keeps batching them as the cast changes, not just on the first reconcile', () => {
    // A later spawn goes through the same `spawn()` call, but a future refactor that built the
    // first frame's views differently (a warm-up path, a pool) could easily miss it.
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
    const layers = new Layers();
    const scene = new Scene(layers);
    scene.reconcile(s, s.players[0]!.id);
    const before = layers.shadow.children.length;
    addEnemy(s, 400, 400, 0 as Brad);
    scene.reconcile(s, s.players[0]!.id);
    expect(layers.shadow.children.length).toBeGreaterThan(before);
    for (const c of layers.shadow.children) {
      const g = c as Graphics;
      if (g.context) expect(g.context.batchMode).toBe('batch');
    }
  });
});

describe('Scene — actors carry no lighting filter of their own any more', () => {
  it('leaves a player carrying only its own shield glow — no lighting filter underneath it', () => {
    // The launch characters all have a shield pool, so the ONE filter here is the shield's.
    // Before this change there were two, and the lit one was on every actor unconditionally.
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
    const scene = new Scene(new Layers());
    scene.reconcile(s);
    expect(skinFiltersOf(scene.player!).map((f) => (f as object).constructor.name)).toEqual(['EnergyShieldFilter']);
  });

  it('spawns a shieldless enemy with NO filters at all, so it batches with its neighbours', () => {
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
    const enemy = addEnemy(s, 300, 300, 0 as Brad);
    const scene = new Scene(new Layers());
    scene.reconcile(s);
    expect(skinFiltersOf(scene.actorAt(enemy.id)!)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------
// The shield shell, driven by the ENGINE's numbers rather than by literals.
//
// Every test in `Actor.test.ts` calls `setShield(4, 8)` by hand. This is the seam where the real
// pool arrives, and a 2026-08-26 mutation battery over `Scene.ts` — the file the shell-exit
// battery never mutated — found it untested in exactly the way that matters. All three of these
// survived the whole 3239-test suite:
//
//   v.setShield(p.maxShield, p.shield)          // the ratio inverted
//   v.setShield(p.shield, 1)                    // the pool hard-coded
//   v.setShield(Math.max(1, p.shield), p.maxShield)  // the shell can NEVER break
//
// The last one is the one to remember: it leaves the entire exit animation dead in the shipped
// game with everything green. "0 survivors" is always scoped to the files a battery mutates.
// ---------------------------------------------------------------------------------------

describe('Scene — the shield shell reads the real pool, not just an on/off switch', () => {
  const shellOf = (a: Actor): { intensity: number; shatter: number } | null =>
    (a as unknown as { fx: { shieldFilter: { intensity: number; shatter: number } | null } })
      .fx.shieldFilter;

  it('sets the shell brightness to the RATIO the engine reports', () => {
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
    const p = s.players[0]!;
    p.shield = p.maxShield / 4; // a real pool, quartered — not a literal pair
    const scene = new Scene(new Layers());
    scene.reconcile(s);
    expect(shellOf(scene.player!)!.intensity).toBeCloseTo(0.25, 6);
  });

  it('follows the pool down as it drains, frame by frame', () => {
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
    const p = s.players[0]!;
    const scene = new Scene(new Layers());
    const seen: number[] = [];
    for (const k of [1, 0.75, 0.5, 0.25]) {
      p.shield = p.maxShield * k;
      scene.reconcile(s);
      seen.push(shellOf(scene.player!)!.intensity);
    }
    expect(seen).toEqual([1, 0.75, 0.5, 0.25].map((k) => expect.closeTo(k, 6)));
  });

  it('starts the exit off a REAL hit that empties the pool', () => {
    // `takeDamage` is the only producer of both halves of this moment: the `shield_break` event
    // `EventReactor` throws its shards from, and the `shield === 0` the shell reads to begin its
    // exit. Driving the real one here is what actually checks the claim the wiring's comments
    // make — that the two halves need no handshake because they read the same instant from two
    // different channels. No literal-driven test can check that.
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
    const p = s.players[0]!;
    const scene = new Scene(new Layers());
    scene.reconcile(s);
    expect(shellOf(scene.player!)!.shatter).toBe(0);

    s.events.length = 0;
    takeDamage(s, p, p.shield, 'enemy', 'physical');
    expect(p.shield).toBe(0);
    expect(s.events.some((e) => e.type === 'shield_break')).toBe(true);

    scene.reconcile(s);
    // Still on screen — the exit is what holds it there, and this is the frame the burst lands on.
    expect(skinFiltersOf(scene.player!)).toHaveLength(1);
    scene.interpolate(1, SHATTER_MS / 2);
    expect(shellOf(scene.player!)!.shatter).toBeCloseTo(0.5, 6);
    scene.interpolate(1, SHATTER_MS / 2);
    expect(skinFiltersOf(scene.player!)).toEqual([]); // and only then gone
  });

  it('gives a shielded ENEMY a shell too — the sync is not player-only', () => {
    // No shipped enemy carries a shield pool today (`enemies.ts`: `maxShield: 0`), which is why
    // deleting the enemy half of the sync survived the suite untouched. That is a CONTENT gap,
    // not a test gap: design/07's two-pool health is a property of every actor, and a shielded
    // elite is a content change rather than a code one. So the fixture supplies the pool the
    // shipped roster does not have yet, and the line stops being unverifiable.
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
    const e = addEnemy(s, 300, 300, 0 as Brad);
    e.maxShield = 4;
    e.shield = 2;
    const scene = new Scene(new Layers());
    scene.reconcile(s);
    expect(shellOf(scene.actorAt(e.id)!)!.intensity).toBeCloseTo(0.5, 6);
  });
});

// `render/weaponSkins` is mocked here so the "texture exists" branch is reachable
// under vitest (no art preloaded in a plain-node run) — same convention as
// Pickup.test.ts's own mock of the same module.
const weaponSkinMocks = vi.hoisted(() => ({ texture: undefined as unknown }));
vi.mock('../../render/weaponSkins', () => ({
  getWeaponTexture: (name: string | undefined) => (name === 'blaster' ? weaponSkinMocks.texture : undefined),
}));

describe('Scene.reconcile — weapon pickup id passthrough (design/03)', () => {
  it('passes the PickupItem.weaponId through to the Pickup view (real icon, not the chevron fallback)', async () => {
    const { Texture, TextureSource } = await import('pixi.js');
    weaponSkinMocks.texture = new Texture({ source: new TextureSource({ width: 8, height: 8 }) });
    try {
      const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
      const it: PickupItem = {
        id: s.nextId(), kind: 'weapon', gx: pxToFp(300), gy: pxToFp(300),
        spawnTick: 0, alive: true, weaponId: 'blaster',
      };
      s.pickups.push(it);
      const scene = new Scene(new Layers());
      scene.reconcile(s);

      const views = (scene as unknown as { views: Map<number, { children: unknown[] }> }).views;
      const view = views.get(it.id)!;
      // The claim is "the id reached the view and resolved a real texture", so assert THAT —
      // the drop's child count also moves whenever the drop gains a layer (it gained the
      // rarity/element overlays in 2026-08-25), and a count would fail for the wrong reason.
      const { Sprite } = await import('pixi.js');
      const icon = view.children.find((c): c is InstanceType<typeof Sprite> => c instanceof Sprite);
      expect(icon).toBeDefined();
      expect(icon!.texture).toBe(weaponSkinMocks.texture);
    } finally {
      weaponSkinMocks.texture = undefined;
    }
  });

  it('falls back to the chevron shape when the pickup has no weaponId', () => {
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
    const it: PickupItem = {
      id: s.nextId(), kind: 'weapon', gx: pxToFp(300), gy: pxToFp(300),
      spawnTick: 0, alive: true,
    };
    s.pickups.push(it);
    const scene = new Scene(new Layers());
    scene.reconcile(s);

    const views = (scene as unknown as { views: Map<number, { children: unknown[] }> }).views;
    expect(views.get(it.id)!.children.length).toBe(2); // glow + chevron, no icon sprite
  });
});

describe('Scene.reconcile — pickup hover phase passthrough (strobe fix, 2026-08-15)', () => {
  // Pickup derives its hover's start phase from the engine id it is handed, so a pile of
  // drops doesn't rise and fall in lockstep (which is what made a whole floor of loot read
  // as one flicker). That only works if reconcile actually passes the id down — forgetting
  // it silently defaults every view to phase 0, i.e. right back to lockstep.
  it('gives drops reconciled from the same state different hover phases', () => {
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
    const items = [addPickup(s, 300, 300), addPickup(s, 340, 300), addPickup(s, 380, 300)];
    const scene = new Scene(new Layers());
    scene.reconcile(s);

    const views = (scene as unknown as { views: Map<number, Entity> }).views;
    const heights = items.map((it) => {
      const v = views.get(it.id)!;
      v.interpolate(1, 16);
      return Math.round((v.curY - v.y) * 100) / 100; // hover height (Entity writes y = groundY - z)
    });
    expect(new Set(heights).size).toBe(heights.length);
  });
});

/**
 * `Scene.refreshQuality` (render/quality.ts, 2026-08-25) — a tier change has to reach actors
 * that already exist.
 *
 * An actor's filter list is otherwise only recomposed when that actor's own status changes, so
 * without this a player standing still with a shield up, or an enemy mid-burn, would keep
 * whichever list the PREVIOUS tier produced. Both loops matter and are asserted separately: the
 * live views and the `dying` list, which is deliberately kept out of `views`.
 */
describe('Scene.refreshQuality', () => {
  afterEach(() => resetActiveQuality());

  it('recomposes a live actor that already has an effect up', () => {
    setActiveQuality('high');
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
    const p = s.players[0]!;
    p.maxShield = 100;
    p.shield = 100;
    const scene = new Scene(new Layers());
    scene.reconcile(s, p.id);
    const view = scene.player!;
    expect(skinFiltersOf(view)).toHaveLength(1); // premise: the shell is mounted

    setActiveQuality('low');
    scene.refreshQuality();
    expect(skinFiltersOf(view)).toEqual([]);
  });

  it('reaches an actor that is already playing its death animation', () => {
    setActiveQuality('high');
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
    const e = addEnemy(s, 200, 200, 0 as Brad);
    const scene = new Scene(new Layers());
    scene.reconcile(s, s.players[0]!.id);
    // Kill it: reconcile moves the view out of `views` and into `dying`, dissolving.
    s.enemies.length = 0;
    scene.reconcile(s, s.players[0]!.id);
    const dying = (scene as unknown as { dying: Actor[] }).dying;
    expect(dying).toHaveLength(1);
    expect(skinFiltersOf(dying[0]!)).toHaveLength(1);
    void e;

    setActiveQuality('low');
    scene.refreshQuality();
    // The dissolve shader is gone and the alpha fade has taken over — the case where the two
    // tiers differ most, and the one a `views`-only loop would miss entirely.
    expect(skinFiltersOf(dying[0]!)).toEqual([]);
    expect((dying[0]! as unknown as { skin: { view: { alpha: number } } }).skin.view.alpha).toBe(1);
    dying[0]!.interpolate(1, 350);
    expect((dying[0]! as unknown as { skin: { view: { alpha: number } } }).skin.view.alpha).toBeCloseTo(0.5, 1);
  });
});

/**
 * The two LIFECYCLE edges `Scene` owns (2026-09-02) — the halves of the animation vocabulary
 * that have no engine event to hang off. `hurt` and `attack` arrive as events and are
 * `EventReactor`'s business; spawning and dying are diffs of `GameState`'s own entity arrays,
 * which is a thing only this file computes. Both are one line, and both are the only thing
 * standing between the engine and a clip that has never played.
 *
 * Driven through the real `Scene.reconcile` rather than by calling `Actor` directly, because the
 * claim is about WHERE in the diff each edge is, not about what the actor then does.
 */
describe('Scene.reconcile — the spawn/death edges reach the actor view', () => {
  /** Spy on every `Actor` the scene builds, without importing Actor into the assertion: the two
   *  methods are recorded on the instance the moment it appears in `views`. */
  const calls = (scene: Scene, id: number): string[] => {
    const v = (scene as unknown as { views: Map<number, unknown> }).views.get(id) as
      { __log?: string[] } | undefined;
    return v?.__log ?? [];
  };
  const instrument = (scene: Scene, id: number): void => {
    const v = (scene as unknown as { views: Map<number, Record<string, unknown>> }).views.get(id)!;
    const log: string[] = [];
    v.__log = log;
    for (const m of ['onSpawn', 'onDeath']) {
      const real = v[m] as () => void;
      v[m] = (): void => { log.push(m); real.call(v); };
    }
  };

  it('a brand-new id gets onSpawn, exactly once, on the tick it first appears', () => {
    // Spied on the PROTOTYPE rather than on an instance, because the view does not exist to
    // instrument until the reconcile that creates it — which is the whole point of this edge.
    // `Enemy extends Actor` and does not override it, so one spy covers both factions.
    const spy = vi.spyOn(Actor.prototype, 'onSpawn');
    try {
      const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
      addEnemy(s, 300, 300, 0 as Brad);
      const scene = new Scene(new Layers());
      scene.reconcile(s);
      expect(spy).toHaveBeenCalledTimes(2); // the player seat and the enemy
      // ...and NOT again on every later tick, which would restart the materialise every frame.
      scene.reconcile(s);
      scene.reconcile(s);
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });

  it('an id that drops out of the alive list gets onDeath, not a bare destroy', () => {
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
    const enemy = addEnemy(s, 300, 300, 0 as Brad);
    const scene = new Scene(new Layers());
    scene.reconcile(s);
    instrument(scene, enemy.id);
    const log = calls(scene, enemy.id);
    enemy.alive = false;
    scene.reconcile(s);
    expect(log).toEqual(['onDeath']);
  });

  it('the player seat gets both edges too, not just enemies', () => {
    // Every clip in the vocabulary is authored for all seven bundles including the three
    // characters, and a player death is the one every run ends on.
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
    const scene = new Scene(new Layers());
    scene.reconcile(s);
    const id = s.players[0]!.id;
    instrument(scene, id);
    const log = calls(scene, id);
    s.players[0]!.alive = false;
    scene.reconcile(s);
    expect(log).toEqual(['onDeath']);
  });

  it('a bullet or a pickup appearing gets neither — they have no clips at all', () => {
    // `Scene.spawn` is shared by every view type, so the Actor guard on that line is load-
    // bearing: a `Bullet` has no `onSpawn` and calling one would throw on the first shot fired.
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
    addBullet(s, 200, 200);
    addPickup(s, 250, 250);
    const scene = new Scene(new Layers());
    expect(() => scene.reconcile(s)).not.toThrow();
    expect((scene as unknown as { views: Map<number, unknown> }).views.size).toBe(3);
  });
});

/**
 * The two facts about a DYING view that the death clip made load-bearing (2026-09-02). Both are
 * about the second, separate list `Scene` keeps: a view whose id has gone is out of `views` but
 * still being interpolated, and the two halves of that have opposite requirements — it must keep
 * receiving frames (so its collapse plays) and must NOT be findable by an event reaction (so a
 * corpse is never flinched).
 */
describe('Scene — a dying view keeps its frames but leaves the lookup', () => {
  const killOne = (): { scene: Scene; id: number } => {
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
    const enemy = addEnemy(s, 300, 300, 0 as Brad);
    const scene = new Scene(new Layers());
    scene.reconcile(s);
    enemy.alive = false;
    scene.reconcile(s);
    return { scene, id: enemy.id };
  };

  it('keeps handing a dying view its frame dt, so the collapse clip plays out', () => {
    // The dying list is a SECOND interpolation loop, and the `death` clip's clock is driven by the
    // frame dt `Actor.interpolate` forwards to its skin (`Skin.setFacing`'s third argument ->
    // `RigSkin.advanceClips`). A dying view that stopped receiving one would freeze mid-collapse
    // and then vanish anyway when the DISSOLVE clock — a different clock, ticked by
    // `ActorFilters` — ran out: a corpse that stops falling but still disappears on cue.
    const { scene } = killOne();
    const dying = (scene as unknown as { dying: Actor[] }).dying;
    expect(dying).toHaveLength(1);
    const skin = (dying[0] as unknown as { skin: { setFacing: (...a: unknown[]) => void } }).skin;
    const spy = vi.spyOn(skin, 'setFacing');

    scene.interpolate(1, 16);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![2], 'the frame dt, not 0 — a 0 would freeze every clip clock').toBe(16);
  });

  it('drops it out of actorAt the same tick, so no event reaction can reach a corpse', () => {
    // `GameLoop` reconciles before it consumes the tick's events (asserted in its own suite), so
    // this is what a KILLING blow's `hit` finds when it reaches `EventReactor`: nothing. That is
    // the mechanism, and it is why `rigClipLayer`'s "a corpse does not flinch" rule is defence at
    // the layer that owns it rather than a guard on a live case. If `actorAt` is ever widened to
    // search the dying list, that guard becomes the only thing holding the line.
    const { scene, id } = killOne();
    expect(scene.actorAt(id), 'a dying view must not be reachable by id').toBeUndefined();
    // ...while still very much alive as a VIEW, which is the whole point of the two lists.
    expect((scene as unknown as { dying: Actor[] }).dying).toHaveLength(1);
    expect((scene as unknown as { views: Map<number, unknown> }).views.has(id)).toBe(false);
  });

  it('a dying enemy also leaves the x-ray focus list, and for the same reason', () => {
    // `enemies` is `instanceof Enemy` over `views` — same mechanism, and worth stating beside the
    // one above because both are "the dying list is not the live list" and a future refactor that
    // merged them would break the corpse rule silently while looking like a simplification.
    const { scene } = killOne();
    expect(scene.enemies).toHaveLength(0);
  });
});

/**
 * `spawnedActors` — the `spawn` cue's entire trigger (design/11, 2026-09-02). There is no
 * `spawn` event: an id appearing in `GameState` is a diff, and this class is the only thing
 * that computes diffs. So the count it reports is the whole signal, and every case below is
 * a way that count can lie without anything else looking wrong.
 */
describe('Scene.spawnedActors — the spawn cue has no event behind it', () => {
  it('counts the actor views built by this reconcile', () => {
    const s = createGameState(CFG);
    addEnemy(s, 100, 100, 0 as Brad);
    addEnemy(s, 140, 100, 0 as Brad);
    const scene = new Scene(new Layers());
    scene.reconcile(s, s.players[0]!.id);
    expect(scene.spawnedActors).toBe(3); // the seat + two mobs
  });

  it('reports ZERO on the next reconcile, when nothing new appeared', () => {
    // The failure this pins is an accumulator instead of a per-call count: it would play a
    // spawn cue on every frame of the run, growing louder, and only the ear would notice.
    const s = createGameState(CFG);
    addEnemy(s, 100, 100, 0 as Brad);
    const scene = new Scene(new Layers());
    scene.reconcile(s, s.players[0]!.id);
    scene.reconcile(s, s.players[0]!.id);
    expect(scene.spawnedActors).toBe(0);
  });

  it('counts a wave that arrives mid-run, and only the new members of it', () => {
    const s = createGameState(CFG);
    const scene = new Scene(new Layers());
    scene.reconcile(s, s.players[0]!.id); // the seat
    addEnemy(s, 100, 100, 0 as Brad);
    addEnemy(s, 140, 100, 0 as Brad);
    addEnemy(s, 180, 100, 0 as Brad);
    scene.reconcile(s, s.players[0]!.id);
    expect(scene.spawnedActors).toBe(3);
  });

  it('ignores bullets and pickups — only a body has a spawn clip to match', () => {
    // Bullets are the highest-volume view in the game. Counting them would turn `spawn` into
    // a second, louder `muzzle` that fires on the wrong frame.
    const s = createGameState(CFG);
    const scene = new Scene(new Layers());
    scene.reconcile(s, s.players[0]!.id);
    addBullet(s, 50, 50);
    addBullet(s, 60, 50);
    addPickup(s, 70, 50);
    scene.reconcile(s, s.players[0]!.id);
    expect(scene.spawnedActors).toBe(0);
  });

  it('counts again after clear(), because every view really is rebuilt', () => {
    // `clear()` drops every view before a new run's engine is created, so the next reconcile
    // legitimately materialises the whole cast — and it should sound like it.
    const s = createGameState(CFG);
    addEnemy(s, 100, 100, 0 as Brad);
    const scene = new Scene(new Layers());
    scene.reconcile(s, s.players[0]!.id);
    scene.clear();
    scene.reconcile(s, s.players[0]!.id);
    expect(scene.spawnedActors).toBe(2);
  });
});

/**
 * Chests (design/05 "Chest rooms", ENGINE_VERSION 63) are drawn by `ChestLayer`, which
 * `ChestLayer.test.ts` covers in isolation. What that file cannot cover is the WIRING: the
 * layer is owned here rather than plumbed through `GameLoop`, so if `reconcile` stopped
 * calling it, or `clear()` stopped tearing it down, every one of those tests would stay green
 * while a live run drew no chests at all — or drew the previous run's.
 */
describe('Scene.reconcile — chests are mirrored, and swept by clear()', () => {
  const addChest = (s: GameState, kind: 'small' | 'big', plates: number) => {
    s.chests.push({
      id: s.nextChestId(),
      roomId: 'r1',
      kind,
      gx: pxToFp(200),
      gy: pxToFp(150),
      mechanisms: Array.from({ length: plates }, (_, i) => ({ gx: pxToFp(200 + 32 * i), gy: pxToFp(150), occupied: false })),
      opened: false,
    });
  };

  it('draws a chest body into the Y-sorted entity layer and its plates into the ground layer', () => {
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
    const layers = new Layers();
    const scene = new Scene(layers);

    scene.reconcile(s, s.players[0]!.id);
    const entitiesBefore = layers.entities.children.length;
    const groundBefore = layers.ground.children.length;

    addChest(s, 'big', 2);
    scene.reconcile(s, s.players[0]!.id);

    expect(layers.entities.children.length).toBe(entitiesBefore + 1);
    expect(layers.ground.children.length).toBe(groundBefore + 1);
  });

  it('drops the chest views on clear(), which is what a new run relies on', () => {
    // `clear()` runs before a new engine is created. The two layers a chest draws into are not
    // swept by anything else, so a chest left mounted here would hang over the next run.
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
    const layers = new Layers();
    const scene = new Scene(layers);
    addChest(s, 'big', 2);
    scene.reconcile(s, s.players[0]!.id);
    expect(layers.entities.children.length).toBeGreaterThan(0);
    expect(layers.ground.children.length).toBeGreaterThan(0); // the premise for the sweep below

    scene.clear();
    expect(layers.entities.children.length).toBe(0);
    expect(layers.ground.children.length).toBe(0);
  });
});

/**
 * The collected-drop flight (`scene/pickupFlight.ts`), from this class's side: WHICH removals
 * become a flight, and what the arc is aimed at. The curve itself is `pickupFlight.test.ts`.
 *
 * The load-bearing test here is the one that asserts an ABSENCE — a floor teardown removes
 * every uncollected drop with no `pickup` event behind it, and a flight launched off the state
 * diff alone would fling a whole floor's loot at the player on every descend.
 */
describe('Scene.reconcile — a collected drop flies to whoever took it', () => {
  function collected(byId: number, xpx = 300, ypx = 300): GameEvent {
    return { type: 'pickup', kind: 'material', by: byId, gx: pxToFp(xpx), gy: pxToFp(ypx), materialId: 'fire', qty: 1 };
  }

  /** Flights are mounted into `layers.entities` but deliberately kept out of `Scene.views`
   *  (they mirror no engine entity any more), so the difference between the two counts is
   *  exactly what is in the air. */
  function inFlight(scene: Scene, layers: Layers): Pickup[] {
    const views = new Set((scene as unknown as { views: Map<number, Entity> }).views.values());
    return layers.entities.children.filter((c) => c instanceof Pickup && !views.has(c)) as Pickup[];
  }

  it('launches one flight for the collected drop, carrying the same kind', () => {
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
    const p = s.players[0]!;
    const layers = new Layers();
    const scene = new Scene(layers);
    const item = addPickup(s, 300, 300);
    scene.reconcile(s, p.id);
    expect(inFlight(scene, layers).length).toBe(0); // on the floor, not in the air

    item.alive = false;
    scene.reconcile(s, p.id, [collected(p.id)]);
    const flying = inFlight(scene, layers);
    expect(flying.length).toBe(1);
    expect(flying[0]!.kind).toBe('material');
  });

  it('launches NOTHING when a drop leaves state with no pickup event — a floor teardown is not a collection', () => {
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
    const p = s.players[0]!;
    const layers = new Layers();
    const scene = new Scene(layers);
    const item = addPickup(s, 300, 300);
    scene.reconcile(s, p.id);

    item.alive = false;
    scene.reconcile(s, p.id); // the descend/room-change path: view gone, no event
    expect(inFlight(scene, layers).length).toBe(0);
  });

  it('launches nothing when the collector has no view — an arc with no body on the end says nothing', () => {
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
    const layers = new Layers();
    const scene = new Scene(layers);
    addPickup(s, 300, 300);
    scene.reconcile(s, s.players[0]!.id);

    scene.reconcile(s, s.players[0]!.id, [collected(9999)]); // an id this scene never mirrored
    expect(inFlight(scene, layers).length).toBe(0);
  });

  it('ARRIVES on the collector\'s body: it ends over their ground point, above their feet', () => {
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
    const p = s.players[0]!;
    const layers = new Layers();
    const scene = new Scene(layers);
    scene.reconcile(s, p.id, [collected(p.id, 300, 300)]);
    const drop = inFlight(scene, layers)[0]!;
    // It starts where the loot lay (300, 300) — a long way from the player at (100, 100), which
    // is what makes the arrival below an arc across the room rather than a nudge.
    expect(drop.x).toBeCloseTo(300, 3);
    expect(Math.hypot(drop.x - scene.player!.x, drop.y - scene.player!.y)).toBeGreaterThan(50);

    scene.interpolate(1, FLIGHT_MS * 0.99);
    const body = scene.player!;
    expect(Math.abs(drop.x - body.x)).toBeLessThan(6);
    // Up at the BODY, not at the ground point — loot flying into a character's feet reads as
    // dropping in front of them. Measured as a fraction of the drawn body rather than in px,
    // because the same 10 px that is a chest on a mob is an ankle on a boss. A bare "higher than
    // the feet" bound is NOT enough and this is measured, not assumed: with the target moved to
    // the feet the drop is still on its way down out of the hop when it arrives, so the old
    // assertion passed and the mutant lived.
    const bodyH = body.bodySilhouette.bodyH;
    expect(body.y - drop.y).toBeGreaterThan(bodyH * 0.3);
    expect(body.y - drop.y).toBeLessThan(bodyH); // and not sailing over their head
  });

  it('carries the WEAPON it is of — a flown gun is that gun, not a generic loot icon', () => {
    // `Pickup` resolves `weaponId` into the weapon's own art plus design/13's two channels (the
    // rarity pips and the element badge). Dropping the id on the way into the flight leaves the
    // chevron fallback, which is the same silhouette for every gun in the game. Compared against
    // a reference view rather than against a child count spelled out here, so the assertion
    // cannot drift away from whatever the constructor actually builds.
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
    const p = s.players[0]!;
    const layers = new Layers();
    const scene = new Scene(layers);
    scene.reconcile(s, p.id, [{
      type: 'pickup', kind: 'weapon', by: p.id, weaponId: 'repeater', gx: pxToFp(300), gy: pxToFp(300),
    }]);

    const flown = inFlight(scene, layers)[0]!;
    const withId = new Pickup('weapon', 'repeater');
    const withoutId = new Pickup('weapon');
    // The premise: those two really are different objects, so the match below cannot pass
    // vacuously if `Pickup` ever stops caring about the id.
    expect(withId.children.length).not.toBe(withoutId.children.length);
    expect(flown.children.length).toBe(withId.children.length);
  });

  it('flies to the COLLECTOR in co-op, not to the seat this client is playing', () => {
    // The entire reason `pickup.by` was added. In single-player every wrong answer coincides with
    // the right one, so this is the only shape that tells them apart: two seats far apart, the
    // LOCAL one is seat A, and seat B takes the drop.
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }, { start: [500, 420] }] });
    const [a, b] = [s.players[0]!, s.players[1]!];
    const layers = new Layers();
    const scene = new Scene(layers);
    scene.reconcile(s, a.id, [collected(b.id, 300, 300)]);

    scene.interpolate(1, FLIGHT_MS * 0.99);
    const drop = inFlight(scene, layers)[0]!;
    const mate = scene.actorAt(b.id)!;
    const me = scene.actorAt(a.id)!;
    // The absolute bound is loose on purpose, and the RATIO is what this test is actually
    // about. Most of the 20-odd px is the collector's own chest height (the arc ends on the
    // BODY, which the "ARRIVES on the collector's body" case above pins exactly) plus the tail
    // of the arc, and that tail moved when the flight gained its acceleration — a drop that now
    // crosses the last stretch at ~790 px/s is a few px further out at t = 0.99 than one that
    // used to crawl in. Neither number can be confused with 400 px of "flew to the wrong seat".
    const toMate = Math.hypot(drop.x - mate.x, drop.y - mate.y);
    const toMe = Math.hypot(drop.x - me.x, drop.y - me.y);
    expect(toMate).toBeLessThan(30);
    expect(toMe).toBeGreaterThan(100);
    expect(toMate).toBeLessThan(toMe / 4);
  });

  it('bows two simultaneous drops to OPPOSITE sides — a chest payout is not one stack of arcs', () => {
    // `Scene` derives the bow's side from the drop's own position, because a `pickup` event
    // carries no item id to spread it by. Two drops one px apart in x therefore land on opposite
    // parities, and the tilt is where that reads whichever way either one is travelling.
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
    const p = s.players[0]!;
    const layers = new Layers();
    const scene = new Scene(layers);
    scene.reconcile(s, p.id, [collected(p.id, 300, 300), collected(p.id, 301, 300)]);

    scene.interpolate(1, FLIGHT_MS * 0.5);
    const [one, two] = inFlight(scene, layers);
    expect(one!.rotation * two!.rotation).toBeLessThan(0); // opposite signs, and neither is 0
  });

  it('is destroyed on arrival, and swept by clear() if a run ends mid-flight', () => {
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
    const p = s.players[0]!;
    const layers = new Layers();
    const scene = new Scene(layers);
    scene.reconcile(s, p.id, [collected(p.id)]);
    expect(inFlight(scene, layers).length).toBe(1);
    scene.interpolate(1, FLIGHT_MS);
    expect(inFlight(scene, layers).length).toBe(0);

    scene.reconcile(s, p.id, [collected(p.id)]);
    expect(inFlight(scene, layers).length).toBe(1);
    scene.clear();
    expect(layers.entities.children.length).toBe(0);
  });
});
