/**
 * Chapter progress (design/gameplay/04-chapters.md) — which PvE chapters this account may
 * start a run in, and which one it has picked. Pure transactions over `MetaState`, in the same
 * shape as `forge.ts`'s: each returns the SAME object when nothing changes, so a caller can
 * skip the save.
 *
 * The rule: the first chapter in `CHAPTER_ORDER` is always unlocked, and chapter N+1 unlocks
 * the first time chapter N is cleared (its boss beaten — a last-floor extraction). An unlocked
 * chapter stays unlocked and can be replayed any time; `clearedChapters` only ever grows.
 */
import { CHAPTER_ORDER, DEFAULT_CHAPTER_ID, isChapterId, nextChapterId, type ChapterId } from '@dd/engine';
import type { MetaState } from './MetaState';

/** The two fields chapter progress reads — what the lobby's picker is handed. */
export type ChapterProgress = Pick<MetaState, 'selectedChapter' | 'clearedChapters'>;

/** The chapter before `id` in unlock order — the one whose clear unlocks `id` — or null for
 *  the first chapter, which nothing has to unlock. */
export function previousChapterId(id: ChapterId): ChapterId | null {
  const i = CHAPTER_ORDER.indexOf(id);
  return i > 0 ? CHAPTER_ORDER[i - 1]! : null;
}

/** Whether a run may be started in `id`. */
export function isChapterUnlocked(m: Pick<MetaState, 'clearedChapters'>, id: ChapterId): boolean {
  const prev = previousChapterId(id);
  return prev === null || m.clearedChapters.includes(prev);
}

/**
 * `m` with `id` recorded as cleared — the same object back when it already was.
 *
 * The FIRST clear also moves the pick to the chapter it unlocks, when there is one: the lobby
 * snaps to the pick, so without this the unlock would happen off screen and the player would
 * walk back into the chapter they just finished. A repeat clear never moves the pick — a player
 * replaying chapter 1 on purpose keeps it.
 */
export function recordChapterCleared(m: MetaState, id: ChapterId): MetaState {
  if (m.clearedChapters.includes(id)) return m;
  const unlocked = nextChapterId(id);
  return {
    ...m,
    clearedChapters: [...m.clearedChapters, id],
    ...(unlocked !== null ? { selectedChapter: unlocked } : {}),
  };
}

/**
 * Pick the chapter the next run starts in. Refuses (same object back) an id outside the
 * catalog and a chapter that is still locked — the same "only what you own" rule
 * `selectCharacter` applies to the roster, so the persisted pick is always one a run could use.
 */
export function selectChapter(m: MetaState, id: string): MetaState {
  if (!isChapterId(id) || !isChapterUnlocked(m, id) || m.selectedChapter === id) return m;
  return { ...m, selectedChapter: id };
}

/**
 * The chapter a new run actually starts in: the pick when it is unlocked, otherwise the first
 * chapter. The pick should never be locked — `selectChapter` refuses that — but it is read
 * from storage and from the account blob, and a hand-edited or half-synced save must not be
 * able to start a run in a chapter this account never earned.
 */
export function playableChapter(m: ChapterProgress): ChapterId {
  return isChapterUnlocked(m, m.selectedChapter) ? m.selectedChapter : DEFAULT_CHAPTER_ID;
}
