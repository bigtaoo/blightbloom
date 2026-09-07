// The two things that have to be true of the game while an ad is on screen.
//
// `AdController` states the rule and calls this; this is the implementation, and it lives
// here rather than in the controller so that the controller stays testable against a
// counter and so that the choice of MECHANISM is visible on its own.
//
//   silent   the platform requires it in as many words ("mute your audio whenever an
//            advertisement starts playing, and unmute it when the ad has finished"), because
//            the ad has audio of its own and two soundtracks at once is the complaint.
//   frozen   "ensure that a user cannot progress the game while requesting or showing an
//            ad". Not merely paused-looking: no simulation, no input, no frame.
//
// ## Why stopping the ticker is the right freeze
//
// Because it needs no cooperation from the game at all. Pixi's `Application` drives BOTH
// `Game.update` and its own render off the shared ticker, so stopping it halts the
// simulation, the input read, the music tick and the renderer in one call — and `Game.ts`,
// which sits at exactly its 500-line limit, gains no "am I suspended?" branch that every
// future frame would have to keep honouring.
//
// The alternative — a `suspended` flag checked inside `Game.update` — is strictly worse
// here: it is a line of portal policy inside the game loop, it leaves the renderer running
// (paying for frames nobody can see, behind an ad, on the low-end handsets this platform
// cares most about), and it is one flag that a later refactor can drop without any test
// noticing. Stopping the clock cannot be half-honoured.
//
// The frozen frame stays on screen underneath, which is correct: the ad covers the game
// frame, and what the player sees when it ends is exactly what they left.
import { setExternalMute } from '../../audio/externalMute';
import type { AdSuspension } from './AdController';

/** The slice of Pixi's ticker this needs. Two methods, so a test drives two counters
 *  (CLAUDE.md form ②) and this module never imports Pixi. */
export interface SuspendableClock {
  stop(): void;
  start(): void;
}

/**
 * Mute and freeze; unmute and unfreeze.
 *
 * Both halves are idempotent, which `AdController` depends on: it releases from a `finally`
 * that also runs when the ad never started (an unfilled request), so `resume` is called more
 * often than `suspend` by design.
 */
export function adSuspension(clock: SuspendableClock): AdSuspension {
  let suspended = false;
  return {
    suspend() {
      if (suspended) return;
      suspended = true;
      setExternalMute(true);
      clock.stop();
    },
    resume() {
      if (!suspended) return;
      suspended = false;
      // Unmute BEFORE restarting the clock, so the first frame back is already at the
      // player's own volume rather than silent for one frame — the audio bus is set from
      // `SettingsBinding.applyAll`, which this triggers synchronously.
      setExternalMute(false);
      clock.start();
    },
  };
}
