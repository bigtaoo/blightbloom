// Split out of Game.ts, 2026-09-03 — every phase → screen transition, and the relayout
// that re-runs the current one against a fresh viewport.
//
// ## Where this sits, and what it is NOT
//
// `ScreenFlow` (2026-08-12) already owns the WIDGET orchestration of a transition: which
// containers to show and hide, in what order, so the settings button floats correctly over
// the forge. This file owns the layer above it — WHICH transition, and the `phase` write
// that goes with it. The two were together in Game.ts because a transition is two lines of
// each, and separating them is what lets the decision half be tested without a renderer.
//
// It reads and writes `RunState.phase`, `settingsReturnPhase` and `tutorialActive`, and
// nothing else of the run's. It never starts, ends or advances a run — `RunLifecycle` does
// that and calls in here for the screen half, never the other way round. That one-way edge
// is deliberate: CLAUDE.md names a two-way dependency as a sign the boundary is drawn
// wrong, and "navigate" and "run a match" genuinely are separable verbs.
import { t } from '../../i18n';
import type { SettingsState } from '../../settings';
import type { Layers } from '../scene/layers';
import type { Backdrop } from '../scene/Backdrop';
import type { HudView } from '../ui/HudView';
import type { PortalPrompt } from '../ui/PortalPrompt';
import type { FloorCardPrompt } from '../ui/FloorCardPrompt';
import type { Screens } from '../screens/Screens';
import type { Forge } from '../screens/Forge';
import type { StoreScreen } from '../screens/StoreScreen';
import type { MainMenu } from '../screens/MainMenu';
import type { PvpPreview } from '../screens/PvpPreview';
import type { Matchmaking, MatchmakingSignal } from '../screens/Matchmaking';
import type { PartyScreen } from '../screens/PartyScreen';
import type { LoginScreen } from '../screens/LoginScreen';
import type { Settings } from '../screens/Settings';
import type { PauseMenu } from '../screens/PauseMenu';
import type { CoopSession } from '../../net/CoopSession';
import type { ArtGate } from './ArtGate';
import type { ScreenFlow } from './ScreenFlow';
import type { RunState } from '../runState';

export interface ScreenNavDeps {
  run: RunState;
  layers: Layers;
  screenFlow: ScreenFlow;
  artGate: ArtGate;
  backdrop: Backdrop;
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
  settingsScreen: Settings;
  pauseMenu: PauseMenu;
  /** Live renderer dimensions (`viewport.ts`'s computeScreenSize over the Application). */
  screenSize: () => { w: number; h: number };
  /** The live settings, for the screens that render them. */
  settings: () => SettingsState;
  /** The Matchmaking screen's injected connect function — supplied by `OnlineMatch`. */
  connect: (signal: MatchmakingSignal) => Promise<CoopSession>;
  /**
   * Run anything the meta layer deferred until the player was between runs — supplied by
   * `OnlineMatch.flushPendingMetaSync`, and injected for exactly the reason `connect` above
   * is: this file must not depend on the controller that owns runs and sessions (see the
   * header's one-way-edge note). What it means here is only "the hub is being entered now".
   */
  onHubEntered: () => void;
}

export class ScreenNav {
  constructor(private readonly deps: ScreenNavDeps) {}

  /** Menu design space (ui/menuLayer.ts) for the current viewport. */
  private fit(): { w: number; h: number } {
    return this.deps.layers.menu.fit(this.deps.screenSize());
  }

  // ---- The screens ----

  /**
   * The LOBBY — the boot front door and, since the 2026-09-10 merge, the branch point too
   * (design/10 screen flow). SOLO drops into the forge/loadout screen below; CO-OP and PVP
   * SOLO QUEUE open matchmaking; SQUAD opens the PvP party lobby (design/05/15); TUTORIAL
   * starts the standalone level; SETTINGS reuses the same overlay the forge uses.
   *
   * It carries the recommend-tutorial flag the mode-select screen's own show used to, for
   * the same reason: the badge is drawn from `MetaState.hasSeenTutorial`, and this method is
   * the one with a `run` to read it from.
   */
  showMenu(): void {
    this.deps.onHubEntered();
    this.deps.run.phase = 'menu';
    const { w, h } = this.fit();
    this.deps.screenFlow.showMenu(w, h, !this.deps.run.meta.hasSeenTutorial);
  }

  /**
   * PvP match preview (design/10 open question "PvP preset-pick has no UI yet", 15) —
   * shown for the solo PVP-SOLO-QUEUE path only, between the lobby and Matchmaking, so a
   * player sees their character/the real map/PvP-scaled stats before committing to queue.
   * Does NOT run for the squad path — see phase.ts's doc comment on 'pvpPreview' for why.
   */
  showPvpPreview(): void {
    if (this.deps.artGate.defer(() => this.showPvpPreview())) return; // character art (design/12)
    this.deps.run.phase = 'pvpPreview';
    const { w, h } = this.fit();
    this.deps.screenFlow.showPvpPreview(w, h, this.deps.run.meta.selectedSkin);
  }

  /** The PvP pre-formed-party lobby (design/05/15's squad follow-up). BACK returns to the
   *  main menu; a successful `onStartMatch` hands off to `OnlineMatch.beginSquadMatch`. */
  showSquad(): void {
    this.deps.run.phase = 'squad';
    const { w, h } = this.fit();
    this.deps.screenFlow.showSquad(w, h);
  }

  /** Login/register/logout (design/16-accounts.md — the never-built account front door).
   *  BACK returns to the main menu, same shape as showSquad. */
  showAccount(): void {
    this.deps.run.phase = 'account';
    const { w, h } = this.fit();
    this.deps.screenFlow.showAccount(w, h);
  }

  /** The forge outpost / loadout screen — the between-run hub (design/14). Shows the
   *  current meta (bank / blueprints / loadout / character); Fire, Enter, or the START
   *  RUN button descends into a run. */
  showForge(): void {
    // The run-art boundary (design/12): the forge is where a player CHOOSES with weapon art,
    // so it is gated rather than START RUN. Returns false — and costs nothing — once the art
    // is in.
    if (this.deps.artGate.defer(() => this.showForge())) return;
    // AFTER the art gate, not before: a deferred call re-enters this method once the art
    // lands, and flushing on the way past would run the sync while the loading screen is
    // still up and the phase is still whatever it was.
    this.deps.onHubEntered();
    this.deps.run.phase = 'forge';
    const { w, h } = this.fit();
    this.deps.screenFlow.showForge(w, h, this.deps.run.meta);
  }

  /**
   * The store (design/19 §4) — reached only from the forge's STORE button or its [B] key,
   * and BACK returns there. Not art-gated like `showForge`: this screen draws no weapon art,
   * only names and prices, so gating it would make a purchase wait on a download it does not
   * use. `showForge` on the way back is gated as it always was.
   */
  showStore(): void {
    this.deps.run.phase = 'store';
    const { w, h } = this.fit();
    this.deps.screenFlow.showStore(w, h, this.deps.run.meta);
  }

  /**
   * Wraps the injected connect with real connecting/error feedback (design/10 screen-flow
   * gap) — reached from the lobby's CO-OP/PVP SOLO QUEUE or PartyScreen's START MATCHING,
   * both of which set `matchmakingReturnPhase` first so Cancel/Back knows where to go back
   * to.
   */
  showMatchmaking(): void {
    if (this.deps.artGate.defer(() => this.showMatchmaking())) return; // the run on the far side
    this.deps.run.phase = 'matchmaking';
    const { w, h } = this.fit();
    this.deps.screenFlow.showMatchmaking(w, h, (signal) => this.deps.connect(signal));
  }

  /** Re-render the forge in place — used after an account sync changes what it shows. */
  refreshForgeIfOpen(): void {
    if (this.deps.run.phase !== 'forge') return;
    const { w, h } = this.fit();
    this.deps.forge.render(this.deps.run.meta, w, h);
  }

  // ---- Settings ----

  openSettings(): void {
    if (this.deps.run.phase !== 'forge' && this.deps.run.phase !== 'menu') return;
    this.deps.run.settingsReturnPhase = this.deps.run.phase;
    this.deps.run.phase = 'settings';
    const { w, h } = this.fit();
    this.deps.screenFlow.openSettings(w, h, this.deps.settings());
  }

  closeSettings(): void {
    if (this.deps.run.settingsReturnPhase === 'menu') this.showMenu();
    else this.showForge();
  }

  // ---- In-run pause menu (design/10, now resolved) ----
  //
  // Offline/local play ONLY (single-player + local `?coop=1` bot ally): the sim genuinely
  // freezes (the loop skips advanceSim while phase is 'paused', mirroring hitStopMs's own
  // "acc doesn't accumulate while frozen" trick — no catch-up burst on resume). A shared
  // online/PvP match can't be frozen from one client without server reconciliation (the
  // same reasoning `hitStopMs` itself is offline-only for), so the pause hotkey is a
  // deliberate no-op there — a documented scope decision, not an oversight.

  pause(): void {
    this.deps.run.phase = 'paused';
    const { w, h } = this.fit();
    this.deps.screenFlow.pause(w, h, this.skipLabel());
  }

  resume(): void {
    this.deps.screenFlow.resume();
    this.deps.run.phase = 'playing';
  }

  openSettingsFromPause(): void {
    this.deps.run.settingsReturnPhase = 'paused';
    this.deps.run.phase = 'settings';
    const { w, h } = this.fit();
    this.deps.screenFlow.openSettingsFromPause(w, h, this.deps.settings());
  }

  openPauseFromSettings(): void {
    this.deps.run.phase = 'paused';
    const { w, h } = this.fit();
    this.deps.screenFlow.openPauseFromSettings(w, h, this.skipLabel());
  }

  /** The pause menu's QUIT reads SKIP during the tutorial (design/10 screen-flow gap). */
  private skipLabel(): string | undefined {
    return this.deps.run.tutorialActive ? t('tutorial.skip') : undefined;
  }

  /** The win/lose/placement screen (RunOutcome's host call). */
  showOutcome(won: boolean, title: string, lines: readonly string[]): void {
    const { w, h } = this.fit();
    this.deps.screens.show(w, h, won, title, lines);
  }

  // ---- Relayout ----

  /**
   * Re-run whichever screen's own layout math is currently on-screen against a fresh
   * screenSize() (window resize / orientation change / F11 fullscreen toggle). The canvas
   * itself already tracks the viewport (WebPlatform's `resizeTo: window`) — this is the
   * missing half: each screen's Panel/button positions were only ever computed once, at the
   * moment it was shown, so without this they stayed pinned to whatever size was current
   * back then (funny reference: relayout on resize, not just on first show).
   * HudView.reposition already existed for exactly this but was never wired to anything.
   */
  relayout(): void {
    // `w`/`h` below are MENU design space (ui/menuLayer.ts); the backdrop and in-run HUD
    // are not.
    const { w, h } = this.fit();
    const size = this.deps.screenSize();
    const d = this.deps;
    d.backdrop.resize(size.w, size.h);
    d.hud.reposition(size);
    d.portalPrompt.reposition(size);
    d.floorCardPrompt.reposition(size);
    d.screenFlow.repositionSettingsButtonIfForge(d.run.phase === 'forge', w, h);
    switch (d.run.phase) {
      case 'menu': d.mainMenu.show(w, h); break; // the badge is already set — see showMenu
      case 'pvpPreview': d.pvpPreview.show(w, h, d.run.meta.selectedSkin); break;
      case 'forge': d.forge.render(d.run.meta, w, h); break;
      case 'matchmaking': d.matchmaking.resize(w, h); break; // NOT show() — must not restart connect()
      case 'squad': d.partyScreen.show(w, h); break;
      case 'account': d.loginScreen.show(w, h); break;
      case 'store': d.storeScreen.resize(w, h); break; // NOT show() — must not re-list mid-purchase
      case 'paused': d.pauseMenu.show(w, h, this.skipLabel()); break;
      case 'settings': d.settingsScreen.show(w, h, d.settings()); break;
      case 'victory':
      case 'defeat':
        d.screens.resize(w, h);
        break;
      case 'playing':
        break; // in-run HUD only needs the reposition() above — no static panel layout
    }
  }
}
