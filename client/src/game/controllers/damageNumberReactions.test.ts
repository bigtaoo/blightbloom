import { describe, it, expect, vi } from 'vitest';
import { pxToFp, type GameEvent, type GameState } from '@dd/engine';
import { THEME, elementColor } from '../theme';
import { fpToPx } from '../coords';
import {
  reactToHealNumber, reactToHitNumber, healNumberTint, hitNumberTint, showsHitNumber,
  CRIT_TINT, HEAL_TINT, SELF_TINT, ENVIRONMENT_TINT, HEAD_LIFT_R, type DamageNumberHost,
} from './damageNumberReactions';

type Hit = Extract<GameEvent, { type: 'hit' }>;
type Heal = Extract<GameEvent, { type: 'heal' }>;

const heal = (over: Partial<Heal> = {}): Heal => ({
  type: 'heal', target: 1, gx: pxToFp(40), gy: pxToFp(80), amount: 3, pool: 'hp', ...over,
});

const hit = (over: Partial<Hit> = {}): Hit => ({
  type: 'hit', target: 20, faction: 'player', gx: pxToFp(96), gy: pxToFp(160), damage: 14, damageType: 'fire', ...over,
});

/** A state with one player (id 1, the local seat), one rival player (id 2), one enemy (id 20). */
function state(): GameState {
  return {
    players: [{ id: 1, radius: pxToFp(16) }, { id: 2, radius: pxToFp(16) }],
    enemies: [{ id: 20, radius: pxToFp(32) }],
  } as unknown as GameState;
}

function host(views: Record<number, { x: number; y: number }> = {}, s: GameState | null = state()): DamageNumberHost {
  return { activeState: () => s, actorAt: (id) => views[id] };
}

const isLocal = (id: number) => id === 1;

describe('showsHitNumber', () => {
  it('numbers every hit on a non-player and every hit on this seat', () => {
    for (const f of ['player', 'enemy', 'environment'] as const) {
      expect(showsHitNumber(false, false, f)).toBe(true);
      expect(showsHitNumber(true, true, f)).toBe(true);
    }
  });

  it('numbers another player only when a player hit them (a PvP rival), not an enemy or the zone', () => {
    expect(showsHitNumber(true, false, 'player')).toBe(true);
    expect(showsHitNumber(true, false, 'enemy')).toBe(false);
    expect(showsHitNumber(true, false, 'environment')).toBe(false);
  });
});

describe('hitNumberTint', () => {
  it('uses the weapon element on an ordinary hit, physical in the locked neutral', () => {
    expect(hitNumberTint(hit({ damageType: 'ice' }), false)).toBe(elementColor('ice'));
    expect(hitNumberTint(hit({ damageType: 'physical' }), false)).toBe(0xe2e8f0);
  });

  it('is red on damage this seat took, whatever the element', () => {
    expect(hitNumberTint(hit({ faction: 'enemy', damageType: 'poison' }), true)).toBe(SELF_TINT);
  });

  it('is slate for the zone and hazard tiles', () => {
    expect(hitNumberTint(hit({ faction: 'environment', damageType: 'physical' }), false)).toBe(ENVIRONMENT_TINT);
  });

  it('is shield cyan when the shield swallowed the hit whole — on yourself too', () => {
    expect(hitNumberTint(hit({ shieldRemaining: 3 }), false)).toBe(THEME.colors.shield);
    expect(hitNumberTint(hit({ shieldRemaining: 3 }), true)).toBe(THEME.colors.shield);
    // A hit that emptied the shield reached health: not cyan.
    expect(hitNumberTint(hit({ shieldRemaining: 0 }), true)).toBe(SELF_TINT);
  });

  it('is crit gold over the element, but yields to "you" and to a swallowed hit', () => {
    expect(hitNumberTint(hit({ crit: true, damageType: 'fire' }), false)).toBe(CRIT_TINT);
    expect(hitNumberTint(hit({ crit: true, faction: 'environment' }), false)).toBe(CRIT_TINT);
    expect(hitNumberTint(hit({ crit: true, faction: 'player' }), true)).toBe(SELF_TINT);
    expect(hitNumberTint(hit({ crit: true, shieldRemaining: 2 }), false)).toBe(THEME.colors.shield);
  });

  it('keeps the hit colours distinct, or two kinds of hit would merge into one number', () => {
    const tints = [
      SELF_TINT, ENVIRONMENT_TINT, THEME.colors.shield, CRIT_TINT,
      ...(['physical', 'fire', 'ice', 'lightning', 'poison'] as const).map(elementColor),
    ];
    expect(new Set(tints).size).toBe(tints.length);
  });
});

describe('reactToHitNumber', () => {
  it('anchors the number above the target VIEW, lifted by its own body radius', () => {
    const spawn = vi.fn();
    reactToHitNumber(hit(), { spawn }, host({ 20: { x: 70, y: 90 } }), isLocal);
    expect(spawn).toHaveBeenCalledWith(20, 14, elementColor('fire'), 70, 90 - fpToPx(pxToFp(32)) * HEAD_LIFT_R, 'hit');
  });

  it('falls back to the event position and a player-sized lift for a target already gone', () => {
    const spawn = vi.fn();
    reactToHitNumber(hit({ target: 99 }), { spawn }, host({}, null), isLocal);
    expect(spawn).toHaveBeenCalledWith(99, 14, elementColor('fire'), fpToPx(pxToFp(96)), fpToPx(pxToFp(160)) - 16 * HEAD_LIFT_R, 'hit');
  });

  it('numbers the local seat in red, using the player radius', () => {
    const spawn = vi.fn();
    reactToHitNumber(hit({ target: 1, faction: 'enemy' }), { spawn }, host({ 1: { x: 0, y: 0 } }), isLocal);
    expect(spawn).toHaveBeenCalledWith(1, 14, SELF_TINT, 0, -fpToPx(pxToFp(16)) * HEAD_LIFT_R, 'hit');
  });

  it('passes the crit style for a crit, and the plain style otherwise', () => {
    const spawn = vi.fn();
    reactToHitNumber(hit({ crit: true }), { spawn }, host(), isLocal);
    reactToHitNumber(hit(), { spawn }, host(), isLocal);
    expect(spawn.mock.calls.map((c) => [c[2], c[5]])).toEqual([[CRIT_TINT, 'crit'], [elementColor('fire'), 'hit']]);
  });

  it('skips a teammate hit by an enemy, and numbers a rival hit by a player', () => {
    const spawn = vi.fn();
    reactToHitNumber(hit({ target: 2, faction: 'enemy' }), { spawn }, host(), isLocal);
    expect(spawn).not.toHaveBeenCalled();
    reactToHitNumber(hit({ target: 2, faction: 'player' }), { spawn }, host(), isLocal);
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});

describe('healNumberTint', () => {
  it('is heal green for health and shield cyan for a battery', () => {
    expect(healNumberTint('hp')).toBe(HEAL_TINT);
    expect(HEAL_TINT).toBe(THEME.colors.pickupHeal);
    expect(healNumberTint('shield')).toBe(THEME.colors.shield);
  });
});

describe('reactToHealNumber', () => {
  it('prints "+N" over the local seat, above its view, in the pool colour', () => {
    const spawn = vi.fn();
    reactToHealNumber(heal(), { spawn }, host({ 1: { x: 10, y: 50 } }), isLocal);
    reactToHealNumber(heal({ pool: 'shield', amount: 4 }), { spawn }, host({ 1: { x: 10, y: 50 } }), isLocal);
    const y = 50 - fpToPx(pxToFp(16)) * HEAD_LIFT_R;
    expect(spawn.mock.calls).toEqual([
      [1, 3, HEAL_TINT, 10, y, 'heal'],
      [1, 4, THEME.colors.shield, 10, y, 'heal'],
    ]);
  });

  it('falls back to the event position when the seat has no view yet', () => {
    const spawn = vi.fn();
    reactToHealNumber(heal(), { spawn }, host({}, null), isLocal);
    expect(spawn).toHaveBeenCalledWith(1, 3, HEAL_TINT, fpToPx(pxToFp(40)), fpToPx(pxToFp(80)) - 16 * HEAD_LIFT_R, 'heal');
  });

  it("leaves another player's heal unprinted: it is on the ally row already", () => {
    const spawn = vi.fn();
    reactToHealNumber(heal({ target: 2 }), { spawn }, host(), isLocal);
    expect(spawn).not.toHaveBeenCalled();
  });
});
