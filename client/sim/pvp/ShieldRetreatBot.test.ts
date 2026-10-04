/**
 * `ShieldRetreatBot` — the sim-only bot that backs off to refill its shield (volume 128). The
 * finding that the juggernaut's lead is the shipped bot's doing rests on this policy doing what
 * the volume says, so each rule is pinned here: it backs off only once the shield is spent, stays
 * backed off until the shield is back to `exitFrac` of its pool, walks away from a near opponent
 * and stands when nobody is near, never touches a seat with no shield, and keeps firing throughout.
 */
import { describe, expect, it } from 'vitest';
import { createGameState } from '@dd/engine/state/GameState';
import { Button } from '@dd/engine/state/commands';
import { BRAD_FULL } from '@dd/engine/math/trig';
import { PvpBotController } from '../../src/game/controllers/PvpBotController';
import { ShieldRetreatBot, type RetreatStats } from './ShieldRetreatBot';

const CFG = { seed: 3, worldW: 1600, worldH: 1200, waves: [] as const };
const shipped = new PvpBotController();

/** Seat 0 with a 10-point shield pool, its opponent `dx` px due east. */
function duel(dx: number, shield: number) {
  const s = createGameState({
    ...CFG,
    players: [{ start: [100, 400], teamId: 0 }, { start: [100 + dx, 400], teamId: 1 }],
  });
  s.players[0]!.maxShield = 10;
  s.players[0]!.shield = shield;
  return s;
}

function fresh(exitFrac = 1): { bot: ShieldRetreatBot; stats: RetreatStats } {
  const stats: RetreatStats = { entries: 0, ticks: 0, regained: 0 };
  return { bot: new ShieldRetreatBot(exitFrac, stats), stats };
}

/** The move's east component: negative is walking away from an opponent due east. */
const east = (moveBrad: number) => Math.cos((moveBrad / BRAD_FULL) * Math.PI * 2);

describe('ShieldRetreatBot', () => {
  it('plays the shipped bot exactly while its shield has anything left', () => {
    const s = duel(220, 1);
    const { bot, stats } = fresh();
    expect(bot.build(s, 0, 5)).toEqual(shipped.build(s, 0, 5));
    expect(stats).toEqual({ entries: 0, ticks: 0, regained: 0 });
  });

  it('once the shield is spent, walks away from a near opponent and keeps firing', () => {
    const s = duel(220, 0);
    const { bot, stats } = fresh();
    const cmd = bot.build(s, 0, 5);
    // Control: the shipped bot, same state, closes in.
    expect(east(shipped.build(s, 0, 5).moveBrad)).toBeGreaterThan(0);
    expect(cmd.moveMag).toBeGreaterThan(0);
    expect(east(cmd.moveBrad)).toBeLessThan(0);
    expect(cmd.buttons & Button.FIRE).toBeTruthy();
    expect(stats).toEqual({ entries: 1, ticks: 1, regained: 0 });
  });

  it('stands still when nobody is within twice fire range, so the idle timer runs', () => {
    const s = duel(1400, 0);
    const { bot, stats } = fresh();
    expect(bot.build(s, 0, 5).moveMag).toBe(0);
    expect(stats.ticks).toBe(1);
  });

  it('stays backed off until the shield is back to exitFrac of its pool, then re-engages', () => {
    const s = duel(220, 0);
    const { bot, stats } = fresh(0.5);
    bot.build(s, 0, 5);
    s.players[0]!.shield = 4; // under ceil(10 * 0.5): still backing off
    expect(east(bot.build(s, 0, 6).moveBrad)).toBeLessThan(0);
    s.players[0]!.shield = 5; // at the threshold: back to the shipped bot
    expect(bot.build(s, 0, 7)).toEqual(shipped.build(s, 0, 7));
    expect(stats).toEqual({ entries: 1, ticks: 2, regained: 4 });
  });

  it('counts one entry per spent shield, not one per tick spent backing off', () => {
    const s = duel(220, 0);
    const { bot, stats } = fresh();
    for (let t = 0; t < 5; t++) bot.build(s, 0, t);
    expect(stats.entries).toBe(1);
    s.players[0]!.shield = 10;
    bot.build(s, 0, 5);
    s.players[0]!.shield = 0;
    bot.build(s, 0, 6);
    expect(stats.entries).toBe(2);
  });

  it('leaves a seat with no shield pool to the shipped bot (the juggernaut)', () => {
    const s = duel(220, 0);
    s.players[0]!.maxShield = 0;
    const { bot, stats } = fresh();
    expect(bot.build(s, 0, 5)).toEqual(shipped.build(s, 0, 5));
    expect(stats.entries).toBe(0);
  });

  it('leaves a downed seat to the shipped bot', () => {
    const s = duel(220, 0);
    s.players[0]!.downed = true;
    const { bot, stats } = fresh();
    expect(bot.build(s, 0, 5)).toEqual(shipped.build(s, 0, 5));
    expect(stats.entries).toBe(0);
  });
});
