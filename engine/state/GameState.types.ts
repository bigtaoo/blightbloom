/**
 * Pure type/interface declarations split out of GameState.ts (CLAUDE.md "500-line
 * file convention", form ① — independent module: zero logic, zero shared private
 * state, nothing here does anything besides describe shapes GameState.ts consumes
 * and constructs). Re-exported wholesale from GameState.ts so every existing
 * `import { EngineConfig, PlayerConfig, ... } from '.../state/GameState'` site
 * (and engine/index.ts's `export * from './state/GameState'`) is untouched.
 */
import type { SkinId } from '../content/skins';
import type { ArenaPresetId } from '../balance/build';
import type { DungeonConfig } from '../world/dungeon';
import type { RoomPiece } from '../content/rooms';
import type { ArenaMap, Door, RoomId } from '../content/arenas';
import type { AABB } from './entities';

export type Phase = 'idle' | 'playing' | 'gameover';

/**
 * One enemy spawn in a wave: world-px position, plus an optional enemy `type` that
 * SpawnSystem resolves through ENEMY_BLUEPRINTS (missing = 'basic'). The `[x, y]`
 * form stays valid, so old wave data needs no change (design/09 forward-compat).
 */
export type SpawnSpec = readonly [number, number, string?];
/** A wave is a list of enemy spawn entries (positions in world px → grid-fp). */
export type WaveDef = readonly SpawnSpec[];

/**
 * One co-op seat (design/05/06, ROADMAP 3.1 — "the thing that spawns a SECOND
 * player"). Each entry becomes one PlayerActor whose `owner` == its index here, so a
 * command's `owner` routes to the right seat (ApplyInputSystem). Every field mirrors
 * the single-player top-level config so a seat is self-describing:
 *   - `skinId`   chosen character (unknown/absent → default, resolveSkin)
 *   - `loadout`  crafted weapon ids (unknown dropped; free slots filled by kind from
 *                PLAYER_BASE.startWeapons — see resolveLoadout, content/players.ts)
 *   - `start`    spawn px (absent → world centre; dungeon mode overrides on room load)
 * The engine has always iterated `state.players` by owner, so N seats need no system
 * change — only this construction path. See `EngineConfig.players`.
 */
export interface PlayerConfig {
  skinId?: SkinId;
  loadout?: readonly string[];
  start?: readonly [number, number]; // px
  // Team identity for combat targeting (design/15, ROADMAP 4.2a). ABSENT (every
  // config before this feature, and every co-op config today) → every seat
  // defaults to the SAME team (0, see buildSeat) — allies never damage each
  // other, byte-identical to the pre-teamId behavior. A PvP arena build (4.2c,
  // not yet built) assigns each seat its OWN distinct teamId instead; a future
  // squad build assigns the same teamId to several seats. Independent of the
  // seat's `owner`/array index (state/commands.ts) — see entities.ts's note.
  teamId?: number;
}

export interface EngineConfig {
  seed: number;
  worldW: number; // px (converted to grid-fp at construction via pxToFp)
  worldH: number; // px
  waves: readonly WaveDef[];
  // Co-op seats (design/05/06, ROADMAP 3.1). PRESENT → one PlayerActor per entry, in
  // order (owner index = array index). ABSENT (every config before this feature) → the
  // single-player path below (the top-level skinId/loadout/playerStart build exactly one
  // seat), byte-identical — additive, no ENGINE_VERSION bump. When `players` is given the
  // top-level skinId/loadout/playerStart are ignored (each seat is self-describing); a
  // one-entry `players` list is exactly equivalent to the single-player top-level form.
  players?: readonly PlayerConfig[];
  skinId?: SkinId; // chosen character (design/14); unknown/absent → default (resolveSkin)
  // Brought-in loadout (design/05/14, ROADMAP 2.2) — up to WEAPON_SLOTS weapon ids the
  // player crafted at the forge and carried into this run. Resolved by `resolveLoadout`
  // (content/players.ts): unknown ids dropped (design/09 forward-compat), then every free
  // slot filled from PLAYER_BASE.startWeapons with a kind the staged list doesn't cover,
  // so a run always spawns carrying a gun AND a melee weapon. ABSENT or EMPTY → the plain
  // PLAYER_BASE.startWeapons pair.
  loadout?: readonly string[];
  playerStart?: readonly [number, number]; // px; defaults to world centre
  // Static round solids (pillars), in world px [x, y, radius]. Converted to
  // grid-fp at construction; MovementSystem pushes actors out of them (design/07).
  obstacles?: readonly (readonly [number, number, number])[];
  // Static rectangular solids (AABB tile/wall geometry, design/07/09 ROADMAP 1.2),
  // in world px [x, y, w, h] (top-left corner + extents). Converted to grid-fp at
  // construction; MovementSystem/ProjectileStepSystem resolve against them exactly
  // like `obstacles` above, just with a rect test instead of a circle test.
  walls?: readonly (readonly [number, number, number, number])[];
  // Floors AFTER the first (design/05/09, ROADMAP 1.4/1.5) — `waves` above is floor
  // 0; each entry here is one additional floor's wave list. PRESENCE enables the
  // extraction-checkpoint / materials-banking loop (ExtractionSystem); every config
  // that omits it (every config before this feature existed) is completely
  // untouched — additive, no ENGINE_VERSION bump. Reaching the end of a floor's
  // waves with no enemies left is the per-floor checkpoint: EXTRACT (bank + end
  // the run) or DESCEND (bank + reload the next entry here) via a held/tapped
  // INTERACT (see ExtractionSystem). The last floor (index === floors.length) has
  // no descend option — reaching its checkpoint auto-resolves as EXTRACT, matching
  // design/05 "the last floor's boss room IS its extraction room."
  floors?: readonly (readonly WaveDef[])[];
  // Seeded dungeon mode (design/05/09, ROADMAP 1.3 wired live). An ALTERNATIVE to the
  // flat `floors` list above: instead of hand-listing each floor's waves, a floor is
  // GENERATED from a hand-authored RoomPiece library (`world/dungeon.ts generateFloor`
  // draws the roomgenPrng) and traversed room-by-room, each room swapping in its own
  // collision geometry (`content/rooms.ts roomGeometry`) and enemies. PRESENCE enables
  // the same extraction/materials loop as `floors` (floorsEnabled below). Additive: a
  // config that omits it (every config before this feature) never draws roomgenPrng,
  // never mutates walls/obstacles, and is byte-identical — no ENGINE_VERSION bump.
  // `waves`/`worldW`/`worldH` above are ignored in dungeon mode (each room supplies its
  // own bounds); pass `waves: []` and any placeholder bounds. MUTUALLY EXCLUSIVE with
  // `arena` below — since 2026-08-27 that is ENFORCED (`GameState`'s constructor throws on
  // a config carrying both) rather than only asserted here; see `state/roomModel.ts` for
  // what the unenforced version cost.
  dungeon?: { config: DungeonConfig; library: readonly RoomPiece[] };
  // PvP arena mode (design/15, ROADMAP 4.2b/c) — an ALTERNATIVE to the flat
  // `walls`/`obstacles`/`worldW`/`worldH` above: every `ArenaRoom` in the map is
  // stitched into ONE co-resident world at construction (`content/arenas.ts
  // buildArenaGeometry`), unlike dungeon mode's one-room-live-at-a-time swap.
  // PRESENCE overrides `walls`/`obstacles`/`worldW`/`worldH` entirely (pass
  // placeholders, same convention as dungeon mode's `waves: []` note above).
  // Additive: a config that omits it (every config before this feature) never
  // touches this path — byte-identical, no ENGINE_VERSION bump. MUTUALLY EXCLUSIVE with
  // `dungeon` above, enforced at construction (see that field's note).
  arena?: ArenaMap;
  // Which `ARENA_PRESETS` entry (balance/build.ts) every seat's landing-kit weapons +
  // HP/shield scale come from when `arena` is set (ROADMAP 4.2c). One preset for the
  // whole match, not per-seat — `skinId` (per seat) is still what buildArenaSpecs scales
  // the RIGHT character's stats by. Absent → 'landing_basic' (today's only preset).
  arenaPreset?: ArenaPresetId;
}

/**
 * The zone's live state (design/15, ROADMAP 4.2d) — a room-graph BFS shrink, not a
 * geometric circle. `dist`/`maxDist` are deliberately NOT stored here: they're a pure
 * deterministic function of `eye` + the static `arenaMap` (rooms/doors never change
 * mid-match), so ZoneSystem recomputes them at each (infrequent) stage transition
 * instead of duplicating derived data into replicated state.
 */
export interface ZoneState {
  eye: RoomId;
  stage: number; // 0 = every reachable room still safe
  phase: 'warn' | 'hold';
  ticksToPhaseEnd: number;
  safe: RoomId[]; // rooms safe AT the current stage
  closing: RoomId[]; // only meaningful during 'warn': rooms about to drop at stage+1
  escalation: number; // extra damagePerTick increments once the final stage is reached
}

/**
 * One `ArenaRoom`'s lazy-activation + WaveScript runtime (design/15, ROADMAP 4.3).
 * `activated` flips true the tick a player's cached `roomId` first matches this
 * room — perf-only lazy activation (design/15: the map ships bundled, so this is
 * NOT an information-hiding measure). `schedule`/`cursor` mirror the dungeon
 * mode's `roomSchedule`/`roomSpawnCursor` shape exactly, just per-room instead of
 * globally-one-room-at-a-time (arena rooms are all co-resident, ROADMAP 4.2b).
 */
export interface ArenaRoomRuntime {
  activated: boolean;
  roomTick: number; // ticks since activation (room-local clock, mirrors dungeon's roomTick)
  schedule: { atTick: number; spawnPoint: number; enemyType?: string }[];
  cursor: number;
  lootSpawned: boolean;
}

/**
 * One dungeon room's lazy-activation + WaveScript runtime + combat-lock state
 * (design/05 "Room & door model", 2026-08-04, DoorSystem). Parallel array to
 * `dungeonRooms` (index-aligned, same array-order-determinism convention as
 * `arenaRoomRuntime`). `activated`/`roomTick`/`schedule`/`cursor` mirror
 * `ArenaRoomRuntime`'s exact shape and trigger (activates the tick a player's
 * `roomId` first matches this room; its WaveScript starts fresh from that
 * moment — NOT a shared floor-wide clock, so a room nobody has reached yet
 * keeps its full intended spawn pacing whenever it's eventually activated).
 * `hasLiveEnemy` is new: a room is "in combat" purely because it has a live
 * enemy (never an authored flag) — see `DoorSystem`. No separate `locked` field
 * here: a room's OWN combat state is exactly `hasLiveEnemy` (that's the thing
 * whose rising/falling edge fires force-regroup / unlocks its doors); "locked"
 * as a concept only exists per-DOOR (`DoorRuntime.locked` below), since a door
 * shared by two rooms locks if EITHER side has a live enemy.
 */
export interface DungeonRoomRuntime {
  activated: boolean;
  roomTick: number;
  schedule: { atTick: number; spawnPoint: number; enemyType?: string }[];
  cursor: number;
  hasLiveEnemy: boolean;
}

/**
 * One dungeon door's runtime lock state (design/05, 2026-08-04, DoorSystem).
 * `passageAabb` is `door.passageGrid` pre-converted to Fp ONCE (same
 * "convert once, never inside a system" rule as `walls`/`obstacles`/
 * `arenaRoomRects`) — `DoorSystem` re-adds it into `state.walls` while locked
 * and removes it while open, without ever re-deriving the rect from grid units
 * at match time.
 */
export interface DoorRuntime {
  door: Door;
  passageAabb: AABB;
  locked: boolean;
}
