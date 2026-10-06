/**
 * The endless dungeon's portal (design/gameplay/04-chapters.md "The Endless Descent",
 * 2026-10-06): every boss floor offers EXTRACT and DESCEND both, and the press that opens the
 * portal picks the way. Driven on the extraction-gate fixture's two rooms with their enemies
 * removed, cycled as one two-floor segment: floor 0 is interior, floor 1 a boss floor, floor 2
 * the interior one again.
 */
import { describe, expect, it } from 'vitest';
import { createGameEngine } from '@dd/engine/GameEngine';
import type { EngineConfig } from '@dd/engine/state/GameState';
import { makeCommand } from '@dd/engine/state/input';
import { Button } from '@dd/engine/state/commands';
import type { Brad } from '@dd/engine/math/trig';
import { PORTAL_COUNTDOWN_TICKS } from '@dd/engine/config';
import type { DungeonConfig } from '@dd/engine/world/dungeon';
import { EXTRACT_GATE_DUNGEON, EXTRACT_GATE_ROOMS } from '@dd/engine/fixtures/extractionGateFloor';

const ROOMS = EXTRACT_GATE_ROOMS.map((p) => ({ ...p, spawns: { ...p.spawns, enemy: [] } }));
const ENDLESS: DungeonConfig = {
  ...EXTRACT_GATE_DUNGEON,
  biomeId: 'endless_test',
  floorMaps: undefined,
  endless: { segments: [EXTRACT_GATE_DUNGEON] },
};

function engine(seats: 1 | 2, dungeon: DungeonConfig = ENDLESS) {
  const players = seats === 2 ? [{ start: [100, 100] as [number, number] }, { start: [140, 100] as [number, number] }] : undefined;
  const cfg: EngineConfig = { seed: 31, worldW: 800, worldH: 800, waves: [], dungeon: { config: dungeon, library: ROOMS }, ...(players ? { players } : {}) };
  return createGameEngine(cfg);
}
type Eng = ReturnType<typeof engine>;

/** One tick; seat i presses `buttons[i]` (0 = nothing), every seat votes card 1. */
function step(eng: Eng, buttons: number[]): void {
  const t = eng.state.tick + 1;
  eng.step(buttons.map((b, owner) => makeCommand({ owner, tick: t, moveBrad: 0 as Brad, moveMag: 0, buttons: b, cardVote: 1 })));
}

/** Idle until floor `floor`'s checkpoint is open (its card offer rolled), solo or co-op. */
function toCheckpoint(eng: Eng, seats: number): void {
  for (let i = 0; i < 20 && eng.state.floorCardOffer.length === 0; i++) step(eng, new Array(seats).fill(0));
}

/** Descend from the interior floor 0 to the boss floor 1. */
function toBossFloor(eng: Eng, seats = 1): void {
  toCheckpoint(eng, seats);
  step(eng, new Array(seats).fill(Button.CONFIRM_DESCEND));
  expect(eng.state.floorIndex).toBe(1);
  toCheckpoint(eng, seats);
}

describe('an endless boss floor offers both ways out', () => {
  it('rolls a card offer there, which a finite last floor never does', () => {
    const eng = engine(1);
    toBossFloor(eng);
    expect(eng.state.floorCardOffer).toHaveLength(3);

    const finite = engine(1, EXTRACT_GATE_DUNGEON);
    toCheckpoint(finite, 1);
    step(finite, [Button.CONFIRM_DESCEND]);
    for (let i = 0; i < 20; i++) step(finite, [0]);
    expect(finite.state.floorIndex).toBe(1);
    expect(finite.state.floorCardOffer).toEqual([]);
  });

  it('EXTRACT there ends the run as a win', () => {
    const eng = engine(1);
    toBossFloor(eng);
    step(eng, [Button.CONFIRM_EXTRACT]);
    expect(eng.state.phase).toBe('gameover');
    expect(eng.state.winner).toBe(0);
    expect(eng.state.floorIndex).toBe(1);
    expect(eng.state.portalChoice).toBeNull();
  });

  it('DESCEND there goes on to the next lap, whose floor reads the segment’s first floor again', () => {
    const eng = engine(1);
    toBossFloor(eng);
    step(eng, [Button.CONFIRM_DESCEND]);
    expect(eng.state.phase).toBe('playing');
    expect(eng.state.floorIndex).toBe(2);
    expect(eng.state.floorCards).toHaveLength(2);
    step(eng, [0]);
    expect(eng.state.dungeonRooms.map((r) => r.piece.id)).toEqual(['extract_gate_mid']);
  });

  it('an interior endless floor still ignores EXTRACT', () => {
    const eng = engine(1);
    toCheckpoint(eng, 1);
    step(eng, [Button.CONFIRM_EXTRACT]);
    expect(eng.state.phase).toBe('playing');
    expect(eng.state.portalCountdownTicks).toBe(0);
  });

  it('both buttons on one tick read as EXTRACT, the safe way', () => {
    const eng = engine(1);
    toBossFloor(eng);
    step(eng, [Button.CONFIRM_EXTRACT | Button.CONFIRM_DESCEND]);
    expect(eng.state.phase).toBe('gameover');
  });
});

describe('in co-op the opening press picks the way', () => {
  it('records the choice while the countdown runs, and only that button confirms it', () => {
    const eng = engine(2);
    toBossFloor(eng, 2);
    step(eng, [0, Button.CONFIRM_EXTRACT]);
    expect(eng.state.portalChoice).toBe('extract');
    expect(eng.state.portalCountdownTicks).toBe(PORTAL_COUNTDOWN_TICKS - 1);

    step(eng, [Button.CONFIRM_DESCEND, 0]);
    expect(eng.state.players[0]!.portalReady).toBe(false);
    expect(eng.state.phase).toBe('playing');

    step(eng, [Button.CONFIRM_EXTRACT, 0]);
    expect(eng.state.phase).toBe('gameover');
    expect(eng.state.portalChoice).toBeNull();
  });

  it('a countdown opened by DESCEND descends when it runs out', () => {
    const eng = engine(2);
    toBossFloor(eng, 2);
    step(eng, [Button.CONFIRM_DESCEND, 0]);
    expect(eng.state.portalChoice).toBe('descend');
    for (let i = 0; i < PORTAL_COUNTDOWN_TICKS - 1; i++) step(eng, [0, Button.CONFIRM_EXTRACT]);
    expect(eng.state.phase).toBe('playing');
    expect(eng.state.floorIndex).toBe(2);
    expect(eng.state.portalChoice).toBeNull();
  });

  it('never records a choice on a floor offering one button', () => {
    const eng = engine(2);
    toCheckpoint(eng, 2);
    step(eng, [Button.CONFIRM_DESCEND, 0]);
    expect(eng.state.portalCountdownTicks).toBeGreaterThan(0);
    expect(eng.state.portalChoice).toBeNull();
  });
});
