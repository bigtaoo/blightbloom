/**
 * The local player under real online timing (2026-10-01): `LocalPredictor` + the delay meter
 * (`net/inputDelay.ts`) + the paced playout (`onlineInterpolation.ts`), against a model of the
 * server — a command lands on the frame of the 100 ms, 3-frame window its arrival falls in
 * (2026-10-03; before, always the window's last frame — kept as `lastFrame`, the control), the
 * batch goes out at the window's end, and each leg of the trip has its own delay and jitter. What is measured is
 * the drawn x of a player running east and letting go, compared with where the stick put them.
 *
 * The control is the model this replaced (ease onto the bare confirmed position): it carries
 * the whole latency while running and slides on by it after the stop.
 */
import { describe, it, expect } from 'vitest';
import { LocalPredictor, DEFAULT_PREDICTOR, type Walkable } from './LocalPredictor';
import { OnlineInterpolation } from './onlineInterpolation';
import { InputDelayMeter } from '../../net/inputDelay';

const SPEED = 192; // px/s — the sim's (6.4 px/tick × 30 Hz)
const TICK = 1000 / 30;
const STEP = SPEED / 30;
const BATCH_MS = 100;
const BATCH_FRAMES = 3;

interface Net {
  upMs: number;
  downMs: number;
  jitterMs: number;
  fps: number;
  /** NetInputSource's cushion, in frames. */
  cushion: number;
}

function noise(amp: number): () => number {
  let seed = 97531;
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed / 0x7fffffff) * amp; // delay only ever adds
  };
}

interface Run {
  t: number[];
  drawn: number[];
  ideal: number[];
  /** Where the confirmed sim ends up once everything has landed. */
  settled: number;
  stopAt: number;
}

/** Run east from 500 ms to `stopAt`, then stand; `wall` blocks x past it. */
function play(net: Net, opts: { old?: boolean; lastFrame?: boolean; wall?: number; stopAt?: number } = {}): Run {
  const wall = opts.wall ?? Infinity;
  const walk: Walkable = (x, y) => ({ x: Math.min(x, wall), y });
  const stopAt = opts.stopAt ?? 8000;
  const rnd = noise(net.jitterMs);
  const dt = 1000 / net.fps;
  const pred = new LocalPredictor({ speedPxPerSec: SPEED, ...DEFAULT_PREDICTOR });
  const interp = new OnlineInterpolation();
  const meter = new InputDelayMeter();
  pred.reset(0, 0, 0);

  const toServer: { at: number; mag: number; tag: number }[] = [];
  const landed = new Map<number, { mag: number; tag: number }>(); // frame → the command held from it
  const toClient: { at: number; to: number }[] = [];
  let serverFrame = 0;
  let nextPulse = 37; // the server's phase against the client's clock
  let watermark = 0;
  let stepped = 0;
  let held = { mag: 0, tag: -1 };
  let simX = 0;
  let lastSent = -1;
  let idealX = 0;
  let oldX = 0;
  let oldTarget = 0;
  const out: Run = { t: [], drawn: [], ideal: [], settled: 0, stopAt };

  for (let t = 0; t < stopAt + 2000; t += dt) {
    // The server, up to now.
    while (nextPulse <= t) {
      serverFrame += BATCH_FRAMES;
      for (let i = toServer.length - 1; i >= 0; i--) {
        if (toServer[i]!.at <= nextPulse) {
          const c = toServer.splice(i, 1)[0]!;
          // The window frame the arrival falls in (MatchRoom's WindowClock), or — the server
          // before 2026-10-03 — always the window's last frame.
          const into = Math.min(BATCH_FRAMES - 1, Math.max(0, Math.floor(((c.at - (nextPulse - BATCH_MS)) * BATCH_FRAMES) / BATCH_MS)));
          const frame = opts.lastFrame ? serverFrame : serverFrame - BATCH_FRAMES + 1 + into;
          const prev = landed.get(frame);
          if (!prev || c.tag > prev.tag) landed.set(frame, { mag: c.mag, tag: c.tag });
        }
      }
      const last = toClient.length > 0 ? toClient[toClient.length - 1]!.at : 0;
      toClient.push({ at: Math.max(last, nextPulse + net.downMs + rnd()), to: serverFrame });
      nextPulse += BATCH_MS;
    }
    while (toClient.length > 0 && toClient[0]!.at <= t) watermark = toClient.shift()!.to;

    // The client's frame, in GameLoop.advanceOnline's order.
    const mag = t >= 5000 && t < stopAt ? 255 : 0;
    const tag = stepped + 1; // `session.frame`, as the input builder stamps it
    if (mag !== lastSent) {
      lastSent = mag;
      meter.sent(tag, t);
      toServer.push({ at: t + net.upMs + rnd(), mag, tag });
    }
    pred.predict(0, mag, dt, walk);
    idealX = Math.min(wall, idealX + (SPEED * mag * dt) / 255000);
    oldX = Math.min(wall, oldX + (SPEED * mag * dt) / 255000);

    const ready = Math.max(0, watermark - net.cushion - stepped);
    for (let n = interp.plan(dt, ready); n > 0; n--) {
      stepped++;
      held = landed.get(stepped) ?? held;
      meter.applied(held.tag, t);
      simX = Math.min(wall, simX + (STEP * held.mag) / 255);
      pred.reconcile(simX, 0);
      oldTarget = simX;
    }
    pred.settle(interp.alpha, meter.delayMs, dt, walk);
    oldX += (oldTarget - oldX) * (1 - Math.pow(1 - DEFAULT_PREDICTOR.correctionGain, dt / TICK));

    out.t.push(t);
    out.drawn.push(opts.old ? oldX : pred.pose.x);
    out.ideal.push(idealX);
  }
  out.settled = simX;
  return out;
}

const LAN: Net = { upMs: 20, downMs: 20, jitterMs: 10, fps: 60, cushion: 0 };
const NETS: [string, Net][] = [
  ['60 fps, 40 ms RTT', LAN],
  ['60 fps, 160 ms RTT, 30 ms jitter', { upMs: 80, downMs: 80, jitterMs: 30, fps: 60, cushion: 0 }],
  ['144 fps, 100 ms RTT', { upMs: 50, downMs: 50, jitterMs: 15, fps: 144, cushion: 0 }],
  ['30 fps, 100 ms RTT', { upMs: 50, downMs: 50, jitterMs: 15, fps: 30, cushion: 0 }],
  ['60 fps, 100 ms RTT, the old 3-frame cushion', { upMs: 50, downMs: 50, jitterMs: 15, fps: 60, cushion: 3 }],
];

/** While running steady: how far the drawn player trails the stick, at worst. */
function runningLag(r: Run): number {
  let worst = 0;
  for (let i = 0; i < r.t.length; i++) if (r.t[i]! > 6000 && r.t[i]! < r.stopAt) worst = Math.max(worst, r.ideal[i]! - r.drawn[i]!);
  return worst;
}
/** Per-frame steps while running steady, as a share of the frame's ideal step. */
function runningSteps(r: Run): number[] {
  const out: number[] = [];
  for (let i = 1; i < r.t.length; i++) {
    if (r.t[i]! > 6000 && r.t[i]! < r.stopAt) out.push((r.drawn[i]! - r.drawn[i - 1]!) / (r.ideal[i]! - r.ideal[i - 1]!));
  }
  return out;
}
/** After the stop: [furthest forward, furthest back] the drawn player moves from where the stick left it. */
function afterStop(r: Run): [number, number] {
  const i0 = r.t.findIndex((t) => t >= r.stopAt);
  const at = r.drawn[i0]!;
  let fwd = 0;
  let back = 0;
  let peak = at;
  for (let i = i0; i < r.t.length; i++) {
    peak = Math.max(peak, r.drawn[i]!);
    fwd = Math.max(fwd, r.drawn[i]! - at);
    back = Math.max(back, peak - r.drawn[i]!);
  }
  return [fwd, back];
}

/** The smallest per-frame step, as a share of the stick's, from the stick going down — and after
 *  it comes up, any step back (beyond float noise) as itself. */
function slowestStep(r: Run): number {
  let lo = Infinity;
  for (let i = 1; i < r.t.length; i++) {
    const want = r.ideal[i]! - r.ideal[i - 1]!;
    const got = r.drawn[i]! - r.drawn[i - 1]!;
    if (r.t[i]! > 5000) lo = Math.min(lo, want > 0 ? got / want : got < -0.01 ? got : Infinity);
  }
  return lo;
}

describe('local prediction under online timing', () => {
  it('the control: easing onto the confirmed position carries the latency and slides after the stop', () => {
    const r = play(LAN, { old: true });
    expect(runningLag(r)).toBeGreaterThan(4 * STEP); // 34 px measured, 79 px with the old cushion
    expect(afterStop(r)[0]).toBeGreaterThan(4 * STEP);
  });

  for (const [name, net] of NETS) {
    it(`${name}: runs with the stick, steps evenly, stops where the sim does`, () => {
      const r = play(net);
      const steps = runningSteps(r);
      const lag = runningLag(r);
      const [fwd, back] = afterStop(r);
      // Running: a couple of px behind the stick (3-7 measured), never the whole latency.
      expect(lag, 'lag').toBeLessThan(2 * STEP);
      expect(Math.min(...steps), 'slowest step').toBeGreaterThan(0.98);
      expect(Math.max(...steps), 'fastest step').toBeLessThan(1.02);
      // Stopping: what is left is one sim tick (where in it the stop arrived) plus that lag.
      expect(fwd, 'slide').toBeLessThanOrEqual(STEP + lag + 0.5);
      expect(back, 'pulled back').toBeLessThan(0.05);
      expect(r.drawn[r.drawn.length - 1]!, 'settles on the sim').toBeCloseTo(r.settled, 1);
      // From the first step on: may ease (the start lands up to a batch late), never reverses.
      expect(slowestStep(r), 'start').toBeGreaterThan(0.6);
    });
  }

  it('slides forward, never back, at every batch phase of the stop', () => {
    let oldWorst = 0;
    for (let stopAt = 7000; stopAt < 7100; stopAt += 9) {
      const r = play(LAN, { stopAt });
      const [fwd, back] = afterStop(r);
      // The control: the server landing every command on its window's last frame (before
      // 2026-10-03) slides up to the whole window — 19 px measured, against 7 px now.
      const old = play(LAN, { stopAt, lastFrame: true });
      oldWorst = Math.max(oldWorst, afterStop(old)[0] - runningLag(old));
      expect(fwd, `slide @ ${stopAt}`).toBeLessThanOrEqual(STEP + runningLag(r) + 0.5);
      expect(back, `pulled back @ ${stopAt}`).toBeLessThan(0.05);
      expect(r.drawn[r.drawn.length - 1]!).toBeCloseTo(r.settled, 1);
    }
    expect(oldWorst).toBeGreaterThan(2 * STEP);
  });

  it('holds still against a wall — no creep into it, no sawtooth', () => {
    const r = play(LAN, { wall: 200 });
    const tail = r.drawn.slice(r.t.findIndex((t) => t > 6500));
    expect(tail[0]!).toBeCloseTo(200, 1); // reached it...
    expect(Math.max(...tail)).toBeLessThanOrEqual(200); // ...and never went in
    for (let i = 1; i < tail.length; i++) expect(Math.abs(tail[i]! - tail[i - 1]!)).toBeLessThan(0.05);
  });
});
