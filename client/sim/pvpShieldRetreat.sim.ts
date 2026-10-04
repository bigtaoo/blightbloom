/**
 * Is the juggernaut's bot-vs-bot lead the character or the bot? (volume 128)
 *
 * Volume 127 found the juggernaut winning about 1.4x its seat share in FFA. The shipped bot never
 * disengages, so a shield never gets its idle time to refill, and the juggernaut is the one
 * character with no shield. This plays the same matches as `pvpBalanceSim.sim.ts` (same config,
 * same deconfoundings, 2 to 6 seats) three ways: the shipped bot, and `pvp/ShieldRetreatBot` with
 * a spent shield backing off until it is half full, or full.
 *
 * Not in `test:sims`: it is an instrument for one question, not a gate on the build. Run it via
 * `npm run test:pvp-shield`; `PVP_SHIELD_BLOCKS` sets the 150-match blocks per condition
 * (default 2; volume 128's table is 6).
 */
import { describe, expect, it } from 'vitest';
import { createGameEngine, type GameState, type PlayerCommand } from '@dd/engine';
import { buildPvpEngineConfig } from '../src/game/match/pvpConfig';
import { PvpBotController } from '../src/game/controllers/PvpBotController';
import { idleCommand } from '../src/game/controllers/ai/engage';
import { countsTowardShare, fairShares, type ShareInput } from './pvp/fairShare';
import { deconfoundSkinSeating, MAX_START_DELAY, startDelays } from './pvp/matchSetup';
import { ShieldRetreatBot, type RetreatStats } from './pvp/ShieldRetreatBot';

const PLAYER_COUNTS = [2, 3, 4, 5, 6];
const SEEDS_PER_COUNT = 30;
const MAX_TICKS = 20000;
const BLOCKS = Number(process.env.PVP_SHIELD_BLOCKS ?? 2);
/** Block 0 is `pvpBalanceSim.sim.ts`'s own seeds; the rest are fresh. */
const blockBase = (b: number) => (b === 0 ? 1_000_000 : 7_000_000 + b * 1_000_000);

type Bot = { build(s: GameState, owner: number, tick: number): PlayerCommand };
interface Condition {
  name: string;
  bot: (stats: RetreatStats) => Bot;
}
const CONDITIONS: Condition[] = [
  { name: 'shipped', bot: () => new PvpBotController() },
  { name: 'backs off to half', bot: (st) => new ShieldRetreatBot(0.5, st) },
  { name: 'backs off to full', bot: (st) => new ShieldRetreatBot(1, st) },
];

interface Match extends ShareInput {
  ticks: number;
}

function runMatch(seed: number, playerCount: number, makeBot: () => Bot): Match {
  const config = deconfoundSkinSeating(buildPvpEngineConfig(seed, playerCount), seed);
  const engine = createGameEngine(config);
  const bots = Array.from({ length: playerCount }, makeBot);
  const delays = startDelays(seed, playerCount, MAX_START_DELAY);
  let ticks = 0;
  while (engine.state.phase !== 'gameover' && ticks < MAX_TICKS) {
    const t = engine.state.tick + 1;
    engine.step(bots.map((b, seat) => (t <= delays[seat]! ? idleCommand(seat, t) : b.build(engine.state, seat, t))));
    ticks++;
  }
  const w = engine.state.players.findIndex((p) => p.alive);
  return { playerCount, ticks, winnerSkin: w >= 0 ? config.players![w]!.skinId! : 'tie', skins: config.players!.map((p) => p.skinId!) };
}

const ratio = (rows: readonly ShareInput[], skin: string) => {
  const x = fairShares(rows).get(skin)!;
  return x.wins / x.fair;
};

describe('PvP shield retreat (does the juggernaut lead come from a bot that never disengages?)', () => {
  it('plays the same matches with the shipped bot and one that backs off to refill its shield', () => {
    const juggernaut = new Map<string, number>();
    for (const c of CONDITIONS) {
      const stats: RetreatStats = { entries: 0, ticks: 0, regained: 0 };
      const rows: Match[] = [];
      const perBlock: string[] = [];
      for (let b = 0; b < BLOCKS; b++) {
        const block: Match[] = [];
        for (const pc of PLAYER_COUNTS) for (let i = 0; i < SEEDS_PER_COUNT; i++) block.push(runMatch(blockBase(b) + pc * 10_000 + i, pc, () => c.bot(stats)));
        rows.push(...block);
        perBlock.push([...fairShares(block)].map(([k, x]) => `${k} ${(x.wins / x.fair).toFixed(2)}`).join(' '));
      }
      expect(rows.filter((r) => r.ticks >= MAX_TICKS), c.name).toEqual([]);
      juggernaut.set(c.name, ratio(rows, 'juggernaut'));
      const avg = Math.round(rows.reduce((n, r) => n + r.ticks, 0) / rows.length);
      // eslint-disable-next-line no-console
      console.log(
        `\n${c.name}: ${rows.length} matches, ${rows.filter(countsTowardShare).length} decided, avg ${avg} ticks\n` +
          perBlock.map((l, b) => `  block ${b}: ${l}`).join('\n') +
          `\n  all: ${[...fairShares(rows)].map(([k, x]) => `${k} ${x.wins}/${x.fair.toFixed(1)} = ${(x.wins / x.fair).toFixed(2)}`).join(', ')}` +
          (c.name === 'shipped' ? '' : `\n  backed off ${stats.entries} times, ${stats.ticks} seat-ticks, ${stats.regained} shield regained`),
      );
      // The instrument: a retreat condition whose bot never backed off measured nothing.
      if (c.name !== 'shipped') expect(stats.regained, c.name).toBeGreaterThan(0);
    }
    // Volume 128's finding, held: backing off takes the juggernaut's lead away. At 2 blocks the
    // shipped bot reads 1.33 and backing off to full 0.98.
    expect(juggernaut.get('shipped')! - juggernaut.get('backs off to full')!).toBeGreaterThan(0.2);
  }, 3_600_000);
});
