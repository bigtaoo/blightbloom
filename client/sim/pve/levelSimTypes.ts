/**
 * The level simulator's data shapes — split out of `levelSim.ts` (CLAUDE.md "500-line
 * file convention", form ①: these are plain data interfaces with no logic, shared by
 * `levelSim.ts` (which fills a `RunMetrics` in) and `levelSimTracker.ts` (which does
 * the filling), so neither of those two need import the other. `levelSim.ts`
 * re-exports everything here, so `from './levelSim'` stays the one import site for
 * every existing caller.
 */
import type { PickupItem, RarityTier, ShopOffer } from '@dd/engine';
import type { BotProfile, BOT_PROFILES } from './PveBotController';

/** One room's fight, from the tick it woke up to the tick it went quiet. */
export interface RoomEncounter {
  floorIndex: number;
  roomId: string;
  activatedTick: number;
  clearedTick: number | null;
  /** Enemies alive in the room the tick it activated. */
  garrison: number;
  /** Ticks from activation to the player's first point of damage in this room —
   *  null if the room never landed a hit. The run's reaction window. */
  reactionTicks: number | null;
  /** Most enemies of this room firing simultaneously (any single tick). */
  peakShooters: number;
  damageTaken: number;
}

/**
 * One pickup the run PRODUCED, recorded the tick it appeared on the floor. Distinct
 * from the `pickup` event, which fires when one is COLLECTED — "how much loot does a
 * floor hand out" is a question about the drop table (design/09 `DROP_TABLE`), not
 * about what the bot managed to walk over.
 */
export interface DropRecord {
  floorIndex: number;
  /** The room it landed in — null inside a door passage or off the room graph. */
  roomId: string | null;
  kind: PickupItem['kind'];
  tick: number;
  /** `WEAPON_SPECS` id, `kind === 'weapon'` only — the weapon rarity distribution's key. */
  weaponId?: string;
  /** Intrinsic rarity (`balance/rarity.ts`) of `weaponId`, looked up once at record time
   *  so a report never has to re-import the catalog to answer "what tier was this". */
  rarity?: RarityTier;
}

/** Player HP/shield at the moment one floor's checkpoint resolved (design/05 "Room
 *  encounter budget" — the per-floor survivability measurement Task 0 was asked for,
 *  read alongside `peakBurstDamage` rather than instead of it: a burst asks "could one
 *  window have killed you", this asks "what did you actually have left"). */
export interface FloorVitals {
  floorIndex: number;
  hp: number;
  shield: number;
  maxHp: number;
  maxShield: number;
}

/** A shop's stock and the player's coins the tick its room first activates — i.e. the
 *  earliest moment the shop is reachable, not the moment (if any) it is worked. Read
 *  against `SHOP_PRICES` this is the "shop purchasing power" measurement: how much of
 *  the counter a floor's income actually affords, independent of whether the bot (which
 *  never shops) buys anything. */
export interface ShopSnapshot {
  floorIndex: number;
  roomId: string;
  tick: number;
  coins: number;
  offers: { kind: ShopOffer['kind']; price: number }[];
}

/**
 * One TRIGGER PULL the player spent — the unit an ammo/energy economy is priced in
 * (design/03 "a mechanic has no price anywhere in this repo"). Deliberately a
 * trigger and not a bullet: a spread frame emits `bullets` projectiles from one
 * pull, and charging per pellet would tax `scattergun` eight times for one decision.
 * Both numbers are recorded so either pricing can be costed off the same sweep.
 *
 * Read off `bullet_fired` / `melee_swing` events rather than off any weapon field:
 * a weapon fires at most once per tick (its cooldown is >= 1 tick), so every
 * `bullet_fired` the player owns on one tick belongs to exactly one pull.
 */
export interface FireRecord {
  floorIndex: number;
  /** Which half of the loadout spent the pull. Melee is the FREE half under every
   *  energy model considered (design/05) — it is counted so the free/paid split is
   *  measured rather than assumed. */
  kind: 'ranged' | 'melee';
  /** `WeaponSimSpec.name` of the slot that fired, or null on the one ambiguous tick
   *  shape: a weapon pickup resolves at step 10, AFTER the fire at step 3, so on a
   *  tick that did both, the slot's current occupant is not the one that shot. Those
   *  pulls are counted but left unattributed rather than charged to the wrong gun. */
  weapon: string | null;
  /** Projectiles this pull emitted (1 for a pinpoint gun, `bullets` for a spread or
   *  radial frame). Always 1 for a melee swing. */
  bullets: number;
  /** What this pull cost the pool (ENGINE_VERSION 62) — 0 for a melee swing, which is
   *  the free half by design, and null on the same ambiguous swap tick `weapon` is
   *  null on. Recorded per pull rather than looked up from `weapon` in the report,
   *  because a run's whole point is that the gun in the slot CHANGES. */
  energySpent: number | null;
  tick: number;
}

export interface RunMetrics {
  seed: number;
  profileName: string;
  skinId: string;
  outcome: 'extracted' | 'died' | 'timeout';
  ticks: number;
  /** Deepest floor index reached (0-based), and the room the run ended in. */
  floorReached: number;
  endRoom: string | null;
  encounters: RoomEncounter[];
  enemiesKilled: number;
  damageTaken: number;
  /** Worst damage total inside any one-second (30-tick) window. */
  peakBurstDamage: number;
  /** The player's own effective pool (maxHp + maxShield) — what `peakBurstDamage`
   *  has to be read against. */
  effectiveHp: number;
  /** Lowest `(hp + shield) / (maxHp + maxShield)` seen while alive. */
  lowestHpFrac: number;
  /** Every drop the run produced, in spawn order — the loot-economy measurement
   *  (2026-09-05: "每层只出产 2 到 3 个武器" / "血瓶概率非常低"). */
  drops: DropRecord[];
  /** Enemy kills per floor index. The DENOMINATOR a per-floor drop count has to be
   *  read against: a bot that beelines the capstone leaves most of a floor's roster
   *  alive, and that shows up as few drops through no fault of the drop table. */
  killsByFloor: Record<number, number>;
  /** Every trigger pull the player spent, in fire order — the consumption half of
   *  the loot economy (`drops` is the production half). */
  fires: FireRecord[];
  /** Floor indices whose CHECKPOINT the run reached (capstone cleared → the portal
   *  opened, whether the run then descended or extracted). A "per full floor" total
   *  is only comparable over these. */
  checkpointFloors: number[];
  /** Ticks per floor on which the player held a ranged weapon it could NOT afford to
   *  pull — the ammo economy actually biting, as opposed to merely existing
   *  (ENGINE_VERSION 60). Added because the v60 character-capacity A/B came back
   *  byte-identical and there was no way to tell "capacity does not matter" apart
   *  from "the bot never empties the bar in the first place". Counted on the same
   *  `observe()` pass as everything else, so it shares the run's tick denominator. */
  dryTicksByFloor: Record<number, number>;
  /** Live ticks each ranged weapon was the one held, and of those, the ticks it could not be
   *  afforded — `dryTicksByFloor` split by gun (2026-09-26, once the bot started swapping). */
  heldTicksByWeapon?: Record<string, number>;
  dryTicksByWeapon?: Record<string, number>;
  /** Live ticks per floor, the denominator `dryTicksByFloor` is a fraction of. */
  aliveTicksByFloor: Record<number, number>;
  /** Energy refills per floor the player actually WALKED OVER, as opposed to the ones
   *  the floor produced (`drops`). The two are very different numbers and the gap is
   *  the measurement (ENGINE_VERSION 62): a pool sitting at full refuses a refill
   *  outright (`PickupSystem.pickupWouldApply`), so a sustainable gun reads as
   *  "ammo drops are worthless" while the drop table is working exactly as authored. */
  energyRefillsTakenByFloor: Record<number, number>;
  /** The pool this run was played with (`SkinDef.maxEnergy` + any `flat_energy` picked
   *  up), sampled at the end — so a dry-tick count can be read against the capacity it
   *  was produced under rather than against an assumed 100. */
  finalMaxEnergy: number;
  /** HP/shield left at each floor's checkpoint, one entry per `checkpointFloors` value
   *  (same floor index, same order) — the per-floor survivability measurement. */
  vitalsAtCheckpoint: FloorVitals[];
  /** Rooms placed on each floor (`dungeonRooms.length`, sampled once per floor on
   *  first sight) — the denominator a room-skip rate needs. A procedurally-generated
   *  floor is a strict linear chain (no branch), but a hand-authored floor already can
   *  fork off the critical path (`placeAuthoredFloor.ts`), so `encounters.length` for
   *  that floor is not always equal to this even before any branch Task 6 adds. */
  roomsTotalByFloor: Record<number, number>;
  /** One entry per shop, snapshotted the tick its room first activates. */
  shopSnapshots: ShopSnapshot[];
}

export interface RunOptions {
  seed: number;
  skinId?: string;
  /** Crafted loadout ids; `[]` (the default) is a fresh save's real state — the
   *  starter blaster + saber (`PLAYER_BASE.startWeapons`), i.e. exactly what a new
   *  player walks in with. */
  loadout?: string[];
  profileName?: keyof typeof BOT_PROFILES;
  profile?: BotProfile;
  maxTicks?: number;
}
