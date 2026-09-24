import { describe, it, expect } from 'vitest';
import { toFp, type Fp } from '@dd/engine/math/fixed';
import type { Brad } from '@dd/engine/math/trig';
import { createGameState, type GameState } from '@dd/engine/state/GameState';
import { ENEMY_TEAM_ID, type EnemyActor, type ShieldBreakSim } from '@dd/engine/state/entities';
import { freshStatus } from '@dd/engine/content/damage';
import { BASIC_ENEMY } from '@dd/engine/content/enemies';
import { takeDamage } from './combat';

const CFG = { seed: 1, worldW: 800, worldH: 800, playerStart: [400, 400] as const, waves: [] as const };

/** Drop an enemy on top of the player so it sits inside any break radius. */
function enemyOnPlayer(s: GameState, over: Partial<EnemyActor> = {}): EnemyActor {
  const p = s.players[0]!;
  const e: EnemyActor = {
    id: s.nextId(), faction: 'enemy', teamId: ENEMY_TEAM_ID,
    gx: p.gx, gy: p.gy, z: toFp(0), vx: toFp(0), vy: toFp(0),
    knockVx: toFp(0), knockVy: toFp(0),
    facing: 0 as Brad, hp: BASIC_ENEMY.maxHp, maxHp: BASIC_ENEMY.maxHp,
    shield: 0, maxShield: 0, ticksSinceHit: 0,
    radius: BASIC_ENEMY.radius, footprintRadius: BASIC_ENEMY.footprintRadius, solidRadius: BASIC_ENEMY.radius,
    alive: true, weapon: null, firing: false, status: freshStatus(), enraged: false, armorBroken: false, aggroed: false, holding: false,
    ...over,
  };
  s.enemies.push(e);
  return e;
}

describe('shield-break passive (design/02/07 — fired by takeDamage)', () => {
  it("an aoe passive bursts damage to nearby enemies when the player's shield breaks", () => {
    const s = createGameState(CFG); // default vanguard: aoe radius 2.5, damage 2
    const p = s.players[0]!;
    const near = enemyOnPlayer(s);
    const hp0 = near.hp;
    p.shield = 1;
    takeDamage(s, p, 1, 'enemy', 'physical'); // empties the shield → break → aoe
    expect(near.hp).toBe(hp0 - 2); // took the vanguard burst
    expect(s.events.some((e) => e.type === 'shield_break' && e.id === p.id)).toBe(true);
  });

  it('does not fire when the shield only drops (not depleted)', () => {
    const s = createGameState(CFG);
    const p = s.players[0]!;
    const near = enemyOnPlayer(s);
    const hp0 = near.hp;
    p.shield = 3;
    takeDamage(s, p, 1, 'enemy', 'physical'); // 3 → 2, still shielded
    expect(near.hp).toBe(hp0); // no burst
    expect(s.events.some((e) => e.type === 'shield_break')).toBe(false);
  });

  it('guards against recursive break: a break-passive hit never triggers another passive', () => {
    const s = createGameState(CFG);
    const p = s.players[0]!;
    // An enemy that itself has a shield + break passive, sitting in the player's aoe.
    const foePassive: ShieldBreakSim = { kind: 'aoe', radius: 9999 as Fp, damage: 5 };
    enemyOnPlayer(s, { shield: 1, maxShield: 1, shieldBreak: foePassive });
    const p2Hp0 = p.hp;
    p.shield = 1;
    takeDamage(s, p, 1, 'enemy', 'physical'); // player breaks → aoe hits `near` (dmg 2 > its 1 shield)
    // `near`'s shield is emptied by the player's burst, so a shield_break fires for it too…
    expect(s.events.filter((e) => e.type === 'shield_break').length).toBe(2);
    // …but its OWN passive must NOT retaliate (firePassive=false on the burst) — the
    // player took no damage back.
    expect(p.hp).toBe(p2Hp0);
  });

  it('a knock passive adds an outward velocity impulse instead of damage', () => {
    const s = createGameState(CFG);
    const p = s.players[0]!;
    p.shieldBreak = { kind: 'knock', radius: 3000 as Fp, impulse: 200 as Fp };
    // Enemy offset to the east so the outward impulse has a clear +x component.
    const near = enemyOnPlayer(s, { gx: (p.gx + 500) as Fp });
    const hp0 = near.hp;
    p.shield = 1;
    takeDamage(s, p, 1, 'enemy', 'physical');
    expect(near.hp).toBe(hp0); // knock deals no damage
    expect(near.knockVx).toBeGreaterThan(0); // shoved outward (+x)
    expect(near.vx).toBe(toFp(0)); // NOT written into vx (design/07 v25 — see the field's doc comment)
  });
});
