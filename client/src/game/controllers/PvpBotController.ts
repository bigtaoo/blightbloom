// A deterministic PvP practice bot (design/15 follow-up — matchmaking bot backfill). It
// generalizes AllyController's "just another command source" pattern (design/08 "render
// only produces input") to the arena's every-seat-its-own-team shape: engage the
// nearest LIVING opponent (a different teamId — every real PvP seat has its own,
// AllyController.ts / buildOnlineConfig), and idle when none remain (an empty arena, or
// this bot is the last one standing). Pure function of GameState — no wall-clock/RNG —
// so it is reproducible: any two observers computing this from the SAME confirmed state
// at the SAME tick get the identical command, which is exactly what lets
// server/src/BotClient.ts drive a bot seat as a normal headless client, indistinguishable
// from a real one at the wire level (design/06).
import { type GameState, type PlayerCommand } from '@dd/engine';
import { engageNearest, idleCommand, type Point } from './ai/engage';
import { roomIsUnsafe, zoneRetreatCommand } from './ai/zoneRetreat';

export class PvpBotController {
  /** Build this bot seat's command for `tick`. */
  build(s: GameState, owner: number, tick: number): PlayerCommand {
    const me = s.players[owner];
    if (!me || !me.alive || me.downed) return idleCommand(owner, tick);

    // Nearest living opponent on a different team.
    const opponents: (Point & { roomId?: string })[] = [];
    for (const p of s.players) if (p !== me && p.alive && !p.downed && p.teamId !== me.teamId) opponents.push(p);

    // Out of the closing zone first (2026-09-26, `ai/zoneRetreat.ts`), then fight — but never
    // walk into the storm after someone: an opponent standing in an unsafe room is shot at
    // from where the bot stands, not chased.
    const retreat = zoneRetreatCommand(s, owner, tick, me, opponents);
    if (retreat) return retreat;
    const cmd = engageNearest(owner, tick, me, opponents);
    if (!cmd) return idleCommand(owner, tick);
    const target = nearest(me, opponents);
    if (target && roomIsUnsafe(s, target.roomId)) return { ...cmd, moveMag: 0 };
    return cmd;
  }
}

function nearest<T extends Point>(me: Point, pool: readonly T[]): T | undefined {
  let best: T | undefined;
  let d = Infinity;
  for (const p of pool) {
    const dd = (p.gx - me.gx) ** 2 + (p.gy - me.gy) ** 2;
    if (dd < d) {
      d = dd;
      best = p;
    }
  }
  return best;
}
