/**
 * The lobby's chapter picker (design/gameplay/04-chapters.md): what it shows, what it picks,
 * and the one rule that keeps it honest — SHOWING a locked chapter is not CHOOSING it.
 *
 * `MainMenu.test.ts` / `LobbyRoutes.test.ts` cover the half that lives in the column: where the
 * row sits, and which run-starting cards go out of play while it is blocked.
 */
import { describe, it, expect, afterEach } from 'vitest';
import type { Graphics } from 'pixi.js';
import { CHAPTER_ORDER, type ChapterId } from '@dd/engine';
import { installFakeTextCanvas } from '../screens/fakeTextCanvas';
import { ChapterPicker, CHAPTER_PICKER_H } from './ChapterPicker';
import { LOCALES, resetLocaleForTests, setLocale, t } from '../../i18n';
import { useLocale } from '../../i18n/loadLocale';

installFakeTextCanvas();

afterEach(() => resetLocaleForTests());

const W = 272;

interface CardLike {
  label: { text: string };
  hint: { text: string; visible: boolean; x: number; width: number };
  style: { art?: string; frame: number };
  view: { alpha: number; children: unknown[]; position: { x: number } };
  onTap: (() => void) | null;
}
interface BtnLike {
  onTap: (() => void) | null;
  view: { position: { x: number }; children: unknown[] };
}

function privateOf(p: ChapterPicker) {
  return p as unknown as { card: CardLike; prevBtn: BtnLike; nextBtn: BtnLike };
}

function boxOf(b: { view: { children: unknown[] } }) {
  return (b.view.children[0] as Graphics).getLocalBounds();
}

/** A picker with every callback recorded. */
function make(progress: { selectedChapter: ChapterId; clearedChapters: string[] }) {
  const p = new ChapterPicker(W);
  const picks: ChapterId[] = [];
  const blocks: boolean[] = [];
  p.onSelect = (id) => picks.push(id);
  p.onBlockedChange = (b) => blocks.push(b);
  p.setProgress(progress);
  return { p, picks, blocks };
}

describe('what it shows', () => {
  it('a fresh account sees chapter 1, named, numbered, in its own art', () => {
    setLocale('en');
    const { p } = make({ selectedChapter: 'ember', clearedChapters: [] });
    const c = privateOf(p).card;
    expect(p.chapter).toBe('ember');
    expect(p.blocked).toBe(false);
    expect(c.label.text).toBe(t('chapter.ember.name'));
    expect(c.hint.text).toBe(t('chapter.number', { n: 1 }));
    expect(c.style.art).toBe('chapter_ember');
    expect(c.view.alpha).toBe(1);
  });

  it('a locked chapter says what unlocks it, dimmed, in a plain frame', () => {
    setLocale('en');
    const { p } = make({ selectedChapter: 'ember', clearedChapters: [] });
    const unlocked = privateOf(p).card.style.frame;
    p.cycle(1);
    const c = privateOf(p).card;
    expect(p.chapter).toBe('frost');
    expect(p.blocked).toBe(true);
    expect(c.label.text).toBe(t('chapter.frost.name'));
    expect(c.hint.text).toBe(t('chapter.locked', { n: 1 }));
    expect(c.style.art).toBe('chapter_frost');
    expect(c.view.alpha).toBeLessThan(1);
    expect(c.style.frame).not.toBe(unlocked);
  });

  it('an unlocked chapter 2 is numbered like any other, at full strength', () => {
    setLocale('en');
    const { p } = make({ selectedChapter: 'frost', clearedChapters: ['ember'] });
    expect(p.chapter).toBe('frost');
    expect(privateOf(p).card.hint.text).toBe(t('chapter.number', { n: 2 }));
    expect(privateOf(p).card.view.alpha).toBe(1);
  });

  it('snaps a locked pick (a hand-edited save) back to the chapter a run would really start in', () => {
    const { p, blocks } = make({ selectedChapter: 'frost', clearedChapters: [] });
    expect(p.chapter).toBe('ember');
    expect(p.blocked).toBe(false);
    expect(blocks).toEqual([]); // never blocked, so no change to report
  });
});

describe('showing is not choosing', () => {
  it('cycling onto a LOCKED chapter blocks the start, and does not pick it', () => {
    const { p, picks, blocks } = make({ selectedChapter: 'ember', clearedChapters: [] });
    privateOf(p).nextBtn.onTap!();
    expect(picks).toEqual([]);
    expect(blocks).toEqual([true]);
    privateOf(p).prevBtn.onTap!();
    expect(p.chapter).toBe('ember');
    expect(blocks).toEqual([true, false]);
    // Back on the chapter that was already the pick: picked again (idempotent in the meta).
    expect(picks).toEqual(['ember']);
  });

  it('cycling onto an UNLOCKED chapter picks it', () => {
    const { p, picks, blocks } = make({ selectedChapter: 'ember', clearedChapters: ['ember'] });
    privateOf(p).card.onTap!(); // the card itself is the big "next" target on a phone
    expect(p.chapter).toBe('frost');
    expect(picks).toEqual(['frost']);
    expect(blocks).toEqual([]);
  });

  it('wraps at both ends of the catalog', () => {
    const { p } = make({ selectedChapter: 'ember', clearedChapters: ['ember'] });
    p.cycle(-1);
    expect(p.chapter).toBe(CHAPTER_ORDER[CHAPTER_ORDER.length - 1]);
    p.cycle(1);
    expect(p.chapter).toBe(CHAPTER_ORDER[0]);
  });

  it('a new show un-blocks a picker left on a locked chapter, and says so', () => {
    const { p, blocks } = make({ selectedChapter: 'ember', clearedChapters: [] });
    p.cycle(1);
    p.setProgress({ selectedChapter: 'ember', clearedChapters: [] });
    expect(p.blocked).toBe(false);
    expect(blocks).toEqual([true, false]);
  });

  it('copies the progress it is handed rather than keeping the caller’s array', () => {
    const cleared: string[] = [];
    const p = new ChapterPicker(W);
    p.setProgress({ selectedChapter: 'ember', clearedChapters: cleared });
    cleared.push('ember'); // the meta moving on later must not unlock the picker behind its back
    p.cycle(1);
    expect(p.blocked).toBe(true);
  });
});

describe('layout', () => {
  it('lays the arrows and the card out in one row inside the given width, without overlap', () => {
    const p = new ChapterPicker(W);
    const { card, prevBtn, nextBtn } = privateOf(p);
    expect(p.height).toBe(CHAPTER_PICKER_H);
    expect(prevBtn.view.position.x).toBe(0);
    expect(card.view.position.x).toBeGreaterThanOrEqual(boxOf(prevBtn).width);
    expect(card.view.position.x + boxOf(card).width).toBeLessThanOrEqual(nextBtn.view.position.x);
    expect(nextBtn.view.position.x + boxOf(nextBtn).width).toBeLessThanOrEqual(W + 1);
  });

  it('update and refreshArt reach the card without throwing (art may land late)', () => {
    const p = new ChapterPicker(W);
    expect(() => { p.update(16); p.refreshArt(); }).not.toThrow();
  });
});

describe('every locale', () => {
  it.each(LOCALES)('%s: the hint fits the card, locked or not', async (locale) => {
    await useLocale(locale);
    const { p } = make({ selectedChapter: 'ember', clearedChapters: [] });
    for (let i = 0; i < CHAPTER_ORDER.length; i++) {
      p.retext();
      const c = privateOf(p).card;
      expect(c.hint.visible).toBe(true);
      expect(c.hint.x + c.hint.width, `${locale} ${p.chapter}: "${c.hint.text}"`).toBeLessThanOrEqual(boxOf(c).width);
      expect(c.hint.text.endsWith('…'), `${locale} ${p.chapter}: "${c.hint.text}" was cut`).toBe(false);
      p.cycle(1);
    }
  });
});
