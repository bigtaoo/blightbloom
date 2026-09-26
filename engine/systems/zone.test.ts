/**
 * ZoneSystem + EnvironmentSystem (design/15, ROADMAP 4.2d) — the room-graph BFS
 * shrink stage machine and the per-actor zone/hazard-tile damage it drives. The
 * pure BFS/safe-set math is unit-tested in isolation in content/arenas.test.ts;
 * this file proves the STAGE MACHINE's tick-by-tick behavior and its effect on
 * actors through GameState.
 */
import { describe, it, expect } from 'vitest';
import { toFpGrid } from '@dd/engine/content/convert';
import { createGameState } from '@dd/engine/state/GameState';
import type { GameState } from '@dd/engine/state/GameState';
import { ZoneSystem, EnvironmentSystem } from '@dd/engine/systems';
import type { ArenaMap } from '@dd/engine/content/arenas';

const LINEAR_MAP: ArenaMap = {
  id: 'linear_test',
  sizeGrid: { w: 30, h: 10 },
  rooms: [
    { id: 'A', rectGrid: { x: 0, y: 0, w: 10, h: 10 }, solids: [] },
    { id: 'B', rectGrid: { x: 10, y: 0, w: 10, h: 10 }, solids: [] },
    { id: 'C', rectGrid: { x: 20, y: 0, w: 10, h: 10 }, solids: [] },
  ],
  doors: [
    { roomA: 'A', roomB: 'B', passageGrid: { x: 10, y: 4, w: 1, h: 2 } },
    { roomA: 'B', roomB: 'C', passageGrid: { x: 20, y: 4, w: 1, h: 2 } },
  ],
  spawns: [{ x: 5, y: 5 }],
  eyeCandidates: [{ roomId: 'A' }], // one candidate — deterministic draw regardless of seed
};

function arenaState(): GameState {
  return createGameState({ seed: 1, worldW: 0, worldH: 0, waves: [], arena: LINEAR_MAP });
}

/** Tick `sys` until `predicate()` is true; fails loudly instead of hanging forever
 * if the stage machine never reaches the expected state (a real bug, not a slow test). */
function tickUntil(sys: ZoneSystem, s: GameState, predicate: () => boolean, maxTicks = 5000): void {
  for (let i = 0; i < maxTicks; i++) {
    sys.tick(s);
    if (predicate()) return;
  }
  throw new Error(`tickUntil: predicate never became true within ${maxTicks} ticks`);
}

describe('ZoneSystem — no-op outside arena mode', () => {
  it('never initializes state.zone for a plain (non-arena) config', () => {
    const s = createGameState({ seed: 1, worldW: 800, worldH: 600, waves: [] });
    new ZoneSystem().tick(s);
    new ZoneSystem().tick(s);
    expect(s.zone).toBeUndefined();
  });
});

describe('ZoneSystem — eye draw + initial state', () => {
  it('draws the only eyeCandidate and starts with every reachable room safe', () => {
    const s = arenaState();
    new ZoneSystem().tick(s); // first tick only initializes — no transition yet
    expect(s.zone).toBeDefined();
    expect(s.zone!.eye).toBe('A');
    expect(s.zone!.stage).toBe(0);
    expect(s.zone!.phase).toBe('hold');
    expect(s.zone!.safe).toEqual(['A', 'B', 'C']);
    expect(s.zone!.escalation).toBe(0);
  });
});

describe('ZoneSystem — full stage progression', () => {
  it('shrinks stage by stage (WARN telegraphs, then CLOSE applies), then escalates forever at the final stage', () => {
    const s = arenaState();
    const sys = new ZoneSystem();
    sys.tick(s); // init

    // Stage 0 -> WARN (room C, at the outer dist=2 ring, is about to close).
    tickUntil(sys, s, () => s.zone!.phase === 'warn');
    expect(s.zone!.stage).toBe(0);
    expect(s.zone!.closing).toEqual(['C']);
    const warnEvent = s.events.find((e) => e.type === 'zone_warn');
    expect(warnEvent).toMatchObject({ type: 'zone_warn', stage: 1, closing: ['C'] });

    // WARN -> CLOSE: stage advances to 1, safe shrinks to {A, B}.
    tickUntil(sys, s, () => s.zone!.stage === 1);
    expect(s.zone!.phase).toBe('hold');
    expect(s.zone!.safe).toEqual(['A', 'B']);
    const closeEvent = s.events.find((e) => e.type === 'zone_close');
    expect(closeEvent).toMatchObject({ type: 'zone_close', stage: 1 });

    // Stage 1 -> WARN again (room B is next to close) -> CLOSE -> stage 2, safe={A} only.
    tickUntil(sys, s, () => s.zone!.phase === 'warn' && s.zone!.stage === 1);
    expect(s.zone!.closing).toEqual(['B']);
    tickUntil(sys, s, () => s.zone!.stage === 2);
    expect(s.zone!.safe).toEqual(['A']);

    // Final stage (only the eye room safe): no further shrink, only escalating damage.
    expect(s.zone!.escalation).toBe(0);
    tickUntil(sys, s, () => s.zone!.escalation === 1);
    expect(s.zone!.stage).toBe(2); // unchanged — no more shrinking
    expect(s.zone!.safe).toEqual(['A']); // unchanged
    tickUntil(sys, s, () => s.zone!.escalation === 2);
    expect(s.zone!.stage).toBe(2); // still unchanged after a second escalation cycle
  });
});

describe('EnvironmentSystem — zone damage', () => {
  it('does not damage an actor standing in a currently-safe room', () => {
    const s = arenaState();
    new ZoneSystem().tick(s); // stage 0: every room safe
    const p = s.players[0]!;
    p.gx = toFpGrid(25); // inside room C (x 20..30)
    p.gy = toFpGrid(5);
    const hpBefore = p.hp;
    new EnvironmentSystem().tick(s);
    expect(p.hp).toBe(hpBefore);
    expect(p.roomId).toBe('C');
  });

  it('damages an actor standing in a room the zone has already closed', () => {
    const s = arenaState();
    const zoneSys = new ZoneSystem();
    zoneSys.tick(s); // init
    tickUntil(zoneSys, s, () => s.zone!.stage === 1); // now only {A, B} are safe
    const p = s.players[0]!;
    p.gx = toFpGrid(25); // still in room C — now poisoned
    p.gy = toFpGrid(5);
    const poolBefore = p.hp + p.shield; // shield absorbs first (design/07) — check the total pool
    new EnvironmentSystem().tick(s);
    expect(p.hp + p.shield).toBeLessThan(poolBefore);
    const dmgEvent = s.events.find((e) => e.type === 'zone_damage');
    expect(dmgEvent).toMatchObject({ type: 'zone_damage', target: p.id });
    const hitEvent = s.events.find((e) => e.type === 'hit' && e.faction === 'environment');
    expect(hitEvent).toBeDefined();
  });

  it('leaves a downed player alone in a closed room (downed = invulnerable, design/07 3.2; v77)', () => {
    const s = arenaState();
    const zoneSys = new ZoneSystem();
    zoneSys.tick(s);
    tickUntil(zoneSys, s, () => s.zone!.stage === 1);
    const p = s.players[0]!;
    p.gx = toFpGrid(25); // room C, poisoned
    p.gy = toFpGrid(5);
    p.downed = true;
    p.hp = 0;
    const shieldBefore = p.shield;
    new EnvironmentSystem().tick(s);
    expect(p.hp).toBe(0);
    expect(p.shield).toBe(shieldBefore);
    expect(s.events.some((e) => e.type === 'zone_damage' || e.type === 'hit')).toBe(false);
    expect(p.roomId).toBe('C'); // still tracked: a revive can stand them back up in there
    // Control: the same body, stood back up, is damaged on the very next tick.
    p.downed = false;
    p.hp = 5;
    new EnvironmentSystem().tick(s);
    expect(s.events.some((e) => e.type === 'zone_damage' && e.target === p.id)).toBe(true);
  });

  it('updates roomId as an actor crosses from one room into the next', () => {
    const s = arenaState();
    new ZoneSystem().tick(s);
    const p = s.players[0]!;
    p.gx = toFpGrid(5); // room A
    p.gy = toFpGrid(5);
    new EnvironmentSystem().tick(s);
    expect(p.roomId).toBe('A');
    p.gx = toFpGrid(15); // room B
    new EnvironmentSystem().tick(s);
    expect(p.roomId).toBe('B');
  });
});

describe('EnvironmentSystem — cell trait damage', () => {
  const mapWithTrait: ArenaMap = {
    ...LINEAR_MAP,
    rooms: [
      { ...LINEAR_MAP.rooms[0]!, cellTraits: [{ id: 'spike1', rectGrid: { x: 4, y: 4, w: 2, h: 2 }, kind: 'spike', timed: false, damage: 2 }] },
      LINEAR_MAP.rooms[1]!,
      LINEAR_MAP.rooms[2]!,
    ],
  };

  it('damages an actor standing on an always-on hazard tile', () => {
    const s = createGameState({ seed: 1, worldW: 0, worldH: 0, waves: [], arena: mapWithTrait });
    new ZoneSystem().tick(s); // zone stage 0 — room A is safe, so any damage here is the TRAIT, not the zone
    const p = s.players[0]!;
    p.gx = toFpGrid(5); // inside the spike tile (4..6, 4..6)
    p.gy = toFpGrid(5);
    const poolBefore = p.hp + p.shield; // shield absorbs first (design/07)
    new EnvironmentSystem().tick(s);
    expect(p.hp + p.shield).toBe(poolBefore - 2);
  });

  it('does not damage an actor clear of the hazard tile', () => {
    const s = createGameState({ seed: 1, worldW: 0, worldH: 0, waves: [], arena: mapWithTrait });
    new ZoneSystem().tick(s);
    const p = s.players[0]!;
    p.gx = toFpGrid(1); // far corner of room A, clear of the tile at (4..6, 4..6)
    p.gy = toFpGrid(1);
    const hpBefore = p.hp;
    new EnvironmentSystem().tick(s);
    expect(p.hp).toBe(hpBefore);
  });
});
