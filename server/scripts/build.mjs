/**
 * Deploy build (design/19-server-platform.md, ROADMAP 9). Bundles the three process
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
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const serverRoot = join(here, '..');
const tsconfig = join(serverRoot, 'tsconfig.json');
const outdir = join(serverRoot, 'dist');

const entries = [
  { in: join(serverRoot, 'src/index.ts'), out: 'index' },
  { in: join(serverRoot, 'src/matchsvc.ts'), out: 'matchsvc' },
  { in: join(serverRoot, 'src/billsvc/main.ts'), out: 'billsvc' },
];

for (const entry of entries) {
  await build({
    entryPoints: [entry.in],
    outfile: join(outdir, `${entry.out}.mjs`),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    tsconfig,
    external: ['ws', 'node:sqlite'],
    logLevel: 'info',
  });
}
