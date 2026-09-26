/**
 * What a party IS FOR, and how big that lets it get (2026-09-26, co-op room codes) — the one
 * definition, shared by the server that caps membership and the client that draws `1/2`.
 *
 * A party used to mean a PvP squad and nothing else, so its cap was simply `SQUAD_SIZE`. A
 * co-op party fills a co-op room, which has {@link COOP_SEATS} seats, and a third friend in a
 * co-op party is a friend the matchmaker would have to leave behind. So the cap is a function
 * of the mode, and it lives here — beside `roomCode.ts`, imported by the server through
 * `server/src/config.ts` — for the reason that file gives: two copies of the number cannot be
 * held in agreement by a test on either side.
 */
import { SQUAD_SIZE } from './pvpConfig';

/** The two things a party can queue for. Spelled the same as the server's `MatchMode`. */
export type PartyMode = 'coop' | 'pvp';

/** Seats in a co-op room. `onlineConnect.ts` asks `/find` for exactly this many. */
export const COOP_SEATS = 2;

/** The most members a party of this mode may hold: a whole co-op room, or one PvP squad. */
export function partyCapacity(mode: PartyMode): number {
  return mode === 'coop' ? COOP_SEATS : SQUAD_SIZE;
}

/** A request's `mode` field, read the way every route reads it: only `'coop'` is co-op.
 *  Absent or unknown is `'pvp'` — the only kind of party that existed before this field. */
export function parsePartyMode(raw: unknown): PartyMode {
  return raw === 'coop' ? 'coop' : 'pvp';
}
