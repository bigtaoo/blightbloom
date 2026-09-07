import { defineConfig } from 'vite';
import { engineAlias } from '../build/ddAlias.mjs';

// The CrazyGames build. `npm run build:crazygames` → `client/dist-crazygames/`, which is the
// directory to zip and upload. `npm run dev:crazygames` runs the same shape on the dev server.
//
// It differs from `vite.config.js` (our own domain, `b.gamestao.com`) in exactly three ways,
// and every one of them is a documented requirement of the host rather than a preference:
//
//  1. `base: './'` — the portal serves the upload from a path of its choosing, and its
//     technical requirements say "use only relative paths when referring to other files in
//     the game bundle... avoid absolute paths as they fail to load". This fixes the paths
//     VITE writes (the script tag, the hashed chunks, any CSS url()). It does NOT fix the
//     paths this repository's own source contains — those are absolute by convention
//     (`'/skins/orb-core/eye.png'`) and are the bulk of the bytes; `main.crazygames.ts`
//     installs `baseAssetHost(import.meta.env.BASE_URL)` for those. Both halves are needed
//     and neither covers the other.
//  2. A different entry module — `src/main.crazygames.ts` instead of `src/main.ts`.
//  3. The SDK `<script>` in `<head>`, ahead of the entry module (it installs
//     `window.CrazyGames` synchronously, and `CrazyGamesSdk.init` polls for it).
//
// (2) and (3) are done by rewriting `index.html` at build time rather than by keeping a
// second copy of it. A second copy is the more obvious approach and is the wrong one here:
// the boot splash, the touch-suppression CSS and the viewport meta are all real, all
// load-bearing, and a divergence between two copies of them would be invisible until it
// showed up on the target this repository cannot test. One file, one rewrite.
//
// ## Why the rewrite is on TWO hooks
//
// Because Vite reaches `index.html` by two different routes and only one of them is
// `transformIndexHtml`:
//
//   dev     the file is served through `transformIndexHtml` untouched, so a `pre`-ordered
//           hook there sees the original `/src/main.ts`.
//   build   `vite:build-html` parses the HTML in its own `transform` and has ALREADY
//           replaced the entry's `src` with the emitted chunk by the time
//           `applyHtmlTransforms` runs at `generateBundle`. A `transformIndexHtml` hook is
//           therefore too late to swap the entry — which is not a subtle failure: the first
//           attempt at this config threw its own "no longer references /src/main.ts" guard
//           during `rendering chunks`, and that guard is the only reason it was not a
//           silently mis-built bundle.
//
// So the rewrite lives in a plugin `transform` (which does run on the HTML module in build,
// ahead of `vite:build-html` because of `enforce: 'pre'`) AND in `transformIndexHtml` (for
// dev). `rewrite` is idempotent so being called twice is free, and `applied` records that it
// happened at least once so a Vite change that routes around both hooks fails the build
// rather than shipping an unintegrated game.
// The backend this build talks to, and why it is set HERE rather than left to CI.
//
// `client/src/game/runState.ts` reads `VITE_MATCHSVC_URL` and falls back to
// `http://localhost:8788`, which is right for `npm run dev` and is the one default that can
// never be right for an uploaded bundle: a portal page has no localhost to reach, so co-op,
// PvP, the ladder and accounts would all silently fail to connect on a build that looked
// completely fine locally. The Cloudflare build gets the value injected by
// `.github/workflows/client-deploy.yml` from a repo variable; this target has no workflow,
// because the artefact is a zip a human uploads.
//
// So the portal build defaults to the deployed backend and still honours an explicit
// override (`VITE_MATCHSVC_URL=... npm run build:crazygames`) for pointing a test upload at
// something else. `??=` rather than `=` is what keeps that override working.
process.env.VITE_MATCHSVC_URL ??= 'https://bb.gamestao.com';

const SDK_TAG = '<script src="https://sdk.crazygames.com/crazygames-sdk-v2.js"></script>';
const DEFAULT_ENTRY = '/src/main.ts';
const PORTAL_ENTRY = '/src/main.crazygames.ts';

/** Swap the entry module and inject the SDK script. Idempotent in both halves. */
export function rewritePortalHtml(html) {
  let out = html;
  if (out.includes(DEFAULT_ENTRY)) out = out.replace(DEFAULT_ENTRY, PORTAL_ENTRY);
  if (!out.includes('sdk.crazygames.com')) {
    out = out.replace('</head>', `    ${SDK_TAG}\n  </head>`);
  }
  return out;
}

// Exported as a FACTORY, and the export exists for the test: the guard below is per-build
// state, so asserting "a build with no rewrite fails" needs a fresh instance rather than the
// one this file already handed to `defineConfig`.
export const portalHtml = () => {
  let applied = false;
  const apply = (html) => {
    const out = rewritePortalHtml(html);
    if (out.includes(PORTAL_ENTRY) && out.includes('sdk.crazygames.com')) applied = true;
    return out;
  };
  return {
    name: 'crazygames-html',
    enforce: 'pre',
    transform(code, id) {
      if (!id.endsWith('.html')) return null;
      return apply(code);
    },
    transformIndexHtml(html) {
      return apply(html);
    },
    closeBundle() {
      // A silent no-op would ship a build with none of the portal integration in it — the
      // right entry module missing, the SDK absent — which looks entirely normal and fails
      // review for reasons no log would name.
      if (!applied) {
        throw new Error(
          'vite.crazygames.config.js: index.html was never rewritten — it no longer references ' +
            `${DEFAULT_ENTRY}, or Vite stopped routing the HTML through transform/transformIndexHtml`,
        );
      }
    },
  };
};

export default defineConfig({
  base: './',
  resolve: { alias: engineAlias },
  plugins: [portalHtml()],
  // No `versionManifestPlugin` — the auto-reload it feeds is deliberately absent from this
  // target (see `main.crazygames.ts` note 4), so emitting the manifest would ship a file
  // nothing reads.
  build: { target: 'es2020', outDir: 'dist-crazygames', emptyOutDir: true },
});
