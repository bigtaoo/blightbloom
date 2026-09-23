/**
 * hostileTargets / nearestHostile (design/15 — the PvP team/hostility model,
 * ROADMAP 4.2a). Mirrors teamHostility.test.ts's conventions but exercises the
 * shared pooling functions directly rather than only through HitResolveSystem/
 * DeflectSystem/ProjectileStepSystem consumers.
 */
import { describe, it, expect } from 'vitest';
import { toFp } from '@dd/engine/math/fixed';
import type { Brad } from '@dd/engine/math/trig';
import { pxToFp } from '@dd/engine/content/convert';
import { createGameState } from '@dd/engine/state/GameState';
import type { GameState } from '@dd/engine/state/GameState';
import { ENEMY_TEAM_ID, type EnemyActor } from '@dd/engine/state/entities';
import { freshStatus } from '@dd/engine/content/damage';
import { BASIC_ENEMY } from '@dd/engine/content/enemies';
import { hostileTargets, nearestHostile } from '@dd/engine/systems/targeting';

const CFG = { seed: 23, worldW: 1600, worldH: 1200, waves: [] as const };

function addEnemy(s: GameState, xpx: number, ypx: number): EnemyActor {
  const e: EnemyActor = {
    id: s.nextId(), faction: 'enemy', teamId: ENEMY_TEAM_ID,
    gx: pxToFp(xpx), gy: pxToFp(ypx), z: toFp(0), vx: toFp(0), vy: toFp(0),
    knockVx: toFp(0), knockVy: toFp(0),
    facing: 0 as Brad, hp: BASIC_ENEMY.maxHp, maxHp: BASIC_ENEMY.maxHp, shield: 0, maxShield: 0,
    ticksSinceHit: 0, radius: BASIC_ENEMY.radius, footprintRadius: BASIC_ENEMY.footprintRadius, solidRadius: BASIC_ENEMY.radius,
    alive: true, weapon: null, firing: false, status: freshStatus(), enraged: false, armorBroken: false, aggroed: false, holding: false,
  };
  s.enemies.push(e);
  return e;
}

describe('hostileTargets — team-id filtering', () => {
  it('includes a different-team player and every live enemy, excludes same-team players', () => {
    const s = createGameState({
      ...CFG,
      players: [
        { start: [400, 400], teamId: 0 },
        { start: [420, 400], teamId: 0 }, // ally — same team as self
        { start: [440, 400], teamId: 1 }, // rival — different team
      ],
    });
    const enemy = addEnemy(s, 900, 900);
    const self = s.players[0]!;
    const targets = hostileTargets(s, self);
    expect(targets).toContain(s.players[2]); // rival
    expect(targets).not.toContain(s.players[0]); // self is never its own target
    expect(targets).not.toContain(s.players[1]); // ally, same team
    expect(targets).toContain(enemy); // AI's ENEMY_TEAM_ID never equals a player's teamId
  });

  it('excludes dead actors on either side, re-checked fresh every call (never stale via the per-tick cache)', () => {
    const s = createGameState({ ...CFG, players: [{ teamId: 0 }, { teamId: 1 }] });
    const rival = s.players[1]!;
    const enemy = addEnemy(s, 900, 900);
    const self = s.players[0]!;
    expect(hostileTargets(s, self)).toContain(rival);
    expect(hostileTargets(s, self)).toContain(enemy);
    rival.alive = false;
    enemy.alive = false;
    // Same tick, same team partition — only alive/downed are re-evaluated per call.
    expect(hostileTargets(s, self)).not.toContain(rival);
    expect(hostileTargets(s, self)).not.toContain(enemy);
  });
});

describe('hostileTargets — downed exclusion differs PvE vs PvP (design/07/05/15)', () => {
  it('PvE (no arena): a downed hostile player is excluded — downed is untargetable', () => {
    const s = createGameState({ ...CFG, players: [{ teamId: 0 }, { teamId: 1 }] });
    expect(s.zoneEnabled).toBe(false);
    const rival = s.players[1]!;
    rival.downed = true;
    const self = s.players[0]!;
    expect(hostileTargets(s, self)).not.toContain(rival);
  });

  it('PvP (arena mode): a downed rival stays a valid target', () => {
    const arena = {
      id: 'mini', sizeGrid: { w: 10, h: 10 },
      rooms: [{ id: 'A', rectGrid: { x: 0, y: 0, w: 10, h: 10 }, solids: [] }],
      doors: [], spawns: [{ x: 5, y: 5 }], eyeCandidates: [{ roomId: 'A' }],
    };
    const s = createGameState({ ...CFG, arena, players: [{ teamId: 0 }, { teamId: 1 }] });
    expect(s.zoneEnabled).toBe(true);
    const rival = s.players[1]!;
    rival.downed = true;
    const self = s.players[0]!;
    expect(hostileTargets(s, self)).toContain(rival);
  });

  it('a downed SAME-team ally is excluded in both modes — it was never hostile to begin with', () => {
    const s = createGameState({ ...CFG, players: [{ teamId: 0 }, { teamId: 0 }] });
    const ally = s.players[1]!;
    ally.downed = true;
    const self = s.players[0]!;
    expect(hostileTargets(s, self)).not.toContain(ally);
  });
});

describe('nearestHostile', () => {
  it('returns null when there is no hostile target at all', () => {
    const s = createGameState({ ...CFG, players: [{ teamId: 0 }] });
    const self = s.players[0]!;
    expect(nearestHostile(s, self, self.gx, self.gy)).toBeNull();
  });

  it('picks the closer of two hostile candidates', () => {
    const s = createGameState({
      ...CFG,
      players: [{ teamId: 0, start: [800, 600] }, { teamId: 1, start: [850, 600] }], // rival, 50px away
    });
    const far = addEnemy(s, 1600, 1100); // much farther
    const near = s.players[1]!;
    const self = s.players[0]!;
    const target = nearestHostile(s, self, self.gx, self.gy);
    expect(target).toBe(near);
    expect(target).not.toBe(far);
  });

  it('breaks an exact-distance tie by array order — players are pooled before enemies', () => {
    // Offsets are exact multiples of WORLD.pxPerGrid (32px = 1 grid = FP_SCALE fp)
    // so pxToFp introduces no rounding asymmetry — the two candidates are an EXACT
    // squared-distance tie, not just visually symmetric px offsets.
    const s = createGameState({
      ...CFG,
      players: [
        { teamId: 0, start: [800, 600] },
        { teamId: 1, start: [832, 600] }, // rival, 32px east — hostile
      ],
    });
    const enemy = addEnemy(s, 768, 600); // 32px west — exact mirrored distance, also hostile
    const self = s.players[0]!;
    const target = nearestHostile(s, self, self.gx, self.gy);
    expect(target).toBe(s.players[1]); // the rival player wins the tie, not the enemy
    expect(target).not.toBe(enemy);
  });
});
