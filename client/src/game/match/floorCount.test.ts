/**
 * totalFloorCount (design/10 screen-flow gap fix) — three render-side call sites
 * (Game.ts's checkpoint gate, HudView's floor chip, RunOutcome's result line) used to
 * hardcode `EMBER_DUNGEON.floorCount` instead of reading the real config; this pins the
 * mode-generic replacement against real `createGameState` fixtures for every mode.
 *
 * checkpointReached (2026-08-12 stuck-portal fix) — mirrors ExtractionSystem.tick's own
 * per-mode "checkpoint reached" condition, which GameLoop.ts needs its own render-side
 * copy of. See that describe block below for the bug this replaced (dungeon mode's
 * `wavesExhausted` is never set — SpawnSystem.tick's dungeon branch returns before the
 * line that sets it — so the portal/popup gate was permanently false on any non-final
 * floor).
 */
import { describe, it, expect } from 'vitest';
import { createGameState, buildEnemyActor, toFp, EMBER_DUNGEON, EMBER_ROOMS, type DungeonConfig } from '@dd/engine';
import { totalFloorCount, checkpointReached } from './floorCount';

const TINY_DUNGEON: DungeonConfig = {
  ...EMBER_DUNGEON,
  floorCount: 5,
};

describe('totalFloorCount', () => {
  it('reads dungeonConfig.floorCount when dungeonEnabled', () => {
    const s = createGameState({
      seed: 1, worldW: 800, worldH: 800, waves: [],
      dungeon: { config: TINY_DUNGEON, library: EMBER_ROOMS },
    });
    expect(s.dungeonEnabled).toBe(true);
    expect(totalFloorCount(s)).toBe(5);
  });

  it('is extraFloors.length + 1 when floorsEnabled (flat, non-dungeon mode)', () => {
    const s = createGameState({
      seed: 1, worldW: 800, worldH: 800, waves: [],
      floors: [[[[100, 100]]], [[[200, 200]]], [[[300, 300]]]], // 3 extra floors → 4 total
    });
    expect(s.dungeonEnabled).toBe(false);
    expect(s.floorsEnabled).toBe(true);
    expect(totalFloorCount(s)).toBe(4);
  });

  it('is 1 + extraFloors.length even for a single-extra-floor (2-floor) flat config, like the tutorial', () => {
    const s = createGameState({
      seed: 1, worldW: 800, worldH: 800, waves: [],
      floors: [[[[100, 100]]]], // 1 extra floor → 2 total
    });
    expect(totalFloorCount(s)).toBe(2);
  });

  it('falls back to EMBER_DUNGEON.floorCount for a bare state with no floors/dungeon concept at all', () => {
    const s = createGameState({ seed: 1, worldW: 800, worldH: 800, waves: [] });
    expect(s.dungeonEnabled).toBe(false);
    expect(s.floorsEnabled).toBe(false);
    expect(totalFloorCount(s)).toBe(EMBER_DUNGEON.floorCount);
  });
});

function dungeonStateWithRooms(roomCount: number) {
  const s = createGameState({
    seed: 1, worldW: 800, worldH: 800, waves: [],
    dungeon: { config: TINY_DUNGEON, library: EMBER_ROOMS },
  });
  // Normally populated by SpawnSystem on floor-load (design/05) — built by hand here
  // so the test controls each room's `activated`/`hasLiveEnemy` directly, same as
  // ExtractionSystem.test.ts's own capstoneCleared fixtures.
  for (let i = 0; i < roomCount; i++) {
    s.dungeonRoomRuntime.push({ activated: false, roomTick: 0, schedule: [], cursor: 0, hasLiveEnemy: false });
  }
  return s;
}

describe('checkpointReached — dungeon mode (reads the capstone room, not a global flag)', () => {
  it('false before the capstone (last) room has ever been entered', () => {
    const s = dungeonStateWithRooms(2);
    expect(checkpointReached(s)).toBe(false);
  });

  it('false once the capstone is activated but still has a live enemy', () => {
    const s = dungeonStateWithRooms(2);
    s.dungeonRoomRuntime[1]!.activated = true;
    s.dungeonRoomRuntime[1]!.hasLiveEnemy = true;
    expect(checkpointReached(s)).toBe(false);
  });

  it('true once the capstone is activated and cleared', () => {
    const s = dungeonStateWithRooms(2);
    s.dungeonRoomRuntime[1]!.activated = true;
    s.dungeonRoomRuntime[1]!.hasLiveEnemy = false;
    expect(checkpointReached(s)).toBe(true);
  });

  it('THE FIX: stays true even with a live enemy in another co-resident room (matches ExtractionSystem, which only checks capstoneCleared — not a global enemies.length === 0)', () => {
    const s = dungeonStateWithRooms(2);
    s.dungeonRoomRuntime[0]!.activated = true;
    s.dungeonRoomRuntime[0]!.hasLiveEnemy = true; // room 0 (not the capstone) still has a mob up
    s.dungeonRoomRuntime[1]!.activated = true;
    s.dungeonRoomRuntime[1]!.hasLiveEnemy = false; // but the capstone itself is clear
    s.enemies.push(buildEnemyActor(s, toFp(10), toFp(10)));
    expect(s.enemies.length).toBeGreaterThan(0); // the old (buggy) `enemies.length === 0` check would fail here
    expect(checkpointReached(s)).toBe(true);
  });
});

describe('checkpointReached — flat, non-dungeon mode (unchanged: wavesExhausted && no live enemies)', () => {
  function flatState() {
    return createGameState({
      seed: 1, worldW: 800, worldH: 800, waves: [],
      floors: [[[[100, 100]]]],
    });
  }

  it('false while wavesExhausted is still false', () => {
    const s = flatState();
    expect(s.wavesExhausted).toBe(false);
    expect(checkpointReached(s)).toBe(false);
  });

  it('false once wavesExhausted flips on, if an enemy is still alive', () => {
    const s = flatState();
    s.wavesExhausted = true;
    s.enemies.push(buildEnemyActor(s, toFp(10), toFp(10)));
    expect(checkpointReached(s)).toBe(false);
  });

  it('true once wavesExhausted is on and every enemy is gone', () => {
    const s = flatState();
    s.wavesExhausted = true;
    expect(s.enemies.length).toBe(0);
    expect(checkpointReached(s)).toBe(true);
  });
});
