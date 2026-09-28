/**
 * Every menu screen takes its button icons through `whenUiTexture` (2026-09-28), because the
 * boot no longer waits for them: only the `boot` UI tier is in when `Game` builds its screens,
 * and the rest land while the player sits in the lobby. So the case this file is about is the
 * one a real boot hits and no other screen test does — the screen is built BEFORE its icons
 * exist, and has to gain each one, on the right button, when it arrives.
 *
 * The other screen tests cannot see it: they build against a uiSkins with nothing loaded and
 * never land anything, so a `whenUiTexture` call swapped back to `getUiTexture` (which reads
 * once, at construction, and gets `undefined`) leaves every one of them green.
 *
 * Each landed key gets its OWN texture, labelled with the key, so the assertion is which icon
 * sits where, not merely how many sprites appeared.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Assets, Container, Sprite, Texture } from 'pixi.js';
import { PauseMenu } from './PauseMenu';
import { Settings } from './Settings';
import { LoginScreen, type AuthApi } from './LoginScreen';
import { PartyScreen, type PartyApi } from './PartyScreen';
import { Loadout } from './Loadout';
import { LobbyRoutes } from '../ui/LobbyRoutes';
import { MenuShell } from '../ui/MenuShell';
import { preloadUiTier, resetUiSkinsForTests, UI_ASSETS, UI_ASSET_KEYS } from '../../render/uiSkins';
import { installFakeTextCanvas } from './fakeTextCanvas';

installFakeTextCanvas();

/** The button icons, and nothing else: the painting, the banners and the menu background are
 *  drawn by other paths, and landing them would only add sprites this file does not track. */
const ICON_KEYS = UI_ASSET_KEYS.filter((k) => k.startsWith('icon_') || k === 'npc_forger');

/** Land every icon key through the real tier loaders, each as its own labelled texture. */
async function landIcons(): Promise<void> {
  const keyOf = new Map(ICON_KEYS.map((k) => [UI_ASSETS[k], k]));
  const spy = vi.spyOn(Assets, 'load').mockImplementation(async (opts: unknown) => {
    const key = keyOf.get((opts as { src: string }).src);
    if (!key) throw new Error('not an icon');
    return new Texture({ source: Texture.WHITE.source, label: key }) as never;
  });
  try {
    await Promise.all([preloadUiTier('boot'), preloadUiTier('lobby'), preloadUiTier('late')]);
  } finally {
    spy.mockRestore();
  }
}

/** The label of every icon sprite under `root`, sorted — duplicates kept, since two buttons
 *  sharing one icon (`icon_play` on RESUME and SAVE & QUIT) is two icons, not one. */
function iconsUnder(root: Container): string[] {
  const out: string[] = [];
  const walk = (c: Container): void => {
    if (c instanceof Sprite && ICON_KEYS.includes(c.texture.label ?? '')) out.push(c.texture.label!);
    for (const child of c.children) walk(child);
  };
  walk(root);
  return out.sort();
}

const authApi = (): AuthApi => ({ register: vi.fn(), login: vi.fn(), logout: vi.fn(), changePassword: vi.fn() });
const partyApi = (): PartyApi => ({
  createParty: vi.fn(), joinParty: vi.fn(), leaveParty: vi.fn(), startPartyMatching: vi.fn(), getParty: vi.fn(),
});

// Built fresh inside each case, AFTER the reset: the whole point is a screen that predates its art.
// `open` is what the player does next — shows the screen — for the one screen that draws an icon
// on each show rather than through `whenUiTexture`.
const SCREENS: Array<{ name: string; build: () => { view: Container }; icons: string[]; open?: (s: never) => void }> = [
  { name: 'MenuShell', build: () => new MenuShell({ title: 'T', back: 'BACK' }), icons: ['icon_back'] },
  { name: 'PauseMenu', build: () => new PauseMenu(), icons: ['icon_back', 'icon_play', 'icon_play', 'icon_quit', 'icon_settings'] },
  { name: 'Settings', build: () => new Settings(), icons: ['icon_back', 'icon_play'] },
  {
    name: 'LoginScreen',
    build: () => new LoginScreen({ matchBaseUrl: 'http://mm', api: authApi() }),
    // Two `icon_account`s: the LOGIN tab, and the guest avatar's glyph. The avatar re-reads its
    // glyph on every `refresh()` (each show, each sign-in change) rather than subscribing, which
    // holds because `icon_account` is a `boot` key — in before any screen exists, pinned in
    // `uiSkins.test.ts`. Here it lands late, so it shows from the next open, not at once.
    icons: ['icon_account', 'icon_account', 'icon_back', 'icon_logout', 'icon_password', 'icon_register'],
    open: (s: LoginScreen) => s.show(800, 600),
  },
  {
    name: 'PartyScreen',
    build: () => new PartyScreen({ matchBaseUrl: 'http://mm', playerId: 'me', api: partyApi() }),
    icons: ['icon_back', 'icon_party_create', 'icon_party_create', 'icon_party_join', 'icon_party_leave', 'icon_play'],
  },
  { name: 'Loadout', build: () => new Loadout(), icons: ['icon_back', 'icon_clear', 'icon_play', 'icon_play'] },
  { name: 'LobbyRoutes', build: () => new LobbyRoutes(), icons: ['icon_account', 'icon_party_create', 'npc_forger'] },
];

beforeEach(() => resetUiSkinsForTests());
afterEach(() => resetUiSkinsForTests());

describe('menu screens built before their icons exist', () => {
  it.each(SCREENS)('$name gains every icon, on its own button, when the icons land', async ({ build, icons, open }) => {
    const screen = build();
    // The control: at construction there is nothing to draw, so a screen that reads its icons
    // once, there, would stop here for good.
    expect(iconsUnder(screen.view)).toEqual([]);
    await landIcons();
    open?.(screen as never);
    expect(iconsUnder(screen.view)).toEqual(icons);
  });

  it('draws the icons at once when they are already in — the second screen of a session', async () => {
    await landIcons();
    for (const { name, build, icons } of SCREENS) expect(iconsUnder(build().view), name).toEqual(icons);
  });
});
