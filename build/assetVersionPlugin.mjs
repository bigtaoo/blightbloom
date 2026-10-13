import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

// Content-hash every shipped public/ file into the build, so a re-exported image reaches a
// returning player on the visit it ships with rather than the one after (2026-10-12).
//
// The art is not content-hashed by name — `/biome/floor_fire.jpg` keeps its filename across a
// regrade — and `public/_headers` gives it an hour of freshness plus a week of
// `stale-while-revalidate`. That trade is right for presentation-only bytes that do not change
// meaning between deploys, and it went wrong the first time art and code changed TOGETHER: the
// 2026-10-12 floor regrade (median 172 -> 105) shipped alongside a 1.6x larger slab density,
// and a returning player got the new density over the old, bright floor — a frame brighter and
// coarser than either version was ever meant to look.
//
// So the build defines `__DD_ASSET_VERSIONS__`, a map from public path ('/biome/floor_fire.jpg')
// to the first 10 hex of its sha256, and `render/assetHost.ts` appends `?v=<hash>` to every URL
// it resolves on web. A changed file is a new URL — a cache miss at the browser and at the
// edge — and an unchanged one keeps its URL and its cache. The `_headers` policy stays as it
// is; it now only ever serves the bytes the URL names.
//
// Build-only on purpose: the dev server serves public/ uncached anyway, and vitest gets no
// define, so every existing test sees the bare, unversioned paths it was written against. The
// WeChat build does not use this plugin at all — its "URLs" are file paths inside the code
// package, which has no HTTP cache to defeat and no query string to parse.

/** Hex digits kept per file. 40 bits is far past collision range for a few hundred files. */
export const VERSION_LENGTH = 10;

/**
 * `{ '/rel/path': hash }` for every file under `dir`. Content, not name+size like
 * versionManifestPlugin: a regrade can keep a JPEG's byte count by chance, and here a missed
 * change is exactly the bug being fixed.
 *
 * @param {string} dir
 * @returns {Record<string, string>}
 */
export function hashPublicDir(dir) {
  /** @type {Record<string, string>} */
  const out = {};
  /** @param {string} current @param {string} prefix */
  function walk(current, prefix) {
    for (const dirent of readdirSync(current, { withFileTypes: true })) {
      const rel = `${prefix}/${dirent.name}`;
      const abs = path.join(current, dirent.name);
      if (dirent.isDirectory()) walk(abs, rel);
      else out[rel] = createHash('sha256').update(readFileSync(abs)).digest('hex').slice(0, VERSION_LENGTH);
    }
  }
  walk(dir, '');
  return out;
}

/**
 * @param {{ publicDir?: string }} [options] Defaults to `<root>/public`, Vite's own default.
 * @returns {import('vite').Plugin}
 */
export function assetVersionPlugin(options = {}) {
  return {
    name: 'dd-asset-version',
    apply: 'build',
    config(config) {
      const root = config.root ?? process.cwd();
      const dir = options.publicDir ?? path.resolve(root, 'public');
      return { define: { __DD_ASSET_VERSIONS__: JSON.stringify(hashPublicDir(dir)) } };
    },
  };
}
