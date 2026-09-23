/**
 * Step 11 — Spawns (both modes; see the arena branch below). A scripted wave director: spawn the first wave
 * immediately, then, once a wave is fully cleared, run a short break before the
 * next; when the last wave is dispatched, flag wavesExhausted for WinCondition.
 * Enemies spawn with an aiPrng-seeded initial cooldown so their fire phases don't
 * lock-step (replaces the demo's non-deterministic `gx % 1` jitter).
 *
 * Ports Game.ts updateWaves()/spawnNextWave() + WaveDirector, float px → grid-fp.
 * Wave positions still arrive via EngineConfig (px, converted with pxToFp); the
 * enemy blueprint (HP / footprint / loadout) now lives in content/enemies.ts (09).
 */
import type { Fp } from '../math/fixed';
import { SIM } from '../sim.config';
import { mechanismRing } from '../content/chests';
import { rollShopStock } from '../content/shops';
import { pxToFp, toFpGrid } from '../content/convert';
import { buildEnemyActor, BOSS_POOL } from '../content/enemies';
import type { WaveScript, RoomPiece } from '../content/rooms';
import type { ArenaRoom } from '../content/arenas';
import {
  generateFloor,
  placeFloor,
  placeFloorGraph2d,
  placeAuthoredFloor,
  buildFloorGeometry,
  toFpAabbGrid,
  type PlacedRoom,
  type DungeonFloorMap,
} from '../world/dungeon';
import type { EnemyActor, PickupItem } from '../state/entities';
import type { ArenaRoomRuntime, DungeonRoomRuntime, GameState, WaveDef } from '../state/GameState';
import { dropClearance } from '../state/actorRadius';
import { clampToWalkable } from './geom';

/** One expanded, timed spawn entry — shared shape between dungeon's single global
 * schedule and the arena's per-room schedules (ArenaRoomRuntime.schedule). */
type ScheduleEntry = { atTick: number; spawnPoint: number; enemyType?: string };

/**
 * Expand a room's `encounter` (design/09 WaveScript) into a timed spawn schedule —
 * each entry becomes `count` copies (atTick + j*spacingTicks, so a burst can
 * trickle in), sorted by (atTick, authoring order) for deterministic dispatch
 * (and thus deterministic aiPrng draw order in spawnEnemyAt). A room with no
 * `encounter` falls back to every spawn point at tick 0 (an all-at-once room —
 * the common hand-authored case). Shared by both PvE dungeon rooms and PvP arena
 * rooms — same WaveScript vocabulary, different spawn-point source.
 */
function expandEncounter(
  encounter: WaveScript | undefined,
  spawnCount: number,
  typeAt: (i: number) => string | undefined,
): ScheduleEntry[] {
  const sched: (ScheduleEntry & { seq: number })[] = [];
  let seq = 0;
  if (encounter) {
    for (const entry of encounter.entries) {
      const spacing = entry.spacingTicks ?? 0;
      for (let j = 0; j < entry.count; j++) {
        sched.push({ atTick: entry.atTick + j * spacing, spawnPoint: entry.spawnPoint, enemyType: entry.enemyType, seq: seq++ });
      }
    }
  } else {
    for (let i = 0; i < spawnCount; i++) {
      sched.push({ atTick: 0, spawnPoint: i, enemyType: typeAt(i), seq: seq++ });
    }
  }
  sched.sort((a, b) => a.atTick - b.atTick || a.seq - b.seq);
  return sched.map(({ atTick, spawnPoint, enemyType }) => ({ atTick, spawnPoint, enemyType }));
}

export class SpawnSystem {
  tick(state: GameState): void {
    // Dungeon mode (ROADMAP 1.3 wired) drives spawns from the generated room sequence
    // instead of the flat wave list — a completely separate path, so every non-dungeon
    // config takes the byte-identical original code below (no ENGINE_VERSION bump).
    if (state.dungeonEnabled) return this.tickDungeon(state);

    // PvP arena mode (design/15, ROADMAP 4.3) — every room is already co-resident
    // (4.2b); this only lazily activates each room's encounter/loot the tick a
    // player first enters it (perf-only, NOT information-hiding — see content/arenas.ts
    // LootMarker's doc comment and design/15's honest anti-cheat-limit note).
    if (state.zoneEnabled) return this.tickArena(state);

    if (state.enemies.length > 0 || state.wavesExhausted) return;

    if (state.waveIndex === -1) {
      this.advance(state); // -1 → wave 0, no break before the first wave
      return;
    }

    // Current wave cleared: run the inter-wave break, then advance.
    if (state.waveBreakTicks <= 0) {
      state.waveBreakTicks = SIM.waveBreakTicks;
      state.events.push({ type: 'wave_clear', wave: state.waveIndex + 1 });
    }
    state.waveBreakTicks--;
    if (state.waveBreakTicks <= 0) {
      state.waveBreakTicks = 0;
      this.advance(state);
    }
  }

  private advance(state: GameState): void {
    const next = state.waveIndex + 1;
    if (next >= state.waves.length) {
      state.wavesExhausted = true;
      return;
    }
    state.waveIndex = next;
    this.spawnWave(state, state.waves[next]!);
  }

  private spawnWave(state: GameState, wave: WaveDef): void {
    for (const [px, py, type] of wave) {
      this.spawnEnemyAt(state, pxToFp(px), pxToFp(py), type);
    }
  }

  /**
   * Instantiate one enemy at an already-converted (fp) position. Shared by the flat
   * wave director (px positions) and the dungeon room loader (grid positions); the
   * caller converts. Resolves the blueprint by `type` (missing/unknown → basic,
   * design/09 forward-compat); the aiPrng draw stays one-per-spawn regardless of
   * variant, so fire-phase jitter is unaffected by which mobs a wave/room contains.
   */
  private spawnEnemyAt(state: GameState, gx: Fp, gy: Fp, type?: string): EnemyActor {
    const enemy = buildEnemyActor(state, gx, gy, type);
    state.enemies.push(enemy);
    return enemy;
  }

  /**
   * The `'boss_random'` sentinel (Task 2, ENGINE_VERSION 70): a room's authored spawn
   * point can name this instead of a real blueprint id, and the FIRST time that room's
   * schedule is built (room activation, `tickDungeon` above — never re-rolled on a
   * later tick of the same room) it resolves to one draw off `BOSS_POOL`. Every other
   * type passes through unchanged and costs no draw at all, so a floor with no random
   * boss room is byte-identical to before this existed. One `aiPrng` draw, same stream
   * `buildEnemyActor` already spends a per-spawn fire-phase draw from — a boss room's
   * schedule is built once, so this cannot shift by which OTHER mob spawns alongside it.
   */
  private resolveSpawnType(state: GameState, type: string | undefined): string | undefined {
    if (type !== 'boss_random') return type;
    return BOSS_POOL[state.aiPrng.nextInt(BOSS_POOL.length)];
  }

  // ── Dungeon mode (design/05 "Room & door model", 2026-08-04 — co-resident) ──────

  /**
   * The floor director. A floor is now every one of its `RoomPiece`s placed into ONE
   * co-resident, door-connected map (`world/dungeon.ts` `generateFloor`→`placeFloor`→
   * `buildFloorGeometry`) — matching PvP's `ArenaMap` shape — rather than one room
   * swapped in at a time. On a fresh floor (`dungeonRooms.length === 0`, the sentinel
   * `ExtractionSystem.resolveDescend` resets to) it generates + places + stitches the
   * whole floor once (the only live `roomgenPrng` draw site, room selection AND door
   * placement together). Every tick thereafter, each room activates — and its own
   * `WaveScript` starts, completely fresh from its own `roomTick === 0` — the first
   * tick any player's `roomId` matches it, EXACTLY mirroring `tickArena`'s own
   * activation trigger/timing below (deliberately not a shared floor-wide clock: a
   * room nobody has reached yet keeps its full intended spawn pacing whenever it's
   * eventually activated, design/05). `DoorSystem` (step 11.5, right after this one)
   * reads this tick's freshly-dispatched enemies to lock/unlock doors and force-
   * regroup — never this system's concern.
   */
  private tickDungeon(state: GameState): void {
    if (state.dungeonRooms.length === 0) {
      this.generateAndPlaceFloor(state);
    }
    for (let i = 0; i < state.dungeonRooms.length; i++) {
      const room = state.dungeonRooms[i]!;
      const rt = state.dungeonRoomRuntime[i]!;
      if (!rt.activated) {
        const entered = state.players.some((p) => p.alive && p.roomId === room.id);
        if (!entered) continue;
        rt.activated = true;
        rt.roomTick = 0;
        rt.schedule = expandEncounter(
          room.piece.encounter,
          room.piece.spawns.enemy.length,
          (idx) => this.resolveSpawnType(state, room.piece.spawns.enemy[idx]?.type),
        );
        rt.cursor = 0;
        state.events.push({ type: 'room_enter', floorIndex: state.floorIndex, roomId: room.id });
      } else {
        rt.roomTick++;
      }
      this.dispatchDungeonSpawns(state, room, rt);
    }
  }

  /**
   * Generate this floor's room sequence, place it into a co-resident, door-connected
   * map, and stitch its collision geometry in — replacing the previous floor's
   * (content-swap in place, `state.rebuildSpatialIndex()`, same convention every
   * other room-geometry rebuild in this engine already follows). Every per-room
   * runtime/rect array is cleared and repopulated (never reassigned — `readonly` on
   * these fields is the array reference, not the contents). Teleports every player
   * onto the floor's first room's own authored spawn points (co-op players share
   * spawn 0 if the room authored fewer points than there are players) — a
   * force-regroup mid-floor teleport (DoorSystem) uses each room's single
   * `entranceGrid` instead, since spreading players out is a floor-start-only
   * concern.
   */
  /**
   * Resolves this floor's hand-authored map (Task 6, "room-layout randomization",
   * 2026-09-23) — `floorLayoutVariants[floorIndex]`, when authored, offers a POOL of
   * interchangeable door-graph layouts for the same room roster (mirroring
   * `content/enemies.ts`'s `BOSS_POOL`/`'boss_random'` sentinel: one well-scoped
   * `roomgenPrng` draw over otherwise-fixed hand content). A floor index without a
   * variant pool falls back to `floorMaps[floorIndex]` unchanged, costing zero extra
   * draws — exactly the pre-Task-6 behavior for every floor that doesn't opt in.
   */
  private resolveAuthoredFloor(state: GameState): DungeonFloorMap | undefined {
    const variants = state.dungeonConfig!.floorLayoutVariants?.[state.floorIndex];
    if (variants && variants.length > 0) return variants[state.roomgenPrng.nextInt(variants.length)];
    return state.dungeonConfig!.floorMaps?.[state.floorIndex];
  }

  private generateAndPlaceFloor(state: GameState): void {
    // Hand-authored floors (design/05 "Hand-authored PvE floors", 2026-08-05) take
    // priority over procedural generation for this floor index — zero roomgenPrng
    // draws for it either way, so a later procedural floor's own draw sequence is
    // unaffected by whether an earlier floor was authored or generated. Otherwise,
    // `layout: 'graph2d'` (world/dungeon.ts, ROADMAP "real 2D graph layout" follow-up)
    // places `generateFloor`'s SAME stage sequence via the 2D-capable
    // `placeFloorGraph2d` instead of `placeFloor`'s west→east-only spine; a
    // 'graph2d' config never forks (`generateFloor` only forks for 'branching'), so
    // `stages` here is always plain `RoomPiece[]`, never a fork-array `FloorStage`.
    const authored = this.resolveAuthoredFloor(state);
    const generated = authored
      ? undefined
      : generateFloor(state.dungeonConfig!, state.floorIndex, state.roomgenPrng, state.roomLibrary);
    const { placed, doors } = authored
      ? placeAuthoredFloor(authored, state.roomLibrary)
      : state.dungeonConfig!.layout === 'graph2d'
        ? placeFloorGraph2d(generated!.stages as readonly RoomPiece[], state.roomgenPrng)
        : placeFloor(generated!.stages, state.roomgenPrng);
    const geo = buildFloorGeometry(placed, doors);

    state.dungeonRooms.length = 0;
    state.dungeonRooms.push(...placed);
    state.dungeonRoomIndexById.clear();
    placed.forEach((r, i) => state.dungeonRoomIndexById.set(r.id, i));

    state.dungeonDoors.length = 0;
    for (const door of doors) {
      state.dungeonDoors.push({ door, passageAabb: toFpAabbGrid(door.passageGrid), locked: false });
    }

    state.dungeonRoomRuntime.length = 0;
    for (let i = 0; i < placed.length; i++) {
      state.dungeonRoomRuntime.push({
        activated: false, roomTick: 0, schedule: [], cursor: 0, hasLiveEnemy: false,
      });
    }

    // A floor used to roll a weapon ALLOWANCE here (2 or 3, one `dropPrng.nextInt` per
    // floor) and `DeathDropsSystem` enforced it. Both are gone as of 2026-09-14: an enemy
    // does not drop weapons, so there is no per-kill weapon rate for an allowance to cap
    // and no shortfall for a capstone to make up. Removing the draw is why this pass moves
    // every seeded floor's later loot — see `versionHistory.ts`.

    state.dungeonRoomRects.length = 0;
    for (const r of placed) {
      state.dungeonRoomRects.push({
        id: r.id,
        rect: {
          x: toFpGrid(r.offsetXGrid),
          y: toFpGrid(r.offsetYGrid),
          w: toFpGrid(r.piece.sizeGrid.w),
          h: toFpGrid(r.piece.sizeGrid.h),
        },
      });
    }

    state.dungeonBaseWalls.length = 0;
    state.dungeonBaseWalls.push(...geo.walls);
    state.walls.length = 0;
    state.walls.push(...geo.walls);
    state.obstacles.length = 0;
    state.obstacles.push(...geo.obstacles);
    state.rebuildSpatialIndex();
    state.worldW = geo.worldW;
    state.worldH = geo.worldH;

    // Same rule as every floor/room transition before this one (design/05/09): an
    // uncollected drop can never be reached again once the geometry it sat on is gone.
    state.pickups.length = 0;

    // This floor's chests (design/05 "Chest rooms", ENGINE_VERSION 63). Same lifecycle and
    // same reason as the pickups cleared above: an unopened chest is unreachable the moment
    // its room stops existing. Built AFTER `walls`/`obstacles`/`worldW`/`worldH` are in
    // place, because `mechanismRing`'s points are clamped against this floor's geometry --
    // doing it earlier would clamp a plate against the PREVIOUS floor's stone.
    state.chests.length = 0;
    state.shops.length = 0;
    for (const room of placed) {
      for (const c of room.piece.chests ?? []) {
        const gx = toFpGrid(c.x + room.offsetXGrid);
        const gy = toFpGrid(c.y + room.offsetYGrid);
        const at = clampToWalkable(gx, gy, dropClearance(), state);
        state.chests.push({
          // `nextChestId`, never `nextId` — see its doc comment: a chest taking an entity id
          // shifts every later enemy id, and an enemy id sets its opening-volley delay.
          id: state.nextChestId(),
          roomId: room.id,
          kind: c.kind,
          gx: at.gx,
          gy: at.gy,
          // A plate a player cannot stand on is a chest that can never open, so every
          // mechanism goes through the same walkable clamp the chest itself just did.
          mechanisms:
            c.kind === 'big'
              ? mechanismRing(at.gx, at.gy, state.players.length).map((m) => {
                  const mp = clampToWalkable(m.gx, m.gy, dropClearance(), state);
                  return { gx: mp.gx, gy: mp.gy, occupied: false };
                })
              : [],
          opened: false,
        });
      }
      // This floor's shop counters (design/05 "Shops", 2026-09-14). Same placement rules as
      // the chests above — clamped walkable, tied to the room, cleared with the floor — and
      // stocked from `dropPrng` HERE rather than on first approach, so a shop's contents are
      // decided by the floor's seed and not by which player walked in first.
      for (const sh of room.piece.shops ?? []) {
        const at = clampToWalkable(
          toFpGrid(sh.x + room.offsetXGrid),
          toFpGrid(sh.y + room.offsetYGrid),
          dropClearance(),
          state,
        );
        state.shops.push({
          id: state.nextShopId(),
          roomId: room.id,
          gx: at.gx,
          gy: at.gy,
          stock: rollShopStock(state.dropPrng, () => state.nextShopId()),
        });
      }
    }

    const first = placed[0];
    if (first) {
      state.players.forEach((p, i) => {
        const sp = first.piece.spawns.player[i] ?? first.piece.spawns.player[0];
        if (sp) {
          p.gx = toFpGrid(sp.x + first.offsetXGrid);
          p.gy = toFpGrid(sp.y + first.offsetYGrid);
        }
      });
    }
  }

  /** Same dispatch shape as the arena's `dispatchArenaSpawns` — a room's own
   * independent clock/cursor, since every dungeon room is now co-resident too.
   * Sets each newly-spawned enemy's `roomId` DIRECTLY (never left to next tick's
   * `EnvironmentSystem` inference, unlike a PvP arena spawn) so `DoorSystem`
   * (step 11.5, right after this system) sees an accurate `hasLiveEnemy` this SAME
   * tick — a real, deliberate difference from the arena path: without it, a room's
   * doors would stay open for one extra tick after its first enemy spawns, a real
   * (if narrow) walk-back-out window. */
  private dispatchDungeonSpawns(state: GameState, room: PlacedRoom, rt: DungeonRoomRuntime): void {
    while (rt.cursor < rt.schedule.length) {
      const ev = rt.schedule[rt.cursor]!;
      if (ev.atTick > rt.roomTick) break;
      const sp = room.piece.spawns.enemy[ev.spawnPoint];
      if (sp) {
        const enemy = this.spawnEnemyAt(state, toFpGrid(sp.x + room.offsetXGrid), toFpGrid(sp.y + room.offsetYGrid), ev.enemyType);
        enemy.roomId = room.id;
      }
      rt.cursor++;
    }
  }

  // ── PvP arena mode (design/15, ROADMAP 4.3) ─────────────────────────────────────

  /**
   * Every arena room is already co-resident (4.2b) — this just lazily activates
   * each room's encounter + loot the tick a player's cached `roomId`
   * (EnvironmentSystem, step 8b — already fresh this tick, since it runs before
   * this step) first matches it, then dispatches whatever of its schedule is due.
   * An already-activated room only needs its own local clock ticked forward.
   */
  private tickArena(state: GameState): void {
    const map = state.arenaMap;
    if (!map) return;
    map.rooms.forEach((room, i) => {
      const rt = state.arenaRoomRuntime[i];
      if (!rt) return;
      if (!rt.activated) {
        const entered = state.players.some((p) => p.alive && p.roomId === room.id);
        if (!entered) return;
        rt.activated = true;
        rt.roomTick = 0;
        rt.schedule = expandEncounter(room.encounter, room.spawns?.length ?? 0, (idx) => room.spawns?.[idx]?.type);
        rt.cursor = 0;
        if (!rt.lootSpawned) {
          this.spawnArenaLoot(state, room);
          rt.lootSpawned = true;
        }
      } else {
        rt.roomTick++;
      }
      this.dispatchArenaSpawns(state, room, rt);
    });
  }

  /** Same dispatch shape as the dungeon's `dispatchDueSpawns`, just reading one
   * room's own runtime instead of the single global schedule — every arena room
   * runs its own independent clock/cursor since they're all co-resident at once. */
  private dispatchArenaSpawns(state: GameState, room: ArenaRoom, rt: ArenaRoomRuntime): void {
    const spawns = room.spawns ?? [];
    while (rt.cursor < rt.schedule.length) {
      const ev = rt.schedule[rt.cursor]!;
      if (ev.atTick > rt.roomTick) break;
      const sp = spawns[ev.spawnPoint];
      if (sp) this.spawnEnemyAt(state, toFpGrid(sp.x + room.rectGrid.x), toFpGrid(sp.y + room.rectGrid.y), ev.enemyType);
      rt.cursor++;
    }
  }

  /**
   * Spawn one UNRESOLVED 'crate' pickup per `lootMarker`, once, the tick its room
   * activates. Deliberately does NOT roll `rollArenaDrop` here (design/15's own
   * "honest anti-cheat-limit" note on this being perf-only, not information-hiding,
   * is now actually closed): every room is co-resident in shared GameState from
   * match start, so an eager roll would put every floor's exact loot identity within
   * reach of a map-wide state-reading/free-camera cheat long before any legitimate
   * player is near it. `PickupSystem` rolls the real kind/weaponId/buffId once a
   * player is within `SIM.lootRevealRadius` of the crate — same dropPrng stream,
   * just a later, player-gated draw. `tableId` isn't differentiated yet
   * (content/arenas.ts `LootMarker`'s doc comment: the real per-table catalog is
   * still "to design").
   */
  private spawnArenaLoot(state: GameState, room: ArenaRoom): void {
    for (const marker of room.lootMarkers ?? []) {
      // Clamp the authored marker point too — a defensive backstop against a
      // map-editor marker that ends up on/behind a wall (design/07 pickups).
      // By `dropClearance()` (ENGINE_VERSION 50), same as every other drop site: an
      // authored marker is the one of the three most likely to be off, so it is the
      // one that most wants the guarantee that what lands there is standable.
      const pos = clampToWalkable(
        toFpGrid(marker.point.x + room.rectGrid.x),
        toFpGrid(marker.point.y + room.rectGrid.y),
        dropClearance(),
        state,
      );
      const item: PickupItem = {
        id: state.nextId(),
        kind: 'crate',
        gx: pos.gx,
        gy: pos.gy,
        spawnTick: state.tick,
        alive: true,
      };
      state.pickups.push(item);
    }
  }
}
