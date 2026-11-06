/**
 * First boot goes straight into a run (design/20 "Onboarding"): the rule for when the front
 * door is skipped, as free functions over a narrow deps object, so the whole decision is
 * testable without a Game.
 *
 * A player who has never played is not helped by a lobby of five doors they cannot read yet —
 * they are one PLAY press from the run that teaches them (`RunLifecycle.beginRun` arms the
 * first-run hints off the same `hasSeenTutorial`), and on a portal every visitor who does not
 * find that press is a session lost before the first second of play. So the first-ever boot
 * makes the press for them; every later boot shows the menu as before.
 *
 * Each refusal below keeps a boot that is not "a first-time player with nothing else to do":
 *  - `hasSeenTutorial` — a returning player gets the lobby.
 *  - a run save exists — `beginRun` clears the one save slot, so auto-starting would destroy a
 *    run nobody chose to give up. Any save, not only a resumable one: it is never this code's
 *    place to decide a save is worthless.
 *  - not on the menu — something else (a replay, a host's invite) already moved the game on.
 *  - a dev URL toggle naming a different run (`?online=1`, `?pvp=1`, `?replay=`) — those
 *    pages were opened to test that, not the first run.
 *
 * Each entry point calls `Game.startFirstRunIfNew()` right after `game.start()`; the CrazyGames
 * one waits until its boot intent (an accepted invite, instant multiplayer) has answered
 * `'none'`, because that intent moves the player off the menu itself.
 */
import type { Phase } from '../phase';
import { loadSavedRun } from '../match/runSaveStore';

export interface FirstRunAutostartView {
  phase: Phase;
  meta: { hasSeenTutorial: boolean };
  online: boolean;
  pvp: boolean;
  replayUrl: string | null;
}

/** Whether this boot should skip the menu and start the first run. */
export function shouldAutoStartFirstRun(run: FirstRunAutostartView, hasSave: boolean): boolean {
  return run.phase === 'menu' && !run.meta.hasSeenTutorial && !hasSave &&
    !run.online && !run.pvp && run.replayUrl === null;
}

export interface FirstRunAutostartDeps {
  run: FirstRunAutostartView;
  runs: { beginQuickRun(): void };
  /** Whether the one run-save slot holds anything; defaults to the real store. */
  hasSave?: () => boolean;
}

/** Start the first run if this boot qualifies; returns whether it did. */
export function autoStartFirstRun(d: FirstRunAutostartDeps): boolean {
  const hasSave = d.hasSave ?? (() => loadSavedRun() !== null);
  if (!shouldAutoStartFirstRun(d.run, hasSave())) return false;
  d.runs.beginQuickRun();
  return true;
}
