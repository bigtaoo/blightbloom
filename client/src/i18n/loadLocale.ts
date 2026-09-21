/**
 * The seven non-English locale tables, and the only place they are imported.
 *
 * Split out of `index.ts` on 2026-09-21, for a measured reason: the eight tables are 85 kB of
 * the client's 912 kB entry chunk, and a build without the other seven came out 22 kB smaller
 * after brotli — 9.4% off the download a player waits through before the menu exists, spent on
 * seven languages no single visit can read. Each `import()` below becomes its own chunk, and a
 * visit fetches exactly the one it is in.
 *
 * ## Why this is a separate file from `index.ts`
 *
 * Because `index.ts` exports `t()` and must stay free of the locale tables to be worth
 * splitting at all — an `import()` inside it would still be fine for Rollup, but `index.ts` is
 * imported by ~every module in the client and this file is imported by five. Keeping the
 * dynamic-import table here means the async concern has exactly one home, and `registerLocale`
 * has exactly one caller.
 *
 * ## The failure mode this file is shaped around
 *
 * `t()` is synchronous at every call site, so a locale that has not landed renders English
 * rather than throwing — a silent fallback, which is the failure this repository has the worst
 * record with. Three things keep it closed:
 *
 *   1. **The entry points await `ensureLocale` before `new Game(...)`.** Screens read `t()`
 *      while being CONSTRUCTED, so after the constructor is already too late. Pinned by a
 *      source-order assertion in `i18n.test.ts`, the same way the art phases are pinned.
 *   2. **`useLocale` is what a language CHANGE calls** — load, then switch, in that order.
 *   3. **`prefetchLocales` runs once the lobby is up**, so by the time anyone opens the
 *      settings screen every table is already in and the switch is instant. It is a
 *      convenience, not a correctness measure: (2) is correct on its own.
 *
 * A failed import leaves the player in English and logs. It never rejects, because there is no
 * caller for whom a missing translation is worth a broken boot.
 */
import {
  LOCALES,
  clearLoadedLocalesForTests,
  registerLocale,
  setLocale,
  type Locale,
  type Translations,
} from './index';
import type { en } from './locales/en';

type LocaleTable = Translations<typeof en>;

/**
 * One dynamic import per locale, written out rather than built from a template string:
 * Rollup needs a statically analysable specifier to emit a chunk, and
 * `import(`./locales/${locale}`)` would either bundle the whole directory into one chunk or
 * fail to resolve — either way undoing the split this file exists for.
 */
const LOADERS: Readonly<Record<Exclude<Locale, 'en'>, () => Promise<LocaleTable>>> = {
  zh: async () => (await import('./locales/zh')).zh,
  de: async () => (await import('./locales/de')).de,
  fr: async () => (await import('./locales/fr')).fr,
  es: async () => (await import('./locales/es')).es,
  pl: async () => (await import('./locales/pl')).pl,
  ru: async () => (await import('./locales/ru')).ru,
  it: async () => (await import('./locales/it')).it,
};

/** Memoised on the PROMISE, not on completion: the boot await and a prefetch kicked a moment
 *  later must share one download rather than race for two. */
const inflight = new Map<Locale, Promise<void>>();

/**
 * Make `locale`'s table available to `t()`. Resolves immediately for `en` (statically bundled)
 * and for a locale already in memory.
 *
 * Never rejects — see the header.
 */
export function ensureLocale(locale: Locale): Promise<void> {
  const loader = LOADERS[locale as Exclude<Locale, 'en'>];
  if (!loader) return Promise.resolve();
  let pending = inflight.get(locale);
  if (!pending) {
    pending = loader()
      .then((table) => registerLocale(locale, table))
      .catch((err: unknown) => {
        // Dropped from the memo so a later attempt (the settings screen, a retry after the
        // network came back) can try again rather than replaying one failed fetch forever.
        inflight.delete(locale);
        console.warn(`i18n: '${locale}' failed to load; staying in English`, err);
      });
    inflight.set(locale, pending);
  }
  return pending;
}

/** Load `locale` and then switch to it — the two steps in the one order that is correct, for
 *  every caller that CHANGES language. `setLocale` alone would switch to a table that is not
 *  there yet and render one screen of English on the way. */
export async function useLocale(locale: Locale): Promise<void> {
  await ensureLocale(locale);
  setLocale(locale);
}

/**
 * Pull the remaining tables in the background.
 *
 * Kicked from the entry points once the lobby is up, beside `beginDeferredArt()` and for the
 * same reason: the bytes are small, nothing is waiting on them, and having them already in
 * memory is what makes the settings screen's language button feel like a toggle rather than a
 * fetch. Never awaited, and a failure is already swallowed by `ensureLocale`.
 */
export function prefetchLocales(): void {
  for (const locale of LOCALES) void ensureLocale(locale);
}

/** Test-only: the memo outlives a single test file, so a locale loaded in one would make the
 *  next file's "renders English until it lands" case inert. Same convention as
 *  `render/preloadArt.ts`'s `resetPreloadArt`. */
export function resetLoadedLocalesForTests(): void {
  inflight.clear();
  clearLoadedLocalesForTests();
}
