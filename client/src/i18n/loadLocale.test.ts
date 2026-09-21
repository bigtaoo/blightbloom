/**
 * i18n/loadLocale.ts — the seven lazily-imported locale tables (2026-09-21).
 *
 * The split is a size decision (22 kB of brotli off the first download), and its whole risk is
 * one shape: `t()` is synchronous, so a locale whose table has not landed renders ENGLISH
 * rather than failing. That is a silent fallback, and every case below is about a place it
 * could hide.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { getLocale, isLocaleLoaded, resetLocaleForTests, setLocale, t, LOCALES } from './index';
import { ensureLocale, prefetchLocales, resetLoadedLocalesForTests, useLocale } from './loadLocale';

beforeEach(() => {
  resetLoadedLocalesForTests();
  resetLocaleForTests();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('ensureLocale', () => {
  it('registers a table that was not bundled', async () => {
    expect(isLocaleLoaded('zh')).toBe(false);
    await ensureLocale('zh');
    expect(isLocaleLoaded('zh')).toBe(true);
    setLocale('zh');
    expect(t('loading.boot')).toBe('加载中');
  });

  it('answers English — not the raw key — for a locale that has not landed yet', async () => {
    // The documented fallback, and the reason `useLocale` exists. A screen built one tick too
    // early reads as the game in the wrong language; `lookup` returning `key` would make it
    // read as a broken build.
    setLocale('zh');
    expect(t('loading.boot')).toBe('LOADING');
    await ensureLocale('zh');
    expect(t('loading.boot')).toBe('加载中');
  });

  it('is a no-op for English, which is bundled and never fetched', async () => {
    await expect(ensureLocale('en')).resolves.toBeUndefined();
    expect(isLocaleLoaded('en')).toBe(true);
  });

  it('shares one load between concurrent callers', async () => {
    // The boot await and the prefetch kicked a moment later are exactly this pair. Memoised on
    // the PROMISE rather than on completion, so the second caller joins the first download
    // instead of starting a second one.
    const first = ensureLocale('ru');
    const second = ensureLocale('ru');
    expect(second).toBe(first);
    await first;
    expect(isLocaleLoaded('ru')).toBe(true);
  });

  it('loads every declared locale — the split dropped none of them', async () => {
    // The mutant this kills is a LOADERS table missing a row: `ensureLocale` would resolve
    // happily (no loader means "nothing to do"), the language would silently stay English, and
    // nothing else in this suite looks at all eight.
    await Promise.all(LOCALES.map((l) => ensureLocale(l)));
    for (const locale of LOCALES) expect(isLocaleLoaded(locale), locale).toBe(true);
  });
});

describe('useLocale', () => {
  it('loads first and switches second', async () => {
    await useLocale('de');
    expect(getLocale()).toBe('de');
    expect(isLocaleLoaded('de')).toBe(true);
  });

  it('leaves the language unchanged until the table is in', async () => {
    // `setLocale` before `await` is the mutant with no visible symptom in a fast test and a
    // screen of English in a real one.
    const pending = useLocale('fr');
    expect(getLocale()).toBe('en');
    await pending;
    expect(getLocale()).toBe('fr');
  });
});

describe('prefetchLocales', () => {
  it('pulls every table without being awaited', async () => {
    prefetchLocales();
    await Promise.all(LOCALES.map((l) => ensureLocale(l)));
    for (const locale of LOCALES) expect(isLocaleLoaded(locale), locale).toBe(true);
  });
});

describe('a locale that fails to load', () => {
  it('stays in English, logs, and can be retried rather than replaying the failure', async () => {
    // A mini-game on a dead connection, or a chunk that 404s after a deploy. Two properties:
    // the promise RESOLVES (nothing here is worth a broken boot), and the memo is dropped so
    // the settings screen can try again — a memoised rejection would pin the player to
    // English for the rest of the session.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.doMock('./locales/it', () => {
      throw new Error('chunk 404');
    });
    vi.resetModules();
    const { ensureLocale: freshEnsure, resetLoadedLocalesForTests: freshReset } = await import('./loadLocale');
    freshReset();

    await expect(freshEnsure('it')).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();

    vi.doUnmock('./locales/it');
    vi.resetModules();
    const { ensureLocale: retryEnsure } = await import('./loadLocale');
    const { isLocaleLoaded: retryLoaded } = await import('./index');
    await retryEnsure('it');
    expect(retryLoaded('it')).toBe(true);
  });
});

describe('the entry points', () => {
  it('kick the active locale early and await it BEFORE constructing the game', () => {
    // A source-order assertion, the same technique `render/wechatPhasedBoot.test.ts` uses for
    // the art phases and for the same reason: an entry point runs `boot()` on import, so there
    // is no seam to observe this from inside.
    //
    // The hole it closes: screens read `t()` while they are being CONSTRUCTED (labels are
    // passed to widgets, not re-read per frame), so a table that lands after `new Game(...)`
    // leaves English baked into whatever nothing re-renders. The symptom is a menu that is
    // half translated, on the machines that are slowest to fetch a chunk.
    for (const entry of ['main.ts', 'main.wechat.ts', 'main.crazygames.ts']) {
      const src = readFileSync(new URL(`../${entry}`, import.meta.url), 'utf8');
      const kick = src.indexOf('const localeReady = ensureLocale(persistedLocale())');
      const lobby = src.indexOf('await preloadLobbyArt(');
      const settle = src.indexOf('await localeReady;');
      const construct = src.indexOf('new Game(app, input, audio)');
      expect(kick, `${entry}: no ensureLocale kick`).toBeGreaterThan(-1);
      expect(settle, `${entry}: nothing awaits the locale`).toBeGreaterThan(-1);
      // Kicked BEFORE the lobby wait, so the chunk's round trip overlaps it rather than
      // being a round trip of its own added after the bundle has already downloaded...
      expect(kick, `${entry}: the locale fetch is on the critical path`).toBeLessThan(lobby);
      // ...and settled before the first screen is built.
      expect(settle, `${entry}: the locale is awaited too late`).toBeLessThan(construct);
    }
  });

  it('prefetch the rest, and only after the lobby is up', () => {
    // Never on the critical path: the prefetch is the reason the language button feels like a
    // toggle, and it must not be a reason the first screen is slower.
    for (const entry of ['main.ts', 'main.wechat.ts', 'main.crazygames.ts']) {
      const src = readFileSync(new URL(`../${entry}`, import.meta.url), 'utf8');
      expect(src.indexOf('await preloadLobbyArt('), entry).toBeLessThan(src.indexOf('prefetchLocales()'));
      expect(src, entry).not.toMatch(/await prefetchLocales/);
    }
  });
});

describe('no test may switch to a locale it has not loaded', () => {
  /**
   * The guard for the defect this file's split introduced, found by a peer session rather than
   * by me — and worth stating exactly, because the shape recurs.
   *
   * The sweep that moved every call site onto `useLocale` matched the LITERAL
   * `setLocale('zh')`. Eleven sites across eight files switch locale inside a
   * `for (const locale of LOCALES)` loop, so the argument is a variable and the regex saw
   * nothing — "a source-reading sweep's worst failure is matching nothing", applied to the
   * sweep itself. Those eleven kept compiling, kept passing, and silently ran seven of their
   * eight iterations against the English fallback: `contentNames.test.ts` — the test-time
   * replacement for the compile-time exhaustiveness content keys cannot have — stopped
   * checking seven locales, and every per-locale WIDTH sweep (labelFit, viewportFit,
   * widgetOverlap, textMetrics) stopped measuring the long strings it exists for. Measured
   * rather than assumed: breaking one Russian content name gives 1 red with `await useLocale`
   * and 0 red with the old `setLocale`.
   *
   * A regex over the call sites is what the sweep got wrong, so this checks the PROPERTY
   * instead — in a test file, the only argument `setLocale` may take is `'en'`, the one locale
   * that is statically bundled and therefore always in memory. Everything else goes through
   * `useLocale`, whatever shape the argument has.
   */
  const TEST_FILES = globTestFiles(new URL('..', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));

  it('finds the test tree at all, so the sweep below cannot pass over nothing', () => {
    // The failure mode of every check in this describe. A broken path, a renamed extension or
    // a `setLocale` that no longer exists all produce an empty scan and a green run.
    expect(TEST_FILES.length).toBeGreaterThan(200);
    const withSetLocale = TEST_FILES.filter((f) => /\bsetLocale\(/.test(readFileSync(f, 'utf8')));
    expect(withSetLocale.length, 'no test calls setLocale at all — has it been renamed?').toBeGreaterThan(0);
  });

  it("only ever calls setLocale('en'), the one locale that is always in memory", () => {
    const offenders: string[] = [];
    for (const file of TEST_FILES) {
      // THIS file is the one exemption, and it has to be: the cases above deliberately switch
      // to a locale they have not loaded, because "renders English until the table lands" is
      // the documented behaviour and something has to pin it. It is also the only file whose
      // own source contains the needle in prose. One file, one purpose — but it does mean the
      // rule is unenforced inside it, so a real violation here has to be caught by reading.
      if (file.endsWith('loadLocale.test.ts')) continue;
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/(?<![.\w])setLocale\(([^)]*)\)/g)) {
        if (m[1]!.trim() !== "'en'") {
          const line = src.slice(0, m.index).split('\n').length;
          offenders.push(`${file.split(/[\\/]/).slice(-2).join('/')}:${line} — setLocale(${m[1]})`);
        }
      }
    }
    expect(offenders, `switch with \`await useLocale(...)\` instead:\n  ${offenders.join('\n  ')}`).toEqual([]);
  });
});

/** Every `.test.ts` under `client/src`, found without a glob dependency. */
function globTestFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.test.ts')) out.push(full);
    }
  };
  walk(root);
  return out;
}
