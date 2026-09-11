/**
 * report.ts — the level simulator's aggregation + text rendering. Pure functions over
 * `RunMetrics`, so the fixtures below are hand-written metric rows rather than real
 * runs: what matters here is that the numbers the balance decisions are read off
 * (median reaction window, peak shooters, clear rate, death-room histogram) are
 * computed correctly, independently of whether a run happens to produce them.
 */
import { describe, expect, it } from 'vitest';
import {
  floorDropStats,
  floorFireStats,
  formatDropTable,
  formatFireTable,
  formatRoomTable,
  formatSummary,
  formatWeaponFireTable,
  median,
  roomStats,
  summarize,
  weaponFireStats,
} from './report';
import type { DropRecord, FireRecord, RoomEncounter, RunMetrics } from './levelSim';

function enc(over: Partial<RoomEncounter> = {}): RoomEncounter {
  return {
    floorIndex: 0,
    roomId: 'r1',
    activatedTick: 100,
    clearedTick: 400,
    garrison: 8,
    reactionTicks: 40,
    peakShooters: 2,
    damageTaken: 5,
    ...over,
  };
}

function run(over: Partial<RunMetrics> = {}): RunMetrics {
  return {
    seed: 1,
    profileName: 'careful',
    skinId: 'vanguard',
    outcome: 'died',
    ticks: 1000,
    floorReached: 0,
    endRoom: 'r1',
    encounters: [enc()],
    enemiesKilled: 8,
    damageTaken: 9,
    peakBurstDamage: 5,
    effectiveHp: 9.2,
    lowestHpFrac: 0.1,
    drops: [],
    fires: [],
    killsByFloor: { 0: 8 },
    checkpointFloors: [],
    dryTicksByFloor: {},
    aliveTicksByFloor: { 0: 1000 },
    energyRefillsTakenByFloor: {},
    finalMaxEnergy: 100,
    ...over,
  };
}

/** A trigger pull; `kind`, `bullets` and `weapon` are what the fire tables turn on.
 *  Defaults to a single-projectile ranged pull, i.e. the starter blaster. */
function fire(over: Partial<FireRecord> = {}): FireRecord {
  return { floorIndex: 0, kind: 'ranged', weapon: 'blaster', bullets: 1, energySpent: 3, tick: 200, ...over };
}

/** A drop record; `kind` and `floorIndex` are what every assertion below turns on. */
function drop(over: Partial<DropRecord> = {}): DropRecord {
  return { floorIndex: 0, roomId: 'r1', kind: 'material', tick: 200, ...over };
}

describe('median', () => {
  it('is null for an empty sample', () => {
    expect(median([])).toBeNull();
  });

  it('takes the middle of an odd count and the mean of the two middles of an even count', () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it('does not mutate its input', () => {
    const input = [3, 1, 2];
    median(input);
    expect(input).toEqual([3, 1, 2]);
  });
});

describe('summarize', () => {
  it('counts outcomes and averages progress', () => {
    const s = summarize([
      run({ outcome: 'extracted', floorReached: 4, ticks: 5000 }),
      run({ outcome: 'died', floorReached: 2, ticks: 3000 }),
      run({ outcome: 'timeout', floorReached: 1, ticks: 40000 }),
    ]);
    expect([s.runs, s.extracted, s.died, s.timedOut]).toEqual([3, 1, 1, 1]);
    expect(s.avgFloorReached).toBeCloseTo(2.3, 1);
    expect(s.avgTicks).toBe(16000);
  });

  it('buckets where runs ENDED by floor:room, and never counts an extraction as a death', () => {
    const s = summarize([
      run({ outcome: 'died', floorReached: 0, endRoom: 'r1' }),
      run({ outcome: 'died', floorReached: 0, endRoom: 'r1' }),
      run({ outcome: 'timeout', floorReached: 2, endRoom: 'r5' }),
      run({ outcome: 'extracted', floorReached: 4, endRoom: 'r5' }),
    ]);
    expect(s.deathsByRoom).toEqual({ '0:r1': 2, '2:r5': 1 });
  });

  it('reports the worst burst window across runs alongside the effective HP it must be read against', () => {
    const s = summarize([run({ peakBurstDamage: 4 }), run({ peakBurstDamage: 11 })]);
    expect(s.maxPeakBurstDamage).toBe(11);
    expect(s.avgPeakBurstDamage).toBe(7.5);
    expect(s.effectiveHp).toBe(9.2);
  });

  it('survives an empty sweep instead of dividing by zero', () => {
    const s = summarize([]);
    expect(s.runs).toBe(0);
    expect(s.avgFloorReached).toBe(0);
    expect(s.maxPeakBurstDamage).toBe(0);
    expect(s.deathsByRoom).toEqual({});
  });
});

describe('roomStats', () => {
  it('groups encounters across runs by floor:room and counts samples', () => {
    const rows = roomStats([
      run({ encounters: [enc({ roomId: 'r1' }), enc({ roomId: 'r2' })] }),
      run({ encounters: [enc({ roomId: 'r1' })] }),
    ]);
    expect(rows.map((r) => [r.key, r.samples])).toEqual([
      ['0:r1', 2],
      ['0:r2', 1],
    ]);
  });

  it('keys by FLOOR as well as room — the same piece on two floors is two different fights', () => {
    const rows = roomStats([run({ encounters: [enc({ floorIndex: 0, roomId: 'r1' }), enc({ floorIndex: 1, roomId: 'r1' })] })]);
    expect(rows.map((r) => r.key)).toEqual(['0:r1', '1:r1']);
  });

  it('medians the reaction window, ignoring samples where the room never landed a hit', () => {
    const rows = roomStats([
      run({ encounters: [enc({ reactionTicks: 30 })] }),
      run({ encounters: [enc({ reactionTicks: 90 })] }),
      run({ encounters: [enc({ reactionTicks: null })] }),
    ]);
    expect(rows[0]!.medianReactionTicks).toBe(60);
  });

  it('reports null reaction when no sample of the room ever hit the player', () => {
    const rows = roomStats([run({ encounters: [enc({ reactionTicks: null })] })]);
    expect(rows[0]!.medianReactionTicks).toBeNull();
  });

  it('takes the max garrison and max peak shooters, but averages the rest', () => {
    const rows = roomStats([
      run({ encounters: [enc({ garrison: 8, peakShooters: 1, damageTaken: 4 })] }),
      run({ encounters: [enc({ garrison: 9, peakShooters: 3, damageTaken: 6 })] }),
    ]);
    expect(rows[0]!.garrison).toBe(9);
    expect(rows[0]!.maxPeakShooters).toBe(3);
    expect(rows[0]!.avgPeakShooters).toBe(2);
    expect(rows[0]!.avgDamageTaken).toBe(5);
  });

  it('computes clear rate and averages clear time over CLEARED samples only', () => {
    const rows = roomStats([
      run({ encounters: [enc({ activatedTick: 100, clearedTick: 300 })] }),
      run({ encounters: [enc({ activatedTick: 100, clearedTick: 500 })] }),
      run({ encounters: [enc({ clearedTick: null })] }),
    ]);
    expect(rows[0]!.clearRate).toBeCloseTo(0.67, 2);
    expect(rows[0]!.avgClearTicks).toBe(300); // (200 + 400) / 2 — the uncleared one is excluded
  });

  it('reports a null clear time for a room nothing ever cleared', () => {
    const rows = roomStats([run({ encounters: [enc({ clearedTick: null })] })]);
    expect(rows[0]!.clearRate).toBe(0);
    expect(rows[0]!.avgClearTicks).toBeNull();
  });

  it('sorts by floor, then room id — the order a descent is actually played in', () => {
    const rows = roomStats([
      run({
        encounters: [
          enc({ floorIndex: 1, roomId: 'r2' }),
          enc({ floorIndex: 0, roomId: 'r9' }),
          enc({ floorIndex: 1, roomId: 'r1' }),
        ],
      }),
    ]);
    expect(rows.map((r) => r.key)).toEqual(['0:r9', '1:r1', '1:r2']);
  });
});

describe('formatSummary / formatRoomTable', () => {
  it('renders the burst window against the HP pool, and names the label it was given', () => {
    const text = formatSummary('profile=careful', summarize([run({ peakBurstDamage: 5 })]));
    expect(text).toContain('profile=careful');
    expect(text).toContain('5');
    expect(text).toContain('9.2 effective HP');
  });

  it('says so explicitly when every run extracted, rather than printing an empty object', () => {
    const text = formatSummary('x', summarize([run({ outcome: 'extracted', endRoom: 'r5' })]));
    expect(text).toContain('every run extracted');
  });

  it('renders one table row per room plus a header, with a dash for missing values', () => {
    const text = formatRoomTable(roomStats([run({ encounters: [enc({ reactionTicks: null, clearedTick: null })] })]));
    const lines = text.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('garrison');
    expect(lines[1]).toContain('r1');
    expect(lines[1]).toContain('-');
  });
});

describe('floorDropStats — the loot economy per floor (design/09 DROP_TABLE)', () => {
  it('groups a run\u2019s drops by floor and counts each kind separately', () => {
    const rows = floorDropStats([
      run({
        killsByFloor: { 0: 20, 1: 10 },
        checkpointFloors: [0],
        drops: [
          drop({ kind: 'weapon' }),
          drop({ kind: 'weapon', roomId: 'r2' }),
          drop({ kind: 'heal' }),
          drop({ kind: 'material' }),
          drop({ kind: 'buff' }),
          drop({ kind: 'energy' }),
          drop({ floorIndex: 1, kind: 'weapon' }),
        ],
      }),
    ]);
    expect(rows.map((r) => r.floorIndex)).toEqual([0, 1]); // sorted by floor
    const f0 = rows[0]!;
    expect([f0.avgWeapons, f0.avgHeals, f0.avgMaterials, f0.avgBuffs, f0.avgEnergy]).toEqual([2, 1, 1, 1, 1]);
    expect(rows[1]!.avgWeapons).toBe(1);
  });

  it('reads min/max weapons over COMPLETE visits only — a died-on floor under-counts', () => {
    // Two runs on floor 0: one reached the checkpoint with 3 weapons, one died early
    // with 0. The average sees both; the spread must only see the complete one, or
    // "0 weapons this floor" gets blamed on the drop table instead of on the death.
    const rows = floorDropStats([
      run({ killsByFloor: { 0: 60 }, checkpointFloors: [0], drops: [drop({ kind: 'weapon' }), drop({ kind: 'weapon' }), drop({ kind: 'weapon' })] }),
      run({ killsByFloor: { 0: 4 }, checkpointFloors: [], drops: [] }),
    ]);
    const f0 = rows[0]!;
    expect([f0.samples, f0.complete]).toEqual([2, 1]);
    expect([f0.minWeapons, f0.maxWeapons]).toEqual([3, 3]);
    expect(f0.avgWeapons).toBe(1.5); // 3 over two visits — deliberately still diluted
  });

  it('has no weapon spread at all when no visit was complete', () => {
    const rows = floorDropStats([run({ killsByFloor: { 0: 4 }, checkpointFloors: [], drops: [drop({ kind: 'weapon' })] })]);
    expect([rows[0]!.minWeapons, rows[0]!.maxWeapons]).toEqual([null, null]);
  });

  it('reports the worst single-room weapon concentration, passage drops included', () => {
    // Three weapons on one floor, two of them in the same room, one in a passage
    // (roomId null). The per-room max is 2 — and the passage drop must not be
    // silently discarded, or a floor could dump loot into corridors unnoticed.
    const rows = floorDropStats([
      run({
        killsByFloor: { 0: 50 },
        checkpointFloors: [0],
        drops: [drop({ kind: 'weapon', roomId: 'r1' }), drop({ kind: 'weapon', roomId: 'r1' }), drop({ kind: 'weapon', roomId: null })],
      }),
    ]);
    expect(rows[0]!.maxWeaponsInOneRoom).toBe(2);
    expect(rows[0]!.avgWeapons).toBe(3); // the passage drop still counts toward the floor
  });

  it('turns counts into per-kill rates, which is what the drop table is tuned in', () => {
    const rows = floorDropStats([
      run({ killsByFloor: { 0: 50 }, checkpointFloors: [0], drops: [...Array(10)].map(() => drop({ kind: 'heal' })) }),
    ]);
    expect(rows[0]!.healsPerKill).toBe(0.2); // 10 heals / 50 kills
    expect(rows[0]!.weaponsPerKill).toBe(0);
  });

  it('never divides by zero on a floor that recorded drops but no kills', () => {
    // Reachable in principle: the pity/quota drops planned for the capstone are
    // spawned by the engine, not by a kill this tracker attributed to the floor.
    const rows = floorDropStats([run({ killsByFloor: {}, checkpointFloors: [0], drops: [drop({ kind: 'weapon' })] })]);
    expect([rows[0]!.healsPerKill, rows[0]!.weaponsPerKill]).toEqual([0, 0]);
    expect(rows[0]!.avgKills).toBe(0);
  });

  it('prices the pulls, and splits the spend into what the CLOCK funded and what the FLOOR did', () => {
    // The 2026-09-11 column (ENGINE_VERSION 62). 20 pulls at the blaster's 3 = 60 spent;
    // one collected refill funded 30 of that and the regen clock funded the other half.
    const rows = floorFireStats([
      run({
        killsByFloor: { 0: 10 },
        checkpointFloors: [0],
        fires: Array.from({ length: 20 }, () => fire({ energySpent: 3 })),
        energyRefillsTakenByFloor: { 0: 1 },
        drops: [drop({ kind: 'energy' }), drop({ kind: 'energy' }), drop({ kind: 'energy', floorIndex: 1 })],
      }),
    ]);
    expect(rows[0]!.avgSpend).toBe(60);
    expect(rows[0]!.floorShare).toBe(0.5); // 30 of 60 — ENERGY_PICKUP_AMOUNT is 30
    // Taken counts COLLECTED refills, spawned counts the ones this floor PRODUCED — the
    // gap between the two is the whole finding, so a row conflating them would hide it.
    expect(rows[0]!.refillsTaken).toBe(1);
    expect(rows[0]!.refillsSpawned).toBe(2); // the floor-1 drop belongs to floor 1
  });

  it('charges a melee swing nothing, and a swap-tick pull nothing rather than the wrong gun', () => {
    // `energySpent` is null exactly where `weapon` is: the slot that fired is not the one
    // standing there once PickupSystem has run. Charging that pull at the NEW gun's price
    // is the specific wrong answer this guards — it would make a floor that handed out a
    // cannon read as if the cannon had been firing all along.
    const rows = floorFireStats([
      run({
        killsByFloor: { 0: 2 },
        checkpointFloors: [0],
        fires: [fire({ kind: 'melee', weapon: 'saber', energySpent: 0 }), fire({ weapon: null, energySpent: null })],
      }),
    ]);
    expect(rows[0]!.avgSpend).toBe(0);
    expect(rows[0]!.floorShare).toBe(0); // and not NaN, off a zero spend
  });

  it('renders one table row per floor, headed', () => {
    const rows = floorDropStats([run({ killsByFloor: { 0: 20, 1: 20 }, checkpointFloors: [0, 1], drops: [drop({ kind: 'weapon' })] })]);
    const lines = formatDropTable(rows).split('\n');
    expect(lines).toHaveLength(3); // header + 2 floors
    expect(lines[0]).toContain('weapons(avg/min/max)');
    expect(lines[0]).toContain('energy');
    expect(lines[1]).toMatch(/^0 /);
  });
});

describe('floorFireStats — what a floor COSTS to clear (the ammo-economy denominator)', () => {
  it('separates trigger pulls from projectiles, so a spread frame is not counted eight times', () => {
    const rows = floorFireStats([
      run({
        killsByFloor: { 0: 10 },
        checkpointFloors: [0],
        fires: [fire({ bullets: 8 }), fire({ bullets: 8 }), fire({ bullets: 1 })],
      }),
    ]);
    expect(rows[0]!.avgTriggers).toBe(3);
    expect(rows[0]!.avgBullets).toBe(17);
  });

  it('counts melee swings on their own axis and reports the free/paid split', () => {
    const rows = floorFireStats([
      run({
        killsByFloor: { 0: 10 },
        checkpointFloors: [0],
        fires: [fire(), fire(), fire(), fire({ kind: 'melee', weapon: 'saber' })],
      }),
    ]);
    expect(rows[0]!.avgTriggers).toBe(3);
    expect(rows[0]!.avgSwings).toBe(1);
    expect(rows[0]!.meleeShare).toBe(0.25);
  });

  it('never lets a melee swing inflate the projectile count', () => {
    // `FireRecord.bullets` is 1 for a swing so the two kinds stay summable, which is
    // exactly the field a careless sum would charge as a bullet.
    const rows = floorFireStats([
      run({ killsByFloor: { 0: 4 }, checkpointFloors: [0], fires: [fire({ kind: 'melee', weapon: 'saber' })] }),
    ]);
    expect(rows[0]!.avgBullets).toBe(0);
  });

  it('groups by floor and sorts by floor', () => {
    const rows = floorFireStats([
      run({
        killsByFloor: { 0: 10, 2: 5 },
        checkpointFloors: [0, 2],
        fires: [fire({ floorIndex: 2 }), fire({ floorIndex: 0 }), fire({ floorIndex: 0 })],
      }),
    ]);
    expect(rows.map((r) => [r.floorIndex, r.avgTriggers])).toEqual([
      [0, 2],
      [2, 1],
    ]);
  });

  it('reads the trigger spread over COMPLETE visits only — a died-on floor spent less', () => {
    // The same correction floorDropStats makes for weapons, for the same reason: a
    // pool sized off a run that died in room two is sized off two rooms of shooting.
    const rows = floorFireStats([
      run({ killsByFloor: { 0: 60 }, checkpointFloors: [0], fires: [...Array(30)].map(() => fire()) }),
      run({ killsByFloor: { 0: 4 }, checkpointFloors: [], fires: [fire(), fire()] }),
    ]);
    const f0 = rows[0]!;
    expect([f0.samples, f0.complete]).toEqual([2, 1]);
    expect([f0.minTriggers, f0.maxTriggers]).toEqual([30, 30]);
    expect(f0.avgTriggers).toBe(16); // 32 over two visits — deliberately still diluted
  });

  it('has no trigger spread at all when no visit was complete', () => {
    const rows = floorFireStats([run({ killsByFloor: { 0: 4 }, checkpointFloors: [], fires: [fire()] })]);
    expect([rows[0]!.minTriggers, rows[0]!.maxTriggers]).toEqual([null, null]);
  });

  it('turns pulls into per-kill exchange rates — the unit a refill drop gets priced in', () => {
    const rows = floorFireStats([
      run({ killsByFloor: { 0: 20 }, checkpointFloors: [0], fires: [...Array(60)].map(() => fire({ bullets: 2 })) }),
    ]);
    expect(rows[0]!.triggersPerKill).toBe(3);
    expect(rows[0]!.bulletsPerKill).toBe(6);
  });

  it('never divides by zero on a floor that fired but recorded no kills', () => {
    const rows = floorFireStats([run({ killsByFloor: {}, checkpointFloors: [0], fires: [fire()] })]);
    expect([rows[0]!.triggersPerKill, rows[0]!.bulletsPerKill]).toEqual([0, 0]);
  });

  it('reports the share of live ticks the pool could not cover a pull — the economy biting', () => {
    // The column that tells "capacity does not matter" apart from "the bar never
    // emptied" (ENGINE_VERSION 60). Denominated in LIVE ticks, not in pulls: a player
    // who cannot afford to fire is not firing, so a pull-denominated version would go to
    // zero exactly when the pressure is highest.
    const rows = floorFireStats([
      run({
        killsByFloor: { 0: 10 },
        checkpointFloors: [0],
        fires: [fire()],
        dryTicksByFloor: { 0: 250 },
        aliveTicksByFloor: { 0: 1000 },
      }),
    ]);
    expect(rows[0]!.dryShare).toBe(0.25);
  });

  it('pools dry ticks across runs against the matching live-tick denominator, per floor', () => {
    // Two runs that spent very different amounts of time on the floor: the share has to
    // be the pooled ratio, not the mean of two ratios (which would weight a 10-tick
    // visit the same as a 1000-tick one).
    const rows = floorFireStats([
      run({ killsByFloor: { 0: 1 }, checkpointFloors: [0], fires: [fire()], dryTicksByFloor: { 0: 100 }, aliveTicksByFloor: { 0: 100 } }),
      run({ killsByFloor: { 0: 1 }, checkpointFloors: [0], fires: [fire()], dryTicksByFloor: { 0: 0 }, aliveTicksByFloor: { 0: 900 } }),
    ]);
    expect(rows[0]!.dryShare).toBe(0.1); // 100/1000, not (1 + 0)/2
  });

  it('reports 0 rather than NaN for a floor with no live ticks recorded', () => {
    const rows = floorFireStats([
      run({ killsByFloor: { 0: 1 }, checkpointFloors: [0], fires: [fire()], dryTicksByFloor: {}, aliveTicksByFloor: {} }),
    ]);
    expect(rows[0]!.dryShare).toBe(0);
  });

  it('reports a zero melee share rather than NaN for a floor that never fired at all', () => {
    // Reachable: a floor whose visit was recorded off `killsByFloor` (a kill the
    // player did not fire for — a DoT tick, a deflected bullet) with no pulls on it.
    const rows = floorFireStats([run({ killsByFloor: { 0: 1 }, checkpointFloors: [], fires: [] })]);
    expect(rows[0]!.meleeShare).toBe(0);
  });

  it('renders one table row per floor, headed', () => {
    const rows = floorFireStats([run({ killsByFloor: { 0: 20, 1: 20 }, checkpointFloors: [0, 1], fires: [fire(), fire({ floorIndex: 1 })] })]);
    const lines = formatFireTable(rows).split('\n');
    expect(lines).toHaveLength(3); // header + 2 floors
    expect(lines[0]).toContain('triggers(avg/min/max)');
    expect(lines[0]).toContain('dry%'); // the energy column is actually rendered, not just computed
    expect(lines[0]).toContain('refills(taken/spawned)');
    // Anchored to the END of the row: the triggers column also contains slashes, so a bare
    // `toContain('/')` here would pass without the new pair ever being rendered.
    expect(lines[1]).toMatch(/\d+\/\d+$/);
    expect(lines[1]).toMatch(/^0 /);
  });
});

describe('weaponFireStats — per-weapon consumption, the input to pricing a MECHANIC', () => {
  it('accumulates pulls and projectiles per weapon and sorts by pulls', () => {
    const rows = weaponFireStats([
      run({
        fires: [
          fire({ weapon: 'blaster' }),
          fire({ weapon: 'blaster' }),
          fire({ weapon: 'scattergun', bullets: 8 }),
        ],
      }),
    ]).rows;
    expect(rows.map((r) => [r.weapon, r.pulls, r.bullets])).toEqual([
      ['blaster', 2, 2],
      ['scattergun', 1, 8],
    ]);
    expect(rows[1]!.bulletsPerPull).toBe(8);
  });

  it('keys by kind as well as name, so a melee and a ranged weapon sharing a name never merge', () => {
    const rows = weaponFireStats([
      run({ fires: [fire({ weapon: 'tomahawk' }), fire({ kind: 'melee', weapon: 'tomahawk' })] }),
    ]).rows;
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.kind).sort()).toEqual(['melee', 'ranged']);
  });

  it('never counts a swing as a projectile', () => {
    const rows = weaponFireStats([run({ fires: [fire({ kind: 'melee', weapon: 'saber' })] })]).rows;
    expect([rows[0]!.bullets, rows[0]!.bulletsPerPull]).toEqual([0, 0]);
  });

  it('sets each weapon share against every pull in the sweep, melee included', () => {
    const rows = weaponFireStats([
      run({ fires: [fire({ weapon: 'blaster' }), fire({ weapon: 'blaster' }), fire({ kind: 'melee', weapon: 'saber' }), fire({ kind: 'melee', weapon: 'saber' })] }),
    ]).rows;
    expect(rows.every((r) => r.share === 0.5)).toBe(true);
  });

  it('counts an unattributed pull separately instead of charging it to the wrong gun', () => {
    // A null weapon is a pull from a tick that also collected a weapon (PickupSystem
    // runs five steps after the fire). Folding those into the current occupant would
    // make this table quietly wrong in exactly the runs that swap most.
    const stats = weaponFireStats([run({ fires: [fire({ weapon: 'blaster' }), fire({ weapon: null }), fire({ weapon: null })] })]);
    expect(stats.unattributed).toBe(2);
    expect(stats.rows).toHaveLength(1);
    // The share denominator still counts them, so the column can never sum past 100%.
    expect(stats.rows[0]!.share).toBeCloseTo(0.333, 3);
  });

  it('aggregates across runs, not within one', () => {
    const stats = weaponFireStats([run({ fires: [fire({ weapon: 'blaster' })] }), run({ fires: [fire({ weapon: 'blaster' })] })]);
    expect(stats.rows[0]!.pulls).toBe(2);
  });

  it('renders a headed table that always names the unattributed count, even at zero', () => {
    const text = formatWeaponFireTable(weaponFireStats([run({ fires: [fire({ weapon: 'blaster' })] })]));
    const lines = text.split('\n');
    expect(lines[0]).toContain('bul/pull');
    expect(lines[1]).toContain('blaster');
    expect(lines[2]).toContain('unattributed pulls');
    expect(lines[2]).toContain('0');
  });

  it('survives a sweep with no fires at all', () => {
    const stats = weaponFireStats([run({ fires: [] })]);
    expect(stats.rows).toEqual([]);
    expect(stats.unattributed).toBe(0);
  });
});
