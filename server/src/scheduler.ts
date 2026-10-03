/**
 * The clocks `MatchRoom` runs on, split out of `MatchRoom.ts` (2026-10-03) and re-exported
 * from it: the metronome, the settlement timeout, and the clock a command's landing frame is
 * read from. Injected so tests can drive all three by hand (no real timers); the production
 * one is `nodeScheduler`.
 */
export interface Scheduler {
  setInterval(fn: () => void, ms: number): IntervalHandle;
  clearInterval(handle: IntervalHandle): void;
  setTimeout(fn: () => void, ms: number): IntervalHandle;
  clearTimeout(handle: IntervalHandle): void;
  /** A monotonic ms clock, for where in the window a command arrived (`WindowClock`). */
  now?(): number;
}
export type IntervalHandle = unknown;
