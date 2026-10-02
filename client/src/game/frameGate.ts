// Even frame pacing on every refresh rate (2026-10-01, motion-comfort pass) — the follow-up
// `powerBudget.ts` recorded and did not attempt: taking the render-rate cap away from Pixi's
// own gate.
//
// ## Why Pixi's gate cannot do it
//
// `Ticker.update` compares an elapsed time truncated to whole milliseconds against
// `_minElapsedMS`, and carries the remainder forward. `tickerCapFor` picks the integer that
// survives the truncation, which is enough on a panel whose vsync interval is itself close to a
// whole millisecond (60, 120 Hz). On 90, 100 and 165 Hz it is not, the carried phase drifts, and
// the gate drops a frame every so often: 4-9% of frames last one vsync longer than their
// neighbours, measured in `powerBudget.test.ts`. That is a stutter of the whole screen several
// times a second, which is the thing this project's player reported as making them ill.
//
// ## What replaces it
//
// A gate that counts VSYNCS instead of milliseconds. Every rAF timestamp sits on a vsync, give or
// take noise far under one interval, so "draw on every Nth vsync" is "draw when at least N - 1/2
// intervals have passed since the last drawn frame". Half an interval of margin on each side
// swallows any timestamp jitter, and nothing is carried forward, so nothing can drift.
//
// It is handed the same number Pixi was: `tickerCapFor`'s output, which is always an even
// division of the display rate plus under a millisecond of headroom. `vsyncsPerFrame` recovers the
// division exactly (the `frameGate.test.ts` table covers every rate the cap is
// tested at), so the policy in `powerBudget.ts` does not change and still works unmodified on a
// ticker that has no gate installed. Until the display probe answers, the gate estimates the vsync
// interval itself from the callbacks it is shown, and draws every frame until it has one.

/** The two ticker members this needs (Pixi's `Ticker`, structurally). */
export interface GatedTicker {
  maxFPS: number;
  update(currentTime?: number): void;
}

/** Decides, per rAF callback, whether this one draws a frame. Pure; see the header. */
export class FrameGate {
  /** The cap, in frames per second, as `applyPowerBudget` writes it. 0 = draw every vsync. */
  cap = 0;
  private last = -Infinity;
  /** Every callback the gate is shown, drawn or not — what `vsync` is estimated from. */
  private seen = -Infinity;
  /** Running estimate of the vsync interval (ms), for while the display probe has no answer. */
  private vsync: number | null = null;

  admit(now: number, hz: number | null): boolean {
    this.observe(now - this.seen);
    this.seen = now;
    const vsync = hz !== null ? 1000 / hz : this.vsync;
    if (this.cap > 0 && vsync !== null) {
      const need = (vsyncsPerFrame(1000 / this.cap / vsync) - 0.5) * vsync;
      if (now - this.last < need) return false;
    }
    this.last = now;
    return true;
  }

  /** An average of the callback gaps, ignoring a gap of 1.5 intervals or more (a dropped frame,
   *  a stall) so that one hitch cannot move the vsync count the cap rounds to. */
  private observe(gap: number): void {
    if (!(gap > 1 && gap < 50)) return;
    if (this.vsync === null) this.vsync = gap;
    else if (gap < this.vsync * 1.5) this.vsync += (gap - this.vsync) * 0.1;
  }
}

/**
 * How many vsyncs one frame lasts, given the cap's period in vsyncs. Never FEWER than the cap
 * allows (a cap is a ceiling), and exact for `tickerCapFor`'s output: that is `ceil(N·v) - 1` ms
 * for N vsyncs of `v` ms, i.e. a ratio in `(N - 1/v, N]`, and with `v` over 4/3 ms (any panel
 * under 750 Hz) taking a quarter off before the `ceil` lands on N.
 */
export function vsyncsPerFrame(ratio: number): number {
  return Math.max(1, Math.ceil(ratio - 0.25));
}

/**
 * Put a {@link FrameGate} in front of `ticker`: its `maxFPS` becomes the gate's cap (Pixi's own
 * gate is switched off), and `update` runs only on the frames the gate admits. A skipped frame
 * does not touch the ticker at all, so the next drawn frame's `deltaMS` spans both, as it did
 * under Pixi's gate. `hz` is read every frame, because the display probe answers after boot.
 */
export function installFrameGate(ticker: GatedTicker, hz: () => number | null): FrameGate {
  const gate = new FrameGate();
  gate.cap = ticker.maxFPS;
  ticker.maxFPS = 0;
  const raw = ticker.update.bind(ticker);
  Object.defineProperty(ticker, 'maxFPS', {
    configurable: true,
    get: () => gate.cap,
    set: (fps: number) => {
      gate.cap = fps;
    },
  });
  ticker.update = (now = performance.now()) => {
    if (gate.admit(now, hz())) raw(now);
  };
  return gate;
}
