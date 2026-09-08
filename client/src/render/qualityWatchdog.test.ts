/**
 * The auto-downgrade detector (`qualityWatchdog.ts`, 2026-08-25).
 *
 * Every case below is about the SHAPE of the window stream rather than about one number, because
 * the failure modes are all sequence-shaped: firing on a single loading hitch, never firing
 * because a healthy window in the middle reset the streak, firing more times than there are
 * rungs to step down, or counting a window from a backgrounded tab (where rAF is throttled and
 * every device looks broken).
 *
 * Rewritten 2026-09-08 when the boolean latch became a STEP counter (the `medium` tier): the
 * cases that read `downgraded` now read `downgrades`, and "fires once" became "fires once per
 * rung, and never more than there are rungs".
 */
import { describe, it, expect } from 'vitest';
import { QualityWatchdog, type FrameWindowLike } from './qualityWatchdog';

/** A window that would trip the detector, unless something else disqualifies it. */
function slow(over: Partial<FrameWindowLike> = {}): FrameWindowLike {
  return { fps: 18, frames: 40, discarded: false, ...over };
}
function fast(over: Partial<FrameWindowLike> = {}): FrameWindowLike {
  return { fps: 60, frames: 120, discarded: false, ...over };
}

/** Feed a list of windows, returning how many of them the watchdog fired on. */
function fire(wd: QualityWatchdog, windows: FrameWindowLike[]): number {
  return windows.filter((w) => wd.observe(w)).length;
}

describe('QualityWatchdog', () => {
  it('does not fire on fewer than the sustain count of slow windows', () => {
    const wd = new QualityWatchdog({ sustainWindows: 3 });
    expect(fire(wd, [slow(), slow()])).toBe(0);
    expect(wd.downgrades).toBe(0);
  });

  it('fires on exactly the window that completes the streak', () => {
    const wd = new QualityWatchdog({ sustainWindows: 3 });
    expect(wd.observe(slow())).toBe(false);
    expect(wd.observe(slow())).toBe(false);
    expect(wd.observe(slow())).toBe(true);
    expect(wd.downgrades).toBe(1);
  });

  it('steps once per FRESH streak, not once per slow window', () => {
    // The windows that condemned the tier we were on are no evidence about the cheaper one we
    // just switched to, so the streak restarts. With sustain 2: the 2nd window steps, the 3rd
    // does not (streak of 1), the 4th steps again.
    const wd = new QualityWatchdog({ sustainWindows: 2 });
    expect(wd.observe(slow())).toBe(false);
    expect(wd.observe(slow())).toBe(true);
    expect(wd.observe(slow())).toBe(false);
    expect(wd.observe(slow())).toBe(true);
    expect(wd.downgrades).toBe(2);
  });

  it('stops at the bottom rung, however many slow windows follow', () => {
    // `resolveTier`'s ladder is three tiers, i.e. two steps. A third `true` could only mean
    // "downgrade something already on the cheapest tier", which is a lie to the caller.
    const wd = new QualityWatchdog({ sustainWindows: 1 });
    expect(fire(wd, [slow(), slow(), slow(), slow(), slow(), slow()])).toBe(2);
    expect(wd.downgrades).toBe(2);
  });

  it('honours a maxSteps of one — a two-tier ladder is still expressible', () => {
    const wd = new QualityWatchdog({ sustainWindows: 1, maxSteps: 1 });
    expect(fire(wd, [slow(), slow(), slow()])).toBe(1);
    expect(wd.downgrades).toBe(1);
  });

  it('resets the streak on a healthy window — a loading hitch is not a slow device', () => {
    const wd = new QualityWatchdog({ sustainWindows: 3 });
    // Two slow (a room load), one fine, two slow. Five slow-ish windows in total, no run of 3.
    expect(fire(wd, [slow(), slow(), fast(), slow(), slow()])).toBe(0);
    // ...and the streak really did restart, rather than merely being paused: it takes a FULL
    // three more, not one more, to trip it.
    expect(wd.observe(slow())).toBe(true);
  });

  it('ignores a window from a hidden tab without crediting it either way', () => {
    const wd = new QualityWatchdog({ sustainWindows: 3 });
    // The discarded window sits mid-streak. If it counted, this fires early; if it RESET the
    // streak, this never fires at all. Neither: the streak simply carries across it.
    expect(fire(wd, [slow(), slow({ discarded: true }), slow()])).toBe(0);
    expect(wd.observe(slow())).toBe(true);
  });

  it('ignores a window too short to describe the game rather than the load', () => {
    const wd = new QualityWatchdog({ sustainWindows: 2, minFrames: 5 });
    expect(fire(wd, [slow({ frames: 2 }), slow({ frames: 4 }), slow({ frames: 1 })])).toBe(0);
    expect(fire(wd, [slow(), slow()])).toBe(1);
  });

  it('treats the fps floor as inclusive-healthy — exactly at the floor is not slow', () => {
    // The floor is documented as "5fps of headroom below 30, so a 30Hz-locked device is not
    // slow". A device pinned at exactly the floor must therefore keep the high tier.
    const wd = new QualityWatchdog({ fpsFloor: 25, sustainWindows: 2 });
    expect(fire(wd, [slow({ fps: 25 }), slow({ fps: 25 }), slow({ fps: 25 })])).toBe(0);
    expect(fire(wd, [slow({ fps: 24.9 }), slow({ fps: 24.9 })])).toBe(1);
  });

  it('re-arms after reset(), so returning to auto re-measures', () => {
    const wd = new QualityWatchdog({ sustainWindows: 2 });
    expect(fire(wd, [slow(), slow()])).toBe(1);
    wd.reset();
    expect(wd.downgrades).toBe(0);
    // And the streak went with the latch — one slow window must not be enough now.
    expect(wd.observe(slow())).toBe(false);
    expect(wd.observe(slow())).toBe(true);
  });

  it('defaults to a streak long enough to outlast a single sampling window', () => {
    // No options at all — the production configuration. One slow window must never be enough:
    // that is the whole reason this is a streak detector and not a threshold.
    const wd = new QualityWatchdog();
    expect(wd.observe(slow())).toBe(false);
    expect(wd.downgrades).toBe(0);
  });
});
