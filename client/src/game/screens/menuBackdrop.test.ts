/**
 * Every full-screen menu outside the lobby draws the lobby painting, dimmed (design/10 "One
 * shell for every menu", 2026-09-27), and moves it only while it is the screen on show.
 *
 * Two properties, each checked on every screen by the same list `menuCoversWorld.test.ts`
 * uses: the backdrop IS the dimmed lobby painting (not the retired hub art under a scrim), and
 * `animate` drives it while the screen is visible and never while it is hidden — ten screens
 * share the main loop's `menuScreens` list, and all but one are hidden on any frame.
 */
import { describe, it, expect, vi } from 'vitest';
import { installFakeTextCanvas } from './fakeTextCanvas';
import { LobbyBackdrop } from '../ui/LobbyBackdrop';
import { MENU_BACKDROP_DIM } from '../ui/menuTheme';
import { Forge } from './Forge';
import { Loadout } from './Loadout';
import { LoginScreen } from './LoginScreen';
import { Matchmaking } from './Matchmaking';
import { PartyScreen } from './PartyScreen';
import { PauseMenu } from './PauseMenu';
import { PvpPreview } from './PvpPreview';
import { Screens } from './Screens';
import { Settings } from './Settings';
import { StoreScreen } from './StoreScreen';
import { StorePurchase } from '../controllers/StorePurchase';

installFakeTextCanvas();

interface MenuScreen {
  view: { visible: boolean };
  animate(dtMs: number): void;
}

const SCREENS: Array<[string, () => MenuScreen]> = [
  ['Forge', () => new Forge()],
  ['Loadout', () => new Loadout()],
  ['PvpPreview', () => new PvpPreview()],
  ['Matchmaking', () => new Matchmaking()],
  ['PauseMenu', () => new PauseMenu()],
  ['Screens', () => new Screens()],
  ['Settings', () => new Settings()],
  ['PartyScreen', () => new PartyScreen({ matchBaseUrl: '' })],
  ['LoginScreen', () => new LoginScreen({ matchBaseUrl: '' })],
  ['StoreScreen', () => new StoreScreen(new StorePurchase({
    baseUrl: () => '', platform: () => null, refreshOwnership: async () => {}, sleep: async () => {},
  }))],
];

function backdropOf(screen: MenuScreen): LobbyBackdrop {
  return (screen as unknown as { panel: LobbyBackdrop }).panel;
}

describe.each(SCREENS)('%s — the menu backdrop', (_name, build) => {
  it('is the lobby painting, dimmed', () => {
    const backdrop = backdropOf(build());
    expect(backdrop).toBeInstanceOf(LobbyBackdrop);
    expect((backdrop as unknown as { dim: number }).dim).toBe(MENU_BACKDROP_DIM);
  });

  it('moves while the screen is up, and not while it is hidden', () => {
    const screen = build();
    const spy = vi.spyOn(backdropOf(screen), 'update');
    screen.view.visible = false;
    screen.animate(16);
    expect(spy).not.toHaveBeenCalled();
    screen.view.visible = true;
    screen.animate(16);
    expect(spy).toHaveBeenCalledWith(16);
  });
});
