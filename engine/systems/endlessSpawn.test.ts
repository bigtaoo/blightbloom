/**
 * How an endless dungeon builds each floor (design/gameplay/04-chapters.md "The Endless
 * Descent", 2026-10-06): `SpawnSystem` reads the floor's map from the segment that owns it, and
 * `buildEnemyActor` scales a mob's health by the endless config's own curve at the run's global
 * floor index. `endlessPortal.test.ts` drives a one-segment cycle, which cannot tell "the
 * owning segment" from "the first segment", nor a lap's floor 0 from the run's.
 */
import { describe, expect, it } from 'vitest';
import { createGameEngine } from '@dd/engine/GameEngine';
import type { EngineConfig } from '@dd/engine/state/GameState';
import { makeCommand } from '@dd/engine/state/input';
import { Button } from '@dd/engine/state/commands';
import type { Brad } from '@dd/engine/math/trig';
import type { DungeonConfig, DungeonFloorMap } from '@dd/engine/world/dungeon';
import type { RoomPiece } from '@dd/engine/content/rooms';
import { EXTRACT_GATE_DUNGEON, EXTRACT_GATE_ROOMS } from '@dd/engine/fixtures/extractionGateFloor';

const quiet = (p: RoomPiece): RoomPiece => ({ ...p, spawns: { ...p.spawns, enemy: [] } });
const MID = quiet(EXTRACT_GATE_ROOMS[0]!);
const BOSS = quiet(EXTRACT_GATE_ROOMS[1]!);
/** Segment B's interior room: segment A's with a different id, so a floor says whose map it read. */
const MID_B: RoomPiece = { ...MID, id: 'extract_gate_mid_b' };

const floorMap = (id: string, pieceId: string): DungeonFloorMap => ({
  id,
  rooms: [{ id: 'g1', pieceId, offsetXGrid: 0, offsetYGrid: 0 }],
  doors: [],
});
const SEGMENT_B: DungeonConfig = {
  ...EXTRACT_GATE_DUNGEON,
  extractionPieceId: MID_B.id,
  floorMaps: { 0: floorMap('b_f0', MID_B.id), 1: floorMap('b_f1', BOSS.id) },
};
const TWO_SEGMENTS: DungeonConfig = {
  ...EXTRACT_GATE_DUNGEON,
  biomeId: 'endless_test',
  floorMaps: undefined,
  endless: { segments: [EXTRACT_GATE_DUNGEON, SEGMENT_B] },
};

function engine(dungeon: DungeonConfig, library: readonly RoomPiece[] = [MID, BOSS, MID_B]) {
  const cfg: EngineConfig = { seed: 31, worldW: 800, worldH: 800, waves: [], dungeon: { config: dungeon, library } };
  return createGameEngine(cfg);
}
type Eng = ReturnType<typeof engine>;

function step(eng: Eng, buttons: number): void {
  const t = eng.state.tick + 1;
  eng.step([makeCommand({ owner: 0, tick: t, moveBrad: 0 as Brad, moveMag: 0, buttons, cardVote: 1 })]);
}

/** Wait for the checkpoint, press DESCEND, and settle on the next floor; returns its room ids. */
function descend(eng: Eng): string[] {
  for (let i = 0; i < 20 && eng.state.floorCardOffer.length === 0; i++) step(eng, 0);
  const from = eng.state.floorIndex;
  step(eng, Button.CONFIRM_DESCEND);
  expect(eng.state.floorIndex).toBe(from + 1);
  step(eng, 0);
  return eng.state.dungeonRooms.map((r) => r.piece.id);
}

describe('an endless floor is built from the segment that owns it', () => {
  it('reads segment A, then segment B, then wraps to segment A on the next lap', () => {
    const eng = engine(TWO_SEGMENTS);
    step(eng, 0); // a floor is built on the first tick, not by the constructor
    expect(eng.state.dungeonRooms.map((r) => r.piece.id)).toEqual([MID.id]); // floor 0: A's floor 0
    expect(descend(eng)).toEqual([BOSS.id]); //   floor 1: A's boss floor
    expect(descend(eng)).toEqual([MID_B.id]); //  floor 2: B's floor 0, not A's
    expect(descend(eng)).toEqual([BOSS.id]); //   floor 3: B's boss floor
    expect(descend(eng)).toEqual([MID.id]); //    floor 4: lap two, A's floor 0 again
    expect(eng.state.floorIndex).toBe(4);
  });
});

describe('an endless mob is as tough as the run is deep, not as its lap is', () => {
  /** One basic mob in the interior room, so a floor-0 map spawns something to measure. */
  const MID_ONE: RoomPiece = { ...MID, spawns: { ...MID.spawns, enemy: [{ x: 3, y: 3, type: 'basic' }] } };
  /** The first live mob's max health, ticking until the room (entered a tick after the floor
   *  is built) has spawned it. */
  const mobHp = (eng: Eng): number => {
    for (let i = 0; i < 60 && !eng.state.enemies.some((e) => e.alive); i++) step(eng, 0);
    const mob = eng.state.enemies.find((e) => e.alive);
    expect(mob).toBeDefined();
    return mob!.maxHp;
  };

  it('scales by the endless curve at the global floor, while every segment authors a flat one', () => {
    // A flat segment curve (EXTRACT_GATE_DUNGEON: base 1, perFloor 0) under a steep endless one:
    // reading the segment's curve, or the lap-local floor, would make both mobs equal.
    const steep: DungeonConfig = {
      ...EXTRACT_GATE_DUNGEON,
      floorMaps: undefined,
      difficultyCurve: { base: 1, perFloor: 1 },
      endless: { segments: [EXTRACT_GATE_DUNGEON] },
    };
    const eng = engine(steep, [MID_ONE, BOSS]);
    step(eng, 0);
    const lapOne = mobHp(eng);
    const clear = () => {
      for (const m of eng.state.enemies) (m.hp = 0), (m.alive = false);
    };
    clear();
    descend(eng);
    descend(eng); // floor 2: the segment's floor 0 again, two floors deeper
    expect(eng.state.dungeonRooms.map((r) => r.piece.id)).toEqual([MID_ONE.id]);
    expect(mobHp(eng)).toBe(lapOne * 3); // curve 1 + 1·2 at floor 2, against 1 at floor 0
  });
});
