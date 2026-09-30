import { describe, it, expect, afterEach } from 'vitest';
import { REVIVE_CHANNEL_TICKS } from '@dd/engine';
import { ReviveBanner } from './ReviveBanner';
import { resetLocaleForTests } from '../../i18n';
import { useLocale } from '../../i18n/loadLocale';

afterEach(() => resetLocaleForTests());

describe('ReviveBanner', () => {
  it('stays hidden while the seat is not reviving anyone', () => {
    const b = new ReviveBanner();
    b.set(null);
    expect(b.view.visible).toBe(false);
    expect(() => b.update(16)).not.toThrow();
  });

  it('shows the channel as a percentage and says what it costs', () => {
    const b = new ReviveBanner();
    b.set(Math.round(REVIVE_CHANNEL_TICKS / 4));
    expect(b.view.visible).toBe(true);
    expect(b.titleText).toBe('REVIVING 25%');
    expect(b.hintText).toMatch(/shoot/i);
    for (let i = 0; i < 20; i++) expect(() => b.update(16)).not.toThrow();
    b.set(null); // let go, or walked out of the reach
    expect(b.view.visible).toBe(false);
  });

  it('translates under zh', async () => {
    await useLocale('zh');
    const b = new ReviveBanner();
    b.set(REVIVE_CHANNEL_TICKS);
    expect(b.titleText).toBe('正在救援 100%');
  });

  it('reposition does not throw before any state is set', () => {
    expect(() => new ReviveBanner().reposition({ w: 1280, h: 720 })).not.toThrow();
  });
});
