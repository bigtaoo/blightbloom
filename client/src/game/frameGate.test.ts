/**
 * The vsync-counting frame gate (`frameGate.ts`, 2026-10-01), driven through a REAL Pixi
 * `Ticker` with jittered timestamps — the same harness `powerBudget.test.ts` uses to measure
 * Pixi's own gate, so the two tables are directly comparable. That file pins the residue
 * (4-9% uneven on 90/100/165 Hz); this one pins that the residue is gone.
 */
import { describe, it, expect } from 'vitest';
import { Ticker } from 'pixi.js';
import { FrameGate, installFrameGate, vsyncsPerFrame } from './frameGate';
import { FRAME_RATE_SETTINGS, IDLE_MAX_FPS, tickerCapFor } from './powerBudget';

const RATES = [60, 75, 90, 100, 120, 144, 165, 240];

/** Seeded ±`amp` ms of timestamp noise (see `powerBudget.test.ts`). */
function jitter(amp: number): () => number {
  let seed = 24680;
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed / 0x7fffffff - 0.5) * 2 * amp;
  };
}

/** Frames drawn per second, and the share of frames whose length (in whole vsyncs) is not the
 *  usual one. `gated: false` measures Pixi's own gate, as the control. */
function cadence(cap: number, hz: number, known: number | null, gated = true, amp = 0.2) {
  const ticker = new Ticker();
  // Installed BEFORE the cap is written, as in the game (`applyPowerBudget` writes it every
  // frame): Pixi's own `maxFPS` getter rounds to a whole fps, so a cap read back from it at
  // install time is not the one `tickerCapFor` chose.
  if (gated) installFrameGate(ticker, () => known);
  ticker.maxFPS = cap;
  const period = 1000 / hz;
  const noise = jitter(amp);
  const ranAt: number[] = [];
  let now = 0;
  ticker.add(() => ranAt.push(now));
  const seconds = 30;
  for (let t = 1000; t < 1000 + seconds * 1000; t += period) ticker.update((now = t + noise()));
  ticker.destroy();
  const gaps: number[] = [];
  for (let i = 2; i < ranAt.length; i++) gaps.push(Math.round((ranAt[i]! - ranAt[i - 1]!) / period));
  const counts = new Map<number, number>();
  for (const n of gaps) counts.set(n, (counts.get(n) ?? 0) + 1);
  const mode = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
  return { fps: ranAt.length / seconds, unevenPct: (100 * gaps.filter((n) => n !== mode).length) / gaps.length };
}

describe('installFrameGate — cadence against the real ticker', () => {
  it('the control: Pixi\'s own gate leaves a residue on the panels this exists for', () => {
    // If a future Pixi fixes its gate this fails, and the gate here can be reconsidered.
    const worst = Math.max(...[90, 100, 165].map((hz) => cadence(tickerCapFor(60, hz), hz, hz, false).unevenPct));
    expect(worst).toBeGreaterThan(3);
  });

  it('is perfectly even on every refresh rate, at every setting, with the rate known', () => {
    for (const hz of RATES) {
      for (const target of [...FRAME_RATE_SETTINGS, IDLE_MAX_FPS]) {
        const got = cadence(tickerCapFor(target, hz), hz, hz);
        expect(got.unevenPct, `${hz}Hz @ ${target}`).toBe(0);
        // ...at the rate `tickerCapFor` snapped to, not below it.
        const aimed = hz <= target * 1.02 ? hz : hz / Math.max(1, Math.round(hz / target));
        expect(got.fps, `${hz}Hz @ ${target} fps`).toBeCloseTo(aimed, 0);
      }
    }
  });

  it('is even with the rate not yet measured too', () => {
    for (const hz of RATES) {
      for (const target of FRAME_RATE_SETTINGS) {
        const got = cadence(tickerCapFor(target, null), hz, null);
        expect(got.unevenPct, `${hz}Hz @ ${target}`).toBe(0);
        expect(got.fps, `${hz}Hz @ ${target} fps`).toBeLessThanOrEqual(target * 1.26); // 75 Hz at 60: the one rate it overshoots
      }
    }
  });

  it('holds up under a full millisecond of timestamp noise', () => {
    for (const hz of [90, 120, 144]) expect(cadence(tickerCapFor(60, hz), hz, hz, true, 1).unevenPct).toBe(0);
  });

  it('runs every vsync with no cap, and reads a cap written after install', () => {
    const ticker = new Ticker();
    installFrameGate(ticker, () => 120);
    let ran = 0;
    ticker.add(() => ran++);
    for (let t = 1000; t < 2000; t += 1000 / 120) ticker.update(t);
    expect(ran).toBeGreaterThan(115);
    ticker.maxFPS = 60;
    expect(ticker.maxFPS).toBe(60);
    ran = 0;
    for (let t = 2000; t < 3000; t += 1000 / 120) ticker.update(t);
    expect(ran).toBeCloseTo(60, -1);
    ticker.destroy();
  });

  it('switches Pixi\'s own gate off, keeping the cap it was given', () => {
    const ticker = new Ticker();
    ticker.maxFPS = 50;
    const gate = installFrameGate(ticker, () => null);
    expect(gate.cap).toBe(50); // (Pixi's getter rounds it — harmless, the next write is exact)
    expect((ticker as unknown as { _minElapsedMS: number })._minElapsedMS).toBe(0);
    ticker.destroy();
  });

  it('a skipped frame leaves the ticker untouched, so the next deltaMS spans both', () => {
    const ticker = new Ticker();
    installFrameGate(ticker, () => 120);
    ticker.maxFPS = tickerCapFor(60, 120);
    const deltas: number[] = [];
    ticker.add((t) => deltas.push(t.deltaMS));
    for (let t = 1000; t < 1200; t += 1000 / 120) ticker.update(t);
    for (const d of deltas.slice(1)) expect(d).toBeCloseTo(1000 / 60, 6);
    ticker.destroy();
  });
});

describe('FrameGate', () => {
  it('takes the clock itself when update() is called without a timestamp, as Pixi allows', () => {
    const ticker = new Ticker();
    installFrameGate(ticker, () => null);
    let ran = 0;
    ticker.add(() => ran++);
    ticker.update(); // first ever: admitted, and the ticker sees a real time
    expect(ran + ticker.lastTime).toBeGreaterThan(0);
    ticker.destroy();
  });

  it('admits the first frame it ever sees', () => {
    const gate = new FrameGate();
    gate.cap = 30;
    expect(gate.admit(5, 60)).toBe(true);
    expect(gate.admit(5 + 1000 / 60, 60)).toBe(false);
    expect(gate.admit(5 + 2000 / 60, 60)).toBe(true);
  });
});

describe('vsyncsPerFrame', () => {
  it('recovers the vsync count tickerCapFor snapped to, at every rate and setting', () => {
    for (const hz of [...RATES, 50, 59.94, 200, 360, 480]) {
      for (const target of [...FRAME_RATE_SETTINGS, IDLE_MAX_FPS]) {
        const cap = tickerCapFor(target, hz);
        if (cap === 0) continue;
        const want = Math.max(1, Math.round(hz / target));
        expect(vsyncsPerFrame(1000 / cap / (1000 / hz)), `${hz}Hz @ ${target}`).toBe(want);
      }
    }
  });

  it('rounds toward FEWER frames on an in-between ratio — a cap is a ceiling', () => {
    expect(vsyncsPerFrame(1.44)).toBe(2); // 60 asked of a 90 Hz panel: 45, not 90
    expect(vsyncsPerFrame(0.5)).toBe(1);
  });
});
