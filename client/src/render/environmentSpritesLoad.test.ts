/**
 * What `environmentSprites`'s getters RESOLVE to once a load succeeds, which its sibling
 * `environmentSprites.test.ts` cannot see: that file lets the real (always-failing) network
 * call fail and asserts the registry stays empty, so the key each getter builds is never
 * once exercised. Same split, and the same stubbed `Assets.load`, as
 * `biomeTilesLoad.test.ts` / `taoBundle.test.ts`.
 *
 * This file exists because a mutation battery said so (2026-08-20). Two mutants survived the
 * whole suite: dropping the `pickup_` prefix from `getPickupTexture`'s lookup, and a typo in
 * `getPortalArchTexture`'s key. Both are silent — the getter returns `undefined`, which is
 * indistinguishable from "not preloaded yet", so every drop and every portal just keeps
 * drawing the Graphics fallback it is supposed to have outgrown, and no test anywhere
 * noticed. Asserting the key mapping end to end is the only thing that catches it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ assetsLoad: vi.fn() }));
vi.mock('pixi.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('pixi.js')>();
  return { ...actual, Assets: { ...actual.Assets, load: mocks.assetsLoad } };
});

import {
  preloadEnvironmentSprites,
  getDoorTexture,
  getPickupTexture,
  getPortalArchTexture,
} from './environmentSprites';

interface FakeTexture {
  __src: string;
  __mipmaps: boolean;
  source: { addressMode?: string; width: number; height: number };
}

beforeEach(() => {
  mocks.assetsLoad.mockReset();
  mocks.assetsLoad.mockImplementation(
    async (arg: string | { src: string; data?: { autoGenerateMipmaps?: boolean } }) => {
      const src = typeof arg === 'string' ? arg : arg.src;
      const mipmaps = typeof arg === 'string' ? false : arg.data?.autoGenerateMipmaps === true;
      return { __src: src, __mipmaps: mipmaps, source: { width: 192, height: 192 } } as FakeTexture;
    },
  );
});

const src = (t: unknown): string => (t as FakeTexture | undefined)?.__src ?? 'MISSING';

describe('environmentSprites — each getter resolves to its OWN file', () => {
  it('maps every drop kind to its own sprite', async () => {
    await preloadEnvironmentSprites();
    // Asserted per kind rather than as "some texture came back": a lookup that dropped the
    // `pickup_` prefix, or one that returned a shared texture, would satisfy a mere
    // toBeDefined() while putting the wrong picture (or no picture) on the floor.
    expect(src(getPickupTexture('material'))).toBe('/environment/pickup_material.png');
    expect(src(getPickupTexture('heal'))).toBe('/environment/pickup_heal.png');
    expect(src(getPickupTexture('buff'))).toBe('/environment/pickup_buff.png');
    expect(src(getPickupTexture('crate'))).toBe('/environment/pickup_crate.png');
    expect(src(getPickupTexture('bandage'))).toBe('/environment/pickup_bandage.png');
    expect(src(getPickupTexture('coin'))).toBe('/environment/pickup_coin.png');
    expect(src(getPickupTexture('energy'))).toBe('/environment/pickup_energy.png');
    expect(src(getPickupTexture('shield'))).toBe('/environment/pickup_shield.png');
    expect(src(getPickupTexture('emp'))).toBe('/environment/pickup_emp.png');
  });

  it('has nothing for a weapon drop even after a full successful preload', async () => {
    // The one kind that must stay unresolved: a weapon drop draws that weapon's own
    // business-end art. `Pickup` also never asks — belt and braces, since either half
    // failing alone would swap a specific gun for a generic icon.
    await preloadEnvironmentSprites();
    expect(getPickupTexture('weapon')).toBeUndefined();
  });

  it('maps the portal arch and the two door states to their own files', async () => {
    await preloadEnvironmentSprites();
    expect(src(getPortalArchTexture())).toBe('/environment/portal_arch.png');
    expect(src(getDoorTexture(true))).toBe('/environment/door_locked_raw.png');
    expect(src(getDoorTexture(false))).toBe('/environment/door_open_raw.png');
  });

  it('gives every one of them a mip chain and no wrap addressing', async () => {
    // The same two lines biomeTilesLoad.test.ts pins for the pillar, for the same reason —
    // and this module had neither until this pass, so the doors have been minifying 2.4:1
    // with no mip chain since they shipped.
    await preloadEnvironmentSprites();
    for (const tex of [
      getPickupTexture('material'),
      getPickupTexture('bandage'),
      getPortalArchTexture(),
      getDoorTexture(true),
      getDoorTexture(false),
    ] as unknown as FakeTexture[]) {
      expect(tex).toBeDefined();
      expect(tex.__mipmaps).toBe(true);
      expect(tex.source.addressMode).toBeUndefined();
    }
  });

  it('leaves the registry empty for an asset that fails to load (boot must never block)', async () => {
    // Re-imported so the module's texture registry starts empty: it is module-level state
    // with no clear() (deliberately — a failed RE-preload should keep the texture it already
    // has), so the tests above have already filled it by this point.
    vi.resetModules();
    const fresh = await import('./environmentSprites');
    mocks.assetsLoad.mockRejectedValue(new Error('404'));
    await expect(fresh.preloadEnvironmentSprites()).resolves.toBeUndefined();
    expect(fresh.getPickupTexture('material')).toBeUndefined();
    expect(fresh.getPortalArchTexture()).toBeUndefined();
  });
});
