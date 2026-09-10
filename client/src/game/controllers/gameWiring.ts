// Split out of Game.ts's start(), 2026-09-03 — the callback wiring: which screen's button,
// which HUD control and which key runs which verb.
//
// ## Why this one is free functions rather than a class
//
// CLAUDE.md's split order puts independent function modules first, and this is the shape that
// earns it: there is no state here at all. Every line is one assignment from a widget's
// callback slot to a verb on one of the four controllers, so the whole file is a table — no
// fields, no lifecycle, nothing to construct.
//
// ## What changed about the old argument for keeping it in the shell
//
// Game.ts's file-length note defended this block twice, on the grounds that "fragmenting it
// further would hide the full picture of what connects to what". That was right while the
// verbs it wires were also in the shell — the picture WAS the file. It stopped being true
// once the verbs moved: the block became ninety lines of `this.a.b = () => this.c.d()` in a
// class that no longer owns either side. Moving the table to its own file puts the whole
// picture in one screenful instead of buried in the middle of a 600-line constructor path,
// which is the same thing that argument was protecting.
//
// `keydownAction` is the piece with real behaviour, and it is a PURE function on purpose:
// the key table used to be an `if` chain inside a DOM listener, so the rule that F9 and pause
// are offline-only could not be asserted without a `window`.
import { isPortalHost } from '../../platform/hostKind';
import { setPublicFlagsListener } from '../../net/clientFlags';
import { onSessionChanged } from '../../platform/sessionEvents';
import { setOnlineEntry } from '../../platform/onlineEntry';
import type { InputSource } from '../../platform/types';
import type { CommandBuilder } from './CommandBuilder';
import type { ForgeInput } from './ForgeInput';
import type { OnlineMatch } from './OnlineMatch';
import type { RunLifecycle } from './RunLifecycle';
import type { ScreenNav } from './ScreenNav';
import type { HudView } from '../ui/HudView';
import type { PortalPrompt } from '../ui/PortalPrompt';
import type { FloorCardPrompt } from '../ui/FloorCardPrompt';
import type { MainMenu } from '../screens/MainMenu';
import type { PvpPreview } from '../screens/PvpPreview';
import type { Matchmaking } from '../screens/Matchmaking';
import type { PartyScreen } from '../screens/PartyScreen';
import type { LoginScreen } from '../screens/LoginScreen';
import type { Forge } from '../screens/Forge';
import type { StoreScreen } from '../screens/StoreScreen';
import type { Screens } from '../screens/Screens';
import type { PauseMenu } from '../screens/PauseMenu';
import { shouldSwapToSlot } from './weaponSlotSelect';
import type { RunState } from '../runState';

export interface WiringDeps {
  run: RunState;
  nav: ScreenNav;
  runs: RunLifecycle;
  net: OnlineMatch;
  forgeInput: ForgeInput;
  builder: CommandBuilder;
  input: InputSource;
  hud: HudView;
  portalPrompt: PortalPrompt;
  floorCardPrompt: FloorCardPrompt;
  mainMenu: MainMenu;
  pvpPreview: PvpPreview;
  matchmaking: Matchmaking;
  partyScreen: PartyScreen;
  loginScreen: LoginScreen;
  forge: Forge;
  storeScreen: StoreScreen;
  screens: Screens;
  pauseMenu: PauseMenu;
  /** Confirm — the verb Fire, Enter and the START RUN / result-screen buttons share. */
  confirm: () => void;
  /** The active slot of the local player, or undefined outside a run. */
  activeSlot: () => number | undefined;
}

/** Every screen's own buttons. */
export function wireScreens(d: WiringDeps): void {
  // The lobby's five routes, wired once (design/10's 2026-09-10 merge — they used to be the
  // mode-select screen's four plus this screen's SQUAD). Every one of them hands off to
  // something that already existed; what the merge changed is which screen they are on.
  d.mainMenu.onSolo = () => d.nav.showForge();
  d.mainMenu.onCoop = () => d.net.beginSoloQueue(false);
  d.mainMenu.onPvpSolo = () => d.net.beginSoloQueue(true);
  d.mainMenu.onSquad = () => d.nav.showSquad();
  d.mainMenu.onTutorial = () => d.runs.beginTutorialRun();
  d.mainMenu.onSettings = () => d.nav.openSettings();
  // ...and the one control whose presence depends on the HOST (`platform/hostKind.ts`):
  //
  //   default   no PLAY button at all. SOLO is the primary action and goes to the forge —
  //             the between-run decision this game is built around.
  //   portal    a PLAY button above the routes that starts a run immediately, because the
  //             platform allows a first-time visitor at most one click to gameplay
  //             (`docs.crazygames.com/requirements/gameplay`). Nothing becomes unreachable:
  //             SOLO is still directly below it.
  if (isPortalHost()) {
    d.mainMenu.setQuickPlay(true);
    d.mainMenu.onPlay = () => d.runs.beginQuickRun();
    // ...and no way into the account screen at all. A portal forbids a game's own
    // credential login (`MainMenu.setAccountEntry` has the rules and the citation); the
    // player is signed in silently from the entry point instead, so `onAccount` is left
    // unwired rather than pointed at a screen the platform would reject. `LoginScreen` is
    // still constructed and mounted, exactly as `StoreScreen` is on a build that may not
    // sell — one policy fact, one screen unreachable, no screen with an opinion about it.
    d.mainMenu.setAccountEntry(false);
  } else {
    d.mainMenu.onAccount = () => d.nav.showAccount();
  }
  // The maintenance banner's live half (design/21 §9's delivery path). `show()` already
  // re-reads the flag, so this is only about the player who is ALREADY sitting in the menu
  // when an operator puts a notice up — which is precisely the player a notice about a
  // shutdown in twenty minutes exists for. One slot, set here rather than in an entry
  // point, because this is the layer that has a `mainMenu` to refresh.
  setPublicFlagsListener(() => d.mainMenu.refreshBanner());
  d.pvpPreview.onQueue = () => d.nav.showMatchmaking();
  d.pvpPreview.onBack = () => d.nav.showMenu();
  d.matchmaking.onConnected = (session) => d.runs.finalizeOnlineRun(session);
  d.matchmaking.onCancelled = () => d.net.onCancelled();
  d.partyScreen.onBack = () => d.nav.showMenu();
  d.partyScreen.onStartMatch = (partyId) => d.net.beginSquadMatch(partyId);
  // The two multiplayer doors a HOST can push the game through (design/20's multiplayer
  // requirements): "put me in a match" and "put me in this friend's party". Installed for
  // every target because the registry is inert unless something calls it, and only a portal
  // has anything to call it with — same shape as `rewardedAd.ts`, opposite direction.
  setOnlineEntry({
    queueCoop: () => d.net.beginSoloQueue(false),
    joinPartyByCode: (code) => {
      // Show first, then join: `show()` is what clears the previous visit's stale-attempt
      // token, and joining before it would have the answer discarded as stale.
      d.nav.showSquad();
      d.partyScreen.joinWithCode(code);
    },
  });
  d.loginScreen.onBack = () => d.nav.showMenu();
  // A login/register/logout can change which MetaStore backs the forge (design/16
  // -accounts.md's account-bound blueprints) and the main menu's own "Hi, X" label.
  const sessionChanged = () => {
    d.mainMenu.refreshAccountLabel();
    void d.net.syncMetaWithSession();
  };
  d.loginScreen.onSessionChange = sessionChanged;
  // The same reaction, for a session that did not come from a screen: a portal signs the
  // player in from the entry point (`platform/crazygames/portalAuth.ts`), and the meta
  // re-sync is what carries a guest's accumulated Forge progress up to the account it just
  // landed in. Subscribed rather than called because the login is asynchronous and may
  // resolve either side of this wiring — `sessionEvents.ts`'s header has the race it is
  // built to make impossible.
  onSessionChanged(sessionChanged);
  d.forge.onBack = () => d.nav.showMenu();
  d.forge.onCycleCharacter = () => d.forgeInput.cycleCharacter();
  d.forge.onClear = () => d.forgeInput.clear();
  d.forge.onCraftAt = (i) => d.forgeInput.craftAt(i);
  d.forge.onStart = () => d.confirm();
  // STORE — a real purchase screen where the `demo: free grant` ACQUIRE used to be
  // (design/19 §4). The button is only rendered where this build may sell at all; the
  // assembly sets `forge.storeEnabled` from `platform/storePlatform.ts`.
  d.forge.onStore = () => d.nav.showStore();
  // BACK re-renders the forge against the CURRENT meta, which is how a delivered purchase
  // reaches it: `StorePurchase`'s `refreshOwnership` has already written the server's answer
  // through `run.setMeta` by then. No separate "ownership changed" hook — the store is a
  // full phase, so the forge is not on screen to refresh while it is open.
  d.storeScreen.onBack = () => d.nav.showForge();
  d.screens.onConfirm = () => d.confirm();
  d.screens.onMenu = () => d.nav.showMenu();
  d.pauseMenu.onResume = () => d.nav.resume();
  d.pauseMenu.onSettings = () => d.nav.openSettingsFromPause();
  d.pauseMenu.onQuit = () => d.runs.quitRun();
}

/** The in-run HUD's own controls and the portal popup. */
export function wireHud(d: WiringDeps): void {
  // Portal popup (design/10 legibility fix, 2026-08-02): a button click is the player's
  // explicit checkpoint choice — routes to CommandBuilder's one-shot latches, same shape as
  // onSwitchWeapon → builder.requestSwap() below.
  d.portalPrompt.onExtract = () => d.builder.requestConfirmExtract();
  d.portalPrompt.onDescend = () => d.builder.requestConfirmDescend();
  // Floor cards (design/05, ENGINE_VERSION 58) — a tap is a VOTE, not a descend; the
  // portal's own Descend button is still what leaves the floor. `onPressStart` swallows
  // the press so choosing a card never also fires a shot, exactly as
  // WeaponPickupPrompt does (WebInput reads `firing` off a raw mousedown that a Pixi
  // button consuming the event knows nothing about).
  d.floorCardPrompt.onVote = (slot) => d.builder.requestCardVote(slot);
  d.floorCardPrompt.onPressStart = () => d.builder.suppressFireUntilRelease();
  // Ground-weapon click-to-collect (design/03, ENGINE_VERSION 32) — same shape as the portal
  // popup above: a row click latches the target id onto the builder.
  d.hud.weaponPickupPrompt.onPick = (id) => d.builder.requestPickup(id);
  // ...and the press CARRYING that click is swallowed, instead of fire being gated on the
  // panel being open at all (see CommandBuilder.suppressFireUntilRelease).
  d.hud.weaponPickupPrompt.onPressStart = () => d.builder.suppressFireUntilRelease();
  // In-run pause button (see HudView.pauseBtn's own doc comment): the same pause() the
  // Escape/P key already calls, guarded by the same `!online` check (pause freezes the local
  // sim loop unconditionally — see ScreenNav's own note on why that is unsafe for a shared
  // match).
  d.hud.onPause = () => {
    if (!d.run.online && d.run.phase === 'playing') d.nav.pause();
  };
  // Tapping the idle-slot chip (HudView, design/10 HUD follow-up) swaps the active weapon —
  // same latch as the keyboard/touch swap controls.
  d.hud.onSwapWeapon = () => {
    if (d.run.phase === 'playing') d.builder.requestSwap();
  };
  // The HUD's record button — the same verb as the F9 hotkey, so a touch/WeChat player (no
  // keyboard at all) can hand over a repro too. Not phase-guarded: an offline run stays
  // packable after it ends, and the button is only mounted while the HUD is up anyway.
  d.hud.onSaveReplay = () => d.runs.saveReplay();
  // Discrete actions route through the shell: during a run they latch a one-tick button pulse
  // on the command builder. A weapon button NAMES a slot; the engine offers only a toggle,
  // and `shouldSwapToSlot` is that bridge (see its own doc).
  d.input.onSwitchWeapon = (slot) => {
    if (d.run.phase === 'playing' && shouldSwapToSlot(d.activeSlot(), slot)) d.builder.requestSwap();
  };
}

/** What a key press means, given the phase and whether the run is a shared online match. */
export type KeyAction = 'forge' | 'closeSettings' | 'pause' | 'resume' | 'saveReplay' | 'none';

/**
 * The key table, as a pure function — the reason this is not just an `if` chain inside the
 * DOM listener below. Two of its rules are invisible from outside and would fail silently:
 *
 *  - pause/resume and F9 are OFFLINE ONLY. A shared online match cannot be frozen from one
 *    client without server reconciliation, so the hotkey is a deliberate no-op there — and a
 *    regression would look like "Escape sometimes doesn't work", not like a bug.
 *  - Escape and O BOTH close the settings screen, but only from the settings phase; O in the
 *    forge phase OPENS it, which is the `forge` action (ForgeInput owns that table).
 *
 * Every code that is not a shell hotkey returns `forge`, because ForgeInput's own handler is
 * phase-guarded and ignores anything it does not recognise.
 */
export function keydownAction(code: string, phase: string, online: boolean): KeyAction {
  if (phase === 'settings' && (code === 'Escape' || code === 'KeyO')) return 'closeSettings';
  if (online) return 'forge';
  if (phase === 'playing' && (code === 'Escape' || code === 'KeyP')) return 'pause';
  if (phase === 'paused' && (code === 'Escape' || code === 'KeyP')) return 'resume';
  // Deliberately always available rather than behind a `?replay=1` flag: the moment worth
  // recording is one nobody planned for, so opting in beforehand is exactly what fails.
  if (code === 'F9') return 'saveReplay';
  return 'forge';
}

/**
 * The two `window` listeners. Guarded to the DOM: WeChat has no `window`, and its settings
 * entry is the SETTINGS button instead.
 *
 * The resize listener registers AFTER WebPlatform's own `resizeTo: window` (added during
 * `app.init()`, well before this runs), so the browser's guaranteed same-event listener
 * ordering means Pixi's renderer.resize() has already happened by the time ours fires —
 * `relayout` reads the already-updated renderer dimensions, not last frame's.
 */
export function wireWindow(d: WiringDeps): void {
  if (typeof window === 'undefined') return;
  window.addEventListener('keydown', (e) => {
    // ForgeInput runs first and is phase-guarded, so a shell hotkey and a forge key can
    // share a code without either shadowing the other.
    d.forgeInput.onKey(e.code);
    switch (keydownAction(e.code, d.run.phase, d.run.online)) {
      case 'closeSettings': d.nav.closeSettings(); break;
      case 'pause': d.nav.pause(); break;
      case 'resume': d.nav.resume(); break;
      case 'saveReplay': d.runs.saveReplay(); break;
      default: break; // 'forge' — already handled above
    }
  });
  window.addEventListener('resize', () => requestAnimationFrame(() => d.nav.relayout()));
}
