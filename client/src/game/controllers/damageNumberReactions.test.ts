import { describe, it, expect, vi } from 'vitest';
import { pxToFp, type GameEvent, type GameState } from '@dd/engine';
import { THEME, elementColor } from '../theme';
import { fpToPx } from '../coords';
import {
  reactToHitNumber, hitNumberTint, showsHitNumber, SELF_TINT, ENVIRONMENT_TINT, HEAD_LIFT_R,
  type DamageNumberHost,
} from './damageNumberReactions';

type Hit = Extract<GameEvent, { type: 'hit' }>;

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

  it('keeps the five colours distinct, or two kinds of hit would merge into one number', () => {
    const tints = [SELF_TINT, ENVIRONMENT_TINT, THEME.colors.shield, elementColor('fire'), elementColor('physical')];
    expect(new Set(tints).size).toBe(tints.length);
  });
});

describe('reactToHitNumber', () => {
  it('anchors the number above the target VIEW, lifted by its own body radius', () => {
    const spawn = vi.fn();
    reactToHitNumber(hit(), { spawn }, host({ 20: { x: 70, y: 90 } }), isLocal);
    expect(spawn).toHaveBeenCalledWith(20, 14, elementColor('fire'), 70, 90 - fpToPx(pxToFp(32)) * HEAD_LIFT_R);
  });

  it('falls back to the event position and a player-sized lift for a target already gone', () => {
    const spawn = vi.fn();
    reactToHitNumber(hit({ target: 99 }), { spawn }, host({}, null), isLocal);
    expect(spawn).toHaveBeenCalledWith(99, 14, elementColor('fire'), fpToPx(pxToFp(96)), fpToPx(pxToFp(160)) - 16 * HEAD_LIFT_R);
  });

  it('numbers the local seat in red, using the player radius', () => {
    const spawn = vi.fn();
    reactToHitNumber(hit({ target: 1, faction: 'enemy' }), { spawn }, host({ 1: { x: 0, y: 0 } }), isLocal);
    expect(spawn).toHaveBeenCalledWith(1, 14, SELF_TINT, 0, -fpToPx(pxToFp(16)) * HEAD_LIFT_R);
  });

  it('skips a teammate hit by an enemy, and numbers a rival hit by a player', () => {
    const spawn = vi.fn();
    reactToHitNumber(hit({ target: 2, faction: 'enemy' }), { spawn }, host(), isLocal);
    expect(spawn).not.toHaveBeenCalled();
    reactToHitNumber(hit({ target: 2, faction: 'player' }), { spawn }, host(), isLocal);
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});
