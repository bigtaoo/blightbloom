// A sim-only PvP bot that backs off to let its shield refill (volume 128): the shipped
// `PvpBotController`, except that a seat whose shield is spent walks away from the nearest
// opponent until the shield is back to `exitFrac` of its pool. It exists to answer one question:
// whether the juggernaut's lead in bot-vs-bot FFA (volume 127) is the character or the bot. The
// shipped bot never disengages, and the juggernaut is the one character with no shield to refill.
//
// Unlike the shipped bot it keeps state (whether it is backing off), which is fine for a sim
// command source and is why it is not a candidate for `PvpBotController` as written.
import type { GameState, PlayerCommand } from '@dd/engine';
import { PvpBotController } from '../../src/game/controllers/PvpBotController';
import { FIRE_RANGE_FP, type Point } from '../../src/game/controllers/ai/engage';
import { steer } from '../../src/game/controllers/ai/steer';
import { zoneRetreatCommand } from '../../src/game/controllers/ai/zoneRetreat';

/** How far ahead, in fp, the point it walks toward lies. */
const AWAY_FP = 4000;

export interface RetreatStats {
  /** Times a seat started backing off. */
  entries: number;
  /** Seat-ticks spent backing off, the zone's own retreat excluded. */
  ticks: number;
  /** Shield points regained while backing off. */
  regained: number;
}

export class ShieldRetreatBot {
  private readonly base = new PvpBotController();
  private retreating = false;
  private lastShield = 0;

  constructor(
    private readonly exitFrac: number,
    private readonly stats: RetreatStats,
  ) {}

  build(s: GameState, owner: number, tick: number): PlayerCommand {
    const cmd = this.base.build(s, owner, tick);
    const me = s.players[owner];
    if (!me || !me.alive || me.downed || me.maxShield === 0) return cmd;
    if (!this.retreating && me.shield === 0) {
      this.retreating = true;
      this.stats.entries++;
    }
    if (this.retreating && me.shield >= Math.ceil(me.maxShield * this.exitFrac)) this.retreating = false;
    if (this.retreating && me.shield > this.lastShield) this.stats.regained += me.shield - this.lastShield;
    this.lastShield = me.shield;
    if (!this.retreating) return cmd;
    // The zone still comes first: its walk is the shipped bot's, and so is the fire.
    const opponents: Point[] = s.players.filter((p) => p !== me && p.alive && !p.downed && p.teamId !== me.teamId);
    if (zoneRetreatCommand(s, owner, tick, me, opponents)) return cmd;
    this.stats.ticks++;
    let near: Point | undefined;
    let d = Infinity;
    for (const p of opponents) {
      const dd = Math.hypot(p.gx - me.gx, p.gy - me.gy);
      if (dd < d) [d, near] = [dd, p];
    }
    // Nobody within twice fire range: stand, so the shield's idle timer runs.
    if (!near || d > 2 * FIRE_RANGE_FP) return { ...cmd, moveMag: 0 };
    // Straight away, else 45 degrees off it either side, else square to it; the fight's own
    // move when a wall blocks all five.
    const ux = (me.gx - near.gx) / (d || 1);
    const uy = (me.gy - near.gy) / (d || 1);
    for (const [ax, ay] of [[ux, uy], [ux - uy, uy + ux], [ux + uy, uy - ux], [-uy, ux], [uy, -ux]] as const) {
      const move = steer(s, me, [{ gx: me.gx + ax * AWAY_FP, gy: me.gy + ay * AWAY_FP }]);
      if (move) return { ...cmd, ...move };
    }
    return cmd;
  }
}
