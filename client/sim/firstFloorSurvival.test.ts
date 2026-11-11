/**
 * "The learning chapter cannot kill a player who has not started playing yet."
 *
 * The gate on the half of the 2026-11-11 first-floor pass that has no other witness
 * (ENGINE_VERSION 93, design/22 §4.1). The sandbox measured `first_input.ms` at a median
 * of 7.7 s with 76 of 97 first touches landing INSIDE a live run: for those seconds the
 * player is reading the screen while the dungeon shoots at them. `GameLoop`'s opening
 * hold (`controllers/openingHold.ts`) answers that for the AUTOSTARTED run, but it is a
 * client-side freeze — it does nothing for a player who has pressed something once, put
 * the phone down, and come back. `ember.ts`'s `shieldRegenDelay: 45` answers that half:
 * half the global 3 s wait, which is shorter than the entry room chips at.
 *
 * What is asserted is the DECISION, not the accident: chapter 1 must carry a passive
 * player through the opening 40 s, and a chapter that is NOT the learning chapter must
 * not — otherwise the same two assertions would pass against a build where nothing in
 * the dungeon can hurt anyone, which is the shape this file exists to rule out.
 */
import { describe, it, expect } from 'vitest';
import { LocalInputSource, makeCommand, quantizeMove, runHeadless } from '@dd/engine';
import { buildDungeonRunConfig } from '../src/game/match/offlineConfig';

/** 40 s at 30 Hz — well past `first_input.ms`'s 7.7 s median and its 50.7 s p90's own
 *  cause (a tab nobody is looking at), and past the opening hold's 20 s fuse. */
const OPENING_TICKS = 1200;

/** The run a player makes by holding one direction and never firing: they walk into the
 *  entry room's garrison and stay there. Not standing still — since ENGINE_VERSION 89 the
 *  entry room's mobs sit outside aggro range of the spawn, so a motionless player is
 *  never shot and the fixture would prove nothing. */
function walk(chapterId: 'ember' | 'frost', dirRad: number): { phase: string; tick: number } {
  const config = buildDungeonRunConfig({
    seed: 0xda1d, chapterId, coop: false,
    localSeat: { skinId: 'vanguard', loadout: [] }, allySkinId: 'skirmisher',
  });
  const src = new LocalInputSource();
  for (let t = 1; t <= OPENING_TICKS; t++) {
    src.submit(makeCommand({
      owner: 0, tick: t, ...quantizeMove(Math.cos(dirRad), Math.sin(dirRad)), buttons: 0,
    }));
  }
  const engine = runHeadless(config, src, OPENING_TICKS);
  return { phase: engine.state.phase, tick: engine.state.tick };
}

const COMPASS = [0, 1, 2, 3, 4, 5, 6, 7].map((k) => [k * 45, (k * Math.PI) / 4] as const);

describe('chapter 1 — the first 40 s of a player who has not started playing', () => {
  it.each(COMPASS)('survives walking %i° into the entry room without firing a shot', (_, rad) => {
    expect(walk('ember', rad)).toEqual({ phase: 'playing', tick: OPENING_TICKS });
  });

  it('chapter 2 still kills the same walk — the control, and the reason to believe the rest', () => {
    // Chapter 2 is chapter 1 under `deriveChapter.mjs`'s `transpose`, so 90° here is the
    // 0° walk that killed in chapter 1 until ENGINE_VERSION 93. It keeps the global 90-tick
    // regen delay, and dies at tick 258 — about 8.6 s, which is the 7.7 s median first
    // touch plus one second. That is the number this whole change is about.
    const dead = walk('frost', Math.PI / 2);
    expect(dead.phase).toBe('gameover');
    expect(dead.tick).toBeLessThan(OPENING_TICKS);
  });
});
