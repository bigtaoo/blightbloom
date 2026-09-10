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
import { checkResumable, packRunSave, unpackCommands } from '../match/runSave';
import { clearSavedRun, loadSavedRun, writeSavedRun } from '../match/runSaveStore';
import type { Layers } from '../scene/layers';
import type { Scene } from '../scene/Scene';
import type { RoomBuilder } from '../scene/RoomBuilder';
import type { FxController } from '../fx/FxController';
import type { HudView } from '../ui/HudView';
import type { Forge } from '../screens/Forge';
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
   * the lobby/PartyScreen → showMatchmaking → `finalizeOnlineRun` instead, so a real
   * connecting/error screen exists instead of a blank `playing` phase.
   */
  beginRun(): void {
    const d = this.deps;
    // A fresh run replaces any saved one — there is only ever one save slot (`runSave.ts`),
    // and the Forge's NEW RUN button says so. Dropped here rather than at the button so the
    // rule holds for every route into a fresh run, including the portal's one-click PLAY.
    clearSavedRun();
    this.resetRenderState();
    d.run.tutorialActive = false;
    // Teach a player who has never been taught, on their first real run — the beats the
    // standalone tutorial drives, over the dungeon and the loadout they actually have
    // (design/20's onboarding pass). This is the FIRST-CLICK path on a portal, where the
    // menu route to the tutorial exists but a new visitor is one PLAY press from a run and
    // would otherwise be shown no controls at all; it is the same fix on every other target,
    // which is why it lives here and not behind a host branch. `hasSeenTutorial` retires it
    // (`GameLoop` marks it at gameover), so it is once per player, not once per run.
    d.run.firstRunHints = !d.run.meta.hasSeenTutorial;
    if (d.run.firstRunHints) d.tutorialHints.reset();

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
   * The lobby's TUTORIAL row (design/10 screen-flow gap) — a fixed, offline,
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
    d.run.firstRunHints = false; // the standalone level teaches on its own flag
    d.tutorialHints.reset();
    const tutorial = this.startOfflineEngine(
      'tutorial',
      buildTutorialConfig({ skinId: d.run.meta.selectedSkin }),
    );
    d.run.runCount++;
    this.enterPrimedRun(tutorial, () => d.mainMenu.hide());
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

  /**
   * CONTINUE RUN (design/05 "Only the boss floor ends a run", ENGINE_VERSION 61) — resume the
   * unfinished single-player run `saveAndQuitRun` put away.
   *
   * The whole resume is: rebuild the config from the save's seed + loadout, replay the saved
   * command stream through a fresh engine, and hand the same input source to the live command
   * builder, which appends to it from the next tick on. There is no restore step, because
   * there is nothing to restore — see `runSave.ts`'s header for why a seed and an input
   * stream ARE the run.
   *
   * Three things this has to get right that a naive "advance N times" would not:
   *
   *  - **The version and content checks come first** (`checkResumable`). A save from another
   *    `ENGINE_VERSION`, or one whose floor library has been edited since, replays into a
   *    different world; refusing is the only honest answer, and the save is dropped so the
   *    Forge stops offering it.
   *  - **The fast-forward's last tick must not reach the render layer.** `step()` clears
   *    `state.events` at the top of each tick, so after the loop the final tick's events are
   *    still sitting there and `GameLoop`'s first real frame would drain them — replaying a
   *    burst of hit flashes, sounds and score from a tick the player is not watching.
   *  - **The scene is primed by hand.** A dungeon run normally builds its geometry from tick
   *    1's `room_enter` event (see `beginRun`), which has just been consumed by the
   *    fast-forward, so this takes the `enterPrimedRun` path the arena and tutorial use.
   *
   * The loadout is deliberately NOT spent again: `beginRun` consumed it when the run first
   * started, and the weapons the save carries are the ones that run is already holding.
   */
  resumeSavedRun(): void {
    const d = this.deps;
    if (d.artGate.defer(() => this.resumeSavedRun())) return; // a run, with no screen between
    const save = loadSavedRun();
    if (!save) return; // nothing to continue — the button should not have been there
    const config = buildDungeonRunConfig({
      seed: save.seed,
      coop: false, // savableRun() admits single-player runs only, so this is not a choice
      localSeat: { skinId: save.skinId, loadout: save.loadout },
      allySkinId: d.allySkinId(),
    });
    const refusal = checkResumable(save, config);
    if (refusal !== null) {
      clearSavedRun();
      d.nav.showForge(); // re-render, so the now-impossible CONTINUE button goes away
      d.hud.toast(
        t(refusal === 'engine-version' ? 'toast.runSaveOldVersion' : 'toast.runSaveStale'),
        THEME.colors.enemy,
      );
      return;
    }

    this.resetRenderState();
    d.run.tutorialActive = false;
    d.run.firstRunHints = false; // taught already, or never — a resume is not a first run
    const engine = createGameEngine(config, d.recorder.resume('dungeon', config, unpackCommands(save)));
    for (let frame = 1; frame <= save.ticks; frame++) {
      if (engine.advance(frame) === null) break; // a local source never stalls; belt and braces
      if (engine.state.phase === 'gameover') break;
    }
    engine.state.clearEvents(); // see the doc comment: the last replayed tick is not a frame
    d.run.engine = engine;
    d.run.runCount++;
    d.run.score = save.score; // after resetRenderState, which zeroes it for a fresh run
    this.enterPrimedRun(engine);
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
      d.run.firstRunHints = false; // watching a recording is not being taught
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
    // No hints in an online match: `GameLoop.advanceOnline` never consumed them (they are
    // driven from the offline sim step alone), and a lockstep session is the wrong place to
    // learn the controls anyway.
    d.run.firstRunHints = false;
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
   * the lobby instead of Forge (a tutorial run never touched the loadout).
   */
  quitRun(): void {
    // The save goes with the run. There is at most one (`runSave.ts`), so a stale entry left
    // behind here would be offered as "continue" against a run the player deliberately
    // abandoned — including the case where the run being abandoned IS a resumed one.
    clearSavedRun();
    this.leaveRun();
  }

  /**
   * SAVE & QUIT (design/05 "Only the boss floor ends a run", ENGINE_VERSION 61) — the other
   * half of removing mid-floor extraction. Banking early used to be how a player stopped for
   * the evening; it cost them the run's whole carry-out decision to do it. This is the verb
   * that decision no longer has to double as.
   *
   * Order matters: the save is written FIRST and a failure aborts, because the alternative is
   * telling someone their run was kept and dropping them in the Forge with nothing. On a
   * refusal the pause menu stays open and the run stays live — they can keep playing, or quit
   * for real.
   */
  saveAndQuitRun(): void {
    const d = this.deps;
    const state = d.run.engine?.state;
    const config = d.recorder.runConfig;
    const commands = d.recorder.recordedCommands();
    if (!state || !config || !commands) {
      d.hud.toast(t('toast.runSaveFailed'), THEME.colors.enemy);
      return;
    }
    const stored = writeSavedRun(packRunSave({
      config,
      commands,
      ticks: state.tick,
      floorIndex: state.floorIndex,
      score: d.run.score,
      nowMs: Date.now(),
    }));
    if (!stored) {
      // A host with no storage at all (WeChat today — see runSave.ts) or a full quota. The
      // in-memory copy stands for this session, but saying "saved" would be a lie the moment
      // the tab closes, so this reports the failure and leaves the run alone.
      d.hud.toast(t('toast.runSaveFailed'), THEME.colors.enemy);
      return;
    }
    d.hud.toast(t('toast.runSaved'), THEME.colors.pickupHeal);
    this.leaveRun();
  }

  /** The screen-and-state half both exits share. Split out so `saveAndQuitRun` can reach it
   *  WITHOUT `quitRun`'s `clearSavedRun` — the one difference between the two. */
  private leaveRun(): void {
    const d = this.deps;
    d.pauseMenu.hide();
    const { wasTutorial } = d.run.endRun();
    if (wasTutorial) {
      d.run.markTutorialSeen();
      d.nav.showMenu();
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
