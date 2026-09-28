/**
 * uiSkins.ts's best-effort asset registry (design/13 UI-art pass). `getUiTexture`
 * intentionally returns `undefined` identically whether a key was never registered
 * OR was registered but its file hasn't loaded (no network server in this test env,
 * so every `Assets.load` call rejects and is swallowed) — that's the "missing art
 * never blocks boot" contract every menu screen relies on. `UI_ASSET_KEYS` is the
 * one thing this file CAN assert precisely: that a given key is actually wired into
 * the registry, independent of whether its PNG exists yet.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Texture } from 'pixi.js';
import { FLOOR_CARD_IDS } from '@dd/engine';
import {
  preloadUiArt, preloadUiTier, getUiTexture, whenUiTexture, onUiTexture, uiTierOf, uiUsesMipmaps,
  resetUiSkinsForTests, UI_ASSETS, UI_ASSET_KEYS,
} from './uiSkins';

// The 2026-08 icon pass (LoginScreen/PauseMenu/PartyScreen/Forge) + the Forger NPC
// sprite — the exact set this session's icon/biome/npc wiring added.
const NEW_KEYS = [
  'icon_register', 'icon_password', 'icon_logout', 'icon_back', 'icon_quit',
  'icon_party_create', 'icon_party_join', 'icon_party_leave', 'icon_clear',
  'npc_forger',
];

describe('uiSkins — asset registry', () => {
  it('has every 2026-08 icon/npc key registered', () => {
    for (const key of NEW_KEYS) expect(UI_ASSET_KEYS).toContain(key);
  });

  it('still has the earlier hub/icon keys registered (no accidental drop)', () => {
    for (const key of ['hub', 'icon_play', 'icon_squad', 'icon_account', 'icon_settings']) {
      expect(UI_ASSET_KEYS).toContain(key);
    }
  });

  it('has an icon key for every floor card the engine can offer', () => {
    // A consistency gate, not a spot check (design/18): `FloorCardPrompt` looks its art up
    // as `icon_card_${id}` straight off the offer, and a card added to the engine catalogue
    // with no key here would draw text-only forever — the fallback is silent by design, so
    // nothing else would ever go red. Read a failure as "generate the icon and wire it",
    // never as "loosen this".
    for (const id of FLOOR_CARD_IDS) expect(UI_ASSET_KEYS).toContain(`icon_card_${id}`);
  });

  it('getUiTexture returns undefined for an unregistered key', () => {
    expect(getUiTexture('not_a_real_key')).toBeUndefined();
  });
});

describe('uiSkins — preloadUiArt never throws (missing/unreachable art must not block boot)', () => {
  it('resolves cleanly even though no asset server exists in this test environment', async () => {
    await expect(preloadUiArt()).resolves.toBeUndefined();
    // Every registered key still falls back to undefined — confirms the per-asset
    // try/catch swallowed the failed load instead of leaving a half-thrown state.
    for (const key of UI_ASSET_KEYS) expect(getUiTexture(key)).toBeUndefined();
  });
});

describe('uiSkins — every texture is loaded WITH a mip chain, bar the named few', () => {
  it('asks for autoGenerateMipmaps per its key, and never for repeat addressing', async () => {
    // Every icon here is a 208-256 px lone object drawn into a button or badge a fraction of
    // that size. Same rule and same reason as `weaponSkins`/`environmentSprites`/the sprite
    // keys in `biomeTiles`; this loader was simply the last one still passing a bare url,
    // found by auditing all of them at once (2026-08-24) rather than one report at a time.
    // The exceptions (2026-09-28) are art that is only ever MAGNIFIED — see `uiUsesMipmaps`.
    const calls: Array<{ src?: string; data?: Record<string, unknown> }> = [];
    const pixi = await import('pixi.js');
    const spy = vi.spyOn(pixi.Assets, 'load').mockImplementation(async (opts: unknown) => {
      calls.push(opts as { src?: string; data?: Record<string, unknown> });
      throw new Error('no asset server in this test environment');
    });
    resetUiSkinsForTests();
    try {
      await preloadUiArt();
    } finally {
      spy.mockRestore();
      resetUiSkinsForTests();
    }
    expect(calls.length).toBe(UI_ASSET_KEYS.length);
    const keyOf = new Map(Object.entries(UI_ASSETS).map(([k, p]) => [p, k]));
    for (const opt of calls) {
      expect(typeof opt).toBe('object');
      // PNG, or JPEG for OPAQUE art (the lobby painting and route banners, 2026-09-27; the
      // menu background, 2026-09-28) — never anything else a platform might not decode.
      expect(opt.src).toMatch(/^\/ui\/.+\.(png|jpg)$/);
      if (opt.src!.endsWith('.jpg')) expect(opt.src).toMatch(/^\/ui\/(lobby_(bg|card_\w+)|hub_bg)\.jpg$/);
      const key = keyOf.get(opt.src!)!;
      expect(opt.data?.autoGenerateMipmaps, key).toBe(uiUsesMipmaps(key));
      expect(opt.data?.addressMode).toBeUndefined();
    }
    // The exception list is what it says, and short: an icon slipping into it is a shimmer bug.
    expect(UI_ASSET_KEYS.filter((k) => !uiUsesMipmaps(k))).toEqual(['hub']);
  });
});

describe('uiSkins — load tiers (2026-09-28)', () => {
  const fileSize = (path: string) => statSync(fileURLToPath(new URL(`../../public${path}`, import.meta.url))).size;

  it('keeps the tier the boot waits for small, in bytes, off the real files', () => {
    // The point of the tiers: `preloadLobbyArt` awaits `boot` alone. Measured on the shipped
    // files so a heavy image moved into `boot` fails here rather than on a player's phone.
    // 500 kB is headroom over the ~440 kB it weighs today, not a target.
    const bytes = UI_ASSET_KEYS.filter((k) => uiTierOf(k) === 'boot').reduce((sum, k) => sum + fileSize(UI_ASSETS[k]!), 0);
    expect(bytes).toBeGreaterThan(100_000); // a sweep over nothing proves nothing
    expect(bytes).toBeLessThan(500_000);
  });

  it('puts every lobby BUTTON icon in `boot`, so no lobby label re-flows on arrival', () => {
    for (const key of ['icon_account', 'icon_settings', 'icon_party_create', 'npc_forger']) {
      expect(uiTierOf(key), key).toBe('boot');
    }
    // The menu background (Panel's 'hub') and the painting are the first frame itself.
    expect(uiTierOf('hub')).toBe('boot');
    expect(uiTierOf('lobby_bg')).toBe('boot');
  });

  it('files an unknown key under `late`, the direction that cannot lengthen the boot', () => {
    expect(uiTierOf('a_key_added_tomorrow')).toBe('late');
  });

  it('loads only the asked tier, once, however often it is asked', async () => {
    const srcs: string[] = [];
    const pixi = await import('pixi.js');
    const spy = vi.spyOn(pixi.Assets, 'load').mockImplementation(async (opts: unknown) => {
      srcs.push((opts as { src: string }).src);
      return Texture.WHITE as never;
    });
    resetUiSkinsForTests();
    try {
      const first = preloadUiTier('boot');
      expect(preloadUiTier('boot')).toBe(first); // memoised on the promise
      await first;
      await preloadUiTier('boot');
    } finally {
      spy.mockRestore();
    }
    const boot = UI_ASSET_KEYS.filter((k) => uiTierOf(k) === 'boot');
    expect(srcs.sort()).toEqual(boot.map((k) => UI_ASSETS[k]).sort());
    for (const key of boot) expect(getUiTexture(key)).toBe(Texture.WHITE);
    const other = UI_ASSET_KEYS.find((k) => uiTierOf(k) === 'late')!;
    expect(getUiTexture(other)).toBeUndefined();
    resetUiSkinsForTests();
  });
});

describe('uiSkins — whenUiTexture / onUiTexture', () => {
  async function landing(keys: readonly string[], run: () => Promise<void>): Promise<void> {
    const pixi = await import('pixi.js');
    const spy = vi.spyOn(pixi.Assets, 'load').mockImplementation(async (opts: unknown) => {
      const src = (opts as { src: string }).src;
      if (keys.some((k) => UI_ASSETS[k] === src)) return Texture.WHITE as never;
      throw new Error('not in this test');
    });
    try {
      await run();
    } finally {
      spy.mockRestore();
    }
  }

  it('applies at once when the texture is already in', async () => {
    resetUiSkinsForTests();
    await landing(['hub'], () => preloadUiTier('boot'));
    const apply = vi.fn();
    whenUiTexture('hub', apply);
    expect(apply).toHaveBeenCalledExactlyOnceWith(Texture.WHITE);
    resetUiSkinsForTests();
  });

  it('applies exactly once, on arrival, when asked before it lands — and ignores other keys', async () => {
    resetUiSkinsForTests();
    const apply = vi.fn();
    await landing(['icon_play'], async () => {
      whenUiTexture('icon_back', apply);
      await preloadUiTier('late');
    });
    expect(apply).not.toHaveBeenCalled(); // icon_play landed, icon_back did not
    resetUiSkinsForTests();
    await landing(['icon_back', 'icon_play'], async () => {
      whenUiTexture('icon_back', apply);
      expect(apply).not.toHaveBeenCalled();
      await preloadUiTier('late');
    });
    expect(apply).toHaveBeenCalledExactlyOnceWith(Texture.WHITE);
    resetUiSkinsForTests();
  });

  it('never calls back for a file that fails, and leaves no listener behind once it fires', async () => {
    resetUiSkinsForTests();
    const heard: string[] = [];
    const off = onUiTexture((k) => heard.push(k));
    const apply = vi.fn();
    await landing(['lobby_rock_a'], async () => {
      whenUiTexture('lobby_rock_a', apply);
      whenUiTexture('lobby_rock_b', apply); // fails to load
      await preloadUiTier('lobby');
    });
    expect(apply).toHaveBeenCalledTimes(1);
    expect(heard).toEqual(['lobby_rock_a']);
    off();
    // A second landing of the same key (a reset module, the same file again): the one-shot
    // already fired and the subscription is gone, so neither hears it.
    resetUiSkinsForTests();
    const again = vi.fn();
    onUiTexture(again);
    await landing(['lobby_rock_a'], () => preloadUiTier('lobby'));
    expect(again).toHaveBeenCalledWith('lobby_rock_a'); // the load really happened...
    expect(heard).toEqual(['lobby_rock_a']); // ...and the unsubscribed listener missed it
    expect(apply).toHaveBeenCalledTimes(1);
    resetUiSkinsForTests();
  });
});

describe('uiSkins — the keys the rest of the client asks for', () => {
  it('names no key the registry lacks: a typo waits for a texture that never comes', () => {
    // `whenUiTexture` on an unknown key never fires and never throws, and `getUiTexture` returns
    // the same `undefined` a not-yet-loaded file does — the button just stays text-only, which
    // looks like the art is late, not missing. So sweep every literal key in the source.
    const src = fileURLToPath(new URL('..', import.meta.url));
    const asked = new Map<string, string>();
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (/\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) {
          for (const m of readFileSync(path, 'utf8').matchAll(/(?:getUiTexture|whenUiTexture)\('([^']+)'/g)) asked.set(m[1]!, path);
        }
      }
    };
    walk(src);
    // A sweep over nothing proves nothing: the menu screens alone name over a dozen.
    expect(asked.size).toBeGreaterThan(12);
    for (const [key, where] of asked) expect(UI_ASSET_KEYS, `${key} in ${where}`).toContain(key);
  });
});

describe('uiSkins — the lossy-quantized files stay quantized (2026-09-28)', () => {
  // Re-quantized to a 256-entry palette with libimagequant: a third to a half of their RGBA
  // size. `tools/png-pipeline/compress.mjs` re-inflates any file it touches back to RGBA, and
  // only the `boot` files sit under a byte budget above — the portraits and the weapon are
  // `lobby` tier, so running the compressor over them would triple the lobby's download with
  // nothing red. PNG byte 25 is the IHDR colour type; 3 is indexed.
  const QUANTIZED = [
    'lobby_hero_orb', 'lobby_hero_skirmisher', 'lobby_hero_juggernaut',
    'lobby_logo_en', 'lobby_logo_zh', 'npc_forger', 'lobby_weapon',
  ];

  it.each(QUANTIZED)('%s is an 8-bit palette PNG', (key) => {
    const bytes = readFileSync(fileURLToPath(new URL(`../../public${UI_ASSETS[key]}`, import.meta.url)));
    expect(bytes.subarray(12, 16).toString('latin1')).toBe('IHDR'); // the offset really is the header
    expect(bytes[24], 'bit depth').toBe(8);
    expect(bytes[25], 'colour type').toBe(3);
  });
});
