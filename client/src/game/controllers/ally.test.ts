/**
 * AllyController — the local co-op bot (ROADMAP 3.1). It produces a normal PlayerCommand
 * for a non-local seat, so it's pure engine-facing logic (no Pixi) and testable headlessly.
 * Verifies it engages the nearest enemy (fire in range) and regroups on the leader when the
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
import { type Brad } from '@dd/engine/math/trig';
import { ENEMY_TEAM_ID, type EnemyActor } from '@dd/engine/state/entities';
import { REVIVE_CHANNEL_TICKS } from '@dd/engine';
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
  it('fires on the nearest enemy, advancing while outside spacing', () => {
    const s = createGameState({ ...CFG, players: [{ start: [400, 400] }, { start: [420, 400] }] });
    addEnemy(s, 620, 400); // ~6 grid east of the ally at 420 — in fire range, outside keep-dist
    const cmd = ally.build(s, 1, 0, 5);
    expect(cmd.buttons & Button.FIRE).toBeTruthy(); // firing
    expect(cmd.moveMag).toBeGreaterThan(0); // advancing to close the gap (beyond keep-dist)
  });

  it('holds position (stops advancing) once inside spacing but keeps firing', () => {
    const s = createGameState({ ...CFG, players: [{ start: [400, 400] }, { start: [420, 400] }] });
    addEnemy(s, 500, 400); // ~2.5 grid east — inside keep-dist: fight in place, don't body-block
    const cmd = ally.build(s, 1, 0, 5);
    expect(cmd.buttons & Button.FIRE).toBeTruthy();
    expect(cmd.moveMag).toBe(0); // holding
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
