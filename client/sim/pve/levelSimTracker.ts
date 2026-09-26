/**
 * The level simulator's per-tick observer — split out of `levelSim.ts` (CLAUDE.md
 * "500-line file convention", form ①: `EncounterTracker` is one self-contained
 * accumulator with no dependency on `runLevel` itself, so it moves whole rather than
 * being decomposed further). `levelSim.ts` owns the public `RunMetrics` shape and the
 * loop that drives an engine tick-by-tick; this file owns turning each tick's
 * `GameState` into that shape's fields.
 *
 * Per-tick observer. Deliberately reads room ACTIVATION off
 * `dungeonRoomRuntime[i].activated` rather than the `room_enter` event: activation
 * is the moment the garrison is allowed to act (AIDecideSystem's one and only
 * behaviour gate), which is precisely what the reaction window is measured from.
 */
import { WEAPON_SPECS, type GameState, type PlayerActor } from '@dd/engine';
import { roomIdAt } from './pveNav';
import type { DropRecord, FireRecord, FloorVitals, RoomEncounter, ShopSnapshot } from './levelSimTypes';

const BURST_WINDOW_TICKS = 30; // 1s @30Hz

export class EncounterTracker {
  readonly encounters: RoomEncounter[] = [];
  readonly drops: DropRecord[] = [];
  readonly fires: FireRecord[] = [];
  readonly killsByFloor: Record<number, number> = {};
  readonly checkpointFloors: number[] = [];
  readonly dryTicksByFloor: Record<number, number> = {};
  readonly heldTicksByWeapon: Record<string, number> = {};
  readonly dryTicksByWeapon: Record<string, number> = {};
  readonly aliveTicksByFloor: Record<number, number> = {};
  readonly energyRefillsTakenByFloor: Record<number, number> = {};
  readonly vitalsAtCheckpoint: FloorVitals[] = [];
  readonly roomsTotalByFloor: Record<number, number> = {};
  readonly shopSnapshots: ShopSnapshot[] = [];
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
  private readonly seenShops = new Set<number>();

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
    this.trackDrops(s, p);
    this.trackFire(s, p);
    this.trackEnergy(s, p);
    this.trackShops(s, p);
  }

  /** Open an encounter the tick a room activates; close it when it goes quiet. */
  private trackRooms(s: GameState): void {
    // Guarded by `.length > 0`, not a plain `??=`: the tick a descend advances
    // `floorIndex` can observe the new floor before `dungeonRooms` is re-placed for it
    // (ExtractionSystem's own "fresh floor has been placed yet" window), and `??=` would
    // lock that transient 0 in for the floor's whole run.
    if (this.roomsTotalByFloor[s.floorIndex] === undefined && s.dungeonRooms.length > 0) {
      this.roomsTotalByFloor[s.floorIndex] = s.dungeonRooms.length;
    }
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
  private trackDrops(s: GameState, p: PlayerActor): void {
    const swapThisTick = s.events.some((ev) => ev.type === 'pickup' && ev.kind === 'weapon');
    for (const item of s.pickups) {
      if (this.seenPickups.has(item.id)) continue;
      this.seenPickups.add(item.id);
      if (item.kind === 'weapon' && swapThisTick) continue;
      const weaponId = item.kind === 'weapon' ? item.weaponId : undefined;
      this.drops.push({
        floorIndex: s.floorIndex,
        roomId: roomIdAt(s, item.gx, item.gy) ?? null,
        kind: item.kind,
        tick: s.tick,
        weaponId,
        rarity: weaponId ? WEAPON_SPECS[weaponId]?.rarity : undefined,
      });
    }
    for (const ev of s.events) {
      // Both checkpoint resolutions count as "this floor's portal opened": `descend`
      // carries the floor it moved TO (ExtractionSystem increments before pushing),
      // and a `win` in a floors-enabled run is an EXTRACT off the floor still current.
      if (ev.type === 'descend') {
        const floorIndex = ev.floorIndex - 1;
        this.checkpointFloors.push(floorIndex);
        this.vitalsAtCheckpoint.push({ floorIndex, hp: p.hp, shield: p.shield, maxHp: p.maxHp, maxShield: p.maxShield });
      }
      // A team wipe pushes `win` too, with `winner: 'enemies'` (WinConditionSystem) —
      // and counting that as a completed floor is exactly the measurement bug this
      // field exists to avoid. Only a PLAYER win (a numeric seat) is an extraction,
      // which is the one non-descend way a floor's checkpoint gets reached. Caught on
      // the first real sweep: floor 0 reported 8 of 8 visits "complete" while the
      // summary right above it said 5 of those 8 runs died in r4_forge.
      if (ev.type === 'win' && typeof ev.winner === 'number') {
        this.checkpointFloors.push(s.floorIndex);
        this.vitalsAtCheckpoint.push({ floorIndex: s.floorIndex, hp: p.hp, shield: p.shield, maxHp: p.maxHp, maxShield: p.maxShield });
      }
    }
  }

  /** Snapshot a shop's stock + the player's coins the tick its room first activates —
   *  the earliest point "could this run afford the counter" is answerable at all. */
  private trackShops(s: GameState, p: PlayerActor): void {
    for (const shop of s.shops) {
      if (this.seenShops.has(shop.id)) continue;
      const idx = s.dungeonRooms.findIndex((r) => r.id === shop.roomId);
      if (idx < 0 || !s.dungeonRoomRuntime[idx]?.activated) continue;
      this.seenShops.add(shop.id);
      this.shopSnapshots.push({
        floorIndex: s.floorIndex,
        roomId: shop.roomId,
        tick: s.tick,
        coins: p.coins,
        offers: shop.stock.map((o) => ({ kind: o.kind, price: o.price })),
      });
    }
  }

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
    const id = ranged.spec.name;
    this.heldTicksByWeapon[id] = (this.heldTicksByWeapon[id] ?? 0) + 1;
    if (p.energy < ranged.spec.energyCost) {
      this.dryTicksByFloor[floor] = (this.dryTicksByFloor[floor] ?? 0) + 1;
      // Per GUN as well as per floor (2026-09-26): once the bot swaps into a looted frame,
      // "which weapon runs its pool dry" is the question, and a floor total cannot say.
      this.dryTicksByWeapon[id] = (this.dryTicksByWeapon[id] ?? 0) + 1;
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
