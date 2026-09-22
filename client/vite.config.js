import { defineConfig } from 'vite';
import { engineAlias } from '../build/ddAlias.mjs';
import { versionManifestPlugin } from '../build/versionManifestPlugin.mjs';
import { runtimeChunkPreload } from '../build/runtimeChunkPreload.mjs';

export default defineConfig({
  // @dd/engine — deterministic sim core (design/06), a sibling package at the repo root
  // because the server and both tools consume the same source. See build/ddAlias.mjs.
  resolve: { alias: engineAlias },
  // Emits dist/version.json, polled by src/platform/web/autoReload.ts so a tab left open
  // across a deploy reloads itself. public/_headers keeps that file (and index.html)
  // uncached at Cloudflare's edge, without which the poll would read a stale hash.
  //
  // ...and `<link rel="modulepreload">` for the renderer chunks Pixi only reaches through a
  // dynamic import, which the browser therefore cannot discover until the entry chunk has run.
  // Worth ~1.5 s of serialised round trips in front of the first screen — see that file for the
  // measurement.
  plugins: [versionManifestPlugin(), runtimeChunkPreload()],
  server: { port: 5173, host: true },
  build: { target: 'es2020', outDir: 'dist' },
  // Vitest reads this same file — deliberately, so the `@dd/engine` alias above has exactly
  // one definition per package. The sibling project `funny` deleted a second, test-only
  // config for this reason: nothing ran it, its alias list silently drifted behind the real
  // one, and 4 of its 11 files died at load there while the live config ran all 11 green.
  test: {
    coverage: {
      provider: 'v8',
      // `text` for the local run, `json-summary` for build/checkCoverageThreshold.mjs (the
      // 90/90 gate), `html` to read a specific file's misses, `lcov` for any external viewer.
      reporter: ['text', 'json-summary', 'html', 'lcov'],
      reportsDirectory: './coverage',
      // WHOLE-TREE ON PURPOSE, and this is the one line in this block worth defending.
      //
      // `funny`'s client scopes coverage to a hand-written allow-list — `src/game/**` plus
      // ~50 individual files — because its render/UI layer sits at 0-15% and would drown the
      // number. That list is explicitly transitional there, and its own guard test exists
      // because every way it breaks is silent: a stale entry matches nothing, one fewer file
      // is measured, and the percentage goes UP.
      //
      // This client does not need it and must not grow one. Measured 2026-09-03 over
      // `src/**`, before any of this was gated: 96.52% lines (8047/8337), 90.03% branches,
      // across all 217 source files with none missing from the report. The render/scene
      // layer here is testable without a browser (see design/18 and the *Coverage.test.ts
      // sweep idiom) rather than being PIXI-drawing code wall to wall, so the honest scope
      // is the whole tree. `src/coverageScope.test.ts` is what keeps it that way: it fails
      // if this include is ever narrowed to per-file entries — the inverse of funny's guard,
      // because the risk here is a whitelist APPEARING, not one rotting.
      include: ['src/**/*.ts'],
      // A `.md` under src/ (src/perf/README.md) makes the v8 remapper throw a rollup
      // PARSE_ERROR and silently drop the file from the report; matching only .ts avoids it.
      exclude: ['src/**/*.test.ts', 'src/**/*.d.ts'],
    },
  },
});
