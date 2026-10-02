/**
 * LocalPredictor (ROADMAP 3.3 follow-up / design/06 local-player prediction). Pins the
 * render-layer predictor's math headlessly — the properties that matter for feel under
 * latency: at zero lag it tracks the confirmed sim exactly (no visible correction); under
 * lag it LEADS the confirmed position by the input still in flight (that lead IS the hidden
 * latency) and holds it; a large gap snaps, a small one eases. No real RTT needed — the lag
 * is simulated by feeding reconcile() an intentionally-stale confirmed position. The same
 * predictor under a model of the real server's timing is `predictorPlayout.test.ts`.
 * Weapon-facing is out of scope here (design/10 v33): it's engine-decided, not predicted —
 * see LocalPredictor's own header comment.
 */
import { describe, it, expect } from 'vitest';
import { createGameState } from '@dd/engine/state/GameState';
import { LocalPredictor, DEFAULT_PREDICTOR, walkableFor, type Walkable } from './LocalPredictor';
import { bradToRad } from '../coords';

const SPEED = 192; // px/sec — the real sim value (fpToPx(6.4px/tick) × 30Hz)
const DT = 1000 / 30; // one sim-frame's worth of render time (ms)
const STEP = (SPEED * DT) / 1000; // px advanced per full-magnitude frame = 6.4
const EAST = 0; // brad 0 → +x

const make = (over: Partial<typeof DEFAULT_PREDICTOR> = {}) =>
  new LocalPredictor({ speedPxPerSec: SPEED, ...DEFAULT_PREDICTOR, ...over });

describe('LocalPredictor — prediction', () => {
  it('is inert until reset (no pose drift, ignores predict/reconcile)', () => {
    const p = make();
    expect(p.isActive).toBe(false);
    p.predict(EAST, 255, DT);
    p.reconcile(500, 500);
    expect(p.pose).toEqual({ x: 0, y: 0, bodyFacing: 0, moving: false });
  });

  it('dead-reckons at the sim speed', () => {
    const p = make();
    p.reset(0, 0, 0);
    p.predict(EAST, 255, DT);
    expect(p.pose.x).toBeCloseTo(STEP, 5);
    expect(p.pose.y).toBeCloseTo(0, 5);
  });

  it('scales displacement by move magnitude (half stick → half step, zero → still)', () => {
    const half = make();
    half.reset(0, 0, 0);
    half.predict(EAST, 128, DT);
    expect(half.pose.x).toBeCloseTo(STEP * (128 / 255), 5);

    const idle = make();
    idle.reset(0, 0, 0);
    idle.predict(EAST, 0, DT);
    expect(idle.pose.x).toBe(0);
  });
});

describe('LocalPredictor — reconciliation', () => {
  it('at zero lag, predicted tracks confirmed within a sub-pixel epsilon (no visible pop)', () => {
    const p = make();
    p.reset(0, 0, 0);
    let confirmed = 0;
    for (let f = 0; f < 60; f++) {
      p.predict(EAST, 255, DT); // local input advances predicted
      confirmed += STEP; // confirmed advances in lockstep (no latency)
      p.reconcile(confirmed, 0);
      p.settle(1, null, DT);
    }
    expect(Math.abs(p.pose.x - confirmed)).toBeLessThan(0.5);
  });

  it('under lag, leads the confirmed position by exactly the input in flight', () => {
    // Confirmed trails 6 frames; the measured delay says so (5 ticks + the interpolation's 1).
    const K = 6;
    const p = make();
    p.reset(0, 0, 0);
    for (let f = 1; f <= 60; f++) {
      p.predict(EAST, 255, DT);
      p.reconcile(Math.max(0, f - K) * STEP, 0);
      p.settle(1, (K - 1) * DT, DT);
    }
    expect(p.pose.x).toBeCloseTo(60 * STEP, 2); // where the stick put it, not where confirmed is
  });

  it('with no delay measured yet, eases onto the confirmed position (the model before)', () => {
    const p = make();
    p.reset(0, 0, 0);
    for (let f = 1; f <= 60; f++) {
      p.predict(EAST, 255, DT);
      p.reconcile(Math.max(0, f - 6) * STEP, 0);
      p.settle(1, null, DT);
    }
    expect(p.pose.x).toBeLessThan(58 * STEP);
  });

  it('converges to confirmed once input stops (error decays monotonically to ~0)', () => {
    const target = 100;
    const p = make();
    p.reset(target + 40, 0, 0); // a 40px lead built up under lag; input has now stopped
    p.reconcile(target, 0);
    p.reconcile(target, 0);
    let prevErr = Infinity;
    for (let f = 0; f < 30; f++) {
      p.predict(EAST, 0, DT); // input released → no advance
      p.settle(1, 100, DT);
      const err = Math.abs(p.pose.x - target);
      expect(err).toBeLessThanOrEqual(prevErr + 1e-9); // never diverges
      prevErr = err;
    }
    expect(prevErr).toBeLessThan(0.1); // settled onto the confirmed position
  });

  it('snaps on a large gap (teleport / room transition), eases on a small one', () => {
    const snap = make();
    snap.reset(0, 0, 0);
    snap.reconcile(1000, 0); // >> snapPx → jump
    snap.settle(0.5, null, DT); // ...to the far side, not halfway across the gap
    expect(snap.pose.x).toBe(1000);

    const ease = make();
    ease.reset(0, 0, 0);
    ease.reconcile(10, 0); // < snapPx → no jump: it becomes the target of the next frames
    expect(ease.pose.x).toBe(0);
    ease.settle(1, null, DT / 2);
    ease.settle(1, null, DT / 2); // one tick of render time, in two frames → gain (0.25) of it
    expect(ease.pose.x).toBeCloseTo(10 * DEFAULT_PREDICTOR.correctionGain, 5);
  });

  it('interpolates the confirmed base at the playout alpha', () => {
    const p = make({ correctionGain: 1 }); // drawn = target, to read the target off
    p.reset(0, 0, 0);
    p.reconcile(10, 0);
    p.settle(0.25, null, DT);
    expect(p.pose.x).toBeCloseTo(2.5, 6);
    p.settle(-1, null, DT); // clamped into 0..1
    expect(p.pose.x).toBe(0);
  });

  // 2026-10-01: the correction landed whole on each confirmed tick, so holding the stick into a
  // wall drew a 30 Hz sawtooth of a full tick's step. The predictor now knows the walls.
  it('holds still against a wall instead of sawing at the tick rate', () => {
    const wall: Walkable = (x, y) => ({ x: Math.min(x, 0), y });
    const p = make();
    p.reset(0, 0, 0);
    const deltas: number[] = [];
    for (let f = 0; f < 240; f++) {
      const before = p.pose.x;
      p.predict(EAST, 255, DT / 2, wall); // 60 fps render, stick held east
      if (f % 2 === 1) p.reconcile(0, 0); // 30 Hz confirmed: blocked at x = 0
      p.settle(f % 2 === 1 ? 0 : 0.5, 150, DT / 2, wall);
      deltas.push(p.pose.x - before);
    }
    expect(p.pose.x).toBe(0);
    expect(Math.max(...deltas.map(Math.abs))).toBe(0);
  });

  it('walks the lead into a thin wall in short steps, never out the far side', () => {
    // A 32 px slab from x = 20 to 52, pushing out by its nearer face — the sim's own rule.
    const slab: Walkable = (x, y) => ({ x: x > 20 && x < 52 ? (x < 36 ? 20 : 52) : x, y });
    const p = make({ correctionGain: 1, snapPx: 1000 });
    p.reset(0, 0, 0);
    for (let f = 0; f < 9; f++) p.predict(EAST, 255, DT); // 57.6 px of stick in flight
    p.settle(1, 1000, DT, slab); // one 57.6 px push would land at 57.6, through the slab
    expect(p.pose.x).toBe(20);
  });

  it('forgets input older than a second — past that a delay reading is a stall', () => {
    const p = make({ correctionGain: 1, snapPx: 1e6 });
    p.reset(0, 0, 0);
    for (let f = 0; f < 60; f++) p.predict(EAST, 255, DT); // two seconds of stick
    p.settle(1, 5000, DT);
    // The last second's worth (30 steps, one more where the float clock lands on the edge), not both.
    expect(p.pose.x).toBeGreaterThan(30 * STEP - 1e-6);
    expect(p.pose.x).toBeLessThan(31 * STEP + 1e-6);
  });

  it('a zero-length frame adds nothing to the lead (and no NaN)', () => {
    const p = make({ correctionGain: 1 });
    p.reset(0, 0, 0);
    p.predict(EAST, 255, DT);
    p.predict(EAST, 255, 0);
    p.settle(1, 1000, DT);
    expect(p.pose.x).toBeCloseTo(STEP, 6);
  });

  it('deactivate() halts prediction so the caller can fall back to confirmed', () => {
    const p = make();
    p.reset(5, 5, 0);
    p.deactivate();
    p.predict(EAST, 255, DT);
    p.reconcile(999, 999);
    p.settle(1, 100, DT);
    expect(p.pose).toEqual({ x: 5, y: 5, bodyFacing: 0, moving: false });
    expect(p.isActive).toBe(false);
  });
});

describe("walkableFor — the sim's own wall response, in px", () => {
  const state = createGameState({ seed: 3, worldW: 1600, worldH: 1200, waves: [], players: [{ start: [400, 400] }] });
  const walk = walkableFor(state, state.players[0]!);

  it('hands a free point back untouched, float and all', () => {
    expect(walk(400.123, 300.456)).toEqual({ x: 400.123, y: 300.456 });
  });

  it('pushes a point past the world edge back inside it', () => {
    const at = walk(-50, 300);
    expect(at.x).toBeGreaterThan(0);
    expect(at.y).toBeCloseTo(300, 1);
  });
});

describe('LocalPredictor — moving flag (ROADMAP: fixes the local player\'s walk animation never playing under prediction)', () => {
  it('is true the frame a nonzero move magnitude is predicted, false when idle', () => {
    const p = make();
    p.reset(0, 0, 0);
    expect(p.pose.moving).toBe(false); // fresh reset, nothing predicted yet

    p.predict(EAST, 255, DT);
    expect(p.pose.moving).toBe(true);

    p.predict(EAST, 0, DT); // stick released
    expect(p.pose.moving).toBe(false);
  });

  it('stays false while inactive, even if predict() is (harmlessly) called', () => {
    const p = make();
    p.predict(EAST, 255, DT); // no-op — never reset()
    expect(p.pose.moving).toBe(false);
  });
});

describe('LocalPredictor — body facing (upper/lower body split)', () => {
  it('body facing tracks the move direction while moving', () => {
    const p = make();
    p.reset(0, 0, 0);
    const NORTH = 16384; // brad quarter-turn
    p.predict(NORTH, 255, DT);
    expect(p.pose.bodyFacing).toBeCloseTo(bradToRad(NORTH), 5);
  });

  it('holds the last body facing when the stick goes idle (no snap-to-zero)', () => {
    const p = make();
    const NORTH = 16384;
    p.reset(0, 0, 0);
    p.predict(NORTH, 255, DT);
    expect(p.pose.bodyFacing).toBeCloseTo(bradToRad(NORTH), 5);
    p.predict(EAST, 0, DT); // moveMag 0 — idle stick, moveBrad snapped back to EAST
    expect(p.pose.bodyFacing).toBeCloseTo(bradToRad(NORTH), 5); // held, not reset to EAST
  });
});
