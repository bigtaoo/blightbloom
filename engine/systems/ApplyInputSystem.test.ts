/**
 * ApplyInputSystem's facing logic (design/10, aim removal v33): there is no manual
 * aim input anymore. Every tick a player faces the nearest hostile if one exists
 * (any distance), else the direction it's moving, else it holds last tick's facing.
 */
import { describe, it, expect } from 'vitest';
import { toFp } from '@dd/engine/math/fixed';
import type { Brad } from '@dd/engine/math/trig';
import { atan2Brad, BRAD_HALF, BRAD_QUARTER } from '@dd/engine/math/trig';
import { createGameState } from '@dd/engine/state/GameState';
import type { GameState } from '@dd/engine/state/GameState';
import { ENEMY_TEAM_ID, type EnemyActor } from '@dd/engine/state/entities';
import { makeCommand } from '@dd/engine/state/input';
import { freshStatus } from '@dd/engine/content/damage';
import { BASIC_ENEMY } from '@dd/engine/content/enemies';
import { pxToFp } from '@dd/engine/content/convert';
import { ApplyInputSystem } from '@dd/engine/systems';

const CFG = { seed: 1, worldW: 1600, worldH: 1200, waves: [] as const };

function state(): GameState {
  return createGameState(CFG);
}

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

describe('ApplyInputSystem — facing (no manual aim, design/10 v33)', () => {
  it('faces the nearest hostile, overriding the movement direction', () => {
    const s = state();
    const p = s.players[0]!;
    const e = addEnemy(s, 900, 700); // off to the side, not directly ahead
    // Player moves due west while an enemy sits to the northeast — facing must lock
    // onto the enemy, not the direction of travel.
    new ApplyInputSystem().tick(s, [makeCommand({ owner: 0, tick: 1, moveBrad: BRAD_HALF as Brad, moveMag: 255, buttons: 0 })]);
    expect(p.facing).toBe(atan2Brad(e.gy - p.gy, e.gx - p.gx));
    expect(p.facing).not.toBe(BRAD_HALF);
  });

  it('faces the movement direction when no hostile exists', () => {
    const s = state();
    const p = s.players[0]!;
    new ApplyInputSystem().tick(s, [makeCommand({ owner: 0, tick: 1, moveBrad: BRAD_QUARTER as Brad, moveMag: 255, buttons: 0 })]);
    expect(p.facing).toBe(BRAD_QUARTER);
  });

  it('holds last tick\'s facing when idle with no hostile', () => {
    const s = state();
    const p = s.players[0]!;
    const sys = new ApplyInputSystem();
    // Tick 1: establish a facing via movement.
    sys.tick(s, [makeCommand({ owner: 0, tick: 1, moveBrad: BRAD_QUARTER as Brad, moveMag: 255, buttons: 0 })]);
    expect(p.facing).toBe(BRAD_QUARTER);
    // Tick 2: stand still, no target — facing must not reset.
    sys.tick(s, [makeCommand({ owner: 0, tick: 2, moveBrad: 0 as Brad, moveMag: 0, buttons: 0 })]);
    expect(p.facing).toBe(BRAD_QUARTER);
  });

  it('a dead player\'s own facing is untouched (idle path never writes it)', () => {
    const s = state();
    const p = s.players[0]!;
    p.facing = BRAD_QUARTER as Brad;
    p.alive = false;
    new ApplyInputSystem().tick(s, [makeCommand({ owner: 0, tick: 1, moveBrad: 0 as Brad, moveMag: 0, buttons: 0 })]);
    expect(p.facing).toBe(BRAD_QUARTER);
  });
});

describe('ApplyInputSystem — pickupTargetId passthrough (design/03, ENGINE_VERSION 32)', () => {
  it('copies this tick\'s command pickupTargetId onto the player, unmodified', () => {
    const s = state();
    const p = s.players[0]!;
    new ApplyInputSystem().tick(s, [makeCommand({ owner: 0, tick: 1, moveBrad: 0 as Brad, moveMag: 0, buttons: 0, pickupTargetId: 42 })]);
    expect(p.pickupTargetId).toBe(42);
  });

  it('defaults to 0 (no click) when the command omits it', () => {
    const s = state();
    const p = s.players[0]!;
    new ApplyInputSystem().tick(s, [makeCommand({ owner: 0, tick: 1, moveBrad: 0 as Brad, moveMag: 0, buttons: 0 })]);
    expect(p.pickupTargetId).toBe(0);
  });

  it('resets to 0 on an idle tick (no command) — a one-shot click never lingers', () => {
    const s = state();
    const p = s.players[0]!;
    const sys = new ApplyInputSystem();
    sys.tick(s, [makeCommand({ owner: 0, tick: 1, moveBrad: 0 as Brad, moveMag: 0, buttons: 0, pickupTargetId: 7 })]);
    expect(p.pickupTargetId).toBe(7);
    sys.tick(s, []); // no command this tick → idle path
    expect(p.pickupTargetId).toBe(0);
  });

  it('a dead player is idled, clearing pickupTargetId even though a command targeted them', () => {
    const s = state();
    const p = s.players[0]!;
    p.pickupTargetId = 7;
    p.alive = false;
    new ApplyInputSystem().tick(s, [makeCommand({ owner: 0, tick: 1, moveBrad: 0 as Brad, moveMag: 0, buttons: 0, pickupTargetId: 99 })]);
    expect(p.pickupTargetId).toBe(0); // dead/downed → idle(), same as firing/confirmExtract/confirmDescend
  });
});
