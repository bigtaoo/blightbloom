/**
 * AIDecideSystem.tick() — PvE enemy facing/fire-intent/chase decision (see the
 * module's own doc comment for the no-target early-out, the chase-to-engage-range
 * movement, and the dungeon room-activation gate's rationale, design/05 "Room &
 * door model", 2026-08-04; movement added ENGINE_VERSION 37).
 */
import { describe, it, expect } from 'vitest';
import { isqrt, toFp } from '@dd/engine/math/fixed';
import type { Fp } from '@dd/engine/math/fixed';
import type { Brad } from '@dd/engine/math/trig';
import { atan2Brad } from '@dd/engine/math/trig';
import { pxToFp } from '@dd/engine/content/convert';
import { createGameState } from '@dd/engine/state/GameState';
import type { GameState } from '@dd/engine/state/GameState';
import { ENEMY_TEAM_ID, type EnemyActor } from '@dd/engine/state/entities';
import { freshStatus } from '@dd/engine/content/damage';
import {
  BASIC_ENEMY,
  DEFAULT_ENEMY_ENGAGE_RANGE_FP,
  DEFAULT_ENEMY_MOVE_SPEED_PER_TICK,
} from '@dd/engine/content/enemies';
import { AIDecideSystem } from '@dd/engine/systems/AIDecideSystem';
import { MovementSystem } from '@dd/engine/systems/MovementSystem';
import {
  NOTICE_DELAY_TICKS,
  NOTICE_SPREAD_TICKS,
  ROOM_FIRE_BUDGET,
  noticeDelayTicks,
} from '@dd/engine/balance/encounter';
import type { DungeonRoomRuntime } from '@dd/engine/state/GameState.types';
import type { DungeonConfig } from '@dd/engine/world/dungeon';
import type { RoomPiece } from '@dd/engine/content/rooms';

const CFG = { seed: 29, worldW: 1600, worldH: 1200, waves: [] as const };

/** Adds a mob that has ALREADY noticed the player (`aggroed`, v42's perception-radius
 *  latch) — same "don't silently gate a test that is about something else" intent as
 *  `activateRoom` below. The perception radius has its own describe block, which builds
 *  its mobs with `aggroed: false` explicitly. */
function addEnemy(s: GameState, xpx: number, ypx: number, roomId?: string): EnemyActor {
  const e = addUnawareEnemy(s, xpx, ypx, roomId);
  e.aggroed = true;
  return e;
}

function addUnawareEnemy(s: GameState, xpx: number, ypx: number, roomId?: string): EnemyActor {
  const e: EnemyActor = {
    id: s.nextId(), faction: 'enemy', teamId: ENEMY_TEAM_ID,
    gx: pxToFp(xpx), gy: pxToFp(ypx), z: toFp(0), vx: toFp(0), vy: toFp(0),
    knockVx: toFp(0), knockVy: toFp(0),
    facing: 0 as Brad, hp: BASIC_ENEMY.maxHp, maxHp: BASIC_ENEMY.maxHp, shield: 0, maxShield: 0,
    ticksSinceHit: 0, radius: BASIC_ENEMY.radius, footprintRadius: BASIC_ENEMY.footprintRadius, solidRadius: BASIC_ENEMY.radius,
    alive: true, weapon: null, firing: false, status: freshStatus(), enraged: false, aggroed: false, holding: false, roomId,
  };
  s.enemies.push(e);
  return e;
}

// Minimal dungeon config: only `dungeon`'s PRESENCE matters here (it flips
// `state.dungeonEnabled`) — `generateFloor` is never invoked by these tests, so
// none of the catalog's actual field values are exercised.
const DUMMY_ROOM: RoomPiece = {
  id: 'r', sizeGrid: { w: 10, h: 10 }, solids: [],
  spawns: { player: [{ x: 5, y: 5 }], enemy: [] }, exits: [],
};
const DUMMY_DUNGEON: DungeonConfig = {
  biomeId: 'd', nameKey: 'd', floorCount: 1, roomsPerFloor: { min: 1, max: 1 },
  pieceTags: ['d'], layout: 'linear', extractionPieceId: 'r', bossPieceId: 'r',
  difficultyCurve: { base: 1, perFloor: 0 },
};

function dungeonState(): GameState {
  return createGameState({ ...CFG, dungeon: { config: DUMMY_DUNGEON, library: [DUMMY_ROOM] } });
}

/** Register `roomId` as an activated room whose garrison has already noticed the
 *  player (`roomTick` past every possible `noticeDelayTicks`, v41), so a test that is
 *  about something else isn't silently gated by the notice window. Returns the runtime
 *  row for tests that do want to drive `roomTick` themselves. */
function activateRoom(s: GameState, roomId: string): DungeonRoomRuntime {
  const rt: DungeonRoomRuntime = {
    activated: true,
    roomTick: NOTICE_DELAY_TICKS + NOTICE_SPREAD_TICKS,
    schedule: [],
    cursor: 0,
    hasLiveEnemy: false,
  };
  s.dungeonRoomIndexById.set(roomId, s.dungeonRoomRuntime.length);
  s.dungeonRoomRuntime.push(rt);
  return rt;
}

describe('AIDecideSystem.tick — no-target early-out', () => {
  it('sets firing false (overriding a prior true) when no player exists at all', () => {
    const s = createGameState({ ...CFG, players: [] });
    const e = addEnemy(s, 900, 700);
    e.firing = true;
    e.vx = toFp(1);
    e.vy = toFp(1);
    new AIDecideSystem().tick(s);
    expect(e.firing).toBe(false);
    expect(e.vx).toBe(toFp(0)); // no target → also stop moving (ENGINE_VERSION 37)
    expect(e.vy).toBe(toFp(0));
  });

  it('sets firing false when the only player is downed (design/07 — ignore a body that cannot fight back)', () => {
    const s = createGameState(CFG);
    s.players[0]!.downed = true;
    const e = addEnemy(s, 900, 700);
    e.firing = true;
    e.vx = toFp(1);
    new AIDecideSystem().tick(s);
    expect(e.firing).toBe(false);
    expect(e.vx).toBe(toFp(0));
  });

  it('skips a dead enemy entirely — leaves its facing/firing/vx/vy untouched', () => {
    const s = createGameState(CFG);
    const e = addEnemy(s, 900, 700);
    e.alive = false;
    e.firing = false;
    e.vx = toFp(3);
    const facingBefore = e.facing;
    new AIDecideSystem().tick(s);
    expect(e.facing).toBe(facingBefore);
    expect(e.firing).toBe(false);
    expect(e.vx).toBe(toFp(3));
  });

  it('targets the first alive, non-downed player when several exist', () => {
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }, { start: [900, 700] }] });
    s.players[0]!.downed = true; // first seat is downed — must be skipped
    const e = addEnemy(s, 0, 0);
    new AIDecideSystem().tick(s);
    const target = s.players[1]!;
    expect(e.facing).toBe(atan2Brad(target.gy - e.gy, target.gx - e.gx));
    // Correctly targets seat 1 (not the downed seat 0), but it's far outside engage
    // range, so it must not be firing yet (ENGINE_VERSION 40) — facing and firing
    // are independent now.
    expect(e.firing).toBe(false);
  });
});

describe('AIDecideSystem.tick — atan2 facing', () => {
  it('faces exactly toward the target via atan2Brad(dy, dx) and sets firing true once in range', () => {
    const s = createGameState({ ...CFG, players: [{ start: [900, 700] }] });
    const target = s.players[0]!;
    const e = addEnemy(s, 850, 650); // within the default ~180px engage range, off-axis
    new AIDecideSystem().tick(s);
    expect(e.facing).toBe(atan2Brad(target.gy - e.gy, target.gx - e.gx));
    expect(e.firing).toBe(true);
  });

  it('re-faces every tick as the target moves', () => {
    const s = createGameState({ ...CFG, players: [{ start: [900, 700] }] });
    const target = s.players[0]!;
    const e = addEnemy(s, 400, 400);
    new AIDecideSystem().tick(s);
    const firstFacing = e.facing;
    target.gx = pxToFp(400); // target moves to sit directly above the enemy
    target.gy = pxToFp(0);
    new AIDecideSystem().tick(s);
    expect(e.facing).not.toBe(firstFacing);
    expect(e.facing).toBe(atan2Brad(target.gy - e.gy, target.gx - e.gx));
  });
});

describe('AIDecideSystem.tick — chase toward engage range (ENGINE_VERSION 37)', () => {
  it('closes distance when farther than engageRangeFp, along the exact direction to the target', () => {
    const s = createGameState({ ...CFG, players: [{ start: [900, 700] }] });
    const target = s.players[0]!;
    const e = addEnemy(s, 400, 400); // well outside the default ~180px engage range
    new AIDecideSystem().tick(s);
    expect(e.vx).toBeGreaterThan(0); // target is to the +x, +y side
    expect(e.vy).toBeGreaterThan(0);
    // Direction must match facing. Asserted as an ANGLE within ~1°, not as an exact
    // vy/vx ratio: vx/vy are truncated integer fp, so the shorter the velocity vector
    // the coarser the direction it can encode, and v42's slower default speed (4 -> 2.6
    // px/tick) made that quantization visible in the ratio's second decimal.
    const dx = target.gx - e.gx;
    const dy = target.gy - e.gy;
    expect(Math.abs(Math.atan2(e.vy, e.vx) - Math.atan2(dy, dx))).toBeLessThan(0.02);
  });

  it('does NOT fire while still out of engage range (ENGINE_VERSION 40 — no more room-wide alpha strike)', () => {
    const s = createGameState({ ...CFG, players: [{ start: [900, 700] }] });
    const e = addEnemy(s, 400, 400); // well outside the default ~180px engage range
    e.firing = true; // pre-set true to prove the gate actually flips it off
    new AIDecideSystem().tick(s);
    expect(e.firing).toBe(false);
  });

  it('moves at (approximately) the configured moveSpeedPerTick magnitude', () => {
    const s = createGameState({ ...CFG, players: [{ start: [900, 700] }] });
    const e = addEnemy(s, 400, 400);
    new AIDecideSystem().tick(s);
    const speedSq = e.vx * e.vx + e.vy * e.vy;
    // isqrt truncates twice (direction normalize, then this check) — allow 1fp slack.
    expect(Math.abs(isqrt(speedSq) - DEFAULT_ENEMY_MOVE_SPEED_PER_TICK)).toBeLessThanOrEqual(1);
  });

  it('stops (vx=vy=0) and fires once within engageRangeFp of the target (ENGINE_VERSION 40)', () => {
    const s = createGameState({ ...CFG, players: [{ start: [400, 400] }] });
    const e = addEnemy(s, 400, 400); // exactly on top of the target — well inside range
    new AIDecideSystem().tick(s);
    expect(e.vx).toBe(toFp(0));
    expect(e.vy).toBe(toFp(0));
    expect(e.firing).toBe(true);
  });

  it('fires exactly at the boundary (distance === engageRangeFp), and settles just inside it', () => {
    const s = createGameState({ ...CFG, players: [{ start: [400, 400] }] });
    const e = addEnemy(s, 400, 400);
    // Place the enemy exactly engageRangeFp away along +x — the boundary is inclusive.
    e.gx = (s.players[0]!.gx - DEFAULT_ENEMY_ENGAGE_RANGE_FP) as Fp;
    new AIDecideSystem().tick(s);
    expect(e.firing).toBe(true); // in range on the tick it reaches the boundary

    // It does not stop ON the line, though (ENGINE_VERSION 56): its standing spot is a
    // couple of walking steps inside its own range, so that settling within one step of
    // the spot still leaves it in range rather than balanced on the edge of it. Two ticks
    // of movement is all that costs, and it stops there rather than creeping inward.
    const mv = new MovementSystem();
    const ai = new AIDecideSystem();
    for (let i = 0; i < 30; i++) {
      ai.tick(s);
      mv.tick(s);
    }
    expect(e.vx).toBe(toFp(0));
    expect(e.vy).toBe(toFp(0));
    expect(e.firing).toBe(true);
    const away = s.players[0]!.gx - e.gx;
    expect(away).toBeLessThanOrEqual(DEFAULT_ENEMY_ENGAGE_RANGE_FP);
    expect(away).toBeGreaterThan(DEFAULT_ENEMY_ENGAGE_RANGE_FP - 4 * DEFAULT_ENEMY_MOVE_SPEED_PER_TICK);
  });

  it('does NOT fire one fp past the boundary (distance === engageRangeFp + 1)', () => {
    const s = createGameState({ ...CFG, players: [{ start: [400, 400] }] });
    const e = addEnemy(s, 400, 400);
    e.gx = (s.players[0]!.gx - DEFAULT_ENEMY_ENGAGE_RANGE_FP - toFp(1)) as Fp;
    e.firing = true; // pre-set true to prove the gate actually flips it off, not just leaves it
    new AIDecideSystem().tick(s);
    expect(e.vx).not.toBe(toFp(0)); // still closing the last 1fp
    expect(e.firing).toBe(false);
  });

  it('a per-enemy moveSpeedPerTick/engageRangeFp override wins over the shared default', () => {
    const s = createGameState({ ...CFG, players: [{ start: [900, 700] }] });
    const e = addEnemy(s, 400, 400);
    // 60x the default, and still well under the ~18000 fp it has left to walk: a step big
    // enough to cover the whole remaining distance would be an ARRIVAL (v56 stops a mob at
    // its destination rather than launching it past), which measures the stop rule instead
    // of the speed override this is about.
    e.moveSpeedPerTick = toFp(5);
    e.engageRangeFp = toFp(0); // never satisfied at this distance, so it should keep closing
    new AIDecideSystem().tick(s);
    const speed = isqrt(e.vx * e.vx + e.vy * e.vy);
    // Direction-normalize truncates twice at this magnitude — a loose relative
    // tolerance, not exact-arithmetic reimplementation.
    expect(speed).toBeGreaterThan(toFp(5) * 0.95);
    expect(speed).toBeLessThan(toFp(5) * 1.05);
    expect(e.firing).toBe(false); // 0fp range never satisfied at this distance
  });

  it('a per-enemy engageRangeFp override drives the FIRING gate too, not just the movement stop (ENGINE_VERSION 40)', () => {
    const s = createGameState({ ...CFG, players: [{ start: [900, 700] }] });
    const e = addEnemy(s, 400, 400); // ~583px away — well beyond the ~180px default range
    e.engageRangeFp = pxToFp(700); // a sniper-style override, wider than the default
    new AIDecideSystem().tick(s);
    expect(e.vx).toBe(toFp(0)); // already "in range" under the wider override — stopped
    expect(e.vy).toBe(toFp(0));
    expect(e.firing).toBe(true); // and firing, at a distance the DEFAULT range would reject
  });

  it('a hand-built enemy missing moveSpeedPerTick/engageRangeFp falls back to the shared defaults', () => {
    const s = createGameState({ ...CFG, players: [{ start: [900, 700] }] });
    const e = addEnemy(s, 400, 400);
    expect(e.moveSpeedPerTick).toBeUndefined();
    expect(e.engageRangeFp).toBeUndefined();
    new AIDecideSystem().tick(s);
    expect(isqrt(e.vx * e.vx + e.vy * e.vy)).toBeGreaterThan(0); // moved, using the fallback speed
    expect(e.firing).toBe(false); // ~583px away, well beyond the fallback ~180px default range
  });

  it('in dungeon mode, an unactivated room leaves vx/vy untouched (frozen, same gate as firing)', () => {
    const s = dungeonState();
    const e = addEnemy(s, 400, 400, 'nonexistent-room');
    e.vx = toFp(7);
    e.vy = toFp(9);
    new AIDecideSystem().tick(s);
    expect(e.vx).toBe(toFp(7));
    expect(e.vy).toBe(toFp(9));
  });
});

describe('AIDecideSystem.tick — perception radius (ENGINE_VERSION 42)', () => {
  const AGGRO_PX = 320; // DEFAULT_ENEMY_AGGRO_RANGE_FP, in px

  it('a mob farther away than its aggro range is fully inert — no move, no fire, no turn', () => {
    const s = createGameState({ ...CFG, players: [{ start: [400, 400] }] });
    const e = addUnawareEnemy(s, 400 + AGGRO_PX + 40, 400);
    e.facing = 12345 as Brad; // an arbitrary starting facing the system must NOT overwrite
    new AIDecideSystem().tick(s);
    expect(e.aggroed).toBe(false);
    expect(e.firing).toBe(false);
    expect(e.vx).toBe(toFp(0));
    expect(e.vy).toBe(toFp(0));
    expect(e.facing).toBe(12345);
  });

  it('a mob inside its aggro range latches `aggroed` and chases, even though it is still well outside engage range', () => {
    const s = createGameState({ ...CFG, players: [{ start: [400, 400] }] });
    const e = addUnawareEnemy(s, 400 + AGGRO_PX - 40, 400);
    new AIDecideSystem().tick(s);
    expect(e.aggroed).toBe(true);
    expect(e.vx).toBeLessThan(0); // closing westward, toward the player
    expect(e.firing).toBe(false); // aggro range is wider than engage range — still closing
  });

  it('the latch is one-way: a mob that noticed the player keeps chasing after they run back out of range', () => {
    const s = createGameState({ ...CFG, players: [{ start: [400, 400] }] });
    const e = addUnawareEnemy(s, 400 + AGGRO_PX - 40, 400);
    new AIDecideSystem().tick(s);
    expect(e.aggroed).toBe(true);

    s.players[0]!.gx = pxToFp(400 - AGGRO_PX * 3); // sprint far away
    new AIDecideSystem().tick(s);
    expect(e.aggroed).toBe(true);
    expect(e.vx).toBeLessThan(0); // still coming
  });

  it('a per-blueprint aggroRangeFp override wins over the shared default', () => {
    const s = createGameState({ ...CFG, players: [{ start: [400, 400] }] });
    const near = addUnawareEnemy(s, 400 + AGGRO_PX - 40, 400);
    near.aggroRangeFp = pxToFp(100); // a short-sighted mob: the same spot no longer wakes it
    const far = addUnawareEnemy(s, 400 + AGGRO_PX + 200, 400);
    far.aggroRangeFp = pxToFp(1000); // a long-sighted one: awake from much farther out
    new AIDecideSystem().tick(s);
    expect(near.aggroed).toBe(false);
    expect(far.aggroed).toBe(true);
  });

  it('the perception radius is INSIDE the room-activation gate, not a replacement for it', () => {
    const s = dungeonState();
    s.players[0]!.gx = pxToFp(400);
    s.players[0]!.gy = pxToFp(400);
    activateRoom(s, 'awake');
    const inAwakeRoom = addUnawareEnemy(s, 420, 400, 'awake'); // point-blank, room woken
    const inSleepingRoom = addUnawareEnemy(s, 420, 400, 'asleep'); // point-blank, room NOT woken
    new AIDecideSystem().tick(s);
    expect(inAwakeRoom.aggroed).toBe(true);
    expect(inSleepingRoom.aggroed).toBe(false);
  });
});

describe('AIDecideSystem.tick — dungeon room-activation gate (design/05, 2026-08-04)', () => {
  it('outside dungeon mode, an enemy with no roomId still decides normally', () => {
    const s = createGameState({ ...CFG, players: [{ start: [900, 700] }] });
    expect(s.dungeonEnabled).toBe(false);
    const e = addEnemy(s, 850, 650); // roomId undefined, within engage range
    new AIDecideSystem().tick(s);
    expect(e.firing).toBe(true);
  });

  it('in dungeon mode, an enemy with no roomId is inert (isActivated(undefined) → false)', () => {
    const s = dungeonState();
    const e = addEnemy(s, 400, 400); // roomId undefined
    e.firing = false;
    new AIDecideSystem().tick(s);
    expect(e.firing).toBe(false); // never touched — left exactly as spawned
  });

  it('in dungeon mode, a roomId with no matching dungeonRoomIndexById entry is inert', () => {
    const s = dungeonState();
    const e = addEnemy(s, 400, 400, 'nonexistent-room');
    e.firing = true; // pre-set true to prove the gate leaves it UNTOUCHED, not forced false
    new AIDecideSystem().tick(s);
    expect(e.firing).toBe(true);
  });

  it('in dungeon mode, a real room that has not activated yet is inert', () => {
    const s = dungeonState();
    s.dungeonRoomIndexById.set('r0', 0);
    s.dungeonRoomRuntime.push({ activated: false, roomTick: 0, schedule: [], cursor: 0, hasLiveEnemy: false });
    const e = addEnemy(s, 400, 400, 'r0');
    e.firing = true;
    const facingBefore = e.facing;
    new AIDecideSystem().tick(s);
    expect(e.firing).toBe(true); // untouched
    expect(e.facing).toBe(facingBefore); // untouched
  });

  it('in dungeon mode, an activated room decides normally', () => {
    const s = dungeonState();
    const target = s.players[0]!; // default seat, world centre (800,600px)
    activateRoom(s, 'r0');
    const e = addEnemy(s, 750, 550, 'r0'); // within engage range of the world-centre spawn
    new AIDecideSystem().tick(s);
    expect(e.facing).toBe(atan2Brad(target.gy - e.gy, target.gx - e.gx));
    expect(e.firing).toBe(true);
  });
});

/**
 * The room encounter budget (ENGINE_VERSION 41, balance/encounter.ts) — the fix for
 * the third and final round of the same live report ("一进游戏就被集火秒杀"), after
 * v37's chase and v40's fire-range gate each only moved the volley later. Both halves
 * are per-ROOM, so they are tested against a room's worth of mobs rather than one.
 */
describe('AIDecideSystem.tick — per-room fire budget + staggered notice (ENGINE_VERSION 41)', () => {
  /**
   * `n` mobs all inside engage range of the world-centre player, at strictly increasing
   * distances — nearest first, by construction — and 36 degrees apart around it.
   *
   * They used to be a straight line of mobs 10 px apart, which since ENGINE_VERSION 56 is a
   * line of mobs standing in each other's spots: they would spend these tests walking round
   * to their own, and a mob that is walking is not contending for a fire slot (v40's "stop
   * and shoot"). The budget is what is under test here, not the spread, so the crowd is
   * authored already spread — 36 degrees is comfortably past the ~33 degrees two mobs claim
   * at this radius, so nobody moves and every mob is a contender from tick one.
   */
  const CROWD_OFFSETS_PX: readonly (readonly [number, number])[] = [
    [100, 0],
    [87, 63],
    [35, 108],
    [-37, 115],
    [-104, 75],
    [-135, 0],
    [-115, -84],
    [-46, -142],
    [48, -148],
    [132, -96],
  ];
  function crowd(s: GameState, n: number, roomId = 'r0'): EnemyActor[] {
    const out: EnemyActor[] = [];
    for (let i = 0; i < n; i++) {
      const [dx, dy] = CROWD_OFFSETS_PX[i]!;
      out.push(addEnemy(s, 800 + dx, 600 + dy, roomId));
    }
    return out;
  }

  it('caps a room at ROOM_FIRE_BUDGET simultaneous shooters however many mobs are in range', () => {
    const s = dungeonState();
    activateRoom(s, 'r0');
    const mobs = crowd(s, 10);
    new AIDecideSystem().tick(s);
    expect(mobs.filter((e) => e.firing).length).toBe(ROOM_FIRE_BUDGET);
  });

  it('awards the slots to the NEAREST mobs — the threat comes from what is closest, not from array order', () => {
    const s = dungeonState();
    activateRoom(s, 'r0');
    const mobs = crowd(s, 8); // index 0 nearest, distance increasing with index
    new AIDecideSystem().tick(s);
    expect(mobs.map((e) => e.firing)).toEqual(mobs.map((_, i) => i < ROOM_FIRE_BUDGET));
  });

  it('budgets each room independently — a second room in combat is not starved by the first', () => {
    const s = dungeonState();
    activateRoom(s, 'r0');
    activateRoom(s, 'r1');
    const a = crowd(s, 5, 'r0');
    const b = crowd(s, 5, 'r1');
    new AIDecideSystem().tick(s);
    expect(a.filter((e) => e.firing).length).toBe(ROOM_FIRE_BUDGET);
    expect(b.filter((e) => e.firing).length).toBe(ROOM_FIRE_BUDGET);
  });

  it('frees a slot when a shooter dies — the queue advances instead of the room going quiet', () => {
    const s = dungeonState();
    activateRoom(s, 'r0');
    const mobs = crowd(s, 5);
    new AIDecideSystem().tick(s);
    for (const e of mobs.slice(0, ROOM_FIRE_BUDGET)) e.alive = false;
    new AIDecideSystem().tick(s);
    const firing = mobs.filter((e) => e.alive && e.firing);
    expect(firing.length).toBe(ROOM_FIRE_BUDGET);
    expect(firing[0]).toBe(mobs[ROOM_FIRE_BUDGET]); // the next-nearest survivor took over
  });

  it('holds fire until each mob’s own notice delay has elapsed, staggered by id', () => {
    const s = dungeonState();
    const rt = activateRoom(s, 'r0');
    // One mob only, so the budget can never be what is withholding fire.
    const e = addEnemy(s, 780, 600, 'r0');
    const delay = noticeDelayTicks(e.id);
    expect(delay).toBeGreaterThanOrEqual(NOTICE_DELAY_TICKS);

    rt.roomTick = delay - 1;
    new AIDecideSystem().tick(s);
    expect(e.firing).toBe(false);

    rt.roomTick = delay;
    new AIDecideSystem().tick(s);
    expect(e.firing).toBe(true);
  });

  it('a mob still holding fire during its notice window keeps CLOSING — the room wakes visibly, it just does not shoot', () => {
    const s = dungeonState();
    activateRoom(s, 'r0'); // roomTick 0 → nobody has noticed yet
    const e = addEnemy(s, 200, 600, 'r0'); // far out of engage range
    new AIDecideSystem().tick(s);
    expect(e.firing).toBe(false);
    expect(e.vx).toBeGreaterThan(0); // moving toward the world-centre player
  });

  it('a flat (non-dungeon) config still gets the budget, and its roomId-less mobs share one', () => {
    const s = createGameState(CFG); // no dungeon → dungeonEnabled false, no room runtime
    const mobs: EnemyActor[] = [];
    for (let i = 0; i < 6; i++) mobs.push(addEnemy(s, 800 - 20 - i * 10, 600));
    new AIDecideSystem().tick(s);
    expect(mobs.filter((e) => e.firing).length).toBe(ROOM_FIRE_BUDGET);
  });
});
