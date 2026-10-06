// Shared UI chrome art (design/13's still-open "outpost/hub" look) — one background
// image reused behind every menu-shaped screen (MainMenu/LoginScreen/PauseMenu/
// Settings/Screens/Forge/PartyScreen, all built on the same `ui/widgets.ts`
// Panel/Button), plus a handful of button/result icon glyphs. Preloaded best-effort
// like skinRegistry/weaponSkins: a missing or not-yet-generated file just leaves that
// screen on its flat-colour/plain-text fallback (Panel's flat fill, Button's centered
// label) — art never blocks boot or play. See the GPT Image 2 prompts on file for the
// asset list this key set expects.
//
// Loaded in three TIERS (2026-09-28), because the boot used to await all ~40 files (1.65 MB)
// before the first menu frame, and on a slow link that was most of the wait:
//   boot   awaited by `preloadLobbyArt` — what the lobby's first frame cannot do without: the
//          painting, the menu background, both logos, and every icon on a lobby BUTTON (a
//          button that gains its icon later re-flows its label, which reads as a glitch).
//   lobby  kicked the moment `boot` is in, never awaited — the lobby's decoration: portraits,
//          route-card banners, the drifting rocks, the orbiting weapon. Each is a lone image
//          whose absence the lobby already draws (`MainMenu` re-lays itself out on arrival
//          and the pieces fade in).
//   late   after `lobby`, and AWAITED by the run gate (`preloadArt.ts`'s `loadRunArt`) —
//          everything else: the icons of screens off the lobby, and everything a run draws.
//          A menu screen built before its icon lands takes it through `whenUiTexture`.
import { Assets, Texture } from 'pixi.js';
import { resolveAssetUrl } from './assetHost';
import { DAMAGE_DIGITS_PATH } from './damageDigitAtlas';

/** Exported so the WeChat package checks can enumerate the real FILES this loader asks
 *  for — see biomeTiles.ts's BIOME_TILE_ASSETS for the full note. */
export const UI_ASSETS: Readonly<Record<string, string>> = {
  hub: '/ui/hub_bg.jpg',
  icon_play: '/ui/icon_play.png',
  icon_squad: '/ui/icon_squad.png',
  icon_account: '/ui/icon_account.png',
  icon_settings: '/ui/icon_settings.png',
  icon_result_extract: '/ui/icon_result_extract.png',
  icon_result_wiped: '/ui/icon_result_wiped.png',
  // Remaining button icons (2026-08 pass) — LoginScreen/PauseMenu/PartyScreen/Forge.
  // icon_play/icon_account/icon_settings above are REUSED (RESUME/START MATCHING/
  // START RUN, LOGIN, PauseMenu's SETTINGS) rather than duplicated.
  icon_register: '/ui/icon_register.png',
  icon_password: '/ui/icon_password.png',
  icon_logout: '/ui/icon_logout.png',
  icon_back: '/ui/icon_back.png',
  icon_quit: '/ui/icon_quit.png',
  icon_party_create: '/ui/icon_party_create.png',
  icon_party_join: '/ui/icon_party_join.png',
  icon_party_leave: '/ui/icon_party_leave.png',
  icon_clear: '/ui/icon_clear.png',
  // The checkpoint's floor-card offer (2026-09-21) — one per entry in the engine's
  // `FLOOR_CARDS`, keyed `icon_card_<card id>` so `FloorCardPrompt` can look one up from the
  // offer without a second table mapping cards to art. A card whose icon is missing (an id
  // newer than this build, or art not yet generated) draws as it always did: text only.
  icon_card_potion_flow: '/ui/icon_card_potion_flow.png',
  icon_card_windfall: '/ui/icon_card_windfall.png',
  icon_card_edge: '/ui/icon_card_edge.png',
  icon_card_cadence: '/ui/icon_card_cadence.png',
  icon_card_bulwark: '/ui/icon_card_bulwark.png',
  icon_card_precision: '/ui/icon_card_precision.png',
  icon_card_capacitor: '/ui/icon_card_capacitor.png',
  // Task 8 (catalogue expansion, 2026-09-23) — four more cards, same "text-only until
  // art exists" fallback as every entry above.
  icon_card_surge: '/ui/icon_card_surge.png',
  icon_card_aegis: '/ui/icon_card_aegis.png',
  icon_card_stockpile: '/ui/icon_card_stockpile.png',
  icon_card_bounty: '/ui/icon_card_bounty.png',
  // The Forge outpost NPC (design/13's "Outpost/hub" NPC gap — a forger character
  // standing in the loadout screen). Sprite, not a button icon — Forge.ts positions
  // it directly rather than going through Button.setIcon.
  npc_forger: '/ui/npc_forger.png',
  // The floating damage-number digits (design/10, 2026-09-26) — GENERATED, not drawn: see
  // tools/digit-atlas/gen_damage_digits.py and the glyph table it writes beside
  // `render/damageDigitAtlas.ts`. In the lobby pack with the rest of `ui/`, so it is resident
  // long before the first hit; 15 kB.
  damage_digits: DAMAGE_DIGITS_PATH,
  // The lobby redesign (design/10, 2026-09-27) — its painting, the two logos (one per script;
  // `MainMenu` picks by locale), a portrait per playable character (`LobbyHero`) and the three
  // route-card banners (`LobbyRoutes`). The painting and the banners are OPAQUE, so they ship
  // as JPEG: the painting is 187 kB at 1920x1080 as JPEG and would be several MB as PNG, in the
  // one pack the boot waits for. Raws and prompts: `art/ui/lobby_*_raw.png`, `art/ui/prompts.md`.
  lobby_bg: '/ui/lobby_bg.jpg',
  lobby_logo_en: '/ui/lobby_logo_en.png',
  lobby_logo_zh: '/ui/lobby_logo_zh.png',
  lobby_hero_orb: '/ui/lobby_hero_orb.png',
  lobby_hero_skirmisher: '/ui/lobby_hero_skirmisher.png',
  lobby_hero_juggernaut: '/ui/lobby_hero_juggernaut.png',
  lobby_card_descend: '/ui/lobby_card_descend.jpg',
  lobby_card_coop: '/ui/lobby_card_coop.jpg',
  lobby_card_pvp: '/ui/lobby_card_pvp.jpg',
  // The PvE chapter picker's banners (2026-10-06), one per chapter: the same 768x256 opaque
  // JPEG format and flat-cel style as the route cards above, in the chapter's element hue.
  // Raws and prompts: `art/ui/chapter_*_raw.png`, `art/ui/prompts.md`.
  chapter_ember: '/ui/chapter_ember.jpg',
  chapter_frost: '/ui/chapter_frost.jpg',
  chapter_storm: '/ui/chapter_storm.jpg',
  // The painting's three sky rocks, lifted out of it (the sky painted back under them) so
  // `LobbyBackdrop` can drift them. `art/ui/prompts.md`, "The drifting rocks".
  lobby_rock_a: '/ui/lobby_rock_a.png',
  lobby_rock_b: '/ui/lobby_rock_b.png',
  lobby_rock_c: '/ui/lobby_rock_c.png',
  // One weapon orbiting the lobby hero: a copy of `weapons/gun_cryobolt.png`, because the
  // weapon art ships in the `forge` pack, which only arrives at the run phase.
  lobby_weapon: '/ui/lobby_weapon.png',
};

/** When a key loads — see the header. A key not listed in either set is `late`, which is the
 *  safe direction for a new file: it can never silently lengthen the boot. */
export type UiTier = 'boot' | 'lobby' | 'late';

const BOOT_KEYS: ReadonlySet<string> = new Set([
  'lobby_bg', 'hub', 'lobby_logo_en', 'lobby_logo_zh',
  // The lobby's buttons: the corner account/settings pair, and the route column's squad,
  // forge (the forger's portrait) and tutorial tiles.
  'icon_account', 'icon_settings', 'icon_party_create', 'npc_forger',
]);

const LOBBY_KEYS: ReadonlySet<string> = new Set([
  'lobby_hero_orb', 'lobby_hero_skirmisher', 'lobby_hero_juggernaut', 'lobby_weapon',
  'lobby_card_descend', 'lobby_card_coop', 'lobby_card_pvp',
  // The chapter picker's banners — drawn by the lobby, never by its first frame.
  'chapter_ember', 'chapter_frost', 'chapter_storm',
  'lobby_rock_a', 'lobby_rock_b', 'lobby_rock_c',
]);

export function uiTierOf(key: string): UiTier {
  if (BOOT_KEYS.has(key)) return 'boot';
  if (LOBBY_KEYS.has(key)) return 'lobby';
  return 'late';
}

/** The keys loaded without a mip chain. Every one is drawn at or ABOVE its source size on the
 *  screens this game targets (the menu background is a 384 px swatch stretched to the whole
 *  screen), so a chain would be GPU memory and first-frame upload time spent on levels that are
 *  never sampled. Everything else keeps it — see `preloadUiTier`. */
const NO_MIPMAP_KEYS: ReadonlySet<string> = new Set(['hub']);

export function uiUsesMipmaps(key: string): boolean {
  return !NO_MIPMAP_KEYS.has(key);
}

const textures = new Map<string, Texture>();
const tierLoads = new Map<UiTier, Promise<void>>();
const listeners = new Set<(key: string) => void>();

/** Every key `getUiTexture` can resolve once preloaded — exposed so tests can assert
 * a key (e.g. a new icon or `npc_forger`) is actually registered here, since
 * `getUiTexture` itself returns `undefined` identically for both a missing key and a
 * registered key whose file hasn't loaded (network-independent by design). */
export const UI_ASSET_KEYS: readonly string[] = Object.keys(UI_ASSETS);

/**
 * Load one tier. Memoised on the promise, so the boot's kick and the run gate's await share one
 * download; a tier that finished (with whatever failed swallowed) resolves immediately.
 */
export function preloadUiTier(tier: UiTier): Promise<void> {
  let load = tierLoads.get(tier);
  if (!load) {
    load = Promise.all(
      UI_ASSET_KEYS.filter((key) => uiTierOf(key) === tier).map(async (key) => {
        try {
          // Same lone-object rule the weapon/environment/biome-sprite loaders follow: these
          // are 208-256 px sources drawn into buttons and badges a fraction of that size, so
          // without a mip chain they minify off a 2x2 texel neighbourhood. Caught in the same
          // loader audit as `weaponSkins.ts` (2026-08-24). `repeat` stays off — only a
          // tileable swatch wants it, and every file here is a lone object.
          const texture = await Assets.load<Texture>({
            src: resolveAssetUrl(UI_ASSETS[key]),
            data: { autoGenerateMipmaps: uiUsesMipmaps(key) },
          });
          textures.set(key, texture);
          for (const listen of [...listeners]) listen(key);
        } catch {
          // Not generated yet (or failed to fetch) — fine, every consumer already
          // renders correctly without it.
        }
      }),
    ).then(() => undefined);
    tierLoads.set(tier, load);
  }
  return load;
}

/** Every tier, in order, awaited — for callers with no reason to think about tiers. */
export async function preloadUiArt(): Promise<void> {
  await preloadUiTier('boot');
  await preloadUiTier('lobby');
  await preloadUiTier('late');
}

export function getUiTexture(key: string): Texture | undefined {
  return textures.get(key);
}

/**
 * Hand `key`'s texture to `apply` — now if it is loaded, otherwise once, when it lands. For
 * the menu widgets that set their art once, in a constructor that can run before a `lobby` or
 * `late` file has arrived. A file that never loads never calls back, which leaves the widget on
 * the fallback it already draws.
 */
export function whenUiTexture(key: string, apply: (texture: Texture) => void): void {
  const now = textures.get(key);
  if (now) {
    apply(now);
    return;
  }
  const off = onUiTexture((landed) => {
    if (landed !== key) return;
    off();
    apply(textures.get(key)!);
  });
}

/** Told the key of every UI texture as it lands. Returns the unsubscribe. */
export function onUiTexture(listen: (key: string) => void): () => void {
  listeners.add(listen);
  return () => listeners.delete(listen);
}

/** Test-only: module state outlives a single test file. */
export function resetUiSkinsForTests(): void {
  textures.clear();
  tierLoads.clear();
  listeners.clear();
}
