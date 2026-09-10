/**
 * Dungeon mode wired live (design/05/09, ROADMAP 1.3; co-resident room/door model,
 * design/05 "Room & door model" 2026-08-04). A floor is generated, PLACED (every room
 * simultaneously live, door-connected, matching PvP's co-resident `ArenaMap` shape —
 * `world/dungeon.ts generateFloor`→`placeFloor`→`buildFloorGeometry`), and stitched
 * into `GameState` ONCE; rooms activate lazily (a player's `roomId` first matching
 * one), doors lock as a unit while their room has a live enemy, and
 * ExtractionSystem's descend generates the next floor fresh. All of this is a no-op
 * unless `EngineConfig.dungeon` is set (additive, no ENGINE_VERSION bump for THIS
 * gate — see config.ts's note; the co-resident cutover itself IS a bump, v34), so
 * these tests cover both the dungeon behaviour and the non-dungeon regression.
 *
 * Verified through the full createGameEngine pipeline (the "screenshots time out,
 * drive the engine headlessly" convention), plus a few targeted state pokes — moving
 * a player directly into a room it hasn't walked to, or clearing `state.enemies` —
 * where simulating the real movement/combat would only add noise; deep DoorSystem
 * lock/unlock/force-regroup mechanics have their own dedicated `doors.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import { createGameEngine } from '@dd/engine/GameEngine';
import { hashState } from '@dd/engine/replay';
import type { EngineConfig } from '@dd/engine/state/GameState';
import { Button } from '@dd/engine/state/commands';
import { makeCommand } from '@dd/engine/state/input';
import type { Brad } from '@dd/engine/math/trig';
import { toFp } from '@dd/engine/math/fixed';
import { toFpGrid } from '@dd/engine/content/convert';
import { buildEnemyActor } from '@dd/engine/content/enemies';
import { NOTICE_DELAY_TICKS, NOTICE_SPREAD_TICKS } from '@dd/engine/balance/encounter';
import { ENEMY_TEAM_ID, type Projectile } from '@dd/engine/state/entities';
import type { RoomPiece } from '@dd/engine/content/rooms';
import type { DungeonConfig, DungeonFloorMap } from '@dd/engine/world/dungeon';
import { EMBER_DUNGEON, EMBER_PROCEDURAL_DUNGEON, EMBER_ROOMS } from '@dd/engine/world/rooms/ember';
import { EMBER_L1_ROOMS } from '@dd/engine/world/rooms/emberLevel1';

// A tiny, fully-controlled library. Two normal pieces (distinct geometry, NO enemies →
// their room activates with an empty schedule and never locks), an empty extraction
// capstone, and a boss capstone (also enemy-free here so the plumbing tests never need
// to win a fight). Grid units, like every RoomPiece. Every piece names the exits
// `placeFloor`'s west↔east spine actually needs (a normal room only ever needs the
// 'east' side here since roomsPerFloor is fixed at exactly 1 normal + 1 capstone —
// never two normal rooms chained to each other).
const TEST_LIB: RoomPiece[] = [
  {
    id: 't_hall',
    tags: ['t'],
    sizeGrid: { w: 20, h: 16 },
    solids: [{ x: 5, y: 5, w: 2, h: 2 }],
    spawns: { player: [{ x: 2, y: 8 }], enemy: [] },
    exits: [{ edge: 'east' }],
  },
  {
    id: 't_pillars',
    tags: ['t'],
    sizeGrid: { w: 24, h: 12 },
    solids: [],
    pillars: [{ center: { x: 12, y: 6 }, radius: 1 }],
    spawns: { player: [{ x: 2, y: 6 }], enemy: [] },
    exits: [{ edge: 'east' }],
  },
  {
    id: 't_extract',
    role: 'extraction',
    sizeGrid: { w: 10, h: 10 },
    solids: [],
    spawns: { player: [{ x: 5, y: 8 }], enemy: [] },
    exits: [{ edge: 'west' }],
  },
  {
    id: 't_boss',
    role: 'boss',
    sizeGrid: { w: 22, h: 18 },
    solids: [],
    spawns: { player: [{ x: 11, y: 16 }], enemy: [] },
    exits: [{ edge: 'west' }],
  },
];

// min=max=2 → every floor is exactly [1 normal, capstone]. Two floors: floor 0's
// capstone is the extraction room, floor 1 (the last) is the boss room.
const TEST_DUN: DungeonConfig = {
  biomeId: 't',
  nameKey: 't',
  floorCount: 2,
  roomsPerFloor: { min: 2, max: 2 },
  pieceTags: ['t'],
  layout: 'linear',
  extractionPieceId: 't_extract',
  bossPieceId: 't_boss',
  difficultyCurve: { base: 1, perFloor: 1 },
};

const DUN_CFG: EngineConfig = {
  seed: 7,
  worldW: 640, // placeholder — the placed floor's own bounds override this
  worldH: 640,
  waves: [],
  dungeon: { config: TEST_DUN, library: TEST_LIB },
};

const idle = (tick: number) =>
  makeCommand({ owner: 0, tick, moveBrad: 0 as Brad, moveMag: 0, buttons: 0 });
// Portal-popup DESCEND choice (design/10 legibility pass, ENGINE_VERSION 31) — a
// one-shot press, not a held key; resolves the very tick it's pressed. Carries a
// floor-card vote too (ENGINE_VERSION 58): a descend is only honoured once the squad
// has picked one of the checkpoint's three cards, so every press in this file votes
// for the first slot. Which card it is never matters here — these tests are about
// floor placement and geometry, and `floorCards.test.ts` owns the vote itself.
const confirmDescend = (tick: number) =>
  makeCommand({ owner: 0, tick, moveBrad: 0 as Brad, moveMag: 0, buttons: Button.CONFIRM_DESCEND, cardVote: 1 });
// Same shape, EXTRACT half — the last floor needs this explicit press too now (2026-08-12
// bug fix: it used to auto-resolve the instant the capstone cleared, no gesture at all).
const confirmExtract = (tick: number) =>
  makeCommand({ owner: 0, tick, moveBrad: 0 as Brad, moveMag: 0, buttons: Button.CONFIRM_EXTRACT });

/** Directly place player 0 onto `room`'s own authored spawn point 0, offset into the
 * room's placement in the shared floor — a targeted state poke standing in for real
 * movement through an (unlocked) door, same convention this file already uses for
 * "force a room clear." */
function teleportPlayerInto(eng: ReturnType<typeof createGameEngine>, room: { offsetXGrid: number; offsetYGrid: number; piece: RoomPiece }): void {
  const sp = room.piece.spawns.player[0]!;
  eng.state.players[0]!.gx = toFpGrid(sp.x + room.offsetXGrid);
  eng.state.players[0]!.gy = toFpGrid(sp.y + room.offsetYGrid);
}

describe('Dungeon mode — no-op unless a `dungeon` config is provided', () => {
  it('a plain config never places a floor, never draws roomgenPrng, keeps its static geometry', () => {
    const cfg: EngineConfig = {
      seed: 1, worldW: 800, worldH: 600, playerStart: [400, 300],
      waves: [[[600, 300]]],
      walls: [[100, 100, 64, 64]],
    };
    const eng = createGameEngine(cfg);
    const wallsBefore = eng.state.walls.length;
    const roomgenBefore = eng.state.roomgenPrng.peek();
    for (let t = 1; t <= 20; t++) eng.step([idle(t)]);
    expect(eng.state.dungeonEnabled).toBe(false);
    expect(eng.state.dungeonRooms.length).toBe(0); // never placed a floor
    expect(eng.state.walls.length).toBe(wallsBefore); // config geometry untouched
    expect(eng.state.roomgenPrng.peek()).toBe(roomgenBefore); // no dungeon draws
  });
});

describe('Dungeon mode — a floor places ALL its rooms co-residently, from tick 1', () => {
  it('generates + places both rooms and their connecting door at once, stitches one shared world', () => {
    const eng = createGameEngine(DUN_CFG);
    const s = eng.state;
    eng.step([idle(1)]);

    expect(s.dungeonEnabled).toBe(true);
    expect(s.floorsEnabled).toBe(true); // dungeon enables the extraction loop
    expect(s.dungeonRooms.length).toBe(2); // [1 normal room, capstone] — BOTH placed already
    expect(s.dungeonDoors.length).toBe(1); // connecting them
    expect(s.dungeonRoomRuntime.length).toBe(2);
    expect(s.dungeonRoomRects.length).toBe(2);

    const room0 = s.dungeonRooms[0]!;
    const capstone = s.dungeonRooms[1]!;
    expect(room0.piece.role).toBeUndefined(); // a normal room, not the capstone
    expect(capstone.piece.role).toBe('extraction'); // floor 0 isn't the last floor

    // BOTH rooms' geometry is stitched into ONE world — not just whichever is "live."
    expect(s.walls.length).toBe(room0.piece.solids.length + capstone.piece.solids.length);
    expect(s.obstacles.length).toBe((room0.piece.pillars?.length ?? 0) + (capstone.piece.pillars?.length ?? 0));
    // World bounds cover the WHOLE floor (rooms placed side by side along one spine).
    expect(s.worldW).toBe(toFpGrid(room0.piece.sizeGrid.w + capstone.piece.sizeGrid.w));
    expect(s.worldH).toBe(toFpGrid(Math.max(room0.piece.sizeGrid.h, capstone.piece.sizeGrid.h)));

    // Player teleported onto room 0's own spawn point (offset by its placement, 0 here
    // since it's first) — but NOT yet "activated": that needs EnvironmentSystem to
    // confirm the position on a later tick (design/05's own accepted one-tick startup
    // lag, same class PvP's own first-room activation already has).
    const ps = room0.piece.spawns.player[0]!;
    expect(s.players[0]!.gx).toBe(toFpGrid(ps.x + room0.offsetXGrid));
    expect(s.players[0]!.gy).toBe(toFpGrid(ps.y + room0.offsetYGrid));
    expect(s.dungeonRoomRuntime[0]!.activated).toBe(false);
  });

  it('room 0 activates (and fires room_enter) the tick AFTER placement, once its roomId is confirmed', () => {
    const eng = createGameEngine(DUN_CFG);
    eng.step([idle(1)]); // floor places; not yet activated
    expect(eng.state.dungeonRoomRuntime[0]!.activated).toBe(false);

    const events = eng.step([idle(2)]);
    expect(eng.state.dungeonRoomRuntime[0]!.activated).toBe(true);
    const room0 = eng.state.dungeonRooms[0]!;
    expect(events.some((e) => e.type === 'room_enter' && e.roomId === room0.id)).toBe(true);
  });
});

describe('Dungeon mode — nothing auto-advances anymore; a room activates only once actually reached', () => {
  it('the capstone stays un-activated until the player is actually inside it', () => {
    const eng = createGameEngine(DUN_CFG);
    const s = eng.state;
    eng.step([idle(1)]); // floor places
    eng.step([idle(2)]); // room 0 activates (empty — no enemies, no lock)
    expect(s.dungeonRoomRuntime[1]!.activated).toBe(false); // capstone untouched

    teleportPlayerInto(eng, s.dungeonRooms[1]!);
    eng.step([idle(3)]); // roomId now matches the capstone → it activates
    expect(s.dungeonRoomRuntime[1]!.activated).toBe(true);
  });
});

describe('Dungeon mode — DESCEND generates the next floor', () => {
  it('a CONFIRM_DESCEND press at the floor-0 checkpoint banks, advances the floor index, and regenerates', () => {
    const eng = createGameEngine(DUN_CFG);
    const s = eng.state;
    s.floorMaterials.mat_fire = 2; // pretend we picked up some material this floor

    eng.step([idle(1)]); // floor places
    eng.step([idle(2)]); // room 0 activates (empty)
    teleportPlayerInto(eng, s.dungeonRooms[1]!);
    eng.step([idle(3)]); // capstone activates (empty) → cleared the same instant

    eng.step([confirmDescend(4)]); // one-shot press — resolves immediately
    expect(s.floorIndex).toBe(1);
    expect(s.dungeonRooms.length).toBe(0); // marked for regeneration
    expect(s.bankedMaterials.mat_fire).toBe(2); // floor buffer banked
    expect(s.phase).not.toBe('gameover');

    eng.step([idle(5)]); // SpawnSystem generates + places floor 1
    expect(s.dungeonRooms.length).toBe(2);
    expect(s.dungeonRooms[1]!.piece.role).toBe('boss'); // floor 1 is the last → boss capstone
  });
});

describe('Dungeon mode — placing a floor REPLACES the room-rect list, it never appends to it', () => {
  it('clears a stale rect the placement did not put there, without depending on who cleared last', () => {
    // `SpawnSystem`'s dungeon branch clears `dungeonRoomRects` before repushing, and
    // `ExtractionSystem.resolveDescend` clears it too. A 2026-08-27 battery deleting SpawnSystem's
    // copy survived the whole suite, because on floor 0 the list is empty at construction and on a
    // descend ExtractionSystem has already emptied it — the trigger existed and no test could
    // reach it. It is a DEFENSIVE clear worth keeping rather than deleting: the alternative makes
    // placement silently depend on its caller having tidied up first, which is exactly the
    // implicit cross-system coupling this engine avoids everywhere else. So make the trigger
    // reachable instead.
    //
    // It matters because the list is what `state/roomModel.ts` answers "which rooms are live"
    // from, and every consumer of that (the camera's fit target, the per-room floor wash/mottle/
    // light pool, `EnvironmentSystem`'s room-membership test) treats a rect in it as a real room.
    // A leftover from the previous floor would have the camera able to frame a room that no longer
    // exists, at coordinates the new floor has re-used for something else.
    const eng = createGameEngine(DUN_CFG);
    const s = eng.state;
    eng.step([idle(1)]); // floor 0 places
    eng.step([idle(2)]); // room 0 activates (empty)
    teleportPlayerInto(eng, s.dungeonRooms[1]!);
    eng.step([idle(3)]); // capstone activates and is cleared the same instant
    eng.step([confirmDescend(4)]); // ExtractionSystem clears the co-resident state
    expect(s.dungeonRoomRects.length).toBe(0);

    // The poke: a rect nothing placed, sitting in the list the tick before floor 1 is placed.
    s.dungeonRoomRects.push({
      id: 'stale_from_floor_0',
      rect: { x: toFpGrid(0), y: toFpGrid(0), w: toFpGrid(4), h: toFpGrid(4) },
    });

    eng.step([idle(5)]); // SpawnSystem generates + places floor 1
    expect(s.dungeonRoomRects.length).toBe(2); // floor 1's two rooms, and only those
    expect(s.dungeonRoomRects.map((r) => r.id)).toEqual(s.dungeonRooms.map((r) => r.id));
    expect(s.dungeonRoomRects.some((r) => r.id === 'stale_from_floor_0')).toBe(false);
  });
});

describe('Dungeon mode — DESCEND leaves the floor’s stranded enemies behind (ENGINE_VERSION 39)', () => {
  // The checkpoint only asks that the CAPSTONE room be cleared (`capstoneCleared`), and
  // never asks where the player is standing — so a floor can absolutely still be holding
  // live enemies elsewhere the tick DESCEND resolves. The realistic route (no impossible
  // walk through a locked door needed): room 0's encounter trickles in, the player kills
  // the first entry, the door unlocks, they walk on and clear the capstone — and only
  // THEN does room 0's late `atTick` entry fire, re-populating a room they already left.
  // Before this fix those enemies rode into the next floor carrying room 0's `roomId` and
  // their old grid positions, i.e. embedded in geometry that had just been torn down.
  const STRAND_LIB: RoomPiece[] = [
    {
      id: 'sd_room', tags: ['sd'], sizeGrid: { w: 20, h: 16 }, solids: [],
      spawns: { player: [{ x: 2, y: 8 }], enemy: [{ x: 16, y: 4 }, { x: 16, y: 12 }] },
      exits: [{ edge: 'east' }],
      encounter: {
        entries: [
          { atTick: 0, enemyType: 'basic', spawnPoint: 0, count: 1 }, // killed on the way through
          { atTick: 8, enemyType: 'basic', spawnPoint: 1, count: 2 }, // fires long after the player left
        ],
      },
    },
    {
      id: 'sd_extract', role: 'extraction', sizeGrid: { w: 10, h: 10 }, solids: [],
      spawns: { player: [{ x: 5, y: 8 }], enemy: [] }, exits: [{ edge: 'west' }],
    },
    {
      id: 'sd_boss', role: 'boss', sizeGrid: { w: 20, h: 16 }, solids: [],
      spawns: { player: [{ x: 2, y: 8 }], enemy: [] }, exits: [{ edge: 'west' }],
    },
  ];
  const STRAND_CFG: EngineConfig = {
    seed: 13, worldW: 640, worldH: 640, waves: [],
    dungeon: {
      config: {
        biomeId: 'sd', nameKey: 'sd', floorCount: 2, roomsPerFloor: { min: 2, max: 2 },
        pieceTags: ['sd'], layout: 'linear', extractionPieceId: 'sd_extract', bossPieceId: 'sd_boss',
        difficultyCurve: { base: 1, perFloor: 0 },
      },
      library: STRAND_LIB,
    },
  };

  /** Drive floor 0 up to "capstone cleared, room 0 re-populated behind me" — the exact
   * state the bug needs. Returns the engine at tick 10, ready for a DESCEND press. */
  function runToStrandedCheckpoint(eng: ReturnType<typeof createGameEngine>): void {
    const s = eng.state;
    eng.step([idle(1)]); // floor 0 places
    eng.step([idle(2)]); // room 0 activates — the atTick-0 entry spawns, its door locks
    expect(s.enemies.length).toBe(1);
    expect(s.dungeonDoors[0]!.locked).toBe(true);

    s.enemies.length = 0; // the player kills it (real combat is exercised elsewhere)
    eng.step([idle(3)]); // DoorSystem sees an empty room → unlocks
    expect(s.dungeonDoors[0]!.locked).toBe(false);

    teleportPlayerInto(eng, s.dungeonRooms[1]!); // walk through the now-open door
    eng.step([idle(4)]); // capstone activates (empty) → cleared; checkpoint is open

    for (let t = 5; t <= 10; t++) eng.step([idle(t)]); // → room-tick 8: room 0's late entry
    expect(s.enemies.length).toBe(2); // room 0 is live again, well behind the player
    expect(s.enemies.every((e) => e.roomId === s.dungeonRooms[0]!.id)).toBe(true);
    expect(s.dungeonRoomRuntime[1]!.activated).toBe(true);
    expect(s.dungeonRoomRuntime[1]!.hasLiveEnemy).toBe(false); // capstone still cleared
  }

  it('drops every enemy left alive on the floor instead of carrying them into the next one', () => {
    const eng = createGameEngine(STRAND_CFG);
    const s = eng.state;
    runToStrandedCheckpoint(eng);
    const dropPrngBefore = s.dropPrng.peek();
    const deathsBefore = s.events.filter((e) => e.type === 'death').length;

    eng.step([confirmDescend(11)]);
    expect(s.floorIndex).toBe(1);
    expect(s.enemies.length).toBe(0); // left behind with the floor they stood on
    // A silent discard, not a mass death: no drop rolls (which would shift every later
    // dropPrng draw in the run and pay out materials for kills that never happened), and
    // no `death` events for render/score to react to.
    expect(s.dropPrng.peek()).toBe(dropPrngBefore);
    expect(s.events.filter((e) => e.type === 'death').length).toBe(deathsBefore);
    expect(s.pickups.length).toBe(0);
  });

  it('leaves the next floor populated only by its OWN rooms — no stale roomId survives', () => {
    const eng = createGameEngine(STRAND_CFG);
    const s = eng.state;
    runToStrandedCheckpoint(eng);
    eng.step([confirmDescend(11)]);

    eng.step([idle(12)]); // SpawnSystem generates + places floor 1
    expect(s.dungeonRooms.length).toBe(2);
    expect(s.enemies.length).toBe(0); // floor 1's rooms haven't been entered yet

    eng.step([idle(13)]); // floor 1's room 0 activates — its own atTick-0 entry spawns
    expect(s.enemies.length).toBe(1);
    // Every live enemy belongs to a room of the CURRENT floor. Pre-fix this failed with
    // 3: floor 0's two strays kept an id that `dungeonRoomIndexById` no longer knows.
    expect(s.enemies.every((e) => e.roomId !== undefined && s.dungeonRoomIndexById.has(e.roomId))).toBe(true);
  });

  it('takes the in-flight bullets with them — nothing shot on the old floor lands on the new one', () => {
    const eng = createGameEngine(STRAND_CFG);
    const s = eng.state;
    runToStrandedCheckpoint(eng);
    // A targeted poke rather than waiting for the stranded mob's own gun, so the
    // assertion never depends on AI/weapon timing. Parked (zero velocity) deep inside
    // room 0, well clear of the player, so nothing but the descend can remove it.
    const room0 = s.dungeonRooms[0]!;
    const bullet: Projectile = {
      id: s.nextId(), faction: 'enemy', teamId: ENEMY_TEAM_ID,
      gx: toFpGrid(room0.offsetXGrid + 10), gy: toFpGrid(room0.offsetYGrid + 2), z: toFp(0),
      vx: toFp(0), vy: toFp(0), radius: toFp(0.15), damage: 1, damageType: 'physical',
      lifeTicks: 90, alive: true,
    };
    s.projectiles.push(bullet);

    eng.step([idle(11)]); // an ordinary tick leaves it flying — the assertion below isn't vacuous
    expect(s.projectiles).toHaveLength(1);

    eng.step([confirmDescend(12)]);
    expect(s.projectiles).toHaveLength(0);
  });

  it('takes an enemy NO room owns with it — a `roomId === undefined` straggler held nothing back', () => {
    // The quieter second route into the same bug. `DoorSystem`'s scan skips any enemy
    // with `roomId === undefined` (so it locks no door and sets no `hasLiveEnemy`), and
    // `capstoneCleared` reads only that flag — a mob in the un-owned space between rooms
    // is therefore invisible to every guard the floor has, and rode into the next floor
    // with nothing having so much as noticed it. Real on a `branching`/`graph2d` floor,
    // whose siblings sit BRANCH_GAP_GRID apart with genuinely un-owned space between them
    // (and v37's chase will walk a mob straight into it); poked in directly here rather
    // than building a whole fork floor just to herd one there. STRAND_CFG's own un-owned
    // pocket is the space south of the 10x10 capstone, past the 20x16 first room's height.
    const eng = createGameEngine(STRAND_CFG);
    const s = eng.state;
    eng.step([idle(1)]); // floor 0 places
    eng.step([idle(2)]); // room 0 activates — its atTick-0 entry spawns
    s.enemies.length = 0; // the player kills it
    eng.step([idle(3)]); // door unlocks
    teleportPlayerInto(eng, s.dungeonRooms[1]!);
    eng.step([idle(4)]); // capstone activates (empty) → cleared; checkpoint open

    const stray = buildEnemyActor(s, toFpGrid(25), toFpGrid(13.5), 'basic');
    s.enemies.push(stray); // `roomId` deliberately left unset — no rect will claim it
    eng.step([idle(5)]);
    expect(stray.alive).toBe(true);
    expect(stray.roomId).toBeUndefined(); // EnvironmentSystem re-checks every tick, still nothing
    expect(s.dungeonRoomRuntime.every((rt) => !rt.hasLiveEnemy)).toBe(true);
    expect(s.dungeonDoors.every((d) => !d.locked)).toBe(true); // it holds nothing back at all

    eng.step([confirmDescend(6)]);
    expect(s.enemies).toHaveLength(0); // cleared wholesale, never by a roomId lookup
  });

  it('an EXTRACT at the same checkpoint leaves them alone — the wipe is DESCEND-only', () => {
    // Nothing to go stale: the run ends here, there is no next floor's geometry for a
    // leftover to be measured against, and `resolveExtract` is a different method for a
    // reason. A guard against someone later hoisting the clear up into `tick()`.
    const eng = createGameEngine(STRAND_CFG);
    const s = eng.state;
    runToStrandedCheckpoint(eng);
    // Since ENGINE_VERSION 61 an EXTRACT press only resolves on the LAST floor, and
    // `runToStrandedCheckpoint` leaves us on floor 0 of 2. Stamped by hand rather than
    // driven a floor deeper: what this test is about is which arrays `resolveExtract`
    // touches, and the stranded-enemy state the helper builds is the same on either
    // floor. `floorCount: 2`, so index 1 IS the last.
    s.floorIndex = 1;

    eng.step([confirmExtract(11)]);
    expect(s.phase).toBe('gameover');
    expect(s.winner).toBe(0);
    expect(s.enemies).toHaveLength(2);
  });

  it('wipes only the floor’s leftovers — the player and their run carry straight through', () => {
    // The other half of the over-reach guard: `state.enemies`/`state.projectiles` are the
    // only actor arrays the descend touches. `players` is a different array with a
    // different lifetime — the run IS the player.
    const eng = createGameEngine(STRAND_CFG);
    const s = eng.state;
    s.floorMaterials.mat_fire = 4;
    runToStrandedCheckpoint(eng);
    const p = s.players[0]!;
    const weaponBefore = p.weapon?.spec.name;
    const maxHpBefore = p.maxHp;

    eng.step([confirmDescend(11)]);
    expect(s.players).toHaveLength(1);
    expect(s.players[0]).toBe(p); // the same object, not a rebuilt one
    expect(p.alive).toBe(true);
    expect(p.hp).toBeGreaterThan(0); // (exact hp is combat's business — the stranded pair shoots)
    expect(p.maxHp).toBe(maxHpBefore);
    expect(p.weapon?.spec.name).toBe(weaponBefore);
    expect(s.bankedMaterials.mat_fire).toBe(4); // the floor buffer still banks normally
  });

  it('stays byte-identical across two engines on the same seed, wipe and all', () => {
    // The wipe is a simulation-output change (hence ENGINE_VERSION 39), so it has to be
    // replay-stable like everything else: it draws no PRNG, so floor 1's generation on
    // the far side of it must still land in lockstep.
    const a = createGameEngine(STRAND_CFG);
    const b = createGameEngine(STRAND_CFG);
    const both = (cmds: Parameters<typeof a.step>[0]): void => {
      a.step(cmds);
      b.step(cmds);
      expect(hashState(b.state)).toBe(hashState(a.state));
    };

    both([idle(1)]);
    both([idle(2)]);
    a.state.enemies.length = 0; // the same "player kills the first entry" poke, both sides
    b.state.enemies.length = 0;
    both([idle(3)]);
    teleportPlayerInto(a, a.state.dungeonRooms[1]!);
    teleportPlayerInto(b, b.state.dungeonRooms[1]!);
    both([idle(4)]);
    for (let t = 5; t <= 10; t++) both([idle(t)]);
    expect(a.state.enemies).toHaveLength(2); // stranded, on both

    both([confirmDescend(11)]); // the wipe itself
    expect(a.state.enemies).toHaveLength(0);
    both([idle(12)]); // floor 1 generates + places — roomgenPrng still in lockstep
    both([idle(13)]);
    expect(a.state.dungeonRooms.map((r) => r.id)).toEqual(b.state.dungeonRooms.map((r) => r.id));
  });
});

describe('Dungeon mode — the last floor has no descend option, but still needs an explicit EXTRACT (2026-08-12 bug fix)', () => {
  it('clearing the deepest floor’s capstone opens the checkpoint; an explicit CONFIRM_EXTRACT ends the run as a win', () => {
    const eng = createGameEngine(DUN_CFG);
    const s = eng.state;
    // Floor 0 → descend to floor 1.
    eng.step([idle(1)]);
    eng.step([idle(2)]);
    teleportPlayerInto(eng, s.dungeonRooms[1]!);
    eng.step([idle(3)]);
    eng.step([confirmDescend(4)]);
    // Floor 1 (last): normal room, then walk into the (enemy-free) boss capstone.
    eng.step([idle(5)]); // floor 1 places
    eng.step([idle(6)]); // room 0 activates
    teleportPlayerInto(eng, s.dungeonRooms[1]!);
    eng.step([idle(7)]); // boss capstone activates (empty) → cleared, but waits on a gesture
    expect(s.floorIndex).toBe(1);
    expect(s.phase).not.toBe('gameover'); // no auto-resolve — the run must still wait

    eng.step([confirmExtract(8)]);
    expect(s.phase).toBe('gameover');
    expect(s.winner).toBe(0);
  });
});

describe('Dungeon mode — hand-authored floors override generation for that floor index (design/05 "Hand-authored PvE floors", 2026-08-05)', () => {
  const AUTHORED_LIB: RoomPiece[] = [
    { id: 'auth_start', sizeGrid: { w: 20, h: 16 }, solids: [], spawns: { player: [{ x: 2, y: 8 }], enemy: [] }, exits: [] },
    { id: 'auth_end', role: 'extraction', sizeGrid: { w: 10, h: 10 }, solids: [], spawns: { player: [{ x: 5, y: 8 }], enemy: [] }, exits: [] },
  ];
  const AUTHORED_FLOOR: DungeonFloorMap = {
    id: 'floor0',
    rooms: [
      { id: 'start', pieceId: 'auth_start', offsetXGrid: 0, offsetYGrid: 0 },
      { id: 'end', pieceId: 'auth_end', offsetXGrid: 20, offsetYGrid: 0 },
    ],
    doors: [{ roomA: 'start', roomB: 'end', passageGrid: { x: 19, y: 4, w: 2, h: 4 } }],
  };
  const cfg: EngineConfig = {
    ...DUN_CFG,
    dungeon: { config: { ...TEST_DUN, floorMaps: { 0: AUTHORED_FLOOR } }, library: [...TEST_LIB, ...AUTHORED_LIB] },
  };

  it('floor 0 places the authored map exactly, drawing zero roomgenPrng values', () => {
    const eng = createGameEngine(cfg);
    const s = eng.state;
    const roomgenBefore = s.roomgenPrng.peek();
    eng.step([idle(1)]);
    expect(s.roomgenPrng.peek()).toBe(roomgenBefore); // authored floor draws nothing
    expect(s.dungeonRooms.map((r) => r.id)).toEqual(['start', 'end']);
    expect(s.dungeonDoors).toHaveLength(1);
    expect(s.dungeonDoors[0]!.door.passageGrid).toEqual(AUTHORED_FLOOR.doors[0]!.passageGrid);
    expect(s.dungeonRooms[1]!.piece.role).toBe('extraction');
  });

  it('a floor index absent from floorMaps still generates procedurally, even after an earlier floor was authored', () => {
    const eng = createGameEngine(cfg);
    const s = eng.state;
    eng.step([idle(1)]); // floor 0: authored
    eng.step([idle(2)]); // 'start' activates (empty)
    teleportPlayerInto(eng, s.dungeonRooms[1]!);
    eng.step([idle(3)]); // 'end' (capstone) activates (empty) → cleared instantly
    eng.step([confirmDescend(4)]);
    expect(s.floorIndex).toBe(1);

    const roomgenBefore = s.roomgenPrng.peek();
    eng.step([idle(5)]); // floor 1 has no floorMaps entry → SpawnSystem falls back to generateFloor/placeFloor
    expect(s.roomgenPrng.peek()).not.toBe(roomgenBefore); // procedural generation DID draw
    expect(s.dungeonRooms.length).toBe(2);
    expect(s.dungeonRooms[1]!.piece.role).toBe('boss'); // floor 1 is the last → TEST_LIB's boss capstone
  });
});

describe('Dungeon mode — a room with a live enemy holds the checkpoint back', () => {
  it('the run never falsely extracts while a room\'s enemy is still alive, even elsewhere on the floor', () => {
    // A one-floor dungeon whose only normal room spawns an enemy; the boss capstone
    // stays reachable (its door was never locked — only the GUARD room's would lock)
    // but must not be treated as cleared/extractable just because IT has no enemy.
    const lib: RoomPiece[] = [
      {
        id: 'guard', tags: ['g'], sizeGrid: { w: 20, h: 16 }, solids: [],
        spawns: { player: [{ x: 2, y: 8 }], enemy: [{ x: 16, y: 8, type: 'basic' }] }, exits: [{ edge: 'east' }],
      },
      {
        id: 'g_boss', role: 'boss', sizeGrid: { w: 20, h: 16 }, solids: [],
        spawns: { player: [{ x: 2, y: 8 }], enemy: [] }, exits: [{ edge: 'west' }],
      },
    ];
    const cfg: EngineConfig = {
      seed: 3, worldW: 640, worldH: 640, waves: [],
      dungeon: {
        config: {
          biomeId: 'g', nameKey: 'g', floorCount: 1, roomsPerFloor: { min: 2, max: 2 },
          pieceTags: ['g'], layout: 'linear', extractionPieceId: 'g_boss', bossPieceId: 'g_boss',
          difficultyCurve: { base: 1, perFloor: 0 },
        },
        library: lib,
      },
    };
    const eng = createGameEngine(cfg);
    const s = eng.state;

    eng.step([idle(1)]); // floor places
    eng.step([idle(2)]); // room 0 (guard) activates — spawns the guard, locks its door
    expect(s.enemies.length).toBe(1);
    expect(s.dungeonDoors[0]!.locked).toBe(true);
    for (let t = 3; t <= 10; t++) eng.step([idle(t)]);
    expect(s.phase).not.toBe('gameover'); // never reached/cleared the boss — no false extraction
    expect(s.enemies.length).toBe(1); // the guard blocks the door; player never got past it

    s.enemies.length = 0; // simulate the guard dying (real combat is exercised elsewhere)
    eng.step([idle(11)]);
    expect(s.dungeonDoors[0]!.locked).toBe(false); // unlocked — now walkable

    teleportPlayerInto(eng, s.dungeonRooms[1]!); // walk through the now-open door
    eng.step([idle(12)]); // boss room activates (empty) → cleared, but waits on a gesture
    expect(s.phase).not.toBe('gameover'); // no auto-resolve — the run must still wait

    eng.step([confirmExtract(13)]);
    expect(s.phase).toBe('gameover');
  });
});

describe('Dungeon mode — determinism', () => {
  it('two engines on the same seed pick the same rooms/doors and stay byte-equal every tick', () => {
    const a = createGameEngine(DUN_CFG);
    const b = createGameEngine(DUN_CFG);
    for (let t = 1; t <= 10; t++) {
      a.step([idle(t)]);
      b.step([idle(t)]);
      expect(hashState(b.state)).toBe(hashState(a.state));
    }
    expect(a.state.dungeonRooms.map((r) => r.id)).toEqual(b.state.dungeonRooms.map((r) => r.id));
    expect(a.state.dungeonDoors.map((d) => d.door.passageGrid)).toEqual(b.state.dungeonDoors.map((d) => d.door.passageGrid));
  });
});

describe('Dungeon mode — WaveScript timing (atTick / spacingTicks), room-local from ACTIVATION', () => {
  // A normal room whose encounter trickles in: 1 mob the tick it activates, then a pair
  // 5 room-ticks later, spaced 3 ticks apart. Capstone is enemy-free.
  const TIMED_LIB: RoomPiece[] = [
    {
      id: 'timed', tags: ['tm'], sizeGrid: { w: 20, h: 16 }, solids: [],
      spawns: { player: [{ x: 2, y: 8 }], enemy: [{ x: 16, y: 4 }, { x: 16, y: 12 }] },
      exits: [{ edge: 'east' }],
      encounter: {
        entries: [
          { atTick: 0, enemyType: 'basic', spawnPoint: 0, count: 1 },
          { atTick: 5, enemyType: 'basic', spawnPoint: 1, count: 2, spacingTicks: 3 },
        ],
      },
    },
    {
      id: 'tm_boss', role: 'boss', sizeGrid: { w: 20, h: 16 }, solids: [],
      spawns: { player: [{ x: 2, y: 8 }], enemy: [] }, exits: [{ edge: 'west' }],
    },
  ];
  const TIMED_CFG: EngineConfig = {
    seed: 11, worldW: 640, worldH: 640, waves: [],
    dungeon: {
      config: {
        biomeId: 'tm', nameKey: 'tm', floorCount: 1, roomsPerFloor: { min: 2, max: 2 },
        pieceTags: ['tm'], layout: 'linear', extractionPieceId: 'tm_boss', bossPieceId: 'tm_boss',
        difficultyCurve: { base: 1, perFloor: 0 },
      },
      library: TIMED_LIB,
    },
  };

  it('spawns entries when due and staggers a count over spacingTicks, starting fresh from ITS OWN activation', () => {
    const eng = createGameEngine(TIMED_CFG);
    const s = eng.state;

    eng.step([idle(1)]); // floor places — room 0 not yet activated
    expect(s.dungeonRoomRuntime[0]!.activated).toBe(false);

    eng.step([idle(2)]); // room 0 activates: room-tick 0 → the atTick-0 entry fires
    const rt = s.dungeonRoomRuntime[0]!;
    expect(rt.activated).toBe(true);
    expect(rt.roomTick).toBe(0);
    expect(rt.schedule.length).toBe(3); // 1 + 2 expanded copies
    expect(rt.cursor).toBe(1);
    expect(s.enemies.length).toBe(1);

    for (let t = 3; t <= 7; t++) eng.step([idle(t)]); // → room-tick 5: first of the pair
    expect(rt.roomTick).toBe(5);
    expect(rt.cursor).toBe(2);

    eng.step([idle(8)]); // room-tick 6 — the spaced copy (atTick 8) is not due yet
    expect(rt.cursor).toBe(2);
    eng.step([idle(9)]); // room-tick 7 — still not due
    expect(rt.cursor).toBe(2);
    eng.step([idle(10)]); // room-tick 8 — the last copy fires
    expect(rt.cursor).toBe(3);
    expect(s.enemies.length).toBe(3); // idle player killed none
  });

  it("the door's lock reacts to live-enemy count in real time — clearing a wave early re-opens it until the next one spawns", () => {
    const eng = createGameEngine(TIMED_CFG);
    const s = eng.state;
    eng.step([idle(1)]); // floor places
    eng.step([idle(2)]); // room 0 activates — the atTick-0 entry spawns, door locks
    expect(s.dungeonDoors[0]!.locked).toBe(true);

    s.enemies.length = 0; // clear the first wave early, well before room-tick 5's pair
    eng.step([idle(3)]); // DoorSystem sees zero live enemies this tick → unlocks
    expect(s.dungeonDoors[0]!.locked).toBe(false);

    for (let t = 4; t <= 7; t++) eng.step([idle(t)]); // → room-tick 5: the pair's first copy
    expect(s.dungeonRoomRuntime[0]!.roomTick).toBe(5);
    expect(s.enemies.length).toBe(1);
    expect(s.dungeonDoors[0]!.locked).toBe(true); // re-locked the instant it has a live enemy again
  });
});

describe('Dungeon mode — a room\'s far-side enemies do not alpha-strike on activation (ENGINE_VERSION 40)', () => {
  // The end-to-end regression for the reported bug ("一进入地图就被几十个怪物集火，瞬间就死了"):
  // a wide room whose whole garrison spawns at tick 0 (SpawnSystem's hand-authored
  // default, same as every real level-1 room) — one enemy right next to the player
  // spawn (well inside engageRangeFp), one clear across the room (well outside it).
  // Both are in the SAME activated room, spawned the SAME tick, driven through the
  // real createGameEngine pipeline (AIDecideSystem → WeaponFireSystem → Movement, not
  // a hand-rolled subset) — this is the actual whole-room alpha strike the unit-level
  // AIDecideSystem/enemyChase tests can't see, since they never spawn two enemies at
  // once through a real room activation.
  const FAR_LIB: RoomPiece[] = [
    {
      id: 'far_hall', tags: ['far'], sizeGrid: { w: 30, h: 10 }, solids: [],
      // x=4 is ~2 grid (~64px) from the player spawn at x=2 — inside the default
      // ~5.6 grid engage range. x=28 is ~26 grid (~832px) away — nowhere close.
      spawns: { player: [{ x: 2, y: 5 }], enemy: [{ x: 4, y: 5 }, { x: 28, y: 5 }] },
      exits: [{ edge: 'east' }],
      encounter: {
        entries: [
          { atTick: 0, enemyType: 'basic', spawnPoint: 0, count: 1 }, // near
          { atTick: 0, enemyType: 'basic', spawnPoint: 1, count: 1 }, // far
        ],
      },
    },
    {
      id: 'far_boss', role: 'boss', sizeGrid: { w: 20, h: 16 }, solids: [],
      spawns: { player: [{ x: 2, y: 8 }], enemy: [] }, exits: [{ edge: 'west' }],
    },
  ];
  const FAR_CFG: EngineConfig = {
    seed: 13, worldW: 640, worldH: 640, waves: [],
    dungeon: {
      config: {
        biomeId: 'far', nameKey: 'far', floorCount: 1, roomsPerFloor: { min: 2, max: 2 },
        pieceTags: ['far'], layout: 'linear', extractionPieceId: 'far_boss', bossPieceId: 'far_boss',
        difficultyCurve: { base: 1, perFloor: 0 },
      },
      library: FAR_LIB,
    },
  };

  it('neither enemy fires during the notice window, then only the near one does (ENGINE_VERSION 40 + 41)', () => {
    const eng = createGameEngine(FAR_CFG);
    const s = eng.state;
    eng.step([idle(1)]); // floor places
    eng.step([idle(2)]); // room 0 activates — both atTick:0 entries spawn this same tick
    expect(s.enemies.length).toBe(2);
    // AIDecideSystem (step 2) runs before SpawnSystem (later) in a tick's own order, so
    // a freshly-spawned enemy gets its first real AI decision the tick AFTER it spawns
    // — same one-tick lag `room_enter`/`activated` itself already has (see the
    // "activates the tick AFTER placement" test above).
    eng.step([idle(3)]);
    // Identify by position rather than assuming dispatch order.
    const far = s.enemies.reduce((a, b) => (a.gx > b.gx ? a : b));
    const near = s.enemies.reduce((a, b) => (a.gx < b.gx ? a : b));
    // v41: even the mob standing right next to the spawn holds fire through its own
    // staggered notice delay — this is the reaction window on room entry, and it is
    // why walking in is no longer an instant volley from whatever spawned nearest.
    expect(near.firing).toBe(false);
    expect(far.firing).toBe(false);

    // Step past the longest possible notice delay; the far mob is ~26 grid out and
    // closes only ~4px/tick, so it is still nowhere near engage range afterwards.
    let t = 4;
    for (; t <= 3 + NOTICE_DELAY_TICKS + NOTICE_SPREAD_TICKS; t++) eng.step([idle(t)]);
    expect(far.firing).toBe(false); // the whole point of ENGINE_VERSION 40
    expect(near.firing).toBe(true); // a genuinely close threat engages, just not instantly
  });

  it('the far enemy still has not fired a single bullet after several more ticks — it has to close the distance first', () => {
    const eng = createGameEngine(FAR_CFG);
    const s = eng.state;
    eng.step([idle(1)]);
    eng.step([idle(2)]); // activation
    for (let t = 3; t <= 15; t++) eng.step([idle(t)]); // 13 more ticks — nowhere near enough to close ~770px
    const far = s.enemies.reduce((a, b) => (a.gx > b.gx ? a : b));
    expect(far.gx).toBeGreaterThan(toFpGrid(20)); // confirms it's still the far one, not some other actor
    expect(far.firing).toBe(false);
    // Every live projectile so far belongs to the near enemy (or the player, if any) —
    // none originated from the far one, i.e. no bullet crossed the room on activation.
    for (const p of s.projectiles) {
      if (!p.alive) continue;
      expect(p.ownerId).not.toBe(far.id);
    }
  });
});

describe('Dungeon mode — branching layout resolves at generation time, not via player input', () => {
  // design/05 (2026-08-04, updated 2026-08-05 "fully-realized branching"): the old
  // chooseBranch read player facing "at the moment of arrival" — that moment no
  // longer exists once every room is placed before any player acts. This fixture's
  // roomsPerFloor min=max=2 → normalCount=1, BELOW the 2-normal-stage minimum a real
  // fork needs (a fork point AND a reconvergence point), so it still exercises the
  // "no eligible fork slot" degrade path under the new algorithm too — a real
  // sibling fork, exercised end-to-end, is the dedicated describe block below. Deep
  // resolution-mechanics coverage (both the degrade and the real-fork case) lives in
  // dungeon.test.ts; this is just the integration smoke test that the full engine
  // still produces a valid, deterministic floor.
  const BR_LIB: RoomPiece[] = [
    { id: 'br_a', tags: ['b'], sizeGrid: { w: 20, h: 16 }, solids: [], spawns: { player: [{ x: 2, y: 8 }], enemy: [] }, exits: [{ edge: 'east' }] },
    { id: 'br_b', tags: ['b'], sizeGrid: { w: 22, h: 14 }, solids: [], spawns: { player: [{ x: 2, y: 7 }], enemy: [] }, exits: [{ edge: 'east' }] },
    { id: 'br_boss', role: 'boss', sizeGrid: { w: 20, h: 16 }, solids: [], spawns: { player: [{ x: 2, y: 8 }], enemy: [] }, exits: [{ edge: 'west' }] },
  ];
  const cfg = (seed: number): EngineConfig => ({
    seed, worldW: 640, worldH: 640, waves: [],
    dungeon: {
      config: {
        biomeId: 'b', nameKey: 'b', floorCount: 1, roomsPerFloor: { min: 2, max: 2 },
        pieceTags: ['b'], layout: 'branching', branchFactor: 2,
        extractionPieceId: 'br_boss', bossPieceId: 'br_boss', difficultyCurve: { base: 1, perFloor: 0 },
      },
      library: BR_LIB,
    },
  });

  it('resolves a real pool room deterministically per seed — no crash, no leftover candidate structure', () => {
    const a1 = createGameEngine(cfg(5));
    const a2 = createGameEngine(cfg(5));
    a1.step([idle(1)]);
    a2.step([idle(1)]);
    expect(a1.state.dungeonRooms.length).toBe(2);
    expect(['br_a', 'br_b']).toContain(a1.state.dungeonRooms[0]!.piece.id);
    expect(a1.state.dungeonRooms[1]!.piece.id).toBe('br_boss');
    expect(a1.state.dungeonRooms.map((r) => r.piece.id)).toEqual(a2.state.dungeonRooms.map((r) => r.piece.id));
  });
});

describe('Dungeon mode — a real fork places real sibling rooms end-to-end (design/05, 2026-08-05)', () => {
  // A pool of exactly TWO same-width, same-height, enemy-carrying pieces — with
  // roomsPerFloor min=max=3 (normalCount=2), forkStageIndex = 1 + nextInt(1) = 1
  // ALWAYS, for every seed, and the fork's sameWidth partner search always finds
  // exactly the other pool piece, so this floor is ALWAYS
  // [hub, [sibA, sibB], capstone] regardless of seed — no seed search needed. Both
  // pool pieces carry an enemy (whichever one is drawn for the hub gets cleared in
  // the test below before proceeding, exactly like doors.test.ts's own "clear the
  // guard" convention) so combat-lock is exercised on every room, not just siblings.
  const FK_A: RoomPiece = {
    id: 'fk_a', tags: ['fk'], sizeGrid: { w: 20, h: 20 }, solids: [],
    spawns: { player: [{ x: 2, y: 10 }], enemy: [{ x: 10, y: 10, type: 'basic' }] },
    exits: [{ edge: 'west' }, { edge: 'east' }],
  };
  const FK_B: RoomPiece = {
    id: 'fk_b', tags: ['fk'], sizeGrid: { w: 20, h: 20 }, solids: [],
    spawns: { player: [{ x: 2, y: 10 }], enemy: [{ x: 10, y: 10, type: 'basic' }] },
    exits: [{ edge: 'west' }, { edge: 'east' }],
  };
  const FK_CAP: RoomPiece = {
    id: 'fk_cap', role: 'boss', sizeGrid: { w: 14, h: 42 }, solids: [],
    spawns: { player: [{ x: 7, y: 21 }], enemy: [] }, exits: [{ edge: 'west' }],
  };
  const FORK_DUN: DungeonConfig = {
    biomeId: 'fk', nameKey: 'fk', floorCount: 1, roomsPerFloor: { min: 3, max: 3 },
    pieceTags: ['fk'], layout: 'branching', branchFactor: 2,
    extractionPieceId: 'fk_cap', bossPieceId: 'fk_cap', difficultyCurve: { base: 1, perFloor: 0 },
  };
  const FORK_CFG: EngineConfig = {
    seed: 7, worldW: 640, worldH: 640, waves: [],
    players: [{}, {}], // trigger (owner 0) + bystander, same shape as doors.test.ts's force-regroup fixture
    dungeon: { config: FORK_DUN, library: [FK_A, FK_B, FK_CAP] },
  };

  it('places 4 rooms / 4 doors (a diamond, not a rooms.length-1 chain)', () => {
    const eng = createGameEngine(FORK_CFG);
    eng.step([idle(1)]);
    const s = eng.state;
    expect(s.dungeonRooms.length).toBe(4); // hub, 2 siblings, capstone
    expect(s.dungeonDoors.length).toBe(4); // hub→sib0, hub→sib1, sib0→cap, sib1→cap
    // Siblings share the hub's east boundary X and are stacked apart in Y.
    const [hub, sibA, sibB, cap] = s.dungeonRooms;
    expect(sibA!.offsetXGrid).toBe(hub!.offsetXGrid + hub!.piece.sizeGrid.w);
    expect(sibB!.offsetXGrid).toBe(sibA!.offsetXGrid);
    expect(sibA!.offsetYGrid).not.toBe(sibB!.offsetYGrid);
    expect(cap!.offsetXGrid).toBe(sibA!.offsetXGrid + sibA!.piece.sizeGrid.w);
  });

  it('combat-lock is per-sibling: entering one sibling never locks the untaken sibling\'s door', () => {
    const eng = createGameEngine(FORK_CFG);
    const s = eng.state;
    eng.step([idle(1)]); // floor places
    eng.step([idle(2)]); // hub activates → its own authored enemy spawns → hub's forward doors lock
    const [hub, sibA, sibB, cap] = s.dungeonRooms;
    expect(s.dungeonRoomRuntime[0]!.hasLiveEnemy).toBe(true);

    s.enemies.length = 0; // clear the hub's guard (doors.test.ts's own "clear the guard" convention)
    eng.step([idle(3)]); // DoorSystem sees zero live enemies → hub's doors unlock

    teleportPlayerInto(eng, sibA!); // walk through the now-open hub→sibA door
    eng.step([idle(4)]); // sibA's roomId confirmed → activates → its own enemy spawns → locks

    expect(s.dungeonRoomRuntime[1]!.activated).toBe(true);
    expect(s.dungeonRoomRuntime[1]!.hasLiveEnemy).toBe(true);
    expect(s.dungeonRoomRuntime[2]!.activated).toBe(false); // sibB never entered
    expect(s.dungeonRoomRuntime[2]!.hasLiveEnemy).toBe(false);

    const doorLockedBetween = (aId: string, bId: string) =>
      s.dungeonDoors.find((d) => (d.door.roomA === aId && d.door.roomB === bId) || (d.door.roomA === bId && d.door.roomB === aId))!.locked;
    expect(doorLockedBetween(hub!.id, sibA!.id)).toBe(true); // sibA's own doors locked
    expect(doorLockedBetween(sibA!.id, cap!.id)).toBe(true);
    expect(doorLockedBetween(hub!.id, sibB!.id)).toBe(false); // sibB's own doors untouched
    expect(doorLockedBetween(sibB!.id, cap!.id)).toBe(false);
  });

  it('force-regroup pulls the bystander into the entered sibling, never the untaken one', () => {
    const eng = createGameEngine(FORK_CFG);
    const s = eng.state;
    eng.step([idle(1)]); // floor places
    eng.step([idle(2)]); // hub activates, locks
    s.enemies.length = 0;
    eng.step([idle(3)]); // hub unlocks
    const [, sibA, sibB] = s.dungeonRooms;
    const bystanderRoomBefore = s.players[1]!.roomId;

    teleportPlayerInto(eng, sibA!);
    const events = eng.step([idle(4)]); // sibA activates → force-regroup fires

    expect(s.players[1]!.roomId).toBe(sibA!.id); // pulled into the entered sibling
    expect(s.players[1]!.roomId).not.toBe(bystanderRoomBefore);
    expect(s.players[1]!.roomId).not.toBe(sibB!.id); // never the untaken one
    expect(events.some((e) => e.type === 'force_regroup' && e.roomId === sibA!.id)).toBe(true);
  });

  it('walking from either sibling into the capstone works — the reconvergence', () => {
    const eng = createGameEngine(FORK_CFG);
    const s = eng.state;
    eng.step([idle(1)]);
    eng.step([idle(2)]);
    s.enemies.length = 0;
    eng.step([idle(3)]);
    const [, sibA, , cap] = s.dungeonRooms;
    teleportPlayerInto(eng, sibA!);
    eng.step([idle(4)]); // sibA activates, locks
    s.enemies.length = 0;
    eng.step([idle(5)]); // sibA unlocks

    teleportPlayerInto(eng, cap!);
    eng.step([idle(6)]);
    expect(s.dungeonRoomRuntime[3]!.activated).toBe(true);
  });
});

describe('Dungeon mode — the real Ember biome runs end-to-end', () => {
  it('places the shipped level 1 (authored floor 0) without throwing; bounds are set once and stay stable', () => {
    const eng = createGameEngine({
      seed: 0xda1d, worldW: 1600, worldH: 1200, waves: [],
      dungeon: { config: EMBER_DUNGEON, library: EMBER_L1_ROOMS },
    });
    const s = eng.state;
    eng.step([idle(1)]); // first Ember floor places
    // Level 1's floor 0 is hand-authored (world/dungeons/ember/ember_l1_floor_1.json):
    // exactly 5 rooms, not a `roomsPerFloor` draw. The room/door SHAPE of every floor
    // is `world/rooms/emberLevel1.test.ts`'s job — this asserts the live engine walks
    // the authored path and stitches it into one stable world.
    expect(s.dungeonRooms.length).toBe(5);
    expect(s.dungeonDoors.length).toBe(s.dungeonRooms.length - 1);
    const worldWAtPlacement = s.worldW;
    const worldHAtPlacement = s.worldH;
    // Unlike the old per-room swap model, bounds cover the WHOLE floor and are set once
    // — drive a while and confirm they never get resized out from under anything.
    for (let t = 2; t <= 60; t++) {
      eng.step([idle(t)]);
      expect(s.worldW).toBe(worldWAtPlacement);
      expect(s.worldH).toBe(worldHAtPlacement);
    }
  });

  // `placeAdjacent2d` (world/dungeon.ts) centers whichever axis a hop DIDN'T
  // travel along, so plain `offsetYGrid !== 0` is not a reliable "did it bend"
  // signal by itself (an east/west-only chain already shifts offsetYGrid room to
  // room whenever two consecutive pieces have different heights) — a shared
  // centerX between two consecutive rooms is what a real north/south hop leaves
  // behind, matching dungeon.test.ts's own `isVerticalHop` check.
  function tookVerticalHop(rooms: readonly { offsetXGrid: number; piece: RoomPiece }[]): boolean {
    for (let i = 1; i < rooms.length; i++) {
      const a = rooms[i - 1]!;
      const b = rooms[i]!;
      if (a.offsetXGrid + a.piece.sizeGrid.w / 2 === b.offsetXGrid + b.piece.sizeGrid.w / 2) return true;
    }
    return false;
  }

  // The PROCEDURAL Ember pair (world/rooms/ember.ts `EMBER_PROCEDURAL_DUNGEON` +
  // `EMBER_ROOMS`): the shipped `EMBER_DUNGEON` authors every floor now, so it never
  // reaches `placeFloorGraph2d`. This test's whole point is that a BENT generated
  // floor survives the full live pipeline, so it keeps driving the pair that
  // actually generates.
  it("a bending seed places the procedural Ember pair via placeFloorGraph2d end-to-end, doors and all (design/05, 2026-08-05 'graph2d' content follow-up)", () => {
    // Found by a live search here (rather than pinning dungeon.test.ts's own found
    // seed, which searches at the pure-function level) so this exact seed is
    // checked through the FULL live pipeline (buildFloorGeometry's door-gap
    // carving + DoorSystem), not just the pure placement function.
    let bendingSeed = -1;
    for (let seed = 1; seed <= 200; seed++) {
      const eng = createGameEngine({
        seed, worldW: 1600, worldH: 1200, waves: [],
        dungeon: { config: EMBER_PROCEDURAL_DUNGEON, library: EMBER_ROOMS },
      });
      eng.step([idle(1)]);
      if (tookVerticalHop(eng.state.dungeonRooms)) {
        bendingSeed = seed;
        break;
      }
    }
    expect(bendingSeed).toBeGreaterThan(0);

    const eng = createGameEngine({
      seed: bendingSeed, worldW: 1600, worldH: 1200, waves: [],
      dungeon: { config: EMBER_PROCEDURAL_DUNGEON, library: EMBER_ROOMS },
    });
    const s = eng.state;
    eng.step([idle(1)]);
    expect(tookVerticalHop(s.dungeonRooms)).toBe(true);
    expect(s.dungeonDoors.length).toBe(s.dungeonRooms.length - 1);
    // The bent floor still stitches into one shared, walkable world — same
    // door-gap-carving/DoorSystem machinery as any straight floor, no special case.
    for (let t = 2; t <= 10; t++) eng.step([idle(t)]);
    expect(s.dungeonRoomRuntime.length).toBe(s.dungeonRooms.length);
  });
});

describe('Dungeon mode — `layout: \'graph2d\'` places a real 2D floor end-to-end (ROADMAP "real 2D graph layout" follow-up)', () => {
  // A pool with one all-4-exit piece (like ember_cross) and a west-only capstone —
  // roomsPerFloor min=max=2 → exactly [g2_cross, capstone], so the ONE transition
  // is cross's own outgoing choice (undefined entryEdge → all 4 exits viable,
  // narrowed to whichever the capstone's lone 'west' exit matches: 'east' only —
  // deterministic, not seed-dependent, so this floor always places due east,
  // proving graph2d wires correctly end-to-end without needing a seed search for a
  // north/south-bending case (that geometry is dungeon.test.ts's own concern).
  const G2_CROSS: RoomPiece = {
    id: 'g2_cross', tags: ['g2'], sizeGrid: { w: 16, h: 16 }, solids: [],
    spawns: { player: [{ x: 8, y: 8 }], enemy: [] },
    exits: [{ edge: 'north' }, { edge: 'south' }, { edge: 'east' }, { edge: 'west' }],
  };
  const G2_CAP: RoomPiece = {
    id: 'g2_cap', role: 'boss', sizeGrid: { w: 12, h: 10 }, solids: [],
    spawns: { player: [{ x: 6, y: 5 }], enemy: [] }, exits: [{ edge: 'west' }],
  };
  const G2_DUN: DungeonConfig = {
    biomeId: 'g2', nameKey: 'g2', floorCount: 1, roomsPerFloor: { min: 2, max: 2 },
    pieceTags: ['g2'], layout: 'graph2d',
    extractionPieceId: 'g2_cap', bossPieceId: 'g2_cap', difficultyCurve: { base: 1, perFloor: 0 },
  };
  const G2_CFG: EngineConfig = {
    seed: 3, worldW: 640, worldH: 640, waves: [],
    dungeon: { config: G2_DUN, library: [G2_CROSS, G2_CAP] },
  };

  it('generates + places a floor via placeFloorGraph2d, stitches one shared world, no throw', () => {
    const eng = createGameEngine(G2_CFG);
    const s = eng.state;
    eng.step([idle(1)]);
    expect(s.dungeonRooms.length).toBe(2);
    expect(s.dungeonDoors.length).toBe(1);
    const [room0, cap] = s.dungeonRooms;
    expect(room0!.piece.id).toBe('g2_cross');
    expect(cap!.piece.id).toBe('g2_cap');
    expect(cap!.offsetXGrid).toBe(room0!.offsetXGrid + room0!.piece.sizeGrid.w); // placed east
    expect(s.worldW).toBe(toFpGrid(room0!.piece.sizeGrid.w + cap!.piece.sizeGrid.w));
  });

  it('walking through the door into the capstone activates it, same as any other layout', () => {
    const eng = createGameEngine(G2_CFG);
    const s = eng.state;
    eng.step([idle(1)]);
    eng.step([idle(2)]); // room 0 activates
    const cap = s.dungeonRooms[1]!;
    teleportPlayerInto(eng, cap);
    eng.step([idle(3)]);
    expect(s.dungeonRoomRuntime[1]!.activated).toBe(true);
  });

  it('is deterministic end-to-end for a given seed', () => {
    const a = createGameEngine(G2_CFG);
    const b = createGameEngine(G2_CFG);
    a.step([idle(1)]);
    b.step([idle(1)]);
    expect(a.state.dungeonRooms.map((r) => ({ id: r.id, x: r.offsetXGrid, y: r.offsetYGrid }))).toEqual(
      b.state.dungeonRooms.map((r) => ({ id: r.id, x: r.offsetXGrid, y: r.offsetYGrid })),
    );
  });
});

describe('Dungeon mode — a `graph2d` floor that actually BENDS (south, not east) runs end-to-end', () => {
  // Forced, seed-independent bend: the spawn room has only a 'south' exit and the
  // capstone only a 'north' one, so there is exactly one viable direction and no
  // PRNG luck involved — proving the whole live pipeline (buildFloorGeometry's
  // door-gap carving, DoorSystem activation, walkability) handles a horizontal
  // (north/south-wall) door correctly, not just the always-vertical doors every
  // other dungeon fixture in this file happens to produce.
  const BEND_SPAWN: RoomPiece = {
    id: 'bend_spawn', tags: ['bend'], sizeGrid: { w: 14, h: 12 }, solids: [],
    spawns: { player: [{ x: 7, y: 2 }], enemy: [] }, exits: [{ edge: 'south' }],
  };
  const BEND_CAP: RoomPiece = {
    id: 'bend_cap', role: 'boss', sizeGrid: { w: 14, h: 10 }, solids: [],
    spawns: { player: [{ x: 7, y: 5 }], enemy: [] }, exits: [{ edge: 'north' }],
  };
  const BEND_DUN: DungeonConfig = {
    biomeId: 'bend', nameKey: 'bend', floorCount: 1, roomsPerFloor: { min: 2, max: 2 },
    pieceTags: ['bend'], layout: 'graph2d',
    extractionPieceId: 'bend_cap', bossPieceId: 'bend_cap', difficultyCurve: { base: 1, perFloor: 0 },
  };
  const BEND_CFG: EngineConfig = {
    seed: 11, worldW: 640, worldH: 640, waves: [],
    dungeon: { config: BEND_DUN, library: [BEND_SPAWN, BEND_CAP] },
  };

  it('places the capstone directly SOUTH of the spawn room, with a horizontal door carved through both walls', () => {
    const eng = createGameEngine(BEND_CFG);
    const s = eng.state;
    eng.step([idle(1)]);
    const [room0, cap] = s.dungeonRooms;
    expect(cap!.offsetYGrid).toBe(room0!.offsetYGrid + room0!.piece.sizeGrid.h); // south, not east
    expect(cap!.offsetXGrid).toBe(room0!.offsetXGrid); // centered — same width, same X

    const doorRt = s.dungeonDoors[0]!;
    expect(doorRt.door.passageGrid.w).toBeGreaterThan(doorRt.door.passageGrid.h); // horizontal passage
    // The door's own center is open (not a wall) — a real, walkable carved gap.
    const cx = toFpGrid(doorRt.door.passageGrid.x + doorRt.door.passageGrid.w / 2);
    const cy = toFpGrid(doorRt.door.passageGrid.y + doorRt.door.passageGrid.h / 2);
    const coveredAtCenter = s.walls.some((w) => cx >= w.x && cx < w.x + w.w && cy >= w.y && cy < w.y + w.h);
    expect(coveredAtCenter).toBe(false);
  });

  it('walking south through the door activates the capstone, same as any east-going floor', () => {
    const eng = createGameEngine(BEND_CFG);
    const s = eng.state;
    eng.step([idle(1)]);
    eng.step([idle(2)]); // room 0 activates
    const cap = s.dungeonRooms[1]!;
    teleportPlayerInto(eng, cap);
    eng.step([idle(3)]);
    expect(s.dungeonRoomRuntime[1]!.activated).toBe(true);
  });
});
