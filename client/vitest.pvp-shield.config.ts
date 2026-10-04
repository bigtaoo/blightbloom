import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config.js';

// `pvpShieldRetreat.sim.ts` (volume 128): the PvP matches played with a bot that backs off to
// refill its shield, against the shipped one. An instrument for one question, so it is not in
// `test:sims`. Run it via `npm run test:pvp-shield`.
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      include: ['sim/pvpShieldRetreat.sim.ts'],
      testTimeout: 3_600_000,
    },
  }),
);
