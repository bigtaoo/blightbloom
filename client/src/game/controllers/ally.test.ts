/**
 * AllyController — the local co-op bot (ROADMAP 3.1). It produces a normal PlayerCommand
 * for a non-local seat, so it's pure engine-facing logic (no Pixi) and testable headlessly.
 * Verifies it fights an enemy in reach (fire in range, held back: `ai/holdBack.ts`) and regroups on the leader when the
 * floor is quiet, and — the point of it — that a real two-seat engine SIMULATES the ally's
 * commands (the second player actually moves under bot control through step()). Facing is
 * engine-decided (design/10 v33), not part of the command — see ApplyInputSystem's own
 * auto-face coverage for that.
 */
import { describe, it, expect } from 'vitest';
import { createGameEngine } from '@dd/engine/GameEngine';
import { createGameState } from '@dd/engine/state/GameState';
import type { GameState } from '@dd/engine/state/GameState';
import { Button } from '@dd/engine/state/commands';
import { makeCommand } from '@dd/engine/state/input';
import { pxToFp } from '@dd/engine/content/convert';
import { freshStatus } from '@dd/engine/content/damage';
import { BASIC_ENEMY } from '@dd/engine/content/enemies';
import { toFp } from '@dd/engine/math/fixed';
import { BRAD_FULL, type Brad } from '@dd/engine/math/trig';
import { ENEMY_TEAM_ID, type EnemyActor } from '@dd/engine/state/entities';
import { CHEST_MECHANISM_RING_GRID, PORTAL_COUNTDOWN_TICKS, REVIVE_CHANNEL_TICKS } from '@dd/engine';
import { toFpGrid } from '@dd/engine/content/convert';
import { mechanismRing } from '@dd/engine/content/chests';
import type { Chest } from '@dd/engine/state/entities';
import { AllyController } from './AllyController';

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

const ally = new AllyController();
const CFG = { seed: 3, worldW: 1600, worldH: 1200, waves: [] as const };

describe('AllyController — command generation', () => {
  it('fires on the nearest enemy, advancing while outside the standoff', () => {
    const s = createGameState({ ...CFG, players: [{ start: [400, 400] }, { start: [420, 400] }] });
    addEnemy(s, 740, 400); // 10 grid east of the ally at 420: in fire range, past the 7.5-grid standoff
    const cmd = ally.build(s, 1, 0, 5);
    expect(cmd.buttons & Button.FIRE).toBeTruthy(); // firing
    expect(cmd.moveMag).toBeGreaterThan(0); // advancing to close the gap
    expect(Math.cos((cmd.moveBrad / BRAD_FULL) * 2 * Math.PI)).toBeGreaterThan(0.9); // east
  });

  it('backs off an enemy inside the standoff and keeps firing (ai/holdBack.ts)', () => {
    const s = createGameState({ ...CFG, players: [{ start: [400, 400] }, { start: [420, 400] }] });
    addEnemy(s, 500, 400); // 2.5 grid east: well inside the standoff
    const cmd = ally.build(s, 1, 0, 5);
    expect(cmd.buttons & Button.FIRE).toBeTruthy();
    expect(Math.cos((cmd.moveBrad / BRAD_FULL) * 2 * Math.PI)).toBeLessThan(-0.9); // west, away
    expect(cmd.moveMag).toBeGreaterThan(0);
  });

  it('control: with holdsBack off it holds position inside 4 grid, as it fought before', () => {
    const s = createGameState({ ...CFG, players: [{ start: [400, 400] }, { start: [420, 400] }] });
    addEnemy(s, 500, 400);
    const cmd = new AllyController({ holdsBack: false }).build(s, 1, 0, 5);
    expect(cmd.buttons & Button.FIRE).toBeTruthy();
    expect(cmd.moveMag).toBe(0); // holding
  });

  it('with its leader dead, an enemy in the leader’s room is no longer its fight', () => {
    // Two rooms sharing an edge, as `placeFloor` lays them: A to x10, B from x10 to x30 (grid).
    const twoRooms = (leaderAlive: boolean) => {
      const s = createGameState({ ...CFG, players: [{ start: [448, 160] }, { start: [256, 160] }] });
      s.dungeonRoomRects.push(
        { id: 'A', rect: { x: toFpGrid(0), y: toFpGrid(0), w: toFpGrid(10), h: toFpGrid(10) } } as never,
        { id: 'B', rect: { x: toFpGrid(10), y: toFpGrid(0), w: toFpGrid(20), h: toFpGrid(10) } } as never,
      );
      s.players[0]!.alive = leaderAlive;
      addEnemy(s, 544, 160); // in B, 9 grid east of the ally in A: in fire range
      return s;
    };
    const dead = ally.build(twoRooms(false), 1, 0, 5);
    expect(dead.buttons).toBe(0);
    expect(dead.moveMag).toBe(0);
    // Control: the leader standing in B makes the same enemy the ally's.
    expect(ally.build(twoRooms(true), 1, 0, 5).buttons & Button.FIRE).toBeTruthy();
  });

  it('a dead enemy is not a target', () => {
    const s = createGameState({ ...CFG, players: [{ start: [400, 400] }, { start: [420, 400] }] });
    addEnemy(s, 500, 400).alive = false;
    expect(ally.build(s, 1, 0, 5).buttons).toBe(0);
    // Control: alive, the same enemy draws fire.
    const live = createGameState({ ...CFG, players: [{ start: [400, 400] }, { start: [420, 400] }] });
    addEnemy(live, 500, 400);
    expect(ally.build(live, 1, 0, 5).buttons & Button.FIRE).toBeTruthy();
  });

  it('holds fire and regroups toward the leader when no enemies remain', () => {
    const s = createGameState({ ...CFG, players: [{ start: [400, 400] }, { start: [900, 400] }] });
    // Leader (seat 0) is far WEST of the ally (seat 1) — the ally should move west, not fire.
    const cmd = ally.build(s, 1, 0, 5);
    expect(cmd.buttons).toBe(0); // no target → no fire
    expect(cmd.moveMag).toBeGreaterThan(0); // heading west toward the leader
  });

  it('a downed ally issues an idle command (it cannot act)', () => {
    const s = createGameState({ ...CFG, players: [{ start: [400, 400] }, { start: [420, 400] }] });
    s.players[1]!.downed = true;
    const cmd = ally.build(s, 1, 0, 5);
    expect(cmd.moveMag).toBe(0);
    expect(cmd.buttons).toBe(0);
  });
});

describe('two-seat run: the bot ally actually drives the second player through step()', () => {
  it('the ally seat closes on an enemy under bot control (real engine simulation)', () => {
    // Local co-op shape: seat 0 (leader) idle, seat 1 (ally) bot-driven. A disarmed enemy
    // to the east both keeps the run alive (empty-waves auto-wins on tick 1) and gives the
    // ally something to engage — it should advance on the enemy and shrink the gap.
    const eng = createGameEngine({ ...CFG, waves: [[[1200, 400]]], players: [{ start: [400, 400] }, { start: [600, 400] }] });
    eng.step([makeCommand({ owner: 0, tick: 1, moveBrad: 0 as Brad, moveMag: 0, buttons: 0 })]);
    for (const e of eng.state.enemies) e.weapon = null; // disarm so the scenario is clean
    const enemy = eng.state.enemies[0]!;

    const gapTo = () => Math.abs(eng.state.players[1]!.gx - enemy.gx);
    const startGap = gapTo();
    for (let t = 2; t <= 40; t++) {
      const leaderCmd = makeCommand({ owner: 0, tick: t, moveBrad: 0 as Brad, moveMag: 0, buttons: 0 });
      eng.step([leaderCmd, ally.build(eng.state, 1, 0, t)]);
    }
    expect(gapTo()).toBeLessThan(startGap); // the bot drove the 2nd player toward the enemy
    expect(eng.state.players[0]!.gx).toBe(pxToFp(400)); // leader stayed put (only its own cmd moved it)
    expect(eng.state.winner).toBeNull(); // both up, enemy alive → run continues
  });
});

describe('AllyController — reviving the downed leader (volume 118)', () => {
  // Leader (seat 0) downed `gapPx` east of the ally (seat 1).
  function downedLeader(gapPx: number): GameState {
    const s = createGameState({ ...CFG, players: [{ start: [400 + gapPx, 400] }, { start: [400, 400] }] });
    Object.assign(s.players[0]!, { downed: true, hp: 0, bleedoutTicks: 900 });
    return s;
  }
  const interacts = (buttons: number) => (buttons & Button.INTERACT) !== 0;

  it('holds INTERACT beside the body, with no bandage (a co-op revive is free), and never fires', () => {
    const s = downedLeader(20);
    expect(s.players[1]!.bandages).toBe(0);
    const cmd = ally.build(s, 1, 0, 5);
    expect(interacts(cmd.buttons)).toBe(true);
    expect(cmd.buttons & Button.FIRE).toBe(0);
    expect(cmd.moveMag).toBe(0);
  });

  it('with `revives: false` (the co-op sim control) it never holds INTERACT over the body', () => {
    const cmd = new AllyController({ revives: false }).build(downedLeader(20), 1, 0, 5);
    expect(interacts(cmd.buttons)).toBe(false);
  });

  it('walks to a body out of reach without holding INTERACT', () => {
    const cmd = ally.build(downedLeader(200), 1, 0, 5);
    expect(cmd.moveMag).toBeGreaterThan(0);
    expect(interacts(cmd.buttons)).toBe(false);
  });

  it('fights an enemy with a clear shot before starting, and holds a channel already running', () => {
    const s = downedLeader(20);
    addEnemy(s, 600, 400);
    const open = ally.build(s, 1, 0, 5);
    expect(interacts(open.buttons)).toBe(false);
    expect(open.buttons & Button.FIRE).toBeTruthy();
    s.players[0]!.reviveProgressTicks = 50;
    const held = ally.build(s, 1, 0, 5);
    expect(interacts(held.buttons)).toBe(true);
    expect(held.buttons & Button.FIRE).toBe(0);
  });

  it('a leader up is no revive: the ally regroups as before', () => {
    const s = downedLeader(200);
    s.players[0]!.downed = false;
    expect(interacts(ally.build(s, 1, 0, 5).buttons)).toBe(false);
  });

  it('brings the leader back up through step()', () => {
    const eng = createGameEngine({ ...CFG, waves: [[[1500, 1100]]], players: [{ start: [440, 400] }, { start: [400, 400] }] });
    const idle = (t: number) => makeCommand({ owner: 0, tick: t, moveBrad: 0 as Brad, moveMag: 0, buttons: 0 });
    eng.step([idle(1)]);
    const enemy = eng.state.enemies[0]!;
    enemy.weapon = null;
    Object.assign(eng.state.players[0]!, { downed: true, hp: 0, bleedoutTicks: 900 });
    let revived = false;
    for (let t = 2; t < 2 + REVIVE_CHANNEL_TICKS + 30 && !revived; t++) {
      // The enemy is held far off, so the run lasts and nothing is in fire range.
      Object.assign(enemy, { gx: pxToFp(1500), gy: pxToFp(1100) });
      eng.step([idle(t), ally.build(eng.state, 1, 0, t)]);
      revived = eng.state.events.some((e) => e.type === 'revived' && e.id === eng.state.players[0]!.id);
    }
    expect(revived).toBe(true);
    expect(eng.state.players[0]!.downed).toBe(false);
    expect(eng.state.winner).toBeNull();
  });
});

describe('AllyController — a big chest’s second plate (2026-10-03)', () => {
  // A two-plate chest at grid (20, 10): plates due east (20 + ring, 10) and due west.
  const CX = 20;
  const R = CHEST_MECHANISM_RING_GRID;
  function chestState(leaderGx: number, allyGx: number): { s: GameState; chest: Chest } {
    const s = createGameState({ ...CFG, players: [{ start: [0, 0] }, { start: [0, 0] }] });
    Object.assign(s.players[0]!, { gx: toFpGrid(leaderGx), gy: toFpGrid(10) });
    Object.assign(s.players[1]!, { gx: toFpGrid(allyGx), gy: toFpGrid(10) });
    const chest: Chest = { id: 1, roomId: 'none', kind: 'big', gx: toFpGrid(CX), gy: toFpGrid(10), mechanisms: mechanismRing(toFpGrid(CX), toFpGrid(10), 2), opened: false };
    s.chests.push(chest);
    return { s, chest };
  }
  /** The command's heading as a unit vector (+y is south). */
  const heading = (cmd: { moveBrad: number }) => {
    const a = (cmd.moveBrad / BRAD_FULL) * 2 * Math.PI;
    return { x: Math.cos(a), y: Math.sin(a) };
  };

  it('holds the free plate once the leader stands on the other, where it would otherwise regroup', () => {
    // The plates are 2 * ring = 6 grid apart, past the 3-grid regroup distance.
    const { s, chest } = chestState(CX - R, CX + R);
    expect(ally.build(s, 1, 0, 5).moveMag).toBe(0);
    chest.opened = true; // control: the same spot, no chest to work
    expect(heading(ally.build(s, 1, 0, 5)).x).toBeLessThan(-0.9); // regroups west, on the leader
  });

  it('walks to the free plate, not to the leader', () => {
    // Ally 6 grid due south of the free (east) plate; the leader is on the west plate.
    const { s } = chestState(CX - R, CX + R);
    s.players[1]!.gy = toFpGrid(16);
    const h = heading(ally.build(s, 1, 0, 5));
    expect(h.y).toBeLessThan(-0.95); // due north, onto the plate
    expect(Math.abs(h.x)).toBeLessThan(0.2); // not toward the leader, north-west
  });

  it('leaves a plate alone while no squadmate stands on one', () => {
    // Leader at the chest's centre, on no plate; ally on the east plate, 3 grid off: within
    // the regroup distance, so it stands still either way — move it out to 5 grid.
    const { s } = chestState(CX, CX + R + 2);
    expect(heading(ally.build(s, 1, 0, 5)).x).toBeLessThan(-0.9); // regroups, past the plate
  });

  it('leaves the chest alone once every plate is held by someone else', () => {
    // Three seats, two plates: seats 0 and 2 hold both, so seat 1 has no plate to take.
    const s = createGameState({ ...CFG, players: [{ start: [0, 0] }, { start: [0, 0] }, { start: [0, 0] }] });
    Object.assign(s.players[0]!, { gx: toFpGrid(CX - R), gy: toFpGrid(10) });
    Object.assign(s.players[1]!, { gx: toFpGrid(CX - R - 4), gy: toFpGrid(14) });
    Object.assign(s.players[2]!, { gx: toFpGrid(CX + R), gy: toFpGrid(10) });
    s.chests.push({ id: 1, roomId: 'none', kind: 'big', gx: toFpGrid(CX), gy: toFpGrid(10), mechanisms: mechanismRing(toFpGrid(CX), toFpGrid(10), 2), opened: false });
    // Regrouping on seat 0, 4 grid north-east (0.71, -0.71); seat 2's plate is east-north-east.
    const h = heading(ally.build(s, 1, 0, 5));
    expect(h.y).toBeLessThan(-0.6);
    expect(h.x).toBeLessThan(0.8);
  });

  it('fights an enemy in range before the plate, but takes the plate over one far off', () => {
    const { s } = chestState(CX - R, CX + R);
    addEnemy(s, 1500, 1100).weapon = null; // 26+ grid off: not in range
    const onPlate = ally.build(s, 1, 0, 5);
    expect(onPlate.moveMag).toBe(0);
    expect(onPlate.buttons & Button.FIRE).toBe(0);
    addEnemy(s, (CX + R + 6) * 32, 10 * 32); // 6 grid east: in range
    expect(ally.build(s, 1, 0, 5).buttons & Button.FIRE).toBeTruthy();
  });

  it('opens the chest with the leader through step()', () => {
    const eng = createGameEngine({ ...CFG, waves: [[[1500, 1100]]], players: [{ start: [0, 0] }, { start: [0, 0] }] });
    const idle = (t: number) => makeCommand({ owner: 0, tick: t, moveBrad: 0 as Brad, moveMag: 0, buttons: 0 });
    eng.step([idle(1)]);
    const s = eng.state;
    s.enemies[0]!.weapon = null;
    Object.assign(s.players[0]!, { gx: toFpGrid(CX + R), gy: toFpGrid(10) });
    Object.assign(s.players[1]!, { gx: toFpGrid(CX - R - 6), gy: toFpGrid(14) });
    const chest: Chest = { id: 1, roomId: 'none', kind: 'big', gx: toFpGrid(CX), gy: toFpGrid(10), mechanisms: mechanismRing(toFpGrid(CX), toFpGrid(10), 2), opened: false };
    s.chests.push(chest);
    for (let t = 2; t < 200 && !chest.opened; t++) {
      Object.assign(s.enemies[0]!, { gx: pxToFp(1500), gy: pxToFp(1100) });
      eng.step([idle(t), ally.build(s, 1, 0, t)]);
    }
    expect(chest.opened).toBe(true);
  });
});

describe('AllyController — confirming the portal (ENGINE_VERSION 87)', () => {
  const confirms = (buttons: number) => (buttons & Button.CONFIRM_DESCEND) !== 0 && (buttons & Button.CONFIRM_EXTRACT) !== 0;

  it('confirms while a countdown runs and it has not, on top of what it is doing', () => {
    const s = createGameState({ ...CFG, players: [{ start: [400, 400] }, { start: [420, 400] }] });
    addEnemy(s, 620, 400);
    s.portalCountdownTicks = 100;
    const cmd = ally.build(s, 1, 0, 5);
    expect(confirms(cmd.buttons)).toBe(true);
    expect(cmd.buttons & Button.FIRE).toBeTruthy(); // still fighting
  });

  it('does not press with no countdown, once confirmed, or while downed', () => {
    const s = createGameState({ ...CFG, players: [{ start: [400, 400] }, { start: [420, 400] }] });
    expect(confirms(ally.build(s, 1, 0, 5).buttons)).toBe(false);
    s.portalCountdownTicks = 100;
    s.players[1]!.portalReady = true;
    expect(confirms(ally.build(s, 1, 0, 5).buttons)).toBe(false);
    s.players[1]!.portalReady = false;
    s.players[1]!.downed = true;
    expect(confirms(ally.build(s, 1, 0, 5).buttons)).toBe(false);
  });

  it('a leader’s descend goes on the next tick, not after the countdown, through step()', () => {
    const eng = createGameEngine({ seed: 9, worldW: 800, worldH: 600, waves: [], floors: [[]], players: [{ start: [100, 100] }, { start: [140, 100] }] });
    const lead = (t: number, buttons = 0, cardVote = 0) => makeCommand({ owner: 0, tick: t, moveBrad: 0 as Brad, moveMag: 0, buttons, cardVote });
    eng.step([lead(1, 0, 1), ally.build(eng.state, 1, 0, 1)]);
    eng.step([lead(2, Button.CONFIRM_DESCEND), ally.build(eng.state, 1, 0, 2)]);
    expect(eng.state.portalCountdownTicks).toBe(PORTAL_COUNTDOWN_TICKS - 1);
    eng.step([lead(3), ally.build(eng.state, 1, 0, 3)]);
    expect(eng.state.floorIndex).toBe(1);
  });
});
