/**
 * Co-op downed / revive (design/05/07, ROADMAP 3.2). A lethal hit sends a player `downed`
 * (frozen, revivable) instead of dead; a teammate revives via a sustained-INTERACT channel,
 * and a run ends only when NO player is up. The engine builds one player today (multi-player
 * wiring is the Phase 3.1 net layer), so the co-op cases synthesise a second PlayerActor —
 * the systems all iterate state.players, so this exercises the real code paths.
 */
import { describe, it, expect } from 'vitest';
import { toFp } from '@dd/engine/math/fixed';
import { BRAD_FULL, type Brad } from '@dd/engine/math/trig';
import { pxToFp, toFpGrid } from '@dd/engine/content/convert';
import { freshStatus } from '@dd/engine/content/damage';
import { BASIC_ENEMY } from '@dd/engine/content/enemies';
import { PLAYER_BASE } from '@dd/engine/content/players';
import { BASE_MAX_ENERGY } from '@dd/engine/balance/energy';
import { makeWeapon, BLASTER_SIM } from '@dd/engine/content/weapons';
import { createGameState } from '@dd/engine/state/GameState';
import type { EngineConfig, GameState } from '@dd/engine/state/GameState';
import { ENEMY_TEAM_ID, type EnemyActor, type PlayerActor, type Projectile } from '@dd/engine/state/entities';
import {
  DOWNED_BLEEDOUT_TICKS, REVIVE_CHANNEL_TICKS, REVIVE_HP, REVIVE_RANGE_GRID,
} from '@dd/engine/config';
import {
  ApplyInputSystem, DeathDropsSystem, HitResolveSystem, ReviveSystem, WinConditionSystem,
  canRevive, findReviver, reviveTarget,
} from '@dd/engine/systems';
import { createGameEngine } from '@dd/engine/GameEngine';
import { makeCommand } from '@dd/engine/state/input';
import { Button } from '@dd/engine/state/commands';
import type { RoomPiece } from '@dd/engine/content/rooms';

const CFG = { seed: 7, worldW: 1600, worldH: 1200, waves: [] as const };
const state = (): GameState => createGameState(CFG);

/** Add a second player at a px position (the engine only spawns one today). */
function addPlayer(s: GameState, xpx: number, ypx: number): PlayerActor {
  const w = makeWeapon(BLASTER_SIM);
  const p: PlayerActor = {
    id: s.nextId(), faction: 'player', teamId: 0, // same team as player 0 — a co-op ally, not a rival
    gx: pxToFp(xpx), gy: pxToFp(ypx), z: toFp(0), vx: toFp(0), vy: toFp(0),
    knockVx: toFp(0), knockVy: toFp(0),
    facing: 0 as Brad, hp: 6, maxHp: 6, shield: 0, maxShield: 0, ticksSinceHit: 0,
    radius: PLAYER_BASE.radius, footprintRadius: PLAYER_BASE.footprintRadius, solidRadius: PLAYER_BASE.solidRadius,
    alive: true, weapon: w, weapons: [w], activeSlot: 0, buffs: [], energy: BASE_MAX_ENERGY, maxEnergy: BASE_MAX_ENERGY, coins: 0, shopBuyId: 0,
    firing: false, interacting: false, pickupTargetId: 0, cardVote: 0, portalReady: false, confirmExtract: false, confirmDescend: false,
    downed: false, bleedoutTicks: 0, reviveProgressTicks: 0,
    bandages: 0, prevButtons: 0, status: freshStatus(),
    floorMaterials: {}, bankedMaterials: {}, blueprintPickup: null, characterPickup: null,
  };
  s.players.push(p);
  return p;
}

function addEnemy(s: GameState, xpx: number, ypx: number): EnemyActor {
  const e: EnemyActor = {
    id: s.nextId(), faction: 'enemy', teamId: ENEMY_TEAM_ID,
    gx: pxToFp(xpx), gy: pxToFp(ypx), z: toFp(0), vx: toFp(0), vy: toFp(0),
    knockVx: toFp(0), knockVy: toFp(0),
    facing: 0 as Brad, hp: BASIC_ENEMY.maxHp, maxHp: BASIC_ENEMY.maxHp,
    shield: 0, maxShield: 0, ticksSinceHit: 0,
    radius: BASIC_ENEMY.radius, footprintRadius: BASIC_ENEMY.footprintRadius, solidRadius: BASIC_ENEMY.radius,
    alive: true, weapon: null, firing: false, status: freshStatus(), enraged: false, armorBroken: false, aggroed: false, holding: false,
  };
  s.enemies.push(e);
  return e;
}

describe('DeathDropsSystem — a lethal hit sends a player DOWNED, not dead', () => {
  it('hp ≤ 0 → downed (alive stays true), frozen, bleedout armed, one downed event', () => {
    const s = state();
    const p = s.players[0]!;
    p.hp = 0;
    p.vx = toFp(5); // was moving
    new DeathDropsSystem().tick(s);
    expect(p.downed).toBe(true);
    expect(p.alive).toBe(true); // NOT a permanent death yet
    expect(p.bleedoutTicks).toBe(DOWNED_BLEEDOUT_TICKS);
    expect(p.vx).toBe(toFp(0)); // frozen in place
    expect(s.events.filter((e) => e.type === 'downed')).toHaveLength(1);
    // Idempotent: a second tick while still downed doesn't re-arm or re-emit.
    s.events.length = 0;
    new DeathDropsSystem().tick(s);
    expect(s.events.filter((e) => e.type === 'downed')).toHaveLength(0);
  });
});

describe('WinConditionSystem — a run ends only when NO player is up', () => {
  it('single-player: the sole player going down ends the run (enemies win)', () => {
    const s = state();
    s.players[0]!.downed = true;
    s.players[0]!.alive = true; // downed, not dead
    new WinConditionSystem().tick(s);
    expect(s.winner).toBe('enemies');
    expect(s.phase).toBe('gameover');
  });

  it('co-op: one down, one up → the run continues', () => {
    const s = state();
    addPlayer(s, 500, 400);
    s.players[0]!.downed = true; // player A down
    new WinConditionSystem().tick(s); // player B still up
    expect(s.winner).toBe(null);
  });

  it('co-op: BOTH down at once → team wipe (enemies win)', () => {
    const s = state();
    addPlayer(s, 500, 400);
    s.players[0]!.downed = true;
    s.players[1]!.downed = true;
    new WinConditionSystem().tick(s);
    expect(s.winner).toBe('enemies');
  });
});

describe('ReviveSystem — the revive channel', () => {
  const downedWithReviverInRange = () => {
    const s = state();
    const a = s.players[0]!; // will be downed
    a.downed = true;
    a.bleedoutTicks = DOWNED_BLEEDOUT_TICKS;
    a.gx = pxToFp(400);
    a.gy = pxToFp(400);
    const b = addPlayer(s, 400, 400); // on top of A, well within revive range
    b.interacting = true;
    return { s, a, b };
  };

  it('a teammate holding INTERACT in range completes a revive after REVIVE_CHANNEL_TICKS', () => {
    const { s, a } = downedWithReviverInRange();
    const sys = new ReviveSystem();
    for (let t = 1; t < REVIVE_CHANNEL_TICKS; t++) {
      sys.tick(s);
      expect(a.downed).toBe(true); // not yet
    }
    sys.tick(s); // the completing tick
    expect(a.downed).toBe(false);
    expect(a.alive).toBe(true);
    expect(a.hp).toBe(REVIVE_HP);
    expect(s.events.some((e) => e.type === 'revived' && e.id === a.id)).toBe(true);
  });

  it('bleedout is PAUSED while a valid revive is in progress', () => {
    const { s, a } = downedWithReviverInRange();
    const sys = new ReviveSystem();
    for (let t = 0; t < 10; t++) sys.tick(s);
    expect(a.bleedoutTicks).toBe(DOWNED_BLEEDOUT_TICKS); // untouched — reviver present
    expect(a.reviveProgressTicks).toBe(10);
  });

  it('interruption (reviver stops / walks off) resets channel progress and resumes bleedout', () => {
    const { s, a, b } = downedWithReviverInRange();
    const sys = new ReviveSystem();
    for (let t = 0; t < 20; t++) sys.tick(s);
    expect(a.reviveProgressTicks).toBe(20);
    b.interacting = false; // let go of INTERACT
    sys.tick(s);
    expect(a.reviveProgressTicks).toBe(0); // channel reset
    expect(a.bleedoutTicks).toBe(DOWNED_BLEEDOUT_TICKS - 1); // bleedout resumed
  });

  it('an out-of-range teammate does not revive', () => {
    const { s, a, b } = downedWithReviverInRange();
    b.gx = pxToFp(400 + 32 * (REVIVE_RANGE_GRID + 3)); // several grid units away
    const sys = new ReviveSystem();
    for (let t = 0; t < 30; t++) sys.tick(s);
    expect(a.reviveProgressTicks).toBe(0);
    expect(a.bleedoutTicks).toBe(DOWNED_BLEEDOUT_TICKS - 30); // only bleedout ran
  });

  it('bleedout expiry with no reviver → permanent death', () => {
    const s = state();
    const a = s.players[0]!;
    a.downed = true;
    a.bleedoutTicks = 2; // about to expire
    const sys = new ReviveSystem();
    sys.tick(s);
    expect(a.alive).toBe(true);
    sys.tick(s); // bleedoutTicks → 0
    expect(a.downed).toBe(false);
    expect(a.alive).toBe(false); // dead for good
    expect(s.events.some((e) => e.type === 'death' && e.id === a.id)).toBe(true);
  });

  it('the permanent-death event carries the DRAWN body radius, like the enemy one', () => {
    // `DeathDropsSystem` is not the only producer of a `death` event — this is the other one,
    // and both feed the same `EventReactor` case. It matters that they agree on which of the
    // four radii (`state/actorRadius.ts`) `death.r` means: a player's `footprintRadius` is
    // deliberately smaller than the silhouette, so the wrong field here would size a burst
    // smaller than the body it came out of, and the render layer has no way to tell.
    //
    // It is asserted on the player `createGameState` actually builds, not on this file's
    // hand-made `addPlayer` fixture, so a `PLAYER_BASE` change moves the expectation with it.
    const s = state();
    const a = s.players[0]!;
    a.downed = true;
    a.bleedoutTicks = 1;
    new ReviveSystem().tick(s);
    const death = s.events.find((e) => e.type === 'death' && e.id === a.id);
    expect(death).toBeDefined();
    expect(death!.type === 'death' && death!.r).toBe(a.radius);
    // ...and `radius` is a distinct number from the feet circle, so the line above is a real
    // claim about WHICH radius rather than an accident of the two being equal today.
    expect(a.radius).not.toBe(a.footprintRadius);
  });
});

describe('ReviveSystem — PvP squad + bandage gating (design/05/15)', () => {
  /** A zoneEnabled (PvP) state needs a real arena — `createGameState` only sets
   * `zoneEnabled` when `EngineConfig.arena` is provided. */
  const MINI_ARENA = {
    id: 'mini', sizeGrid: { w: 10, h: 10 },
    rooms: [{ id: 'A', rectGrid: { x: 0, y: 0, w: 10, h: 10 }, solids: [] }],
    doors: [], spawns: [{ x: 5, y: 5 }], eyeCandidates: [{ roomId: 'A' }],
  };

  function pvpDownedWithReviverInRange(sameTeam: boolean, reviverBandages: number) {
    const s = createGameState({ ...CFG, arena: MINI_ARENA, players: [{ teamId: 0 }] });
    expect(s.zoneEnabled).toBe(true);
    const a = s.players[0]!;
    a.downed = true;
    a.bleedoutTicks = DOWNED_BLEEDOUT_TICKS;
    a.gx = pxToFp(400);
    a.gy = pxToFp(400);
    const b = addPlayer(s, 400, 400); // on top of A, well within revive range
    b.teamId = sameTeam ? 0 : 1;
    b.bandages = reviverBandages;
    b.interacting = true;
    return { s, a, b };
  }

  it('a same-squad reviver WITH a bandage completes the revive and spends exactly one bandage', () => {
    const { s, a, b } = pvpDownedWithReviverInRange(true, 1);
    const sys = new ReviveSystem();
    for (let t = 0; t < REVIVE_CHANNEL_TICKS; t++) sys.tick(s);
    expect(a.downed).toBe(false);
    expect(b.bandages).toBe(0); // spent
  });

  it('a same-squad reviver with NO bandage cannot even start the channel', () => {
    const { s, a, b } = pvpDownedWithReviverInRange(true, 0);
    const sys = new ReviveSystem();
    sys.tick(s);
    expect(a.reviveProgressTicks).toBe(0); // never advances
    expect(a.bleedoutTicks).toBe(DOWNED_BLEEDOUT_TICKS - 1); // bleedout runs as if no reviver at all
    expect(b.bandages).toBe(0); // nothing spent on a non-starting attempt
  });

  it('a RIVAL squad member never revives, even carrying a bandage', () => {
    const { s, a, b } = pvpDownedWithReviverInRange(false, 1);
    const sys = new ReviveSystem();
    for (let t = 0; t < 10; t++) sys.tick(s);
    expect(a.reviveProgressTicks).toBe(0);
    expect(a.bleedoutTicks).toBe(DOWNED_BLEEDOUT_TICKS - 10);
    expect(b.bandages).toBe(1); // the rival's bandage is untouched
  });

  it('an INTERRUPTED PvP revive does not spend the bandage', () => {
    const { s, a, b } = pvpDownedWithReviverInRange(true, 1);
    const sys = new ReviveSystem();
    for (let t = 0; t < REVIVE_CHANNEL_TICKS - 1; t++) sys.tick(s); // one short of completion
    expect(a.downed).toBe(true);
    b.interacting = false; // interrupt right before completion
    sys.tick(s);
    expect(a.reviveProgressTicks).toBe(0);
    expect(b.bandages).toBe(1); // untouched — only a COMPLETED revive spends it
  });

  it('PvE (no zoneEnabled) is completely unaffected by the bandage requirement, even at 0 bandages', () => {
    const s = state(); // plain PvE state — no arena, zoneEnabled false
    expect(s.zoneEnabled).toBe(false);
    const a = s.players[0]!;
    a.downed = true;
    a.bleedoutTicks = DOWNED_BLEEDOUT_TICKS;
    a.gx = pxToFp(400);
    a.gy = pxToFp(400);
    const b = addPlayer(s, 400, 400);
    b.interacting = true;
    expect(b.bandages).toBe(0); // default — PvE never grants any
    const sys = new ReviveSystem();
    for (let t = 0; t < REVIVE_CHANNEL_TICKS; t++) sys.tick(s);
    expect(a.downed).toBe(false); // still completes for free, exactly as before
  });
});

describe('downed players are invulnerable (design/07, 3.2)', () => {
  it('an enemy bullet passes through a downed player without dealing damage', () => {
    const s = state();
    const p = s.players[0]!;
    p.gx = pxToFp(400);
    p.gy = pxToFp(400);
    p.downed = true;
    p.hp = 0;
    const b: Projectile = {
      id: s.nextId(), faction: 'enemy', teamId: ENEMY_TEAM_ID, gx: pxToFp(400), gy: pxToFp(400), z: toFp(0),
      vx: toFp(0), vy: toFp(0), radius: toFpGrid(0.2), damage: 3, damageType: 'physical',
      lifeTicks: 10, alive: true,
    };
    s.projectiles.push(b);
    new HitResolveSystem().tick(s);
    expect(p.hp).toBe(0); // unchanged — no overkill, no re-death
    expect(b.alive).toBe(true); // bullet not consumed by a downed body
  });
});

describe('ReviveSystem — a dungeon force-regroup interrupts an in-progress revive (design/05, 2026-08-04)', () => {
  // Two rooms; room 2 has one enemy so stepping a player inside it activates combat
  // and DoorSystem force-regroups every OTHER online, non-downed player into it —
  // this test's actual subject is what that does to a channel running back in room 1.
  const ROOM1: RoomPiece = {
    id: 'fr_room1', tags: ['fr'], sizeGrid: { w: 20, h: 16 }, solids: [],
    spawns: { player: [{ x: 2, y: 8 }], enemy: [] },
    exits: [{ edge: 'east' }],
  };
  const ROOM2: RoomPiece = {
    id: 'fr_room2', role: 'boss', sizeGrid: { w: 20, h: 16 }, solids: [],
    spawns: { player: [{ x: 2, y: 8 }], enemy: [{ x: 16, y: 8, type: 'basic' }] },
    exits: [{ edge: 'west' }],
  };
  const CFG: EngineConfig = {
    seed: 21, worldW: 640, worldH: 640, waves: [],
    players: [{}, {}, {}], // A (downed), B (reviver), C (the one who walks into room 2)
    dungeon: {
      config: {
        biomeId: 'fr', nameKey: 'fr', floorCount: 1, roomsPerFloor: { min: 2, max: 2 },
        pieceTags: ['fr'], layout: 'linear', extractionPieceId: 'fr_room2', bossPieceId: 'fr_room2',
        difficultyCurve: { base: 1, perFloor: 0 },
      },
      library: [ROOM1, ROOM2],
    },
  };
  const interactCmd = (owner: number, tick: number) =>
    makeCommand({ owner, tick, moveBrad: 0 as Brad, moveMag: 0, buttons: Button.INTERACT });

  it("yanking the reviver away resets the channel via the SAME unmodified findReviver distance check — no bespoke interrupt code", () => {
    const eng = createGameEngine(CFG);
    const s = eng.state;
    eng.step([]); // tick 1: floor places (co-resident); room 1 not yet activated (1-tick lag)

    const [a, b, c] = s.players;
    a!.downed = true;
    a!.hp = 0;
    a!.bleedoutTicks = DOWNED_BLEEDOUT_TICKS;

    for (let t = 2; t <= 6; t++) eng.step([interactCmd(1, t)]); // B channels A's revive
    expect(a!.downed).toBe(true); // not complete yet (REVIVE_CHANNEL_TICKS is well above 5)
    expect(a!.reviveProgressTicks).toBe(5);
    expect(a!.bleedoutTicks).toBe(DOWNED_BLEEDOUT_TICKS); // paused — a valid reviver was present throughout

    // Directly place C inside room 2 (bypassing real movement — a targeted state poke,
    // same convention this file already uses for "force a downed/lethal state").
    const room2 = s.dungeonRooms.find((r) => r.piece.id === 'fr_room2')!;
    c!.gx = toFpGrid(room2.offsetXGrid + 16);
    c!.gy = toFpGrid(room2.offsetYGrid + 8);

    // Tick 7, one call: EnvironmentSystem sees C's new roomId → SpawnSystem activates
    // room 2 + spawns its enemy (roomId set directly) → DoorSystem's rising edge force-
    // regroups B (the only OTHER online, non-downed player — A is downed, C is already
    // there) → ReviveSystem, later this SAME tick, re-checks B's distance from A and
    // fails, exactly as an ordinary "reviver walked off" interruption would.
    eng.step([interactCmd(1, 7)]);

    expect(b!.roomId).toBe(room2.id); // B was pulled into the fight, not walked
    expect(c!.roomId).toBe(room2.id); // C (the trigger) stays exactly where it was
    expect(a!.reviveProgressTicks).toBe(0); // channel reset
    expect(a!.bleedoutTicks).toBe(DOWNED_BLEEDOUT_TICKS - 1); // bleedout resumed for one tick
    expect(a!.downed).toBe(true); // still down — just no longer being revived
  });
});

describe('Integration — single-player downed→wipe through the real engine step()', () => {
  it('a player reduced to 0 HP downs and the run ends the same/next tick with enemies winning', () => {
    const eng = createGameEngine({ seed: 2, worldW: 800, worldH: 600, playerStart: [400, 300], waves: [] });
    const p = eng.state.players[0]!;
    p.hp = 1;
    p.shield = 0; // drop the default skin's shield so a single chip hit is lethal
    // An enemy offset along +x fires back west through the (stationary) player.
    const e = addEnemy(eng.state, 470, 300);
    e.weapon = makeWeapon(BLASTER_SIM);
    for (let t = 1; t <= 200 && eng.state.phase !== 'gameover'; t++) {
      eng.step([makeCommand({ owner: 0, tick: t, moveBrad: 0 as Brad, moveMag: 0, buttons: 0 })]);
    }
    expect(eng.state.phase).toBe('gameover');
    expect(eng.state.winner).toBe('enemies');
    expect(eng.state.players[0]!.downed).toBe(true); // single-player: down = run over, never revived
  });
});

describe('A reviver cannot attack, and may move inside the reach (design/07, ENGINE_VERSION 86)', () => {
  const both = Button.FIRE | Button.INTERACT;
  const cmd = (owner: number, buttons: number, moveBrad = 0, moveMag = 0) =>
    makeCommand({ owner, tick: 1, moveBrad: moveBrad as Brad, moveMag, buttons });
  /** A downed at (400,400), B its squadmate standing `offsetPx` east of it. */
  const pair = (offsetPx = 0) => {
    const s = state();
    const a = s.players[0]!;
    a.gx = pxToFp(400);
    a.gy = pxToFp(400);
    a.downed = true;
    a.bleedoutTicks = DOWNED_BLEEDOUT_TICKS;
    const b = addPlayer(s, 400 + offsetPx, 400);
    return { s, a, b };
  };

  it('FIRE held with INTERACT over a revivable squadmate does not fire; the move still applies', () => {
    const { s, a, b } = pair();
    new ApplyInputSystem().tick(s, [cmd(1, both, 0, 255)]);
    expect(b.interacting).toBe(true);
    expect(b.firing).toBe(false);
    expect(b.vx).toBeGreaterThan(0); // walking is still allowed
    expect(reviveTarget(s, b)).toBe(a);
  });

  it('fires as usual when there is nothing it could revive', () => {
    const reach = REVIVE_RANGE_GRID * 32 + 32; // the range plus two 16 px body radii
    const cases: [string, (x: ReturnType<typeof pair>) => void, number][] = [
      ['FIRE without INTERACT', () => {}, Button.FIRE],
      ['out of reach', ({ b }) => (b.gx = pxToFp(400 + reach + 64)), both],
      ['the body is up', ({ a }) => (a.downed = false), both],
      ['the body is a rival', ({ b }) => (b.teamId = 1), both],
    ];
    for (const [label, poke, buttons] of cases) {
      const x = pair();
      poke(x);
      new ApplyInputSystem().tick(x.s, [cmd(1, buttons)]);
      expect(x.b.firing, label).toBe(true);
      expect(reviveTarget(x.s, x.b), label).toBeNull();
    }
  });

  it('in PvP a seat with no bandage cannot revive, so it may shoot', () => {
    const MINI = {
      id: 'mini', sizeGrid: { w: 40, h: 40 },
      rooms: [{ id: 'A', rectGrid: { x: 0, y: 0, w: 40, h: 40 }, solids: [] }],
      doors: [], spawns: [{ x: 12, y: 12 }], eyeCandidates: [{ roomId: 'A' }],
    };
    const s = createGameState({ ...CFG, arena: MINI, players: [{ teamId: 0 }] });
    const a = s.players[0]!;
    a.gx = pxToFp(400);
    a.gy = pxToFp(400);
    a.downed = true;
    const b = addPlayer(s, 400, 400);
    new ApplyInputSystem().tick(s, [cmd(1, both)]);
    expect(b.firing).toBe(true);
    b.bandages = 1;
    new ApplyInputSystem().tick(s, [cmd(1, both)]);
    expect(b.firing).toBe(false);
  });

  it('two seats on one body both hold their fire; the first one in seat order is the reviver', () => {
    const { s, a, b } = pair();
    const c = addPlayer(s, 400, 400);
    new ApplyInputSystem().tick(s, [cmd(1, both), cmd(2, both)]);
    expect([b.firing, c.firing]).toEqual([false, false]);
    expect([reviveTarget(s, b), reviveTarget(s, c)]).toEqual([a, a]);
    expect(findReviver(s, a)).toBe(b);
    expect(canRevive(s, a, a)).toBe(false); // never oneself
  });

  it('through step(): a reviver pacing inside the reach completes the channel and fires nothing until it is done', () => {
    const eng = createGameEngine({ seed: 3, worldW: 1600, worldH: 1200, waves: [], players: [{}, {}] });
    const s = eng.state;
    const [a, b] = s.players as [PlayerActor, PlayerActor];
    a.gx = pxToFp(800);
    a.gy = pxToFp(600);
    a.hp = 0;
    a.downed = true;
    a.bleedoutTicks = DOWNED_BLEEDOUT_TICKS;
    b.gx = pxToFp(800);
    b.gy = pxToFp(600);
    addEnemy(s, 60, 60); // unarmed and far off: only there so the run is not already won
    let shots = 0;
    let t = 0;
    while (a.downed && t < REVIVE_CHANNEL_TICKS + 5) {
      t++;
      // Pace east and west on alternate ten-tick legs: moving, never leaving the reach.
      const west = Math.floor(t / 10) % 2 === 1;
      const events = eng.step([makeCommand({ owner: 1, tick: t, moveBrad: (west ? BRAD_FULL / 2 : 0) as Brad, moveMag: 255, buttons: both })]);
      shots += events.filter((e) => e.type === 'bullet_fired' && e.ownerId === b.id).length;
    }
    expect(a.downed).toBe(false);
    expect(t).toBe(REVIVE_CHANNEL_TICKS); // not one tick of the channel lost to the pacing
    expect(shots).toBe(0);
    // Up again, the same held buttons shoot: the only thing holding the fire was the revive.
    for (let k = 1; k <= 30; k++) {
      const events = eng.step([makeCommand({ owner: 1, tick: t + k, moveBrad: 0 as Brad, moveMag: 0, buttons: both })]);
      shots += events.filter((e) => e.type === 'bullet_fired' && e.ownerId === b.id).length;
    }
    expect(shots).toBeGreaterThan(0);
  });
});
