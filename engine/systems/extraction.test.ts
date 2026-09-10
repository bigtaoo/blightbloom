/**
 * Extraction rooms + materials carry-out (design/05, ROADMAP 1.4/1.5). ExtractionSystem
 * is a no-op unless EngineConfig.floors is set (additive, no ENGINE_VERSION bump —
 * see config.ts's note); these tests cover both the floors-enabled behavior and the
 * floors-disabled regression (old configs must be byte-identical to before).
 *
 * The checkpoint gesture (design/10 legibility pass, ENGINE_VERSION 31) resolves from
 * explicit one-shot `Button.CONFIRM_EXTRACT`/`CONFIRM_DESCEND` presses (a render-side
 * portal + popup), not the original hold-to-extract/tap-to-descend INTERACT timer.
 */
import { describe, it, expect } from 'vitest';
import { createGameState } from '@dd/engine/state/GameState';
import type { GameState, EngineConfig } from '@dd/engine/state/GameState';
import { Prng } from '@dd/engine/math/prng';
import { addFp, toFp } from '@dd/engine/math/fixed';
import { rollDrop } from '@dd/engine/content/drops';
import { createGameEngine } from '@dd/engine/GameEngine';
import { Button } from '@dd/engine/state/commands';
import { makeCommand } from '@dd/engine/state/input';
import type { Brad } from '@dd/engine/math/trig';
import { ExtractionSystem, PickupSystem, WinConditionSystem } from '@dd/engine/systems';
import type { RoomPiece } from '@dd/engine/content/rooms';

// Two floors total: floor 0 (config.waves) is NOT last (extraFloors.length === 1);
// floor 1 (extraFloors[0]) IS last (floorIndex 1 >= extraFloors.length 1).
const FLOORS_CFG: EngineConfig = {
  seed: 1,
  worldW: 800,
  worldH: 600,
  playerStart: [400, 300],
  waves: [[[600, 300]]],
  floors: [[[[600, 300]]]],
};

function atCheckpoint(s: GameState): void {
  s.wavesExhausted = true;
  s.enemies.length = 0;
}

describe('ExtractionSystem — no-op unless floorsEnabled', () => {
  it('does nothing for a config without `floors` (regression: old auto-win path stays live)', () => {
    const s = createGameState({ seed: 1, worldW: 800, worldH: 600, waves: [] });
    atCheckpoint(s);
    new ExtractionSystem().tick(s);
    expect(s.phase).not.toBe('gameover');
    new WinConditionSystem().tick(s); // the pre-1.4 win path must still fire
    expect(s.phase).toBe('gameover');
    expect(s.winner).toBe(0);
  });
});

describe('ExtractionSystem — DESCEND (explicit confirmDescend press)', () => {
  it('banks the floor buffer, advances the floor, and reloads its waves', () => {
    const s = createGameState(FLOORS_CFG);
    s.floorMaterials.mat_fire = 3;
    atCheckpoint(s);
    const p = s.players[0]!;

    p.confirmDescend = true;
    // A descend is only honoured once the squad has picked a floor card
    // (ENGINE_VERSION 58). These tests drive the system directly, with no
    // ApplyInputSystem to copy a vote off a command, so the seat votes by hand.
    p.cardVote = 1;
    new ExtractionSystem().tick(s);

    expect(s.floorIndex).toBe(1);
    expect(s.waves).toEqual(FLOORS_CFG.floors![0]);
    expect(s.waveIndex).toBe(-1);
    expect(s.wavesExhausted).toBe(false);
    expect(s.bankedMaterials.mat_fire).toBe(3);
    expect(s.floorMaterials).toEqual({});
    expect(s.events.some((e) => e.type === 'descend' && e.floorIndex === 1)).toBe(true);
    expect(s.phase).not.toBe('gameover');
  });

  it('does not resolve while confirmDescend is unset', () => {
    const s = createGameState(FLOORS_CFG);
    atCheckpoint(s);
    new ExtractionSystem().tick(s); // no popup choice pressed at all
    expect(s.floorIndex).toBe(0);
    expect(s.phase).not.toBe('gameover');
  });

  it('clears leftover pickups on descend', () => {
    const s = createGameState(FLOORS_CFG);
    atCheckpoint(s);
    s.pickups.push({ id: s.nextId(), kind: 'heal', gx: s.worldW, gy: s.worldH, spawnTick: 0, alive: true });
    const p = s.players[0]!;
    p.confirmDescend = true;
    p.cardVote = 1; // see above — a descend needs a card pick (ENGINE_VERSION 58)
    new ExtractionSystem().tick(s);
    expect(s.pickups).toHaveLength(0);
  });

  it('keeps in-flight bullets — the enemy/projectile wipe is dungeon-only (ENGINE_VERSION 39)', () => {
    // A flat `floors` descend swaps the wave LIST and nothing else: the arena geometry
    // the bullet was fired into is still standing, so it is not stale the way a dungeon
    // floor's leftovers are. (`enemies` is necessarily already empty here — this mode's
    // checkpoint requires it — so only the projectile half is observable.)
    const s = createGameState(FLOORS_CFG);
    atCheckpoint(s);
    s.projectiles.push({
      id: s.nextId(), faction: 'player', teamId: 0,
      gx: toFp(1), gy: toFp(1), z: toFp(0), vx: toFp(0.5), vy: toFp(0),
      radius: toFp(0.15), damage: 1, damageType: 'physical', lifeTicks: 90, alive: true,
    });
    s.players[0]!.confirmDescend = true;
    new ExtractionSystem().tick(s);
    expect(s.projectiles).toHaveLength(1);
  });
});

describe('ExtractionSystem — EXTRACT (explicit confirmExtract press)', () => {
  it('banks the floor buffer and ends the run as a win, without advancing the floor', () => {
    const s = createGameState(FLOORS_CFG);
    s.floorIndex = 1; // the last floor — the only floor that can end a run (v61)
    s.floorMaterials.mat_ice = 2;
    atCheckpoint(s);
    const p = s.players[0]!;
    p.confirmExtract = true;
    new ExtractionSystem().tick(s);

    expect(s.phase).toBe('gameover');
    expect(s.winner).toBe(0);
    expect(s.floorIndex).toBe(1); // never descended
    expect(s.bankedMaterials.mat_ice).toBe(2);
    expect(s.events.some((e) => e.type === 'win' && e.winner === 0)).toBe(true);
  });

  it('confirmExtract wins out over a simultaneous confirmDescend on the last floor', () => {
    const s = createGameState(FLOORS_CFG);
    s.floorIndex = 1;
    atCheckpoint(s);
    const p = s.players[0]!;
    p.confirmExtract = true;
    p.confirmDescend = true;
    new ExtractionSystem().tick(s);
    expect(s.phase).toBe('gameover');
  });
});

/**
 * ENGINE_VERSION 61 — the mid-floor extraction option is gone (design/05 "Only the boss
 * floor ends a run"). This is the half no golden scenario can see: none of them presses
 * `CONFIRM_EXTRACT`, and `ember-dungeon-floor1` never reaches a checkpoint at all, so this
 * block IS the gate for the rule (recorded as such in ENGINE_VERSION_HISTORY's v61 entry).
 *
 * Both directions are asserted, because only the PAIR pins the rule: "an interior press is
 * ignored" alone would also pass if `confirmExtract` had been deleted outright, and "the last
 * floor still wins" alone would also pass if nothing had changed.
 */
describe('ExtractionSystem — an interior floor cannot end the run at all (v61)', () => {
  it('ignores confirmExtract on a non-last floor: no win, no descend, nothing banked', () => {
    const s = createGameState(FLOORS_CFG);
    s.floorMaterials.mat_ice = 2;
    atCheckpoint(s); // floorIndex 0, and extraFloors.length is 1 — not the last floor
    const p = s.players[0]!;
    p.confirmExtract = true;
    new ExtractionSystem().tick(s);

    expect(s.phase).not.toBe('gameover');
    expect(s.winner).toBe(null);
    expect(s.floorIndex).toBe(0); // an ignored EXTRACT is NOT quietly turned into a descend
    expect(s.bankedMaterials.mat_ice).toBeUndefined(); // the buffer is untouched
    expect(s.floorMaterials.mat_ice).toBe(2);
  });

  it('an interior confirmExtract does not consume the descend the same tick offers', () => {
    // The press is dropped, not reinterpreted — so a player who pressed both on one tick
    // (a stale latch, a double-bound key) still gets the descend they also asked for,
    // rather than a swallowed tick.
    const s = createGameState(FLOORS_CFG);
    atCheckpoint(s);
    const p = s.players[0]!;
    p.confirmExtract = true;
    p.confirmDescend = true;
    p.cardVote = 1;
    new ExtractionSystem().tick(s);
    expect(s.phase).not.toBe('gameover');
    expect(s.floorIndex).toBe(1); // descended, as CONFIRM_DESCEND asked
  });

  it('the LAST floor still ends the run on the same press — the rule is per-floor, not global', () => {
    const s = createGameState(FLOORS_CFG);
    s.floorIndex = 1;
    atCheckpoint(s);
    s.players[0]!.confirmExtract = true;
    new ExtractionSystem().tick(s);
    expect(s.phase).toBe('gameover');
    expect(s.winner).toBe(0);
  });
});

describe('ExtractionSystem — the last floor still needs an explicit CONFIRM_EXTRACT (2026-08-12, live bug report: instant auto-resolve left boss loot unpicked-up)', () => {
  it('reaching the checkpoint on the last floor does NOT end the run by itself', () => {
    const s = createGameState(FLOORS_CFG);
    s.floorIndex = 1; // the last floor (extraFloors.length === 1)
    atCheckpoint(s);
    new ExtractionSystem().tick(s); // no popup choice pressed at all
    expect(s.phase).not.toBe('gameover');
  });

  it('an explicit confirmExtract press on the last floor ends the run as a win', () => {
    const s = createGameState(FLOORS_CFG);
    s.floorIndex = 1;
    s.floorMaterials.mat_poison = 4;
    atCheckpoint(s);
    const p = s.players[0]!;
    p.confirmExtract = true;
    new ExtractionSystem().tick(s);
    expect(s.phase).toBe('gameover');
    expect(s.winner).toBe(0);
    expect(s.bankedMaterials.mat_poison).toBe(4);
  });

  it('a confirmDescend press on the last floor is ignored — no next floor to descend to', () => {
    const s = createGameState(FLOORS_CFG);
    s.floorIndex = 1;
    atCheckpoint(s);
    const p = s.players[0]!;
    p.confirmDescend = true;
    new ExtractionSystem().tick(s);
    expect(s.floorIndex).toBe(1); // unchanged
    expect(s.phase).not.toBe('gameover');
  });

  // The actual reported bug, end to end: a boss's own death drop sits away from where
  // it died (the player is rarely standing on top of the boss the instant it dies), so
  // it takes a real tick of walking to reach. Before this fix, the run had already ended
  // by then — this pins the window now existing: the checkpoint waits, the drop stays on
  // the floor untouched until the player is actually close enough, PickupSystem still
  // banks it into the floor buffer once they are, and it still carries into
  // bankedMaterials on the EXTRACT the player chooses afterward.
  it('a boss drop placed away from the player survives the checkpoint opening, and still banks once collected', () => {
    const s = createGameState(FLOORS_CFG);
    s.floorIndex = 1; // the last floor
    atCheckpoint(s);
    const p = s.players[0]!;
    const drop = {
      // spawnTick one tick in the past — PickupSystem skips a pickup on its own spawn
      // tick (design/08 ordering note, DeathDropsSystem's doc comment above), same as
      // a real boss drop would be by the time PickupSystem runs again below.
      id: s.nextId(), kind: 'material' as const, gx: addFp(p.gx, toFp(50)), gy: addFp(p.gy, toFp(50)),
      spawnTick: s.tick - 1, alive: true, materialId: 'mat_fire', qty: 3,
    };
    s.pickups.push(drop);

    // Checkpoint reached — the run must wait, not resolve out from under the drop.
    new ExtractionSystem().tick(s);
    expect(s.phase).not.toBe('gameover');

    // Still out of pickupRadius — PickupSystem must not vacuum it from a distance.
    new PickupSystem().tick(s);
    expect(s.pickups).toHaveLength(1);
    expect(s.floorMaterials.mat_fire).toBeUndefined();

    // The player walks over to it.
    p.gx = drop.gx;
    p.gy = drop.gy;
    new PickupSystem().tick(s);
    expect(s.pickups).toHaveLength(0);
    expect(s.floorMaterials.mat_fire).toBe(3);

    // Only now does the player choose to leave.
    p.confirmExtract = true;
    new ExtractionSystem().tick(s);
    expect(s.phase).toBe('gameover');
    expect(s.bankedMaterials.mat_fire).toBe(3);
  });
});

describe('Death forfeits only the current floor\'s un-banked buffer', () => {
  it('a run-ending death never merges floorMaterials into bankedMaterials', () => {
    const s = createGameState(FLOORS_CFG);
    s.floorMaterials.mat_fire = 5;
    s.players[0]!.alive = false; // simulate DeathDropsSystem having downed the player
    new WinConditionSystem().tick(s); // death check runs BEFORE the floorsEnabled guard
    expect(s.winner).toBe('enemies');
    expect(s.bankedMaterials.mat_fire).toBeUndefined();
    expect(s.floorMaterials.mat_fire).toBe(5); // still there — simply never banked
  });
});

describe('PickupSystem — materials accumulate into the floor buffer', () => {
  it('sums quantities across multiple pickups of the same material id', () => {
    const s = createGameState(FLOORS_CFG);
    s.tick = 5;
    const p = s.players[0]!;
    s.pickups.push(
      { id: s.nextId(), kind: 'material', gx: p.gx, gy: p.gy, spawnTick: 0, alive: true, materialId: 'mat_fire', qty: 1 },
    );
    new PickupSystem().tick(s);
    s.pickups.push(
      { id: s.nextId(), kind: 'material', gx: p.gx, gy: p.gy, spawnTick: 0, alive: true, materialId: 'mat_fire', qty: 1 },
    );
    new PickupSystem().tick(s);
    s.pickups.push(
      { id: s.nextId(), kind: 'material', gx: p.gx, gy: p.gy, spawnTick: 0, alive: true, materialId: 'mat_ice', qty: 1 },
    );
    new PickupSystem().tick(s);
    expect(s.floorMaterials.mat_fire).toBe(2);
    expect(s.floorMaterials.mat_ice).toBe(1);
  });
});

describe('Materials tier by depth (ROADMAP 1.5)', () => {
  it('rollDrop tags a material drop with the passed tier; default is 0 (old callers unaffected)', () => {
    const p = new Prng(3);
    for (let i = 0; i < 200; i++) {
      const d = rollDrop(p, 4);
      if (d.kind === 'material') expect(d.tier).toBe(4);
    }
    const p2 = new Prng(3);
    for (let i = 0; i < 200; i++) {
      const d = rollDrop(p2);
      if (d.kind === 'material') expect(d.tier).toBe(0);
    }
  });
});

describe('ExtractionSystem — dungeon mode checks the floor\'s capstone room, not wavesExhausted (design/05, 2026-08-04)', () => {
  // A single-room floor (roomsPerFloor min=max=1 → normalCount 0, so the floor is
  // JUST the capstone) — a dummy normal-tagged piece is still needed since
  // generateFloor validates the tag pool exists regardless of whether it's ever drawn.
  const DUMMY_NORMAL: RoomPiece = {
    id: 'solo_normal', tags: ['solo'], sizeGrid: { w: 10, h: 10 }, solids: [],
    spawns: { player: [{ x: 5, y: 5 }], enemy: [] }, exits: [],
  };
  const SOLO_CAPSTONE: RoomPiece = {
    id: 'solo_cap', role: 'boss', sizeGrid: { w: 20, h: 16 }, solids: [],
    spawns: { player: [{ x: 2, y: 8 }], enemy: [{ x: 16, y: 8, type: 'basic' }] }, exits: [],
  };
  const CFG: EngineConfig = {
    seed: 4, worldW: 640, worldH: 640, waves: [],
    dungeon: {
      config: {
        biomeId: 'solo', nameKey: 'solo', floorCount: 1, roomsPerFloor: { min: 1, max: 1 },
        pieceTags: ['solo'], layout: 'linear', extractionPieceId: 'solo_cap', bossPieceId: 'solo_cap',
        difficultyCurve: { base: 1, perFloor: 0 },
      },
      library: [DUMMY_NORMAL, SOLO_CAPSTONE],
    },
  };

  it('setting the OLD flat-floors wavesExhausted flag does nothing in dungeon mode', () => {
    const eng = createGameEngine(CFG);
    eng.step([]); // tick 1: floor places
    eng.state.wavesExhausted = true; // dungeon mode must never read this
    eng.step([]);
    expect(eng.state.phase).not.toBe('gameover');
  });

  it('never resolves before the capstone has even been reached (activated)', () => {
    const eng = createGameEngine(CFG);
    eng.step([]); // tick 1: floor places, player teleported in, but not yet activated
    expect(eng.state.dungeonRoomRuntime[0]!.activated).toBe(false);
    expect(eng.state.phase).not.toBe('gameover'); // no false-positive "cleared" before ever entering
  });

  it('reaching and clearing the capstone opens the checkpoint but does NOT auto-extract by itself', () => {
    const eng = createGameEngine(CFG);
    eng.step([]); // tick 1: floor places
    eng.step([]); // tick 2: player's roomId now matches → activates → its enemy spawns
    expect(eng.state.enemies.length).toBe(1);
    expect(eng.state.phase).not.toBe('gameover'); // enemy still alive — not cleared yet

    eng.state.enemies.length = 0; // simulate the boss dying (combat exercised elsewhere)
    eng.step([]); // tick 3: DoorSystem's hasLiveEnemy falls → capstone reads as cleared
    expect(eng.state.phase).not.toBe('gameover'); // still waits on an explicit CONFIRM_EXTRACT
  });

  it('a CONFIRM_EXTRACT press once the capstone is cleared ends the run as a win (last floor)', () => {
    const eng = createGameEngine(CFG);
    eng.step([]); // tick 1: floor places
    eng.step([]); // tick 2: activates → enemy spawns
    eng.state.enemies.length = 0; // simulate the boss dying
    eng.step([]); // tick 3: capstone reads as cleared
    eng.step([makeCommand({ owner: 0, tick: 4, moveBrad: 0 as Brad, moveMag: 0, buttons: Button.CONFIRM_EXTRACT })]);
    expect(eng.state.phase).toBe('gameover');
    expect(eng.state.winner).toBe(0);
  });
});

describe('Integration — full engine step() drives the extraction gesture via real input', () => {
  it('pressing CONFIRM_EXTRACT at the LAST floor\'s checkpoint through createGameEngine resolves EXTRACT', () => {
    const eng = createGameEngine(FLOORS_CFG);
    eng.state.floorIndex = 1; // the boss floor — the only one an EXTRACT press resolves on (v61)
    atCheckpoint(eng.state); // shortcut past clearing the actual wave
    eng.step([makeCommand({ owner: 0, tick: 1, moveBrad: 0 as Brad, moveMag: 0, buttons: Button.CONFIRM_EXTRACT })]);
    expect(eng.state.phase).toBe('gameover');
    expect(eng.state.winner).toBe(0);
  });

  it('the same press on an interior floor goes nowhere through the real input path too', () => {
    // Not a duplicate of the unit test above: this one goes through ApplyInputSystem's
    // button latch, so it also pins that the bit still ARRIVES and is dropped by
    // ExtractionSystem — rather than the rule accidentally living in the input layer.
    const eng = createGameEngine(FLOORS_CFG);
    atCheckpoint(eng.state); // floorIndex 0
    eng.step([makeCommand({ owner: 0, tick: 1, moveBrad: 0 as Brad, moveMag: 0, buttons: Button.CONFIRM_EXTRACT })]);
    expect(eng.state.players[0]!.confirmExtract).toBe(true); // the press was received
    expect(eng.state.phase).not.toBe('gameover'); // and ignored
    expect(eng.state.floorIndex).toBe(0);
  });

  it('pressing CONFIRM_DESCEND at a checkpoint resolves DESCEND', () => {
    const eng = createGameEngine(FLOORS_CFG);
    atCheckpoint(eng.state);
    eng.step([makeCommand({ owner: 0, tick: 1, moveBrad: 0 as Brad, moveMag: 0, buttons: Button.CONFIRM_DESCEND, cardVote: 1 })]);
    expect(eng.state.floorIndex).toBe(1);
    expect(eng.state.phase).not.toBe('gameover');
  });

  it('a single-tick press only resolves once — the next idle tick does nothing further', () => {
    const eng = createGameEngine(FLOORS_CFG);
    atCheckpoint(eng.state);
    eng.step([makeCommand({ owner: 0, tick: 1, moveBrad: 0 as Brad, moveMag: 0, buttons: Button.CONFIRM_DESCEND, cardVote: 1 })]);
    expect(eng.state.floorIndex).toBe(1);
    eng.step([]); // idle — no repeated descend
    expect(eng.state.floorIndex).toBe(1);
  });
});
