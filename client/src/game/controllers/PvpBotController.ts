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
import { FP_SCALE, makeCommand, quantizeMove, type GameState, type PlayerCommand } from '@dd/engine';
import { engageNearest, FIRE_RANGE_FP, idleCommand, type Point } from './ai/engage';
import { lineOfFireClear, pointClear } from './ai/lineOfFire';
import { nextRoomToward, walkIntoRoom } from './ai/roomRoute';
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
    const target = nearest(me, opponents)!;
    // A shot the pillar or wall in between would eat is not fired (`ai/lineOfFire.ts`). Only
    // tested in range: out of it nothing is fired anyway.
    const inRange = Math.hypot(target.gx - me.gx, target.gy - me.gy) <= FIRE_RANGE_FP;
    const clear = inRange && lineOfFireClear(s, me, target);
    const fire = clear ? cmd.buttons : 0;
    if (roomIsUnsafe(s, target.roomId)) return { ...cmd, moveMag: 0, buttons: fire };
    // An opponent in another room is walked to through the doors (2026-09-29), firing only
    // where a doorway gives a clear shot. Until seats spawned apart the whole lobby started
    // in one room, so the straight-line chase never met a wall; with real spawns it stood
    // 3 grid from an opponent on the far side of one and fired into it for the rest of the match.
    const route = routeToRoom(s, me, target.roomId);
    if (route) return makeCommand({ owner, tick, moveBrad: route.moveBrad, moveMag: route.moveMag, buttons: fire });
    if (!inRange) return cmd;
    if (clear) return cmd.moveMag === 0 ? { ...cmd, ...strafe(s, me, target, owner, tick) } : cmd;
    // Same room, something solid in between: step out from behind it.
    const side = sidestep(s, me, target);
    return makeCommand({ owner, tick, moveBrad: side.moveBrad, moveMag: side.moveMag, buttons: 0 });
  }
}

/** The move toward room `to` along safe rooms, or null when `me` is already there, the rooms
 *  are unknown, or no safe path exists (then the straight-line chase stands). */
function routeToRoom(s: GameState, me: Point & { roomId?: string }, to: string | undefined): ReturnType<typeof walkIntoRoom> | null {
  const map = s.arenaMap;
  const from = me.roomId;
  if (!map || from === undefined || to === undefined || from === to) return null;
  const step = nextRoomToward(map, from, (id) => id === to, (id) => !roomIsUnsafe(s, id));
  return step === undefined ? null : walkIntoRoom(map, me, from, step);
}

/** Distances of the sidestep candidates from the bot, across the line to its target, nearest
 *  first: a small pillar clears in 2 grid, a wide one needs more. */
const SIDESTEP_REACH_FP = [2 * FP_SCALE, 4 * FP_SCALE];

/**
 * The move out from behind a solid, within the target's room: to the nearest of the points
 * `SIDESTEP_REACH_FP` to either side of the line to it that has a clear shot and a clear path
 * from here (north first, then west). With none, it closes in, which
 * walks it round a pillar's rim and along a wall's face.
 */
function sidestep(s: GameState, me: Point, target: Point): ReturnType<typeof quantizeMove> {
  const dx = target.gx - me.gx;
  const dy = target.gy - me.gy;
  const len = Math.hypot(dx, dy) || 1;
  for (const reach of SIDESTEP_REACH_FP) {
    const sides = [1, -1].map((sign) => ({ gx: me.gx - (sign * dy * reach) / len, gy: me.gy + (sign * dx * reach) / len }));
    // North first, then west: a WORLD order, so two bots either side of one pillar pick the
    // same side of it. Choosing by their own left, they circled it in step for a whole match,
    // each always opposite the other.
    sides.sort((a, b) => a.gy - b.gy || a.gx - b.gx);
    for (const c of sides) {
      if (pointClear(s, c.gx, c.gy) && lineOfFireClear(s, me, c) && lineOfFireClear(s, c, target)) {
        return quantizeMove(c.gx - me.gx, c.gy - me.gy);
      }
    }
  }
  return len > FIRE_RANGE_FP / 4 ? quantizeMove(dx, dy) : quantizeMove(-dy, dx);
}

/** Ticks between strafe reversals, and the look-ahead that keeps a strafe off a wall. */
const STRAFE_PERIOD = 45;
const STRAFE_PROBE_FP = FP_SCALE;

/**
 * Sideways, while holding its spacing (2026-09-29). A bot that stood still traded shots down
 * one fixed line with an opponent doing the same, and two same-gun bots fire on the same ticks:
 * hostile bullets that meet cancel (`HitResolveSystem`'s clash), so every pair met halfway and
 * a 5-seat match ran 20,000 ticks with its last two seats unharmed. Moving turns the line
 * between shots. The side flips every `STRAFE_PERIOD` ticks, offset by seat so two bots do not
 * mirror each other, and a side with a solid right beside it is not taken.
 */
function strafe(s: GameState, me: Point, target: Point, owner: number, tick: number): ReturnType<typeof quantizeMove> {
  const dx = target.gx - me.gx;
  const dy = target.gy - me.gy;
  const len = Math.hypot(dx, dy) || 1;
  const first = Math.floor((tick + owner * 17) / STRAFE_PERIOD) % 2 === 0 ? 1 : -1;
  for (const sign of [first, -first]) {
    const px = (-sign * dy) / len;
    const py = (sign * dx) / len;
    if (pointClear(s, me.gx + px * STRAFE_PROBE_FP, me.gy + py * STRAFE_PROBE_FP)) return quantizeMove(px * FP_SCALE, py * FP_SCALE);
  }
  return { moveBrad: 0 as never, moveMag: 0 };
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
