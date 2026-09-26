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
import { Button, makeCommand, quantizeMove, FP_SCALE, type GameState, type PlayerCommand } from '@dd/engine';
import { FIRE_RANGE_FP, type Point } from './engage';

/** A passage centre this close counts as reached, and the bot aims at the next room's centre. */
const GATE_REACHED_FP = FP_SCALE;

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
  const prev = new Map<string, string>([[from, from]]);
  const queue = [from];
  let goal: string | undefined;
  for (let head = 0; head < queue.length && goal === undefined; head++) {
    const cur = queue[head]!;
    for (const d of map.doors) {
      const next = d.roomA === cur ? d.roomB : d.roomB === cur ? d.roomA : undefined;
      if (next === undefined || prev.has(next)) continue;
      prev.set(next, cur);
      if (safe.has(next)) {
        goal = next;
        break;
      }
      queue.push(next);
    }
  }
  if (goal === undefined) return null;
  let step = goal;
  while (prev.get(step) !== from) step = prev.get(step)!;

  const door = map.doors.find((d) => (d.roomA === from && d.roomB === step) || (d.roomB === from && d.roomA === step))!;
  const gate = centre(door.passageGrid);
  const room = map.rooms.find((r) => r.id === step);
  const atGate = Math.hypot(gate.gx - me.gx, gate.gy - me.gy) <= GATE_REACHED_FP;
  const aim = atGate && room ? centre(room.rectGrid) : gate;
  const move = quantizeMove(aim.gx - me.gx, aim.gy - me.gy);
  const inRange = opponents.some((o) => Math.hypot(o.gx - me.gx, o.gy - me.gy) <= FIRE_RANGE_FP);
  return makeCommand({ owner, tick, moveBrad: move.moveBrad, moveMag: move.moveMag, buttons: inRange ? Button.FIRE : 0 });
}

function centre(r: { x: number; y: number; w: number; h: number }): Point {
  return { gx: Math.round((r.x + r.w / 2) * FP_SCALE), gy: Math.round((r.y + r.h / 2) * FP_SCALE) };
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
