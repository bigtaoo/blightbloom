/**
 * Line of sight and the auto-aim target that uses it (ENGINE_VERSION 91, the 2026-11-07
 * first-run report: a new player's aim stuck on a foe behind a pillar while one in the open
 * shot back).
 */
import { describe, it, expect } from 'vitest';
import { toFp } from '@dd/engine/math/fixed';
import type { Fp } from '@dd/engine/math/fixed';
import type { Brad } from '@dd/engine/math/trig';
import { pxToFp } from '@dd/engine/content/convert';
import { createGameState, type GameState } from '@dd/engine/state/GameState';
import { ENEMY_TEAM_ID, type EnemyActor } from '@dd/engine/state/entities';
import { freshStatus } from '@dd/engine/content/damage';
import { BASIC_ENEMY } from '@dd/engine/content/enemies';
import { hasLineOfSight, segmentHitsRect } from '@dd/engine/systems/lineOfSight';
import { AIM_SIGHT_CHECKS, aimTarget, nearestHostile } from '@dd/engine/systems/targeting';
import { ApplyInputSystem } from '@dd/engine/systems/ApplyInputSystem';
import { atan2Brad } from '@dd/engine/math/trig';
import { makeCommand } from '@dd/engine/state/input';

const CFG = { seed: 23, worldW: 1600, worldH: 1200, waves: [] as const };

function addEnemy(s: GameState, xpx: number, ypx: number): EnemyActor {
  const e: EnemyActor = {
    id: s.nextId(), faction: 'enemy', teamId: ENEMY_TEAM_ID,
    gx: pxToFp(xpx), gy: pxToFp(ypx), z: toFp(0), vx: toFp(0), vy: toFp(0),
    knockVx: toFp(0), knockVy: toFp(0),
    facing: 0 as Brad, hp: BASIC_ENEMY.maxHp, maxHp: BASIC_ENEMY.maxHp, shield: 0, maxShield: 0,
    ticksSinceHit: 0, radius: BASIC_ENEMY.radius, footprintRadius: BASIC_ENEMY.footprintRadius, solidRadius: BASIC_ENEMY.radius,
    alive: true, weapon: null, firing: false, status: freshStatus(), enraged: false, armorBroken: false, aggroed: false, holding: false,
  };
  s.enemies.push(e);
  return e;
}

/** A wall rect given in px. */
function wallPx(s: GameState, x: number, y: number, w: number, h: number): void {
  s.walls.push({ x: pxToFp(x), y: pxToFp(y), w: pxToFp(w), h: pxToFp(h) });
}

describe('segmentHitsRect', () => {
  // The rect [10,20] x [10,20].
  const hit = (ax: number, ay: number, bx: number, by: number): boolean => segmentHitsRect(ax, ay, bx, by, 10, 10, 10, 10);

  it('a segment straight through it', () => expect(hit(0, 15, 30, 15)).toBe(true));
  it('a diagonal through it', () => expect(hit(0, 0, 30, 30)).toBe(true));
  it('a segment that stops short of it', () => expect(hit(0, 15, 9, 15)).toBe(false));
  it('a segment passing beside it', () => expect(hit(0, 25, 30, 25)).toBe(false));
  it('a diagonal that passes its corner on the outside', () => expect(hit(0, 9, 11, -2)).toBe(false));
  it('a segment ending inside it', () => expect(hit(0, 15, 15, 15)).toBe(true));
  it('a segment wholly inside it', () => expect(hit(12, 12, 18, 18)).toBe(true));
  it('a segment grazing an edge counts as blocked', () => expect(hit(0, 10, 30, 10)).toBe(true));
  it('a segment touching a corner counts as blocked', () => expect(hit(0, 0, 10, 10)).toBe(true));
  it('a vertical segment beside it, inside its x-bounding box but not y', () => expect(hit(15, 0, 15, 9)).toBe(false));
  it('a diagonal whose bounding box overlaps the rect but misses it', () => expect(hit(0, 18, 8, 30)).toBe(false));
  it('a zero-length segment is a point', () => {
    expect(hit(15, 15, 15, 15)).toBe(true);
    expect(hit(5, 5, 5, 5)).toBe(false);
  });
});

describe('hasLineOfSight', () => {
  it('is clear in an empty room', () => {
    const s = createGameState({ ...CFG, players: [{}] });
    expect(hasLineOfSight(s, pxToFp(100), pxToFp(100), pxToFp(500), pxToFp(500))).toBe(true);
  });

  it('is blocked by a wall between the two points, and not by one off to the side', () => {
    const s = createGameState({ ...CFG, players: [{}] });
    wallPx(s, 290, 0, 20, 300);
    expect(hasLineOfSight(s, pxToFp(100), pxToFp(100), pxToFp(500), pxToFp(100))).toBe(false);
    expect(hasLineOfSight(s, pxToFp(100), pxToFp(400), pxToFp(500), pxToFp(400))).toBe(true);
  });

  it('is blocked by a pillar between the two points, and not by one off to the side', () => {
    const s = createGameState({ ...CFG, players: [{}] });
    s.obstacles.push({ gx: pxToFp(300), gy: pxToFp(100), radius: pxToFp(20) as Fp });
    expect(hasLineOfSight(s, pxToFp(100), pxToFp(100), pxToFp(500), pxToFp(100))).toBe(false);
    expect(hasLineOfSight(s, pxToFp(100), pxToFp(200), pxToFp(500), pxToFp(200))).toBe(true);
  });
});

describe('aimTarget', () => {
  it('is null with nobody hostile', () => {
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
    expect(aimTarget(s, s.players[0]!)).toBeNull();
  });

  it('is the nearest when the nearest is in sight — the old rule, unchanged', () => {
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
    const near = addEnemy(s, 200, 100);
    addEnemy(s, 600, 100);
    expect(aimTarget(s, s.players[0]!)).toBe(near);
  });

  it('skips a nearer foe behind a wall for a farther one in the open', () => {
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
    const hidden = addEnemy(s, 300, 100);
    wallPx(s, 200, 50, 20, 100); // between the player and `hidden`
    const open = addEnemy(s, 100, 500); // farther, nothing in the way
    const self = s.players[0]!;
    expect(nearestHostile(s, self, self.gx, self.gy)).toBe(hidden); // the control
    expect(aimTarget(s, self)).toBe(open);
  });

  it('falls back to the nearest when every foe is out of sight', () => {
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
    const near = addEnemy(s, 300, 100);
    addEnemy(s, 400, 100);
    wallPx(s, 200, 0, 20, 300);
    expect(aimTarget(s, s.players[0]!)).toBe(near);
  });

  it(`checks only the ${AIM_SIGHT_CHECKS} nearest — a clear foe past them loses to the nearest`, () => {
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
    wallPx(s, 200, 0, 20, 400);
    const first = addEnemy(s, 300, 100);
    for (let i = 1; i < AIM_SIGHT_CHECKS; i++) addEnemy(s, 300 + i * 20, 100);
    addEnemy(s, 100, 900); // in the open, but the seventh nearest
    expect(aimTarget(s, s.players[0]!)).toBe(first);
  });

  it('breaks an exact tie by array order, as nearestHostile does', () => {
    const s = createGameState({ ...CFG, players: [{ start: [800, 600] }] });
    const west = addEnemy(s, 768, 600);
    addEnemy(s, 832, 600);
    expect(aimTarget(s, s.players[0]!)).toBe(west);
  });

  it('is what ApplyInputSystem faces', () => {
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
    addEnemy(s, 300, 100);
    wallPx(s, 200, 50, 20, 100);
    const open = addEnemy(s, 100, 500);
    const p = s.players[0]!;
    new ApplyInputSystem().tick(s, [makeCommand({ owner: 0, tick: 1, moveBrad: 0 as Brad, moveMag: 0, buttons: 0 })]);
    expect(p.facing).toBe(atan2Brad(open.gy - p.gy, open.gx - p.gx));
  });
});
