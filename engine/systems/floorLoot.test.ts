/**
 * Per-floor weapon allowance (design/05, ENGINE_VERSION 57) — the mechanism that turns
 * "a floor should hand out 2-3 weapons" into something the sim actually guarantees,
 * rather than something a drop weight approximates.
 *
 * Why this file exists at all: the weights in `content/drops.ts` changed in the same
 * pass, and the entire 1346-test engine suite stayed green through it. Nothing pinned
 * how much loot a floor produced, which is exactly how a floor came to be handing out
 * 0-5 weapons and 7-10 health potions without anything turning red.
 *
 * Enemies are pushed straight into `state.enemies` with the `roomId` under test and
 * killed by zeroing `hp` — the same targeted-state-poke convention `dungeonrun.test.ts`
 * uses, and here it is the point rather than a shortcut: the allowance is a property of
 * WHICH ROOM a kill happened in and HOW MANY the floor has already produced, so driving
 * real movement and combat would add hundreds of ticks of noise per assertion without
 * exercising one extra branch.
 */
import { describe, it, expect } from 'vitest';
import { createGameEngine } from '@dd/engine/GameEngine';
import type { EngineConfig, GameState } from '@dd/engine/state/GameState';
import { makeCommand } from '@dd/engine/state/input';
import type { Brad } from '@dd/engine/math/trig';
import { toFpGrid } from '@dd/engine/content/convert';
import { buildEnemyActor } from '@dd/engine/content/enemies';
import { CHEST_SMALL_WEAPONS, FLOOR_WEAPON_QUOTA_MIN, FLOOR_WEAPON_QUOTA_SPAN } from '@dd/engine/config';
import { Button } from '@dd/engine/state/commands';
import { mechanismRing } from '@dd/engine/content/chests';
import type { RoomPiece } from '@dd/engine/content/rooms';
import type { DungeonConfig } from '@dd/engine/world/dungeon';

/** Five enemy-free rooms, so a floor is [4 normal, capstone] and the QUOTA gate can be
 *  reached without the one-per-room gate hiding it — with fewer than three normal rooms
 *  a floor of 2-3 weapons is bounded by room count and the two gates stop being
 *  distinguishable. Rooms are authored empty; every test pushes its own enemies. */
function normalPiece(id: string): RoomPiece {
  return {
    id,
    tags: ['t'],
    sizeGrid: { w: 20, h: 16 },
    solids: [],
    spawns: { player: [{ x: 2, y: 8 }], enemy: [] },
    // Both edges: a four-room spine chains room to room, so every middle piece needs a
    // west exit to receive the previous room's east one. (Stage 0's west exit is unused.)
    exits: [{ edge: 'west' }, { edge: 'east' }],
  };
}

const TEST_LIB: RoomPiece[] = [
  normalPiece('t_a'),
  normalPiece('t_b'),
  normalPiece('t_c'),
  normalPiece('t_d'),
  {
    id: 't_extract',
    role: 'extraction',
    sizeGrid: { w: 12, h: 12 },
    solids: [],
    spawns: { player: [{ x: 6, y: 8 }], enemy: [] },
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

const TEST_DUN: DungeonConfig = {
  biomeId: 't',
  nameKey: 't',
  floorCount: 2,
  roomsPerFloor: { min: 5, max: 5 },
  pieceTags: ['t'],
  layout: 'linear',
  extractionPieceId: 't_extract',
  bossPieceId: 't_boss',
  difficultyCurve: { base: 1, perFloor: 1 },
};

const idle = (tick: number) => makeCommand({ owner: 0, tick, moveBrad: 0 as Brad, moveMag: 0, buttons: 0 });

/** `seats` > 1 builds a co-op party — ABSENT `players` is the single-seat path every test
 *  below this one uses, and stays byte-identical to what it was before chests needed a party. */
function dungeonEngine(seed: number, seats = 1) {
  const cfg: EngineConfig = {
    seed,
    worldW: 640,
    worldH: 640,
    waves: [],
    ...(seats > 1 ? { players: Array.from({ length: seats }, () => ({})) } : {}),
    dungeon: { config: TEST_DUN, library: TEST_LIB },
  };
  const eng = createGameEngine(cfg);
  eng.step([idle(1)]); // tick 1 places the floor (SpawnSystem) and rolls the allowance
  return eng;
}

/** Add one already-dead, disarmed enemy attributed to `roomId` and step once, so
 *  DeathDropsSystem processes exactly one kill against the allowance. */
function killOne(eng: ReturnType<typeof createGameEngine>, roomId: string): void {
  const s = eng.state;
  const room = s.dungeonRooms.find((r) => r.id === roomId)!;
  const e = buildEnemyActor(s, toFpGrid(room.offsetXGrid + 5), toFpGrid(room.offsetYGrid + 5));
  e.roomId = roomId;
  e.hp = 0; // dies on the next DeathDropsSystem pass
  e.weapon = null; // never shoots at the player while we are only measuring loot
  s.enemies.push(e);
  eng.step([idle(s.tick + 1)]);
}

function killIn(eng: ReturnType<typeof createGameEngine>, roomId: string, n: number): void {
  for (let i = 0; i < n; i++) killOne(eng, roomId);
}

/** Kill one already-dead enemy in the capstone room at a known position, and report it. */
function killCapstone(
  eng: ReturnType<typeof createGameEngine>,
  over: { onDeathSpawn?: { type: string; count: number } } = {},
): { gx: number; gy: number } {
  const s = eng.state;
  const capstone = s.dungeonRooms[s.dungeonRooms.length - 1]!;
  const gx = toFpGrid(capstone.offsetXGrid + 5);
  const gy = toFpGrid(capstone.offsetYGrid + 5);
  const boss = buildEnemyActor(s, gx, gy);
  boss.roomId = capstone.id;
  boss.hp = 0;
  boss.weapon = null;
  if (over.onDeathSpawn) boss.onDeathSpawn = over.onDeathSpawn;
  s.enemies.push(boss);
  eng.step([idle(s.tick + 1)]);
  return { gx, gy };
}

const weaponsOn = (s: GameState) => s.pickups.filter((p) => p.alive && p.kind === 'weapon');
const normalRooms = (s: GameState) => s.dungeonRooms.slice(0, -1).map((r) => r.id);

describe('per-floor weapon allowance — the COUNT', () => {
  it('rolls 2 or 3 for the floor, once, when the floor is placed', () => {
    const seen = new Set<number>();
    for (const seed of [1, 2, 3, 7, 11, 23, 99, 1234]) {
      const s = dungeonEngine(seed).state;
      expect(s.floorWeaponQuota).toBeGreaterThanOrEqual(FLOOR_WEAPON_QUOTA_MIN);
      expect(s.floorWeaponQuota).toBeLessThanOrEqual(FLOOR_WEAPON_QUOTA_MIN + FLOOR_WEAPON_QUOTA_SPAN - 1);
      expect(s.floorWeaponsDropped).toBe(0);
      seen.add(s.floorWeaponQuota);
    }
    // Both values must be reachable, or the range is decoration and a "2 or 3" claim
    // is really a hardcoded 2 that nothing would notice.
    expect([...seen].sort()).toEqual([2, 3]);
  });

  it('never exceeds the quota, however many enemies die on the floor', () => {
    for (const seed of [5, 41, 77]) {
      const eng = dungeonEngine(seed);
      const quota = eng.state.floorWeaponQuota;
      for (const roomId of normalRooms(eng.state)) killIn(eng, roomId, 75);
      const dropped = weaponsOn(eng.state).length;
      expect(dropped, `seed=${seed} quota=${quota}`).toBeLessThanOrEqual(quota);
      expect(eng.state.floorWeaponsDropped).toBe(dropped);
    }
  });

  it('really would have overshot — those same kills roll far more weapons than the quota allows', () => {
    // The anti-vacuity half of the test above: a floor that produced 2 weapons because
    // only 2 were ever rolled would pass it while proving nothing. The evidence that
    // the gate actually fired is the pile of OTHER drops those 300 kills produced.
    const eng = dungeonEngine(5);
    for (const roomId of normalRooms(eng.state)) killIn(eng, roomId, 75);
    expect(eng.state.pickups.length).toBeGreaterThan(100); // 300 kills really happened
    // 300 kills at the table's 5/84 rolls ~18 weapons; the floor allowed at most 3.
    expect(weaponsOn(eng.state).length).toBeLessThanOrEqual(3);
  });
});

describe('per-floor weapon allowance — the CONCENTRATION', () => {
  it('lets one room hand out at most one weapon', () => {
    for (const seed of [5, 41, 77, 302]) {
      const eng = dungeonEngine(seed);
      const rooms = normalRooms(eng.state);
      for (const roomId of rooms) killIn(eng, roomId, 60);
      for (const roomId of rooms) {
        const rect = eng.state.dungeonRoomRects.find((r) => r.id === roomId)!.rect;
        const inRoom = weaponsOn(eng.state).filter(
          (p) => p.gx >= rect.x && p.gx <= rect.x + rect.w && p.gy >= rect.y && p.gy <= rect.y + rect.h,
        );
        expect(inRoom.length, `seed=${seed} room=${roomId}`).toBeLessThanOrEqual(1);
      }
    }
  });

  it('marks exactly the rooms that produced a weapon', () => {
    const eng = dungeonEngine(5);
    const rooms = normalRooms(eng.state);
    for (const roomId of rooms) killIn(eng, roomId, 60);
    const marked = rooms.filter(
      (id) => eng.state.dungeonRoomRuntime[eng.state.dungeonRoomIndexById.get(id)!]!.weaponDropped,
    );
    expect(marked.length).toBe(weaponsOn(eng.state).length);
    expect(marked.length).toBeGreaterThan(0); // the flags are actually being set
  });
});

describe('per-floor weapon allowance — the GUARANTEE', () => {
  it('pays the shortfall on the capstone kill, on the body, filling the floor exactly', () => {
    const eng = dungeonEngine(5);
    const s = eng.state;
    const quota = s.floorWeaponQuota;
    expect(s.floorWeaponsDropped).toBe(0); // nothing has died yet, so the whole quota is owed

    const { gx, gy } = killCapstone(eng);

    expect(s.floorWeaponsDropped).toBe(quota);
    const weapons = weaponsOn(s);
    expect(weapons.length).toBe(quota);
    // The boss's own rolled drop may itself have been one of the weapons and is clamped
    // off its body like any other drop; the make-up drops are the remainder, and all of
    // them land on the body.
    expect(weapons.filter((p) => p.gx === gx && p.gy === gy).length).toBeGreaterThanOrEqual(quota - 1);
  });

  it('waits for a boss that splits — its adds are the room’s last enemies, not the boss', () => {
    const eng = dungeonEngine(5);
    const s = eng.state;
    killCapstone(eng, { onDeathSpawn: { type: 'basic', count: 3 } });

    expect(s.enemies.filter((e) => e.alive).length).toBe(3);
    expect(s.floorWeaponsDropped).toBeLessThan(s.floorWeaponQuota);

    for (const e of s.enemies) {
      e.hp = 0;
      e.weapon = null;
    }
    eng.step([idle(s.tick + 1)]);
    expect(s.floorWeaponsDropped).toBe(s.floorWeaponQuota);
  });

  it('pays nothing on a floor whose quota is already met', () => {
    const eng = dungeonEngine(5);
    const s = eng.state;
    s.floorWeaponsDropped = s.floorWeaponQuota; // pretend the floor already delivered
    const before = s.pickups.length;
    killCapstone(eng);
    // Exactly the boss's own single rolled drop, and it cannot be a weapon (quota spent).
    expect(s.pickups.length).toBe(before + 1);
    expect(weaponsOn(s).length).toBe(0);
  });

  it('pays nothing for a kill outside the capstone room, even on the last enemy alive', () => {
    // The make-up drop is a checkpoint reward, not a "last enemy anywhere" reward:
    // clearing a side room early must not hand over the floor's whole allowance.
    const eng = dungeonEngine(5);
    const s = eng.state;
    killOne(eng, normalRooms(s)[0]!);
    expect(s.enemies.filter((e) => e.alive).length).toBe(0);
    expect(s.floorWeaponsDropped).toBeLessThan(s.floorWeaponQuota);
  });

  it('re-rolls a fresh allowance for the next floor rather than carrying one over', () => {
    const eng = dungeonEngine(5);
    const s = eng.state;
    s.floorWeaponsDropped = 2;
    // Descend by hand: the checkpoint's own conditions are ExtractionSystem's business
    // (extraction.test.ts). What matters here is that PLACING floor 1 re-allocates.
    s.floorIndex = 1;
    s.dungeonRooms.length = 0;
    s.dungeonDoors.length = 0;
    s.dungeonRoomRuntime.length = 0;
    s.dungeonRoomRects.length = 0;
    s.dungeonRoomIndexById.clear();
    s.dungeonBaseWalls.length = 0;
    eng.step([idle(s.tick + 1)]);
    expect(s.floorWeaponsDropped).toBe(0);
    expect(s.floorWeaponQuota).toBeGreaterThanOrEqual(FLOOR_WEAPON_QUOTA_MIN);
    for (const rt of s.dungeonRoomRuntime) expect(rt.weaponDropped).toBe(false);
  });
});

describe('per-floor weapon allowance — a capstone with nothing to kill in it', () => {
  /** Walk player 0 into the capstone room so it activates and the checkpoint opens. */
  function enterCapstone(eng: ReturnType<typeof createGameEngine>): void {
    const s = eng.state;
    const capstone = s.dungeonRooms[s.dungeonRooms.length - 1]!;
    const sp = capstone.piece.spawns.player[0]!;
    s.players[0]!.gx = toFpGrid(sp.x + capstone.offsetXGrid);
    s.players[0]!.gy = toFpGrid(sp.y + capstone.offsetYGrid);
    eng.step([idle(s.tick + 1)]);
    eng.step([idle(s.tick + 1)]);
  }

  it('pays the whole shortfall at the checkpoint when no boss ever dies', () => {
    // Not a corner case: FOUR of the shipped level's five floors end in
    // `ember_l1_extraction`, which has zero enemy spawns. Before this path existed the
    // 2-3 guarantee applied to one floor in five, and the measured sweep showed it —
    // completed floors reading 1 weapon against a quota of 2 or 3.
    const eng = dungeonEngine(5); // TEST_LIB's capstone (t_extract) has no enemies either
    const s = eng.state;
    const quota = s.floorWeaponQuota;
    expect(s.floorWeaponsDropped).toBe(0);

    enterCapstone(eng);

    expect(s.floorWeaponsDropped).toBe(quota);
    const weapons = weaponsOn(s);
    expect(weapons.length).toBe(quota);
    // All of them at one spot — the capstone room's own centre, clamped to walkable.
    expect(new Set(weapons.map((p) => `${p.gx},${p.gy}`)).size).toBe(1);
  });

  it('pays only the REMAINDER when the floor already produced some of its allowance', () => {
    const eng = dungeonEngine(5);
    const s = eng.state;
    const quota = s.floorWeaponQuota;
    // Clear ONE normal room, so the one-per-room cap holds the floor's own production
    // to at most 1 and a remainder is guaranteed to exist against a quota of 2 or 3.
    killIn(eng, normalRooms(s)[0]!, 60);
    const earned = weaponsOn(s).length;
    expect(earned).toBe(1); // the floor really did drop one by itself...
    expect(earned).toBeLessThan(quota); // ...and still owes the rest

    enterCapstone(eng);
    expect(weaponsOn(s).length).toBe(quota);
  });

  it('pays once, not once per tick the portal stays open', () => {
    const eng = dungeonEngine(5);
    const s = eng.state;
    enterCapstone(eng);
    const afterFirst = weaponsOn(s).length;
    for (let i = 0; i < 30; i++) eng.step([idle(s.tick + 1)]);
    expect(weaponsOn(s).length).toBe(afterFirst);
    expect(s.floorWeaponsDropped).toBe(s.floorWeaponQuota);
  });
});

describe('per-floor weapon allowance — scope', () => {
  it('leaves a config with no dungeon on the plain table, allowance never engaged', () => {
    // A flat `waves` run has no floor to allocate against and no rooms to spread over,
    // so it keeps the pre-v57 behaviour outright — which is also what keeps every
    // non-dungeon golden scenario's weapon odds untouched by this pass.
    const eng = createGameEngine({ seed: 5, worldW: 1200, worldH: 900, waves: [[[1100, 800]]] });
    eng.step([idle(1)]);
    expect(eng.state.floorWeaponQuota).toBe(-1);

    const s = eng.state;
    for (let i = 0; i < 400; i++) {
      const e = buildEnemyActor(s, toFpGrid(10), toFpGrid(10));
      e.hp = 0;
      e.weapon = null;
      s.enemies.push(e);
      eng.step([idle(s.tick + 1)]);
    }
    // This is also the COUNTERFACTUAL for the quota tests above: the same drop table,
    // the same kill count, no allowance. Measured at 25 weapons for this seed (5/84 of
    // 400 predicts ~24) — a floor's worth of kills would hand out 4-5 weapons unchecked.
    // The bound is loose rather than exact so an unrelated upstream PRNG shift doesn't
    // fail it, but it is high enough that a broken weapon branch cannot slip under it.
    expect(weaponsOn(s).length).toBeGreaterThan(15);
    expect(s.floorWeaponsDropped).toBe(0);
  });
});

/**
 * Chests spend the same allowance (design/05, ENGINE_VERSION 63). `ChestSystem` adds its
 * payout to `floorWeaponsDropped`, which is this module's own input — so the two features meet
 * here and nowhere else, and until now neither side's suite knew the other existed.
 *
 * The two directions are different claims, and both are load-bearing:
 *
 *   - a chest opened DURING a floor leaves the capstone correspondingly less to hand over, so
 *     chests move WHERE a floor's weapons come from without inflating the economy design/05
 *     tuned;
 *   - the quota is a FLOOR, not a ceiling. A big chest pays one per SEAT and a full party can
 *     take the floor past its quota outright. `payFloorWeaponShortfall` treats a negative
 *     shortfall as "nothing owed", which is why that case needs no special case anywhere —
 *     and an assertion here rather than only a sentence in a doc comment.
 */
describe('per-floor weapon allowance — and the chests that spend it', () => {
  /** Drop a chest onto player 0's feet, in the room they are standing in. */
  function chestUnderfoot(eng: ReturnType<typeof createGameEngine>, kind: 'small' | 'big') {
    const s = eng.state;
    const p = s.players[0]!;
    const room = s.dungeonRooms[0]!;
    const chest = {
      id: s.nextChestId(),
      roomId: room.id,
      kind,
      gx: p.gx,
      gy: p.gy,
      mechanisms: kind === 'big' ? mechanismRing(p.gx, p.gy, s.players.length) : [],
      opened: false,
    };
    // Every plate under a player's feet, so a big chest opens by construction — the plate
    // geometry is `chests.test.ts`'s subject, not this file's.
    for (const m of chest.mechanisms) {
      m.gx = p.gx;
      m.gy = p.gy;
    }
    s.chests.push(chest);
    return chest;
  }

  /**
   * One tick with INTERACT held by every seat, preceded by an idle one.
   *
   * The idle tick is not padding. A room activates in `SpawnSystem` (step 11), which runs
   * AFTER `ChestSystem` (step 10.5), so on the tick a room first activates its chests are
   * still refused by `roomActive` — the chest becomes workable on the tick after. Holding the
   * button through both is what a player does anyway.
   */
  const interactTick = (eng: ReturnType<typeof createGameEngine>) => {
    for (let i = 0; i < 2; i++) {
      eng.step(
        eng.state.players.map((_, owner) =>
          makeCommand({ owner, tick: eng.state.tick + 1, moveBrad: 0 as Brad, moveMag: 0, buttons: Button.INTERACT }),
        ),
      );
    }
  };

  it('leaves the capstone less to hand over — a chest re-routes the floor’s weapons, it does not add to them', () => {
    const eng = dungeonEngine(5);
    const s = eng.state;
    const quota = s.floorWeaponQuota;

    const chest = chestUnderfoot(eng, 'small');
    interactTick(eng);
    expect(chest.opened).toBe(true); // the premise: the chest really did pay
    expect(s.floorWeaponsDropped).toBe(CHEST_SMALL_WEAPONS);

    killCapstone(eng);
    // The floor still ends on exactly its quota — the chest paid part of it, the capstone
    // paid the rest. A chest that forgot to count itself would end the floor one weapon over.
    expect(s.floorWeaponsDropped).toBe(quota);
    expect(weaponsOn(s).length).toBe(quota);
  });

  it('lets a big chest in a full party take the floor PAST its quota, and asks the capstone for nothing', () => {
    const eng = dungeonEngine(5, 4);
    const s = eng.state;
    const quota = s.floorWeaponQuota;
    expect(quota).toBeLessThan(4); // the premise: four seats really can outpay it

    const chest = chestUnderfoot(eng, 'big');
    interactTick(eng);
    expect(chest.opened).toBe(true);
    expect(s.floorWeaponsDropped).toBe(4); // one per seat, whatever the floor owed

    const before = s.pickups.length;
    killCapstone(eng);
    // A negative shortfall is "nothing owed", not a debt to claw back: the capstone hands
    // over nothing but the boss's own rolled drop, and the floor is allowed to end rich.
    expect(s.pickups.length).toBe(before + 1);
    expect(s.floorWeaponsDropped).toBe(4);
    expect(s.floorWeaponsDropped).toBeGreaterThan(quota);
  });

  it('still pays the whole quota on a floor whose chest was never opened', () => {
    // The control. Without it, "chests break the guarantee" would pass the first test above
    // just as well as "chests feed it".
    const eng = dungeonEngine(5);
    const s = eng.state;
    chestUnderfoot(eng, 'small');
    for (let i = 0; i < 2; i++) eng.step([idle(s.tick + 1)]); // no button — the chest stays shut
    expect(s.floorWeaponsDropped).toBe(0);
    killCapstone(eng);
    expect(s.floorWeaponsDropped).toBe(s.floorWeaponQuota);
  });
});
