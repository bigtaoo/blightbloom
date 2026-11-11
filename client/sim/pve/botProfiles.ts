// The bot's skill profiles — the `BotProfile` shape and the `BOT_PROFILES` table, split out
// of `PveBotController.ts` (CLAUDE.md "500-line file convention", form ①: a self-contained
// table of constants with no shared private state, read by the controller and named directly
// by every sim that picks a seat). The controller holds the behaviour; this file holds the
// numbers and the reasons for them.

import { FP_SCALE } from '@dd/engine';

/** Grid units to fixed-point, the unit every distance in a profile is written in. */
export const g = (grid: number): number => grid * FP_SCALE;

export interface BotProfile {
  /** Distance the bot tries to hold from its target while shooting. */
  standoffFp: number;
  /** Dead zone around `standoffFp` — stops a bot oscillating one tick in, one out. */
  hysteresisFp: number;
  /** Opens fire once the target is this close (its gun's own reach is unlimited;
   *  this is the bot's discipline, not the weapon's). */
  fireRangeFp: number;
  /** Break off toward a heal pickup below this fraction of total effective HP. */
  healSeekFrac: number;
  /**
   * Wait in a cleared room for the shield pool to refill before opening the next
   * one (config.ts `SHIELD_REGEN_DELAY`/`SHIELD_REGEN_INTERVAL`). This is the single
   * biggest difference between careful and reckless play in a room-by-room game, and
   * it has to be modelled or the sim cannot see the effect of any regen tuning at
   * all: a bot that walks straight on always fights at whatever HP the last room
   * left it with.
   */
  restsBetweenRooms: boolean;
  /**
   * Walk to a better GUN lying in a quiet room and take it (2026-09-26). Without this the bot
   * fought every floor with the starter blaster, so `weaponFireStats` read `blaster 100%` on
   * every sweep and the energy economy's whole reason to exist — a strong frame running its
   * pool dry — was never exercised by play, only by staged `loadout` runs. "Better" is a
   * strictly higher authored dps (`gunWorth` says why not rarity); ranged only, since the
   * blade is `meleeWhenDry`'s. The bot then stands where the new gun can connect from
   * (`weaponStandoff.ts`).
   */
  swapsWeapons: boolean;
  /**
   * Holster a gun it cannot afford and fight with the blade until the pool refills
   * (2026-09-29). Without it a dry ranged slot left the bot disarmed: it held FIRE on a pull
   * the engine refused and never touched the melee slot, so a looted frame that ran dry was
   * dead weight — the "melee is the free fallback" argument `design/03` rests on had never
   * been exercised. It swaps to the blade when a pull is unaffordable and an enemy shares its
   * room, and back once the pool holds half its size (`weaponChoice.ts`).
   */
  meleeWhenDry: boolean;
  /**
   * Ticks at the very start of a run during which the seat does nothing at all — no
   * move, no fire (2026-11-11).
   *
   * Not a handicap invented to make the numbers look harder. `first_input.ms` on the
   * Playgama sandbox reads a MEDIAN of 7.7 s, and `first_input.screen` says 76 of 97
   * first touches land inside a live run: the portal build autostarts, so the opening
   * seconds of a real run are played by nobody. Every bot here moves optimally from
   * tick one, which is why five tuning passes over floor 1 measured a room the shipped
   * game never presents. 7.7 s is `IDLE_OPENING_TICKS`.
   *
   * Pair it with the fix, not just the diagnosis: with the first-input hold in place
   * (`client/src/game/controllers/openingHold.ts`) the shipped game no longer runs
   * those ticks at all, so a profile carrying this one models the game BEFORE that
   * change — keep it to measure what the hold is worth, not to tune against.
   */
  idleTicks: number;
  /**
   * Never back off: once inside its own standoff band the seat stands and trades rather
   * than kiting out (2026-11-11). It still CLOSES when the target is too far — dropping
   * both arms produced a bot that plinked at the far wall for all 40 000 ticks of 40/40
   * runs without dying, an instrument that measures nothing (see `spacingMove`).
   *
   * The other half of what the telemetry describes: `run_death` reads a median of 13 hits
   * taken at 50% burst, i.e. a player chipped at roughly a hit a second, one who never
   * breaks contact. A kiting bot takes its damage in bursts and then has three clear
   * seconds, which is exactly the `SHIELD_REGEN_DELAY` window; a bot that holds its
   * ground never gets one, and that is the difference between a shield economy that works
   * and one that is switched off.
   */
  holdsGround: boolean;
}

/** The measured median opening, in 30 Hz ticks: `first_input.ms` p50 = 7701 ms. */
export const IDLE_OPENING_TICKS = 231;

/**
 * `careful` sits just outside `DEFAULT_ENEMY_ENGAGE_RANGE_FP` (5.6 grid — the range
 * a mob stops and shoots from, content/enemies.ts), so a competent player's spacing
 * is represented, not just a brawl. `aggressive` closes to the same 4-grid spacing
 * `ai/engage.ts`'s shipped `KEEP_DIST_FP` uses for the co-op ally, i.e. what the
 * game's own existing bot considers normal.
 */
const SKILLED = { idleTicks: 0, holdsGround: false } as const;

export type BotProfileName = 'careful' | 'aggressive' | 'novice' | 'frozen' | 'rooted' | 'newcomer';

export const BOT_PROFILES: Record<BotProfileName, BotProfile> = {
  careful: { standoffFp: g(7.5), hysteresisFp: g(1), fireRangeFp: g(11), healSeekFrac: 0.7, restsBetweenRooms: true, swapsWeapons: true, meleeWhenDry: true, ...SKILLED },
  aggressive: { standoffFp: g(4), hysteresisFp: g(1), fireRangeFp: g(11), healSeekFrac: 0.5, restsBetweenRooms: false, swapsWeapons: true, meleeWhenDry: true, ...SKILLED },
  /**
   * Careful spacing, none of the housekeeping: never walks to a heal, never rests
   * between rooms, never swaps weapons. The ad-hoc profile the ENGINE_VERSION 91
   * investigation used to show that the fire budget rather than the HP curve was the
   * lever on floor 1 — committed 2026-11-11 so that result can be reproduced instead
   * of retyped. It is still a player who kites perfectly and starts on tick one.
   */
  novice: { standoffFp: g(7.5), hysteresisFp: g(1), fireRangeFp: g(11), healSeekFrac: 0, restsBetweenRooms: false, swapsWeapons: false, meleeWhenDry: false, ...SKILLED },
  /** `careful`, but it spends the measured median opening doing nothing. Isolates what the
   *  dead first 7.7 seconds cost on their own, with every other skill left perfect. */
  frozen: { standoffFp: g(7.5), hysteresisFp: g(1), fireRangeFp: g(11), healSeekFrac: 0.7, restsBetweenRooms: true, swapsWeapons: true, meleeWhenDry: true, idleTicks: IDLE_OPENING_TICKS, holdsGround: false },
  /** `aggressive`, but it stands and trades rather than kiting. Isolates the other half:
   *  what never breaking contact costs against a shield that only refills out of contact. */
  rooted: { standoffFp: g(4), hysteresisFp: g(1), fireRangeFp: g(11), healSeekFrac: 0.5, restsBetweenRooms: false, swapsWeapons: true, meleeWhenDry: true, idleTicks: 0, holdsGround: true },
  /**
   * All of it at once: a first-time player as the sandbox telemetry actually describes
   * one — dead for the first 7.7 s, then standing in the open trading shots, with no
   * heal-seeking, no resting and no weapon swapping. This is the seat floor 1 has to be
   * survivable for, and the one every tuning pass before 2026-11-11 was blind to.
   */
  newcomer: { standoffFp: g(4), hysteresisFp: g(1), fireRangeFp: g(11), healSeekFrac: 0, restsBetweenRooms: false, swapsWeapons: false, meleeWhenDry: false, idleTicks: IDLE_OPENING_TICKS, holdsGround: true },
};
