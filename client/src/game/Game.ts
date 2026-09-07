import { Application, Container } from 'pixi.js';
import { SKIN_DEFS, type GameEngine, type GameState } from '@dd/engine';
import { CoopSession } from '../net/CoopSession';
import { MatchRecorder } from './match/MatchRecorder';
import { bankMaterials, unlockBlueprint, createAccountSyncMetaStore, type MetaStore } from '../meta';
import type { SettingsState } from '../settings';
import { Layers } from './scene/layers';
import { Scene } from './scene/Scene';
import { Screens, type ResultOffer } from './screens/Screens';
import { Forge } from './screens/Forge';
import { MainMenu } from './screens/MainMenu';
import { ModeSelect } from './screens/ModeSelect';
import { PvpPreview } from './screens/PvpPreview';
import { Matchmaking } from './screens/Matchmaking';
import { PartyScreen } from './screens/PartyScreen';
import { LoginScreen } from './screens/LoginScreen';
import type { StoreScreen } from './screens/StoreScreen';
import { Settings } from './screens/Settings';
import { PauseMenu } from './screens/PauseMenu';
import { Button } from './ui/widgets';
import { FxController } from './fx/FxController';
import { RenderQualityController } from './renderQuality';
import { SettingsBinding } from './settingsBinding';
import type { FrameWindowLike } from '../render/qualityWatchdog';
import { HudView } from './ui/HudView';
import { TouchControlsView } from './ui/TouchControlsView';
import { CommandBuilder } from './controllers/CommandBuilder';
import { AllyController } from './controllers/AllyController';
import { EventReactor, type EventReactorHost } from './controllers/EventReactor';
import { TutorialHintController } from './controllers/TutorialHintController';
import { RoomBuilder } from './scene/RoomBuilder';
import { Backdrop } from './scene/Backdrop';
import { PickupDebugOverlay } from './scene/PickupDebugOverlay';
import { ArtGate } from './controllers/ArtGate';
import { PortalPrompt } from './ui/PortalPrompt';
import { FloorCardPrompt } from './ui/FloorCardPrompt';
import { buildHudLayer } from './controllers/hudLayer';
import { RunOutcome } from './controllers/RunOutcome';
import { ForgeActions } from './controllers/ForgeActions';
import { GameLoop } from './controllers/GameLoop';
import { ScreenNav } from './controllers/ScreenNav';
import { RunLifecycle } from './controllers/RunLifecycle';
import { OnlineMatch } from './controllers/OnlineMatch';
import { ForgeInput } from './controllers/ForgeInput';
import { wireHud, wireScreens, wireWindow } from './controllers/gameWiring';
import { assembleGame } from './controllers/gameAssembly';
import { readGameQueryParams } from './match/gameQueryParams';
import { computeScreenSize } from './viewport';
import type { Phase } from './phase';
import { RunState } from './runState';
import type { AudioBus, InputCanvas, InputSource } from '../platform/types';

// The demo runs the Ember biome as a seeded dungeon (design/05/09, ROADMAP 1.3): each
// floor is traversed room by room. The engine owns the geometry now — the render layer
// reads state.walls / state.obstacles / worldW/H per room and rebuilds on the
// `room_enter` event (RoomBuilder.build), so there are no fixed WORLD dimensions, wave
// list, or pillar layout here any more (offlineConfig.ts's own PLACEHOLDER_WORLD is
// ignored in dungeon/arena mode — each room/arena resizes the world as it loads).

// Render-side run phases (design/10). The engine only knows idle/playing/gameover;
// the main menu (the boot front door), the forge/loadout outpost (the between-run hub,
// design/14), and the result screens live here in the shell, along with score (derived
// from events). 'paused' is the in-run pause menu (design/10's own open question,
// resolved) — 'settings' also serves as the pause menu's settings sub-screen (Game
// tracks which phase to return to via settingsReturnPhase). 'squad' is the PvP
// pre-formed-party lobby (design/05/15's squad follow-up) — the first runtime (not
// boot-flag) entry point into PvP. Declared in phase.ts — shared vocabulary between
// Game and the screen layer, unit-testable without standing up a Pixi Application.

export class Game {
  private app: Application;
  private layers = new Layers();
  private input: InputSource;
  private audio: AudioBus;

  private scene = new Scene(this.layers);
  // Every offline run records its own input stream (see MatchRecorder) so F9 can hand
  // over a real repro. Free: LocalInputSource retained the stream already.
  private recorder = new MatchRecorder();
  private builder: CommandBuilder;

  // In-match HUD (design/10 widget kit, extracted into HudView 2026-07-28): composed
  // bars/text/toast instead of one debug Text blob. `hudView` is the visibility root
  // every phase transition toggles; `hud` owns the actual widgets (see HudView.ts).
  private hudView = new Container();
  private readonly hud = new HudView();
  // On-screen sticks/buttons for touch play (design/10 open question) — pure
  // presentation over TouchControls' own hit-test geometry, mounted in `hudView` so it
  // shares the exact same phase-driven visibility as the rest of the in-run HUD.
  private readonly touchControlsView = new TouchControlsView();
  private settingsBtn!: Button;

  // `?pickupDebug=1` only (gameQueryParams.ts) — null in a normal session; mounted on
  // `layers.hud` (world-space) below, since it draws collect-radius rings, not HUD text.
  private pickupDebugOverlay: PickupDebugOverlay | null = null;

  private screens = new Screens();
  private forge = new Forge();
  private mainMenu = new MainMenu();
  // ModeSelect (design/10 screen-flow gap): PLAY's new destination — solo PvE / co-op /
  // PvP solo queue / tutorial, previously only reachable as boot-time URL flags.
  private modeSelect = new ModeSelect();
  // PvP match preview (design/10 open question "PvP preset-pick has no UI yet") —
  // ModeSelect's PVP SOLO QUEUE routes here before Matchmaking, so a player sees their
  // character/map/PvP-scaled stats instead of jumping straight into "Finding a match…".
  // Solo-queue path only — see phase.ts's doc comment for why squad doesn't route here.
  private pvpPreview = new PvpPreview();
  // Matchmaking (design/10 screen-flow gap): wraps connectOnlineSession with real
  // connecting/error feedback — previously the game sat in a blank `playing` phase with
  // no UI while matchmaking ran, and a post-ticket failure hung forever with no error.
  private matchmaking = new Matchmaking();
  // Where Cancel/Back on the Matchmaking screen returns to — modeSelect for a solo
  // co-op/PvP queue (beginSoloQueue), squad for a pre-formed party (beginSquadMatch).
  // Same "remember the caller" convention as settingsReturnPhase.
  // Constructed in start(), not as a field initializer — it needs `this.run.matchBaseUrl`
  // AFTER the constructor's `?matchBaseUrl=` query-param override has applied, which a
  // field initializer would run before (design/05/15's PvP squad follow-up).
  private partyScreen!: PartyScreen;
  // Same constructed-in-start() reason as partyScreen — needs the post-override
  // `this.run.matchBaseUrl` (design/16-accounts.md).
  private loginScreen!: LoginScreen;
  // Same constructed-in-start() reason again — it needs the post-override
  // `this.run.matchBaseUrl` AND the platform gate the assembly resolves (design/19 §4).
  private storeScreen!: StoreScreen;
  private settingsScreen = new Settings();
  private pauseMenu = new PauseMenu();
  private readonly portalPrompt = new PortalPrompt();
  private readonly floorCardPrompt = new FloorCardPrompt();
  // Settings can be opened from the main menu, the forge, OR the in-run pause menu
  // (design/10); this is which phase the settings screen's BACK button returns to. Set
  // right before each openSettings()/openSettingsFromPause() call, never read otherwise.
  private readonly backdrop = new Backdrop(this.layers);
  private readonly roomBuilder = new RoomBuilder(this.layers, this.backdrop);
  // Win/lose/placement screens (design/15), extracted into RunOutcome 2026-07-28 — `this`
  // is its host for the score/meta/phase/screen reactions (see that file's doc comment).
  private readonly runOutcome = new RunOutcome(this);

  // Persistent between-run meta (design/14): loaded at boot, saved on every change. The
  // forge outpost mutates it (craft / character / acquire); a run reads only its
  // (skinId, loadout) at start and banks materials back into it on a successful extract.
  // Account-sync-aware (design/16-accounts.md): every save best-effort mirrors to
  // `/account/meta` once logged in; a guest's behavior is unchanged. The `() =>
  // this.run.matchBaseUrl` thunk is why this can stay a field initializer despite needing
  // the post-query-param-override URL — see accountSync.ts's own comment.
  private store: MetaStore = createAccountSyncMetaStore(() => this.run.matchBaseUrl);
  /**
   * Every piece of mutable RUN state — phase, meta, the mode flags, the live engine or
   * session — moved into `runState.ts` (2026-09-03). It is PIXI-free by construction, so
   * the rules that used to need an `Application` to reach are unit-tested directly; see
   * that file's header for why a shared lower layer was the right split here rather than
   * another controller. What stays in this class is the Pixi objects and the wiring.
   *
   * Assigned in the constructor rather than as an initializer only because `store` above
   * is itself an initializer — TypeScript runs them in declaration order, so `store` has
   * to exist first. The `() => this.run.matchBaseUrl` thunk is lazy and is never called
   * before that.
   */
  private readonly run: RunState;

  /** The seat this client drives — read by EventReactor/RunOutcome/GameLoop/TutorialHint
   *  through their host interfaces. A getter onto `run` so those four keep one source of
   *  truth rather than a copy that has to be kept in sync. */
  get localOwner(): number {
    return this.run.localOwner;
  }
  // Craft/cycle-character/acquire/clear/browse actions (extracted 2026-08-12, see that
  // file's doc comment) — a field initializer is fine here (unlike screenFlow below):
  // both `forge` and `store` above are already-declared field initializers themselves,
  // no query-param-override timing dependency.
  private readonly forgeActions = new ForgeActions(this.forge, this.store);

  // Persistent client-side settings (design/10/11: master/SFX/music volume + mute).
  // Reached from the forge outpost only — see openSettings/closeSettings.
  // Persisted settings + the four places a change to them lands — see `settingsBinding.ts`.
  private readonly settingsBinding: SettingsBinding;
  /** The run-boundary art gate (design/12). Inert in any session that did not defer art —
   *  every unit test in this repo included; see `controllers/ArtGate.ts`. */
  private readonly artGate: ArtGate;
  // Render quality — the tier's whole wiring lives in `renderQuality.ts`; this is the handle.
  private readonly quality: RenderQualityController;

  /** The live settings, for the screens that render them. Every WRITE goes through
   *  `settingsBinding.update`, never through this. */
  private get settings(): SettingsState { return this.settingsBinding.state; }

  /** GameShellHost — the same value, as a method, for the parts that take a thunk. */
  settingsState(): SettingsState {
    return this.settingsBinding.state;
  }

  /** GameShellHost — end the run as a defeat with a result screen. The three verbs in
   *  the order a real defeat runs them; `OnlineMatch` calls it when the reconnect loop
   *  gives up (ROADMAP reconnect, design/06). */
  endRunAsDefeat(title: string, body: string): void {
    this.setPhase('defeat');
    this.hideHud();
    this.showOutcomeScreen(false, title, [body]);
  }

  private readonly ally = new AllyController();
  // Fixed-step sim + interpolated render main loop (extracted 2026-08-12, see that
  // file's doc comment) — constructed in start(), same late-construction reason as
  // screenFlow (needs partyScreen, built there too).
  private gameLoop!: GameLoop;
  // The four controllers Game.ts's behaviour split into (2026-09-03) — screen
  // navigation, the run lifecycle, the network glue and the forge's keyboard. All
  // late-constructed in start(), same reason as screenFlow/gameLoop above.
  private nav!: ScreenNav;
  private runs!: RunLifecycle;
  private net!: OnlineMatch;
  private forgeInput!: ForgeInput;

  // Post-processing / game-feel (design/01 fidelity roadmap milestone 3), extracted
  // into FxController 2026-07-28. Offline-only (never touches advanceOnline — see
  // FxController.addHitStop's doc): a strong hit-stop pause would have to be
  // reconciled against the server's confirmed frame stream online, which isn't worth
  // the complexity for a pure juice effect.
  private readonly fx = new FxController(this.layers);

  // Event→feedback reactions (fx/audio/score/hud), extracted into EventReactor
  // 2026-07-28 — see that file's doc comment. `this` is its host for the handful of
  // reactions that reach back into Game-owned state (score/meta/room rebuild).
  private readonly events: EventReactor;
  // The tutorial level's teaching-beat toasts (design/10 screen-flow gap) — same
  // render-only, state+events-only shape as EventReactor, only ever consumed while
  // `tutorialActive` (see stepSim). `this` satisfies its tiny Host (`localOwner`).
  private readonly tutorialHints: TutorialHintController;
  // True only for the standalone tutorial level (beginTutorialRun) — always offline,
  // never `this.run.online`. Gates the tutorial hint reactions and where Pause/result-screen
  // confirm/quit actually return to (ModeSelect instead of Forge).

  constructor(app: Application, input: InputSource, audio: AudioBus) {
    this.app = app;
    this.input = input;
    this.audio = audio;
    this.run = new RunState(this.store);
    // Built here (not as a field initializer) — it captures the platform's own renderer
    // resolution, which only exists once `app` is assigned.
    this.quality = new RenderQualityController({
      fx: this.fx,
      scene: this.scene,
      renderer: app.renderer,
      screenSize: () => this.screenSize(),
    });
    this.settingsBinding = new SettingsBinding({ audio, input, quality: this.quality });
    // Same "needs `app`" reason as `quality` above.
    this.artGate = new ArtGate({
      overlay: this.layers.overlay,
      ticker: app.ticker,
      screenSize: () => this.screenSize(),
    });
    // Built here (not as a field initializer) — it needs `this.audio`, which isn't
    // assigned yet when field initializers run.
    this.events = new EventReactor(this.fx, this.hud, this.audio, this);
    this.tutorialHints = new TutorialHintController(this.hud, this);
    this.builder = new CommandBuilder(input);
    // Load persistent meta (bank / unlocks / loadout / chosen character, design/14).
    this.run.loadMeta();
    // Dev/demo `?query=` overrides (readGameQueryParams — see its doc comment for what
    // each means and why the platform guard lives there). Applying them is `RunState`'s
    // job, since every field they set now lives there; what stays here is the one
    // override that builds a Pixi object.
    const q = readGameQueryParams();
    if (q) {
      this.run.applyQueryParams(q);
      if (q.pickupDebug) {
        this.pickupDebugOverlay = new PickupDebugOverlay();
        this.layers.hud.addChild(this.pickupDebugOverlay.view);
      }
    }
    app.stage.eventMode = 'static'; // let the overlay receive pointer taps (web)
    app.stage.addChild(this.layers.root);

    // Volume, language, control layout and quality all take effect at boot, not just after the
    // first settings edit — see `settingsBinding.ts`.
    this.settingsBinding.load();
    this.settingsScreen.onChange = (next) => this.settingsBinding.update(next);
    this.settingsScreen.onBack = () =>
      this.run.settingsReturnPhase === 'paused' ? this.nav.openPauseFromSettings() : this.nav.closeSettings();
  }

  /** One closed perf sampling window (`src/perf`), handed over by whichever entry installed the
   *  monitor. Feeds the auto-downgrade watchdog — see `RenderQualityController.observeWindow`. */
  observePerfWindow(w: FrameWindowLike) {
    this.quality.observeWindow(this.settings.quality, w);
  }

  start() {
    // Ground / walls / pillars are per-room now (buildRoom, driven by the `room_enter`
    // event), so nothing static is built here — only the fixed HUD overlay.
    this.buildHud();

    // Post-processing (design/01 milestone 3): vignette + chromatic-aberration live on
    // `world` only — the `ui` layer (HUD/menus) must stay crisp and undistorted.
    this.fx.attach();

    // Everything late-constructed, in the one order that works, plus the menu mount —
    // `controllers/gameAssembly.ts` carries the order and the reason for each step.
    const parts = assembleGame({
      run: this.run, layers: this.layers, scene: this.scene, fx: this.fx,
      backdrop: this.backdrop, roomBuilder: this.roomBuilder, recorder: this.recorder,
      builder: this.builder, ally: this.ally, input: this.input, events: this.events,
      runOutcome: this.runOutcome, tutorialHints: this.tutorialHints, artGate: this.artGate,
      forgeActions: this.forgeActions, hud: this.hud, hudView: this.hudView,
      touchControlsView: this.touchControlsView, portalPrompt: this.portalPrompt,
      floorCardPrompt: this.floorCardPrompt,
      pickupDebugOverlay: this.pickupDebugOverlay, settingsBtn: this.settingsBtn,
      mainMenu: this.mainMenu, modeSelect: this.modeSelect, pvpPreview: this.pvpPreview,
      matchmaking: this.matchmaking, forge: this.forge, screens: this.screens,
      settingsScreen: this.settingsScreen, pauseMenu: this.pauseMenu,
    }, this);
    this.partyScreen = parts.partyScreen; this.loginScreen = parts.loginScreen;
    this.storeScreen = parts.storeScreen;
    this.gameLoop = parts.gameLoop; this.nav = parts.nav; this.runs = parts.runs;
    this.net = parts.net; this.forgeInput = parts.forgeInput;

    // Every screen's buttons, the HUD's own controls and the two `window` listeners —
    // `controllers/gameWiring.ts`, a table of free functions with no state of its own. What
    // stays here is only the deps object that names the two sides.
    const wiring = {
      run: this.run, nav: this.nav, runs: this.runs, net: this.net,
      forgeInput: this.forgeInput, builder: this.builder, input: this.input,
      hud: this.hud, portalPrompt: this.portalPrompt, floorCardPrompt: this.floorCardPrompt,
      mainMenu: this.mainMenu, modeSelect: this.modeSelect, pvpPreview: this.pvpPreview,
      matchmaking: this.matchmaking, partyScreen: this.partyScreen, loginScreen: this.loginScreen,
      forge: this.forge, storeScreen: this.storeScreen, screens: this.screens, pauseMenu: this.pauseMenu,
      confirm: () => this.confirm(),
      activeSlot: () => this.activeState()?.players[this.run.localOwner]?.activeSlot,
    };
    wireScreens(wiring);
    this.input.attach(this.app.canvas as unknown as InputCanvas);
    wireHud(wiring);
    wireWindow(wiring);

    this.nav.showMenu();
    this.app.ticker.add((t) => this.update(t.deltaMS));
    // `?replay=` — skip the menu and watch the recording instead (dev only).
    if (this.run.replayUrl) void this.runs.beginReplayRun(this.run.replayUrl);
  }

  // ---- Scene construction (static) ----
  //
  // Room/pillar geometry construction now lives in RoomBuilder (extracted 2026-07-28)
  // — see roomBuilder.build() calls in beginArenaDemoRun / EventReactorHost.onRoomEnter.

  private buildHud() {
    // Assembly + the settings button live in `controllers/hudLayer.ts`; the button is
    // MOUNTED by the constructor above every screen, not on this layer (design/10).
    this.settingsBtn = buildHudLayer(this.screenSize(), this.layers, this.hudView, {
      backdrop: this.backdrop, hud: this.hud, touch: this.touchControlsView,
      portal: this.portalPrompt, cards: this.floorCardPrompt,
    }, () => this.nav.openSettings());
  }

  /** GameLoopHost — the tutorial's completion mark (design/10). Delegates; the rule
   *  (idempotent, one-way, saved) lives in `runState.ts`. */
  markTutorialSeen() {
    this.run.markTutorialSeen();
  }

  /** A free character distinct from the local pick, for the co-op bot ally (ROADMAP 3.1). */
  allySkinId(): string {
    return Object.keys(SKIN_DEFS).find((id) => id !== this.run.meta.selectedSkin) ?? this.run.meta.selectedSkin;
  }

  // ---- RunOutcomeHost (see RunOutcome.ts) ----

  currentScore(): number {
    return this.run.score;
  }

  setPhase(phase: 'victory' | 'defeat'): void {
    this.run.phase = phase;
  }

  hideHud(): void {
    this.hudView.visible = false;
  }

  bankRunMaterials(s: GameState): void {
    this.run.meta = bankMaterials(this.run.meta, s.bankedMaterials);
    this.store.save(this.run.meta);
  }

  showOutcomeScreen(won: boolean, title: string, lines: readonly string[], offer: ResultOffer | null = null): void {
    const { w, h } = this.layers.menu.fit(this.screenSize());
    this.screens.show(w, h, won, title, lines, offer);
  }

  /**
   * The live sim state driving the render this frame — the locally-owned engine offline,
   * or the co-op session's engine online (ROADMAP 3.3). All shared render/event/HUD code
   * reads through this so it works identically on both paths (null before a run starts, or
   * online while still connecting/awaiting match_start).
   *
   * Not `private` — this doubles as the EventReactorHost interface EventReactor calls
   * back through (see the `events` field doc comment).
   */
  activeState(): GameState | null {
    return this.run.online ? this.run.session?.state ?? null : this.run.engine?.state ?? null;
  }

  // ---- EventReactorHost (see EventReactor.ts) ----

  addScore(delta: number): void {
    this.run.score += delta;
  }

  onRoomEnter(s: GameState): void {
    this.roomBuilder.build(s);
  }

  onDoorStateChange(s: GameState): void {
    this.roomBuilder.updateDoors(s);
  }

  onForceRegroup(): void {
    // Collapse prev==cur on the local player's view so interpolate() draws the new,
    // teleported position with no lerp-pan (same mechanism Scene.positionLocal/new-
    // entity spawn already use `Entity.snap()` for).
    this.scene.player?.snap();
  }

  onWeaponPickup(weaponId: string): void {
    if (!this.run.meta.unlockedBlueprints.includes(weaponId)) {
      this.run.meta = unlockBlueprint(this.run.meta, weaponId);
      this.store.save(this.run.meta);
    }
  }

  actorAt(id: number): ReturnType<EventReactorHost['actorAt']> {
    return this.scene.actorAt(id);
  }

  confirm() {
    this.audio.resume(); // a confirm tap is a user gesture — clears the autoplay gate (design/11)
    if (this.run.phase === 'menu') this.nav.showForge();
    else if (this.run.phase === 'forge') this.runs.beginRun();
    else if (this.run.phase === 'victory' || this.run.phase === 'defeat') {
      // The tutorial never touched the loadout, so it returns to ModeSelect instead of
      // Forge (design/10 screen-flow gap) — `hasSeenTutorial` was already marked the
      // moment this run hit gameover (stepSim), not here.
      if (this.run.tutorialActive) {
        this.run.tutorialActive = false;
        this.nav.showModeSelect();
      } else {
        this.nav.showForge();
      }
    }
  }

  // ---- Main loop (see GameLoop.ts) ----

  private update(dt: number) {
    this.gameLoop.update(dt);
  }

  // ---- GameLoopHost (see GameLoop.ts) ----

  getPhase(): Phase {
    return this.run.phase;
  }

  isOnline(): boolean {
    return this.run.online;
  }

  isCoop(): boolean {
    return this.run.coop;
  }

  isArenaDemo(): boolean {
    return this.run.arenaDemo !== null;
  }

  isTutorialActive(): boolean {
    return this.run.tutorialActive;
  }

  replayStopTick(): number | null {
    return this.run.replayStop;
  }

  getEngine(): GameEngine | null {
    return this.run.engine;
  }

  getSession(): CoopSession | null {
    return this.run.session;
  }

  selectedSkinId(): string {
    return this.run.meta.selectedSkin;
  }

  // Formula (and the HiDPI bug it fixes) lives in viewport.ts, split out to be unit-testable.
  screenSize() {
    return computeScreenSize(this.app);
  }
}
