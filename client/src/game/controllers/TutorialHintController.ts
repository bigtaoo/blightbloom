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

/** The swap lesson's give-up (2026-11-07, the first-run report): a player who never presses 1/2
 *  — the fight is going fine with the first weapon — used to keep "Press 1 or 2" on screen for
 *  the rest of the run, over the portal and the card panel. After 15 s it moves on to the next
 *  lesson, unearned. */
export const SWAP_GIVE_UP_TICKS = 450;

/** Each lesson's give-up, ticks; a lesson missing here waits for the player for good. Counted
 *  from when its panel goes up, which for a cued lesson is the cue, not the previous lesson. */
const GIVE_UP_TICKS: Partial<Record<Lesson, number>> = { swap: SWAP_GIVE_UP_TICKS, deflect: DEFLECT_GIVE_UP_TICKS };

/** The lessons that wait for a moment they make sense in before their panel goes up. */
const CUED: ReadonlySet<Lesson> = new Set(['swap', 'deflect']);

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
 * 3. **swap** — `PlayerActor.activeSlot` differs from the slot the lesson started on; dropped
 *    after `SWAP_GIVE_UP_TICKS`.
 * 4. **deflect** — a `'deflect'` event; dropped after `DEFLECT_GIVE_UP_TICKS`.
 *
 * ## The last two wait for their moment (2026-11-08)
 *
 * Swap and deflect used to go up the tick the previous lesson was learned, which on a first
 * run was usually a cleared room: "swing your melee weapon into incoming bullets" with no bullet
 * anywhere, timing out unread. Each now waits, panel hidden, for its CUE (`cued`): swap for a
 * fight (a live enemy that has noticed the player), deflect for the first enemy shot. Only then
 * does its panel go up and its give-up clock start. A run that never meets the cue never shows
 * the lesson, which costs nothing.
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
  /** Whether the current step's cue has arrived (always true for an un-cued step); a step
   *  that is not armed keeps the panel hidden and cannot be learned or given up on. */
  private armed = false;
  /** What the panel last showed: the step, or `waiting` for a cued step not yet armed. */
  private shownFor: Step | 'waiting' | null = null;
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

    if (this.step !== 'done' && this.armed) {
      const limit = GIVE_UP_TICKS[this.step];
      if (this.learned(this.step, p, events)) this.begin(this.next(this.step), s, p);
      else if (limit !== undefined && s.tick - this.stepStartTick >= limit) this.begin(this.skip(this.step), s, p);
    }
    // Checked after the advance, so a cue already present goes straight to the panel with no
    // hidden tick between lessons. Re-measured from the cue: a slot swapped while the panel was
    // hidden is not the lesson.
    if (this.step !== 'done' && !this.armed && this.cued(this.step, s, events)) this.begin(this.step, s, p, true);

    const showing = this.step !== 'done' && !this.armed ? 'waiting' : this.step;
    if (showing !== this.shownFor) {
      this.shownFor = showing;
      if (showing === 'waiting') {
        this.prompt.hide();
      } else if (this.step === 'done') {
        // The last lesson that applied was learned, not given up on (`skip`), so a loadout with
        // no melee weapon still earns its congratulation.
        this.prompt.finish(this.doneEarned ? t('tutorial.hintCleared') : null);
      } else {
        this.prompt.show(this.messageFor(this.step), this.lessons.indexOf(this.step) + 1, this.lessons.length);
      }
    }
  }

  /** Has the moment for a cued lesson come: a fight for swap, an enemy shot for deflect. */
  private cued(step: Lesson, s: GameState, events: readonly GameEvent[]): boolean {
    switch (step) {
      case 'swap':
        return s.enemies.some((e) => e.alive && e.aggroed);
      case 'deflect':
        return events.some((e) => e.type === 'bullet_fired' && e.faction === 'enemy');
      default:
        return true;
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

  /** The lesson after `step`, given up on rather than learned: never an earned `done`. */
  private skip(step: Lesson): Step {
    return this.lessons[this.lessons.indexOf(step) + 1] ?? 'done';
  }

  /** Is the move lesson's panel up — the guide arrow's label then leaves the move keys to it
   *  (`scene/NextRoomArrow.ts`), rather than saying the same thing twice in two places. */
  get teachingMove(): boolean {
    return this.stepStartTick >= 0 && this.step === 'move';
  }

  /** Start `step`: every lesson measures from where the player was when it began, so a
   *  player who already swapped (or walked) during an earlier lesson still has to do it once
   *  more, on cue — that is the lesson. */
  private begin(step: Step, s: GameState, p: PlayerActor, armed = step === 'done' || !CUED.has(step)): void {
    this.step = step;
    this.armed = armed;
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
    this.armed = false;
    this.shownFor = null;
    this.doneEarned = false;
    this.prompt.hide();
  }
}
