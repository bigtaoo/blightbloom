/**
 * The display-rate probe (`displayRate.ts`, 2026-09-22).
 *
 * The value it produces decides whether `game/powerBudget.ts` caps the frame rate at all, so
 * the cases that matter most are the REFUSALS: a wrong number here is acted on silently,
 * while a `null` lands on a conservative cap that was already correct. Each refusal below is
 * a state a real host reaches, named at the case.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  AGREEMENT_TOLERANCE,
  MIN_AGREEMENT,
  MIN_GAPS,
  PROBE_MS,
  estimateDisplayHz,
  probeDisplayRate,
} from './displayRate';

/** `count` timestamps spaced at `hz`, with optional deterministic noise. */
function ticks(hz: number, count: number, amp = 0): number[] {
  const period = 1000 / hz;
  let seed = 99991;
  const noise = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed / 0x7fffffff - 0.5) * 2 * amp;
  };
  return Array.from({ length: count }, (_, i) => 1000 + i * period + (amp ? noise() : 0));
}

describe('estimateDisplayHz', () => {
  it('reads an ordinary panel to within a fraction of a hertz', () => {
    for (const hz of [60, 75, 90, 120, 144, 165, 240]) {
      const est = estimateDisplayHz(ticks(hz, 90));
      expect(est, String(hz)).not.toBe(null);
      expect(est!.hz, String(hz)).toBeCloseTo(hz, 6);
      expect(est!.agreement, String(hz)).toBe(1);
    }
  });

  it('does not round to a nice number', () => {
    // 59.94 is an ordinary refresh rate and it is NOT 60. Rounding here would be inventing
    // precision that `tickerCapFor` then makes a decision with — and the decision it makes at
    // 60 Hz (do not cap at all) is one this project would rather make on a measurement.
    expect(estimateDisplayHz(ticks(59.94, 90))!.hz).toBeCloseTo(59.94, 4);
  });

  it('ignores the minority of gaps that are not the refresh interval', () => {
    // A GC pause, a compositor hiccup, one dropped frame. The mean would report ~57 Hz here;
    // the median is unmoved, which is the entire reason it is the median.
    const t = ticks(60, 90);
    for (const i of [10, 30, 50, 70]) t[i] = t[i]! + 40;
    const est = estimateDisplayHz(t);
    expect(est!.hz).toBeCloseTo(60, 3);
    expect(est!.agreement).toBeLessThan(1);
    expect(est!.agreement).toBeGreaterThanOrEqual(MIN_AGREEMENT);
  });

  it('survives real timestamp noise', () => {
    const est = estimateDisplayHz(ticks(60, 90, 0.4));
    expect(est!.hz).toBeCloseTo(60, 1);
  });

  it('refuses a sample too short to mean anything', () => {
    expect(estimateDisplayHz(ticks(60, MIN_GAPS))).toBe(null); // MIN_GAPS ticks = MIN_GAPS-1 gaps
    expect(estimateDisplayHz(ticks(60, MIN_GAPS + 1))).not.toBe(null);
    expect(estimateDisplayHz([])).toBe(null);
  });

  it('refuses a throttled tab rather than reporting a 1 Hz display', () => {
    // The case this band exists for, and it is not hypothetical: a browser throttles rAF to
    // roughly 1 Hz in a hidden tab. Reported as a display rate, `tickerCapFor` would read it
    // as "the display is slower than the target" and stop capping — the precise state the
    // whole change exists to avoid falling into by accident.
    expect(estimateDisplayHz(ticks(1, 90))).toBe(null);
    // ...and the other end: nothing shipping refreshes faster than 480 Hz, so a sub-2 ms gap
    // is a fake clock (or a test double calling back synchronously).
    expect(estimateDisplayHz(ticks(1000, 90))).toBe(null);
  });

  it('refuses a sample with no single rate in it', () => {
    // A variable-refresh-rate panel under load: half the frames at 60 Hz and half at 40. There
    // is no one number to report, and reporting either would be a decision made on a coin
    // flip that the caller cannot see.
    const mixed: number[] = [1000];
    for (let i = 0; i < 60; i++) mixed.push(mixed[mixed.length - 1]! + (i % 2 === 0 ? 1000 / 60 : 1000 / 40));
    const est = estimateDisplayHz(mixed);
    expect(est).toBe(null);
  });

  it('drops a non-positive gap instead of letting it drag the median', () => {
    // Two callbacks in one tick, or a clock that went backwards. Dropping keeps them out of
    // the median; counting them would pull it toward zero, i.e. toward a "very fast display".
    const t = ticks(60, 90);
    const withDupes = t.flatMap((v, i) => (i % 10 === 0 ? [v, v] : [v]));
    expect(estimateDisplayHz(withDupes)!.hz).toBeCloseTo(60, 3);
  });

  it('agrees with itself about the tolerance it reports', () => {
    // `agreement` is not decoration — it is the number the refusal is made on, so it has to
    // mean what its constant says. Half the gaps moved by twice the tolerance: agreement lands
    // at ~0.5, below MIN_AGREEMENT, so the estimate is refused.
    const t = ticks(60, 90);
    for (let i = 1; i < t.length; i += 2) t[i] = t[i]! + (1000 / 60) * AGREEMENT_TOLERANCE * 2;
    expect(estimateDisplayHz(t)).toBe(null);
  });
});

describe('probeDisplayRate', () => {
  /** A fake rAF that fires synchronously, advancing a clock by `period` each time. */
  function fakeRaf(hz: number, limit = 500): (cb: (t: number) => void) => void {
    const period = 1000 / hz;
    let t = 1000;
    let calls = 0;
    return (cb: (t: number) => void): void => {
      if (calls++ >= limit) return;
      t += period;
      cb(t);
    };
  }

  it('samples for PROBE_MS and reports the rate once', () => {
    const onResult = vi.fn();
    probeDisplayRate({ raf: fakeRaf(60), onResult });
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult.mock.calls[0]![0]).toBeCloseTo(60, 6);
  });

  it('measures its window from the first CALLBACK, not from install', () => {
    // A frame can be a whole interval away from the call that asked for it, and on a slow boot
    // it is several. Measuring from a clock read at install would make the window shorter than
    // it looks by exactly that much — on the 24 Hz end of the band, enough to drop below
    // MIN_GAPS and refuse.
    let sampled = 0;
    const raf = fakeRaf(60);
    const onResult = vi.fn();
    probeDisplayRate({
      raf: (cb) => {
        sampled++;
        raf(cb);
      },
      onResult,
    });
    // ~PROBE_MS of frames at 60 Hz, plus the one that closes the window.
    expect(sampled).toBeGreaterThanOrEqual(Math.floor((PROBE_MS / 1000) * 60));
    expect(sampled).toBeLessThanOrEqual(Math.ceil((PROBE_MS / 1000) * 60) + 2);
  });

  it('honours a shorter window', () => {
    const onResult = vi.fn();
    probeDisplayRate({ raf: fakeRaf(120), sampleMs: 500, onResult });
    expect(onResult.mock.calls[0]![0]).toBeCloseTo(120, 6);
  });

  it('reports null on a host with no rAF at all, rather than never reporting', () => {
    // Some WeChat shells. The distinction matters: `null` is a state the cap knows how to be
    // correct in, while silence would leave a caller waiting for a callback that never comes.
    const onResult = vi.fn();
    probeDisplayRate({ raf: undefined, onResult });
    expect(onResult).toHaveBeenCalledWith(null);
  });

  it('reports null when the sample it collected says nothing', () => {
    // A hidden tab for the whole probe window. One call, one `null`, no throw.
    const onResult = vi.fn();
    probeDisplayRate({ raf: fakeRaf(1), onResult });
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledWith(null);
  });
});

describe('probeDisplayRate under a hidden tab', () => {
  /** rAF that fires synchronously; `hidden` is read fresh on each call so a case can flip it. */
  function fakeRaf(hz: number, limit = 2000): (cb: (t: number) => void) => void {
    const period = 1000 / hz;
    let t = 1000;
    let calls = 0;
    return (cb: (t: number) => void): void => {
      if (calls++ >= limit) return;
      t += period;
      cb(t);
    };
  }

  it('refuses a sample taken while the page is hidden, even at a plausible rate', () => {
    // The 2026-09-22 finding, as a case. A browser throttles rAF in a hidden tab and not
    // always to the 1 Hz the plausible band already refuses: the reading off a real hidden
    // pane was 30.03 Hz, which every check in this file accepted. `tickerCapFor` then read it
    // as "the display is slower than the target" and returned 0 — the power budget silently
    // off for the whole session. Without the `isHidden` guard this case reports ~30.
    const onResult = vi.fn();
    probeDisplayRate({ raf: fakeRaf(30), isHidden: () => true, onResult });
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledWith(null);
  });

  it('...and the same sample IS believed when the page is visible', () => {
    // The control, and the half that makes the case above mean something: 30 Hz is a legal
    // answer from a real display, and refusing it always would be a different bug.
    const onResult = vi.fn();
    probeDisplayRate({ raf: fakeRaf(30), isHidden: () => false, onResult });
    expect(onResult.mock.calls[0]![0]).toBeCloseTo(30, 6);
  });

  it('starts the sample over when the page becomes visible, rather than giving up', () => {
    // Opening a game in a background tab and switching to it a minute later is an ordinary
    // thing to do. The restart costs nothing while hidden — rAF is not running, so the next
    // callback IS the page coming back — and what it buys is a measured cap instead of the
    // conservative one for that whole visit.
    let hidden = true;
    let seen = 0;
    const raf = fakeRaf(120);
    const onResult = vi.fn();
    probeDisplayRate({
      raf: (cb) => {
        if (++seen === 3) hidden = false; // the tab comes to the front
        raf(cb);
      },
      isHidden: () => hidden,
      onResult,
    });
    expect(onResult).toHaveBeenCalledTimes(1);
    // 120, not something between 120 and whatever the hidden frames looked like: the hidden
    // timestamps were discarded rather than averaged in.
    expect(onResult.mock.calls[0]![0]).toBeCloseTo(120, 6);
  });

  it('gives up on a TIME budget, not on a count of restarts', () => {
    // The distinction is not academic, and getting it wrong is what the first version of this
    // did: a hidden tab does not stop firing rAF, it fires it throttled — 30 Hz off the pane
    // this was found in. A budget counted in restarts is therefore spent in a fraction of a
    // second, and the probe answers `null` while the page is still on its way to the front.
    let calls = 0;
    const raf = fakeRaf(30, 100_000);
    const onResult = vi.fn();
    probeDisplayRate({
      raf: (cb) => { calls++; raf(cb); },
      isHidden: () => true,
      giveUpMs: 5_000,
      onResult,
    });
    expect(onResult).toHaveBeenCalledWith(null);
    expect(onResult).toHaveBeenCalledTimes(1);
    // ~5 s of throttled frames, i.e. it really did keep waiting rather than bailing on the
    // handful a restart count would have allowed.
    expect(calls).toBeGreaterThan(100);
  });

  it('measures a tab brought forward well after boot', () => {
    // The ordinary case the time budget exists for: opened in a background tab, looked at once
    // the page you were reading is done. A restart-counted budget reports `null` here.
    let hidden = true;
    let seen = 0;
    const raf = fakeRaf(60, 100_000);
    const onResult = vi.fn();
    probeDisplayRate({
      raf: (cb) => { if (++seen === 400) hidden = false; raf(cb); },
      isHidden: () => hidden,
      onResult,
    });
    expect(onResult.mock.calls[0]![0]).toBeCloseTo(60, 6);
  });

  it('is not "hidden" in a host that has no document at all', () => {
    // A tool, a sim harness, some WeChat shells. There is no tab to hide, and defaulting to
    // hidden there would mean the probe never answers on those hosts — the conservative cap
    // forever, which is safe and also silently wrong.
    const onResult = vi.fn();
    probeDisplayRate({ raf: fakeRaf(75), onResult }); // no isHidden: takes the default
    expect(onResult.mock.calls[0]![0]).toBeCloseTo(75, 6);
  });
});
