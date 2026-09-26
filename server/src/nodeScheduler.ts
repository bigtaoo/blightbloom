/**
 * The production `Scheduler` — Node's own timers, split out of `index.ts` (2026-09-26) so the
 * wiring can be tested with fake timers instead of only through a running gameserver. It is the
 * metronome clock (`setInterval`) and the settlement timeout (`setTimeout`, design/15).
 */
import type { Scheduler } from './MatchRoom';

export const nodeScheduler: Scheduler = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};
