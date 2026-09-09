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
 * `ws` and `node:sqlite` are deliberately left EXTERNAL rather than bundled: `ws` ships
 * optional native/WASM fallback bindings resolved by a runtime `require()` esbuild can't
 * see through, and `node:sqlite` is a Node built-in, not something to inline. Both are
 * satisfied by the deploy image's own minimal `package.json` (`server/deploy/package.json`).
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

/** Left out of the bundles; supplied by the deploy image (`ws`) or by Node itself. */
export const external = ['ws', 'node:sqlite'];

/** Matches the Dockerfile's base image — `node:sqlite` is what sets the floor. */
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
