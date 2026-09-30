/**
 * `yieldsFire` — of two seats trading shots head-on, which one holds this tick (2026-09-30).
 * The last case is the reason for it: two bots with the same gun, nothing between them, and
 * every bullet meeting the other's halfway until one of them takes a turn.
 */
import { describe, it, expect } from 'vitest';
import { createGameEngine } from '@dd/engine/GameEngine';
import { createGameState } from '@dd/engine/state/GameState';
import { buildRunSpecs, SABER_SIM } from '@dd/engine';
import { PvpBotController } from '../PvpBotController';
import { YIELD_BLOCK, yieldsFire } from './fireYield';

const CFG = { seed: 3, worldW: 1600, worldH: 1200, waves: [] as const };

function duel(extra: { start: [number, number]; teamId: number }[] = []) {
  const s = createGameState({
    ...CFG,
    players: [{ start: [400, 400], teamId: 0 }, { start: [520, 400], teamId: 1 }, ...extra],
  });
  s.players[1]!.firing = true;
  return s;
}

describe('yieldsFire', () => {
  it('holds on its own turn while the rival shoots at it, and the rival holds on the next', () => {
    const s = duel();
    const [a, b] = [s.players[0]!, s.players[1]!];
    expect(yieldsFire(s, a, b, 0)).toBe(true); // block 0: the lower teamId holds
    expect(yieldsFire(s, a, b, YIELD_BLOCK)).toBe(false);
    a.firing = true;
    expect(yieldsFire(s, b, a, YIELD_BLOCK)).toBe(true);
    expect(yieldsFire(s, b, a, 0)).toBe(false);
  });

  it('does not hold for a rival that is not pulling the trigger', () => {
    const s = duel();
    s.players[1]!.firing = false;
    expect(yieldsFire(s, s.players[0]!, s.players[1]!, 0)).toBe(false);
  });

  it('does not hold for a rival shooting at someone else', () => {
    const s = duel([{ start: [560, 400], teamId: 2 }]); // nearer to seat 1 than seat 0 is
    expect(yieldsFire(s, s.players[0]!, s.players[1]!, 0)).toBe(false);
  });

  it('does not hold for a rival with a blade in hand', () => {
    const s = duel();
    s.players[1]!.weapon = buildRunSpecs([SABER_SIM])[0]!;
    expect(yieldsFire(s, s.players[0]!, s.players[1]!, 0)).toBe(false);
  });

  it('does not hold for a mob or a teammate', () => {
    const s = duel([{ start: [440, 400], teamId: 0 }]);
    const mob = { gx: 0, gy: 0, teamId: -1 };
    expect(yieldsFire(s, s.players[0]!, mob, 0)).toBe(false);
    s.players[2]!.firing = true;
    expect(yieldsFire(s, s.players[0]!, s.players[2]!, 0)).toBe(false);
  });

  it('lets two bots with the same gun hurt each other', () => {
    const engine = createGameEngine({
      ...CFG,
      waves: [[[1550, 1150]]], // one mob far off keeps the match from ending on tick 1
      players: [{ start: [400, 400], teamId: 0 }, { start: [520, 400], teamId: 1 }],
    });
    const s = engine.state;
    const bot = new PvpBotController();
    const health = () => s.players.map((p) => p.hp + p.shield);
    const before = health();
    let clashes = 0;
    for (let t = 1; t <= 4 * YIELD_BLOCK; t++) {
      engine.step(s.players.map((_p, i) => bot.build(s, i, t)));
      clashes += s.events.filter((e) => e.type === 'clash').length;
    }
    // Both are hit (shield first), each on its turn; and they did trade head-on, or this pins nothing.
    const after = health();
    expect(after[0]).toBeLessThan(before[0]!);
    expect(after[1]).toBeLessThan(before[1]!);
    expect(clashes).toBeGreaterThan(0);
  });
});
