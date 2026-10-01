/**
 * The online playout clock (`onlineInterpolation.ts`; a jitter buffer since 2026-10-01).
 *
 * The property that matters is the one a player sees: how far a remote entity moves on screen
 * from one render frame to the next. `drawn` below is that position in ticks — the scene shows
 * `prev + alpha·(cur - prev)`, and `prev` is the tick before the newest one stepped — fed by the
 * server's real shape, three frames every 100 ms (`MatchRoom`'s `DEFAULT_FRAMES_PER_BATCH`),
 * with arrival jitter on top. `GameLoop.test.ts` covers the wiring.
 */
import { describe, it, expect } from 'vitest';
import { CATCHUP_FRAMES, OnlineInterpolation } from './onlineInterpolation';

const TICK_MS = 1000 / 30;

/** Seeded noise in [-amp, amp], so a regression fails instead of flaking. */
function noise(amp: number): () => number {
  let seed = 13579;
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed / 0x7fffffff - 0.5) * 2 * amp;
  };
}

/**
 * Run `seconds` of render frames at `fps` against batches of 3 frames every 100 ms, each landing
 * up to `jitterMs` late. `plan` is the policy under test; the old one stepped everything ready.
 * Returns the drawn position's per-frame movement, in ticks, after a two-second settle.
 */
function playout(plan: (dt: number, ready: number, clock: OnlineInterpolation) => number, fps: number, jitterMs: number) {
  const clock = new OnlineInterpolation();
  const late = noise(jitterMs);
  const arrivals: number[] = [];
  for (let t = 100; t < 20_000; t += 100) arrivals.push(t + Math.abs(late()));
  arrivals.sort((a, b) => a - b);
  const dt = 1000 / fps;
  let confirmed = 0;
  let stepped = 0;
  let next = 0;
  let last: number | null = null;
  const moves: number[] = [];
  for (let now = 0; now < 12_000; now += dt) {
    while (next < arrivals.length && arrivals[next]! <= now) {
      confirmed += 3;
      next++;
    }
    const n = plan(dt, confirmed - stepped, clock);
    stepped += n;
    const drawn = stepped - 1 + clock.alpha;
    if (now > 2000 && last !== null) moves.push(drawn - last);
    last = drawn;
  }
  return { moves, perFrame: dt / TICK_MS, rate: clock.rate };
}

const paced = (dt: number, ready: number, c: OnlineInterpolation): number => c.plan(dt, ready);
const greedy = (dt: number, ready: number, c: OnlineInterpolation): number => {
  c.plan(dt, 0); // keeps the old alpha: it ramped from the last arrival and clamped at 1
  return ready;
};

describe('OnlineInterpolation — playout against the real batch shape', () => {
  it('the control: stepping each batch as it lands moves remote entities in 10 Hz lurches', () => {
    const { moves } = playout((dt, ready, c) => {
      const n = greedy(dt, ready, c);
      if (n > 0) c.reset(); // alpha restarts on the frame a batch lands, as the old observe() did
      return n;
    }, 60, 0);
    expect(Math.max(...moves)).toBeGreaterThan(2); // a whole batch's travel in one frame
    expect(moves.filter((m) => m === 0).length).toBeGreaterThan(moves.length / 3); // then frozen
  });

  it.each([
    [60, 0],
    [60, 20],
    [144, 20],
    [30, 20],
  ])('moves every remote entity the same distance every frame (%i fps, %i ms jitter)', (fps, jitter) => {
    const { moves, perFrame } = playout(paced, fps, jitter);
    // Never a stall, never a jump: each frame within the 5% the rate is allowed to lean.
    for (const m of moves) {
      expect(m).toBeGreaterThan(perFrame * 0.94);
      expect(m).toBeLessThan(perFrame * 1.06);
    }
  });

  it('settles at a shallow buffer rather than growing one', () => {
    // Steady 3-every-100 ms: the slack at the worst moment is what decides latency. A clock that
    // kept leaning slow would pass the smoothness case above and drift ever further behind.
    const clock = new OnlineInterpolation();
    let confirmed = 0;
    let stepped = 0;
    let deepest = 0;
    for (let now = 0; now < 30_000; now += 1000 / 60) {
      if (Math.floor(now / 100) > Math.floor((now - 1000 / 60) / 100)) confirmed += 3;
      stepped += clock.plan(1000 / 60, confirmed - stepped);
      if (now > 5000) deepest = Math.max(deepest, confirmed - stepped);
    }
    expect(deepest).toBeLessThanOrEqual(6); // two batches, ~200 ms, at its very worst
  });
});

describe('OnlineInterpolation — edges', () => {
  it('steps on its very first frame, so a new match is drawn at once', () => {
    const clock = new OnlineInterpolation();
    expect(clock.plan(16, 1)).toBe(1);
    expect(clock.alpha).toBeLessThan(1); // and it ramps from there, rather than holding
  });

  it('steps nothing with nothing ready, and holds at the newest position through a stall', () => {
    // A server that stops sending. Every remote actor must hold at its newest confirmed
    // position; an alpha past 1 would keep extrapolating, sliding a stopped player onward.
    const clock = new OnlineInterpolation();
    clock.plan(16, 1);
    for (let i = 0; i < 100; i++) {
      expect(clock.plan(16, 0)).toBe(0);
      expect(clock.alpha).toBeLessThanOrEqual(1);
    }
    expect(clock.alpha).toBe(1);
  });

  it('resumes after a stall one tick at a time — the time spent dry is not banked', () => {
    const clock = new OnlineInterpolation();
    clock.plan(16, 1);
    for (let i = 0; i < 30; i++) clock.plan(16, 0);
    expect(clock.plan(16, 6)).toBe(1); // not a burst through everything that piled up
    expect(clock.plan(16, 5)).toBe(0);
  });

  it(`skips a backlog of ${CATCHUP_FRAMES}+ in one go, keeping two queued`, () => {
    // A backgrounded tab or a reconnect resync: pacing half a second of backlog would leave the
    // whole match drawn that far behind for as long as it took to drain.
    const clock = new OnlineInterpolation();
    expect(clock.plan(16, 40)).toBe(38);
    expect(clock.alpha).toBe(0);
    expect(clock.plan(16, CATCHUP_FRAMES - 1)).toBe(0); // below the line: paced again
  });

  it('leans slow when it keeps running dry, and fast when the queue stays deep', () => {
    const dry = new OnlineInterpolation();
    for (let i = 0; i < 70; i++) dry.plan(16, i % 4 === 0 ? 1 : 0);
    expect(dry.rate).toBeLessThan(1);

    const deep = new OnlineInterpolation();
    for (let i = 0; i < 70; i++) deep.plan(16, 8);
    expect(deep.rate).toBeGreaterThan(1);

    const fine = new OnlineInterpolation();
    for (let i = 0; i < 70; i++) fine.plan(16, 2);
    expect(fine.rate).toBe(1);
  });

  it('never returns a negative alpha, whatever dt it is handed', () => {
    // A clock that went backwards across a tab suspend. Alpha feeds a lerp, and a negative one
    // draws every remote actor BEHIND where it was last seen.
    const clock = new OnlineInterpolation();
    clock.plan(16, 1);
    clock.plan(-500, 0);
    expect(clock.alpha).toBeGreaterThanOrEqual(0);
    expect(clock.alpha).toBeLessThanOrEqual(1);
  });

  it('reset restores a first-frame step and the neutral rate', () => {
    const clock = new OnlineInterpolation();
    for (let i = 0; i < 70; i++) clock.plan(16, 8);
    clock.reset();
    expect(clock.rate).toBe(1);
    expect(clock.plan(0, 1)).toBe(1);
  });
});
