// The first-input hold — one half of GameLoop's "the run has not started yet" rule,
// split out of GameLoop.ts (CLAUDE.md "500-line file convention", form ①: a small
// independent unit with no shared private state, testable without a render layer).
//
// WHY (design/22 §4.1, measured 2026-11-11 on the Playgama sandbox): the portal build
// autostarts into a run, and `first_input.screen` says 76 of 97 first touches land
// INSIDE a live run, at a median of 7.7 s. For those 7.7 seconds the player is reading
// the screen, finding the window, or waiting for a hand to arrive — and the dungeon is
// already shooting at them. Enemy guns do 1 damage a hit and `SHIELD_REGEN_DELAY` needs
// 3 unhit seconds before the shield refills, so a motionless opening is not merely lost
// time: it spends the entire sustain budget before the player has pressed anything.
//
// The fix is the oldest one there is — the world does not move until the player does.
// A full freeze of sim ticks, exactly like hit-stop (`FxController.consumeHitStop`) and
// for the same reason: a partial freeze (enemies held, player live) cannot be expressed
// in a deterministic fixed-step tick stream. Skipping ticks leaves the stream itself
// untouched, so golden hashes, replays and the engine version are all unaffected.

import type { InputState } from '../../platform/types';

/**
 * How long the world will wait for a player who never touches anything. Not a guess at
 * human reaction time — `first_input.ms` p90 is 50.7 s, and those are tab-away sessions
 * rather than slow hands. It is a fuse: an input device that is broken, a page that
 * never gets focus, or a seat nobody is sitting in must not leave the game frozen with
 * no way out. 20 s is far past the p50 of 7.7 s that this hold exists to cover.
 */
export const OPENING_HOLD_MAX_MS = 20_000;

/**
 * A stick reading below this is noise — a resting thumb on a virtual stick, or a
 * normalized keyboard vector that is already 0. Deliberately well above the touch
 * controls' own dead zone: releasing the hold is a one-way door, so it should take a
 * deliberate push rather than a tremor.
 */
const MOVE_DEADZONE = 0.2;

/** Is the player asking for anything at all this frame? Any of the three inputs counts
 *  — a first tap of FIRE is as good an answer as a first step. */
export function hasIntent(i: InputState): boolean {
  return i.firing || i.interacting || Math.hypot(i.moveX, i.moveY) >= MOVE_DEADZONE;
}


/**
 * What ended a hold, as `opening_hold{outcome}` reports it (`analyticsTracking.ts`).
 *
 * The split is the whole point of the event. `input` is a player who arrived. `fuse` is a run
 * nobody ever touched — which until 2026-11-14 could only be INFERRED, from a `run_start` with
 * no `first_input` after it. That is an absence, and an absence cannot be split by cause: the
 * 2026-11 sandbox test could say 34.9% of started runs were never touched and could not say
 * whether the keys failed to reach the frame or reached it and nobody pressed. Reported as it
 * happens, this event carries the visit's `focus`/`input` attention, which every Playgama event
 * gets for free (`platform/keyFocus.ts`, attached by `bridgeAnalytics.ts`) — so `fuse` with
 * `focus:false` and `fuse` with `focus:true` are two different problems with two different fixes.
 *
 * There is deliberately no third member for "the player left while the world was still frozen".
 * That one stays an absence on purpose: a `run_start` with no `opening_hold` after it, countable
 * by subtraction, because no listener this side of `pagehide` can be trusted to fire on a frame
 * that never comes.
 */
export type OpeningHoldOutcome = 'input' | 'fuse';

export class OpeningHold {
  private waiting = false;
  private waitedMs = 0;
  private stepped = false;

  /**
   * @param onEnd Fired once per hold, the moment it releases, with how long it had waited.
   *   Defaults to a no-op so this unit stays constructible — and testable — with no analytics
   *   anywhere near it; `GameLoop` passes the reporter (`noteOpeningHoldEnd`).
   */
  constructor(
    private readonly onEnd: (outcome: OpeningHoldOutcome, waitedMs: number) => void = () => {},
  ) {}

  /** Armed at the top of every run (`GameLoop.resetForNewRun`). A hold still waiting when the
   *  next run arms is dropped without a report, which is the "left while frozen" absence above. */
  arm(): void {
    this.waiting = true;
    this.waitedMs = 0;
    this.stepped = false;
  }

  /**
   * The run has produced its first sim tick — the hold only bites from here.
   *
   * Not a nicety: the HUD and the teaching panel are both driven from inside a tick
   * (`TutorialHintController.consume` runs in `GameLoop.stepSim`), so freezing from
   * tick zero would hold the world still behind a screen that had not yet said
   * "Move with WASD" — a frozen game with no instruction on it, which is the bug this
   * is meant to fix rather than a cure for it. One tick is ~33 ms and no enemy can
   * close, aim or fire in it.
   */
  sawFirstTick(): void {
    this.stepped = true;
  }

  /** True while the sim is still waiting — read by the HUD/guides, not by the loop. */
  get held(): boolean {
    return this.waiting;
  }

  /** Real time spent waiting so far, for whoever wants to show it or measure it. */
  get waitedMsSoFar(): number {
    return this.waitedMs;
  }

  /**
   * One render frame. Returns true when this frame's sim ticks must be skipped.
   *
   * Releasing returns FALSE on the same frame rather than swallowing it, so the press
   * that woke the world is also the press the next tick reads — no dropped input, and
   * no extra frame of latency on the one action the player is waiting to feel.
   *
   * `uiIntent` is the same answer arriving down the other wire: a tap on a HUD control
   * (the weapon chip, a portal button, a shop row) latches a command instead of moving
   * the stick, so `CommandBuilder.hasLatchedAction` reports it and this hold treats it
   * exactly like a first step. Without it the tap would be held by the very freeze it
   * was trying to end.
   */
  update(dt: number, input: InputState, uiIntent = false): boolean {
    if (!this.waiting) return false;
    if (uiIntent || hasIntent(input)) return this.release('input');
    // An answer is heard from the first frame; only the FREEZE waits for the opening tick,
    // so a press made before the world had drawn itself is honoured rather than dropped.
    if (!this.stepped) return false;
    this.waitedMs += dt;
    if (this.waitedMs >= OPENING_HOLD_MAX_MS) return this.release('fuse');
    return true;
  }

  /** End the hold and say why. Returns false — the caller's "do not skip this frame". */
  private release(outcome: OpeningHoldOutcome): false {
    this.waiting = false;
    this.onEnd(outcome, this.waitedMs);
    return false;
  }
}
