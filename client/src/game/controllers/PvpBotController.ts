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
import { Button, FP_SCALE, makeCommand, quantizeMove, type GameState, type PlayerCommand } from '@dd/engine';
import { nearestHostile } from '@dd/engine/systems/targeting';
import { engageNearest, FIRE_RANGE_FP, idleCommand, KEEP_DIST_FP, type Point } from './ai/engage';
import { yieldsFire } from './ai/fireYield';
import { lineOfFireClear, pointClear } from './ai/lineOfFire';
import { reviveMove } from './ai/revive';
import { nextRoomToward, walkIntoRoom } from './ai/roomRoute';
import { BODY_CLEAR_FP, HOLD, reachable, steer, type Move } from './ai/steer';
import { roomIsUnsafe, zoneRetreatCommand } from './ai/zoneRetreat';

export class PvpBotController {
  /** @param revives walk to a downed squadmate and hold the revive (volume 118). Off only for
   *  the sims that measure a squad without it. */
  constructor(private readonly opts: { revives?: boolean } = {}) {}

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
    // Whether to pull is decided on what the gun POINTS at, which is not always the opponent
    // being chased: the engine turns every player to its nearest hostile, mob or seat
    // (`ApplyInputSystem`). A shot the pillar or wall in between would eat is not fired
    // (`ai/lineOfFire.ts`); in range is tested first, since out of it nothing is fired anyway.
    const aim = nearestHostile(s, me, me.gx, me.gy);
    // Nor one that would only meet the opponent's own coming down the same line: of two seats
    // trading shots head-on, one holds for a turn (`ai/fireYield.ts`).
    const fire = aim !== null && within(me, aim) && lineOfFireClear(s, me, aim) && !yieldsFire(s, me, aim, tick) ? Button.FIRE : 0;
    // A downed squadmate next, ahead of any fight (volume 118): walk over firing as usual, then
    // hold INTERACT from well inside the reach. The engine holds a reviver's fire
    // (ENGINE_VERSION 86), so the button is not sent with it. A seat with no bandage for an
    // arena revive walks to a floor one instead, while nothing it aims at is in range.
    const rescue = this.opts.revives === false ? undefined : reviveMove(s, me, opponents, aim !== null && within(me, aim));
    if (rescue) return makeCommand({ owner, tick, ...rescue.move, buttons: rescue.interact ? Button.INTERACT : fire });
    const target = nearest(me, opponents);
    const inRange = target !== undefined && within(me, target);
    const clear = inRange && lineOfFireClear(s, me, target);
    // Mobs in its own room are fought before an opponent further off, and with no opponent
    // left standing: they fight back, and a bot that only ever aimed at seats stood among them
    // until they killed it. With seats spawned apart, 2-seat matches were decided by mobs and
    // the zone, the seats dealing each other almost nothing (2026-09-29). An opponent with a
    // clear shot still comes first.
    // Its own room is the whole field on a map without rooms. Only a mob it can shoot from here
    // or walk to: a few spawned in pockets no body can enter (a free-standing block's brim closes
    // a one-grid corridor), and walking at one of those pinned a seat to the block for good. The
    // launch arena places nothing there since ENGINE_VERSION 80 (`content/arenaBodyReach.ts`);
    // the filter stays for any map that does.
    const mob = clear ? undefined : mobToFight(s, me);
    if (mob) return makeCommand({ owner, tick, ...holdAndFight(s, me, mob, owner, tick), buttons: fire });
    const cmd = engageNearest(owner, tick, me, opponents);
    if (!cmd || !target) return idleCommand(owner, tick);
    if (roomIsUnsafe(s, target.roomId)) return { ...cmd, moveMag: 0, buttons: fire };
    // An opponent in another room is walked to through the doors (2026-09-29), firing only
    // where a doorway gives a clear shot. Until seats spawned apart the whole lobby started
    // in one room, so the straight-line chase never met a wall; with real spawns it stood
    // 3 grid from an opponent on the far side of one and fired into it for the rest of the match.
    const route = routeToRoom(s, me, target.roomId);
    if (route) return makeCommand({ owner, tick, moveBrad: route.moveBrad, moveMag: route.moveMag, buttons: fire });
    if (!inRange) return makeCommand({ owner, tick, ...(steer(s, me, [target]) ?? HOLD), buttons: fire });
    return makeCommand({ owner, tick, ...holdAndFight(s, me, target, owner, tick), buttons: fire });
  }
}

/** The nearest live mob in `me`'s room that it can shoot from where it stands or walk to.
 *  Nearest first, and the path search only until one passes: it is the costly test. */
function mobToFight(s: GameState, me: Point & { roomId?: string }): Point | undefined {
  const here = s.enemies.filter((e) => e.alive && e.roomId === me.roomId);
  here.sort((a, b) => (a.gx - me.gx) ** 2 + (a.gy - me.gy) ** 2 - ((b.gx - me.gx) ** 2 + (b.gy - me.gy) ** 2) || a.id - b.id);
  return here.find((e) => lineOfFireClear(s, me, e) || reachable(s, me, e));
}

/** Fire range, in fp: the one test both the opponent and whatever the gun points at share. */
function within(me: Point, t: Point): boolean {
  return Math.hypot(t.gx - me.gx, t.gy - me.gy) <= FIRE_RANGE_FP;
}

/**
 * The move against a target in reach, seat or mob: close to the spacing ring, strafe once
 * there, and step out from behind a solid when the line to it is blocked.
 */
function holdAndFight(s: GameState, me: Point, target: Point, owner: number, tick: number): ReturnType<typeof quantizeMove> {
  const dx = target.gx - me.gx;
  const dy = target.gy - me.gy;
  if (within(me, target) && !lineOfFireClear(s, me, target)) return sidestep(s, me, target) ?? strafe(s, me, target, owner, tick);
  if (Math.hypot(dx, dy) > KEEP_DIST_FP) return steer(s, me, [target]) ?? strafe(s, me, target, owner, tick);
  return strafe(s, me, target, owner, tick);
}

/** The move toward room `to` along safe rooms, or null when `me` is already there, the rooms
 *  are unknown, or no safe path exists (then the straight-line chase stands). */
function routeToRoom(s: GameState, me: Point & { roomId?: string }, to: string | undefined): ReturnType<typeof walkIntoRoom> | null {
  const map = s.arenaMap;
  const from = me.roomId;
  if (!map || from === undefined || to === undefined || from === to) return null;
  const step = nextRoomToward(map, from, (id) => id === to, (id) => !roomIsUnsafe(s, id));
  return step === undefined ? null : walkIntoRoom(s, map, me, from, step);
}

/** Distances of the sidestep candidates from the bot, across the line to its target, nearest
 *  first: a small pillar clears in 2 grid, a wide one needs more. */
const SIDESTEP_REACH_FP = [2 * FP_SCALE, 4 * FP_SCALE];

/**
 * The move out from behind a solid, within the target's room: straight to the nearest of the
 * points `SIDESTEP_REACH_FP` to either side of the line to it where a body can stand and walk to
 * and a shot gets through (north first, then west). With none, it walks at the target itself
 * (`ai/steer.ts`), which brings it round the solid; null when it cannot get
 * there either. (It used to circle sideways at close range instead, and a seat wedged between a
 * block and a pillar pushed into the pillar for the rest of the match.)
 */
function sidestep(s: GameState, me: Point, target: Point): Move | null {
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
      if (pointClear(s, c.gx, c.gy, BODY_CLEAR_FP, true) && lineOfFireClear(s, me, c, BODY_CLEAR_FP, true) && lineOfFireClear(s, c, target)) {
        return quantizeMove(c.gx - me.gx, c.gy - me.gy);
      }
    }
  }
  return steer(s, me, [target]);
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
