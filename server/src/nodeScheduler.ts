/**
 * The production `Scheduler` — Node's own timers, split out of `index.ts` (2026-09-26) so the
 * wiring can be tested with fake timers instead of only through a running gameserver. It is the
 * metronome clock (`setInterval`), the settlement timeout (`setTimeout`, design/15), and the
 * clock a command's landing frame is read from (`now`, 2026-10-03).
 */
import type { Scheduler } from './scheduler';

export const nodeScheduler: Scheduler = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  now: () => performance.now(),
};
