// When the PvP bot holds its fire so a duel can be decided (2026-09-30). Hostile bullets that
// meet cancel (`HitResolveSystem`'s clash), and the engine aims every seat at its nearest
// hostile's CURRENT position (`ApplyInputSystem`), so two seats that fire on the same tick fire
// down one segment from its two ends, and the bullets meet halfway however the two are moving.
// Two bots holding the trigger with the same gun fire on the same ticks for good: a 2-seat
// match of the capacity sim strafed round one room for 20,000 ticks, 330 clashes every 2,000
// and not one hit landed.
//
// The rule: while a rival seat has its gun on this bot and its trigger held, one of the two
// holds. Which one alternates every `YIELD_BLOCK` ticks, ordered by teamId, so each takes its
// turn being shot at and neither is favoured. A seat shooting at someone else, or not shooting,
// is no reason to hold, so a bot fighting a mob, or one of several seats, is untouched.
//
// Pure function of GameState, like everything the bot does.
import { nearestHostile } from '@dd/engine/systems/targeting';
import type { GameState, PlayerActor } from '@dd/engine';

/** Ticks each seat of a pair holds (or fires) before they swap: over a blaster bullet's flight
 *  across the bot's whole fire range (11 grid at 10 grid/s is 33 ticks), so a turn outlasts
 *  the bullets already in the air. */
export const YIELD_BLOCK = 60;

/**
 * True when `me` should not fire at `aim` this tick: `aim` is a rival seat holding a gun's
 * trigger with `me` as its nearest hostile, and it is `me`'s turn to hold.
 */
export function yieldsFire(s: GameState, me: PlayerActor, aim: { teamId: number }, tick: number): boolean {
  const rival = s.players.find((p) => p === aim);
  if (!rival || rival.teamId === me.teamId || !rival.firing || rival.weapon?.spec.kind !== 'ranged') return false;
  const holdsNow = Math.floor(tick / YIELD_BLOCK) % 2 === 0 ? me.teamId < rival.teamId : me.teamId > rival.teamId;
  return holdsNow && nearestHostile(s, rival, rival.gx, rival.gy) === me;
}
