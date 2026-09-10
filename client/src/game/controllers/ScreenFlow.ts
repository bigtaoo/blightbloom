import type { Container } from 'pixi.js';
import type { Button } from '../ui/widgets';
import type { MainMenu } from '../screens/MainMenu';
import type { PvpPreview } from '../screens/PvpPreview';
import type { Matchmaking, MatchmakingConnect } from '../screens/Matchmaking';
import type { PartyScreen } from '../screens/PartyScreen';
import type { LoginScreen } from '../screens/LoginScreen';
import type { Forge } from '../screens/Forge';
import type { StoreScreen } from '../screens/StoreScreen';
import type { Screens } from '../screens/Screens';
import type { Settings } from '../screens/Settings';
import type { PauseMenu } from '../screens/PauseMenu';
import type { MetaState } from '../../meta';
import type { SettingsState } from '../../settings';

/** Every full-screen overlay widget + the in-run HUD's own visibility root, plus the
 * forge-only floating SETTINGS button — everything a screen transition hides/shows.
 * Constructed once, in `Game.start()`, after every widget it references exists
 * (`partyScreen`/`loginScreen`/`settingsBtn` are built there too, needing the
 * post-query-param-override `matchBaseUrl` — see Game.ts's own field comments). */
export interface ScreenFlowWidgets {
  mainMenu: MainMenu;
  pvpPreview: PvpPreview;
  matchmaking: Matchmaking;
  partyScreen: PartyScreen;
  loginScreen: LoginScreen;
  forge: Forge;
  storeScreen: StoreScreen;
  screens: Screens;
  settingsScreen: Settings;
  pauseMenu: PauseMenu;
  settingsBtn: Button;
  hudView: Container;
}

/**
 * Screen-transition widget orchestration ("hide every other full-screen overlay, show
 * this one"), split out of Game.ts (CLAUDE.md "500-line file convention", form ② —
 * independent class + composition). Deliberately NOT a `phase` authority and never
 * calls back into Game: `Game` still owns `phase` (read by the main loop/run
 * lifecycle/forge actions equally — no single concern owns it more than the others)
 * and its own thin `showX()` wrappers set `phase` then delegate the widget mechanics
 * here, passing whatever this needs (selected skin, recommend-tutorial flag, the
 * matchmaking connect function, …) as plain parameters. This is a pure mover of the
 * exact pre-split method bodies — including their per-screen asymmetries (`showSquad`
 * never hides `partyScreen` since that's what it shows; `showForge` is the only one
 * that turns the SETTINGS button ON) — preserved verbatim, not generalized into a
 * single "hide everything except X" helper, since collapsing those asymmetries would
 * be a behavior change disguised as a refactor.
 */
export class ScreenFlow {
  constructor(private readonly w: ScreenFlowWidgets) {}

  showMenu(width: number, height: number, recommendTutorial: boolean): void {
    this.w.hudView.visible = false;
    this.w.pvpPreview.hide();
    this.w.matchmaking.hide();
    this.w.forge.hide();
    this.w.screens.hide();
    this.w.settingsScreen.hide();
    this.w.partyScreen.hide();
    this.w.loginScreen.hide();
    this.w.storeScreen.hide();
    this.w.settingsBtn.view.visible = false;
    // The tutorial badge rode in on `showModeSelect` before the 2026-09-10 merge; the route
    // it belongs to is a row in this screen now, so the flag comes here instead.
    this.w.mainMenu.setRecommendTutorial(recommendTutorial);
    this.w.mainMenu.show(width, height);
  }

  showPvpPreview(width: number, height: number, selectedSkinId: string): void {
    this.w.hudView.visible = false;
    this.w.mainMenu.hide();
    this.w.matchmaking.hide();
    this.w.forge.hide();
    this.w.screens.hide();
    this.w.settingsScreen.hide();
    this.w.partyScreen.hide();
    this.w.loginScreen.hide();
    this.w.storeScreen.hide();
    this.w.settingsBtn.view.visible = false;
    this.w.pvpPreview.show(width, height, selectedSkinId);
  }

  showSquad(width: number, height: number): void {
    this.w.hudView.visible = false;
    this.w.mainMenu.hide();
    this.w.pvpPreview.hide();
    this.w.matchmaking.hide();
    this.w.forge.hide();
    this.w.screens.hide();
    this.w.settingsScreen.hide();
    this.w.loginScreen.hide();
    this.w.storeScreen.hide();
    this.w.partyScreen.show(width, height);
  }

  showAccount(width: number, height: number): void {
    this.w.hudView.visible = false;
    this.w.mainMenu.hide();
    this.w.pvpPreview.hide();
    this.w.matchmaking.hide();
    this.w.forge.hide();
    this.w.screens.hide();
    this.w.settingsScreen.hide();
    this.w.partyScreen.hide();
    this.w.storeScreen.hide();
    this.w.loginScreen.show(width, height);
  }

  showMatchmaking(width: number, height: number, connect: MatchmakingConnect): void {
    this.w.hudView.visible = false;
    this.w.mainMenu.hide();
    this.w.pvpPreview.hide();
    this.w.forge.hide();
    this.w.screens.hide();
    this.w.settingsScreen.hide();
    this.w.partyScreen.hide();
    this.w.loginScreen.hide();
    this.w.storeScreen.hide();
    this.w.matchmaking.show(width, height, connect);
  }

  /** The store (design/19 §4). Reached only from the forge, and it hides the forge like any
   * other full screen — the SETTINGS button goes dark with it, since that button is
   * forge-only and would otherwise float over a purchase screen it cannot return from. */
  showStore(width: number, height: number, meta: MetaState): void {
    this.w.hudView.visible = false;
    this.w.mainMenu.hide();
    this.w.pvpPreview.hide();
    this.w.matchmaking.hide();
    this.w.forge.hide();
    this.w.screens.hide();
    this.w.settingsScreen.hide();
    this.w.partyScreen.hide();
    this.w.loginScreen.hide();
    this.w.settingsBtn.view.visible = false;
    this.w.storeScreen.show(width, height, meta);
  }

  showForge(width: number, height: number, meta: MetaState): void {
    this.w.hudView.visible = false;
    this.w.mainMenu.hide();
    this.w.pvpPreview.hide();
    this.w.matchmaking.hide();
    this.w.screens.hide();
    this.w.settingsScreen.hide();
    this.w.partyScreen.hide();
    this.w.loginScreen.hide();
    this.w.storeScreen.hide();
    this.w.forge.render(meta, width, height);
    this.w.settingsBtn.view.position.set(width - 130, height - 50);
    this.w.settingsBtn.view.visible = true;
  }

  /** Only reachable from the forge/menu phases (Game's own `openSettings()` guards
   * this) — hides just the two screens that can be showing at that point, matching
   * the pre-split behavior exactly (this never touched matchmaking/squad/account/etc.,
   * since none of those phases can open settings). */
  openSettings(width: number, height: number, settings: SettingsState): void {
    this.w.forge.hide();
    this.w.mainMenu.hide();
    this.w.settingsBtn.view.visible = false;
    this.w.settingsScreen.show(width, height, settings);
  }

  pause(width: number, height: number, skipLabel: string | undefined, savable: boolean): void {
    this.w.pauseMenu.show(width, height, skipLabel, savable);
  }

  resume(): void {
    this.w.pauseMenu.hide();
  }

  openSettingsFromPause(width: number, height: number, settings: SettingsState): void {
    this.w.pauseMenu.hide();
    this.w.settingsScreen.show(width, height, settings);
  }

  openPauseFromSettings(width: number, height: number, skipLabel: string | undefined, savable: boolean): void {
    this.w.settingsScreen.hide();
    this.w.pauseMenu.show(width, height, skipLabel, savable);
  }

  /** `resetRunRenderState`'s one settings-button touch (Game.ts) — a fresh run always
   * starts from the forge, so the button (forge-only) must go dark. */
  hideSettingsButton(): void {
    this.w.settingsBtn.view.visible = false;
  }

  /** The forge-phase settings-button reposition `relayoutViewport` does on every
   * resize — kept separate from `showForge`'s own positioning call since a resize
   * must reposition without re-rendering the whole forge screen. */
  repositionSettingsButtonIfForge(isForgePhase: boolean, width: number, height: number): void {
    if (isForgePhase) this.w.settingsBtn.view.position.set(width - 130, height - 50);
  }
}
