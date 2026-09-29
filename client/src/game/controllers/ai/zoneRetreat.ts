// Leave the closing zone (design/15) — the PvP bot's first rule, ahead of "engage the nearest
// opponent" (2026-09-26). Until then `PvpBotController` chased the nearest opponent wherever
// that led and never looked at the zone at all, so the character win rates the balance sim
// reported were partly a measurement of who survives standing in the storm — and the same
// bot fills empty seats in real matches (`server/src/BotClient.ts`). (The first reading,
// "three-quarters of all damage came from the zone", was inflated by the zone also ticking
// on DOWNED bodies — an engine bug fixed in v77; with both fixes the zone deals ~2.5%.)
//
// Pure function of GameState, like everything the bot does — the server recomputes a bot
// seat's command from confirmed state, so no memory and no randomness.
import { Button, makeCommand, type GameState, type PlayerCommand } from '@dd/engine';
import { FIRE_RANGE_FP, type Point } from './engage';
import { nextRoomToward, walkIntoRoom } from './roomRoute';

/**
 * A command walking `me` toward the nearest room that will still be safe, or `null` when its
 * room is fine (or there is no zone, or no way out — then the caller fights as before).
 *
 * "Unsafe" is the room not being in `zone.safe`, or — during a WARN — being one of the rooms
 * about to close, because walking out only once the damage starts costs the whole walk in
 * damage. It still fires at an opponent in range on the way; facing is the engine's.
 */
export function zoneRetreatCommand(
  s: GameState,
  owner: number,
  tick: number,
  me: Point & { roomId?: string },
  opponents: readonly Point[],
): PlayerCommand | null {
  const zone = s.zone;
  const map = s.arenaMap;
  const from = me.roomId;
  if (!zone || !map || from === undefined) return null;
  const closing = zone.phase === 'warn' ? new Set(zone.closing) : new Set<string>();
  const safe = new Set(zone.safe.filter((id) => !closing.has(id)));
  if (safe.has(from) || safe.size === 0) return null;

  // Breadth-first over the door graph to the nearest room that stays safe.
  const step = nextRoomToward(map, from, (id) => safe.has(id));
  if (step === undefined) return null;
  const move = walkIntoRoom(map, me, from, step);
  const inRange = opponents.some((o) => Math.hypot(o.gx - me.gx, o.gy - me.gy) <= FIRE_RANGE_FP);
  return makeCommand({ owner, tick, moveBrad: move.moveBrad, moveMag: move.moveMag, buttons: inRange ? Button.FIRE : 0 });
}

/**
 * Whether a room is one the bot should not walk INTO right now — outside `zone.safe`, or
 * closing during a WARN. `false` with no zone at all. Used to stop the chase at the edge of
 * the safe area: without it the bot left the storm and then followed the nearest opponent
 * straight back out into it.
 */
export function roomIsUnsafe(s: GameState, roomId: string | undefined): boolean {
  const zone = s.zone;
  if (!zone || roomId === undefined) return false;
  if (zone.phase === 'warn' && zone.closing.includes(roomId)) return true;
  return !zone.safe.includes(roomId);
}
