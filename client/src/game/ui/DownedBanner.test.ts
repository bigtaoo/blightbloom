import { describe, it, expect, afterEach } from 'vitest';
import { REVIVE_CHANNEL_TICKS } from '@dd/engine';
import { DownedBanner } from './DownedBanner';
import { resetLocaleForTests } from '../../i18n';
import { useLocale } from '../../i18n/loadLocale';

afterEach(() => resetLocaleForTests());

describe('DownedBanner', () => {
  it('stays hidden while up', () => {
    const b = new DownedBanner();
    b.set(false, 0, 0);
    expect(b.view.visible).toBe(false);
  });

  it('shows a bleedout countdown while downed with no revive in progress', () => {
    const b = new DownedBanner();
    b.set(true, 90, 0); // 90 ticks / 30 tick-rate = 3s
    expect(b.view.visible).toBe(true);
    expect(b.titleText).toContain('DOWN');
    expect(b.detailText).toContain('3');
    expect(b.progressVisible).toBe(false);
  });

  it('switches to a revive-progress readout once a channel is active', () => {
    const b = new DownedBanner();
    b.set(true, 90, Math.round(REVIVE_CHANNEL_TICKS / 2));
    expect(b.titleText).toContain('REVIVED');
    expect(b.progressVisible).toBe(true);
    expect(b.detailText).toBe('');
  });

  it('hides again once revived (downed goes false)', () => {
    const b = new DownedBanner();
    b.set(true, 90, 0);
    b.set(false, 0, 0);
    expect(b.view.visible).toBe(false);
  });

  it('translates under zh', async () => {
    await useLocale('zh');
    const b = new DownedBanner();
    b.set(true, 30, 0);
    expect(b.titleText).toBe('你已倒地');
    b.set(true, 30, Math.round(REVIVE_CHANNEL_TICKS / 2));
    expect(b.titleText).toBe('正在被救援…');
  });

  it('reposition/update do not throw with no state set yet', () => {
    const b = new DownedBanner();
    expect(() => b.reposition({ w: 1280, h: 720 })).not.toThrow();
    expect(() => b.update(16)).not.toThrow();
  });

  it('update() advances the progress bar across many frames without throwing, only while visible', () => {
    const b = new DownedBanner();
    b.set(true, 90, Math.round(REVIVE_CHANNEL_TICKS / 2));
    expect(b.progressVisible).toBe(true);
    for (let i = 0; i < 50; i++) expect(() => b.update(16)).not.toThrow();

    b.set(true, 90, 0); // channel interrupted — bar hides, no more flash to advance
    expect(b.progressVisible).toBe(false);
    expect(() => b.update(16)).not.toThrow();
  });

  it('a revive that completes (downed goes false) then a fresh down-and-revive cycle both read correctly', () => {
    const b = new DownedBanner();
    b.set(true, 30, Math.round(REVIVE_CHANNEL_TICKS / 2));
    b.set(false, 0, 0); // revived
    expect(b.view.visible).toBe(false);

    b.set(true, 45, 0); // downed again later in the same run
    expect(b.titleText).toContain('DOWN');
    expect(b.progressVisible).toBe(false);
    expect(b.detailText).toContain('2'); // 45 ticks / 30 tick-rate, rounded up
  });
});
