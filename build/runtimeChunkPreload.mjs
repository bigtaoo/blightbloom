// Preload the renderer chunks Pixi imports at runtime, so they stop arriving one round trip
// AFTER the bundle that asks for them.
//
// ## The measurement this exists for
//
// Resource timing off the live deploy (b.gamestao.com, 2026-09-21), cold load:
//
//   /assets/index-*.js            651 ms → 3170 ms   (287 kB gzipped — the entry chunk)
//   /assets/WebGLRenderer-*.js   3339 ms → 3469 ms
//   /assets/RenderTargetSystem-* 3339 ms → 3444 ms
//   /assets/BufferResource-*.js  3339 ms → 3447 ms
//   /assets/browserAll-*.js      3565 ms → 4730 ms
//   /assets/webworkerAll-*.js    3565 ms → 4842 ms
//
// Nothing starts before 3339 ms because nothing KNOWS about those files before then: Pixi
// reaches its renderer, its texture loader and its worker loader through dynamic `import()`,
// so the browser cannot discover them until the entry chunk has downloaded, parsed and run.
// That is ~1.5 s of serialised round trips on a connection where the bytes themselves are
// ~55 kB — time spent waiting, not transferring, and all of it in front of the first screen.
//
// A `<link rel="modulepreload">` in the HTML head moves that discovery to the first byte of
// the document, so these fetch ALONGSIDE the entry chunk. The later `import()` then resolves
// out of the module map instead of opening a connection. Nothing about the runtime changes;
// Vite already emits exactly these links for statically imported chunks, and this is the same
// mechanism applied to the ones only Pixi knows about.
//
// ## Why a name list rather than "preload every chunk"
//
// Because three of the emitted chunks are for paths this game never takes, and preloading
// them would be a straight 69 kB of waste on the one download that is in front of the player:
// `WebGPURenderer` (WebPlatform pins `preference: 'webgl'` so WeChat and the browser take the
// same path), `CanvasRenderer`, and `BitmapFont` (nothing here loads a bitmap font). The list
// below is the set the live page actually fetched, and nothing else.
//
// ## Why a miss is fatal rather than skipped
//
// A Pixi upgrade that renames or merges these chunks would make every entry match nothing,
// and the optimisation would silently stop existing — the build would still succeed, the game
// would still work, and the only trace would be a slower first screen nobody could attribute.
// So an entry matching no emitted chunk fails the build and says which one. Same reasoning as
// `vite.crazygames.config.js`'s `applied` guard, which exists for the same class of silence.

/** Emitted chunk name prefixes to preload, as they appear before Rollup's `-<hash>.js`. */
export const RUNTIME_CHUNKS = [
  'WebGLRenderer',
  'RenderTargetSystem',
  'BufferResource',
  'browserAll',
  'webworkerAll',
];

/**
 * The `<link rel="modulepreload">` hrefs for `names`, given the emitted bundle's file names.
 *
 * Exported separately from the plugin so the matching and the guard can be tested without
 * running a Vite build — the plugin body around it is three lines of glue.
 *
 * @param {string[]} fileNames every file name in the emitted bundle
 * @param {string} base Vite's `base` ('/' on our own domain, './' on the portal)
 * @param {string[]} names chunk name prefixes
 * @returns {string[]} hrefs, in `names` order
 */
export function preloadHrefs(fileNames, base = '/', names = RUNTIME_CHUNKS) {
  const chunks = fileNames.filter((f) => f.endsWith('.js'));
  /** @type {string[]} */
  const hrefs = [];
  for (const name of names) {
    // Anchored on the BASENAME and on Rollup's `-<hash>` separator, so 'browserAll' cannot be
    // matched by a future 'browserAllSomethingElse' chunk and a directory component cannot
    // match by accident.
    const matches = chunks.filter((f) => (f.split('/').pop() ?? '').startsWith(`${name}-`));
    if (matches.length === 0) {
      throw new Error(
        `runtimeChunkPreload: no emitted chunk named '${name}-*.js'. Pixi's chunk names have ` +
          'changed — update RUNTIME_CHUNKS in build/runtimeChunkPreload.mjs against a real ' +
          'load, or the preload silently stops covering anything.',
      );
    }
    for (const file of matches) hrefs.push(base.endsWith('/') ? `${base}${file}` : `${base}/${file}`);
  }
  return hrefs;
}

/** @param {string[]} [names] @returns {import('vite').Plugin} */
export function runtimeChunkPreload(names = RUNTIME_CHUNKS) {
  let base = '/';
  return {
    name: 'runtime-chunk-preload',
    configResolved(config) {
      base = config.base ?? '/';
    },
    transformIndexHtml: {
      // `post`, and with `ctx.bundle`: the emitted file names only exist once Rollup has
      // hashed them, which is `generateBundle` — the one point in a build where this hook
      // runs. In DEV there is no bundle and no hashing, and the chunks are served on demand
      // from source, so there is nothing to preload and the hook is a no-op.
      order: 'post',
      handler(html, ctx) {
        if (!ctx.bundle) return html;
        const tags = preloadHrefs(Object.keys(ctx.bundle), base, names).map((href) => ({
          tag: 'link',
          // `crossorigin` is not optional: a module script is fetched in CORS mode, and a
          // preload without it is a second, separate request rather than a hit.
          attrs: { rel: 'modulepreload', crossorigin: true, href },
          injectTo: 'head',
        }));
        return { html, tags };
      },
    },
  };
}
