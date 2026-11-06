import type { GameEvent, GameState, PlayerActor } from '@dd/engine';
import { t } from '../../i18n';

/** The one HUD widget the lessons draw on: `HudView.tutorialPrompt` (ui/TutorialPrompt.ts),
 *  narrowed to what this calls so the step machine stays testable without Pixi. */
export interface TutorialPromptSink {
  show(text: string, step: number, of: number): void;
  finish(text: string | null): void;
  hide(): void;
}

/** The bits of Game a hint reaction needs — same tiny-callback-interface convention as
 * EventReactorHost, kept separate from it since the tutorial is the only caller. */
export interface TutorialHintHost {
  readonly localOwner: number;
}

type Lesson = 'move' | 'attack' | 'swap' | 'deflect';
type Step = Lesson | 'done';

const LESSONS: readonly Lesson[] = ['move', 'attack', 'swap', 'deflect'];

/** How far the seat must travel from where the move lesson started for it to count as
 *  learned: 1.5 grid, in the sim's fixed-point units (`FP_SCALE` 1000). Enough that a stray
 *  key tap does not tick the lesson off, little enough that one deliberate step does. */
const MOVE_LEARNED_FP = 1500;

/** The deflect lesson is the one a player can fail to complete for reasons that are not
 *  theirs (no bullet comes at them, the room is already clear). After this long it is
 *  dropped without congratulation rather than parking a panel on the screen for the rest of
 *  the run: 20 s at the engine's fixed 30 Hz step (design/06). */
export const DEFLECT_GIVE_UP_TICKS = 600;

/**
 * The teaching beats (design/10 screen-flow gap, design/20 onboarding) — render-only, follows
 * EventReactor's exact shape (reads `GameState` + the per-tick `events` queue, never mutates
 * the engine, design/10's "UI reads state+events" rule).
 *
 * ## Each lesson waits for the player (2026-11-06)
 *
 * The first version drove one-shot HUD toasts: the move lesson ("move with WASD, hold the
 * mouse to attack") sat in the 15 px toast lane for 1.4 s and yielded to the next on a 3 s
 * timer whether or not the player had moved. A first-time sandbox player read none of it and
 * was dead inside ten seconds. Now each lesson is one instruction in a large top-centre panel
 * (`TutorialPrompt`) that stays until the player DOES it, read entirely off state and events
 * already present regardless of run mode — no tutorial-specific engine field or hook:
 *
 * 1. **move** — the seat is 1.5 grid from where the lesson started.
 * 2. **attack** — a `bullet_fired` or `melee_swing` owned by the seat.
 * 3. **swap** — `PlayerActor.activeSlot` differs from the slot the lesson started on.
 * 4. **deflect** — a `'deflect'` event; dropped after `DEFLECT_GIVE_UP_TICKS`.
 *
 * ## Two things this learned when it stopped being tutorial-only (2026-09-08)
 *
 * - **A step that cannot apply is SKIPPED, not waited on.** "Swing your melee weapon into
 *   incoming bullets" is bad advice to a player carrying two ranged weapons. `applies`
 *   decides per step, off the same state, and the panel's "step n of m" counts only the
 *   lessons that apply.
 * - **The text depends on the input device, not on the platform.** `touch` picks one
 *   truthful sentence instead of printing two.
 */
export class TutorialHintController {
  private step: Step = 'move';
  private stepStartTick = -1;
  private originX = 0;
  private originY = 0;
  private baselineSlot = 0;
  private lessons: readonly Lesson[] = [];
  private shownForStep: Step | null = null;
  /** Whether `done` was EARNED (the last lesson was completed) rather than arrived at by the
   *  deflect lesson timing out. Only an earned one says "nicely done". */
  private doneEarned = false;

  constructor(
    private readonly prompt: TutorialPromptSink,
    private readonly host: TutorialHintHost,
    /** Whether this session is being played with touch controls — `InputSource.
     *  getTouchVisual().active`, which is true on a phone from the first frame (the
     *  platform's coarse-pointer probe) and never on a mouse session. Defaults to keyboard
     *  so a test, and any caller that has no input source, gets the desktop wording. */
    private readonly touch: () => boolean = () => false,
  ) {}

  consume(s: GameState, events: readonly GameEvent[]): void {
    const p = s.players[this.host.localOwner];
    if (!p) return;
    if (this.stepStartTick < 0) {
      this.lessons = LESSONS.filter((l) => this.applies(l, p));
      this.begin('move', s, p);
    }

    if (this.step !== 'done' && this.learned(this.step, p, events)) {
      this.begin(this.next(this.step), s, p);
    } else if (this.step === 'deflect' && s.tick - this.stepStartTick >= DEFLECT_GIVE_UP_TICKS) {
      this.begin('done', s, p);
    }

    if (this.step !== this.shownForStep) {
      this.shownForStep = this.step;
      if (this.step === 'done') {
        // The last lesson that applied was learned — the only way to `done` but the deflect
        // timeout — so a loadout with no melee weapon still earns its congratulation.
        this.prompt.finish(this.doneEarned ? t('tutorial.hintCleared') : null);
      } else {
        this.prompt.show(this.messageFor(this.step), this.lessons.indexOf(this.step) + 1, this.lessons.length);
      }
    }
  }

  private learned(step: Lesson, p: PlayerActor, events: readonly GameEvent[]): boolean {
    switch (step) {
      case 'move':
        return Math.hypot(p.gx - this.originX, p.gy - this.originY) >= MOVE_LEARNED_FP;
      case 'attack':
        return events.some((e) => (e.type === 'bullet_fired' || e.type === 'melee_swing') && e.ownerId === p.id);
      case 'swap':
        return p.activeSlot !== this.baselineSlot;
      case 'deflect':
        return events.some((e) => e.type === 'deflect');
    }
  }

  /** The lesson after `step` that applies to this loadout, or `done`. A completed last lesson
   *  is earned whichever it is. */
  private next(step: Lesson): Step {
    const i = this.lessons.indexOf(step);
    const next = this.lessons[i + 1];
    if (!next) this.doneEarned = true;
    return next ?? 'done';
  }

  /** Start `step`: every lesson measures from where the player was when it began, so a
   *  player who already swapped (or walked) during an earlier lesson still has to do it once
   *  more, on cue — that is the lesson. */
  private begin(step: Step, s: GameState, p: PlayerActor): void {
    this.step = step;
    this.stepStartTick = s.tick;
    this.originX = p.gx;
    this.originY = p.gy;
    this.baselineSlot = p.activeSlot;
  }

  private applies(step: Lesson, p: PlayerActor): boolean {
    if (step === 'swap') return p.weapons.length > 1;
    if (step === 'deflect') return p.weapons.some((w) => w.spec.kind === 'melee');
    return true;
  }

  private messageFor(step: Lesson): string {
    const touch = this.touch();
    switch (step) {
      case 'move':
        return t(touch ? 'tutorial.hintMoveTouch' : 'tutorial.hintMoveKeys');
      case 'attack':
        return t(touch ? 'tutorial.hintAttackTouch' : 'tutorial.hintAttackKeys');
      case 'swap':
        return t(touch ? 'tutorial.hintSwapTouch' : 'tutorial.hintSwapKeys');
      case 'deflect':
        return t('tutorial.hintDeflect');
    }
  }

  /** Call once per fresh attempt — resets the step machine to the beginning and clears the
   *  panel. Every run that teaches (the standalone tutorial, and a player's first real run)
   *  calls it, so a second taught run starts from `move` rather than from wherever the last
   *  one stopped. */
  reset(): void {
    this.step = 'move';
    this.stepStartTick = -1;
    this.lessons = [];
    this.shownForStep = null;
    this.doneEarned = false;
    this.prompt.hide();
  }
}
