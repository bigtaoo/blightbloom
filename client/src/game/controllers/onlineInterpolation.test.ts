/**
 * The online match's render-interpolation clock (`onlineInterpolation.ts`, 2026-09-22).
 *
 * Two numbers, and every property worth having is about WHEN they move rather than about
 * arithmetic: mirroring twice inside one sim tick is what collapsed `Entity`'s interpolation
 * buffers and made an online match move in 30 Hz steps on a 60 Hz screen. `GameLoop.test.ts`
 * covers this driving the real loop; these cases cover the edges that are awkward to reach
 * from there — a stall, a catch-up burst, a fresh match starting at tick 0.
 */
import { describe, it, expect } from 'vitest';
import { OnlineInterpolation } from './onlineInterpolation';

const TICK_MS = 1000 / 30;

describe('OnlineInterpolation', () => {
  it('reports the first tick it ever sees as an advance', () => {
    const interp = new OnlineInterpolation();
    expect(interp.observe(0, 16)).toBe(true);
    expect(interp.alpha).toBe(0);
  });

  it('advances once per tick, however many frames go by inside it', () => {
    const interp = new OnlineInterpolation();
    interp.observe(7, 16);
    expect(interp.observe(7, 16)).toBe(false);
    expect(interp.observe(7, 16)).toBe(false);
    expect(interp.observe(8, 16)).toBe(true);
  });

  it('ramps alpha with real time and restarts it on each tick', () => {
    const interp = new OnlineInterpolation();
    interp.observe(1, 16);
    expect(interp.alpha).toBe(0);
    interp.observe(1, 16);
    expect(interp.alpha).toBeCloseTo(16 / TICK_MS, 6);
    interp.observe(1, 16);
    expect(interp.alpha).toBeCloseTo(32 / TICK_MS, 6);
    interp.observe(2, 16);
    expect(interp.alpha).toBe(0);
  });

  it('clamps at 1 through a stall rather than running past the confirmed position', () => {
    // A server that stops sending. Every remote actor must hold at its newest confirmed
    // position; an unclamped alpha would keep extrapolating along the last delta, so a player
    // who stopped walking would keep sliding for as long as the network was down.
    const interp = new OnlineInterpolation();
    interp.observe(3, 16);
    for (let i = 0; i < 100; i++) {
      interp.observe(3, 16);
      expect(interp.alpha).toBeLessThanOrEqual(1);
    }
    expect(interp.alpha).toBe(1);
  });

  it('treats a catch-up burst as one advance, because one mirror is what happened', () => {
    // `CoopSession.drive()` can apply several confirmed frames in one call and the caller
    // mirrors the RESULTING state once. Alpha restarts from that state, which is correct: the
    // scene is now showing the newest tick, not the first of the batch.
    const interp = new OnlineInterpolation();
    interp.observe(10, 16);
    interp.observe(10, 16);
    expect(interp.observe(14, 16)).toBe(true);
    expect(interp.alpha).toBe(0);
  });

  it('accepts a tick that goes BACKWARDS as an advance', () => {
    // Not a real netcode case, but the guard is free and the alternative is bad: a `>` test
    // would freeze the scene permanently on a session that resets its tick, and the symptom
    // would be a match that connects and then never moves.
    const interp = new OnlineInterpolation();
    interp.observe(50, 16);
    expect(interp.observe(2, 16)).toBe(true);
  });

  it('forgets the mirrored tick on reset, so a fresh match at tick 0 is drawn', () => {
    // The `-1` sentinel: a match starts at tick 0, and a leftover 0 from the previous one
    // would read as "already mirrored" and hold the first confirmed frame off the screen until
    // tick 1 — which looks like a connection problem, not like an off-by-one.
    const interp = new OnlineInterpolation();
    interp.observe(0, 16);
    interp.observe(0, 16);
    interp.reset();
    expect(interp.observe(0, 16)).toBe(true);
    expect(interp.alpha).toBe(0);
  });

  it('never returns a negative alpha, whatever dt it is handed', () => {
    // A clock that went backwards across a tab suspend. Alpha feeds a lerp, and a negative one
    // draws every remote actor BEHIND where it was last seen.
    const interp = new OnlineInterpolation();
    interp.observe(1, 16);
    interp.observe(1, -500);
    expect(interp.alpha).toBeLessThanOrEqual(1);
    expect(interp.alpha).toBeGreaterThanOrEqual(0);
  });
});
