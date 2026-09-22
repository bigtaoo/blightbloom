/**
 * How fast is the display actually refreshing? (2026-09-22)
 *
 * `game/powerBudget.ts` needs this and nothing else does: a frame-rate cap can only be
 * applied evenly if you know what it is being applied against — see `tickerCapFor`, which
 * turns "60 fps" into "no cap" on a 60 Hz panel and into "72" on a 144 Hz one.
 *
 * ## Why rAF and not `screen.refreshRate`
 *
 * There is no such API. The refresh rate is not exposed to a browser at all, by any of the
 * three hosts this client ships to, so the only way to know it is to time the callback the
 * platform pins to vsync. That is `requestAnimationFrame` — and, importantly, it keeps
 * firing at the display rate whether or not Pixi's ticker decides to run a frame, because
 * the cap is applied INSIDE the ticker callback. So this measures the display even while
 * the thing it is measured for is throttling the game.
 *
 * ## Why the median and not the mean
 *
 * A one-second sample of a 60 Hz display contains a few gaps that are not 16.67 ms: a GC
 * pause, a compositor hiccup, the tab losing focus for an instant. The mean folds those in
 * and reports 58 Hz; the median ignores them as long as they are the minority, which they
 * always are on a display that is working at all. The dispersion check below is what
 * notices when they are NOT the minority and refuses to answer instead of answering wrong —
 * which is the whole reason this returns `null` rather than a number with a confidence
 * attached. A caller cannot act on a confidence; it can act on "I do not know".
 *
 * Pure: every input is a number and the browser half is one injected function. No globals,
 * no timers of its own, so the estimator is driven straight from a test.
 */

/** Gaps needed before an estimate is offered at all. ~1/3 second at 60 Hz. */
export const MIN_GAPS = 20;

/**
 * The plausible range, as periods in ms: 24 Hz (the slowest refresh any shipping panel
 * runs at) to 480 Hz (faster than anything sold). Outside it the sample is measuring
 * something else — the classic case being a backgrounded tab, where rAF is throttled to
 * ~1 Hz and would otherwise be reported as a 1 Hz display, which `tickerCapFor` would
 * read as "the display is slower than the target, do not cap".
 */
export const MIN_PERIOD_MS = 1000 / 480;
export const MAX_PERIOD_MS = 1000 / 24;

/** How wide a gap may be, relative to the median, and still count as agreeing with it. */
export const AGREEMENT_TOLERANCE = 0.2;

/** How many gaps must agree before the median is believed. */
export const MIN_AGREEMENT = 0.6;

export interface DisplayRateEstimate {
  /** Refresh rate in Hz — `1000 / median gap`, never rounded to a "nice" number. Rounding
   *  60.02 to 60 would be inventing precision that the caller then makes decisions with. */
  hz: number;
  /** Gaps the estimate was made from. */
  samples: number;
  /** 0..1 — the fraction of those gaps within {@link AGREEMENT_TOLERANCE} of the median. */
  agreement: number;
}

/** Median of a non-empty list. Copies before sorting: the caller's array is not ours. */
function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Estimate the display rate from a series of rAF timestamps, or `null` when the sample does
 * not support one. Every refusal is a real case seen on one of the three hosts:
 *
 * - too few samples — the probe was cut short by a phase change or a slow boot;
 * - a median outside the plausible band — a throttled (hidden) tab, or a fake rAF in a test;
 * - too little agreement — frames arriving at two different rates, which is what a
 *   variable-refresh-rate panel under a heavy load looks like. There is no single number to
 *   report there, and `tickerCapFor`'s "unknown" branch is the correct answer.
 */
export function estimateDisplayHz(timestamps: readonly number[]): DisplayRateEstimate | null {
  const gaps: number[] = [];
  for (let i = 1; i < timestamps.length; i++) {
    const gap = timestamps[i]! - timestamps[i - 1]!;
    // A non-positive gap is not a slow frame, it is a broken clock (or two callbacks in one
    // tick). Dropping it keeps it out of the median instead of dragging the median down.
    if (gap > 0) gaps.push(gap);
  }
  if (gaps.length < MIN_GAPS) return null;

  const mid = median(gaps);
  if (mid < MIN_PERIOD_MS || mid > MAX_PERIOD_MS) return null;

  const agreeing = gaps.filter((g) => Math.abs(g - mid) <= mid * AGREEMENT_TOLERANCE).length;
  const agreement = agreeing / gaps.length;
  if (agreement < MIN_AGREEMENT) return null;

  return { hz: 1000 / mid, samples: gaps.length, agreement };
}

/** Default sampling length. Long enough for {@link MIN_GAPS} at 24 Hz, short enough that
 *  nothing is waiting on it — the caller never awaits this. */
export const PROBE_MS = 1000;

/**
 * How long the probe keeps waiting for the page to be looked at before giving up and answering
 * `null`.
 *
 * A TIME budget and not a count of restarts, and the difference is the whole of it: a hidden
 * tab does not stop firing rAF, it fires it THROTTLED — the reading that started all this was
 * 30 Hz off a hidden pane, not silence. A budget of "five restarts" is therefore spent in a
 * sixth of a second and the probe answers `null` while the page is still on its way to the
 * front, which is a conservative cap for a session that could have had a measured one.
 *
 * A minute is long enough for the ordinary case (open in a background tab, switch over when the
 * page you were reading is done) and bounded so that a tab left behind forever stops costing an
 * array reset per throttled frame.
 */
export const HIDDEN_GIVE_UP_MS = 60_000;

export interface DisplayRateProbeDeps {
  /** The platform's `requestAnimationFrame`, injected. A host without one (some WeChat
   *  shells) simply never measures, which is a supported state and not an error. */
  raf: ((cb: (t: number) => void) => unknown) | undefined;
  /** How long to sample. */
  sampleMs?: number;
  /** How long to keep waiting for a page that is hidden. See {@link HIDDEN_GIVE_UP_MS}. */
  giveUpMs?: number;
  /**
   * Is the page hidden right now? Injected; defaults to `document.visibilityState`.
   *
   * **This is not a refinement, it is the difference between a measurement and a wrong
   * answer** (found 2026-09-22, in a browser, an hour after the rest of this file was
   * written). A browser throttles rAF in a hidden tab — and not always to the 1 Hz the band
   * above refuses. The real reading off a hidden pane was **30.03 Hz**, comfortably inside
   * 24-480, so it was believed; `tickerCapFor` then read "the display is slower than the
   * target" and returned 0 — no cap at all, for the whole session, on BOTH the idle and the
   * play target. The power budget silently off, on a device that never asked for it.
   *
   * Opening a game in a background tab and switching to it a minute later is an ordinary
   * thing to do, so this is an ordinary case rather than a corner one.
   */
  isHidden?: () => boolean;
  /** Called once with the estimate, or with `null` if there is none. */
  onResult: (hz: number | null) => void;
}

/**
 * Sample rAF for {@link PROBE_MS} and report the estimate exactly once.
 *
 * Deliberately fire-and-forget rather than a promise: nothing may wait for it, and a
 * promise is an invitation to `await` one. The frame cap is correct (case 2 of
 * `tickerCapFor`) for as long as this has not answered, so the only cost of it never
 * answering is a cap that stays conservative.
 */
export function probeDisplayRate(deps: DisplayRateProbeDeps): void {
  const raf = deps.raf;
  if (!raf) {
    deps.onResult(null);
    return;
  }
  const sampleMs = deps.sampleMs ?? PROBE_MS;
  const isHidden = deps.isHidden ?? defaultIsHidden;
  const giveUpMs = deps.giveUpMs ?? HIDDEN_GIVE_UP_MS;
  let timestamps: number[] = [];
  let firstSeen: number | null = null;
  const step = (t: number): void => {
    firstSeen ??= t;
    if (isHidden()) {
      // Throw the sample away and start again rather than reporting what a throttled rAF
      // delivers — see `isHidden`. The clock is rAF's own timestamp, which is the only one
      // this module is given; a hidden tab still delivers those, just fewer of them.
      if (t - firstSeen >= giveUpMs) {
        deps.onResult(null);
        return;
      }
      timestamps = [];
      raf(step);
      return;
    }
    timestamps.push(t);
    // The window is measured from the FIRST callback's own timestamp, not from a clock read
    // at install: the two can be a whole frame apart, and the difference is a sample.
    if (t - timestamps[0]! < sampleMs) {
      raf(step);
      return;
    }
    deps.onResult(estimateDisplayHz(timestamps)?.hz ?? null);
  };
  raf(step);
}

/** `document.visibilityState`, where there is a document. A host without one (a test, a tool,
 *  some WeChat shells) is never "hidden" — it has no tab to hide. */
function defaultIsHidden(): boolean {
  const doc = (globalThis as { document?: { visibilityState?: string } }).document;
  return doc?.visibilityState === 'hidden';
}
