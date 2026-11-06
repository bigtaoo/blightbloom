// The Playgama build: `npm run build:playgama` -> `dist-playgama/`, zipped and uploaded to the
// Playgama developer console (design/22 §4's first closed test).
//
// Modeled on `vite.crazygames.config.js`, with three differences, each a rule of that host:
//  - The Bridge `<script>` goes in front of the entry module, synchronously, because the entry
//    awaits `bridge.initialize()` before anything else (the Bridge docs' required step 1).
//  - `playgama-bridge-config.json` ships next to `index.html`: Bridge reads it at initialize,
//    and it is where the interstitial cooldown lives instead of a timer of ours.
//  - No backend at all. The sandbox frame's CSP admits only Playgama's origins, so there is no
//    `VITE_MATCHSVC_URL`, no `pageOpenBeacon` (its inline `fetch` would be a refused request in
//    the console on every load), and analytics go through Bridge (`main.playgama.ts`).
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { engineAlias } from '../build/ddAlias.mjs';
import { runtimeChunkPreload } from '../build/runtimeChunkPreload.mjs';
import { assetVersionPlugin } from '../build/assetVersionPlugin.mjs';

const SDK_TAG = '<script src="https://bridge.playgama.com/v2/stable/playgama-bridge.js"></script>';
const DEFAULT_ENTRY = '/src/main.ts';
const PORTAL_ENTRY = '/src/main.playgama.ts';
const CONFIG_FILE = 'playgama-bridge-config.json';

/** Bridge's own settings. The cooldown is Bridge's to enforce: a `showInterstitial` inside it
 *  fails at once, so the game asks at every run end and never keeps a clock of its own. */
export const BRIDGE_CONFIG = { advertisement: { minimumDelayBetweenInterstitial: 60 } };

/** Files `public/` carries for our own domain that have no place in the upload: the
 *  Cloudflare headers file, and the policy pages a player there cannot be linked to
 *  (`canLinkOut`), which Playgama's own pages replace. */
export const DROPPED_FILES = ['_headers', 'privacy.html', 'terms.html'];

/** Swap the entry module and make the Bridge script the first thing in `<head>`, where the
 *  Bridge docs ask for it (Vite hoists the entry module into `<head>`, so "in front of the
 *  entry" is not enough). Idempotent in both halves. */
export function rewritePlaygamaHtml(html) {
  let out = html;
  if (out.includes(DEFAULT_ENTRY)) out = out.replace(DEFAULT_ENTRY, PORTAL_ENTRY);
  if (!out.includes('bridge.playgama.com')) out = out.replace('<head>', `<head>\n    ${SDK_TAG}`);
  return out;
}

export const playgamaHtml = () => {
  let applied = false;
  let outDir = '';
  const apply = (html) => {
    const out = rewritePlaygamaHtml(html);
    if (out.includes(PORTAL_ENTRY) && out.includes('bridge.playgama.com')) applied = true;
    return out;
  };
  const config = JSON.stringify(BRIDGE_CONFIG, null, 2);
  return {
    name: 'playgama-html',
    enforce: 'pre',
    transform(code, id) {
      if (!id.endsWith('.html')) return null;
      return apply(code);
    },
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    transformIndexHtml(html) {
      return apply(html);
    },
    // The dev server has no `dist`, so it serves the config itself.
    configureServer(server) {
      server.middlewares.use(`/${CONFIG_FILE}`, (_req, res) => {
        res.setHeader('content-type', 'application/json');
        res.end(config);
      });
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: CONFIG_FILE, source: config });
    },
    closeBundle() {
      for (const f of DROPPED_FILES) rmSync(resolve(outDir, f), { force: true });
      if (!applied) {
        throw new Error(
          'vite.playgama.config.js: index.html was never rewritten — it no longer references ' +
            `${DEFAULT_ENTRY}, or Vite stopped routing the HTML through transform/transformIndexHtml`,
        );
      }
    },
  };
};

export default defineConfig({
  base: './',
  resolve: { alias: engineAlias },
  plugins: [
    playgamaHtml(),
    runtimeChunkPreload(),
    assetVersionPlugin({ publicDir: fileURLToPath(new URL('./public', import.meta.url)) }),
  ],
  build: { target: 'es2020', outDir: 'dist-playgama', emptyOutDir: true },
});
