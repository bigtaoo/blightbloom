import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config.js';

// Sibling of vitest.pvp-sim.config.ts, same reasoning: `pveLevelSim.sim.ts` plays
// real, full-length level-1 runs (5 floors, a bot at two skill profiles, several
// seeds each) to produce PvE difficulty-tuning data — a genuine repeatable check,
// but minutes of simulated game time per run, far too slow to tax every default
// `npm test`. Run it explicitly via `npm run test:pve-sim`. `chapterSim.sim.ts` (2026-10-06)
// is its chapter-2-vs-chapter-1 sibling: full runs, per-floor trials and boss trials.
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      include: ['sim/pveLevelSim.sim.ts', 'sim/chapterSim.sim.ts', 'sim/endlessSim.sim.ts'],
      testTimeout: 600_000,
      hookTimeout: 600_000,
    },
  }),
);
