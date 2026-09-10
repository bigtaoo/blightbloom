// The three analytics events that are DERIVED from the frame rather than announced by a
// call site: `screen_view`, `run_start`, and the `abandon` half of `run_end` (design/21 §2.2).
//
// ## Why derived
//
// `RunState.phase` is written in thirteen places in `ScreenNav.ts`, plus `RunLifecycle` and
// `Game.setPhase`. A `track()` call in each would be fifteen chances to forget one, and a
// forgotten one shows up as a funnel step that merely looks unpopular — the failure mode this
// whole design keeps trying to avoid. So this module compares against the last phase it saw
// and is called once per frame from `GameLoop.update`, which is the same argument
// `powerBudget.ts` makes in its own header, from the same call site: "nothing has to be wired
// into the several places that write `RunState.phase`."
//
// It buys one thing beyond tidiness. **Abandonment is detected, not reported.** There is no
// single "the player quit" path — the pause menu, a confirm dialog, a portal-driven exit and
// anything added later all just move the phase — so a `run_end{outcome:'abandon'}` emitted
// from a quit handler would miss every route nobody thought of. Leaving the run phases for
// anything that is not a result screen IS an abandon, whatever caused it.
//
// ## Reached through the module-level `track`
//
// The convention `musicDirector.ts` established from this exact call site: a dep would have
// to be threaded through `Game.ts`, whose length the drift gate pins. `track` is a no-op
// until an entry point installs analytics, so a test and a tool cost one comparison per
// frame. All three entry points install one — the WeChat build since 2026-09-09, when the
// `wx.getStorageSync` identity store made its install id persist; see `main.wechat.ts` for
// why a per-visit id was a reason to send nothing at all.
import { track } from '../net/analytics';
import type { Phase } from './phase';

/**
 * Minimal view of a run — only what an event carries. Structural so this file needs neither
 * the engine's `GameState` nor a running sim to be tested.
 *
 * `character` arrives already resolved rather than as a players array plus an index,
 * deliberately: which seat is the local one is a question `GameLoop` already has the answer
 * to (`host.localOwner`), and taking `players[0]` here would be right in every solo run and
 * silently wrong in every PvP match — reporting whichever seat the engine happened to list
 * first as the character this player chose.
 */
export interface TrackedState {
  tick: number;
  floorIndex: number;
  /** The local seat's render key (`SkinDef.atlasKey`, e.g. `char_vanguard`), when known. */
  character?: string;
}

/** Ticks per second, matching the engine's own rate. Duplicated rather than imported so
 *  this module stays free of engine imports; asserted equal in its test. */
export const TICK_RATE = 30;

/**
 * Phase → the id reported as `screen`.
 *
 * An explicit table rather than a camelCase-to-snake_case helper, and the second reason is
 * the load-bearing one. The server's `id` charset is `[a-z0-9_.:-]`, so a camelCase phase
 * like `pvpPreview` would be REFUSED and its funnel step would silently never appear.
 * `Record<Phase, string>` is exhaustive, so a new phase is a compile error here — which
 * forces the one decision worth forcing: is this new screen a funnel step, and what is it
 * called?
 */
export const SCREEN_IDS: Record<Phase, string> = {
  menu: 'menu',
  forge: 'forge',
  pvpPreview: 'pvp_preview',
  matchmaking: 'matchmaking',
  playing: 'playing',
  paused: 'paused',
  victory: 'victory',
  defeat: 'defeat',
  settings: 'settings',
  squad: 'squad',
  account: 'account',
  store: 'store',
};

/**
 * The phases that mean "a run is in progress".
 *
 * `paused` is one of them: a paused run has not ended, and treating it as outside the run
 * would report an abandon every time somebody opened the pause menu — and then a `run_start`
 * when they closed it again.
 */
const RUN_PHASES: readonly Phase[] = ['playing', 'paused'];

/**
 * The phases a run may legitimately END on.
 *
 * Leaving a run to one of these is NOT an abandon: `RunOutcome` has already reported the
 * real outcome with its floor, its duration and whether the seat won. Emitting here too
 * would double-count every finished run — and it would report the same run as both won and
 * abandoned, which is the kind of contradiction a funnel cannot be repaired from.
 */
const OUTCOME_PHASES: readonly Phase[] = ['victory', 'defeat'];

const inRun = (p: Phase): boolean => RUN_PHASES.includes(p);
const isOutcome = (p: Phase): boolean => OUTCOME_PHASES.includes(p);

let lastPhase: Phase | null = null;

/**
 * The last state seen while a run was in progress.
 *
 * Found by running the real client, 2026-09-09: **every abandon arrived with no floor and no
 * duration.** Quitting to the forge tears the engine down, so by the frame the phase change
 * is observed `activeState()` is already null — and the props were being read from the
 * CURRENT state. The event survived (a run whose floor is unknown is still abandoned) but
 * the one number it exists to answer, *how far did they get before they stopped*, was
 * missing from every single row.
 *
 * No test could have caught it: at this seam the state is an argument, and a test that
 * passes a state on the transition frame is testing a caller that does not exist. What
 * catches it is a snapshot taken while the run IS live, which is the frame the numbers are
 * real on.
 */
let lastRun: TrackedState | null = null;

/** The shape `trackedRunFrom` reads out of a live `GameState`, narrowed to the three
 *  fields it needs so this module still needs no engine import. */
export interface RunStateLike {
  tick: number;
  floorIndex: number;
  players: readonly { atlasKey?: string }[];
}

/**
 * Project a live sim state into what an event carries.
 *
 * Here rather than in `GameLoop`, for two reasons: the projection belongs beside the shape
 * it projects INTO (CLAUDE.md's first split form — an independent function module), and
 * `GameLoop.ts` was one method away from the 500-line gate. `localOwner` is passed rather
 * than assumed, which is the whole point — see {@link TrackedState}.
 */
export function trackedRunFrom(state: RunStateLike | null, localOwner: number): TrackedState | null {
  if (state === null) return null;
  const character = state.players[localOwner]?.atlasKey;
  return {
    tick: state.tick,
    floorIndex: state.floorIndex,
    ...(character === undefined ? {} : { character }),
  };
}

/** Whole seconds of simulated time. `Math.max(0, …)` because a state handed in before its
 *  first tick has `tick` 0 and nothing here should ever report a negative duration. */
export function runSeconds(state: TrackedState): number {
  return Math.max(0, Math.floor(state.tick / TICK_RATE));
}

/**
 * Called once per frame with the current phase and the live state (or null outside a run).
 *
 * Emits, in this order:
 *
 *  1. `run_end{outcome:'abandon'}` — when a run phase is being left for anything that is not
 *     a result screen. BEFORE the `screen_view`, so the run's own ending is recorded against
 *     the run rather than after the screen that replaced it.
 *  2. `screen_view` — on every phase change, including the first call, because the phase a
 *     visit starts on is the step that separates "opened the game" from "reached the menu".
 *  3. `run_start` — when the run phases are being ENTERED from outside them. Not on
 *     `paused → playing`, which is a run resuming.
 *
 * Returns whether anything was emitted, which is what makes "exactly one per transition"
 * assertable without inspecting the queue.
 */
export function reportFrame(phase: Phase, state: TrackedState | null): boolean {
  // Snapshot BEFORE the early return, so it keeps up on every frame of a run rather than
  // only on the frames where something changed.
  if (inRun(phase) && state !== null) lastRun = state;

  const previous = lastPhase;
  if (phase === previous) return false;
  lastPhase = phase;

  if (previous !== null && inRun(previous) && !inRun(phase) && !isOutcome(phase)) {
    // The run that is ending, from the snapshot rather than from `state` — see `lastRun`.
    // Still `null`-safe: a visit that somehow reaches this without a live frame behind it
    // reports the abandon without its numbers, because a run whose floor is unknown is
    // still an abandoned run worth counting.
    const ending = lastRun;
    track(
      'run_end',
      ending === null
        ? { outcome: 'abandon' }
        : { outcome: 'abandon', floor: ending.floorIndex + 1, duration_s: runSeconds(ending) },
    );
    lastRun = null;
  }

  track('screen_view', { screen: SCREEN_IDS[phase] });

  if (!inRun(previous ?? 'menu') && inRun(phase)) {
    const character = state?.character;
    track('run_start', character === undefined ? undefined : { character });
  }
  return true;
}

/** Test-only: forget the last phase and the run snapshot. */
export function resetAnalyticsTrackingForTests(): void {
  lastPhase = null;
  lastRun = null;
}
