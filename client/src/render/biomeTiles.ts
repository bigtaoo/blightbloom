// Tileable floor/wall swatches for the biome-specific art pass (design/13's still-open
// "other biomes' looks" — the room ground/walls were code-only palette tints until
// now, see game/config.ts's biomePalette()). Same non-blocking best-effort preload
// pattern as uiSkins.ts/weaponSkins.ts: a missing/not-yet-generated swatch just leaves
// RoomBuilder on its existing flat-colour fallback, never blocks boot.
//
// Keyed by BiomeElement (game/theme.ts), not by DungeonConfig.biomeId — a biome's
// LOOK is one swatch per element, reused by every biome that shares that element
// (mirrors how biomePalette() already works).
//
// All FIVE elements are registered here as of 2026-08-25, poison included. Every entry is
// best-effort: a key whose file has not been generated resolves to `undefined` exactly like a
// key that failed to fetch, and `RoomBuilder` falls back to its flat palette fill. So
// registering the poison keys before the art exists costs nothing and means the swatches go
// live the moment the files land, with no second code change — which is the shape of the bug
// this pass was closing in the first place (the fifth element of a LOCKED five-colour language
// had no path to the renderer at all).
//
// Every element now has a chapter drawing it (`engine/world/rooms/` has `ember` → fire, `frost` → ice,
// `storm` → lightning and, since 2026-10-06, `blight` → poison, the finale — design/13 keeps poison off
// chapter 1 per the green-on-green camouflage note). Each is one entry in `theme.ts`'s
// BIOME_ID_TO_ELEMENT, not a change here.
import { Assets, Texture } from 'pixi.js';
import { resolveAssetUrl } from './assetHost';
import type { BiomeElement } from '../game/theme';

/** Exported alongside the key list so the WeChat package checks can enumerate the real
 *  FILES this loader will ask for (`wechatAssetLoad.test.ts`, build/checkWeChatPackage.mjs) —
 *  a key alone does not say which file it resolves to. */
export const BIOME_TILE_ASSETS: Readonly<Record<string, string>> = {
  floor_fire: '/biome/floor_fire.jpg',
  floor_ice: '/biome/floor_ice.png',
  floor_lightning: '/biome/floor_lightning.png',
  floor_neutral: '/biome/floor_neutral.png',
  floor_poison: '/biome/floor_poison.png',
  wall_fire: '/biome/wall_fire.jpg',
  wall_ice: '/biome/wall_ice.png',
  wall_lightning: '/biome/wall_lightning.png',
  wall_neutral: '/biome/wall_neutral.png',
  wall_poison: '/biome/wall_poison.png',
  // Front ELEVATION of a wall, for the standing-wall pass (design/01, 2026-08-18) —
  // a separate asset from `wall_*` above, which is the top-down surface and is now
  // reused as the raised wall's top cap. Tiles horizontally only: its top rows are a
  // lit coping edge and its bottom rows a dark base, so it is used at exactly one
  // height (WALL_HEIGHT) and never repeated vertically.
  wallface_fire: '/biome/wallface_fire.jpg',
  wallface_ice: '/biome/wallface_ice.png',
  wallface_lightning: '/biome/wallface_lightning.png',
  wallface_neutral: '/biome/wallface_neutral.png',
  wallface_poison: '/biome/wallface_poison.png',
  // A whole pillar, as one SPRITE — not a swatch (2026-08-20). Unlike everything above
  // it is never tiled and never repeated: a pillar is a fixed-size round object, and
  // sampling a 256 px wall swatch through a ~35 px cap window was tried in 2026-08-18
  // and read as a dark blob (see pillarRender.ts). One file covers every biome; the
  // biome's hue arrives as a tint (`pillarTint`), which is also how the hand-toned
  // version got it. A per-element `pillar_<element>` file drops in by adding a key here.
  pillar_neutral: '/biome/pillar_neutral.png',
};

/** Keys that are whole objects rather than tileable swatches: they must NOT get the
 *  `repeat` address mode, and they DO need a mip chain, because a sprite is minified
 *  (a 326 px source drawn at ~84 px) where a swatch is drawn about 1:1. Un-mipmapped
 *  minification is what turned the rig art into colour noise in 2026-08-12, and the
 *  chain has to be requested at load time — flipping the flag on an already-uploaded
 *  texture does nothing. */
const SPRITE_KEYS: ReadonlySet<string> = new Set(['pillar_neutral']);

/**
 * What a warm-stone swatch (design/13 "Environment: warm stone, dark edges, light pools",
 * 2026-10-10) carries that the first-generation 256 px swatches do not.
 *
 * - `density`: texels per WORLD px. Loaded as the texture's `resolution`, so `texture.width` is
 *   already in world px for every consumer — the floor stamp, the cap's TilingSprite, a crop —
 *   and none of them has to know a swatch can be finer than 1:1. The old swatches were 256 px drawn
 *   1:1 and then magnified ~3.5x by the camera, which is most of why the floor read soft.
 * - `seamless`: the swatch wraps exactly (`tools/png-pipeline/makeTileable.mjs`), so the floor
 *   stamp must NOT mirror alternate tiles — a mirror is what the old, roughly-matching edges
 *   needed, and on an exact wrap it only turns stone into a kaleidoscope at every tile line.
 * - `authoredTone`: the art already sits on its tonal target (`colorGrade.mjs --median`), so the
 *   wall code must not apply the lifts and tints `scene/wallTone.ts` tuned for the old charcoal art.
 */
export interface SwatchMeta {
  readonly density: number;
  readonly seamless: boolean;
  readonly authoredTone: boolean;
}

/** 512 px over 200 world px: a floor slab is about two hero-widths, the key frame's proportion. The
 *  texel count stays a power of two (`texturePowerOfTwo.test.ts`: a WebGL1 context clamps a
 *  non-power-of-two texture that asks to wrap), so the density is the free number, not the size. */
const WARM_STONE: SwatchMeta = { density: 2.56, seamless: true, authoredTone: true };

/** Keys drawn in the warm-stone direction. Everything else is a first-generation swatch. The
 *  front ELEVATION has no density: it is always stretched to the wall's own height. */
export const SWATCH_META: Readonly<Record<string, SwatchMeta>> = {
  floor_fire: WARM_STONE,
  // 512 px over one 64 px cap cell.
  wall_fire: { ...WARM_STONE, density: 8 },
  wallface_fire: { density: 1, seamless: true, authoredTone: true },
};

const metaByTexture = new WeakMap<Texture, SwatchMeta>();

/** The swatch metadata a loaded texture was registered with, or `undefined` for a
 *  first-generation swatch (and for anything that is not a swatch at all). */
export function swatchMeta(tex: Texture | undefined): SwatchMeta | undefined {
  return tex ? metaByTexture.get(tex) : undefined;
}

const textures = new Map<string, Texture>();

/** Every key `getFloorTexture`/`getWallTexture` can resolve once preloaded — exposed
 * so tests can assert a key is actually registered, since the getters return
 * `undefined` identically for both a missing key and a registered key whose file
 * hasn't loaded (network-independent by design, same shape as uiSkins.ts). */
export const BIOME_TILE_ASSET_KEYS: readonly string[] = Object.keys(BIOME_TILE_ASSETS);

export async function preloadBiomeTiles(): Promise<void> {
  await Promise.all(
    Object.entries(BIOME_TILE_ASSETS).map(async ([key, path]) => {
      try {
        const isSprite = SPRITE_KEYS.has(key);
        const meta = SWATCH_META[key];
        // A warm-stone swatch is minified by its own density before the camera ever sees it (and a
        // kerb's face is squeezed 5x), so it needs the same mip chain a sprite does.
        const tex =
          isSprite || meta
            ? await Assets.load<Texture>({
                src: resolveAssetUrl(path),
                data: { autoGenerateMipmaps: true, resolution: meta?.density ?? 1 },
              })
            : await Assets.load<Texture>(resolveAssetUrl(path));
        if (meta) metaByTexture.set(tex, meta);
        // Tiling textures must wrap, not clamp-to-edge (Pixi's default) — otherwise a
        // TilingSprite repeats the same clamped border pixel instead of the swatch.
        // A sprite key keeps the default clamp: wrapping a lone object's edge would
        // fetch the opposite side of the pillar at its own silhouette.
        if (!isSprite) tex.source.addressMode = 'repeat';
        textures.set(key, tex);
      } catch {
        // Not generated yet (or failed to fetch) — fine, RoomBuilder's flat-colour
        // fallback covers it.
      }
    }),
  );
}

export function getFloorTexture(element: BiomeElement): Texture | undefined {
  return textures.get(`floor_${element}`);
}

export function getWallTexture(element: BiomeElement): Texture | undefined {
  return textures.get(`wall_${element}`);
}

/** The pillar sprite (see `pillar_*` above). Falls back to the element-agnostic
 *  `pillar_neutral` when no per-element file has been generated, which today is every
 *  element — the biome difference is a tint, not a second file. Undefined leaves
 *  RoomBuilder on its hand-toned Graphics cylinder, same contract as every other
 *  swatch here. */
export function getPillarTexture(element: BiomeElement): Texture | undefined {
  return textures.get(`pillar_${element}`) ?? textures.get('pillar_neutral');
}

/** The wall's front elevation (see `wallface_*` above). Undefined leaves RoomBuilder on
 *  its Graphics fallback for the standing face — the wall still stands, it just isn't
 *  textured, same contract as every other swatch here. */
export function getWallFaceTexture(element: BiomeElement): Texture | undefined {
  return textures.get(`wallface_${element}`);
}
