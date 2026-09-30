import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config.js';

// Sibling of vitest.pve-sim.config.ts, same reasoning: `voiceDemand.sim.ts` plays ~230
// headless PvE runs and PvP matches to measure how many sample voices real play asks for
// (design/11 "Voice-count budget"). About a minute, far too slow for the default `npm test`.
// Run it explicitly via `npm run test:voice-sim`; it is folded into `test:sims`.
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      include: ['sim/voiceDemand.sim.ts'],
      testTimeout: 600_000,
      hookTimeout: 600_000,
    },
  }),
);
