// Platform seam for how shipped art is REACHED (design/04, design/12).
//
// The five art loaders (taoBundle / biomeTiles / uiSkins / environmentSprites / weaponSkins)
// used to hardcode two web-only assumptions: that an asset path is also a URL, and that
// `fetch` exists. Neither holds in a WeChat mini-game, and between them they were the whole
// reason the mini-game target rendered Graphics placeholders only.
//
// What each platform actually does:
//
//  - **PNGs need nothing here but a path rewrite.** Pixi v8's `loadTextures` parser falls
//    back to `DOMAdapter.get().createImage()` + `.src = url` whenever `globalThis
//    .createImageBitmap` is absent (see pixi.js/lib/assets/loader/parsers/textures/
//    loadTextures.mjs), which is exactly the WeChat case — and `WeChatAdapter.createImage`
//    (→ `wx.createImage()`) has been implemented all along. So the image path was never
//    blocked on `WeChatAdapter.fetch` at all, contrary to what design/ROADMAP's parked note
//    assumed. It only needed the URL to name a real file inside the package.
//  - **The JSON sidecars are the part that genuinely could not work.** `taoBundle` called
//    the GLOBAL `fetch`, which a mini-game does not have at all, and Pixi's own `loadJson`
//    goes through the adapter's `fetch`, which we deliberately keep unimplemented. WeChat
//    reads files bundled in the code package with `FileSystemManager.readFileSync` instead —
//    a different MECHANISM, not just a different path, which is why `readJson` is part of
//    this interface rather than something callers build out of `resolveUrl`.
//
// The default host is the web one, so nothing that does not opt in changes behaviour (and
// every existing test keeps passing untouched). `main.wechat.ts` installs the WeChat host
// before its first preload.
/** The subset of Pixi's `AssetInitOptions` this seam sets. Declared structurally so the
 *  interface does not drag a Pixi type into every consumer. */
export interface AssetsInitOptions {
  skipDetections?: boolean;
}

export interface AssetHost {
  /** Options for the one-time `Assets.init()` that `preloadCoreArt` runs before the first
   *  load. This is a platform difference with teeth, not a tuning knob: Pixi's default
   *  format detection calls `document.createElement('video')`
   *  (assets/detections/utils/testVideoFormat.mjs, reached from detectMp4/detectOgv/
   *  detectWebm), and a mini-game has no `document`. Left alone it throws
   *  `ReferenceError: document is not defined` inside `init()` — and because `Assets`
   *  sets its `_initialized` flag BEFORE running the detections, every other concurrent
   *  load sails past it. The symptom on device is therefore not a clean crash but ONE
   *  arbitrary texture missing, whichever load happened to be first. Found by
   *  wechatAssetLoad.test.ts on its first run, before any device saw it. */
  assetsInit: AssetsInitOptions;
  /** Rewrite a public-relative asset path ('/skins/orb-core/eye.png') into whatever this
   *  platform's image loader takes. */
  resolveUrl(path: string): string;
  /** Read and parse a JSON sidecar shipped alongside the art. */
  readJson<T>(path: string): Promise<T>;
  /** Read a shipped file as raw bytes. Added for audio (design/11's SFX set is mp3, which
   *  `decodeAudioData` takes as an ArrayBuffer), and it is the same platform split the JSON
   *  sidecars already have: a `fetch` on web, `FileSystemManager.readFileSync` with no
   *  encoding on WeChat. Putting it here rather than in the audio module is what lets audio
   *  inherit design/12's bundle rules — a music subpackage becomes a prefix rule in
   *  assetPacks.json, with no loader change. */
  readBinary(path: string): Promise<ArrayBuffer>;
  /** Make a subpackage's files reachable. Absent on web, where there are no subpackages and
   *  every file is simply served; on WeChat this is `wx.loadSubpackage`, and until it has
   *  resolved a path inside that pack's root names nothing. See `packLoader.ts`. */
  loadPack?(name: string, root: string): Promise<void>;
}

export const webAssetHost: AssetHost = {
  // Web keeps the detections: they are what let a webp/avif variant win where the browser
  // supports it, and every DOM probe they make is available here.
  assetsInit: {},
  resolveUrl: (path) => path,
  readJson: async <T>(path: string): Promise<T> => (await fetch(path)).json() as Promise<T>,
  readBinary: async (path: string): Promise<ArrayBuffer> => (await fetch(path)).arrayBuffer(),
};

/**
 * The web host, but with every asset path rewritten against a base — the form a build needs
 * when it does not own the root of the URL it is served from.
 *
 * A game portal serves an uploaded bundle from a path it chooses
 * (`docs.crazygames.com/requirements/technical`: "use only relative paths when referring to
 * other files in the game bundle... avoid absolute paths as they fail to load"). Vite's
 * `base` handles the paths IT writes — the script tag, the hashed chunks — and handles
 * nothing at all about the paths in this repository's own source, which are absolute by
 * convention (`'/skins/orb-core/eye.png'`) and are the majority of the bytes.
 *
 * `base` is Vite's own `import.meta.env.BASE_URL`, passed in rather than read here so this
 * is testable with no bundler in the picture. Two shapes matter:
 *
 *   `'/'`   the root-hosted build (`b.gamestao.com`). Identity — byte-for-byte the
 *           behaviour of `webAssetHost`, which is what makes this safe to share.
 *   `'./'`  the portal build. Produces a DOCUMENT-relative path with no `./` prefix
 *           (`'skins/orb-core/eye.png'`), which resolves against the served directory.
 *
 * The missing `./` is not cosmetic. `platform/web/webMusicDeck.ts` decides whether a deck
 * already holds the file it is being pointed at with `el.src.endsWith(url)` — `el.src` reads
 * back absolute, so a `'./'` prefix would never match, and every loop wrap would re-assign
 * `src` and restart the download of a multi-megabyte track. A bare relative path resolves
 * identically and still matches the suffix test.
 */
export function baseAssetHost(base: string): AssetHost {
  // A leading './' would survive into every path and break the suffix test described above.
  const prefix = base.replace(/^\.\//, '');
  const rewrite = (path: string): string => prefix + path.replace(/^\//, '');
  return {
    assetsInit: webAssetHost.assetsInit,
    resolveUrl: rewrite,
    readJson: async <T>(path: string): Promise<T> => (await fetch(rewrite(path))).json() as Promise<T>,
    readBinary: async (path: string): Promise<ArrayBuffer> => (await fetch(rewrite(path))).arrayBuffer(),
  };
}

let host: AssetHost = webAssetHost;

export function setAssetHost(next: AssetHost): void {
  host = next;
}

export function getAssetHost(): AssetHost {
  return host;
}

/** Restores the web default. Exported for tests, which must not leak a fake host into the
 *  next file's module registry. */
export function resetAssetHost(): void {
  host = webAssetHost;
}

export function resolveAssetUrl(path: string): string {
  return host.resolveUrl(path);
}

export function readJsonAsset<T>(path: string): Promise<T> {
  return host.readJson<T>(path);
}

export function readBinaryAsset(path: string): Promise<ArrayBuffer> {
  return host.readBinary(path);
}
