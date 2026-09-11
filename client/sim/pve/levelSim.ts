/**
 * The level simulator: drive one full PvE run headlessly and record what it felt
 * like to be shot at.
 *
 * Built for a specific, repeated failure mode — a live report that a room's garrison
 * deletes the player before they can react ("一进游戏就被集火秒杀"). That bug has now
 * been "fixed" twice from reasoning alone (ENGINE_VERSION 40's fire-range gate, and
 * v37's chase before it) without anything in the repo able to say how much incoming
 * damage a room actually produces. This measures it:
 *
 *   - `reactionTicks` — activation → first damage taken. The number the report is
 *     really about; a player needs roughly a second to read a room.
 *   - `peakShooters` — most enemies firing at the player in the same tick, per room.
 *     The literal definition of 集火 (focus fire).
 *   - `peakBurstDamage` — worst 1-second damage window of the run, against the
 *     player's own effective HP pool (`hp + shield`), which is what decides whether
 *     a burst is survivable at all.
 *   - clear time and where the run ended, so a nerf can be checked for overshoot —
 *     an unkillable room and a boring one are both failures.
 *
 * It runs the REAL content through the REAL engine: `buildDungeonRunConfig` is the
 * same function `Game.beginRun` calls, so the simulated run is byte-identical to
 * pressing START (design/06 anti-drift — no second hand-mirrored copy of the run
 * config), and `PveBotController` reaches the engine through nothing but
 * `PlayerCommand`s. What it is NOT is a claim about human skill: a bot's aim is
 * perfect and its nerve never breaks. Read it as a floor on difficulty ("even a
 * tireless kiter dies here"), not as a verdict on how a person will do.
 */
import { createGameEngine, type GameState, type PickupItem, type PlayerActor } from '@dd/engine';
import { buildDungeonRunConfig } from '../../src/game/match/offlineConfig';
import { BOT_PROFILES, PveBotController, type BotProfile } from './PveBotController';
import { roomIdAt } from './pveNav';

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

const BURST_WINDOW_TICKS = 30; // 1s @30Hz
/** 5 floors of hand-authored rooms with a slow starter pistol is a long run; this is
 *  a runaway guard, not an expected outcome — a timeout is reported as its own
 *  result so it can never be mistaken for a survival. */
const DEFAULT_MAX_TICKS = 40_000;

export function runLevel(opts: RunOptions): RunMetrics {
  const profileName = opts.profileName ?? 'careful';
  const profile = opts.profile ?? BOT_PROFILES[profileName];
  const skinId = opts.skinId ?? 'vanguard';
  const maxTicks = opts.maxTicks ?? DEFAULT_MAX_TICKS;

  const engine = createGameEngine(
    buildDungeonRunConfig({
      seed: opts.seed,
      coop: false,
      localSeat: { skinId, loadout: opts.loadout ?? [] },
      allySkinId: 'juggernaut', // ignored: single-player config has no ally seat
    }),
  );
  const bot = new PveBotController(profile);
  const tracker = new EncounterTracker();

  let outcome: RunMetrics['outcome'] = 'timeout';
  let ticks = 0;
  while (ticks < maxTicks) {
    const nextTick = engine.state.tick + 1;
    engine.step([bot.build(engine.state, 0, nextTick)]);
    ticks++;
    tracker.observe(engine.state);
    if (engine.state.phase === 'gameover') {
      outcome = engine.state.winner === 0 ? 'extracted' : 'died';
      break;
    }
  }

  const s = engine.state;
  return {
    seed: opts.seed,
    profileName,
    skinId,
    outcome,
    ticks,
    floorReached: s.floorIndex,
    endRoom: tracker.playerRoom,
    encounters: tracker.encounters,
    enemiesKilled: tracker.enemiesKilled,
    damageTaken: tracker.damageTaken,
    peakBurstDamage: tracker.peakBurstDamage,
    effectiveHp: tracker.effectiveHp,
    lowestHpFrac: tracker.lowestHpFrac,
    drops: tracker.drops,
    fires: tracker.fires,
    killsByFloor: tracker.killsByFloor,
    checkpointFloors: tracker.checkpointFloors,
    dryTicksByFloor: tracker.dryTicksByFloor,
    aliveTicksByFloor: tracker.aliveTicksByFloor,
    energyRefillsTakenByFloor: tracker.energyRefillsTakenByFloor,
    finalMaxEnergy: tracker.finalMaxEnergy,
  };
}

/**
 * Per-tick observer. Deliberately reads room ACTIVATION off
 * `dungeonRoomRuntime[i].activated` rather than the `room_enter` event: activation
 * is the moment the garrison is allowed to act (AIDecideSystem's one and only
 * behaviour gate), which is precisely what the reaction window is measured from.
 */
class EncounterTracker {
  readonly encounters: RoomEncounter[] = [];
  readonly drops: DropRecord[] = [];
  readonly fires: FireRecord[] = [];
  readonly killsByFloor: Record<number, number> = {};
  readonly checkpointFloors: number[] = [];
  readonly dryTicksByFloor: Record<number, number> = {};
  readonly aliveTicksByFloor: Record<number, number> = {};
  readonly energyRefillsTakenByFloor: Record<number, number> = {};
  finalMaxEnergy = 0;
  enemiesKilled = 0;
  damageTaken = 0;
  peakBurstDamage = 0;
  effectiveHp = 0;
  lowestHpFrac = 1;
  playerRoom: string | null = null;

  private readonly open = new Map<string, RoomEncounter>(); // key: `${floor}:${roomId}`
  private readonly window: number[] = [];
  private readonly seenPickups = new Set<number>();

  observe(s: GameState): void {
    const p = s.players[0];
    if (!p) return;
    this.effectiveHp = p.maxHp + p.maxShield;
    if (p.alive) {
      this.lowestHpFrac = Math.min(this.lowestHpFrac, (p.hp + p.shield) / Math.max(1, this.effectiveHp));
      const here = roomIdAt(s, p.gx, p.gy);
      if (here !== undefined) this.playerRoom = here;
    }

    this.trackRooms(s);
    this.trackShooters(s);
    this.trackDamage(s, p.id);
    this.trackDrops(s);
    this.trackFire(s, p);
    this.trackEnergy(s, p);
  }

  /** Open an encounter the tick a room activates; close it when it goes quiet. */
  private trackRooms(s: GameState): void {
    for (let i = 0; i < s.dungeonRooms.length; i++) {
      const room = s.dungeonRooms[i]!;
      const rt = s.dungeonRoomRuntime[i];
      if (!rt?.activated) continue;
      const key = `${s.floorIndex}:${room.id}`;
      let enc = this.open.get(key);
      if (!enc) {
        enc = {
          floorIndex: s.floorIndex,
          roomId: room.id,
          activatedTick: s.tick,
          clearedTick: null,
          garrison: s.enemies.reduce((n, e) => n + (e.alive && e.roomId === room.id ? 1 : 0), 0),
          reactionTicks: null,
          peakShooters: 0,
          damageTaken: 0,
        };
        this.open.set(key, enc);
        this.encounters.push(enc);
      }
      // `hasLiveEnemy` is DoorSystem's own per-room scan (design/05) — the same
      // signal the door lock uses, so "cleared" here means exactly what the game
      // means by it.
      if (enc.clearedTick === null && !rt.hasLiveEnemy) enc.clearedTick = s.tick;
    }
  }

  private trackShooters(s: GameState): void {
    const firing = new Map<string, number>();
    for (const e of s.enemies) {
      if (!e.alive || !e.firing || e.roomId === undefined) continue;
      firing.set(e.roomId, (firing.get(e.roomId) ?? 0) + 1);
    }
    for (const [roomId, n] of firing) {
      const enc = this.open.get(`${s.floorIndex}:${roomId}`);
      if (enc && n > enc.peakShooters) enc.peakShooters = n;
    }
  }

  private trackDamage(s: GameState, playerId: number): void {
    let tickDamage = 0;
    for (const ev of s.events) {
      if (ev.type === 'death' && ev.faction === 'enemy') {
        this.enemiesKilled++;
        this.killsByFloor[s.floorIndex] = (this.killsByFloor[s.floorIndex] ?? 0) + 1;
      }
      if (ev.type === 'pickup' && ev.kind === 'energy') {
        this.energyRefillsTakenByFloor[s.floorIndex] = (this.energyRefillsTakenByFloor[s.floorIndex] ?? 0) + 1;
      }
      if (ev.type !== 'hit' || ev.target !== playerId) continue;
      tickDamage += ev.damage;
    }
    this.damageTaken += tickDamage;

    this.window.push(tickDamage);
    if (this.window.length > BURST_WINDOW_TICKS) this.window.shift();
    const burst = this.window.reduce((a, b) => a + b, 0);
    if (burst > this.peakBurstDamage) this.peakBurstDamage = burst;

    if (tickDamage > 0 && this.playerRoom !== null) {
      const enc = this.open.get(`${s.floorIndex}:${this.playerRoom}`);
      if (enc) {
        enc.damageTaken += tickDamage;
        if (enc.reactionTicks === null) enc.reactionTicks = s.tick - enc.activatedTick;
      }
    }
  }

  /**
   * Record the pickups that APPEARED this tick, plus the per-floor kill count and
   * checkpoint they have to be read against.
   *
   * `state.pickups` is the only channel available: `DeathDropsSystem` pushes a drop
   * with no event of its own — only COLLECTING one emits `pickup` — so a previously
   * unseen id in that array *is* the drop. Ids come from `state.nextId()` and never
   * repeat, so the seen-set stays correct across the descend that clears the array.
   *
   * One exclusion, and it matters: swapping weapons drops the outgoing weapon back
   * onto the floor as a fresh pickup (`PickupSystem.applyWeapon`). That is a player
   * action, not something the drop table produced, and counting it would inflate
   * precisely the number this exists to measure. Such a drop can only ever appear on
   * a tick where a weapon was collected, so a weapon `pickup` event this tick
   * disqualifies new weapon pickups on it.
   */
  private trackDrops(s: GameState): void {
    const swapThisTick = s.events.some((ev) => ev.type === 'pickup' && ev.kind === 'weapon');
    for (const item of s.pickups) {
      if (this.seenPickups.has(item.id)) continue;
      this.seenPickups.add(item.id);
      if (item.kind === 'weapon' && swapThisTick) continue;
      this.drops.push({
        floorIndex: s.floorIndex,
        roomId: roomIdAt(s, item.gx, item.gy) ?? null,
        kind: item.kind,
        tick: s.tick,
      });
    }
    for (const ev of s.events) {
      // Both checkpoint resolutions count as "this floor's portal opened": `descend`
      // carries the floor it moved TO (ExtractionSystem increments before pushing),
      // and a `win` in a floors-enabled run is an EXTRACT off the floor still current.
      if (ev.type === 'descend') this.checkpointFloors.push(ev.floorIndex - 1);
      // A team wipe pushes `win` too, with `winner: 'enemies'` (WinConditionSystem) —
      // and counting that as a completed floor is exactly the measurement bug this
      // field exists to avoid. Only a PLAYER win (a numeric seat) is an extraction,
      // which is the one non-descend way a floor's checkpoint gets reached. Caught on
      // the first real sweep: floor 0 reported 8 of 8 visits "complete" while the
      // summary right above it said 5 of those 8 runs died in r4_forge.
      if (ev.type === 'win' && typeof ev.winner === 'number') this.checkpointFloors.push(s.floorIndex);
    }
  }

  /**
   * Record the player's trigger pulls this tick — the consumption side of the loot
   * economy (design/05), and the denominator any ammo/energy pool has to be sized
   * against. Nothing in the tree measured it before 2026-09-05, so "how much does a
   * shot cost" had no numerator and no denominator.
   *
   * Attribution is by SLOT, not by the active pointer, and that is what makes it
   * exact rather than approximate: `bullet_fired` can only come from the ranged slot
   * and `melee_swing` only from the melee one (WeaponFireSystem branches on
   * `spec.kind`), so which weapon fired is never a guess about `activeSlot`. The one
   * real ambiguity is a tick that also collected a weapon — `PickupSystem` runs at
   * step 10, five steps after the fire — and those pulls are recorded with a null
   * weapon rather than charged to the gun that replaced the one that shot.
   */
  /**
   * The ammo economy's bite, measured rather than assumed (ENGINE_VERSION 60).
   *
   * A "dry" tick is one where the player is alive, holds a ranged weapon, and cannot
   * pay for a pull of it. That is deliberately NOT "energy === 0": a 26-cost frame is
   * already disarmed at 25, and a 3-cost blaster is not disarmed until 2, so a raw
   * zero-check would report the cheap gun as constrained far more often than the
   * expensive one — the exact inversion of what the economy is supposed to do.
   *
   * It is also not a count of REFUSED pulls, which the engine does not surface (a
   * refusal leaves the cooldown untouched and emits nothing, by design). Dry ticks
   * over-count relative to refusals — the bot is not trying to fire on every one of
   * them — so read the number as an upper bound on pressure, and read ZERO as what it
   * really is: proof the pool never once bound, and therefore that any A/B run over a
   * capacity change measured nothing at all.
   */
  private trackEnergy(s: GameState, p: PlayerActor): void {
    this.finalMaxEnergy = p.maxEnergy;
    if (!p.alive) return;
    const floor = s.floorIndex;
    this.aliveTicksByFloor[floor] = (this.aliveTicksByFloor[floor] ?? 0) + 1;
    const ranged = p.weapons.find((w) => w.spec.kind === 'ranged');
    if (!ranged || ranged.spec.kind !== 'ranged') return;
    if (p.energy < ranged.spec.energyCost) {
      this.dryTicksByFloor[floor] = (this.dryTicksByFloor[floor] ?? 0) + 1;
    }
  }

  private trackFire(s: GameState, p: PlayerActor): void {
    let bullets = 0;
    let swings = 0;
    for (const ev of s.events) {
      if (ev.type === 'bullet_fired' && ev.ownerId === p.id) bullets++;
      else if (ev.type === 'melee_swing' && ev.ownerId === p.id) swings++;
    }
    if (bullets === 0 && swings === 0) return;
    const swapped = s.events.some((ev) => ev.type === 'pickup' && ev.kind === 'weapon');
    const nameOf = (kind: 'ranged' | 'melee'): string | null =>
      swapped ? null : (p.weapons.find((w) => w.spec.kind === kind)?.spec.name ?? null);
    const rangedSlot = p.weapons.find((w) => w.spec.kind === 'ranged');
    const rangedCost = swapped || rangedSlot?.spec.kind !== 'ranged' ? null : rangedSlot.spec.energyCost;
    if (bullets > 0) {
      this.fires.push({
        floorIndex: s.floorIndex,
        kind: 'ranged',
        weapon: nameOf('ranged'),
        bullets,
        energySpent: rangedCost,
        tick: s.tick,
      });
    }
    // A swing is one pull that emits one event; `bullets: 1` keeps the two kinds
    // summable in the same column without pretending a swing throws a projectile.
    if (swings > 0) {
      this.fires.push({
        floorIndex: s.floorIndex,
        kind: 'melee',
        weapon: nameOf('melee'),
        bullets: 1,
        energySpent: 0,
        tick: s.tick,
      });
    }
  }
}
