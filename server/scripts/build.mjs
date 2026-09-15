/**
 * Deploy build (design/19-server-platform.md, ROADMAP 9). Bundles the five process
 * entrypoints into self-contained ESM files under `server/dist/`, resolving the
 * `@dd/engine` / `@dd/game/*` / `@dd/net/*` workspace aliases (../tsconfig.base.json)
 * at BUILD time instead of at runtime.
 *
 * Why this exists at all: the server imports live TypeScript from sibling workspaces
 * (`engine/`, `client/src/game/*`, `client/src/net/*`) via tsconfig path aliases, not
 * published packages — fine for local dev (`tsx` resolves the same paths), but it means
 * running the server anywhere else would otherwise require shipping the whole monorepo
 * plus a full `npm ci` at the repo root. Bundling collapses that graph into one file per
 * entrypoint, so a deploy target needs nothing but Node + the `ws` runtime dependency
 * (kept external — see below) and three flat .mjs files.
 *
 * `ws` and `mongodb` are deliberately left EXTERNAL rather than bundled. `ws` ships
 * optional native/WASM fallback bindings resolved by a runtime `require()` esbuild can't
 * see through; `mongodb` is the same failure for the same reason, and it is not a
 * theoretical one — bundled, the driver's `require('timers/promises')` becomes a DYNAMIC
 * require in ESM output and every service dies at boot with "Dynamic require of
 * 'timers/promises' is not supported", after the build has succeeded. It carries optional
 * native dependencies (`kerberos`, `mongodb-client-encryption`, `@mongodb-js/zstd`,
 * `snappy`) resolved the same unseeable way. Both are satisfied by the deploy image's own
 * minimal `package.json` (`server/deploy/package.json`).
 *
 * `node:sqlite` was here until 2026-09-15 and is not any more, because no source file
 * imports it: the four stores are logical databases on the cluster. It was only ever listed
 * to keep a Node BUILT-IN from being inlined, so removing it is the fact that the port is
 * complete rather than a change in policy.
 *
 * `test/deploy.bundle.test.ts` is what caught the mongodb case: it BOOTS each bundle as a
 * bare node process, which is the only layer where "the build passed" and "the service
 * runs" are different questions.
 *
 * The build parameters below are EXPORTED, and `buildAll` takes its output directory as an
 * argument, so `test/deploy.manifests.test.ts` can assert the Dockerfile / compose file /
 * deploy package.json against the real values instead of re-typing them, and
 * `test/deploy.bundle.test.ts` can build into a scratch directory and actually boot the
 * result. Running this file directly still builds into `server/dist` exactly as before.
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
export const serverRoot = join(here, '..');
export const defaultOutdir = join(serverRoot, 'dist');

/** Left out of the bundles; supplied by the deploy image. */
export const external = ['ws', 'mongodb'];

/** Matches the Dockerfile's base image. `node:sqlite` used to set this floor; the driver
 *  and `node:test`-free tooling both run comfortably below it, so it is now just the image
 *  the Dockerfile pins and the two are asserted against each other rather than derived. */
export const target = 'node22';

/** One bundle per process. `out` is the bare basename docker-compose.yml's `command:` runs.
 *  `backup` is the one that is not an HTTP server — it runs a loop, and the same bundle
 *  answers compose's healthcheck when invoked as `node backup.mjs --health`. */
export const entries = [
  { in: join(serverRoot, 'src/index.ts'), out: 'index' },
  { in: join(serverRoot, 'src/matchsvc.ts'), out: 'matchsvc' },
  { in: join(serverRoot, 'src/billsvc/main.ts'), out: 'billsvc' },
  { in: join(serverRoot, 'src/backup/main.ts'), out: 'backup' },
  // The ops console (design/21 §3.4). A fifth entry rather than routes on matchsvc, and a
  // fifth BUNDLE rather than a fifth deploy target: it serves its own page from its own
  // origin, so there is no static asset to publish anywhere and no CORS story.
  { in: join(serverRoot, 'src/adminsvc/main.ts'), out: 'adminsvc' },
];

export async function buildAll(outdir = defaultOutdir, logLevel = 'info') {
  const tsconfig = join(serverRoot, 'tsconfig.json');
  for (const entry of entries) {
    await build({
      entryPoints: [entry.in],
      outfile: join(outdir, `${entry.out}.mjs`),
      bundle: true,
      platform: 'node',
      format: 'esm',
      target,
      tsconfig,
      external,
      logLevel,
    });
  }
  return entries.map((e) => join(outdir, `${e.out}.mjs`));
}

// Only build when run directly (`npm run build -w server`), not when imported by a test —
// the same ESM `require.main === module` guard src/index.ts and src/matchsvc.ts use.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await buildAll();
}
