/**
 * The PvP bot once seats spawn apart (2026-09-29): it only fires a shot that would arrive
 * (`ai/lineOfFire.ts`), steps out from behind a solid, walks to an opponent in another room
 * (`ai/roomRoute.ts`), and strafes while it holds its spacing. Each was the cause of a match in
 * the balance sim that ran 20,000 ticks without a winner, so each end-to-end case below is the
 * shape that stalled, and fails with the rule removed.
 */
import { describe, expect, it } from 'vitest';
import { createGameEngine } from '@dd/engine/GameEngine';
import { createGameState, type GameState } from '@dd/engine/state/GameState';
import { Button } from '@dd/engine/state/commands';
import { BRAD_FULL } from '@dd/engine/math/trig';
import { PvpBotController } from './PvpBotController';
import { lineOfFireClear } from './ai/lineOfFire';
import { nextRoomToward } from './ai/roomRoute';

const CFG = { seed: 3, worldW: 1600, worldH: 1200, waves: [] as const };
const bot = new PvpBotController();
const dirOf = (brad: number) => ({ x: Math.cos((brad / BRAD_FULL) * Math.PI * 2), y: Math.sin((brad / BRAD_FULL) * Math.PI * 2) });

/** Two hostile seats at `a` and `b` (px), with optional pillars and walls between them. */
function duel(a: [number, number], b: [number, number], extra: { obstacles?: [number, number, number][]; walls?: [number, number, number, number][] } = {}): GameState {
  return createGameState({ ...CFG, ...extra, players: [{ start: a, teamId: 0 }, { start: b, teamId: 1 }] });
}

describe('lineOfFireClear', () => {
  it('is blocked by a pillar or a wall on the line, and not by one beside it', () => {
    const me = { gx: 12_500, gy: 12_500 };
    const them = { gx: 22_500, gy: 12_500 };
    expect(lineOfFireClear(duel([400, 400], [720, 400]), me, them)).toBe(true);
    expect(lineOfFireClear(duel([400, 400], [720, 400], { obstacles: [[560, 400, 24]] }), me, them)).toBe(false);
    expect(lineOfFireClear(duel([400, 400], [720, 400], { walls: [[550, 300, 16, 200]] }), me, them)).toBe(false);
    expect(lineOfFireClear(duel([400, 400], [720, 400], { obstacles: [[560, 480, 24]] }), me, them)).toBe(true);
  });
});

describe('PvpBotController — what it can see', () => {
  it('holds fire at an opponent behind a pillar, and steps out sideways', () => {
    const s = duel([400, 400], [620, 400], { obstacles: [[510, 400, 30]] });
    const cmd = bot.build(s, 0, 5);
    expect(cmd.buttons & Button.FIRE).toBe(0);
    expect(cmd.moveMag).toBeGreaterThan(0);
    expect(Math.abs(dirOf(cmd.moveBrad).y)).toBeGreaterThan(0.5); // across the line, not into the pillar
    // Control: no pillar, same spot, and it fires.
    expect(bot.build(duel([400, 400], [620, 400]), 0, 5).buttons & Button.FIRE).toBeTruthy();
  });

  it('strafes the other way when a wall is right beside it', () => {
    // Opponent due east; the first-choice side at this tick is +y (south), so a wall there
    // must send it north.
    const open = bot.build(duel([400, 400], [500, 400]), 0, 5);
    const first = Math.sign(dirOf(open.moveBrad).y);
    const wallY = first > 0 ? 420 : 364;
    const blocked = bot.build(duel([400, 400], [500, 400], { walls: [[300, wallY, 300, 16]] }), 0, 5);
    expect(Math.sign(dirOf(blocked.moveBrad).y)).toBe(-first);
  });

  it('flips its strafe every period, and two seats are not in step', () => {
    const s = duel([400, 400], [500, 400]);
    const sides = [0, 45, 90].map((t) => Math.sign(dirOf(bot.build(s, 0, t).moveBrad).y));
    expect(sides[0]).toBe(-sides[1]!);
    expect(sides[1]).toBe(-sides[2]!);
  });
});

describe('PvpBotController — end to end, the three stalls', () => {
  function hitsBetween(extra: Parameters<typeof duel>[2], a: [number, number], b: [number, number], ticks: number): number {
    // One mob parked in the far corner: a flat run with no enemy left is won on tick 1.
    const engine = createGameEngine({ ...CFG, ...extra, waves: [[[1550, 1150]]], players: [{ start: a, teamId: 0 }, { start: b, teamId: 1 }] });
    const s = engine.state;
    const ids = s.players.map((p) => p.id);
    const bots = [new PvpBotController(), new PvpBotController()];
    let hits = 0; // a count, not an hp delta: the shield regenerates light damage away
    for (let t = 1; t <= ticks && s.phase !== 'gameover'; t++) {
      engine.step(bots.map((x, i) => x.build(s, i, t)));
      hits += s.events.filter((e) => e.type === 'hit' && ids.includes(e.target)).length;
    }
    return hits;
  }

  it('two same-gun bots inside their spacing do damage — standing still, every pair of bullets clashed', () => {
    expect(hitsBetween({}, [400, 400], [510, 400], 300)).toBeGreaterThan(0);
  });

  it('two bots with a pillar between them get round it and do damage', () => {
    expect(hitsBetween({ obstacles: [[505, 400, 40]] }, [400, 400], [610, 400], 600)).toBeGreaterThan(0);
  });
});

describe('nextRoomToward', () => {
  const map = {
    id: 'ring', sizeGrid: { w: 30, h: 20 }, spawns: [], eyeCandidates: [],
    rooms: ['A', 'B', 'C', 'D'].map((id, i) => ({ id, rectGrid: { x: i * 10, y: 0, w: 10, h: 10 }, solids: [] })),
    doors: [
      { roomA: 'A', roomB: 'B', passageGrid: { x: 10, y: 4, w: 1, h: 2 } },
      { roomA: 'B', roomB: 'C', passageGrid: { x: 20, y: 4, w: 1, h: 2 } },
      { roomA: 'A', roomB: 'D', passageGrid: { x: 0, y: 4, w: 1, h: 2 } },
      { roomA: 'D', roomB: 'C', passageGrid: { x: 30, y: 4, w: 1, h: 2 } },
    ],
  } as never;

  it('takes the first shortest path, and a longer one when a room on it may not be entered', () => {
    expect(nextRoomToward(map, 'A', (id) => id === 'C')).toBe('B');
    expect(nextRoomToward(map, 'A', (id) => id === 'C', (id) => id !== 'B')).toBe('D');
    expect(nextRoomToward(map, 'A', (id) => id === 'C', (id) => id === 'A')).toBeUndefined();
  });
});
