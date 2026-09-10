/**
 * UI sound, end to end through `Game` (2026-08-30).
 *
 * The unit tests either side of this one cover the sink (`audio/uiSound.test.ts`), the
 * widgets that fire it (`ui/widgets.test.ts`) and the one controller that chooses a cue from
 * an outcome (`controllers/ForgeActions.test.ts`). What none of them can see is whether the
 * screens the GAME builds are the ones carrying those widgets: which button on which screen
 * got which cue is a per-call-site decision spread across ~14 files, and getting it wrong is
 * inaudible in the only place it matters (forward and back sounding alike on a phone, where
 * they are the same finger in nearly the same place).
 *
 * So each case here presses a REAL button on a REAL screen that `Game` built. The remaining
 * link — boot attaching the bus at all — is a source-level guard in
 * `audio/audioPipeline.test.ts`, next to the one on `audio.preload()`, since both entries are
 * top-level `boot()` scripts with no seam to test through.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { Container } from 'pixi.js';
import { installFakeTextCanvas } from './screens/fakeTextCanvas';
import { Game } from './Game';
import { setUiAudio } from '../audio/uiSound';
import type { AudioCue } from '../platform/types';

installFakeTextCanvas();

// `boot()` is what attaches the sink in the real app (see this file's header); here each
// case attaches its own recorder and detaches after, so no other file's screens can play
// into this one's bus.
afterEach(() => setUiAudio(null));

const NO_TOUCH = {
  active: false, stickRadius: 0, move: null,
  fire: { cx: 0, cy: 0, r: 0, pressed: false },
  weapon1: { cx: 0, cy: 0, r: 0 }, weapon2: { cx: 0, cy: 0, r: 0 },
  interact: { cx: 0, cy: 0, r: 0, pressed: false },
};

/** Same minimal app shape the other Game tests use (gameQuality/gameViewport). */
function fakeApp() {
  const screen = { width: 1280, height: 720 };
  return {
    stage: new Container(),
    renderer: { screen, resolution: 1, resize: () => {} },
    ticker: { add: () => {}, remove: () => {} },
    canvas: {},
  } as unknown as ConstructorParameters<typeof Game>[0];
}

/** A tappable widget, however deeply private it is on its screen. */
interface Tappable { view: { emit: (event: string) => void } }
interface PickupItem { id: number; weaponId?: string }
interface GameScreens {
  mainMenu: { playBtn: Tappable; settingsBtn: Tappable; routes: { soloBtn: Tappable } };
  settingsScreen: { muteBtn: Tappable; backBtn: Tappable };
  forge: { backBtn: Tappable; startBtn: Tappable; storeBtn: Tappable; rowCards: Tappable[] };
  pauseMenu: { resumeBtn: Tappable };
  hud: { pauseBtn: Tappable; weaponPickupPrompt: {
    closeBtn: Tappable;
    rows: Tappable[];
    update(nearby: readonly PickupItem[]): void;
  } };
  screens: { confirmBtn: Tappable; menuBtn: Tappable };
  portalPrompt: { extractBtn: Tappable; descendBtn: Tappable };
}

function newGame() {
  const cues: AudioCue[] = [];
  const game = new Game(
    fakeApp(),
    {
      onSwitchWeapon: null,
      attach: () => {},
      read: () => ({ moveX: 0, moveY: 0, firing: false, interacting: false }),
      getTouchVisual: () => NO_TOUCH,
      setControlMirror: () => {},
    } as never,
    {
      preload: async () => {},
      play: (cue: AudioCue) => { cues.push(cue); },
      setSfxVolume: () => {}, setMusicVolume: () => {}, updateMusic: () => {}, invalidateMusic: () => {}, resume: () => {},
    } as never,
  );
  setUiAudio({
    preload: async () => {},
    play: (cue: AudioCue) => { cues.push(cue); },
    setSfxVolume: () => {}, setMusicVolume: () => {}, updateMusic: () => {}, invalidateMusic: () => {}, resume: () => {},
  });
  game.start();
  return { game, cues, screens: game as unknown as GameScreens };
}

const tap = (w: Tappable) => w.view.emit('pointertap');

describe('Game — every screen it builds carries the right UI cue', () => {
  it('plays ui.tap for the lobby’s primary action', () => {
    // SOLO since the 2026-09-10 merge — and it lives on the composed `LobbyRoutes` widget,
    // which is the half of the lobby a Game-level test can most easily miss.
    const { cues, screens } = newGame();
    tap(screens.mainMenu.routes.soloBtn);
    expect(cues).toEqual(['ui.tap']);
  });

  it('plays ui.back for the button that leaves a screen', () => {
    // The distinction is the point of having two cues: forward and back must not sound alike,
    // because on a small screen they are often the same finger in nearly the same place.
    const { cues, screens } = newGame();
    tap(screens.settingsScreen.backBtn);
    tap(screens.forge.backBtn);
    tap(screens.pauseMenu.resumeBtn); // dismissing the pause overlay is also "leaving"
    expect(cues).toEqual(['ui.back', 'ui.back', 'ui.back']);
  });

  it('plays ui.toggle for a settings option, and ui.back for its exit', () => {
    const { cues, screens } = newGame();
    tap(screens.settingsScreen.muteBtn);
    tap(screens.settingsScreen.backBtn);
    expect(cues).toEqual(['ui.toggle', 'ui.back']);
  });

  it('sounds the in-run HUD too, not just the menus', () => {
    // The pause button is pressed mid-fight, which is exactly when a press that makes no
    // sound reads as a missed input (its catalogue priority is set above every combat cue for
    // the same reason).
    const { cues, screens } = newGame();
    tap(screens.hud.pauseBtn);
    expect(cues).toEqual(['ui.tap']);
  });

  it('lets the forge’s own transactions decide, instead of the widget', () => {
    // A blueprint card is built with no sound of its own, because only the craft transaction
    // knows whether the press did anything. A fresh account has an empty material bank, so
    // every card on the first page is unaffordable and the press must say so — `ui.denied` is
    // what separates "that did nothing" from "the game never saw your finger".
    const { cues, screens } = newGame();
    tap(screens.forge.rowCards[0]!);
    expect(cues).toEqual(['ui.denied']);
  });

  it('the forge’s STORE button is an ordinary forward press — it grants nothing', () => {
    // This button used to BE the transaction (`acquireBtn`, the `demo: free grant` scaffold),
    // which is why it was `silent`. It now opens a screen, and opening a screen always does
    // something, so there is no outcome left for a silent widget to wait on. The cues that
    // depend on a transaction moved one screen in, onto the store's own rows.
    const { cues, screens } = newGame();
    tap(screens.forge.storeBtn);
    expect(cues).toEqual(['ui.tap']);
  });

  it('sounds the extract/descend commit design/11 names by hand', () => {
    // The doc's UI-cue list is "button tap, screen transition, extract/descend commit, result
    // screen". The commit is the moment a run's whole take is banked or gambled, and it is the
    // one prompt reached mid-run with a thumb rather than from a menu.
    const { cues, screens } = newGame();
    tap(screens.portalPrompt.extractBtn);
    tap(screens.portalPrompt.descendBtn);
    expect(cues).toEqual(['ui.tap', 'ui.tap']);
  });

  it('sounds the result screen — the other moment on that list', () => {
    const { cues, screens } = newGame();
    tap(screens.screens.confirmBtn);
    tap(screens.screens.menuBtn); // the secondary exit is a "leaving" press
    expect(cues).toEqual(['ui.tap', 'ui.back']);
  });

  it('sounds a weapon-pickup row, which is built at runtime rather than in a constructor', () => {
    // These rows are `new Button(...)` inside a rebuild loop, not a field — so they are the one
    // family of buttons that a constructor-reading review (or the source sweep in
    // `buttonCueConventions.test.ts`) would see differently from how they actually behave.
    const { cues, screens } = newGame();
    const prompt = screens.hud.weaponPickupPrompt;
    prompt.update([{ id: 1, weaponId: 'repeater' }]);
    expect(prompt.rows).toHaveLength(1);
    tap(prompt.rows[0]!);
    tap(prompt.closeBtn);
    expect(cues).toEqual(['ui.tap', 'ui.back']);
  });

  it('every screen Game builds reaches the sink — none is silently unwired', () => {
    const { cues, screens } = newGame();
    for (const btn of [
      screens.mainMenu.settingsBtn, screens.mainMenu.routes.soloBtn,
      screens.settingsScreen.muteBtn, screens.forge.startBtn, screens.hud.pauseBtn,
    ]) tap(btn);
    expect(cues).toHaveLength(5);
  });
});
