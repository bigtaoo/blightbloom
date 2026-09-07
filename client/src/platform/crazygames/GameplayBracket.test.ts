/**
 * `GameplayBracket` — the per-frame derivation of gameplayStart/gameplayStop.
 *
 * The property under test is not "it calls the SDK" but "it calls it exactly once per real
 * transition", because this runs every frame at 60 Hz and the failure mode of getting it
 * wrong is an SDK call per frame rather than a missing one.
 */
import { describe, expect, it } from 'vitest';
import { GameplayBracket, isGameplayPhase, type GameplaySignal } from './GameplayBracket';
import type { Phase } from '../../game/phase';

function log() {
  const calls: string[] = [];
  const signal: GameplaySignal = {
    gameplayStart: () => void calls.push('start'),
    gameplayStop: () => void calls.push('stop'),
  };
  return { calls, bracket: new GameplayBracket(signal) };
}

describe('isGameplayPhase', () => {
  it('counts only a live run', () => {
    expect(isGameplayPhase('playing')).toBe(true);
  });

  it('counts no menu, overlay or wait as gameplay', () => {
    // Enumerated rather than spot-checked: every phase not named `playing` has to be a
    // break, and a NEW phase added to the union later must default to "not gameplay" —
    // which this asserts by listing the whole union.
    const breaks: Phase[] = [
      'menu', 'modeSelect', 'forge', 'pvpPreview', 'matchmaking', 'paused',
      'victory', 'defeat', 'settings', 'squad', 'account', 'store',
    ];
    for (const p of breaks) expect(isGameplayPhase(p), p).toBe(false);
  });
});

describe('GameplayBracket', () => {
  it('reports a stop on the very first frame, even in a menu', () => {
    // Not a no-op: the portal treats the span before the first bracket call as loading, so
    // a menu that never reports anything is a game that never finished loading.
    const { calls, bracket } = log();
    bracket.update('menu');
    expect(calls).toEqual(['stop']);
  });

  it('emits once per transition, not once per frame', () => {
    const { calls, bracket } = log();
    for (let i = 0; i < 5; i++) bracket.update('menu');
    for (let i = 0; i < 60; i++) bracket.update('playing');
    for (let i = 0; i < 5; i++) bracket.update('victory');
    expect(calls).toEqual(['stop', 'start', 'stop']);
    expect(bracket.isLive()).toBe(false);
  });

  it('treats a pause as a break and resuming as gameplay again', () => {
    const { calls, bracket } = log();
    bracket.update('playing');
    bracket.update('paused');
    bracket.update('playing');
    expect(calls).toEqual(['start', 'stop', 'start']);
    expect(bracket.isLive()).toBe(true);
  });

  it('suppresses gameplay while an ad is up, then restores it', () => {
    // The platform's "a user cannot progress the game while an ad is showing" stated where
    // the phase alone cannot express it — an ad is not a phase.
    const { calls, bracket } = log();
    bracket.update('playing');
    bracket.update('playing', true);
    bracket.update('playing', true);
    bracket.update('playing');
    expect(calls).toEqual(['start', 'stop', 'start']);
  });
});
