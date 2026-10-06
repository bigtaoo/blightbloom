/**
 * Chapter progress (design/gameplay/04-chapters.md): chapter 1 always open, chapter N+1 opened
 * by clearing chapter N, and a persisted pick that can only ever name an open chapter.
 */
import { describe, it, expect } from 'vitest';
import { CHAPTER_ORDER, DEFAULT_CHAPTER_ID } from '@dd/engine';
import { defaultMetaState, type MetaState } from './MetaState';
import {
  isChapterUnlocked, playableChapter, previousChapterId, recordChapterCleared, selectChapter,
} from './chapterProgress';

const cleared = (...ids: string[]): MetaState => ({ ...defaultMetaState(), clearedChapters: ids });

describe('previousChapterId', () => {
  it('names the chapter whose clear unlocks this one, and nothing for the first', () => {
    expect(previousChapterId('ember')).toBeNull();
    expect(previousChapterId('frost')).toBe('ember');
  });
});

describe('isChapterUnlocked', () => {
  it('opens the first chapter for a fresh account, and only the first', () => {
    const m = defaultMetaState();
    expect(isChapterUnlocked(m, CHAPTER_ORDER[0])).toBe(true);
    for (const id of CHAPTER_ORDER.slice(1)) expect(isChapterUnlocked(m, id), id).toBe(false);
  });

  it('opens chapter 2 once chapter 1 is cleared', () => {
    expect(isChapterUnlocked(cleared('ember'), 'frost')).toBe(true);
  });

  it('is not opened by clearing chapter 2 itself — only the chapter BEFORE it counts', () => {
    expect(isChapterUnlocked(cleared('frost'), 'frost')).toBe(false);
  });
});

describe('recordChapterCleared', () => {
  it('adds the chapter, leaving the input untouched', () => {
    const m = defaultMetaState();
    const next = recordChapterCleared(m, 'ember');
    expect(next.clearedChapters).toEqual(['ember']);
    expect(m.clearedChapters).toEqual([]);
  });

  it('hands back the SAME object for a chapter already cleared, so the caller can skip the save', () => {
    const m = cleared('ember');
    expect(recordChapterCleared(m, 'ember')).toBe(m);
  });

  it('a first clear moves the pick to the chapter it unlocks, so the lobby shows the unlock', () => {
    const next = recordChapterCleared(defaultMetaState(), 'ember');
    expect(next.selectedChapter).toBe('frost');
    expect(playableChapter(next)).toBe('frost');
  });

  it('a repeat clear leaves a deliberate replay pick alone', () => {
    const m: MetaState = { ...cleared('ember'), selectedChapter: 'ember' };
    expect(recordChapterCleared(m, 'ember').selectedChapter).toBe('ember');
  });

  it('clearing the last chapter keeps the pick — there is nothing after it to move to', () => {
    const m: MetaState = { ...cleared('ember', 'frost', 'storm'), selectedChapter: 'blight' };
    const next = recordChapterCleared(m, 'blight');
    expect(next.clearedChapters).toEqual(['ember', 'frost', 'storm', 'blight']);
    expect(next.selectedChapter).toBe('blight');
  });
});

describe('selectChapter', () => {
  it('picks an unlocked chapter', () => {
    expect(selectChapter(cleared('ember'), 'frost').selectedChapter).toBe('frost');
  });

  it('refuses a locked chapter — same object back', () => {
    const m = defaultMetaState();
    expect(selectChapter(m, 'frost')).toBe(m);
  });

  it('refuses an id outside the catalog', () => {
    const m = cleared('ember');
    expect(selectChapter(m, 'sand')).toBe(m);
  });

  it('is a no-op for the chapter already picked', () => {
    const m = defaultMetaState();
    expect(selectChapter(m, DEFAULT_CHAPTER_ID)).toBe(m);
  });
});

describe('playableChapter', () => {
  it('is the pick when the pick is unlocked', () => {
    expect(playableChapter({ selectedChapter: 'frost', clearedChapters: ['ember'] })).toBe('frost');
  });

  it('falls back to the first chapter for a pick that is locked', () => {
    expect(playableChapter({ selectedChapter: 'frost', clearedChapters: [] })).toBe(DEFAULT_CHAPTER_ID);
  });
});
