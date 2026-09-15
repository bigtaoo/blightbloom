import { defineConfig } from 'vitest/config';
// @ts-expect-error — plain .mjs helper, shared with every other vite/vitest config here.
import { serverAlias } from '../build/ddAlias.mjs';

// The server consumes @dd/engine from the sibling engine package's source (design/06
// "server via workspace dependency; same bytes on both sides"), plus @dd/net and @dd/game
// for the PvP bot-fill runner (server/src/BotClient.ts): the client's CoopSession +
// Transport contract and the shared pvpConfig/PvpBotController are source, not a published
// package. tsconfig.base.json's `paths` is the type-side mirror of this same map.
export default defineConfig({
  resolve: { alias: serverAlias },
  test: {
    // One mongod for the whole run (test/mongoGlobalSetup.ts). Every store test talks to a
    // real server rather than a fake, which is what catches the places MongoDB's semantics
    // differ from the node:sqlite ones this server was built on.
    globalSetup: ['./test/mongoGlobalSetup.ts'],
    // Per-file: closes the client `freshAccounts()` shares, so a worker cannot hang on an
    // open socket. See test/mongoSetup.ts.
    setupFiles: ['./test/mongoSetup.ts'],
    // The replica set comes up once, but a cold CI machine downloads the binary first.
    testTimeout: 20_000,
    hookTimeout: 30_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html', 'lcov'],
      reportsDirectory: './coverage',
      // Whole-tree, same reasoning as the other two packages. Note the tests live in
      // `test/`, not beside the sources, so `src/**` is already exactly the shipped code.
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts'],
    },
  },
});
