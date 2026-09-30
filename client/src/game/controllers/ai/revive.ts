// Where a bot walks to revive a downed squadmate (volume 118): shared by the shipped
// `PvpBotController` and the sim's `ArenaBotController`, so the two measure the same rule.
import { FP_SCALE, REVIVE_RANGE_GRID, type GameState, type PlayerActor } from '@dd/engine';
import { toFpGrid } from '@dd/engine/content/convert';
import { FIRE_RANGE_FP, type Point } from './engage';
import { lineOfFireClear } from './lineOfFire';
import { HOLD, steer, type Move } from './steer';

/** How far the bot walks to a downed squadmate. A squad drops together (volume 118), so a
 *  mate going down is usually close; a longer walk crosses the fight to get there. */
export const REVIVE_DETOUR_FP = 12 * FP_SCALE;
/** How far off its path a seat with no bandage walks to a floor one. */
export const BANDAGE_DETOUR_FP = 8 * FP_SCALE;
const REVIVE_RANGE_FP = toFpGrid(REVIVE_RANGE_GRID);
/** How close inside that reach the bot stands before it stops walking. Stopping at the edge let
 *  any shove end the channel: in the first sweep 30 of 76 broken channels were a reviver a hair
 *  outside the reach, at a median of 25 of the 450 ticks. */
export const REVIVE_SNUG_FP = toFpGrid(REVIVE_RANGE_GRID / 3);

export interface ReviveGoal {
  kind: 'mate' | 'bandage';
  gx: number;
  gy: number;
  /** Holding INTERACT here counts: the reach `canRevive` measures, centre to centre. */
  inReach: boolean;
  /** Standing well inside that reach: stop walking. */
  snug: boolean;
  /** The body's channel so far (`reviveProgressTicks`); 0 for a bandage. */
  progress: number;
}

/**
 * Where the revive rule walks: the nearest downed squadmate within `REVIVE_DETOUR_FP` when the
 * seat can pay for the revive (an arena one costs a bandage, a PvE one nothing), else the
 * nearest floor bandage within `BANDAGE_DETOUR_FP`.
 */
export function reviveGoal(s: GameState, me: PlayerActor): ReviveGoal | undefined {
  const canPay = !s.zoneEnabled || me.bandages > 0;
  if (canPay) {
    let mate: PlayerActor | undefined;
    let d = REVIVE_DETOUR_FP;
    for (const p of s.players) {
      if (p === me || !p.alive || !p.downed || p.teamId !== me.teamId) continue;
      const dd = dist(me, p);
      if (dd <= d) (d = dd), (mate = p);
    }
    if (!mate) return undefined;
    const bodies = me.radius + mate.radius;
    return { kind: 'mate', gx: mate.gx, gy: mate.gy, inReach: d <= REVIVE_RANGE_FP + bodies, snug: d <= REVIVE_SNUG_FP + bodies, progress: mate.reviveProgressTicks };
  }
  let best: { gx: number; gy: number } | undefined;
  let d = BANDAGE_DETOUR_FP;
  for (const item of s.pickups) {
    if (!item.alive || item.kind !== 'bandage') continue;
    const dd = dist(me, item);
    if (dd <= d) (d = dd), (best = item);
  }
  return best && { kind: 'bandage', gx: best.gx, gy: best.gy, inReach: false, snug: false, progress: 0 };
}

/**
 * This tick's revive move, or undefined when the rule has nothing to do and the fight goes on:
 * walk to the body (firing as usual on the way), then hold INTERACT from well inside the reach.
 * A seat with no bandage for an arena revive walks to a floor one instead, while nothing it aims
 * at is in range (`aimInRange`). `interact` is the INTERACT hold; the engine clears a reviver's
 * FIRE (ENGINE_VERSION 86), so a caller sends one or the other.
 *
 * A reviver cannot shoot back, so the rule does not START a channel while an opponent has a
 * clear shot in fire range; once the body's channel is running with this seat in reach, it
 * holds to the end. Measured on 30 eight-seat matches (volume 118, "A reviver cannot attack"):
 * reviving whatever came gave 21 revives; backing off whenever an opponent showed gave 17 and
 * 372 broken channels, the bot letting go each time an opponent strafed into view; this rule
 * gave 24 and 10.
 */
export function reviveMove(s: GameState, me: PlayerActor, opponents: readonly Point[], aimInRange: boolean): { move: Move; interact: boolean } | undefined {
  const goal = reviveGoal(s, me);
  if (!goal) return undefined;
  if (goal.kind === 'bandage') return aimInRange ? undefined : { move: steer(s, me, [goal]) ?? HOLD, interact: false };
  const started = goal.inReach && goal.progress > 0;
  if (!started && opponents.some((o) => dist(me, o) <= FIRE_RANGE_FP && lineOfFireClear(s, me, o))) return undefined;
  return { move: goal.snug ? HOLD : (steer(s, me, [goal]) ?? HOLD), interact: goal.inReach };
}

function dist(a: { gx: number; gy: number }, b: { gx: number; gy: number }): number {
  return Math.hypot(b.gx - a.gx, b.gy - a.gy);
}
