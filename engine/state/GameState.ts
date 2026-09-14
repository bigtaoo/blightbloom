/**
 * GameState — plain data, constructed from seed + config (design/08). Ordered
 * arrays only (push order = spawn order = iteration order); a state-local nextId()
 * (not a module global, so a headless re-judge can run alongside a live match);
 * injected per-concern PRNGs with distinct derived seeds; a per-tick events queue.
 * No Pixi, no DOM. Systems are the only code that mutates it.
 *
 * The pure type/interface declarations this class is built from and around
 * (Phase/EngineConfig/PlayerConfig/ZoneState/ArenaRoomRuntime/DungeonRoomRuntime/
 * DoorRuntime) live in ./GameState.types.ts (CLAUDE.md "500-line file convention",
 * form ①); re-exported below so every existing `import { EngineConfig, ... } from
 * '.../state/GameState'` site is untouched.
 */
import { Prng } from '../math/prng';
import { toFp } from '../math/fixed';
import type { Fp } from '../math/fixed';
import { pxToFp } from '../content/convert';
import { freshStatus } from '../content/damage';
import { PLAYER_BASE, resolveLoadout } from '../content/players';
import { resolveSkin, toShieldBreakSim } from '../content/skins';
import { buildRunSpecs, buildArenaSpecs } from '../balance/build';

import { UniformGrid } from '../systems/spatialGrid';
import {
  buildArenaGeometry,
  buildArenaCellTraits,
  buildArenaRoomRects,
  type ArenaMap,
  type CellTrait,
  type RoomId,
} from '../content/arenas';
import type {
  AABB,
  Chest,
  EnemyActor,
  Obstacle,
  PickupItem,
  PlayerActor,
  Projectile,
  WeaponState,
  Winner,
} from './entities';
import type { GameEvent } from './events';
import type { RoomRect } from './roomModel';
import type { DungeonConfig, PlacedRoom } from '../world/dungeon';
import type { RoomPiece } from '../content/rooms';
import type {
  ArenaRoomRuntime,
  DoorRuntime,
  DungeonRoomRuntime,
  EngineConfig,
  PlayerConfig,
  Phase,
  WaveDef,
  ZoneState,
} from './GameState.types';

export type {
  Phase,
  SpawnSpec,
  WaveDef,
  PlayerConfig,
  EngineConfig,
  ZoneState,
  ArenaRoomRuntime,
  DungeonRoomRuntime,
  DoorRuntime,
} from './GameState.types';

// Distinct derived-seed constants so the streams never alias (design/06/08).
const SEED_AI = 0x1a2b3c4d;
const SEED_COMBAT = 0x5e6f7a8b;
const SEED_DROP = 0x9c0d1e2f;
const SEED_ROOMGEN = 0x3f4a5b6c;
const SEED_RING = 0x7d8e9f0a;
const SEED_INTEGRITY = 0x2c3d4e5f;
const SEED_CARD = 0x5a6b7c8d;

export class GameState {
  readonly seed: number;
  phase: Phase = 'idle';
  tick = 0;

  private _nextId = 1;
  /** state-local monotonic entity-id allocator (design/08). */
  nextId(): number {
    return this._nextId++;
  }

  // Injected PRNG (distinct derived seeds).
  readonly aiPrng: Prng;
  readonly combatPrng: Prng;
  readonly dropPrng: Prng;
  // Dungeon layout/selection (design/05/08/09, ROADMAP 1.3) — the fourth PRNG the
  // locked GameState schema names. Not yet drawn from by any live system:
  // GameEngine.step() doesn't call the floor generator (world/dungeon.ts
  // generateFloor) — that's wiring the demo's single arena into a real multi-floor
  // run, 1.4/1.5. Reserved now so the schema matches design/08 exactly.
  readonly roomgenPrng: Prng;
  // PvP zone eye draw + future per-seat spawn assignment (design/15, ROADMAP 4.2d) —
  // a distinct stream so tuning/observing the zone never shifts any gameplay-affecting
  // draw sequence (aiPrng/combatPrng/dropPrng), same reasoning as every other stream.
  readonly ringPrng: Prng;
  // Anti-cheat "padding" stream (design/15, ROADMAP 4.4) — drawn once per tick
  // (GameEngine.step) purely to raise how much the periodic-checkpoint state hash
  // moves tick-to-tick, so a diverged client surfaces sooner. NEVER read by any
  // gameplay system — mixing it into aiPrng/combatPrng/dropPrng would shift real
  // draw sequences whenever this tuning changes, for no anti-cheat benefit.
  readonly integrityPrng: Prng;

  /** Floor-card offers (design/05, ENGINE_VERSION 58). Its OWN stream, not `dropPrng`:
   *  a checkpoint's three cards and a kill's loot are independent decisions, and sharing
   *  a stream would make "how many enemies did you kill on this floor" silently decide
   *  which cards you are offered at the end of it. */
  readonly cardPrng: Prng;

  // Entities — ordered arrays; index/id stable within a match.
  readonly players: PlayerActor[] = [];
  readonly enemies: EnemyActor[] = [];
  readonly projectiles: Projectile[] = [];
  readonly pickups: PickupItem[] = [];
  /** Chests placed on the current floor (design/05 "Chest rooms", ENGINE_VERSION 63).
   *  Same lifecycle as `pickups` in dungeon mode: cleared and repopulated by
   *  `SpawnSystem.generateAndPlaceFloor`, since an unopened chest is unreachable once the
   *  geometry it stood on is gone. Empty for every config without authored chests, which
   *  is every config that predates them — `ChestSystem` is then a strict no-op. */
  readonly chests: Chest[] = [];

  // Round solids (design/07). Set once at construction and never mutated for a
  // non-dungeon config; in dungeon mode SpawnSystem.loadRoom repopulates the array
  // CONTENTS (never the reference) as each room loads. The `readonly` on the field is
  // the reference, not the contents — the reassignment-free swap keeps every reader valid.
  readonly obstacles: Obstacle[] = [];
  // Rectangular solids (design/07/09 ROADMAP 1.2) — same lifecycle as `obstacles`:
  // static for a non-dungeon config, per-room content-swapped in dungeon mode.
  readonly walls: AABB[] = [];
  // Broadphase index over the two arrays above (ROADMAP 4.2b) — a derived cache, not
  // gameplay state, rebuilt every time `walls`/`obstacles` are repopulated (here, and
  // by SpawnSystem.loadRoom via rebuildSpatialIndex()).
  spatialIndex!: UniformGrid;

  // World bounds (fp). Mutable ONLY in dungeon mode (each room resizes them as it
  // loads — SpawnSystem.loadRoom); a non-dungeon config sets them once at construction
  // and never touches them again, exactly as before (they were `readonly` pre-1.3).
  worldW: Fp;
  worldH: Fp;

  // Wave director state (design/08 steps 10–11).
  waveIndex = -1; // -1 = run not started; 0-based into the CURRENT floor's waves
  waveBreakTicks = 0; // countdown between a cleared wave and the next spawn
  wavesExhausted = false; // current floor's last wave dispatched
  // Mutable (unlike the other static-at-construction arrays above): ExtractionSystem
  // reassigns this to the next floor's wave list on DESCEND (design/05, ROADMAP 1.4).
  waves: readonly WaveDef[];

  // Extraction / materials-banking (design/05/09, ROADMAP 1.4/1.5). All no-ops
  // unless `floorsEnabled` (EngineConfig.floors was provided) — see ExtractionSystem.
  readonly floorsEnabled: boolean;
  readonly extraFloors: readonly (readonly WaveDef[])[]; // config.floors ?? []
  floorIndex = 0; // 0-based; floor 0 is the original `waves`, floor k>=1 is extraFloors[k-1]
  // This floor's un-banked buffer (materialId → qty) — auto-collected on pickup
  // (PickupSystem), merged into `bankedMaterials` on EXTRACT/DESCEND, and silently
  // discarded on a run-ending death (forfeit is just "never merged" — no extra code).
  floorMaterials: Partial<Record<string, number>> = {};

  // ── Per-floor weapon allowance (design/05, 2026-09-05) ──────────────────────
  // The design target is a floor that hands out 2-3 weapons, and a weight on the
  // drop table cannot express that: at ~60-77 enemies a floor, 5/84 per kill lands
  // anywhere from 0 to 6, and lowering the weight only widens that spread relative
  // to the target. So the WEIGHT sets the pacing (when a weapon shows up) and this
  // quota sets the COUNT, with `DeathDropsSystem` making up any shortfall on the
  // capstone kill so the floor can never come in under it.
  //
  // Dungeon runs only. A config with no rooms (a flat `waves`/`floors` list — every
  // golden scenario and most tests) has no floor to allocate against and is left on
  // the plain table, which is also why `-1` rather than `0` is the unrolled marker:
  // it distinguishes "this floor has no allowance concept" from "this floor's
  // allowance is spent".
  /** This floor's weapon allowance, rolled once when the floor is placed. -1 = never
   *  rolled (non-dungeon config, or a floor not yet placed). */
  floorWeaponQuota = -1;

  // ── Floor cards (design/05, ENGINE_VERSION 58) ──────────────────────────────
  // The checkpoint's "pick one of three". `floorCardOffer` holds THIS checkpoint's
  // three card ids (empty whenever no offer is open — before the capstone falls, on
  // the last floor, and immediately after a descend consumes one); `floorCards` is
  // the run's history of picks, in pick order, and is what `resolveFloorCards` reads
  // to derive the run's heal-drop multiplier and weapon-quota bonus.
  //
  // Buff cards are NOT in that derivation: they are pushed into every seat's
  // `PlayerActor.buffs` at pick time, exactly like a buff picked up off the floor, so
  // they flow through the existing `sumBuffs`/`BUFF_CAPS` machinery instead of a
  // second damage-scaling path.
  /** This checkpoint's three offered card ids; empty when no offer is open. */
  floorCardOffer: string[] = [];
  /** Every card this run has picked, in pick order. Run-scoped, never carries out. */
  floorCards: string[] = [];
  /** Weapons this floor has actually produced, against `floorWeaponQuota`. */
  floorWeaponsDropped = 0;
  // The run's carry-out bag — the ONLY thing that leaves a run (design/05). Never
  // wiped by death; only ever grows, at an extraction checkpoint.
  bankedMaterials: Partial<Record<string, number>> = {};
  /** The blueprint this run's boss kill rolled, or null (design/14, ENGINE_VERSION 63). The
   *  materials bag's companion and the SECOND thing that can leave a run — carried the same
   *  way and forfeited the same way, because nothing hands it to the meta layer unless the run
   *  is won. At most one per run: the roll is skipped once this is set, so a boss with adds
   *  that re-enters the branch cannot pay twice. */
  runBlueprint: string | null = null;

  // Seeded dungeon mode (design/05/09, ROADMAP 1.3 wired live). All inert unless
  // `dungeonEnabled` (EngineConfig.dungeon was provided) — see SpawnSystem's dungeon
  // branch. `dungeonEnabled` also forces `floorsEnabled` on, so ExtractionSystem runs.
  readonly dungeonEnabled: boolean;
  readonly dungeonConfig?: DungeonConfig;
  readonly roomLibrary: readonly RoomPiece[];
  // Co-resident room/door model (design/05 "Room & door model", 2026-08-04) —
  // supersedes the old one-room-at-a-time swap (roomIndex/roomTick/roomSchedule/
  // roomSpawnCursor/floorStages/floorLayout): every room of the current floor is
  // placed and stitched into `walls`/`obstacles` at once, matching PvP's co-resident
  // `arenaMap` shape. `dungeonRooms.length === 0` is the "generate a fresh floor"
  // sentinel SpawnSystem checks (mirrors the old `roomIndex === -1`) — set by
  // ExtractionSystem.resolveDescend, populated by SpawnSystem's dungeon branch.
  // `readonly` is the array REFERENCE, not its contents (same convention as
  // `walls`/`obstacles` above) — a fresh floor clears-and-repushes in place.
  readonly dungeonRooms: PlacedRoom[] = [];
  readonly dungeonDoors: DoorRuntime[] = [];
  // Parallel array to `dungeonRooms` (index-aligned) — same convention as
  // `arenaRoomRuntime`. The floor's capstone (extraction/boss) room is always the
  // LAST entry, since `generateFloor` always appends it last.
  readonly dungeonRoomRuntime: DungeonRoomRuntime[] = [];
  // Every dungeon room's rect, pre-converted to Fp ONCE (same rule as
  // `arenaRoomRects`) — `EnvironmentSystem`'s room-membership test reads this,
  // never `dungeonRooms` directly.
  readonly dungeonRoomRects: RoomRect[] = [];
  // O(1) RoomId → index lookup into `dungeonRooms`/`dungeonRoomRuntime` (same
  // sanctioned pattern as `content/arenas.ts computeRoomDistances`'s own
  // `idToIndex` — a pure lookup, never iterated, so Map iteration order never
  // affects any result). Rebuilt alongside `dungeonRooms` on a fresh floor.
  readonly dungeonRoomIndexById: Map<RoomId, number> = new Map();
  // The floor's fully-open wall geometry (every door carved, none re-added) — set
  // once when the floor is placed, alongside `walls`/`obstacles` (which start
  // identical to this). `DoorSystem` recomputes `walls` from THIS plus whichever
  // doors are currently locked, every time a lock changes, rather than trying to
  // incrementally add/remove an AABB from a flat array with no memory of which
  // door put it there.
  readonly dungeonBaseWalls: AABB[] = [];

  // PvP arena mode (design/15, ROADMAP 4.2b/c/d). All inert unless `zoneEnabled`
  // (EngineConfig.arena was provided) — ZoneSystem/EnvironmentSystem are strict
  // no-ops otherwise (ExtractionSystem's precedent, GameEngine.ts).
  readonly zoneEnabled: boolean;
  readonly arenaMap?: ArenaMap;
  // Every cellTrait, pre-converted to an absolute-Fp rect ONCE at construction (same
  // "convert once, never inside a system" rule as walls/obstacles) — see
  // `content/arenas.ts buildArenaCellTraits`. Empty when `arenaMap` is absent.
  readonly cellTraits: { trait: CellTrait; rect: AABB }[] = [];
  // Every room's rect, pre-converted to Fp ONCE (same rule) — the room-membership
  // point-in-rect test (`EnvironmentSystem`) reads this, never `arenaMap` directly.
  readonly arenaRoomRects: RoomRect[] = [];
  // The zone's per-match-drawn eye + current stage (design/15) — undefined until
  // ZoneSystem's first tick draws it (PRNG draws happen inside systems, not the
  // constructor, matching `roomgenPrng`'s existing precedent above).
  zone?: ZoneState;
  // PvP finish order (design/15, ROADMAP 4.2e) — seat INDICES (into `players`, same
  // convention as `Winner`'s doc comment), in ELIMINATION order (worst place first);
  // the winner (`state.winner`) is implicitly 1st and never pushed here. Populated by
  // WinConditionSystem's arena-mode branch only; empty for every PvE config.
  readonly placements: number[] = [];
  // Per-room lazy-activation + encounter runtime (design/15, ROADMAP 4.3) — parallel
  // array to `arenaMap.rooms` (index-aligned, never a Map: same array-order
  // determinism convention as everywhere else). Initialized eagerly at construction
  // (plain state, no PRNG draw, so — unlike `zone` — there's no reason to defer this
  // to a system's first tick); `SpawnSystem` is the only mutator.
  readonly arenaRoomRuntime: ArenaRoomRuntime[] = [];

  // Outcome + render channel.
  winner: Winner = null;
  events: GameEvent[] = [];

  constructor(config: EngineConfig) {
    // Dungeon mode and arena mode are ALTERNATIVES to each other, never a pair — each of
    // `EngineConfig.dungeon` / `.arena` has said so in its own doc comment since it was
    // added, and both override the flat `waves`/`walls`/`worldW`/`worldH` fields in ways
    // that cannot both be in effect. Enforced here 2026-08-27, because until then the only
    // thing holding the invariant up was those two comments, and three call sites had
    // already drifted into two different rules for picking between the two room-rect lists
    // (see `state/roomModel.ts`, now the single rule both the engine and the client read).
    // Thrown rather than silently preferring one: every `EngineConfig` in this repo is
    // built by code (`match/offlineConfig.ts`, `match/pvpConfig.ts`, tests) and never
    // deserialized from a peer, so a config carrying both is a programming error at
    // authoring time, not untrusted input this could be used to crash.
    if (config.dungeon !== undefined && config.arena !== undefined) {
      throw new Error('EngineConfig: `dungeon` and `arena` are mutually exclusive room models — pass one, not both');
    }
    this.seed = config.seed;
    this.aiPrng = new Prng(config.seed ^ SEED_AI);
    this.combatPrng = new Prng(config.seed ^ SEED_COMBAT);
    this.dropPrng = new Prng(config.seed ^ SEED_DROP);
    this.roomgenPrng = new Prng(config.seed ^ SEED_ROOMGEN);
    this.ringPrng = new Prng(config.seed ^ SEED_RING);
    this.integrityPrng = new Prng(config.seed ^ SEED_INTEGRITY);
    this.cardPrng = new Prng(config.seed ^ SEED_CARD);
    this.worldW = pxToFp(config.worldW);
    this.worldH = pxToFp(config.worldH);
    this.waves = config.waves;
    // Dungeon mode is a second way to enable the extraction/materials loop (design/05),
    // so floorsEnabled is true for EITHER opt-in. A config with neither is untouched.
    this.dungeonEnabled = config.dungeon !== undefined;
    this.dungeonConfig = config.dungeon?.config;
    this.roomLibrary = config.dungeon?.library ?? [];
    this.floorsEnabled = config.floors !== undefined || this.dungeonEnabled;
    this.extraFloors = config.floors ?? [];

    this.zoneEnabled = config.arena !== undefined;
    this.arenaMap = config.arena;

    if (config.arena) {
      // Arena mode overrides the flat obstacles/walls/worldW/worldH above entirely —
      // every room's geometry, stitched at its own offset, replaces the demo's single
      // flat layout (see EngineConfig.arena).
      const geo = buildArenaGeometry(config.arena);
      this.worldW = geo.worldW;
      this.worldH = geo.worldH;
      this.obstacles.push(...geo.obstacles);
      this.walls.push(...geo.walls);
      this.cellTraits.push(...buildArenaCellTraits(config.arena));
      this.arenaRoomRects.push(...buildArenaRoomRects(config.arena));
      for (const _room of config.arena.rooms) {
        this.arenaRoomRuntime.push({ activated: false, roomTick: 0, schedule: [], cursor: 0, lootSpawned: false });
      }
    } else {
      for (const [ox, oy, orad] of config.obstacles ?? []) {
        this.obstacles.push({ gx: pxToFp(ox), gy: pxToFp(oy), radius: pxToFp(orad) });
      }
      for (const [wx, wy, ww, wh] of config.walls ?? []) {
        this.walls.push({ x: pxToFp(wx), y: pxToFp(wy), w: pxToFp(ww), h: pxToFp(wh) });
      }
    }
    this.rebuildSpatialIndex();

    // One PlayerActor per co-op seat (design/05/06, ROADMAP 3.1). ABSENT `players` →
    // exactly one seat built from the single-player top-level fields, byte-identical to
    // before (the seat list is `[{ skinId, loadout, start }]`, so the same buildSeat call
    // with the same nextId()==1 runs — additive, no ENGINE_VERSION bump). PRESENT → one
    // seat per entry, in order, so owner index == array index (ApplyInputSystem routing).
    const seats: readonly PlayerConfig[] =
      config.players ?? [{ skinId: config.skinId, loadout: config.loadout, start: config.playerStart }];
    for (const seat of seats) this.players.push(this.buildSeat(config, seat));
  }

  /**
   * Build one co-op seat's PlayerActor (design/05/06, ROADMAP 3.1). PvP arena mode
   * (`config.arena` set, ROADMAP 4.2c) branches to `buildArenaSpecs` for the body/
   * weapon stats instead of the PvE run-builder path below: the fairness wall
   * (design/05/06/09) means `seat.loadout` (persistent meta gear) must never reach a
   * PvP seat — `buildArenaSpecs` structurally cannot take it (no such parameter), so
   * branching here enforces that at the one place seats are actually built, not just
   * by convention at the call site.
   */
  private buildSeat(config: EngineConfig, seat: PlayerConfig): PlayerActor {
    const [sx, sy] = seat.start ?? [config.worldW / 2, config.worldH / 2];
    // Merge the chosen character (SkinDef defensive identity) with PLAYER_BASE shared
    // constants (design/09/14). Unknown/absent skin → the default (forward-compat).
    const skin = resolveSkin(seat.skinId);

    let weapons: WeaponState[];
    let maxHp: number;
    let maxShield: number;
    if (config.arena) {
      // PvP (design/15): the landing-kit preset's weapons + this character's HP/shield,
      // both scaled by PVP_SCALE_FACTOR — `seat.loadout` is deliberately never read here.
      const built = buildArenaSpecs(config.arenaPreset ?? 'landing_basic', seat.skinId);
      weapons = built.weapons;
      maxHp = built.maxHp;
      maxShield = built.maxShield;
    } else {
      // PvE: resolve the loadout through the run builder (design/09 fairness wall) — the
      // base meta loadout carried in at match start. `resolveLoadout` (content/players.ts)
      // owns the whole rule: unknown crafted ids dropped (forward-compat), the survivors
      // kept active-first, and every free slot filled from PLAYER_BASE.startWeapons with
      // a kind the staged list doesn't cover — so a run ALWAYS spawns with a gun and a
      // melee weapon, and the swap control always has a second slot to point at. Absent
      // or empty `seat.loadout` → the plain starter pair, unchanged.
      weapons = buildRunSpecs(resolveLoadout(seat.loadout));
      maxHp = skin.maxHp;
      maxShield = skin.maxShield;
    }

    return {
      id: this.nextId(),
      faction: 'player',
      teamId: seat.teamId ?? 0, // shared default team (design/15) — see PlayerConfig.teamId
      gx: pxToFp(sx),
      gy: pxToFp(sy),
      z: toFp(0),
      vx: toFp(0),
      vy: toFp(0),
      knockVx: toFp(0),
      knockVy: toFp(0),
      facing: 0 as PlayerActor['facing'],
      hp: maxHp,
      maxHp,
      shield: maxShield, // spawn with a full shield (design/07)
      maxShield,
      ticksSinceHit: 0,
      radius: PLAYER_BASE.radius,
      footprintRadius: PLAYER_BASE.footprintRadius,
      solidRadius: PLAYER_BASE.solidRadius,
      alive: true,
      weapon: weapons[0] ?? null, // active pointer = weapons[activeSlot]
      weapons,
      activeSlot: 0,
      buffs: [], // run-scoped buff stack (design/14); filled by 'buff' pickups
      // Weapon energy (design/03/05) — spawn with a full pool, the same rule the shield
      // spawns on. A CHARACTER stat since ENGINE_VERSION 60 (`SkinDef.maxEnergy`), and
      // read from `skin` in BOTH modes rather than from the arena builder: unlike
      // (maxHp, maxShield) it is deliberately not multiplied by `PVP_SCALE_FACTOR`, since
      // that factor scales weapon DAMAGE alongside the pools it inflates and `energyCost`
      // is not scaled at all — a x5 pool in the arena would delete the ammo economy from
      // PvP rather than preserve its ratio. See `SkinDef.maxEnergy`.
      energy: skin.maxEnergy,
      maxEnergy: skin.maxEnergy,
      firing: false,
      interacting: false,
      confirmExtract: false,
      confirmDescend: false,
      pickupTargetId: 0,
      cardVote: 0,
      downed: false, // co-op downed/revive (design/05/07, ROADMAP 3.2)
      bleedoutTicks: 0,
      reviveProgressTicks: 0,
      bandages: 0, // PvP squad revive (design/05/15) — starts empty, picked up in-arena
      prevButtons: 0,
      status: freshStatus(),
      shieldBreak: skin.shieldBreak ? toShieldBreakSim(skin.shieldBreak) : undefined,
      atlasKey: skin.atlasKey,
    };
  }

  clearEvents(): void {
    this.events.length = 0;
  }

  /** Rebuild the broadphase index from the current walls/obstacles contents (ROADMAP
   * 4.2b). Call after repopulating either array — the constructor does this once;
   * SpawnSystem.loadRoom does it again on every room swap. */
  rebuildSpatialIndex(): void {
    this.spatialIndex = new UniformGrid(this.walls, this.obstacles);
  }
}

export function createGameState(config: EngineConfig): GameState {
  return new GameState(config);
}
