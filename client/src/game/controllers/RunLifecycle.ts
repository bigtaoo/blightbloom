// Split out of Game.ts, 2026-09-03 — starting, ending and swapping a run.
//
// This is the boundary Game.ts's own file-length note nominated TWICE as the next real
// extraction candidate, and the reason it kept being deferred was real: `beginRun`,
// `beginTutorialRun`, `beginArenaDemoRun`, `beginReplayRun`, `finalizeOnlineRun` and
// `quitRun` read and write phase/engine/session/meta/score in combination, so cutting them
// out of the class left two halves calling each other. Moving the STATE into `runState.ts`
// first is what dissolved that: the shared fields now live below both, so this file and the
// shell each depend on a lower layer instead of on one another.
//
// What it owns: the five entry points into a run, the one exit, the render-state reset they
// all share, and the replay export that is only meaningful while one is live. What it does
// NOT own: which screen is showing (`ScreenNav`), how a match is found (`OnlineMatch`), or
// how a frame is drawn (`GameLoop`). It calls into `ScreenNav` for the screen half of an
// entry or exit; nothing in `ScreenNav` calls back here.
import { createGameEngine, ReplayInputSource, type EngineConfig, type GameEngine } from '@dd/engine';
import type { Container } from 'pixi.js';
import { t } from '../../i18n';
import { THEME } from '../theme';
import { clearLoadout } from '../../meta';
import type { CoopSession } from '../../net/CoopSession';
import { buildArenaDemoConfig, buildDungeonRunConfig } from '../match/offlineConfig';
import { buildTutorialConfig } from '../match/tutorialConfig';
import type { MatchRecorder } from '../match/MatchRecorder';
import { saveMarkedReplay } from '../match/replayDownload';
import { loadReplayFile, replayStopTick } from '../match/replayPlayback';
import type { Layers } from '../scene/layers';
import type { Scene } from '../scene/Scene';
import type { RoomBuilder } from '../scene/RoomBuilder';
import type { FxController } from '../fx/FxController';
import type { HudView } from '../ui/HudView';
import type { Forge } from '../screens/Forge';
import type { ModeSelect } from '../screens/ModeSelect';
import type { Matchmaking } from '../screens/Matchmaking';
import type { PartyScreen } from '../screens/PartyScreen';
import type { PauseMenu } from '../screens/PauseMenu';
import type { Screens } from '../screens/Screens';
import type { ArtGate } from './ArtGate';
import type { GameLoop } from './GameLoop';
import type { ScreenFlow } from './ScreenFlow';
import type { ScreenNav } from './ScreenNav';
import type { TutorialHintController } from './TutorialHintController';
import type { RunState } from '../runState';

export interface RunLifecycleDeps {
  run: RunState;
  layers: Layers;
  scene: Scene;
  fx: FxController;
  roomBuilder: RoomBuilder;
  gameLoop: GameLoop;
  screenFlow: ScreenFlow;
  nav: ScreenNav;
  artGate: ArtGate;
  recorder: MatchRecorder;
  tutorialHints: TutorialHintController;
  hud: HudView;
  /** The in-run HUD's visibility root — every phase transition toggles it. */
  hudView: Container;
  forge: Forge;
  /** Only `beginQuickRun` needs it — the one run entry point reached from the main menu
   *  itself, so the one that has to hide the main menu rather than the forge. */
  mainMenu: { hide(): void };
  modeSelect: ModeSelect;
  matchmaking: Matchmaking;
  partyScreen: PartyScreen;
  pauseMenu: PauseMenu;
  screens: Screens;
  /** A free character distinct from the local pick, for the co-op bot ally (ROADMAP 3.1). */
  allySkinId: () => string;
}

export class RunLifecycle {
  constructor(private readonly deps: RunLifecycleDeps) {}

  /**
   * Render state reset shared by every fresh run: offline dungeon/arenaDemo (`beginRun`), a
   * newly-connected online match (`finalizeOnlineRun`), and the tutorial. Extracted
   * (design/10 screen-flow gap) so the online/tutorial paths get the exact same cleanup the
   * offline path always had, instead of duplicating it or (as the online path used to)
   * skipping it until connect resolved.
   */
  resetRenderState(): void {
    const d = this.deps;
    d.scene.clear();
    // `particles.view` is a PERSISTENT child of `layers.fx` (added once at boot), not a
    // transient `_life`-tagged flash/trail — skip it here or a restart would destroy the
    // particle system itself, not just clear stale particles.
    for (const child of [...d.layers.fx.children]) {
      if (child !== d.fx.particles.view) child.destroy();
    }
    d.fx.resetForNewRun();
    d.roomBuilder.clear();
    d.run.score = 0;
    d.gameLoop.resetForNewRun();
    d.screenFlow.hideSettingsButton();
  }

  // ---- Offline entry points ----

  /**
   * Fresh OFFLINE run: reset render state and stand up a new engine (design/10 rebuild).
   * Online runs no longer go through here at all (design/10 screen-flow gap) — they route
   * ModeSelect/PartyScreen → showMatchmaking → `finalizeOnlineRun` instead, so a real
   * connecting/error screen exists instead of a blank `playing` phase.
   */
  beginRun(): void {
    const d = this.deps;
    this.resetRenderState();
    d.run.tutorialActive = false;

    // `?arenaDemo=1` (dev-only, see RunState's field comment) — a synthetic local PvP arena
    // instead of the PvE dungeon, purely so the zone HUD row + Minimap have real data to
    // draw and can be eyeballed in a browser.
    if (d.run.arenaDemo) {
      this.beginArenaDemoRun();
      return;
    }

    // Carry the chosen character + the crafted loadout into the run (design/14) — see
    // offlineConfig.ts's buildDungeonRunConfig doc comment for the coop/single-player shape.
    this.startOfflineEngine(
      'dungeon',
      buildDungeonRunConfig({
        seed: d.run.nextRunSeed(),
        coop: d.run.coop,
        localSeat: { skinId: d.run.meta.selectedSkin, loadout: d.run.meta.loadout },
        allySkinId: d.allySkinId(),
      }),
    );
    d.run.runCount++;

    // The crafted weapons are spent the moment they enter a run — one run each (design/05).
    // Consume the staged loadout now so a death doesn't refund it and the next visit to the
    // forge starts empty. Materials already left the bank at craft time.
    d.run.setMeta(clearLoadout(d.run.meta));

    // No view priming here: the first room loads on sim tick 1 (SpawnSystem), which
    // teleports the player onto its spawn point and emits `room_enter`. The player's view is
    // first created — and snapped — during that tick's reconcile, at the real spawn, and
    // buildRoom draws the room then. Priming now would spawn the view at the placeholder
    // centre and make it visibly slide to the room spawn.
    d.run.phase = 'playing';
    d.hudView.visible = true;
    d.forge.hide();
    d.screens.hide();
  }

  /**
   * One click from the front door into a run — the main menu's PLAY on a host that requires
   * it (`platform/hostKind.ts`).
   *
   * A game portal's own rule is "land new users in gameplay immediately... a maximum of 1
   * click is allowed" (`docs.crazygames.com/requirements/gameplay`), and this game's normal
   * route is PLAY → SELECT MODE → SOLO PvE → START RUN, which is four. That route is not
   * wrong — the forge IS the between-run decision this game is built around — it is simply
   * not what a portal's first-time visitor is given a chance to sit through. So this is a
   * second door to the SAME run, not a different mode: it calls `beginRun` with whatever the
   * meta already holds, which for a first-time player is an empty loadout that
   * `resolveLoadout` fills with the starter kit — exactly what pressing START RUN in the
   * forge without crafting anything does.
   *
   * The art gate is the one thing this must not skip, and the reason it is a method here
   * rather than a second `onPlay` handler in the wiring table: the forge is normally what
   * `showForge` gates on the player's behalf (see `ScreenNav.showForge`), and a run entered
   * with no screen in between has to gate for itself or the first room is drawn out of
   * placeholder rectangles. Same shape as `beginTutorialRun`/`beginArenaDemoRun`, which are
   * the other two entry points with no screen between them and the run.
   */
  beginQuickRun(): void {
    if (this.deps.artGate.defer(() => this.beginQuickRun())) return; // a run, with no screen between
    this.deps.mainMenu.hide();
    this.beginRun();
  }

  /**
   * ModeSelect's TUTORIAL button (design/10 screen-flow gap) — a fixed, offline,
   * always-skippable standalone level (`tutorialConfig.ts`'s own doc comment has the full
   * account of why it's flat-mode, not the real dungeon). Mirrors `beginArenaDemoRun`'s
   * directness: flat mode never fires `room_enter` (that event is dungeon-only,
   * `SpawnSystem.loadRoom`), so `RoomBuilder`/`Portal` never gets constructed by the normal
   * event path — primed here directly instead, exactly like the PvP arena demo (which has
   * the same property, being all co-resident from tick 0).
   */
  beginTutorialRun(): void {
    const d = this.deps;
    if (d.artGate.defer(() => this.beginTutorialRun())) return; // a run, with no screen between
    this.resetRenderState();
    d.run.tutorialActive = true;
    d.tutorialHints.reset();
    const tutorial = this.startOfflineEngine(
      'tutorial',
      buildTutorialConfig({ skinId: d.run.meta.selectedSkin }),
    );
    d.run.runCount++;
    this.enterPrimedRun(tutorial, () => d.modeSelect.hide());
  }

  /** Dev-only (see RunState's `arenaDemo` comment): a catalog ArenaMap + two local seats on
   *  distinct teams. Unlike dungeon mode, arena rooms are all co-resident from tick 0
   *  (ROADMAP 4.2b) — no `room_enter` event ever fires to prime the view, so `buildRoom` is
   *  called once here directly. The second seat is driven by the existing coop bot-ally
   *  submit path (GameLoop), not a real opponent. */
  beginArenaDemoRun(): void {
    const d = this.deps;
    if (d.artGate.defer(() => this.beginArenaDemoRun())) return; // a run, with no screen between
    const arena = this.startOfflineEngine(
      'arena',
      buildArenaDemoConfig({
        seed: d.run.nextRunSeed(),
        arenaId: d.run.arenaDemo ?? 'landing_basic',
        localSkinId: d.run.meta.selectedSkin,
        allySkinId: d.allySkinId(),
      }),
    );
    d.run.runCount++;
    this.enterPrimedRun(arena);
  }

  /** `?replay=<url>`: watch a recording instead of playing (match/replayPlayback.ts).
   *  Failures land in a toast, not a throw — a wrong path or a stream from another
   *  ENGINE_VERSION is the normal way this gets used wrong, and a black screen would be the
   *  worst way to say so. */
  async beginReplayRun(url: string): Promise<void> {
    const d = this.deps;
    if (d.artGate.defer(() => void this.beginReplayRun(url))) return; // a run, no screen between
    try {
      const file = await loadReplayFile(url);
      this.resetRenderState();
      d.run.tutorialActive = false;
      d.recorder.end(); // the stream is the file's, not a live run's
      d.run.replayStop = replayStopTick(file);
      d.run.engine = createGameEngine(file.replay.config, new ReplayInputSource(file.replay));
      this.enterPrimedRun(d.run.engine);
      d.hud.toast(
        `Replay ${file.label} v${file.engineVersion}, held at tick ${d.run.replayStop}`,
        THEME.colors.pickupHeal,
      );
    } catch (e) {
      d.run.replayStop = null;
      d.hud.toast((e as Error).message, THEME.colors.enemy);
    }
  }

  /** The tail every run whose scene is primed up front shares (arena/tutorial/replay): build
   *  the geometry once, then hand the screen over. Dungeon runs do NOT come here — their
   *  first room primes on tick 1's `room_enter` (see `beginRun`'s note). */
  private enterPrimedRun(engine: GameEngine, hide: () => void = () => this.deps.forge.hide()): void {
    const d = this.deps;
    d.roomBuilder.build(engine.state);
    d.run.phase = 'playing';
    d.hudView.visible = true;
    hide();
    d.screens.hide();
  }

  /** Offline engine on a RECORDED input source, so F9 can export the run
   *  (match/MatchRecorder.ts). Every offline entry point goes through here — a hotkey that
   *  only works if you started the run the right way would be useless. */
  private startOfflineEngine(label: string, config: EngineConfig): GameEngine {
    this.deps.run.engine = createGameEngine(config, this.deps.recorder.begin(label, config));
    return this.deps.run.engine;
  }

  // ---- Online (ROADMAP 3.3): matchmaking → socket → CoopSession ----
  //
  // Connection setup (matchmaking + ticket redemption) lives in onlineConnect.ts, and the
  // run-config shape it needs in matchConfig.ts (both pure of run state) — this just owns
  // the session's lifecycle and phase transition. The matchmaking ATTEMPT itself (design/10
  // screen-flow gap) lives entirely in the Matchmaking screen, so this method only runs once
  // that screen already has a connected session in hand: there is no "blank playing phase
  // while invisibly connecting" window any more.

  /** A match actually started — enter `playing` with the now-live session. */
  finalizeOnlineRun(session: CoopSession): void {
    const d = this.deps;
    this.resetRenderState();
    d.run.tutorialActive = false;
    // Drop the last offline run's stream: online input arrives on the confirmed net stream,
    // so nothing here records it and F9 must not export a stale file.
    d.recorder.end();
    d.run.session?.close();
    d.run.session = session;
    d.gameLoop.resetOnlinePrediction(); // re-anchors on the first confirmed frame of the new run
    d.matchmaking.hide();
    d.run.phase = 'playing';
    d.hudView.visible = true;
    d.forge.hide();
    d.screens.hide();
    d.partyScreen.hide();
  }

  // ---- Exit ----

  /**
   * Voluntary quit (design/10) — behaves like a death for the run's own bookkeeping: the
   * floor's un-banked materials are simply forfeited, same as `lose()` never calling
   * bankMaterials (design/05 "death forfeits the floor buffer for free"). No defeat
   * screen/score penalty though — this was a choice, not a loss. Doubles as the tutorial's
   * Skip (design/10 screen-flow gap): a skip counts the same as a completion for
   * `hasSeenTutorial` (never forced, same ethos as LoginScreen's guest path), and returns to
   * ModeSelect instead of Forge (a tutorial run never touched the loadout).
   */
  quitRun(): void {
    const d = this.deps;
    d.pauseMenu.hide();
    const { wasTutorial } = d.run.endRun();
    if (wasTutorial) {
      d.run.markTutorialSeen();
      d.nav.showModeSelect();
    } else {
      d.nav.showForge();
    }
  }

  /** Export the run so far, marked at this tick (match/replayDownload.ts) — the verb behind
   *  BOTH the F9 hotkey and the HUD's record button, so the two can never drift. The wording
   *  is localised here rather than in the module that does the work. */
  saveReplay(): void {
    const d = this.deps;
    const r = saveMarkedReplay(d.recorder, d.run.engine?.state.tick ?? 0, Date.now());
    if (r.ok) d.hud.toast(t('toast.replaySaved', { name: r.name }), THEME.colors.pickupHeal);
    else if (r.reason === 'no-run') d.hud.toast(t('toast.replayNoRun'), THEME.colors.enemy);
    else d.hud.toast(t('toast.replayUnsupported'), THEME.colors.enemy);
  }
}
