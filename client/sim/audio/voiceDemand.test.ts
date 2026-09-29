/**
 * `voiceDemand.ts` — the recorder and the replay behind `voiceDemand.sim.ts`. The sim's gates
 * read "the cap costs nothing"; these cases pin that each half would say otherwise when it
 * should, so a zero from the sim means a measured zero.
 */
import { describe, expect, it } from 'vitest';
import type { GameEvent, GameState } from '@dd/engine';
import type { AudioCue } from '../../src/platform/types';
import { CueLog, replayBudget, shippedDurations, type CueEvent } from './voiceDemand';

const at = (tick: number, cue: AudioCue, count = 1): CueEvent => ({ tick, cue, count });
const lengths = (m: Partial<Record<AudioCue, number[]>>) => new Map(Object.entries(m)) as Map<AudioCue, number[]>;

describe('replayBudget', () => {
  it('admits everything under the cap and reports the concurrency reached', () => {
    const r = replayBudget([[at(0, 'muzzle'), at(0, 'impact'), at(0, 'hurt')]], lengths({ muzzle: [1], impact: [1], hurt: [1] }), 4);
    expect(r.heldPeak).toBe(3);
    expect([...r.byCue.values()].every((c) => c.refused === 0 && c.stolen === 0)).toBe(true);
  });

  it('refuses an equal-priority cue at the cap, and steals for a higher one', () => {
    const log = [at(0, 'muzzle'), at(0, 'muzzle'), at(0, 'muzzle'), at(0, 'hurt')];
    const r = replayBudget([log], lengths({ muzzle: [1], hurt: [1] }), 2);
    expect(r.byCue.get('muzzle')).toMatchObject({ played: 2, refused: 1, stolen: 1 });
    expect(r.byCue.get('hurt')).toMatchObject({ played: 1, refused: 0, stolen: 0 });
  });

  it('counts what a stolen voice had LEFT at the moment it was stolen', () => {
    // A 1 s muzzle at tick 0, stolen by a hurt at tick 15 (0.5 s): half a second is lost.
    const r = replayBudget([[at(0, 'muzzle'), at(15, 'hurt')]], lengths({ muzzle: [1], hurt: [1] }), 1);
    expect(r.byCue.get('muzzle')!.cutSeconds).toBeCloseTo(0.5);
  });

  it('retires voices by time, so a later cue finds the slot free', () => {
    // 0.1 s voices, 3 ticks (0.1 s) apart: each has finished when the next arrives.
    const log = [at(0, 'muzzle'), at(3, 'muzzle'), at(6, 'muzzle')];
    const r = replayBudget([log], lengths({ muzzle: [0.1] }), 1);
    expect(r.byCue.get('muzzle')).toMatchObject({ played: 3, refused: 0 });
  });

  it('cycles the variants, so a long variant is not assumed for every play', () => {
    // Variant 0 lasts 0.01 s, variant 1 lasts 1 s. Round-robin: the first play is the short
    // one, so the second finds the slot free, and the third meets the long one and is
    // refused. Always drawing variant 0 would admit all three.
    const log = [at(0, 'muzzle'), at(1, 'muzzle'), at(3, 'muzzle')];
    const r = replayBudget([log], lengths({ muzzle: [0.01, 1] }), 1);
    expect(r.byCue.get('muzzle')).toMatchObject({ played: 2, refused: 1 });
  });

  it('skips a synth-only cue, which never reaches the budget in the game', () => {
    const r = replayBudget([[at(0, 'status.burn'), at(0, 'muzzle')]], lengths({ 'status.burn': [], muzzle: [1] }), 1);
    expect(r.byCue.has('status.burn')).toBe(false);
    expect(r.byCue.get('muzzle')!.played).toBe(1);
  });

  it('starts every log with an empty budget', () => {
    const r = replayBudget([[at(0, 'muzzle')], [at(0, 'muzzle')]], lengths({ muzzle: [10] }), 1);
    expect(r.byCue.get('muzzle')).toMatchObject({ played: 2, refused: 0 });
  });
});

describe('CueLog', () => {
  const state = (tick: number, events: unknown[], enemies: { id: number; alive: boolean }[] = []) =>
    ({ tick, events, players: [{ id: 1, alive: true }], enemies }) as unknown as GameState;
  const shot = { type: 'bullet_fired', ownerId: 1, gx: 0, gy: 0, facing: 0 } as unknown as GameEvent;

  it('records what the real reactor plays, coalesced per tick', () => {
    const log = new CueLog();
    log.observe(state(5, [shot, shot, shot]));
    expect(log.events).toContainEqual({ tick: 5, cue: 'muzzle', count: 3 });
  });

  it('plays spawn once per new living actor, never again for the same id', () => {
    const log = new CueLog();
    log.observe(state(1, [], [{ id: 7, alive: true }, { id: 8, alive: false }]));
    log.observe(state(2, [], [{ id: 7, alive: true }, { id: 9, alive: true }]));
    expect(log.events.filter((e) => e.cue === 'spawn')).toEqual([
      { tick: 1, cue: 'spawn', count: 2 }, // the seat and enemy 7; the dead 8 has no view
      { tick: 2, cue: 'spawn', count: 1 },
    ]);
  });
});

describe('shippedDurations', () => {
  it('reads every shipped variant, and none for a synth-only cue', () => {
    const d = shippedDurations();
    expect(d.get('muzzle')!.length).toBe(5);
    expect(d.get('status.burn')).toEqual([]);
    for (const [cue, v] of d) for (const s of v) expect(s, cue).toBeGreaterThan(0);
  });
});
