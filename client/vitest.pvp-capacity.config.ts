import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config.js';

// Sibling of vitest.pvp-sim.config.ts: `pvpCapacity.sim.ts` plays headless arena matches with
// a bot that loots, swaps and parries, to measure how often a seat's energy bar runs dry
// (design/03 "What the sim can and cannot see"). Minutes, far too slow for the default
// `npm test`. Run it explicitly via `npm run test:pvp-capacity`; it is folded into `test:sims`.
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      include: ['sim/pvpCapacity.sim.ts'],
      testTimeout: 900_000,
      hookTimeout: 900_000,
    },
  }),
);
