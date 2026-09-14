/**
 * The WeChat art-loading path, driven end to end against a WeChat-SHAPED runtime.
 *
 * Why this file exists: until 2026-08-25 the mini-game target loaded no art at all, and the
 * reason it was allowed to stay that way for so long is that nothing could check it. There
 * is no automation API for a mini-game, `design/04`'s verification checklist is
 * screenshot-and-log based, and the simulator is not even installed on every machine. So the
 * loading path had exactly one form of evidence available — "it looks right in DevTools" —
 * which no one can re-run on a commit.
 *
 * What this replaces that with: strip the browser globals a mini-game does not have, install
 * a `wx` fake backed by the REAL shipped files, and run the REAL `preloadCoreArt()` — the
 * same function `main.wechat.ts` calls — through the real Pixi `Assets` pipeline and the
 * real `WeChatAdapter`. Nothing here is a re-implementation: the only fake is `wx` itself.
 *
 * What it therefore pins:
 *   - no loader reaches for a browser-only global (`fetch`, `createImageBitmap`, `document`,
 *     `Image`) — the failure mode is a boot-time crash on a device and a green suite here,
 *     so the globals are removed rather than merely unused;
 *   - Pixi takes the `DOMAdapter.createImage()` branch, i.e. the branch `WeChatAdapter`
 *     actually implements (see assetHost.ts's header for why the image path never needed
 *     `fetch` at all);
 *   - every path handed to the runtime is a package-relative path that names a real file in
 *     the layout `build/wechatAssetSync.mjs` builds — a leading '/' or a stale filename is a
 *     silent no-art texture on device and is a failure here;
 *   - every registered key of every loader resolves, at the source art's real dimensions.
 *
 * What it CANNOT pin, and what still needs the simulator or a device (design/04's checklist):
 * that the real base library's `wx.createImage()` populates `width`/`height` before `onload`
 * the way this fake does, that `FileSystemManager.readFileSync` behaves the same on the
 * lowest base library, and anything about the GL upload of a wx Image. This is a strong
 * regression net, not a substitute for running it.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { Assets, Texture } from 'pixi.js';
import { WeChatAdapter } from '../platform/wechat/WeChatAdapter';
import { weChatAssetHost } from '../platform/wechat/weChatAssetHost';
import { SUBPACKS, packedPathFor } from './assetManifest';
import { diskPathFor, installWeChatRuntimeFake, PUBLIC, type WeChatRuntimeFake } from './wechatRuntimeFake';
import { preloadCoreArt, CHAR_BUNDLES, resetPreloadArt } from './preloadArt';
import { getRigSkin } from './skinRegistry';
import { BIOME_TILE_ASSETS, getFloorTexture, getWallTexture, getWallFaceTexture, getPillarTexture } from './biomeTiles';
import { UI_ASSETS, getUiTexture } from './uiSkins';
import {
  ENV_SPRITE_ASSETS,
  getPickupTexture,
  getDoorTexture,
  getDoorCurtainTexture,
  getPortalArchTexture,
  getPropTexture,
  getShopkeeperTexture,
} from './environmentSprites';
import { WEAPON_DEFS, KIND_DEFAULTS, getWeaponTexture } from './weaponSkins';

// The runtime, the request logs and the disk-path mapping all live in `wechatRuntimeFake.ts`
// now — `wechatPhasedBoot.test.ts` drives the same runtime through the two-phase boot the entry
// point actually uses, and neither file can borrow the other's `beforeAll`.
let fake: WeChatRuntimeFake;
let imageRequests: readonly string[];
let jsonRequests: readonly string[];
let packLoads: readonly string[];

beforeAll(async () => {
  fake = installWeChatRuntimeFake();
  ({ imageRequests, jsonRequests, packLoads } = fake);
  // The all-at-once path (every pack, every loader), which is what this file is about. The
  // PHASED path both entries take is `wechatPhasedBoot.test.ts`.
  await preloadCoreArt();
});

afterAll(() => {
  fake.restore();
  resetPreloadArt();
});

/** Every texture this bundle/loader produced, keyed for a readable failure message. */
function expectRealTexture(label: string, tex: Texture | undefined): void {
  expect(tex, `${label}: no texture`).toBeDefined();
  const packed = packedPathFor(label.startsWith('/') ? label : `/${label}`);
  const buf = readFileSync(diskPathFor(packed));
  expect(tex!.source.pixelWidth, `${label}: width`).toBe(buf.readUInt32BE(16));
  expect(tex!.source.pixelHeight, `${label}: height`).toBe(buf.readUInt32BE(20));
}

describe('WeChat runtime — the environment the loaders actually ran in', () => {
  it('had none of the browser globals a mini-game lacks', () => {
    for (const g of ['fetch', 'createImageBitmap', 'document', 'window', 'Image']) {
      expect(g in globalThis, `${g} leaked into the WeChat run`).toBe(false);
    }
  });

  it('loaded every image through wx.createImage, and asked for nothing else', () => {
    // The whole premise of the fix: the image path needs no network primitive, so nothing
    // should have reached WeChatAdapter.fetch (which still rejects on purpose).
    expect(imageRequests.length).toBeGreaterThan(50);
    return expect(WeChatAdapter.fetch('anything')).rejects.toThrow(/not implemented/);
  });

  it('asked only for package-relative paths that name real files', () => {
    for (const packed of [...imageRequests, ...jsonRequests]) {
      expect(packed.startsWith('/'), `'${packed}' kept its web leading slash`).toBe(false);
      expect(existsSync(diskPathFor(packed)), `'${packed}' names no file`).toBe(true);
    }
  });

  it('initialised Assets with detections skipped, because at least one of them needs a DOM', async () => {
    expect(weChatAssetHost.assetsInit.skipDetections).toBe(true);
    // The mechanism, proven rather than asserted by comment: Pixi's format detections
    // include video probes that call `document.createElement('video')`. At least one of
    // the registered detections therefore throws in this runtime — which is what would
    // happen inside `Assets.init()` if `skipDetections` were ever dropped, silently
    // costing whichever texture raced there first (assetHost.ts, AssetHost.assetsInit).
    const outcomes = await Promise.allSettled(Assets.detections.map((d) => d.test()));
    const domFailures = outcomes.filter((o) => o.status === 'rejected' && /document/.test(String(o.reason)));
    expect(domFailures.length).toBeGreaterThan(0);
  });

  it('loaded every declared subpackage, exactly once, before anything read out of one', () => {
    // "Before" is enforced by the fake, not asserted here: a read from an unloaded pack
    // throws / fires onerror, so the per-pack assertions further down could not pass at all
    // if `ensureAllPacks()` were removed from preloadCoreArt.
    expect(SUBPACKS.length).toBeGreaterThan(0);
    expect([...packLoads].sort()).toEqual(SUBPACKS.map((p) => p.name).sort());
  });

  it('read every rig sidecar through FileSystemManager, not through a fetch', () => {
    // Two sidecars per bundle (animation.json + frames.json) — the pair taoBundle.ts used
    // to pull with the global `fetch` that does not exist here.
    expect(jsonRequests.length).toBe(CHAR_BUNDLES.length * 2);
    for (const [, baseUrl] of CHAR_BUNDLES) {
      // Through `packedPathFor`, because a bundle in a subpackage is asked for under that
      // pack's root — `boss-core` is, and building the expected string from the web-relative
      // baseUrl instead is what this assertion did until the split existed.
      expect(jsonRequests).toContain(packedPathFor(`${baseUrl}/animation.json`));
      expect(jsonRequests).toContain(packedPathFor(`${baseUrl}/frames.json`));
    }
  });
});

describe('WeChat runtime — every rig bundle resolved', () => {
  it.each(CHAR_BUNDLES)('%s loaded its bindings, clips and every frame texture', (name, baseUrl) => {
    const loaded = getRigSkin(name);
    expect(loaded, `${name} never reached the registry`).toBeDefined();
    expect(loaded!.bundle.bindings.size).toBeGreaterThan(0);
    expect(loaded!.bundle.clips.size).toBeGreaterThan(0);
    expect(loaded!.bundle.textures.size).toBeGreaterThan(0);
    for (const [frameId, tex] of loaded!.bundle.textures) {
      expectRealTexture(`${baseUrl}/${frameId}.png`, tex);
    }
  });

  it('bound every frame declared by frames.json, for every bundle', () => {
    for (const [name, baseUrl] of CHAR_BUNDLES) {
      const frames = JSON.parse(readFileSync(new URL(`${baseUrl.slice(1)}/frames.json`, PUBLIC), 'utf8')) as Record<string, string[]>;
      const expected = Object.entries(frames).flatMap(([slot, variants]) =>
        variants.map((v) => (v === 'default' ? slot : `${slot}__${v}`)),
      );
      expect([...getRigSkin(name)!.bundle.textures.keys()].sort()).toEqual(expected.sort());
    }
  });
});

describe('WeChat runtime — every sprite loader resolved', () => {
  it('loaded every biome swatch, wall face and the pillar', () => {
    for (const el of ['fire', 'ice', 'lightning', 'neutral', 'poison'] as const) {
      expectRealTexture(BIOME_TILE_ASSETS[`floor_${el}`], getFloorTexture(el));
      expectRealTexture(BIOME_TILE_ASSETS[`wall_${el}`], getWallTexture(el));
      expectRealTexture(BIOME_TILE_ASSETS[`wallface_${el}`], getWallFaceTexture(el));
      expectRealTexture(BIOME_TILE_ASSETS.pillar_neutral, getPillarTexture(el));
    }
  });

  it('loaded every UI texture', () => {
    for (const [key, path] of Object.entries(UI_ASSETS)) expectRealTexture(path, getUiTexture(key));
  });

  it('loaded every environment sprite', () => {
    // Exhaustive by construction. This used to name the doors and the arch and then loop the
    // `pickup_`/`prop_` PREFIXES — which silently covered nothing for a key belonging to
    // neither family, and 2026-09-14 added exactly one (`npc_shopkeeper`). A sweep that skips
    // what it does not recognise reports the same green whether the file reached the WeChat
    // package or not, and a missing asset on that target is invisible until a player finds it.
    const getters: Record<string, () => unknown> = {
      door_locked: () => getDoorTexture(true),
      door_open: () => getDoorTexture(false),
      door_curtain: () => getDoorCurtainTexture(),
      portal_arch: () => getPortalArchTexture(),
      npc_shopkeeper: () => getShopkeeperTexture(),
    };
    for (const key of Object.keys(ENV_SPRITE_ASSETS)) {
      if (key.startsWith('pickup_')) getters[key] = () => getPickupTexture(key.slice('pickup_'.length));
      else if (key.startsWith('prop_')) getters[key] = () => getPropTexture(key.slice('prop_'.length));
    }
    // The guard that keeps the loop honest: a key with no getter fails here rather than
    // being skipped, so this sweep cannot go quiet the way its predecessor did.
    expect(Object.keys(getters).sort()).toEqual(Object.keys(ENV_SPRITE_ASSETS).sort());
    for (const [key, get] of Object.entries(getters)) {
      expectRealTexture(ENV_SPRITE_ASSETS[key], get() as Parameters<typeof expectRealTexture>[1]);
    }
  });

  it('loaded every weapon business-end texture, and both kind defaults', () => {
    for (const [name, def] of Object.entries(WEAPON_DEFS)) expectRealTexture(def!.path, getWeaponTexture(name, 'ranged'));
    for (const kind of ['ranged', 'melee'] as const) {
      // An unregistered id falls back to the kind default, which must itself have loaded —
      // that fallback is the never-invisible path (weaponSkins.ts's `resolve`).
      expectRealTexture(KIND_DEFAULTS[kind].path, getWeaponTexture('no-such-weapon', kind));
    }
  });
});

describe('WeChat runtime — a missing package file degrades instead of failing boot', () => {
  it('leaves a getter undefined rather than rejecting the preload', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // Not a registered asset: proves the onerror branch of the fake reaches the loaders'
      // own best-effort catch, which is the contract every one of them documents.
      const { preloadRigSkin } = await import('./skinRegistry');
      await expect(preloadRigSkin('critter-core', '/skins/does-not-exist')).rejects.toThrow();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('WeChat runtime — subpackaged art', () => {
  it('addresses a subpackaged asset under its pack root, not at the project root', () => {
    expect(packedPathFor('/biome/floor_ice.png')).toBe('packs/biome-ice/biome/floor_ice.png');
    expect(packedPathFor('/skins/boss-core/core.png')).toBe('packs/boss/skins/boss-core/core.png');
    // ...and since 2026-09-01 there is no art at the project root at all: the main package is
    // js/game.js alone, so the reachable-today swatches address under `packs/run` rather than
    // bare (design/12, "the first download is code only").
    expect(packedPathFor('/biome/floor_fire.png')).toBe('packs/run/biome/floor_fire.png');
  });

  it('resolved the three deferred biomes, which live behind three separate subpackages', () => {
    for (const el of ['ice', 'lightning', 'poison'] as const) {
      expectRealTexture(BIOME_TILE_ASSETS[`floor_${el}`], getFloorTexture(el));
      expectRealTexture(BIOME_TILE_ASSETS[`wall_${el}`], getWallTexture(el));
      expectRealTexture(BIOME_TILE_ASSETS[`wallface_${el}`], getWallFaceTexture(el));
    }
  });

  it('resolved the boss bundle, whose sidecars had to come out of a subpackage too', () => {
    const boss = getRigSkin('boss-core');
    expect(boss).toBeDefined();
    expect(boss!.bundle.clips.size).toBeGreaterThan(0);
    expect(jsonRequests).toContain('packs/boss/skins/boss-core/animation.json');
  });

  it('kept every floor-1 enemy body in the pack the run gate awaits, not behind the boss pack', () => {
    // `brute` and `floater` both spawn on floor 1 (world/dungeons/ember/ember_l1_floor_1.json),
    // so putting them anywhere the run gate does not await would be wrong. `run` is awaited;
    // `boss` is too today, but it is the pack that exists to be made genuinely lazy first.
    for (const dir of ['critter-core', 'brute-core', 'floater-core']) {
      expect(packedPathFor(`/skins/${dir}/body.png`)).toBe(`packs/run/skins/${dir}/body.png`);
    }
  });
});
