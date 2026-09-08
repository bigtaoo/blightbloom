/**
 * SettingsStore (design/10 volume persistence; `locale` added by design/17-i18n.md).
 * Mirrors this project's standing "fails soft, migrate() defends against a corrupt or
 * pre-existing-shape save" convention (see meta/store.ts, net/session.ts).
 */
import { describe, it, expect } from 'vitest';
import { createWebSettingsStore, MemorySettingsStore } from './store';
import { defaultSettingsState } from './SettingsState';
import { QUALITY_SETTINGS } from '../render/quality';
import { FRAME_RATE_SETTINGS } from '../game/powerBudget';

// jsdom-free: this repo's plain-node vitest has no `localStorage`, so exercise the
// migrate()/fails-soft path directly the way store.ts itself falls back — via an
// in-memory `localStorage` shim scoped to this file only.
function withFakeLocalStorage<T>(fn: () => T): T {
  const data = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => data.set(k, v),
    removeItem: (k: string) => data.delete(k),
  };
  try {
    return fn();
  } finally {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  }
}

describe('defaultSettingsState', () => {
  it('defaults to English', () => {
    expect(defaultSettingsState().locale).toBe('en');
  });
});

describe('MemorySettingsStore', () => {
  it('round-trips a locale change', () => {
    const store = new MemorySettingsStore();
    const next = { ...defaultSettingsState(), locale: 'zh' as const };
    store.save(next);
    expect(store.load().locale).toBe('zh');
  });
});

describe('createWebSettingsStore — locale migration', () => {
  it('round-trips a valid saved locale', () => {
    withFakeLocalStorage(() => {
      const store = createWebSettingsStore('t.settings.1');
      store.save({ ...defaultSettingsState(), locale: 'zh' });
      expect(createWebSettingsStore('t.settings.1').load().locale).toBe('zh');
    });
  });

  it('falls back to English for a saved locale that is no longer valid', () => {
    withFakeLocalStorage(() => {
      // 'xx' is not, and should never become, a real Locale — unlike 'fr' (a real
      // supported locale since 2026-08-03), it can't accidentally start passing once
      // more locales ship, so it stays a reliable "definitely invalid" fixture.
      localStorage.setItem('t.settings.2', JSON.stringify({ ...defaultSettingsState(), locale: 'xx' }));
      expect(createWebSettingsStore('t.settings.2').load().locale).toBe('en');
    });
  });

  it('falls back to English when locale is missing entirely (pre-i18n saved state)', () => {
    withFakeLocalStorage(() => {
      const { locale, ...preI18n } = defaultSettingsState();
      void locale;
      localStorage.setItem('t.settings.3', JSON.stringify(preI18n));
      expect(createWebSettingsStore('t.settings.3').load().locale).toBe('en');
    });
  });

  it('a corrupt saved value still yields a fully-defaulted (English) state, not a throw', () => {
    withFakeLocalStorage(() => {
      localStorage.setItem('t.settings.4', 'not json');
      expect(() => createWebSettingsStore('t.settings.4').load()).not.toThrow();
      expect(createWebSettingsStore('t.settings.4').load().locale).toBe('en');
    });
  });
});

describe('createWebSettingsStore — control-layout migration (design/10 left-handed toggle)', () => {
  it('defaults to standard', () => {
    expect(defaultSettingsState().controlLayout).toBe('standard');
  });

  it('round-trips a valid saved control layout', () => {
    withFakeLocalStorage(() => {
      const store = createWebSettingsStore('t.settings.9');
      store.save({ ...defaultSettingsState(), controlLayout: 'mirrored' });
      expect(createWebSettingsStore('t.settings.9').load().controlLayout).toBe('mirrored');
    });
  });

  it('falls back to standard for a value that is no longer valid', () => {
    withFakeLocalStorage(() => {
      localStorage.setItem('t.settings.10', JSON.stringify({ ...defaultSettingsState(), controlLayout: 'left' }));
      expect(createWebSettingsStore('t.settings.10').load().controlLayout).toBe('standard');
    });
  });

  it('falls back to standard when missing entirely (a pre-existing save)', () => {
    withFakeLocalStorage(() => {
      const { controlLayout, ...rest } = defaultSettingsState();
      void controlLayout;
      localStorage.setItem('t.settings.11', JSON.stringify(rest));
      expect(createWebSettingsStore('t.settings.11').load().controlLayout).toBe('standard');
    });
  });
});

describe('createWebSettingsStore — first-boot browser-locale detection', () => {
  it('a genuinely fresh install (no save at all) picks up a matching browser language', () => {
    withFakeLocalStorage(() => {
      const store = createWebSettingsStore('t.settings.5', { languages: ['de-DE', 'en-US'] });
      expect(store.load().locale).toBe('de');
    });
  });

  it('falls back to English when no browser language matches a supported locale', () => {
    withFakeLocalStorage(() => {
      const store = createWebSettingsStore('t.settings.6', { languages: ['pt-BR', 'nl-NL'] });
      expect(store.load().locale).toBe('en');
    });
  });

  it('does NOT apply browser detection once anything has been saved, even a pre-i18n save missing locale', () => {
    withFakeLocalStorage(() => {
      const { locale, ...preI18n } = defaultSettingsState();
      void locale;
      localStorage.setItem('t.settings.7', JSON.stringify(preI18n));
      // A returning player predating i18n — must stay English, not get "upgraded"
      // to a detected locale just because this field happened to be absent.
      const store = createWebSettingsStore('t.settings.7', { languages: ['de-DE'] });
      expect(store.load().locale).toBe('en');
    });
  });

  it('does not re-detect on a second load once a save exists (e.g. after the player changed it back)', () => {
    withFakeLocalStorage(() => {
      const store = createWebSettingsStore('t.settings.8', { languages: ['de-DE'] });
      const first = store.load(); // detects 'de', but doesn't persist by itself
      expect(first.locale).toBe('de');
      store.save({ ...first, locale: 'en' }); // player switches back to English
      expect(createWebSettingsStore('t.settings.8', { languages: ['de-DE'] }).load().locale).toBe('en');
    });
  });
});

describe('SettingsStore — render quality (render/quality.ts, 2026-08-25)', () => {
  it('round-trips every quality setting', () => {
    withFakeLocalStorage(() => {
      for (const q of QUALITY_SETTINGS) {
        const store = createWebSettingsStore(`t.settings.q.${q}`);
        store.save({ ...defaultSettingsState(), quality: q });
        expect(createWebSettingsStore(`t.settings.q.${q}`).load().quality).toBe(q);
      }
    });
  });

  it('falls back to auto for a save that predates the setting', () => {
    withFakeLocalStorage(() => {
      const { quality, ...preQuality } = defaultSettingsState();
      void quality;
      localStorage.setItem('t.settings.q.old', JSON.stringify(preQuality));
      expect(createWebSettingsStore('t.settings.q.old').load().quality).toBe('auto');
    });
  });

  it('rejects a garbage tier rather than handing it to the renderer', () => {
    withFakeLocalStorage(() => {
      localStorage.setItem('t.settings.q.bad', JSON.stringify({ ...defaultSettingsState(), quality: 'ultra' }));
      expect(createWebSettingsStore('t.settings.q.bad').load().quality).toBe('auto');
    });
  });
});

describe('SettingsStore — in-run frame cap (game/powerBudget.ts, 2026-09-08)', () => {
  it('round-trips every offered rate', () => {
    withFakeLocalStorage(() => {
      for (const fps of FRAME_RATE_SETTINGS) {
        const store = createWebSettingsStore(`t.settings.fps.${fps}`);
        store.save({ ...defaultSettingsState(), frameRate: fps });
        expect(createWebSettingsStore(`t.settings.fps.${fps}`).load().frameRate).toBe(fps);
      }
    });
  });

  it('falls back to 60 for a save that predates the setting', () => {
    withFakeLocalStorage(() => {
      const { frameRate, ...preFrameRate } = defaultSettingsState();
      void frameRate;
      localStorage.setItem('t.settings.fps.old', JSON.stringify(preFrameRate));
      expect(createWebSettingsStore('t.settings.fps.old').load().frameRate).toBe(60);
    });
  });

  it('rejects a rate that is not one of the two, however numeric it looks', () => {
    // The value is written straight onto `Ticker.maxFPS`, where 0 means "no cap at all" — the
    // exact state `powerBudget.ts` exists to remove — and a single-digit rate would also widen
    // the ticker's own catch-up clamp (see IDLE_MAX_FPS's note). A `typeof === 'number'` check
    // would accept all three of these.
    withFakeLocalStorage(() => {
      for (const bad of [0, 5, 144, -60, 'sixty', null] as unknown[]) {
        const key = `t.settings.fps.bad.${String(bad)}`;
        localStorage.setItem(key, JSON.stringify({ ...defaultSettingsState(), frameRate: bad }));
        expect(createWebSettingsStore(key).load().frameRate, String(bad)).toBe(60);
      }
    });
  });
});
