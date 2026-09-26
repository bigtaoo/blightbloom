/**
 * PvpBotController — the PvP practice bot (design/15 follow-up). Mirrors ally.test.ts's
 * structure: verifies it engages the nearest LIVING opponent on a different team (fire in
 * range, hold spacing), ignores teammates and downed/dead seats, idles with no opponents
 * left, and — the point of it — that a real multi-seat engine SIMULATES the bot's commands
 * (a bot-controlled seat actually moves under its own control through step(), exactly like
 * AllyController's co-op counterpart). Facing is engine-decided (design/10 v33), not part
 * of the command.
 */
import { describe, it, expect } from 'vitest';
import { createGameEngine } from '@dd/engine/GameEngine';
import { createGameState } from '@dd/engine/state/GameState';
import { Button } from '@dd/engine/state/commands';
import { makeCommand } from '@dd/engine/state/input';
import { BRAD_FULL, type Brad } from '@dd/engine/math/trig';
import { PvpBotController } from './PvpBotController';

const bot = new PvpBotController();
const CFG = { seed: 3, worldW: 1600, worldH: 1200, waves: [] as const };

describe('PvpBotController — command generation', () => {
  it('fires on the nearest opposing-team seat, advancing while outside spacing', () => {
    const s = createGameState({
      ...CFG,
      players: [{ start: [400, 400], teamId: 0 }, { start: [620, 400], teamId: 1 }],
    });
    const cmd = bot.build(s, 0, 5); // ~6 grid east — in fire range, outside keep-dist
    expect(cmd.buttons & Button.FIRE).toBeTruthy();
    expect(cmd.moveMag).toBeGreaterThan(0);
  });

  it('holds position (stops advancing) once inside spacing but keeps firing', () => {
    const s = createGameState({
      ...CFG,
      players: [{ start: [400, 400], teamId: 0 }, { start: [500, 400], teamId: 1 }],
    });
    const cmd = bot.build(s, 0, 5); // ~2.5 grid east — inside keep-dist
    expect(cmd.buttons & Button.FIRE).toBeTruthy();
    expect(cmd.moveMag).toBe(0);
  });

  it('ignores a same-team seat and holds fire when no opponent remains', () => {
    const s = createGameState({
      ...CFG,
      players: [{ start: [400, 400], teamId: 0 }, { start: [420, 400], teamId: 0 }],
    });
    const cmd = bot.build(s, 0, 5);
    expect(cmd.buttons).toBe(0);
    expect(cmd.moveMag).toBe(0); // idle, not regroup — PvP has no leader concept
  });

  it('skips a downed/dead opponent and targets the next-nearest live one instead', () => {
    const s = createGameState({
      ...CFG,
      players: [
        { start: [400, 400], teamId: 0 },
        { start: [420, 400], teamId: 1 }, // nearest, but downed — must be ignored
        { start: [200, 400], teamId: 2 }, // farther but alive — the real target (due west)
      ],
    });
    s.players[1]!.downed = true;
    const cmd = bot.build(s, 0, 5);
    // Outside keep-dist, so it's advancing — moveBrad reveals which target was chosen.
    expect(cmd.moveBrad).toBe(BRAD_FULL / 2); // due west toward seat 2, not east toward seat 1
  });

  it('a downed bot issues an idle command (it cannot act)', () => {
    const s = createGameState({
      ...CFG,
      players: [{ start: [400, 400], teamId: 0 }, { start: [420, 400], teamId: 1 }],
    });
    s.players[0]!.downed = true;
    const cmd = bot.build(s, 0, 5);
    expect(cmd.moveMag).toBe(0);
    expect(cmd.buttons).toBe(0);
  });
});

describe('two-seat run: the bot actually drives its seat through step()', () => {
  it('closes the gap on the opposing seat under bot control (real engine simulation)', () => {
    const eng = createGameEngine({
      ...CFG,
      players: [{ start: [400, 400], teamId: 0 }, { start: [900, 400], teamId: 1 }],
    });

    const gapTo = () => Math.abs(eng.state.players[0]!.gx - eng.state.players[1]!.gx);
    const startGap = gapTo();
    for (let t = 1; t <= 40; t++) {
      const s = eng.state;
      const cmds = [bot.build(s, 0, t), bot.build(s, 1, t)];
      eng.step(cmds);
    }
    expect(gapTo()).toBeLessThan(startGap); // both bots closed toward each other
  });

  it('a bot with no live opponent left holds position (idle, not wandering)', () => {
    const eng = createGameEngine({
      ...CFG,
      players: [{ start: [400, 400], teamId: 0 }, { start: [900, 400], teamId: 1 }],
    });
    eng.state.players[1]!.alive = false; // last seat standing

    const startX = eng.state.players[0]!.gx;
    for (let t = 1; t <= 10; t++) {
      eng.step([bot.build(eng.state, 0, t), makeCommand({ owner: 1, tick: t, moveBrad: 0 as Brad, moveMag: 0, buttons: 0 })]);
    }
    expect(eng.state.players[0]!.gx).toBe(startX); // held position — no opponent to chase
  });
});

/**
 * The zone comes first (2026-09-26, `ai/zoneRetreat.ts`). Three rooms side by side, 10 grid
 * (320 px) each: A | B | C. Seats are placed in pixels and their `roomId` set by hand, the
 * way `EnvironmentSystem` would have left it.
 */
describe('PvpBotController — the closing zone', () => {
  const map = {
    id: 'corridor', sizeGrid: { w: 30, h: 20 }, spawns: [], eyeCandidates: [],
    rooms: ['A', 'B', 'C'].map((id, i) => ({ id, rectGrid: { x: i * 10, y: 0, w: 10, h: 20 }, solids: [] })),
    doors: [
      { roomA: 'A', roomB: 'B', passageGrid: { x: 10, y: 11, w: 1, h: 2 } },
      { roomA: 'B', roomB: 'C', passageGrid: { x: 20, y: 11, w: 1, h: 2 } },
    ],
  };
  function arena(meAt: [number, number], meRoom: string, themAt: [number, number], themRoom: string, safe: string[]) {
    const s = createGameState({ ...CFG, players: [{ start: meAt, teamId: 0 }, { start: themAt, teamId: 1 }] });
    (s as { arenaMap: unknown }).arenaMap = map; // read-only on GameState; set once at build
    s.zone = { eye: 'A', stage: 1, phase: 'hold', ticksToPhaseEnd: 100, safe, closing: [], escalation: 0 } as typeof s.zone;
    s.players[0]!.roomId = meRoom as never;
    s.players[1]!.roomId = themRoom as never;
    return s;
  }

  it('walks out of a closed room before it fights, even with an opponent to chase', () => {
    // Me in C (closed); the opponent is EAST of me, the way out is WEST.
    const cmd = bot.build(arena([800, 400], 'C', [920, 400], 'C', ['A', 'B']), 0, 5);
    expect(cmd.moveMag).toBeGreaterThan(0);
    expect(Math.cos((cmd.moveBrad / BRAD_FULL) * Math.PI * 2)).toBeLessThan(0); // west, away from them
    expect(cmd.buttons & Button.FIRE).toBeTruthy(); // still shooting on the way
  });

  it('shoots at an opponent standing in the storm but does not follow them into it', () => {
    // Me in B (safe), the opponent ~6 grid east in C (closed): in range, outside spacing.
    const into = bot.build(arena([500, 400], 'B', [700, 400], 'C', ['A', 'B']), 0, 5);
    expect(into.buttons & Button.FIRE).toBeTruthy();
    expect(into.moveMag).toBe(0);
    // Control: the same geometry with C still safe, and it advances as before.
    const chase = bot.build(arena([500, 400], 'B', [700, 400], 'C', ['A', 'B', 'C']), 0, 5);
    expect(chase.moveMag).toBeGreaterThan(0);
  });
});
