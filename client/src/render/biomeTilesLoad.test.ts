/**
 * How `biomeTiles.preloadBiomeTiles` LOADS each asset, which its sibling
 * `biomeTiles.test.ts` cannot see: that file lets the real (always-failing) network call fail
 * and asserts the registry stays empty, so no texture ever reaches the two lines that matter.
 * Here `Assets.load` is stubbed — same partial `vi.mock('pixi.js')` pattern as
 * `taoBundle.test.ts` — so the per-key options and the resulting texture state are readable.
 *
 * The two lines under test both exist because of a real bug this repo has already paid for:
 *
 * - **A sprite key needs a mip chain.** `pillar_neutral` is a 326 px source drawn at ~84 px, and
 *   un-mipmapped minification is what turned the rig art into blue/yellow/purple colour noise
 *   in 2026-08-12. It has to be requested at load time; flipping `autoGenerateMipmaps` on an
 *   already-uploaded texture was tried live that day and did nothing.
 * - **A sprite key must NOT wrap.** `addressMode: 'repeat'` is right for a TilingSprite and
 *   wrong for a lone object, whose silhouette would sample the far side of itself.
 *
 * Kept in its own file rather than added to `biomeTiles.test.ts` because the mock populates the
 * module's texture registry, which is exactly what that file asserts stays empty.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ assetsLoad: vi.fn() }));
vi.mock('pixi.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('pixi.js')>();
  return { ...actual, Assets: { ...actual.Assets, load: mocks.assetsLoad } };
});

import {
  preloadBiomeTiles,
  getFloorTexture,
  getWallTexture,
  getWallFaceTexture,
  getPillarTexture,
  swatchMeta,
  SWATCH_META,
} from './biomeTiles';

interface FakeTexture {
  __src: string;
  __mipmaps: boolean;
  __resolution: number | undefined;
  source: { addressMode?: string; width: number; height: number };
}

type LoadArg = string | { src: string; data?: { autoGenerateMipmaps?: boolean; resolution?: number } };

beforeEach(() => {
  mocks.assetsLoad.mockReset();
  mocks.assetsLoad.mockImplementation(async (arg: LoadArg) => {
    const src = typeof arg === 'string' ? arg : arg.src;
    const mipmaps = typeof arg === 'string' ? false : arg.data?.autoGenerateMipmaps === true;
    const resolution = typeof arg === 'string' ? undefined : arg.data?.resolution;
    return { __src: src, __mipmaps: mipmaps, __resolution: resolution, source: { width: 326, height: 384 } } as FakeTexture;
  });
});

describe('preloadBiomeTiles — swatch keys and sprite keys are loaded differently', () => {
  it('asks for a mip chain for the pillar sprite, and does not wrap it', async () => {
    await preloadBiomeTiles();
    const pillar = getPillarTexture('fire') as unknown as FakeTexture;
    expect(pillar).toBeDefined(); // proven non-empty before asserting anything about it
    expect(pillar.__src).toBe('/biome/pillar_neutral.png');
    expect(pillar.__mipmaps).toBe(true);
    expect(pillar.source.addressMode).toBeUndefined();
  });

  it('still wraps every first-generation swatch, and asks no mipmaps of them', async () => {
    await preloadBiomeTiles();
    for (const tex of [getFloorTexture('ice'), getWallTexture('ice')] as unknown as FakeTexture[]) {
      expect(tex).toBeDefined();
      expect(tex.source.addressMode).toBe('repeat');
      expect(tex.__mipmaps).toBe(false);
      expect(tex.__resolution).toBeUndefined();
      expect(swatchMeta(tex as never)).toBeUndefined();
    }
  });

  it('loads a warm-stone swatch at its density, mipmapped, wrapping, and tagged with its metadata', async () => {
    // The density IS the texture resolution, so `texture.width` comes back in world px for every
    // consumer; and a swatch minified by its own density needs the chain a sprite does.
    await preloadBiomeTiles();
    const cases = [
      [getFloorTexture('fire'), 'floor_fire'],
      [getWallTexture('fire'), 'wall_fire'],
      [getWallFaceTexture('fire'), 'wallface_fire'],
    ] as const;
    for (const [tex, key] of cases) {
      const fake = tex as unknown as FakeTexture;
      expect(fake.__src).toBe(`/biome/${key}.jpg`);
      expect(fake.__mipmaps).toBe(true);
      expect(fake.__resolution).toBe(SWATCH_META[key]!.density);
      expect(fake.source.addressMode).toBe('repeat');
      expect(swatchMeta(tex)).toBe(SWATCH_META[key]);
    }
  });

  it('reads no metadata off a missing texture', () => {
    expect(swatchMeta(undefined)).toBeUndefined();
  });

  it('resolves the pillar for every element off the one shipped file', async () => {
    // The biome difference is a tint (`pillarRender.pillarTint`), not four files — but a
    // per-element `pillar_<element>` key still wins over the fallback if one is ever added.
    await preloadBiomeTiles();
    for (const el of ['fire', 'ice', 'lightning', 'neutral', 'poison'] as const) {
      expect((getPillarTexture(el) as unknown as FakeTexture).__src).toBe('/biome/pillar_neutral.png');
    }
  });

  it('leaves the registry alone for an asset that fails to load (boot must never block)', async () => {
    mocks.assetsLoad.mockRejectedValue(new Error('404'));
    await expect(preloadBiomeTiles()).resolves.toBeUndefined();
  });
});
