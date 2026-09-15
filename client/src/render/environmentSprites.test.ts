/**
 * environmentSprites.ts's door-fixture registry (design/05 "Room & door model",
 * 2026-08-04). Same "no asset server in this test environment" convention as
 * biomeTiles.test.ts: every `Assets.load` call genuinely rejects here, which is exactly
 * what proves `preloadEnvironmentSprites()` is best-effort (RoomBuilder's flat-tint
 * fallback covers an unloaded door the same way it already covers an unloaded floor/wall
 * swatch) rather than one failed load aborting the whole preload.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  preloadEnvironmentSprites,
  getDoorTexture,
  getDoorCurtainTexture,
  getPickupTexture,
  getPortalArchTexture,
  getPropTexture,
  getChestTexture,
  getShopkeeperTexture,
  ENV_SPRITE_ASSETS,
  ENV_SPRITE_ASSET_KEYS,
} from './environmentSprites';

/**
 * Every registered key, mapped to the getter that can actually resolve it — and asserted
 * EXHAUSTIVE below, which is the point of the table existing at all.
 *
 * Before this table, the registration block and the getter block were each a hand-written list,
 * so a new asset was covered only if whoever added it remembered to extend both. The shopkeeper
 * (2026-09-14) did not: a mutation battery deleted its registry row outright, and pointed its
 * getter at the wrong key, and **both survived the entire repo** — `ShopLayer` and `npcArt` mock
 * this module, so nothing anywhere asked the real registry a question. That is the same failure
 * this file's own header already records for `getPropTexture`'s `prop_` prefix, recurring because
 * the fix last time was one more line in a list rather than a structure.
 */
const GETTERS: Readonly<Record<string, () => { source: { label: string } } | undefined>> = {
  door_locked: () => getDoorTexture(true),
  door_open: () => getDoorTexture(false),
  door_curtain: () => getDoorCurtainTexture(),
  portal_arch: () => getPortalArchTexture(),
  npc_shopkeeper: () => getShopkeeperTexture(),
  pickup_material: () => getPickupTexture('material'),
  pickup_heal: () => getPickupTexture('heal'),
  pickup_buff: () => getPickupTexture('buff'),
  pickup_crate: () => getPickupTexture('crate'),
  pickup_bandage: () => getPickupTexture('bandage'),
  prop_crate: () => getPropTexture('crate'),
  prop_barrel: () => getPropTexture('barrel'),
  prop_rubble: () => getPropTexture('rubble'),
  // Both kinds x both states (2026-09-15) — spelled out rather than derived, like every other
  // row here: the point of this table is to be a SECOND statement of the wiring, and a loop
  // over the same key list would just restate the registry to itself.
  chest_small: () => getChestTexture('small', false),
  chest_small_open: () => getChestTexture('small', true),
  chest_big: () => getChestTexture('big', false),
  chest_big_open: () => getChestTexture('big', true),
} as Readonly<Record<string, () => { source: { label: string } } | undefined>>;

describe('environmentSprites — getDoorTexture before any preload', () => {
  it('returns undefined for both lock states (RoomBuilder falls back to a flat tint)', () => {
    expect(getDoorTexture(true)).toBeUndefined();
    expect(getDoorTexture(false)).toBeUndefined();
  });
});

describe('environmentSprites — preloadEnvironmentSprites never throws (missing/unreachable art must not block boot)', () => {
  it('resolves cleanly even though no asset server exists in this test environment', async () => {
    await expect(preloadEnvironmentSprites()).resolves.toBeUndefined();
    expect(getDoorTexture(true)).toBeUndefined();
    expect(getDoorTexture(false)).toBeUndefined();
  });
});

describe('environmentSprites — every key a caller can ask for is actually registered', () => {
  // The getters return `undefined` identically for "not loaded yet" and "no such key", so a
  // typo in the asset table is invisible at run time: the drop just keeps drawing its
  // Graphics fallback forever, which looks like art that was never generated. Same guard
  // biomeTiles.test.ts keeps over BIOME_TILE_ASSET_KEYS.
  it.each(['material', 'heal', 'buff', 'crate', 'bandage'])('pickup_%s has a file', (kind) => {
    expect(ENV_SPRITE_ASSET_KEYS).toContain(`pickup_${kind}`);
  });

  it('registers the two door states, the open curtain, and the portal arch', () => {
    expect(ENV_SPRITE_ASSET_KEYS).toContain('door_locked');
    expect(ENV_SPRITE_ASSET_KEYS).toContain('door_open');
    expect(ENV_SPRITE_ASSET_KEYS).toContain('door_curtain');
    expect(ENV_SPRITE_ASSET_KEYS).toContain('portal_arch');
  });

  it('registers all three room-prop kinds', () => {
    for (const kind of ['crate', 'barrel', 'rubble']) {
      expect(ENV_SPRITE_ASSET_KEYS).toContain(`prop_${kind}`);
    }
  });

  it('registers the shop counter\'s shopkeeper', () => {
    // The first PERSON in this registry, and the only entry whose caller has no Graphics
    // fallback: `ShopLayer` draws no keeper at all without it (design/05). So a typo here is
    // not "the art looks unfinished", it is a room with nobody in it and nothing red anywhere.
    expect(ENV_SPRITE_ASSET_KEYS).toContain('npc_shopkeeper');
  });

  it('has a getter for every registered key, and a registered key for every getter', () => {
    // The anti-vacuity guard over the two lists above, and the reason `GETTERS` exists. Every
    // `toContain` in this block only fires for a name somebody thought to write down; this one
    // fails for a row nobody wired up, which is the case that actually happens. An asset the
    // loader fetches and no getter can return is a file shipped into the bundle for nothing.
    expect(Object.keys(GETTERS).sort()).toEqual([...ENV_SPRITE_ASSET_KEYS].sort());
  });

  it('deliberately has NO pickup_weapon', () => {
    // A weapon drop draws that weapon's own business-end art (render/weaponSkins.ts) so it
    // reads as "that specific gun". A generic file here would quietly shadow it.
    expect(ENV_SPRITE_ASSET_KEYS).not.toContain('pickup_weapon');
  });

  it('every registered key points at a distinct path, and no two share a file', () => {
    // This used to build its Set from the KEYS, which come out of `Object.keys` and are
    // therefore unique by construction — the assertion could not fail, and its own name said
    // it was checking something else. Two keys pointing at one file is a real copy-paste
    // mistake (the row below a duplicated one keeps the path above it), and it is silent: both
    // getters return a texture, one of them the wrong picture.
    const paths = Object.values(ENV_SPRITE_ASSETS);
    expect(new Set(paths).size).toBe(paths.length);
  });
});

describe('environmentSprites — the getters before any preload', () => {
  it('returns undefined for every drop kind, the curtain, and the arch', () => {
    for (const kind of ['material', 'heal', 'buff', 'crate', 'bandage', 'weapon']) {
      expect(getPickupTexture(kind)).toBeUndefined();
    }
    expect(getDoorCurtainTexture()).toBeUndefined();
    expect(getPortalArchTexture()).toBeUndefined();
    // The keeper's undefined path is the one with a visible consequence rather than a fallback:
    // `ShopLayer` draws no merchant at all, deliberately (design/05).
    expect(getShopkeeperTexture()).toBeUndefined();
  });
});

describe('environmentSprites — each getter resolves the key it registered, after a real preload', () => {
  /**
   * Every other test in this file runs against an EMPTY texture map, where a getter returns
   * `undefined` whether its key is right or wrong — so none of them can see a getter looking
   * up the wrong name. Proven by mutation: dropping the `prop_` prefix from `getPropTexture`
   * survived the whole suite. Loading a distinguishable texture per path and asking each
   * getter for it is what closes that, and it closes it for the door/pickup/arch getters at
   * the same time rather than only for the one that happened to be caught.
   */
  async function preloadWithStubs(): Promise<() => void> {
    const pixi = await import('pixi.js');
    // `Assets.load` is overloaded (array form returns a record), so the single-asset stub
    // needs the cast — the sibling mock above only escapes it by throwing, which types as
    // `never`.
    const stub = async (opts: unknown) => {
      const src = (opts as { src: string }).src;
      // The `label` is the only thing asserted, so the stub carries the path it was asked for.
      return new pixi.Texture({ source: new pixi.TextureSource({ width: 4, height: 4, label: src }) });
    };
    const spy = vi
      .spyOn(pixi.Assets, 'load')
      .mockImplementation(stub as unknown as typeof pixi.Assets.load);
    await preloadEnvironmentSprites();
    return () => spy.mockRestore();
  }

  it('maps every getter onto the file its own key names', async () => {
    const restore = await preloadWithStubs();
    try {
      const at = (t: { source: { label: string } } | undefined) => t?.source.label;
      expect(at(getDoorTexture(true))).toBe('/environment/door_locked_raw.png');
      expect(at(getDoorTexture(false))).toBe('/environment/door_open_raw.png');
      expect(at(getDoorCurtainTexture())).toBe('/environment/door_curtain_raw.png');
      expect(at(getPortalArchTexture())).toBe('/environment/portal_arch.png');
      for (const kind of ['material', 'heal', 'buff', 'crate', 'bandage']) {
        expect(at(getPickupTexture(kind))).toBe(`/environment/pickup_${kind}.png`);
      }
      for (const kind of ['crate', 'barrel', 'rubble']) {
        expect(at(getPropTexture(kind))).toBe(`/environment/prop_${kind}.png`);
      }
      expect(at(getShopkeeperTexture())).toBe('/environment/npc_shopkeeper.png');
    } finally {
      restore();
    }
  });

  it('resolves EVERY registered key through its own getter, not just the ones listed above', async () => {
    // The literal paths above are the point of that test — they pin the actual filenames, which
    // a comparison against the registry could never do. This one is the other half: it sweeps
    // `GETTERS`, which is pinned exhaustive against the registry, so a key added later is
    // covered whether or not anyone extends the list above. Mutation says both are needed —
    // pointing `getShopkeeperTexture` at the wrong key survived everything until this ran.
    const restore = await preloadWithStubs();
    try {
      for (const [key, get] of Object.entries(GETTERS)) {
        expect(get()?.source.label, key).toBe(ENV_SPRITE_ASSETS[key]);
      }
    } finally {
      restore();
    }
  });

  it('keeps the prop and pickup namespaces apart — both have a `crate`', async () => {
    // The two kinds genuinely collide on their own name: a lootable supply crate and a
    // scenery crate. Only the key prefix separates them, so a getter that drops it would
    // hand the room's dressing the bright pickup art and nothing else would complain.
    // Preloads again rather than leaning on the test above having run: the texture map is
    // module state, and a test whose subject only exists because of its neighbour stops
    // covering its own claim the moment either one is reordered or run alone.
    const restore = await preloadWithStubs();
    try {
      const prop = getPropTexture('crate');
      const pickup = getPickupTexture('crate');
      expect(prop).toBeDefined();
      expect(pickup).toBeDefined();
      expect(prop).not.toBe(pickup);
    } finally {
      restore();
    }
  });
});

describe('environmentSprites — every texture is loaded WITH a mip chain', () => {
  it('asks for autoGenerateMipmaps on all of them, and never for repeat addressing', async () => {
    // A drop's 192px source lands at ~18px on screen — a 10:1 minification, worse than the
    // 4:1 that made the pillar sprite need this and worse than the ~96:1 that produced the
    // 2026-08-12 rig-art colour-noise bug. The flag has to be passed at LOAD time: setting
    // it on an already-uploaded GPU texture provably does nothing. `repeat` would be wrong
    // for every file here (a lone object's edge would sample its own far side), so its
    // absence is asserted too rather than left to chance.
    const calls: unknown[] = [];
    const pixi = await import('pixi.js');
    const spy = vi.spyOn(pixi.Assets, 'load').mockImplementation(async (opts: unknown) => {
      calls.push(opts);
      throw new Error('no asset server in this test environment');
    });
    try {
      await preloadEnvironmentSprites();
    } finally {
      spy.mockRestore();
    }
    expect(calls.length).toBe(ENV_SPRITE_ASSET_KEYS.length);
    for (const call of calls) {
      const opt = call as { src?: string; data?: Record<string, unknown> };
      expect(opt.src).toMatch(/^\/environment\/.+\.png$/);
      expect(opt.data?.autoGenerateMipmaps).toBe(true);
      expect(opt.data?.addressMode).toBeUndefined();
    }
  });
});
