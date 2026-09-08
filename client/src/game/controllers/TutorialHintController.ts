import type { GameEvent, GameState, PlayerActor } from '@dd/engine';
import type { HudView } from '../ui/HudView';
import { THEME } from '../theme';
import { t } from '../../i18n';

/** The bits of Game a hint reaction needs — same tiny-callback-interface convention as
 * EventReactorHost, kept separate from it since the tutorial is the only caller. */
export interface TutorialHintHost {
  readonly localOwner: number;
}

type Step = 'move' | 'swap' | 'deflect' | 'done';

/** How long the move/aim/fire hint stays the active step before yielding to the
 * weapon-swap hint — a render-only timer off the sim's own tick counter (never an engine
 * hook), long enough to read, short enough not to nag a player who's already moving. */
const MOVE_HINT_TICKS = 90; // 3s at the engine's fixed 30Hz step (design/06)

/**
 * The teaching beats (design/10 screen-flow gap) — render-only, follows EventReactor's exact
 * shape (reads `GameState` + the per-tick `events` queue, never mutates the engine,
 * design/10's "UI reads state+events" rule). A step machine (move → swap → deflect → done)
 * drives one-shot HUD toasts as each lesson's condition is met — reuses the existing
 * `HudView.toast` (ToastQueue) rather than a new persistent widget, same transient-feedback
 * channel every pickup/buff toast already uses.
 *
 * Conditions are read entirely off state already present regardless of run mode:
 * `PlayerActor.activeSlot` (weapon-swap) and the `'deflect'` `GameEvent` (melee parry) —
 * no tutorial-specific engine field or hook was added for this.
 *
 * ## Two things this learned when it stopped being tutorial-only (2026-09-08)
 *
 * It used to run for the standalone tutorial level and nothing else, over a loadout
 * `tutorialConfig.ts` chose (a repeater + a hammer). Since design/20's onboarding pass it
 * also runs for a player's FIRST REAL RUN, whose loadout is whatever they carry — so two
 * assumptions that were true by construction had to become checks:
 *
 * - **A step that cannot apply is SKIPPED, not waited on.** "Swing your melee weapon into
 *   incoming bullets" is bad advice to a player carrying two ranged weapons, and the step
 *   machine would have parked on it forever. `applies` decides per step, off the same state.
 * - **The text depends on the input device, not on the platform.** The old single string
 *   named both ("left stick / WASD"), which is unreadable on both, and it also described an
 *   aim stick that design/10 v33 removed — it told players to aim manually in a game that
 *   auto-faces. `touch` picks one truthful sentence instead of printing two.
 */
export class TutorialHintController {
  private step: Step = 'move';
  private startTick = -1;
  private baselineSlot: number | null = null;
  private shownForStep: Step | null = null;
  /** Whether `done` was EARNED (the last lesson was completed) rather than arrived at by
   *  skipping lessons this loadout cannot teach. Only an earned one says "nicely done" — a
   *  player carrying one ranged weapon would otherwise be congratulated three seconds into
   *  their first run, for nothing. */
  private doneEarned = false;

  constructor(
    private readonly hud: HudView,
    private readonly host: TutorialHintHost,
    /** Whether this session is being played with touch controls — `InputSource.
     *  getTouchVisual().active`, which is true on a phone from the first frame (the
     *  platform's coarse-pointer probe) and never on a mouse session. Defaults to keyboard
     *  so a test, and any caller that has no input source, gets the desktop wording. */
    private readonly touch: () => boolean = () => false,
  ) {}

  consume(s: GameState, events: readonly GameEvent[]): void {
    if (this.startTick < 0) this.startTick = s.tick;
    const p = s.players[this.host.localOwner];
    if (!p) return;

    if (this.step === 'move' && s.tick - this.startTick >= MOVE_HINT_TICKS) {
      this.advance('swap', p);
    }
    if (this.step === 'swap' && this.baselineSlot !== null && p.activeSlot !== this.baselineSlot) {
      this.advance('deflect', p);
    }
    if (this.step === 'deflect' && events.some((e) => e.type === 'deflect')) {
      this.doneEarned = true;
      this.advance('done', p);
    }

    if (this.step !== this.shownForStep) {
      this.shownForStep = this.step;
      const message = this.messageFor(this.step);
      if (message) this.hud.toast(message, this.step === 'done' ? THEME.colors.extractGlow : THEME.colors.pickupBuff);
    }
  }

  /**
   * Move to `next`, then keep moving while the step cannot be taught to THIS player.
   *
   * The skip is a loop rather than one check because the steps are skippable
   * independently: a single-weapon loadout skips `swap`, an all-ranged loadout skips
   * `deflect`, and a single ranged weapon skips both and lands on `done`.
   */
  private advance(next: Step, p: PlayerActor): void {
    let step = next;
    while (step !== 'done' && !this.applies(step, p)) step = step === 'swap' ? 'deflect' : 'done';
    this.step = step;
    // The swap lesson compares against the slot the player was on when the lesson STARTED,
    // so the baseline is taken here rather than at construction — a player who had already
    // swapped before the move hint expired must still be able to complete it.
    if (step === 'swap') this.baselineSlot = p.activeSlot;
  }

  private applies(step: Step, p: PlayerActor): boolean {
    if (step === 'swap') return p.weapons.length > 1;
    if (step === 'deflect') return p.weapons.some((w) => w.spec.kind === 'melee');
    return true;
  }

  private messageFor(step: Step): string | null {
    const touch = this.touch();
    switch (step) {
      case 'move':
        return t(touch ? 'tutorial.hintMoveTouch' : 'tutorial.hintMoveKeys');
      case 'swap':
        return t(touch ? 'tutorial.hintSwapTouch' : 'tutorial.hintSwapKeys');
      case 'deflect':
        return t('tutorial.hintDeflect');
      case 'done':
        return this.doneEarned ? t('tutorial.hintCleared') : null;
    }
  }

  /** Call once per fresh attempt — resets the step machine to the beginning. Every run that
   *  teaches (the standalone tutorial, and a player's first real run) calls it, so a second
   *  taught run starts from `move` rather than from wherever the last one stopped. */
  reset(): void {
    this.step = 'move';
    this.startTick = -1;
    this.baselineSlot = null;
    this.shownForStep = null;
    this.doneEarned = false;
  }
}
