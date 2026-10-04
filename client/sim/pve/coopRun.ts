/**
 * One co-op PvE run, headless: the level sim's bot on seat 0 standing in for the player, and the
 * shipped `AllyController` on seat 1 exactly as `GameLoop` drives it (`ally.build(s, 1, 0, t)`).
 * Built for `coopRevive.sim.ts` (2026-10-03): the ally has revived a downed leader since volume
 * 118, and no run had ever measured what that buys.
 *
 * The config is `buildDungeonRunConfig({ coop: true })`, the function `Game.beginRun` calls, so
 * the run is the one pressing START in co-op plays.
 *
 * The leader bot stands in for a human, and has no revive of its own. `leaderRevives` lays the
 * ally's shipped rule (`ai/revive.ts`) over it: a stand-in for a player who always goes back for
 * the ally, the upper bound of what a human's revives buy.
 */
import { Button, createGameEngine, makeCommand, type GameState, type PlayerCommand } from '@dd/engine';
import { reviveMove } from '../../src/game/controllers/ai/revive';
import { buildDungeonRunConfig } from '../../src/game/match/offlineConfig';
import { AllyController } from '../../src/game/controllers/AllyController';
import { BOT_PROFILES, PveBotController } from './PveBotController';

/** Same runaway guard as the solo level sim. */
const MAX_TICKS = 40_000;

export interface CoopSeat {
  downs: number;
  /** Downs with the other seat still up: the only ones a revive could answer. A seat that goes
   *  down second ends the run (`WinConditionSystem`, nobody up). */
  downsMateUp: number;
  revived: number;
  bledOut: number;
}

export interface CoopRun {
  seed: number;
  /** `extracted` and `wiped` are the engine's own ends. `stranded`: the leader bled out with the
   *  ally still up. Any standing seat may open the portal since ENGINE_VERSION 87, but the ally
   *  never opens one itself (it only confirms), so such a run can never extract; it is cut there
   *  rather than played out to the guard. Since ENGINE_VERSION 88 the ally's seat is flagged a
   *  bot and the engine ends that run as a wipe on the same tick, so `stranded` should never
   *  be read: `coopRevive.sim.ts` gates it at 0. */
  outcome: 'extracted' | 'wiped' | 'stranded' | 'timeout';
  ticks: number;
  floorReached: number;
  /** [leader, ally]. */
  seats: [CoopSeat, CoopSeat];
  /** Seat-ticks of a valid revive channel running. */
  channelTicks: number;
  /** Big chests opened: one plate per seat, so each needs the ally on a plate. */
  bigChests: number;
}

export interface CoopOptions {
  seed: number;
  profileName?: keyof typeof BOT_PROFILES;
  /** The ally's revive rule; `false` is the control. */
  allyRevives?: boolean;
  /** The ally's held-back fight (`ai/holdBack.ts`); `false` is the ally that charged the nearest
   *  enemy anywhere on the floor. */
  allyHoldsBack?: boolean;
  /** The ally's revive rule laid over the leader too. */
  leaderRevives?: boolean;
  maxTicks?: number;
}

export function runCoop(opts: CoopOptions): CoopRun {
  const engine = createGameEngine(
    buildDungeonRunConfig({ seed: opts.seed, coop: true, localSeat: { skinId: 'vanguard', loadout: [] }, allySkinId: 'juggernaut' }),
  );
  const leader = new PveBotController(BOT_PROFILES[opts.profileName ?? 'careful']);
  const ally = new AllyController({ revives: opts.allyRevives, holdsBack: opts.allyHoldsBack });
  const s = engine.state;
  const seats: [CoopSeat, CoopSeat] = [fresh(), fresh()];
  let channelTicks = 0;
  let bigChests = 0;
  let outcome: CoopRun['outcome'] = 'timeout';
  let ticks = 0;

  while (ticks < (opts.maxTicks ?? MAX_TICKS)) {
    const t = s.tick + 1;
    const wasDowned = s.players.map((p) => p.downed);
    const lead = leader.build(s, 0, t);
    engine.step([opts.leaderRevives ? reviving(s, t) ?? lead : lead, ally.build(s, 1, 0, t)]);
    ticks++;
    s.players.forEach((p, i) => {
      if (wasDowned[i] || !p.downed) return;
      seats[i as 0 | 1].downs++;
      if (s.players.some((q) => q !== p && q.alive && !q.downed)) seats[i as 0 | 1].downsMateUp++;
    });
    for (const e of s.events) {
      if (e.type === 'chest_open' && e.kind === 'big') bigChests++;
      const i = s.players.findIndex((p) => p.id === (e as { id?: number }).id);
      if (i < 0) continue;
      if (e.type === 'revived') seats[i as 0 | 1].revived++;
      else if (e.type === 'death' && e.faction === 'player') seats[i as 0 | 1].bledOut++;
    }
    for (const p of s.players) if (p.downed && p.reviveProgressTicks > 0) channelTicks++;
    if (s.phase === 'gameover') {
      outcome = s.winner === 'enemies' ? 'wiped' : 'extracted';
      break;
    }
    if (stranded(s)) {
      outcome = 'stranded';
      break;
    }
  }
  return { seed: opts.seed, outcome, ticks, floorReached: s.floorIndex, seats, channelTicks, bigChests };
}

/** The leader's revive move, `AllyController`'s rule verbatim, or undefined to play on. */
function reviving(s: GameState, tick: number): PlayerCommand | undefined {
  const me = s.players[0]!;
  if (!me.alive || me.downed) return undefined;
  const rescue = reviveMove(s, me, s.enemies.filter((e) => e.alive), false);
  return rescue && makeCommand({ owner: 0, tick, ...rescue.move, buttons: rescue.interact ? Button.INTERACT : 0 });
}

function fresh(): CoopSeat {
  return { downs: 0, downsMateUp: 0, revived: 0, bledOut: 0 };
}

/** The leader is gone and the ally is up: nobody left can take the portal. */
function stranded(s: GameState): boolean {
  return !s.players[0]!.alive && s.players.some((p) => p.alive && !p.downed);
}
