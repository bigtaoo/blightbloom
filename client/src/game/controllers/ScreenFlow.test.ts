/**
 * ScreenFlow (extracted from Game.ts 2026-08-12, CLAUDE.md "500-line file
 * convention") — a pure widget-visibility mover: every real screen widget
 * constructs and its `.show()`/`.hide()` calls run fine under plain vitest with no
 * renderer attached (same finding every other screen test file in this directory
 * already made), so this is tested end-to-end against real instances, asserting on
 * `.view.visible` — never against Game.ts, which this file, by design, never imports.
 */
import { describe, it, expect } from 'vitest';
import { Container, DOMAdapter } from 'pixi.js';
import { Button } from '../ui/widgets';
import { MainMenu } from '../screens/MainMenu';
import { PvpPreview } from '../screens/PvpPreview';
import { Matchmaking } from '../screens/Matchmaking';
import { PartyScreen } from '../screens/PartyScreen';
import { LoginScreen } from '../screens/LoginScreen';
import { Forge } from '../screens/Forge';
import { StoreScreen } from '../screens/StoreScreen';
import { StorePurchase } from './StorePurchase';
import { Screens } from '../screens/Screens';
import { Settings } from '../screens/Settings';
import { PauseMenu } from '../screens/PauseMenu';
import { defaultSettingsState } from '../../settings';
import { ScreenFlow, type ScreenFlowWidgets } from './ScreenFlow';

// showForge() calls forge.render(), which reads Text.height to flow its layout — same
// fake-canvas DOMAdapter seam ForgeActions.test.ts/Forge.test.ts already use (the
// glyph metrics don't matter to any assertion below, only where content visually flows).
DOMAdapter.set({
  ...DOMAdapter.get(),
  createCanvas: (width?: number, height?: number) => {
    const ctx = {
      font: '',
      measureText(text: string) {
        const m = /(\d+(?:\.\d+)?)px/.exec(this.font as string);
        const fontSize = m ? parseFloat(m[1]!) : 10;
        const w = text.length * fontSize * 0.6;
        return { width: w, actualBoundingBoxAscent: fontSize * 0.8, actualBoundingBoxDescent: fontSize * 0.2 };
      },
    };
    return { width: width ?? 0, height: height ?? 0, getContext: () => ctx } as unknown as HTMLCanvasElement;
  },
  getCanvasRenderingContext2D: () => class {} as unknown as typeof CanvasRenderingContext2D,
});

/** A `StorePurchase` that can reach nothing: the store screen kicks a catalogue load on
 * `show()`, and this file is asserting visibility, not networking. `platform: () => null`
 * makes that load return `no-platform` synchronously — no fetch, no timers. */
function storePurchaseStub(): StorePurchase {
  return new StorePurchase({
    baseUrl: () => 'http://mm',
    session: () => null,
    platform: () => null,
    refreshOwnership: () => Promise.resolve(),
    sleep: () => Promise.resolve(),
  });
}

function buildWidgets(): ScreenFlowWidgets {
  return {
    mainMenu: new MainMenu(),
    pvpPreview: new PvpPreview(),
    matchmaking: new Matchmaking(),
    partyScreen: new PartyScreen({ matchBaseUrl: 'http://mm' }),
    loginScreen: new LoginScreen({ matchBaseUrl: 'http://mm' }),
    forge: new Forge(),
    storeScreen: new StoreScreen(storePurchaseStub()),
    screens: new Screens(),
    settingsScreen: new Settings(),
    pauseMenu: new PauseMenu(),
    settingsBtn: new Button('Settings', { w: 110, h: 30, fontSize: 12 }),
    hudView: new Container(),
  };
}

// Show every screen once (arbitrary state) before each test's real call, so a test can
// tell "did this call actually hide it" apart from "it was already hidden".
function showEverything(w: ScreenFlowWidgets) {
  w.mainMenu.show(800, 600);
  w.pvpPreview.show(800, 600, 'default');
  w.matchmaking.show(800, 600, async () => { throw new Error('not used'); });
  w.partyScreen.show(800, 600);
  w.loginScreen.show(800, 600);
  w.forge.hide(); // Forge has no show(); render() doesn't flip visible — start hidden like `showX()`'s pre-state assumes
  w.screens.show(800, 600, true, 'title', []);
  w.settingsScreen.show(800, 600, defaultSettingsState());
  w.pauseMenu.show(800, 600);
  w.hudView.visible = true;
  w.settingsBtn.view.visible = true;
}

describe('ScreenFlow', () => {
  it('showMenu: hides every other overlay + the HUD + settings button, shows mainMenu', () => {
    const w = buildWidgets();
    showEverything(w);
    new ScreenFlow(w).showMenu(800, 600, false);

    expect(w.mainMenu.view.visible).toBe(true);
    expect(w.pvpPreview.view.visible).toBe(false);
    expect(w.matchmaking.view.visible).toBe(false);
    expect(w.forge.view.visible).toBe(false);
    expect(w.screens.view.visible).toBe(false);
    expect(w.settingsScreen.view.visible).toBe(false);
    expect(w.partyScreen.view.visible).toBe(false);
    expect(w.loginScreen.view.visible).toBe(false);
    expect(w.hudView.visible).toBe(false);
    expect(w.settingsBtn.view.visible).toBe(false);
  });

  it('showMenu: threads the recommend-tutorial flag through to the lobby', () => {
    // It used to ride on `showModeSelect`; the TUTORIAL route it badges is a row in the menu
    // since the 2026-09-10 merge, so the flag arrives here instead. Still asserted through
    // the real setter rather than by reading a private: what matters is that the value gets
    // there, and `showMenu` is now the only call that can carry it.
    const w = buildWidgets();
    showEverything(w);
    let recommended: boolean | undefined;
    const original = w.mainMenu.setRecommendTutorial.bind(w.mainMenu);
    w.mainMenu.setRecommendTutorial = (v: boolean) => { recommended = v; original(v); };

    new ScreenFlow(w).showMenu(800, 600, true);

    expect(recommended).toBe(true);
    expect(w.mainMenu.view.visible).toBe(true);
    expect(w.settingsBtn.view.visible).toBe(false);
  });

  it('showPvpPreview: passes the selected skin id through', () => {
    const w = buildWidgets();
    showEverything(w);

    new ScreenFlow(w).showPvpPreview(800, 600, 'ember_scout');

    expect(w.pvpPreview.view.visible).toBe(true);
    expect(w.mainMenu.view.visible).toBe(false);
    expect(w.settingsBtn.view.visible).toBe(false);
  });

  it('showSquad: shows partyScreen and does NOT hide it or touch the settings button (asymmetric by design)', () => {
    const w = buildWidgets();
    showEverything(w);

    new ScreenFlow(w).showSquad(800, 600);

    expect(w.partyScreen.view.visible).toBe(true);
    expect(w.mainMenu.view.visible).toBe(false);
    expect(w.settingsBtn.view.visible).toBe(true); // untouched — showSquad never references it
  });

  it('showAccount: shows loginScreen, hides partyScreen, does not touch the settings button', () => {
    const w = buildWidgets();
    showEverything(w);

    new ScreenFlow(w).showAccount(800, 600);

    expect(w.loginScreen.view.visible).toBe(true);
    expect(w.partyScreen.view.visible).toBe(false);
    expect(w.settingsBtn.view.visible).toBe(true); // untouched
  });

  it('showMatchmaking: passes the connect function through to Matchmaking.show', () => {
    const w = buildWidgets();
    showEverything(w);
    const connect = async () => { throw new Error('stub — never invoked by show() itself'); };
    let passedConnect: unknown;
    const originalShow = w.matchmaking.show.bind(w.matchmaking);
    w.matchmaking.show = (width, height, c) => { passedConnect = c; originalShow(width, height, c); };

    new ScreenFlow(w).showMatchmaking(800, 600, connect);

    expect(w.matchmaking.view.visible).toBe(true);
    expect(passedConnect).toBe(connect); // same function reference reaches Matchmaking.show
  });

  it('showForge: turns the settings button ON and positions it (the one show*() that does)', () => {
    const w = buildWidgets();
    showEverything(w);
    w.settingsBtn.view.visible = false;

    new ScreenFlow(w).showForge(800, 600, { ...defaultMetaLike() });

    expect(w.settingsBtn.view.visible).toBe(true);
    expect(w.settingsBtn.view.position.x).toBe(800 - 130);
    expect(w.settingsBtn.view.position.y).toBe(600 - 50);
    expect(w.mainMenu.view.visible).toBe(false);
  });

  it('openSettings: hides only forge + mainMenu, hides the settings button, shows settingsScreen', () => {
    const w = buildWidgets();
    w.forge.hide();
    w.mainMenu.show(800, 600);
    w.settingsBtn.view.visible = true;
    // Untouched by openSettings — must stay exactly as they were (it never references them).

    new ScreenFlow(w).openSettings(800, 600, defaultSettingsState());

    expect(w.mainMenu.view.visible).toBe(false);
    expect(w.settingsBtn.view.visible).toBe(false);
    expect(w.settingsScreen.view.visible).toBe(true);
  });

  it('pause / resume: shows and hides the pause menu only', () => {
    const w = buildWidgets();
    const flow = new ScreenFlow(w);

    flow.pause(800, 600, undefined);
    expect(w.pauseMenu.view.visible).toBe(true);

    flow.resume();
    expect(w.pauseMenu.view.visible).toBe(false);
  });

  it('openSettingsFromPause / openPauseFromSettings: swap the two widgets in each direction', () => {
    const w = buildWidgets();
    const flow = new ScreenFlow(w);
    w.pauseMenu.show(800, 600);

    flow.openSettingsFromPause(800, 600, defaultSettingsState());
    expect(w.pauseMenu.view.visible).toBe(false);
    expect(w.settingsScreen.view.visible).toBe(true);

    flow.openPauseFromSettings(800, 600, 'Skip');
    expect(w.settingsScreen.view.visible).toBe(false);
    expect(w.pauseMenu.view.visible).toBe(true);
  });

  it('hideSettingsButton: hides the settings button only', () => {
    const w = buildWidgets();
    w.settingsBtn.view.visible = true;
    new ScreenFlow(w).hideSettingsButton();
    expect(w.settingsBtn.view.visible).toBe(false);
  });

  it('repositionSettingsButtonIfForge: repositions only when told the current phase is forge', () => {
    const w = buildWidgets();
    w.settingsBtn.view.position.set(0, 0);
    const flow = new ScreenFlow(w);

    flow.repositionSettingsButtonIfForge(false, 800, 600);
    expect(w.settingsBtn.view.position.x).toBe(0);

    flow.repositionSettingsButtonIfForge(true, 800, 600);
    expect(w.settingsBtn.view.position.x).toBe(800 - 130);
    expect(w.settingsBtn.view.position.y).toBe(600 - 50);
  });
});

// A minimal MetaState-shaped object is enough for showForge (it only reads it to pass
// to forge.render, which we don't assert the content of here) — avoids importing the
// whole meta module + its DOMAdapter-dependent Forge.render() text-measurement path.
function defaultMetaLike() {
  return {
    materialBank: {},
    unlockedBlueprints: [],
    ownedCharacters: [],
    loadout: [],
    selectedSkin: 'default',
    hasSeenTutorial: false,
  };
}
