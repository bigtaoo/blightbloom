import { describe, it, expect } from 'vitest';
import { ENGINE_VERSION } from '@dd/engine/config';
import { toFp } from '@dd/engine/math/fixed';
import { createGameEngine } from '@dd/engine/GameEngine';
import type { EngineConfig } from '@dd/engine/state/GameState';
import { Button, LocalInputSource, type PlayerCommand } from '@dd/engine/state/commands';
import { makeCommand, quantizeMove } from '@dd/engine/state/input';
import {
  hashState,
  ReplayInputSource,
  runHeadless,
  runReplay,
  serializeState,
  toReplay,
  type Replay,
} from '@dd/engine/replay';

const ARENA: EngineConfig = {
  seed: 4242,
  worldW: 800,
  worldH: 800,
  playerStart: [400, 400],
  waves: [
    [[520, 400], [280, 400]],
    [[400, 280]],
  ],
};

// A scripted, varied but deterministic stream through the engine's own input edge:
// movement swept via quantizeMove, held fire + periodic swap.
function scriptedCommand(tick: number): PlayerCommand {
  const { moveBrad, moveMag } = quantizeMove(Math.sin(tick * 0.07), Math.cos(tick * 0.05));
  let buttons = Button.FIRE;
  if (tick % 37 === 0) buttons |= Button.SWAP_WEAPON;
  return makeCommand({ owner: 0, tick, moveBrad, moveMag, buttons });
}

describe('golden replay (design/08: seed + config + input → identical终局)', () => {
  it('two fresh engines on the same seed + stream stay byte-equal every tick', () => {
    const a = createGameEngine(ARENA);
    const b = createGameEngine(ARENA);
    for (let t = 1; t <= 500; t++) {
      const c = scriptedCommand(t);
      a.step([c]);
      b.step([{ ...c }]); // distinct object, same values
      expect(hashState(b.state)).toBe(hashState(a.state));
    }
  });

  it('record via LocalInputSource → replay via ReplayInputSource reproduces the终局', () => {
    // Live run: submit the scripted stream and drive it headless.
    const live = new LocalInputSource();
    for (let t = 1; t <= 500; t++) live.submit(scriptedCommand(t));
    const liveEngine = runHeadless(ARENA, live, 500);

    // Serialize what actually happened into a Replay, then reconstruct it.
    const replay = toReplay(ARENA, live.recorded());
    expect(replay.version).toBe(ENGINE_VERSION);
    const replayed = runReplay(replay, 500);

    expect(serializeState(replayed.state)).toEqual(serializeState(liveEngine.state));
    expect(hashState(replayed.state)).toBe(hashState(liveEngine.state));
  });

  it('sparse stream: absent frames replay as idle-hold, still byte-equal', () => {
    // Only every 3rd frame carries a command; the gaps must replay as idle.
    const live = new LocalInputSource();
    for (let t = 1; t <= 300; t++) {
      if (t % 3 === 0) live.submit(scriptedCommand(t));
    }
    const liveEngine = runHeadless(ARENA, live, 300);
    const replayed = runReplay(toReplay(ARENA, live.recorded()), 300);
    expect(hashState(replayed.state)).toBe(hashState(liveEngine.state));
  });

  it('idle-hold semantics: a frame with no command zeroes movement, not buttons', () => {
    // A far-off enemy keeps the run in 'playing' (an empty wave list wins at tick 1).
    const e = createGameEngine({ seed: 1, worldW: 800, worldH: 800, playerStart: [400, 400], waves: [[[760, 760]]] });
    // Tick 1: move east at full stick.
    e.step([makeCommand({ owner: 0, tick: 1, moveBrad: 0 as never, moveMag: 255, buttons: 0 })]);
    const p = e.state.players[0]!;
    expect(p.vx).toBeGreaterThan(0);
    // Tick 2: no command → idle-hold stops the player (design/08 idle default).
    e.step([]);
    expect(p.vx).toBe(0);
    expect(p.vy).toBe(0);
  });
});

describe('ENGINE_VERSION guard (design/08: fail loud, never replay garbage)', () => {
  it('ReplayInputSource refuses a version mismatch', () => {
    const stale: Replay = { version: ENGINE_VERSION - 1, config: ARENA, commands: [] };
    expect(() => new ReplayInputSource(stale)).toThrow(/version/i);
  });

  it('accepts a matching version', () => {
    const ok: Replay = { version: ENGINE_VERSION, config: ARENA, commands: [] };
    expect(() => new ReplayInputSource(ok)).not.toThrow();
  });

  it('a replay source is read-only', () => {
    const src = new ReplayInputSource({ version: ENGINE_VERSION, config: ARENA, commands: [] });
    expect(() => src.submit()).toThrow();
  });
});

describe('runHeadless (shared authoritative loop)', () => {
  it('drives a scripted run to a deterministic gameover', () => {
    const cfg: EngineConfig = { seed: 9, worldW: 400, worldH: 400, playerStart: [200, 200], waves: [[[280, 200]]] };
    const src = new LocalInputSource();
    for (let t = 1; t <= 600; t++) {
      src.submit(makeCommand({ owner: 0, tick: t, moveBrad: 0 as never, moveMag: 0, buttons: Button.FIRE }));
    }
    const e = runHeadless(cfg, src, 600);
    expect(e.state.phase).toBe('gameover');
    expect(e.state.winner).toBe(0);
    // Same inputs, same seed → identical outcome hash on a second headless run.
    const src2 = new LocalInputSource();
    for (let t = 1; t <= 600; t++) {
      src2.submit(makeCommand({ owner: 0, tick: t, moveBrad: 0 as never, moveMag: 0, buttons: Button.FIRE }));
    }
    expect(hashState(runHeadless(cfg, src2, 600).state)).toBe(hashState(e.state));
  });
});

describe('serializeState: the deflect latch (ENGINE_VERSION 85)', () => {
  it('hashes a bullet that has turned back, and a bullet that has not as before the latch existed', () => {
    const e = createGameEngine(ARENA);
    const s = e.state;
    s.projectiles.push({
      id: s.nextId(), faction: 'player', teamId: 0, gx: toFp(0), gy: toFp(0), z: toFp(0), vx: toFp(0), vy: toFp(0),
      radius: toFp(1), damage: 1, damageType: 'physical', lifeTicks: 9, alive: true,
    });
    const row = () => (serializeState(s) as { projectiles: unknown[][] }).projectiles[0]!;
    const plain = row();
    const hashPlain = hashState(s);
    s.projectiles[0]!.deflected = true;
    expect(row()).toEqual([...plain, 1]); // appended, never folded into a field before it
    expect(hashState(s)).not.toBe(hashPlain);
  });
});

describe('serializeState: the bot flag (ENGINE_VERSION 88)', () => {
  it('hashes which seats are bots, since that decides whether a run with no person left ends', () => {
    const s = createGameEngine(ARENA).state;
    const before = hashState(s);
    expect(s.players[0]!.bot).toBe(false);
    s.players[0]!.bot = true;
    expect(hashState(s)).not.toBe(before);
    s.players[0]!.bot = false;
    expect(hashState(s)).toBe(before); // the flag alone moved it, nothing else did
  });
});

describe('serializeState: the portal choice (an endless boss floor, 2026-10-06)', () => {
  it('hashes which way a two-button portal is going, and is absent while no choice is open', () => {
    const s = createGameEngine(ARENA).state;
    const before = hashState(s);
    expect(s.portalChoice).toBeNull();
    expect(serializeState(s)).not.toHaveProperty('portalChoice'); // every finite floor's hash is unchanged
    s.portalChoice = 'descend';
    const descending = hashState(s);
    expect(descending).not.toBe(before);
    s.portalChoice = 'extract';
    expect(hashState(s)).not.toBe(descending); // two peers disagreeing on the way is a desync
    s.portalChoice = null;
    expect(hashState(s)).toBe(before);
  });
});
