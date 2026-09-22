// build/runtimeChunkPreload.mjs — the `<link rel="modulepreload">` injection that stops
// Pixi's runtime-imported chunks from arriving a round trip after the bundle that needs them.
//
// The two properties worth pinning are the two that fail SILENTLY: a name that matches
// nothing (a Pixi upgrade renames a chunk, every entry misses, the optimisation evaporates
// with a green build), and a name that matches too much (preloading the WebGPU/Canvas
// renderers this game never takes, which is pure waste on the one download in front of the
// player).
import { describe, it, expect } from 'vitest';
import { RUNTIME_CHUNKS, preloadHrefs, runtimeChunkPreload } from './runtimeChunkPreload.mjs';

/** A bundle shaped like a real `vite build` of the client, hashes and all. */
const BUNDLE = [
  'index.html',
  'assets/index-DaotUDpK.js',
  'assets/WebGLRenderer-BdnIsLie.js',
  'assets/RenderTargetSystem-BQhN4wh4.js',
  'assets/BufferResource-CY_fQJEZ.js',
  'assets/browserAll-wP65fZBY.js',
  'assets/webworkerAll-Dv_uLyOb.js',
  'assets/WebGPURenderer-DejgDU__.js',
  'assets/CanvasRenderer-DrjvHyPL.js',
  'assets/BitmapFont-Cm-bhTte.js',
];

describe('preloadHrefs', () => {
  it('names every chunk the live page fetched, and none of the ones it did not', () => {
    // The three excluded ones are 69 kB of renderer this build cannot reach: `WebPlatform`
    // pins `preference: 'webgl'`, and nothing in the client loads a bitmap font.
    expect(preloadHrefs(BUNDLE)).toEqual([
      '/assets/WebGLRenderer-BdnIsLie.js',
      '/assets/RenderTargetSystem-BQhN4wh4.js',
      '/assets/BufferResource-CY_fQJEZ.js',
      '/assets/browserAll-wP65fZBY.js',
      '/assets/webworkerAll-Dv_uLyOb.js',
    ]);
  });

  it('honours the portal build\'s relative base', () => {
    // `vite.crazygames.config.js` sets `base: './'` because the portal serves the upload from
    // a path of its choosing. An absolute href here would 404 there — and only there.
    expect(preloadHrefs(['assets/WebGLRenderer-x.js'], './', ['WebGLRenderer'])).toEqual([
      './assets/WebGLRenderer-x.js',
    ]);
  });

  it('fails the build when a name matches nothing', () => {
    // The whole reason this function throws instead of filtering. Without it, a Pixi upgrade
    // that renames these chunks leaves a build that succeeds, a game that works, and a first
    // screen that is a second and a half slower for reasons no log would name.
    expect(() => preloadHrefs(BUNDLE, '/', ['WebGLRenderer', 'RendererThatMoved'])).toThrow(
      /RendererThatMoved/,
    );
  });

  it('matches on the hash separator, not on a bare prefix', () => {
    // 'browserAll' must not be satisfied by a future 'browserAllExtras' chunk: that would be a
    // match that passes the guard while preloading the wrong file.
    expect(() => preloadHrefs(['assets/browserAllExtras-x.js'], '/', ['browserAll'])).toThrow();
  });

  it('ignores non-JS emissions', () => {
    expect(() => preloadHrefs(['assets/WebGLRenderer-x.css'], '/', ['WebGLRenderer'])).toThrow();
  });
});

describe('runtimeChunkPreload — the plugin around it', () => {
  const handler = (plugin) => plugin.transformIndexHtml.handler;

  it('injects one crossorigin modulepreload link per chunk, into the head', () => {
    const plugin = runtimeChunkPreload(['WebGLRenderer']);
    const bundle = Object.fromEntries(BUNDLE.map((f) => [f, {}]));

    const out = handler(plugin).call(null, '<html></html>', { bundle });

    expect(out.tags).toEqual([
      {
        tag: 'link',
        // Without `crossorigin` the preload is a SECOND request rather than a hit, because a
        // module script is fetched in CORS mode.
        attrs: { rel: 'modulepreload', crossorigin: true, href: '/assets/WebGLRenderer-BdnIsLie.js' },
        injectTo: 'head',
      },
    ]);
  });

  it('is a no-op in dev, where there is no bundle and nothing is hashed yet', () => {
    const out = handler(runtimeChunkPreload()).call(null, '<html></html>', {});
    expect(out).toBe('<html></html>');
  });

  it('keeps its default list in sync with what it exports', () => {
    expect(RUNTIME_CHUNKS).toContain('WebGLRenderer');
    expect(RUNTIME_CHUNKS).not.toContain('WebGPURenderer');
  });
});

describe('the configs that are supposed to be using it', () => {
  // The hole these close: the plugin is correct, tested, and does nothing at all if a config
  // stops listing it. Removing `runtimeChunkPreload()` from a `plugins` array is a one-word
  // edit that breaks no test above, ships a perfectly working game, and quietly puts ~1.5 s of
  // serialised round trips back in front of the first screen. `portalBuild.test.ts` already
  // pins the portal side's plugin list for its own reason; the web build had nobody watching.
  it('is in the web build', async () => {
    const config = (await import('../client/vite.config.js')).default;
    expect(config.plugins.map((p) => p?.name)).toContain('runtime-chunk-preload');
  });

  it('is in the portal build, where it also has to honour the relative base', async () => {
    const config = (await import('../client/vite.crazygames.config.js')).default;
    expect(config.base, 'the portal serves from a path of its choosing').toBe('./');
    expect(config.plugins.map((p) => p?.name)).toContain('runtime-chunk-preload');
  });
});
