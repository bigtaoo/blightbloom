/**
 * chapterTrial.ts + reportChapter.ts + report.ts#entranceRoomStats — the chapter comparison's
 * dungeon builders and aggregation. The builders run over the REAL chapter catalog (they are
 * pure and cheap); the aggregation runs over hand-written rows, like `report.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { CHAPTERS, ENEMY_BLUEPRINTS } from '@dd/engine';
import { bossTrial, floorScale, floorTrial, runBossTrial, type BossTrialRun } from './chapterTrial';
import { bossTrialStats, depthStats, floorTrialStats, formatBossTrialTable, formatDepthTable, formatFloorTrialTable } from './reportChapter';
import { entranceRoomStats } from './report';
import type { RoomEncounter, RunMetrics } from './levelSim';

function enc(over: Partial<RoomEncounter> = {}): RoomEncounter {
  return { floorIndex: 0, roomId: 'r1_cell', activatedTick: 1, clearedTick: 300, garrison: 8, reactionTicks: 60, peakShooters: 2, damageTaken: 3, ...over };
}

function run(over: Partial<RunMetrics> = {}): RunMetrics {
  return {
    seed: 1,
    profileName: 'careful',
    skinId: 'vanguard',
    outcome: 'died',
    ticks: 900,
    floorReached: 0,
    endRoom: 'r1_cell',
    encounters: [enc()],
    enemiesKilled: 8,
    damageTaken: 10,
    peakBurstDamage: 4,
    effectiveHp: 10,
    lowestHpFrac: 0,
    drops: [],
    fires: [],
    killsByFloor: {},
    checkpointFloors: [],
    dryTicksByFloor: {},
    aliveTicksByFloor: {},
    energyRefillsTakenByFloor: {},
    finalMaxEnergy: 100,
    vitalsAtCheckpoint: [],
    roomsTotalByFloor: {},
    shopSnapshots: [],
    ...over,
  };
}

function trial(over: Partial<BossTrialRun> = {}): BossTrialRun {
  return { seed: 1, boss: 'glacimaw', run: run(), bossMaxHp: 85, ttkTicks: null, fightDamage: 10, effectiveHp: 10, bossHpLeftFrac: 0.5, chilledFrac: 0.4, playerDied: true, ...over };
}

describe('entranceRoomStats', () => {
  it('is the room every run opened FIRST, not the first floor-0 row by id', () => {
    // `b1_cache` sorts before `r1_cell` and is enemy-free — the row the old gate read.
    const runs = [run({ encounters: [enc(), enc({ roomId: 'b1_cache', garrison: 0, reactionTicks: null, activatedTick: 400, clearedTick: 400 })] })];
    const entrance = entranceRoomStats(runs);
    expect(entrance?.roomId).toBe('r1_cell');
    expect(entrance?.medianReactionTicks).toBe(60);
  });

  it('is undefined when no run opened a room', () => {
    expect(entranceRoomStats([run({ encounters: [] })])).toBeUndefined();
  });
});

describe('floorTrial / bossTrial builders', () => {
  it('a floor trial is one floor: the chapter floor map at that floor index, at its own scale or an override', () => {
    const t = floorTrial('frost', 2);
    expect(t.config.floorCount).toBe(1);
    expect(t.config.floorMaps?.[0]).toBe(CHAPTERS.frost.config.floorMaps?.[2]);
    expect(t.config.floorLayoutVariants).toBeUndefined();
    expect(t.config.difficultyCurve).toEqual({ base: floorScale('frost', 2), perFloor: 0 });
    expect(floorTrial('frost', 2, 1).config.difficultyCurve.base).toBe(1);
    expect(() => floorTrial('ember', 9)).toThrow(/no authored floor 9/);
  });

  it('a boss trial is the emptied room before the boss room plus the boss room, with the chosen boss', () => {
    const t = bossTrial({ room: 'ember', boss: 'glacimaw', adds: true });
    const map = t.config.floorMaps![0]!;
    expect(map.rooms).toHaveLength(2);
    expect(map.doors).toHaveLength(1);
    const piece = (id: string) => t.library.find((p) => p.id === id)!;
    const [ante, boss] = map.rooms.map((r) => piece(r.pieceId));
    expect(ante!.spawns.enemy).toEqual([]);
    const bossSpawns = boss!.spawns.enemy.filter((e) => e.type !== undefined && ENEMY_BLUEPRINTS[e.type]?.boss);
    expect(bossSpawns.map((e) => e.type)).toEqual(['glacimaw']);
    expect(boss!.spawns.enemy.some((e) => e.type === 'boss_random')).toBe(false);
    expect(boss!.spawns.enemy.length).toBeGreaterThan(1);
    // Last floor's scale of the room's chapter, unless `scaleOf` says otherwise.
    expect(t.config.difficultyCurve.base).toBe(floorScale('ember', 4));
    expect(bossTrial({ room: 'ember', boss: 'glacimaw', adds: true, scaleOf: 'frost' }).config.difficultyCurve.base).toBe(floorScale('frost', 4));
    // The library entries it replaced are untouched.
    expect(CHAPTERS.ember.library.find((p) => p.id === 'ember_l1_boss')!.spawns.enemy.some((e) => e.type === 'boss_random')).toBe(true);
  });

  it('without adds the boss room holds the boss alone', () => {
    const t = bossTrial({ room: 'frost', boss: 'pyrefang', adds: false });
    const bossPiece = t.library.find((p) => p.id === t.config.floorMaps![0]!.rooms[1]!.pieceId)!;
    expect(bossPiece.spawns.enemy.map((e) => e.type)).toEqual(['pyrefang']);
  });

  it('a boss duel really is fought: the boss spawns at its scaled HP and the run ends', () => {
    const t = runBossTrial(101, { room: 'frost', boss: 'glacimaw', adds: false });
    expect(t.bossMaxHp).toBe(Math.round(ENEMY_BLUEPRINTS.glacimaw!.maxHp * floorScale('frost', 4)));
    expect(t.run.outcome).not.toBe('timeout');
    expect(t.ttkTicks === null ? t.playerDied : t.bossHpLeftFrac === 0).toBe(true);
  });
});

describe('chapter report aggregation', () => {
  it('depthStats is the pass rate of the runs that REACHED each floor', () => {
    const rows = depthStats([run(), run({ floorReached: 1, checkpointFloors: [0] }), run({ floorReached: 2, checkpointFloors: [0, 1] })], 4);
    expect(rows.map((r) => [r.reached, r.checkpoint, r.passRate])).toEqual([
      [3, 2, 0.67],
      [2, 1, 0.5],
      [1, 0, 0],
      [0, 0, null],
    ]);
    expect(formatDepthTable({ ember: rows })).not.toContain('\nember    3');
  });

  it('floorTrialStats reads a clear off `extracted` and times only the clears', () => {
    const s = floorTrialStats([run({ outcome: 'extracted', ticks: 600 }), run({ outcome: 'died', ticks: 3000 }), run({ outcome: 'timeout' })]);
    expect(s).toMatchObject({ runs: 3, clearRate: 0.33, timeouts: 1, avgClearSec: 20 });
    expect(floorTrialStats([run()]).avgClearSec).toBeNull();
    expect(formatFloorTrialTable([{ chapter: 'frost', floorIndex: 0, scale: 1.125, stats: s }])).toContain('33%');
  });

  it('bossTrialStats separates kills from losses', () => {
    const s = bossTrialStats([
      trial({ ttkTicks: 600, bossHpLeftFrac: 0, playerDied: false, fightDamage: 4, chilledFrac: 0.2 }),
      trial({ ttkTicks: 900, bossHpLeftFrac: 0, playerDied: false, fightDamage: 6, chilledFrac: 0.4 }),
      trial({ bossHpLeftFrac: 0.3, chilledFrac: 0.6 }),
    ]);
    expect(s).toMatchObject({ runs: 3, bossMaxHp: 85, killRate: 0.67, deathRate: 0.33, medianTtkSec: 25, avgTtkSec: 25, avgHpLeftOnFail: 0.3, chilledPct: 40 });
    const none = bossTrialStats([trial()]);
    expect([none.medianTtkSec, none.avgTtkSec]).toEqual([null, null]);
    expect(formatBossTrialTable([{ label: 'x', stats: none }])).toContain('-/-');
  });
});
