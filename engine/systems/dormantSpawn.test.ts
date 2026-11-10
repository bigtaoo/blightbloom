/**
 * Dormant room spawns (ENGINE_VERSION 92): a spawn point marked `dormant` gives its enemy a
 * short perception radius (`DORMANT_AGGRO_RANGE_FP`, 5 grid) and `wakeOnHurt`, so the first
 * room can hold mobs on screen that wait for the player to walk up or shoot.
 *
 * Each property is asserted against a control in the same room — a plain spawn — because a
 * dormant mob that stays asleep proves nothing if a plain one at the same distance would too.
 */
import { describe, it, expect } from 'vitest';
import { createGameEngine, type GameEngine } from '@dd/engine/GameEngine';
import { makeCommand } from '@dd/engine/state/input';
import type { Brad } from '@dd/engine/math/trig';
import type { Fp } from '@dd/engine/math/fixed';
import type { EngineConfig } from '@dd/engine/state/GameState';
import type { EnemyActor } from '@dd/engine/state/entities';
import type { RoomPiece, SpawnPoint } from '@dd/engine/content/rooms';
import type { DungeonConfig } from '@dd/engine/world/dungeon';
import { DEFAULT_ENEMY_AGGRO_RANGE_FP, DORMANT_AGGRO_RANGE_FP } from '@dd/engine/content/enemies';
import { toFpGrid } from '@dd/engine/content/convert';
import { takeDamage } from './combat';

const idle = (tick: number) => makeCommand({ owner: 0, tick, moveBrad: 0 as Brad, moveMag: 0, buttons: 0 });

/** A start room with the given enemy spawns, and an empty capstone after it. */
function engineWith(enemy: SpawnPoint[]): GameEngine {
  const start: RoomPiece = {
    id: 'start', tags: ['dz'], sizeGrid: { w: 20, h: 16 }, solids: [],
    spawns: { player: [{ x: 2, y: 8 }], enemy }, exits: [{ edge: 'east' }],
  };
  const cap: RoomPiece = {
    id: 'cap', role: 'boss', sizeGrid: { w: 20, h: 16 }, solids: [],
    spawns: { player: [{ x: 2, y: 8 }], enemy: [] }, exits: [{ edge: 'west' }],
  };
  const dungeon: DungeonConfig = {
    biomeId: 'dz', nameKey: 'dz', floorCount: 1, roomsPerFloor: { min: 2, max: 2 },
    pieceTags: ['dz'], layout: 'linear', extractionPieceId: 'cap', bossPieceId: 'cap',
    difficultyCurve: { base: 1, perFloor: 0 },
  };
  const cfg: EngineConfig = { seed: 7, worldW: 640, worldH: 640, waves: [], dungeon: { config: dungeon, library: [start, cap] } };
  return createGameEngine(cfg);
}

let tick = 0;
function run(eng: GameEngine, ticks: number): void {
  for (let i = 0; i < ticks; i++) eng.step([idle(++tick)]);
}

/** The live enemy authored at grid (x, y) — spawns land exactly on their point. */
function enemyAt(eng: GameEngine, x: number, y: number): EnemyActor {
  const room = eng.state.dungeonRooms[0]!;
  const gx = toFpGrid(x + room.offsetXGrid);
  const gy = toFpGrid(y + room.offsetYGrid);
  const e = eng.state.enemies.find((m) => m.alive && Math.abs(m.gx - gx) <= toFpGrid(0.5) && Math.abs(m.gy - gy) <= toFpGrid(0.5));
  expect(e, `no enemy at (${x},${y})`).toBeDefined();
  return e!;
}

describe('dormant spawn points', () => {
  it('give their enemy the short perception radius and wakeOnHurt; a plain spawn gets neither', () => {
    const eng = engineWith([{ x: 9, y: 4, type: 'basic', dormant: true }, { x: 17, y: 13, type: 'basic' }]);
    run(eng, 2);
    const sleeper = enemyAt(eng, 9, 4);
    const plain = enemyAt(eng, 17, 13);
    expect(sleeper.aggroRangeFp).toBe(DORMANT_AGGRO_RANGE_FP);
    expect(sleeper.wakeOnHurt).toBe(true);
    expect(plain.aggroRangeFp ?? DEFAULT_ENEMY_AGGRO_RANGE_FP).toBe(DEFAULT_ENEMY_AGGRO_RANGE_FP);
    expect(plain.wakeOnHurt).toBeUndefined();
  });

  it('sleeps through an idle player 6.5 grid away, where a plain mob at the same distance wakes', () => {
    // (8.5, 2) and (8.5, 14) are both 6.5 grid from the spawn at (2, 8): inside the default
    // 10-grid radius, outside the dormant 5-grid one.
    const eng = engineWith([{ x: 8.5, y: 2, type: 'basic', dormant: true }, { x: 8.5, y: 14, type: 'basic' }]);
    run(eng, 120);
    const sleeper = enemyAt(eng, 8.5, 2);
    expect(sleeper.aggroed).toBe(false);
    expect(sleeper.firing).toBe(false);
    // The control: the same distance wakes a plain mob, so the sleeper's state is the flag's doing.
    expect(eng.state.enemies.some((m) => m.alive && m !== sleeper && m.aggroed)).toBe(true);
  });

  it('wakes when the player walks inside its radius', () => {
    const eng = engineWith([{ x: 9, y: 8, type: 'basic', dormant: true }]);
    run(eng, 30);
    const sleeper = enemyAt(eng, 9, 8);
    expect(sleeper.aggroed).toBe(false);
    const p = eng.state.players[0]!;
    p.gx = (sleeper.gx - toFpGrid(4)) as Fp; // 4 grid away: inside 5
    p.gy = sleeper.gy;
    run(eng, 2);
    expect(sleeper.aggroed).toBe(true);
  });
});

describe('wakeOnHurt (takeDamage)', () => {
  it('a hit wakes a wakeOnHurt mob from any distance; it does not wake a plain one', () => {
    // Both far from the player (11+ grid) so only the hit can explain a wake.
    const eng = engineWith([{ x: 15, y: 2, type: 'basic', dormant: true }, { x: 15, y: 14, type: 'basic' }]);
    run(eng, 2);
    const sleeper = enemyAt(eng, 15, 2);
    const plain = enemyAt(eng, 15, 14);
    expect([sleeper.aggroed, plain.aggroed]).toEqual([false, false]);
    takeDamage(eng.state, sleeper, 1, 'player', 'physical');
    takeDamage(eng.state, plain, 1, 'player', 'physical');
    expect(sleeper.aggroed).toBe(true);
    expect(plain.aggroed).toBe(false);
  });

  it('only a real hit from the player side wakes it: not a hazard, not enemy fire, not a 0', () => {
    const eng = engineWith([{ x: 15, y: 2, type: 'basic', dormant: true }]);
    run(eng, 2);
    const sleeper = enemyAt(eng, 15, 2);
    takeDamage(eng.state, sleeper, 1, 'environment', 'physical');
    takeDamage(eng.state, sleeper, 1, 'enemy', 'physical');
    takeDamage(eng.state, sleeper, 0, 'player', 'physical');
    expect(sleeper.aggroed).toBe(false);
    takeDamage(eng.state, sleeper, 1, 'player', 'physical'); // the control
    expect(sleeper.aggroed).toBe(true);
  });
});
