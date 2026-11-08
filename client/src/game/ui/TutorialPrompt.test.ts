import { describe, it, expect, afterEach } from 'vitest';
import { estimateLines, TutorialPrompt } from './TutorialPrompt';
import { resetLocaleForTests } from '../../i18n';
import { useLocale } from '../../i18n/loadLocale';

afterEach(() => resetLocaleForTests());

describe('TutorialPrompt', () => {
  it('starts hidden and never takes pointer input', () => {
    const p = new TutorialPrompt();
    expect(p.view.visible).toBe(false);
    expect(p.view.eventMode).toBe('none');
    expect(() => p.update(16)).not.toThrow();
  });

  it('shows a lesson with its step counter and keeps it up until told otherwise', () => {
    const p = new TutorialPrompt();
    p.reposition({ w: 1280, h: 720 });
    p.show('Move with WASD.', 1, 4);
    expect(p.view.visible).toBe(true);
    expect(p.bodyText).toBe('Move with WASD.');
    expect(p.counterText).toBe('STEP 1/4');
    for (let i = 0; i < 600; i++) p.update(16); // ten seconds: no timer hides a lesson
    expect(p.view.visible).toBe(true);
    expect(p.view.alpha).toBe(1);
    expect(p.bottom).toBeGreaterThan(Math.round(720 * 0.12));
  });

  it('a finish message fades and hides itself; a null finish hides at once', () => {
    const p = new TutorialPrompt();
    p.show('x', 1, 1);
    p.finish('Nicely done.');
    expect(p.counterText).toBe('');
    p.update(TutorialPrompt.FINISH_MS - 300);
    expect(p.view.visible).toBe(true);
    expect(p.view.alpha).toBeCloseTo(0.5);
    p.update(300);
    expect(p.view.visible).toBe(false);

    p.show('y', 1, 1);
    p.finish(null);
    expect(p.view.visible).toBe(false);
  });

  it('steps aside for a checkpoint panel and comes back with the same lesson (2026-11-07)', () => {
    const p = new TutorialPrompt();
    p.show('Press 1 or 2.', 3, 4);
    p.setYielded(true);
    expect(p.view.visible).toBe(false);
    expect(p.holding).toBe(true);
    p.setYielded(true); // repeated every frame the panel stays open: no change
    expect(p.view.visible).toBe(false);
    p.setYielded(false);
    expect(p.view.visible).toBe(true);
    expect(p.bodyText).toBe('Press 1 or 2.');
  });

  it('a lesson shown while yielded waits; one hidden while yielded stays hidden', () => {
    const p = new TutorialPrompt();
    p.setYielded(true);
    p.show('later', 4, 4);
    expect(p.view.visible).toBe(false);
    p.setYielded(false);
    expect(p.view.visible).toBe(true);
    p.setYielded(true);
    p.hide();
    p.setYielded(false);
    expect(p.view.visible).toBe(false);
    expect(p.holding).toBe(false);
  });

  it('a new lesson cancels a finish in progress', () => {
    const p = new TutorialPrompt();
    p.finish('done');
    p.show('again', 1, 2);
    p.update(TutorialPrompt.FINISH_MS + 100);
    expect(p.view.visible).toBe(true);
  });

  it('grows with the text on a narrow screen', () => {
    const p = new TutorialPrompt();
    p.show('Hold the left mouse button to attack — aiming is automatic.', 2, 4);
    p.reposition({ w: 1280, h: 720 });
    const wide = p.bottom;
    p.reposition({ w: 360, h: 720 });
    expect(p.bottom).toBeGreaterThan(wide);
  });

  it('translates its counter under zh', async () => {
    await useLocale('zh');
    const p = new TutorialPrompt();
    p.show('用 WASD 移动。', 1, 4);
    expect(p.counterText).toBe('第 1/4 步');
  });
});

describe('estimateLines', () => {
  it('wraps Latin text at word boundaries', () => {
    expect(estimateLines('Move with WASD.', 600)).toBe(1);
    // 10 words of 5 glyphs + a space: 6 × 13.2 = 79.2 px each, 3 to a 240 px line.
    expect(estimateLines(Array(10).fill('abcde ').join(''), 240)).toBe(4);
  });

  it('breaks a spaceless CJK run across the lines it fills', () => {
    expect(estimateLines('用'.repeat(10), 100)).toBe(3); // 220 px over 100 px lines
  });
});
