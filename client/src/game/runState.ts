// Split out of Game.ts, 2026-09-03 — the PURE half of the run: every piece of mutable
// state the shell's controllers read and write, and nothing that draws.
//
// ## Why this exists rather than another controller
//
// CLAUDE.md's split order asks for independent functions first, composition second, and an
// inheritance chain only as a last resort. Game.ts fits none of those on its own, and the
// reason is visible the moment you try: `beginRun`, `showForge`, `quitRun`,
// `finalizeOnlineRun` and `confirm` all read and write the SAME dozen fields — `phase`,
// `meta`, `online`, `tutorialActive`, `engine`, `session`, `score`. Cut the file along any
// behavioural seam and the two halves call each other, which CLAUDE.md names outright as a
// sign the boundary is drawn wrong, with the prescribed answer being "extract a shared lower
// layer both depend on". This is that layer.
//
// So the shape is: `RunState` owns the data, the controllers own the behaviour, and Game.ts
// owns the Pixi objects and the wiring between them. A controller never reaches into another
// controller for state — it reads it here.
//
// ## What it buys, concretely
//
// This file imports no `pixi.js`, touches no DOM global, and constructs nothing that needs a
// renderer. That is what makes `runState.test.ts` able to assert the rules that used to be
// unreachable without a browser: that quitting a run clears the online flag (a real
// pre-existing bug, recorded in `quitRun`'s own comment), that the tutorial flag is one-way
// per run, that `activeState` reads the session online and the engine offline. Before the
// split those rules lived in a class whose constructor needs an `Application`.
//
// `src/game/pureLayerBoundary.test.ts` is what keeps it that way; the 90% coverage gate
// cannot (see that file's header for why a percentage can never guard a boundary).
import type { GameEngine, GameState } from '@dd/engine';
import type { CoopSession } from '../net/CoopSession';
import { defaultMetaState, selectCharacter, type MetaState, type MetaStore } from '../meta';
import type { ArenaId } from './match/arenaCatalog';
import type { GameQueryParams } from './match/gameQueryParams';
import type { Phase } from './phase';

/** Where the settings screen's BACK button returns to — set right before each open. */
export type SettingsReturnPhase = 'menu' | 'forge' | 'paused';
/** Where Cancel/Back on the Matchmaking screen returns to (solo queue vs. a party). */
export type MatchmakingReturnPhase = 'menu' | 'squad';

/** Per-run seed = base + run index. Deterministic, and deliberately not a clock read. */
export const SEED_BASE = 0xda1d;

/** The default matchsvc origin, before any `?mm=` override. */
export const DEFAULT_MATCH_BASE_URL = 'http://localhost:8788';

/**
 * The build-time override (server/deploy/README.md §3): `VITE_MATCHSVC_URL`, injected by
 * `.github/workflows/client-deploy.yml` from the repo variable `MATCHSVC_URL` so a deployed
 * build points at the real backend (`https://bb.gamestao.com`) instead of localhost. Read
 * once at module load — `import.meta.env` is a compile-time replacement, not something that
 * changes at runtime, so capturing it in a constant costs nothing and keeps `RunState`'s own
 * field a plain assignment. Unset (local dev, or a test runner with no such env var) falls
 * back to `DEFAULT_MATCH_BASE_URL`; `?mm=` (gameQueryParams.ts) still overrides either one.
 */
const BUILD_MATCH_BASE_URL: string = import.meta.env.VITE_MATCHSVC_URL || DEFAULT_MATCH_BASE_URL;

/**
 * The matchsvc origin this session talks to, given already-parsed query params — the same
 * precedence `applyQueryParams` below applies (`?mm=` beats the build-time value beats
 * localhost), exported because an ENTRY POINT needs the answer before a `RunState` exists.
 *
 * `main.crazygames.ts` is that caller: a portal build logs the player in before the first
 * screen is drawn (design/20 "account integration"), which means it needs the backend URL
 * without going through the game. Deriving it there instead would be a second copy of this
 * precedence rule, and the copy that is wrong is always the one nobody is looking at.
 */
export function resolveMatchBaseUrl(q: Pick<GameQueryParams, 'matchBaseUrl'>): string {
  return q.matchBaseUrl ?? BUILD_MATCH_BASE_URL;
}

export class RunState {
  // ── screen / run phase ────────────────────────────────────────────────────
  phase: Phase = 'menu';
  settingsReturnPhase: SettingsReturnPhase = 'menu';
  matchmakingReturnPhase: MatchmakingReturnPhase = 'menu';

  // ── the run itself ────────────────────────────────────────────────────────
  runCount = 0;
  score = 0;
  engine: GameEngine | null = null;
  session: CoopSession | null = null;
  /** True only for the standalone tutorial level — always offline, never `online`. */
  tutorialActive = false;
  /**
   * True for a player's FIRST REAL run, when they have never been taught (design/20's
   * onboarding pass, 2026-09-08) — the same `TutorialHintController` beats the standalone
   * tutorial drives, over a real dungeon and the player's own loadout.
   *
   * Separate from `tutorialActive` rather than folded into it, because three other readers
   * mean "the standalone level" by that flag and would all be wrong here: the pause menu's
   * SKIP TUTORIAL label (`ScreenNav`), the quit route back to the lobby instead of the
   * Forge (`endRun`), and the tutorial's own fixed config. What the two DO share is the
   * teaching, which is why `Game.isTeaching()` is the union of them and is what `GameLoop`
   * gates the hints on.
   */
  firstRunHints = false;
  /**
   * A meta sync that arrived while a run was in flight and is waiting for the hub
   * (`isHubPhase`). Set by `OnlineMatch.syncMetaWithSession`, cleared by its
   * `flushPendingMetaSync`, which `ScreenNav` calls on the way into the menu or the forge.
   *
   * Lives here rather than inside `OnlineMatch` for the same reason `phase` does: it is a
   * fact about the run's relationship to the meta layer, and `RunState` is where the two
   * concerns already meet.
   */
  pendingMetaSync = false;

  // ── seat / mode ───────────────────────────────────────────────────────────
  // Local co-op (ROADMAP 3.1): the seat THIS client drives, and an optional second seat
  // driven locally by a bot ally so the SECOND player is live + visible (the engine now
  // builds N seats via EngineConfig.players). `?coop=1` opts a run in (a dev toggle, like
  // `?skin=`); default single-player builds one seat and is byte-identical.
  // Online co-op (ROADMAP 3.3): `?online=1` runs the run off a REAL matchmade socket
  // instead — matchmaking → signed ticket → CoopSession drives the engine off the
  // server's confirmed frame stream. `localOwner` is then the ticket-assigned seat (set
  // from match_start), not a fixed 0, so each client's camera follows its own player.
  localOwner = 0;
  coop = false;
  online = false;
  // `?pvp=1` (design/15, ROADMAP Phase 4 closeout) — a REAL matchmade PvP arena run:
  // requests an 8-seat (default; `?seats=` overrides for local two-tab testing) 'pvp'-
  // mode match instead of 2-seat 'coop', builds an arena EngineConfig (ARENA_CATALOG +
  // squad-chunked teamIds, design/05/15) from `match_start`, and reports win/lose by
  // placement instead of the PvE extract/wipe outcome. Reuses the entire online/
  // CoopSession path `?online=1` already proved out — only `mode` and the config it
  // builds differ.
  pvp = false;
  pvpSeats = 2;
  // A pre-formed party's id (design/05/15's squad follow-up, SQUAD screen) — set by
  // beginSquadMatch, threaded into connectOnlineSession so every member's `POST /find`
  // groups into one squad chunk. Undefined for a plain `?pvp=1` boot-flag solo queue.
  partyId?: string;
  // WHICH map the DEV-ONLY local-arena harness boots, or null when it is off. `?arenaDemo=1`
  // is the original small synthetic fixture; `?arena=<id>` picks any catalog map, and is the
  // only way to WALK the real 60-room launch map in a single tab (no matchmaking, no second
  // tab, no matchsvc). Still not a substitute for `?pvp=1`: no ticketed seats, no HP/weapon
  // scaling. Drives the second seat through the coop bot-ally submit path (see GameLoop).
  arenaDemo: ArenaId | null = null;

  // ── dev harnesses ─────────────────────────────────────────────────────────
  matchBaseUrl = BUILD_MATCH_BASE_URL;
  // `?lag=` DEV harness (LaggyTransport, CoopSession construction in the matchmaking
  // controller) to feel/tune the online predictor's smoothing without real devices — the
  // predictor itself lives in GameLoop.
  lagMs = 0;
  // `?replay=<url>` (dev) — the recorded run being watched, and the tick playback holds
  // at. Both null in a normal session. See match/replayPlayback.ts.
  replayUrl: string | null = null;
  replayStop: number | null = null;

  // ── persistent meta ───────────────────────────────────────────────────────
  meta: MetaState;

  constructor(readonly store: MetaStore) {
    this.meta = defaultMetaState();
  }

  /** Load persistent meta (bank / unlocks / loadout / chosen character, design/14). */
  loadMeta(): void {
    this.meta = this.store.load();
  }

  /** Replace `meta` and persist it. Every write goes through here so no caller can
   *  update the in-memory copy and forget the save — which is how a crafted loadout
   *  survives a reload but a banked material does not. */
  setMeta(next: MetaState): void {
    this.meta = next;
    this.store.save(this.meta);
  }

  /**
   * Apply the dev/demo `?query=` overrides. Split from `readGameQueryParams` (which does
   * the parsing and the platform guard) so the APPLICATION of them is testable without a
   * `location` — and so the precedence rules below are stated once, in a readable place.
   *
   * `?skin=` only overrides to a character the account owns; `selectCharacter` enforces
   * that, so an unowned id leaves the current pick standing rather than erroring.
   */
  applyQueryParams(q: GameQueryParams): void {
    if (q.skinOverride) this.meta = selectCharacter(this.meta, q.skinOverride);
    this.coop = q.coop;
    this.online = q.online;
    this.arenaDemo = q.arenaDemo;
    this.pvp = q.pvp;
    // Each of these three is only applied when PRESENT — `null` means "no override", and
    // assigning it would replace a real default with nothing (a matchBaseUrl of `null`
    // sends every request to the string "null/find").
    if (q.pvpSeats !== null) this.pvpSeats = q.pvpSeats;
    if (q.matchBaseUrl !== null) this.matchBaseUrl = q.matchBaseUrl;
    if (q.lagMs !== null) this.lagMs = q.lagMs;
    if (q.loadoutOverride) this.meta = { ...this.meta, loadout: q.loadoutOverride };
    this.replayUrl = q.replayUrl;
  }

  /**
   * The live sim state driving the render this frame — the locally-owned engine offline,
   * or the co-op session's engine online. All shared render/event/HUD code reads through
   * this so it works identically on both paths (null before a run starts, or online while
   * still connecting/awaiting match_start).
   */
  activeState(): GameState | null {
    return this.online ? (this.session?.state ?? null) : (this.engine?.state ?? null);
  }

  /** The seed for the next run to start. */
  nextRunSeed(): number {
    return SEED_BASE + this.runCount;
  }

  /**
   * Guest-local, account-independent (design/10) — set once, on tutorial completion OR
   * skip alike. Idempotent: a no-op (no extra save) once already true.
   */
  markTutorialSeen(): void {
    if (this.meta.hasSeenTutorial) return;
    this.setMeta({ ...this.meta, hasSeenTutorial: true });
  }

  /**
   * The state half of a voluntary quit: drop whichever run handle is live and clear the
   * per-run flags. Returns whether the run being abandoned was the tutorial, because the
   * caller routes to a different screen for it (the lobby, not Forge — a tutorial run
   * never touched the loadout).
   *
   * Clearing `online` here is load-bearing and was a real bug before the split: `quitRun`
   * never reset it, so a later OFFLINE run inherited a stale online flag and both
   * `activeState()` and the sim step keyed off it — the run rendered from a session that
   * was already closed.
   */
  endRun(): { wasTutorial: boolean } {
    if (this.online) {
      this.session?.close();
      this.session = null;
    } else {
      this.engine = null;
    }
    this.online = false;
    const wasTutorial = this.tutorialActive;
    this.tutorialActive = false;
    this.firstRunHints = false;
    return { wasTutorial };
  }
}
