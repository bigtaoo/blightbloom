/**
 * The PvP bot's movement and targeting once seats spawned apart (2026-09-29, second pass):
 * `ai/steer.ts` walks round what the engine's body would hit, and the bot fights what its gun
 * points at, mobs included. Each end-to-end case is a shape that pinned a seat in the balance
 * sim, and fails with the rule removed.
 */
import { describe, expect, it } from 'vitest';
import { createGameEngine } from '@dd/engine/GameEngine';
import { createGameState, type GameState } from '@dd/engine/state/GameState';
import { Button } from '@dd/engine/state/commands';
import { makeCommand } from '@dd/engine/state/input';
import { BRAD_FULL } from '@dd/engine/math/trig';
import type { ArenaMap } from '@dd/engine/content/arenas';
import { PvpBotController } from './PvpBotController';
import { pointClear } from './ai/lineOfFire';
import { walkIntoRoom } from './ai/roomRoute';
import { BODY_CLEAR_FP, reachable, steer } from './ai/steer';

const PX = 1000 / 32; // fp per px
const CFG = { seed: 3, worldW: 1600, worldH: 1200, waves: [] as const };
const fp = (x: number, y: number) => ({ gx: Math.round(x * PX), gy: Math.round(y * PX) });
const dirOf = (brad: number) => ({ x: Math.cos((brad / BRAD_FULL) * Math.PI * 2), y: Math.sin((brad / BRAD_FULL) * Math.PI * 2) });
type Extra = { obstacles?: [number, number, number][]; walls?: [number, number, number, number][] };
type Step = (s: GameState) => { moveBrad: number; moveMag: number } | null;

function field(extra: Extra = {}): GameState {
  return createGameState({ ...CFG, ...extra, players: [{ start: [100, 100], teamId: 0 }] });
}

/** Walk a lone seat toward `goal` (px), `step` choosing each tick's move; the final distance, in grid. */
function walk(extra: Extra, from: [number, number], goal: [number, number], ticks: number, step: Step): number {
  // One mob parked in the far corner: a flat run with no enemy left is won on tick 1.
  const engine = createGameEngine({ ...CFG, ...extra, waves: [[[1550, 1150]]], players: [{ start: from, teamId: 0 }] });
  const s = engine.state;
  const g = fp(...goal);
  for (let t = 1; t <= ticks; t++) {
    const m = step(s) ?? { moveBrad: 0, moveMag: 0 };
    engine.step([makeCommand({ owner: 0, tick: t, moveBrad: m.moveBrad as never, moveMag: m.moveMag, buttons: 0 })]);
  }
  const p = s.players[0]!;
  return Math.hypot(p.gx - g.gx, p.gy - g.gy) / 1000;
}

const steered = (goal: [number, number]): Step => (s) => steer(s, s.players[0]!, [fp(...goal)]);
const straight = (goal: [number, number]): Step => (s) => {
  const p = s.players[0]!;
  const g = fp(...goal);
  const a = Math.atan2(g.gy - p.gy, g.gx - p.gx) / (Math.PI * 2);
  return { moveBrad: Math.round((a * BRAD_FULL + BRAD_FULL) % BRAD_FULL), moveMag: 255 };
};

describe('pointClear — a body is stopped where a shot is not', () => {
  it("counts a free-standing block's north brim for a body only", () => {
    const s = field({ walls: [[400, 400, 128, 32]] });
    s.walls[0]!.freeStanding = true;
    const above = fp(464, 400 - 24); // three quarters of a grid north of the authored edge
    expect(pointClear(s, above.gx, above.gy)).toBe(true);
    expect(pointClear(s, above.gx, above.gy, BODY_CLEAR_FP)).toBe(true);
    expect(pointClear(s, above.gx, above.gy, BODY_CLEAR_FP, true)).toBe(false);
    s.walls[0]!.freeStanding = false; // a perimeter wall has no brim
    expect(pointClear(s, above.gx, above.gy, BODY_CLEAR_FP, true)).toBe(true);
  });
});

describe('steer', () => {
  const bar: Extra = { walls: [[540, 240, 20, 320]] }; // a bar across the straight line

  it('goes straight when the way is clear, and round a bar when it is not', () => {
    expect(dirOf(steer(field(), fp(400, 400), [fp(700, 400)])!.moveBrad).x).toBeGreaterThan(0.99);
    expect(Math.abs(dirOf(steer(field(bar), fp(400, 400), [fp(700, 400)])!.moveBrad).y)).toBeGreaterThan(0.3);
  });

  it('gets a body round the bar end to end, where walking straight stays pinned to it', () => {
    const goal: [number, number] = [700, 400];
    expect(walk(bar, [400, 400], goal, 600, steered(goal))).toBeLessThan(1);
    expect(walk(bar, [400, 400], goal, 600, straight(goal))).toBeGreaterThan(4);
  });

  it('passes a gap exactly one body wide, off the straight line', () => {
    // Two walls, the world's full height, leave a 32 px (one grid) slot at y 400-432: the only
    // way through. The goal is not level with it.
    const slot: Extra = { walls: [[540, 0, 20, 400], [540, 432, 20, 768]] };
    expect(walk(slot, [400, 250], [700, 600], 900, steered([700, 600]))).toBeLessThan(1);
  });

  it('walks up to a goal no body can get to, then holds there; reachable says no', () => {
    const box: Extra = { walls: [[640, 340, 120, 16], [640, 444, 120, 16], [640, 340, 16, 120], [744, 340, 16, 120]] };
    const s = field(box);
    expect(reachable(s, fp(400, 400), fp(700, 400))).toBe(false);
    expect(reachable(field(), fp(400, 400), fp(700, 400))).toBe(true);
    // As close as a body gets (a shot may get in where a body cannot), then null: nothing to walk.
    expect(dirOf(steer(s, fp(400, 400), [fp(700, 400)])!.moveBrad).x).toBeGreaterThan(0.9);
    const goal: [number, number] = [700, 400];
    expect(walk(box, [400, 400], goal, 400, steered(goal))).toBeLessThan(3);
    expect(steer(s, fp(640 - 17, 400), [fp(700, 400)])).toBeNull();
  });
});

describe('walkIntoRoom', () => {
  const map = {
    id: 'pair',
    sizeGrid: { w: 20, h: 10 },
    spawns: [],
    eyeCandidates: [],
    rooms: [
      { id: 'A', rectGrid: { x: 0, y: 0, w: 10, h: 10 }, solids: [] },
      { id: 'B', rectGrid: { x: 10, y: 0, w: 10, h: 10 }, solids: [] },
    ],
    doors: [{ roomA: 'A', roomB: 'B', passageGrid: { x: 9, y: 3, w: 2, h: 4 } }],
  } as unknown as ArenaMap;
  const g = (x: number, y: number) => ({ gx: x * 1000, gy: y * 1000 });

  it('walks round a pillar on the passage axis, and straight through once inside the passage', () => {
    expect(dirOf(walkIntoRoom(field(), map, g(4, 5), 'A', 'B').moveBrad).x).toBeGreaterThan(0.99);
    const pillar = field({ obstacles: [[7 * 32, 5 * 32, 20]] });
    expect(Math.abs(dirOf(walkIntoRoom(pillar, map, g(4, 5), 'A', 'B').moveBrad).y)).toBeGreaterThan(0.2);
    // Inside the passage but off its centre line: on through it, not back to the centre.
    expect(dirOf(walkIntoRoom(field(), map, g(9.5, 3.4), 'A', 'B').moveBrad).x).toBeGreaterThan(0.99);
  });
});

describe('PvpBotController — what it fights', () => {
  const bot = new PvpBotController();
  /** One seat, an opponent far out of range, and optionally a mob, in one open field, one tick in. */
  function withMob(mob: [number, number] | undefined, extra: Extra = {}, opponent: [number, number] = [420, 1100]): GameState {
    const waves = mob ? [[mob]] : [[[1550, 1150] as [number, number]]];
    const engine = createGameEngine({ ...CFG, ...extra, waves, players: [{ start: [400, 400], teamId: 0 }, { start: opponent, teamId: 1 }] });
    engine.step([0, 1].map((owner) => makeCommand({ owner, tick: 1, moveBrad: 0 as never, moveMag: 0, buttons: 0 }))); // the wave spawns
    return engine.state;
  }

  it('fires at a mob its gun points at, with every opponent out of range', () => {
    expect(bot.build(withMob([560, 400]), 0, 5).buttons & Button.FIRE).toBeTruthy();
    expect(bot.build(withMob(undefined), 0, 5).buttons & Button.FIRE).toBe(0);
  });

  it('keeps fighting a mob once no opponent is left standing', () => {
    const s = withMob([560, 400]);
    s.players[1]!.downed = true;
    expect(bot.build(s, 0, 5).buttons & Button.FIRE).toBeTruthy();
    const quiet = withMob(undefined);
    quiet.players[1]!.downed = true;
    expect(bot.build(quiet, 0, 5).buttons & Button.FIRE).toBe(0); // only the parked mob, far off
  });

  it('leaves a mob no body can reach and no shot can see, and goes on toward the opponent', () => {
    const box: Extra = { walls: [[1000, 340, 120, 16], [1000, 444, 120, 16], [1000, 340, 16, 120], [1104, 340, 16, 120]] };
    // The opponent off to the south-east, so heading for it is neither the way to the mob (east)
    // nor a strafe across that line (north or south).
    const sealed = dirOf(bot.build(withMob([1060, 400], box, [1100, 1100]), 0, 5).moveBrad);
    expect(sealed.x).toBeGreaterThan(0.5);
    expect(sealed.y).toBeGreaterThan(0.5);
    expect(dirOf(bot.build(withMob([1060, 400], {}, [1100, 1100]), 0, 5).moveBrad).x).toBeGreaterThan(0.9); // east, at the mob
  });
});
