// GameLoop's two contracts — what it drives (`GameLoopDeps`) and what it has to ask Game for
// (`GameLoopHost`) — split out of `GameLoop.ts` (CLAUDE.md "500-line file convention", form ①:
// a self-contained unit with no behaviour and no shared state). They sit apart from the loop
// on purpose: these two interfaces, not the class, are what every caller and every test double
// is written against, and keeping them here lets a sibling pass take the same `deps` without
// importing the loop back. `GameLoop.ts` re-exports both, so the split is invisible to callers.

import type { GameEngine, GameState } from '@dd/engine';
import type { CoopSession } from '../../net/CoopSession';
import type { InputSource } from '../../platform/types';
import type { Phase } from '../phase';
import type { CommandBuilder } from './CommandBuilder';
import type { AllyController } from './AllyController';
import type { EventReactor } from './EventReactor';
import type { RunOutcome } from './RunOutcome';
import type { TutorialHintController } from './TutorialHintController';
import type { Scene } from '../scene/Scene';
import type { RoomBuilder } from '../scene/RoomBuilder';
import type { FxController } from '../fx/FxController';
import type { HudView } from '../ui/HudView';
import type { TouchControlsView } from '../ui/TouchControlsView';
import type { PortalPrompt } from '../ui/PortalPrompt';
import type { FloorCardPrompt } from '../ui/FloorCardPrompt';
import type { PickupDebugOverlay } from '../scene/PickupDebugOverlay';
import type { FrameRateLike, WorldLayerLike } from '../powerBudget';

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
  /** Screens with their own per-frame clock outside a run (party poll, Matchmaking timers). */
  lobbyScreens: readonly { update(dt: number): void }[];
  /** Every other full-screen menu, for its backdrop's motion (`ui/MenuShell.ts`) — also
   *  while paused, since the pause menu is one. Each no-ops while hidden. */
  menuScreens: readonly { animate(dt: number): void }[];
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
   * run-lifecycle (`beginRun`) and screen-flow (`showForge`/`showMenu`), neither
   * of which this file owns. */
  confirm(): void;
}
