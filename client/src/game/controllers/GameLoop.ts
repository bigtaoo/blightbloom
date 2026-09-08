import { hashState, PLAYER_BASE, roomRects, type GameEngine, type GameEvent, type GameState } from '@dd/engine';
import type { CoopSession } from '../../net/CoopSession';
import type { InputSource } from '../../platform/types';
import type { Phase } from '../phase';
import { updateMusicForFrame } from '../musicDirector';
import { fpToPx, bradToRad } from '../coords';
import { ELEMENT_COLORS } from '../theme';
import { LocalPredictor, DEFAULT_PREDICTOR } from './LocalPredictor';
import type { CommandBuilder } from './CommandBuilder';
import type { AllyController } from './AllyController';
import type { EventReactor } from './EventReactor';
import type { RunOutcome } from './RunOutcome';
import type { TutorialHintController } from './TutorialHintController';
import type { Scene } from '../scene/Scene';
import type { RoomBuilder } from '../scene/RoomBuilder';
import { MAX_WALL_HEIGHT } from '../scene/wallGeometry';
import { DoorFxDriver } from '../scene/doorTick';
import type { OcclusionFocus } from '../scene/occlusion';
import type { FxController } from '../fx/FxController';
import type { HudView } from '../ui/HudView';
import type { TouchControlsView } from '../ui/TouchControlsView';
import type { PortalPrompt } from '../ui/PortalPrompt';
import type { FloorCardPrompt } from '../ui/FloorCardPrompt';
import { updateCheckpointOverlays } from './checkpointOverlays';
import type { PartyScreen } from '../screens/PartyScreen';
import type { PickupDebugOverlay } from '../scene/PickupDebugOverlay';
import { applyPowerBudget, type FrameRateLike, type WorldLayerLike } from '../powerBudget';

const SIM_DT_MS = 1000 / 30; // fixed sim step: the engine runs at 30 Hz (design/06)
const MAX_STEPS = 5; // catch-up cap per render frame → no spiral of death

/** Every already-independent collaborator the main loop drives — none of these need a
 * host callback themselves (they're either stateless adapters or, for `runOutcome`/
 * `events`/`tutorialHints`, already wired to Game as THEIR OWN host — GameLoop just
 * calls through them transparently, same as Game itself used to). */
export interface GameLoopDeps {
  scene: Scene;
  roomBuilder: RoomBuilder;
  fx: FxController;
  hud: HudView;
  touchControlsView: TouchControlsView;
  portalPrompt: PortalPrompt;
  floorCardPrompt: FloorCardPrompt;
  partyScreen: PartyScreen;
  /** `layers.world` and the app ticker, each narrowed to the one knob `powerBudget.ts`
   *  writes: the world is not DRAWN outside a run, and the render rate is capped. */
  world: WorldLayerLike;
  ticker: FrameRateLike;
  builder: CommandBuilder;
  ally: AllyController;
  input: InputSource;
  events: EventReactor;
  runOutcome: RunOutcome;
  tutorialHints: TutorialHintController;
  /** `?pickupDebug=1` only — see gameQueryParams.ts and PickupDebugOverlay's own doc
   *  comment. Null in every normal session. */
  pickupDebugOverlay: PickupDebugOverlay | null;
}

/** The bits of Game the main loop needs but doesn't own itself — `phase`/`engine`/
 * `session`/`meta`/the co-op/PvP-demo flags are all genuinely shared with the run-
 * lifecycle and forge concerns (no single one of them owns these more than another),
 * so this stays a callback interface (same EventReactor/RunOutcome-style decoupling:
 * this file never imports Game.ts). Several of these (`activeState`/`currentScore`)
 * are methods Game already implements for EventReactorHost/RunOutcomeHost — reused
 * here rather than duplicated. */
export interface GameLoopHost {
  getPhase(): Phase;
  isOnline(): boolean;
  isCoop(): boolean;
  isArenaDemo(): boolean;
  /** Whether this run is TEACHING — the standalone tutorial level, or a first-time
   *  player's first real run (`RunState.firstRunHints`). The hint toasts and the
   *  "tutorial seen" mark both key off this rather than off the tutorial flag alone. */
  isTeaching(): boolean;
  /** `?replay=` playback only (design/06 replay, match/replayPlayback.ts): the tick the
   *  recording is being watched AT. Non-null means the run's input comes from the
   *  recorded stream, so nothing here may submit a live command — and once that tick is
   *  reached the sim stops advancing while the render loop keeps running, which is what
   *  makes the reported moment inspectable. Null in every normal session. */
  replayStopTick(): number | null;
  readonly localOwner: number;
  getEngine(): GameEngine | null;
  getSession(): CoopSession | null;
  activeState(): GameState | null;
  currentScore(): number;
  selectedSkinId(): string;
  allySkinId(): string;
  screenSize(): { w: number; h: number };
  /** Guest-local "tutorial seen" flag — shared with quitRun's Skip path, so it stays
   * on the host rather than duplicated here. */
  markTutorialSeen(): void;
  /** Phase-routing on a menu/result-screen confirm (Fire/Enter) — reaches into
   * run-lifecycle (`beginRun`) and screen-flow (`showForge`/`showModeSelect`), neither
   * of which this file owns. */
  confirm(): void;
}

/**
 * The fixed-step sim + interpolated render main loop, split out of Game.ts (CLAUDE.md
 * "500-line file convention", form ② — independent class + composition): `update()`'s
 * three branches (playing/paused/idle), the offline fixed-step loop (`advanceSim`/
 * `stepSim`) and its online counterpart (`advanceOnline`, latency-hiding local-player
 * prediction), plus the render-side adapters they share (`spawnBulletTrails`/
 * `updateFx`/`updateCamera`/`updateHud`). Owns the accumulator (`acc`) and the online
 * local-player predictor (`predictor`/`predLastTick`) as its own private state — none
 * of those are read anywhere outside these methods, unlike `phase`/`engine`/`session`/
 * `meta` (which stay on Game, see `GameLoopHost`'s own doc comment). Result-screen
 * confirm used to be polled here too (a raw fire-button rising edge, `confirmEdge.ts`)
 * — removed 2026-08-17 in favor of `Screens.ts`'s own explicit CONFIRM button, the
 * same "driven exclusively by its own Buttons" rule every other screen already
 * followed (see that file's doc comment for why the raw-input path was a real bug
 * source, not just a redundancy).
 */
export class GameLoop {
  private acc = 0; // accumulated real time (ms) not yet consumed by a sim step

  // Online local-player prediction (design/06): the render layer draws the local seat's own
  // movement/aim ahead of the confirmed frame stream to hide RTT, then eases to the
  // authoritative position. Render-only — the sim is untouched. `lagMs` is a `?lag=` DEV
  // harness (LaggyTransport, wired at CoopSession construction in Game.ts) to feel/tune
  // the smoothing without real devices.
  private readonly predictor = new LocalPredictor({
    // Match the sim's own speed so predicted ≈ confirmed at zero latency: player moves
    // PLAYER_BASE.speedPerTick per 30 Hz tick (players.ts) → px/sec.
    speedPxPerSec: fpToPx(PLAYER_BASE.speedPerTick) * (1000 / SIM_DT_MS),
    ...DEFAULT_PREDICTOR,
  });
  private predLastTick = -1;
  private readonly doorFx = new DoorFxDriver(); // per-frame fixture motion (`scene/doorTick.ts`)

  // Reused every `updateFx` call instead of a fresh array of fresh objects per render frame
  // (`Scene.enemiesScratch` is the same idea one layer down) — occlusion runs at render rate
  // for every live actor, and `.map()`-ing a new `{x,y,halfW,bodyH}` per enemy every frame is
  // needless churn in a room with any real number of mobs. Cleared and refilled in place each
  // call; safe because `RoomBuilder.updateOcclusion` only ever reads it synchronously within
  // the same call, never stores or diffs it across frames.
  private readonly occlusionFociScratch: OcclusionFocus[] = [];

  constructor(
    private readonly deps: GameLoopDeps,
    private readonly host: GameLoopHost,
  ) {}

  /** Run lifecycle's `resetRunRenderState` (Game.ts) — a fresh run always starts with
   * a clean accumulator, whether offline or (via `resetOnlinePrediction` below,
   * separately) online. */
  resetForNewRun(): void {
    this.acc = 0;
  }

  /** Run lifecycle's `finalizeOnlineRun` (Game.ts) — re-anchors the predictor on the
   * first confirmed frame of a newly-connected match. */
  resetOnlinePrediction(): void {
    this.predictor.deactivate();
    this.predLastTick = -1;
  }

  update(dt: number): void {
    const phase = this.host.getPhase();
    // What this frame is allowed to cost: outside a run the world layer is provably invisible
    // and is not drawn, and the render rate is capped so a 120 Hz panel does not spend twice
    // the battery on a 30 Hz sim. `powerBudget.ts` holds the measurement and the reasoning.
    applyPowerBudget(phase, this.deps.world, this.deps.ticker);
    // Music (design/11), before the branch so it runs in EVERY phase — the menu bed is as much
    // a case as the dungeon one. `musicDirector` derives the track from the situation and
    // setting the one already playing is a no-op, so there is no transition to detect here and
    // nothing to keep in step with the phase branches below. It reaches the audio device through
    // a module sink rather than a dep for the reason that file's header records: wiring one
    // would have to land in `Game.ts`, whose length the drift gate pins.
    updateMusicForFrame(
      { phase, state: this.host.activeState(), localOwner: this.host.localOwner },
      dt,
    );
    if (phase === 'playing') {
      if (this.host.isOnline()) this.advanceOnline(dt);
      else this.advanceSim(dt);
    } else if (phase === 'paused') {
      // Genuinely frozen (offline-only, see Game.pause()'s doc comment): advanceSim/
      // advanceOnline are never called, so `acc` simply doesn't move — the same
      // no-catch-up-burst property hitStopMs already relies on. fx keeps fading so
      // the frozen frame doesn't look inert.
      this.updateFx(dt);
      this.deps.scene.interpolate(1, dt);
    } else {
      // Menu / result / squad lobby: freeze the last frame, keep fx fading. Confirm is
      // now driven entirely by Screens.ts's own Button taps (Game.ts wires them), not
      // polled here. `partyScreen.update` no-ops when hidden, so it's safe to call
      // unconditionally rather than gating on `phase === 'squad'` here too.
      this.updateFx(dt);
      this.deps.scene.interpolate(1, dt);
      this.deps.partyScreen.update(dt);
    }
  }

  private advanceSim(dt: number): void {
    // Hit-stop (design/01 milestone 3): a brief FULL freeze of sim ticks on a strong
    // hit — offline/local only (see FxController's `hitStopMs` field doc). Render (fx/
    // particles/camera shake) keeps animating through the freeze; only `stepSim` is
    // skipped, and `acc` deliberately does NOT accumulate `dt` while frozen, so the sim
    // resumes at a clean single-tick cadence afterward instead of bursting through a
    // catch-up.
    if (this.deps.fx.consumeHitStop(dt)) {
      // frozen this frame — sim skipped, render still animates below
    } else {
      this.acc += dt;
      let steps = 0;
      while (this.host.getPhase() === 'playing' && this.acc >= SIM_DT_MS && steps < MAX_STEPS) {
        this.stepSim();
        this.acc -= SIM_DT_MS;
        steps++;
      }
      if (steps >= MAX_STEPS) this.acc = 0; // drop the backlog after a long stall
    }

    const alpha = this.host.getPhase() === 'playing' ? Math.min(1, this.acc / SIM_DT_MS) : 1;
    this.deps.scene.interpolate(alpha, dt);
    this.updateFx(dt);
    this.updateCamera(alpha);
    if (this.host.getPhase() === 'playing') {
      this.updateHud(dt);
      this.deps.touchControlsView.update(this.deps.input.getTouchVisual());
    }
  }

  // One deterministic sim frame: collect input → command → advance the engine →
  // mirror the new state into views → react to this tick's events.
  private stepSim(): void {
    const engine = this.host.getEngine()!;
    const s = engine.state;
    const localOwner = this.host.localOwner;
    const p = s.players[localOwner];

    // Replay playback: the recorded stream IS the input, so a live command must not be
    // submitted over it (ReplayInputSource would throw — it is read-only by design), and
    // the sim holds still once the watched tick is reached.
    const replayStop = this.host.replayStopTick();
    if (replayStop !== null && s.tick >= replayStop) return;

    const frame = s.tick + 1;
    if (replayStop === null) {
      engine.submit(this.deps.builder.build(frame, localOwner));
      // Local co-op (ROADMAP 3.1) — and the `?arenaDemo=1` dev harness, which reuses this
      // exact path: every non-local seat is driven by the bot ally, whose command goes
      // through the exact same submit path a networked teammate's would — the engine
      // can't tell a local bot from a remote player.
      if (this.host.isCoop() || this.host.isArenaDemo()) {
        for (let owner = 0; owner < s.players.length; owner++) {
          if (owner !== localOwner) engine.submit(this.deps.ally.build(s, owner, localOwner, frame));
        }
      }
    }
    const events = engine.advance(frame) ?? [];

    this.deps.scene.reconcile(s, p?.id ?? -1); // camera follows the LOCAL seat
    this.spawnBulletTrails(s);
    this.consumeEvents(events);
    // Tutorial-only teaching-beat toasts (design/10 screen-flow gap) — render-only,
    // reads the same state+events every real run's HUD/fx already read.
    if (this.host.isTeaching()) this.deps.tutorialHints.consume(s, events);

    if (s.phase === 'gameover') {
      if (this.host.isTeaching()) this.host.markTutorialSeen();
      this.deps.runOutcome.handle(s);
    }
  }

  /**
   * The online counterpart to advanceSim. The SERVER is the clock: each render frame we
   * relay the local seat's latest command and drain every frame the server has confirmed
   * (CoopSession.drive self-paces the catch-up), then mirror the resulting state. The LOCAL
   * seat's movement is drawn from a render-layer predictor ahead of the confirmed frame
   * (design/06 latency-hiding) and eased back on each confirmed frame; remote seats/enemies/
   * bullets stay confirmed. Weapon-facing is never predicted (design/10 v33: it's engine-
   * decided, not player input) — it's read straight off the confirmed state every frame,
   * same as every other actor. The sim is never touched — determinism is preserved.
   */
  private advanceOnline(dt: number): void {
    const session = this.host.getSession();
    if (!session || !session.started) {
      // Connecting / awaiting match_start — hold the scene, keep fx fading.
      this.deps.scene.interpolate(1, dt);
      this.updateFx(dt);
      return;
    }
    const s = session.state!;
    const localOwner = this.host.localOwner;
    const p = s.players[localOwner];

    // Relay this render tick's local command (server stamps the authoritative seat/frame).
    const cmd = this.deps.builder.build(session.frame, localOwner);
    session.submit(cmd);

    // Predict the local seat's own motion for THIS render frame (before draining confirmed
    // frames) so movement responds instantly under latency. Suspended when downed/dead.
    const predicting = !!p && p.alive && !p.downed;
    if (predicting) this.predictor.predict(cmd.moveBrad, cmd.moveMag, dt);

    const events = session.drive();

    // Reconcile toward the confirmed local position — but ONLY when a new confirmed frame
    // landed (a stall must not drag the prediction back); first activation snaps to spawn.
    if (predicting && p) {
      if (!this.predictor.isActive) {
        this.predictor.reset(fpToPx(p.gx), fpToPx(p.gy), bradToRad(p.facing));
      } else if (s.tick > this.predLastTick) {
        this.predictor.reconcile(fpToPx(p.gx), fpToPx(p.gy));
      }
      this.predLastTick = s.tick;
    } else {
      this.predictor.deactivate();
    }

    this.deps.scene.reconcile(s, p?.id ?? -1); // camera follows the LOCAL (ticket-assigned) seat
    // Draw the local seat from the predictor (camera follows it too); remote seats confirmed.
    if (predicting && p && this.predictor.isActive) {
      const pose = this.predictor.pose;
      this.deps.scene.positionLocal(pose.x, pose.y, fpToPx(p.z), bradToRad(p.facing), pose.moving);
    }
    this.spawnBulletTrails(s);
    this.consumeEvents(events);
    this.deps.scene.interpolate(1, dt);
    this.updateFx(dt);
    this.updateCamera(1);
    this.updateHud(dt);
    this.deps.touchControlsView.update(this.deps.input.getTouchVisual());

    if (s.phase === 'gameover') {
      // Report the local end-of-match hash (+ placements, for a PvP result) so the
      // server's checkpoint/hash-verified settlement — and, for PvP, the matchsvc
      // ladder-rating report (design/15, ROADMAP 4.4/4.6) — actually fires for a REAL
      // match. Exactly once: this branch only runs while `phase === 'playing'`, and
      // runOutcome.handle always moves it to 'victory'/'defeat' before returning.
      session.reportResult(hashState(s));
      this.deps.runOutcome.handle(s);
    }
  }

  // Events are the only engine→render channel (design/08): fx feedback + score + audio.
  // The actual per-event-type reactions live in EventReactor.
  //
  // The one thing that reaches the reactor without being an event is `scene.spawnedActors`,
  // the count of actor views the reconcile immediately above just built. There is no `spawn`
  // event to carry it — an id appearing in `GameState` is a diff, and `Scene` is the only
  // thing that computes diffs (the same reason `Actor.onSpawn` is driven from there). Read
  // here rather than inside the reactor so the ordering stays visible: it describes the
  // reconcile that ran this frame, and every call site below reconciles first.
  private consumeEvents(events: readonly GameEvent[]): void {
    this.deps.events.consume(events, this.deps.scene.spawnedActors);
  }

  // ---- fx / camera / hud (FxController/HudView do the actual work — see those files) ----

  // Per-element bullet trails (design/03/07). Once per sim tick, drop a fading
  // element-coloured dot at each live elemental bullet's position; the fx fade
  // (FxController.updateFx) turns the string of dots into a comet tail. Physical
  // rounds leave none — the trail IS the "this shot is elemental" tell, matched to
  // the bullet's glow and the aura it will leave on a hit. Render-only: reads
  // engine state, never writes it (design/08).
  private spawnBulletTrails(s: GameState): void {
    for (const b of s.projectiles) {
      if (!b.alive) continue;
      const color = ELEMENT_COLORS[b.damageType];
      if (color === undefined) continue; // physical → no trail
      this.deps.fx.trailDot(fpToPx(b.gx), fpToPx(b.gy), color, fpToPx(b.radius) * 0.9);
    }
  }

  // Thin adapters: FxController itself is decoupled from GameState/phase/screen size,
  // so these gather this frame's derived values (dust bounds, viewport, camera target)
  // and hand them down — the only reason these still live here rather than being
  // inlined at every call site.
  private updateFx(dt: number): void {
    const s = this.host.activeState();
    const dustBounds = s ? { x: 0, y: 0, w: fpToPx(s.worldW), h: fpToPx(s.worldH) } : undefined;
    this.deps.fx.updateFx(dt, this.host.getPhase() === 'playing' ? 700 : 0, dustBounds);

    // Dynamic lighting (design/01 milestone 2): the local player carries their own
    // persistent glow, re-registered at their current position every frame rather than
    // tracked as a one-time spawn; every other point light (muzzle flash/impact bursts)
    // is registered directly by FxController.flash. This one `updateFx` wrapper is
    // already called from every render path (paused/menu/offline/online), so registering
    // here covers all of them with no per-path wiring.
    //
    // What used to follow — `scene.applyLighting`, one `strongestAt` scan and one uniform
    // write PER ACTOR — is gone (2026-08-24). The whole set is uploaded once, to the single
    // scene-lighting pass, by `FxController.updateCamera`, which is where the camera
    // transform this frame's world→region mapping needs is settled.
    const player = this.deps.scene.player;
    if (player) this.deps.fx.lights.addPersistent('local', { x: player.curX, y: player.curY, color: 0xfff4d6, radius: 140, intensity: 0.35 });
    else this.deps.fx.lights.removePersistent('local');

    // Occlusion x-ray (design/01 "Limits of fake 3D"): a standing wall block or pillar that is
    // currently drawing over the local player OR any live enemy goes translucent so nobody can
    // be lost behind it (live report *"如果只有怪物在墙下面的话，就看不到怪物了"* — a monster got no
    // x-ray at all when it, rather than the player, stood in the hidden band). Piggy-backs on
    // this wrapper for exactly the reason the lighting above does — it is already called from
    // every render path (playing/paused/menu/offline/online), and it already has this frame's dt.
    //
    // Every live pickup is a focus too (live report *"被墙挡住的物品，只有角色走到墙下的时候才显示"*):
    // a drop can't walk into the hidden band the way a player/enemy does, but a wall doesn't care
    // WHY something behind it needs to stay visible — feeding its position in the same way makes
    // the wall over it fade unconditionally instead of only while a character is also close
    // enough to trigger that fade for themselves.
    const foci = this.occlusionFociScratch;
    let n = 0;
    const putFocus = (x: number, y: number, sil: { halfW: number; bodyH: number }): void => {
      // Reuse the object already sitting at this slot from a previous frame — only a slot
      // beyond last frame's count (the array was truncated to it below) is actually new.
      let f = foci[n];
      if (!f) foci[n] = f = { x: 0, y: 0, halfW: 0, bodyH: 0 };
      f.x = x; f.y = y; f.halfW = sil.halfW; f.bodyH = sil.bodyH;
      n++;
    };
    for (const e of this.deps.scene.enemies) putFocus(e.curX, e.curY, e.bodySilhouette);
    if (player) putFocus(player.curX, player.curY, player.bodySilhouette);
    for (const p of this.deps.scene.pickups) putFocus(p.curX, p.curY, p.bodySilhouette);
    foci.length = n; // drop any stale slots left over from a frame with more foci than this one
    this.deps.roomBuilder.updateOcclusion(foci, dt);

    // Animated fixtures (`scene/doorFx.ts`, `Portal`) + the client-derived refusal flash, on this
    // wrapper for the same reason as the two passes above. See `doorTick.ts` for the whole rule.
    const d = this.deps;
    this.doorFx.frame(dt, s?.dungeonDoors ?? [], d.roomBuilder, d.fx, player, d.builder.lastMove);
  }

  private updateCamera(alpha: number): void {
    const s = this.host.activeState();
    const worldSize = s ? { w: fpToPx(s.worldW), h: fpToPx(s.worldH) } : null;
    const { w: vw, h: vh } = this.host.screenSize();
    this.deps.fx.updateCamera(alpha, { vw, vh }, worldSize, this.deps.scene.player, this.cameraFrame(s));
  }

  /**
   * The rect the camera should FILL: the local player's current room, in world px
   * (`FxController.updateCamera`'s `frame` — see its doc for why the whole floor is the
   * wrong thing to fit). Both co-resident room models expose the same pre-converted
   * `{id, rect}` list and the engine already caches which one each actor is standing in
   * (`EnvironmentSystem` refreshes `Actor.roomId` every tick), so this is a lookup, not
   * a geometry test. Null whenever there is no room to frame — a flat `waves`/tutorial
   * config, or the tick before the player's `roomId` resolves (standing in a door
   * passage clears it) — and `updateCamera` falls back to the whole world for those.
   */
  private cameraFrame(s: GameState | null): { x: number; y: number; w: number; h: number } | null {
    const roomId = s?.players[this.host.localOwner]?.roomId;
    if (!s || roomId === undefined) return null;
    const rects = roomRects(s);
    const hit = rects.find((r) => r.id === roomId);
    if (!hit) return null;
    // Grown upward by the TALLEST a wall can be (2026-08-18): the room's walls STAND rather
    // than lie flat (design/01, `scene/wallGeometry.ts`), so its north wall is drawn up to
    // MAX_WALL_HEIGHT px above the room rect's own top edge. Fitting the bare rect would push
    // that face off the top of the viewport — the one thing the standing walls exist to show.
    // This has to track the MAXIMUM, not the typical: a room's perimeter walls are taller
    // than its interior blocks (`wallHeight`), and the perimeter is what borders this rect.
    return {
      x: fpToPx(hit.rect.x),
      y: fpToPx(hit.rect.y) - MAX_WALL_HEIGHT,
      w: fpToPx(hit.rect.w),
      h: fpToPx(hit.rect.h) + MAX_WALL_HEIGHT,
    };
  }

  private updateHud(dt: number): void {
    const s = this.host.activeState();
    if (!s) return;
    this.deps.hud.update(s, dt, {
      localOwner: this.host.localOwner,
      score: this.host.currentScore(),
      selectedSkin: this.host.selectedSkinId(),
      showAlly: this.host.isCoop() || this.host.isArenaDemo(),
      allySkinId: this.host.allySkinId(),
      // Read off the live session rather than through a new host method: `getSession()` is
      // already on this interface, and `Game.ts` sits at exactly its 500-line limit.
      seatNames: this.host.getSession()?.seatNames,
      // Offline only: an online match's record is the server's confirmed stream, and a
      // replay-driven session is already replaying somebody else's file.
      canSaveReplay: !this.host.isOnline() && this.host.replayStopTick() === null,
    });
    this.deps.pickupDebugOverlay?.update(s);

    // Everything that appears once a floor is finished — the portal, its popup, the
    // floor-card offer, and the fire suppression they share — is one pass off one
    // condition (`controllers/checkpointOverlays.ts`).
    updateCheckpointOverlays(s, this.host.localOwner, {
      roomBuilder: this.deps.roomBuilder,
      portalPrompt: this.deps.portalPrompt,
      floorCardPrompt: this.deps.floorCardPrompt,
      suppressFire: (active) => this.deps.builder.suppressFire(active),
    });
  }
}
