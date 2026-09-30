import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config.js';

// Sibling of vitest.pvp-capacity.config.ts: `pvpRevive.sim.ts` plays eight-seat arena matches
// with a bot that revives a downed squadmate, to measure the channel, the bleedout and the
// bandage supply (volume 118). Minutes, far too slow for the default `npm test`. Run it
// explicitly via `npm run test:pvp-revive`; it is folded into `test:sims`.
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      include: ['sim/pvpRevive.sim.ts'],
      testTimeout: 900_000,
      hookTimeout: 900_000,
    },
  }),
);
