/**
 * `assetHost` — the platform seam every shipped asset is reached through, and specifically
 * `baseAssetHost`, the rewrite that makes a build servable from a path it does not own.
 *
 * This is the whole of the "use only relative paths" requirement on the runtime side. Vite's
 * `base` handles the paths Vite writes; this handles the ~200 absolute paths that are
 * written in this repository's own source (`'/skins/orb-core/eye.png'`) and that account for
 * nearly all of the bytes. Getting it wrong does not fail loudly — it fails as a game whose
 * every texture 404s while the code runs fine, which is exactly the shape a unit test is
 * worth more than a look at a browser.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  baseAssetHost,
  getAssetHost,
  readBinaryAsset,
  readJsonAsset,
  resetAssetHost,
  resolveAssetUrl,
  setAssetHost,
  webAssetHost,
} from './assetHost';

afterEach(() => {
  resetAssetHost();
  vi.unstubAllGlobals();
});

describe('the default host', () => {
  it('is the web one, and the web one is the identity', () => {
    // Nothing that fails to opt in changes behaviour — the property that lets this seam
    // exist at all without every other target having to know about it.
    expect(getAssetHost()).toBe(webAssetHost);
    expect(resolveAssetUrl('/skins/orb-core/eye.png')).toBe('/skins/orb-core/eye.png');
  });
});

describe('baseAssetHost', () => {
  it('is the identity at the site root', () => {
    // `base: '/'` is the shipped `b.gamestao.com` build. This host has to be byte-for-byte
    // the old behaviour there, or sharing it between the two targets would be a risk rather
    // than a simplification.
    const host = baseAssetHost('/');
    for (const p of ['/skins/orb-core/eye.png', '/audio/music/lobby.mp3', '/ui/icon_play.png']) {
      expect(host.resolveUrl(p)).toBe(p);
    }
  });

  it('produces a document-relative path under a portal base', () => {
    expect(baseAssetHost('./').resolveUrl('/skins/orb-core/eye.png')).toBe('skins/orb-core/eye.png');
  });

  it('does NOT leave a "./" prefix on the result', () => {
    // The one non-obvious rule, and it is a real bug rather than a style preference:
    // `platform/web/webMusicDeck.ts` decides whether a deck already holds the file it is
    // being pointed at with `el.src.endsWith(url)`, and `el.src` reads back ABSOLUTE. A
    // './' prefix never matches that suffix test, so every loop wrap would re-assign `src`
    // and restart the download of a multi-megabyte music track. A bare relative path
    // resolves identically and still matches.
    const url = baseAssetHost('./').resolveUrl('/audio/music/lobby.mp3');
    expect(url.startsWith('./')).toBe(false);
    expect(`https://games.example.com/blightbloom/${url}`.endsWith(url)).toBe(true);
  });

  it('handles a real sub-path base', () => {
    // Not used by any current target, but it is what `import.meta.env.BASE_URL` would hand
    // over if the upload were ever served from a fixed prefix, and the arithmetic is the
    // same one that must not double the slash.
    expect(baseAssetHost('/games/blightbloom/').resolveUrl('/ui/icon_play.png'))
      .toBe('/games/blightbloom/ui/icon_play.png');
  });

  it('rewrites the JSON and binary readers too, not just image URLs', () => {
    // The rig sidecars go through `readJson` and the SFX set through `readBinary`; a rewrite
    // applied only to `resolveUrl` would leave every `.tao` bundle and every sound 404ing
    // while the textures loaded fine — a half-working build, which is the worst outcome to
    // debug.
    const fetched: string[] = [];
    vi.stubGlobal('fetch', (url: string) => {
      fetched.push(url);
      return Promise.resolve({ json: async () => ({ ok: true }), arrayBuffer: async () => new ArrayBuffer(4) });
    });
    setAssetHost(baseAssetHost('./'));
    return Promise.all([
      readJsonAsset('/skins/orb-core.json'),
      readBinaryAsset('/audio/sfx/shot.mp3'),
    ]).then(([json, bin]) => {
      expect(json).toEqual({ ok: true });
      expect((bin as ArrayBuffer).byteLength).toBe(4);
      expect(fetched).toEqual(['skins/orb-core.json', 'audio/sfx/shot.mp3']);
    });
  });

  it('keeps the web host\'s Assets.init options', () => {
    // A portal page is a real browser, so Pixi's format detections must stay ON there —
    // they are what let a webp variant win. Only the mini-game turns them off.
    expect(baseAssetHost('./').assetsInit).toEqual(webAssetHost.assetsInit);
  });
});

describe('setAssetHost / resetAssetHost', () => {
  it('installs and restores', () => {
    const fake = { ...webAssetHost, resolveUrl: (p: string) => `fake${p}` };
    setAssetHost(fake);
    expect(resolveAssetUrl('/a.png')).toBe('fake/a.png');
    resetAssetHost();
    expect(resolveAssetUrl('/a.png')).toBe('/a.png');
  });
});
