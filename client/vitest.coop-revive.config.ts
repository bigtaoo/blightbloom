import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config.js';

// Sibling of vitest.pvp-revive.config.ts: `coopRevive.sim.ts` plays full co-op level runs with
// the shipped ally and a bot leader, to measure what the ally's revive buys (2026-10-03). Too
// slow for the default `npm test`. Run it explicitly via `npm run test:coop-revive`; it is folded
// into `test:sims`.
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      include: ['sim/coopRevive.sim.ts'],
      testTimeout: 900_000,
      hookTimeout: 900_000,
    },
  }),
);
