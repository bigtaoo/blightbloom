// Split out of LobbyRoutes.ts (2026-10-06) — the lobby's PvE chapter picker, which sits
// directly under SOLO in the route column (design/gameplay/04-chapters.md).
//
// ## What it shows
//
// One row: a `‹` arrow, a slim banner card in the chapter's own art (`chapter_<id>`) naming the
// chapter, and a `›` arrow. The arrows (and a tap on the card, which is the bigger target on a
// phone) cycle through `CHAPTER_ORDER`, wrapping. The card's hint is the chapter number, or,
// for a locked chapter, what unlocks it ("Clear chapter 1 to unlock") — drawn dimmed in a
// plain frame so a locked chapter never reads as a choice that was made. The endless chapter
// (the last entry, unlocked by clearing chapter 4) has no number: its hint says ENDLESS, with
// the account's deepest endless floor once there is one (`MetaState.endlessBestFloor`).
//
// ## Showing is not choosing
//
// The persisted pick (`MetaState.selectedChapter`) only ever moves to an UNLOCKED chapter
// (`meta/chapterProgress.ts selectChapter`). Cycling onto a locked one shows it — the player
// should be able to see what is coming — but does not pick it; instead the picker reports
// `blocked`, and the lobby takes the run-starting cards out of play until the player cycles
// back. Without that, a lobby showing "The Frost Descent" would start a chapter-1 run.
import { Container } from 'pixi.js';
import { CHAPTER_ORDER, DEFAULT_CHAPTER_ID, type ChapterId } from '@dd/engine';
import { Button } from './widgets';
import { LobbyCard } from './LobbyCard';
import { t, type TranslationKey } from '../../i18n';
import { isChapterUnlocked, playableChapter, previousChapterId, type ChapterProgress } from '../../meta';

/** The row's height, in the lobby's own units — the slim SOLO bar's, so the column's tiers
 *  keep their rhythm. */
export const CHAPTER_PICKER_H = 48;
const ARROW_W = 30;
const ARROW_GAP = 4;

/** How a chapter is drawn: banner art, its fallback fill, and its frame. Keyed by the
 *  catalog's own id type, so a new chapter is a compile error here until it has a look. */
const CHAPTER_LOOK = {
  ember: { art: 'chapter_ember', fill: 0x7b341e, frame: 0xf6ad55 },
  frost: { art: 'chapter_frost', fill: 0x2a4365, frame: 0x90cdf4 },
  storm: { art: 'chapter_storm', fill: 0x2d3250, frame: 0xfff176 },
  blight: { art: 'chapter_blight', fill: 0x2f3a28, frame: 0x9ccc65 },
  endless: { art: 'chapter_endless', fill: 0x2a2140, frame: 0xd6bcfa },
} as const satisfies Record<ChapterId, { art: string; fill: number; frame: number }>;

const CHAPTER_NAME_KEY = {
  ember: 'chapter.ember.name',
  frost: 'chapter.frost.name',
  storm: 'chapter.storm.name',
  blight: 'chapter.blight.name',
  endless: 'chapter.endless.name',
} as const satisfies Record<ChapterId, TranslationKey>;

const LOCKED_FILL = 0x2a3140;
const LOCKED_FRAME = 0x718096;
const LOCKED_ALPHA = 0.55;

export class ChapterPicker {
  readonly view = new Container();
  private prevBtn: Button;
  private nextBtn: Button;
  private card: LobbyCard;
  /** The chapter on screen — the pick, or a locked chapter the player is looking at. */
  private shown: ChapterId = DEFAULT_CHAPTER_ID;
  private progress: ChapterProgress = { selectedChapter: DEFAULT_CHAPTER_ID, clearedChapters: [] };

  /** The player cycled onto an UNLOCKED chapter: persist it as the pick. */
  onSelect: ((id: ChapterId) => void) | null = null;
  /** `blocked` changed — the lobby enables or disables the cards that start a new run. */
  onBlockedChange: ((blocked: boolean) => void) | null = null;

  constructor(readonly width: number) {
    this.prevBtn = new Button('‹', { w: ARROW_W, h: CHAPTER_PICKER_H, fontSize: 20, borderColor: LOCKED_FRAME });
    this.prevBtn.onTap = () => this.cycle(-1);
    this.nextBtn = new Button('›', { w: ARROW_W, h: CHAPTER_PICKER_H, fontSize: 20, borderColor: LOCKED_FRAME });
    this.nextBtn.onTap = () => this.cycle(1);
    const look = CHAPTER_LOOK[this.shown];
    this.card = new LobbyCard('', width - 2 * (ARROW_W + ARROW_GAP), CHAPTER_PICKER_H, { ...look, fontSize: 16 });
    this.card.onTap = () => this.cycle(1);
    this.prevBtn.view.position.set(0, 0);
    this.card.view.position.set(ARROW_W + ARROW_GAP, 0);
    this.nextBtn.view.position.set(width - ARROW_W, 0);
    this.view.addChild(this.prevBtn.view, this.card.view, this.nextBtn.view);
    this.redraw();
  }

  get height(): number {
    return CHAPTER_PICKER_H;
  }

  /** The chapter on screen. */
  get chapter(): ChapterId {
    return this.shown;
  }

  /** Whether the chapter on screen is locked — no new run may start from the lobby. */
  get blocked(): boolean {
    return !isChapterUnlocked(this.progress, this.shown);
  }

  /** Hand the picker the account's progress; it snaps back to the chapter a run would
   *  actually start in. Called on every lobby `show()`. */
  setProgress(progress: ChapterProgress): void {
    const wasBlocked = this.blocked;
    this.progress = {
      selectedChapter: progress.selectedChapter,
      clearedChapters: [...progress.clearedChapters],
      endlessBestFloor: progress.endlessBestFloor ?? 0,
    };
    this.shown = playableChapter(this.progress);
    this.redraw();
    if (this.blocked !== wasBlocked) this.onBlockedChange?.(this.blocked);
  }

  /** Step through the catalog, wrapping at both ends. */
  cycle(step: 1 | -1): void {
    const wasBlocked = this.blocked;
    const n = CHAPTER_ORDER.length;
    this.shown = CHAPTER_ORDER[(CHAPTER_ORDER.indexOf(this.shown) + step + n) % n]!;
    if (!this.blocked) {
      this.progress = { ...this.progress, selectedChapter: this.shown };
      this.onSelect?.(this.shown);
    }
    this.redraw();
    if (this.blocked !== wasBlocked) this.onBlockedChange?.(this.blocked);
  }

  /** Re-apply the labels from the active locale. */
  retext(): void {
    this.redraw();
  }

  update(dtMs: number): void {
    this.card.update(dtMs);
  }

  /** Pick up banner art that has landed since the last draw. */
  refreshArt(): void {
    this.card.refreshArt();
  }

  private redraw(): void {
    const id = this.shown;
    const look = CHAPTER_LOOK[id];
    const locked = this.blocked;
    this.card.setArt(look.art);
    this.card.setFill(locked ? LOCKED_FILL : look.fill);
    this.card.setFrame(locked ? LOCKED_FRAME : look.frame);
    this.card.view.alpha = locked ? LOCKED_ALPHA : 1;
    this.card.setText(t(CHAPTER_NAME_KEY[id]));
    // A locked chapter always has a previous one: the first chapter is never locked.
    this.card.setHint(locked
      ? t('chapter.locked', { n: CHAPTER_ORDER.indexOf(previousChapterId(id)!) + 1 })
      : this.unlockedHint(id));
  }

  /** The hint under an unlocked chapter: its number, or for the endless one its record. */
  private unlockedHint(id: ChapterId): string {
    if (id !== 'endless') return t('chapter.number', { n: CHAPTER_ORDER.indexOf(id) + 1 });
    const best = this.progress.endlessBestFloor ?? 0;
    return best > 0 ? t('chapter.endless.best', { floor: best }) : t('chapter.endless.hint');
  }
}
