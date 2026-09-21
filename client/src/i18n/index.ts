/**
 * i18n (design/17-i18n.md) — English (`en.ts`) is the canonical/source-of-truth
 * locale; every other locale is a `Translations<typeof en>`, which makes a missing or
 * extra key a compile error rather than a silent runtime fallback. Keys are semantic
 * dotted paths (`t('forge.title')`), not raw English sentences, so editing the English
 * copy never breaks another locale's key.
 *
 * `currentLocale` is a live, in-process mirror of `SettingsState.locale` (the
 * persisted value) — Game.ts calls `setLocale()` once at boot after loading settings,
 * then again on every language change, so every `t()` call site doesn't need a
 * SettingsState threaded through it.
 */
import { en } from './locales/en';

export type Locale = 'en' | 'zh' | 'de' | 'fr' | 'es' | 'pl' | 'ru' | 'it';
export const LOCALES: readonly Locale[] = ['en', 'zh', 'de', 'fr', 'es', 'pl', 'ru', 'it'];
export const DEFAULT_LOCALE: Locale = 'en';

type DotPaths<T> = T extends string
  ? never
  : { [K in keyof T & string]: T[K] extends string ? K : `${K}.${DotPaths<T[K]>}` }[keyof T & string];

/** Every valid `t()` key — a compile-time union of `en.ts`'s dotted leaf paths. */
export type TranslationKey = DotPaths<typeof en>;

/** The shape a translation locale must have: `en.ts`'s exact nested keys, string leaves. */
export type Translations<T> = { [K in keyof T]: T[K] extends string ? string : Translations<T[K]> };

/**
 * The locale tables that are actually in memory.
 *
 * `en` alone is static, and that is a size decision with a number behind it (2026-09-21):
 * the eight tables together are 85 kB of the 912 kB entry chunk, and a build with the other
 * seven removed came out 22 kB smaller after brotli — 9.4% off the one download that stands
 * between a player and the menu, for seven tables no single visit can use. The rest arrive
 * through `loadLocale.ts`, which is the only thing that calls `registerLocale`.
 *
 * `en` is not lazy for two reasons beyond being the one most visits want: it is the
 * source-of-truth locale every other one is typed against (design/17), and it is the fallback
 * `lookup` falls to — a fallback that could itself be missing is not one.
 */
const MESSAGES: Partial<Record<Locale, Translations<typeof en>>> = { en };

/** Put a loaded table in memory. Called by `loadLocale.ts` and by nothing else — a caller
 *  that wants a locale available asks `ensureLocale`, which owns the import. */
export function registerLocale(locale: Locale, table: Translations<typeof en>): void {
  MESSAGES[locale] = table;
}

/** Is `locale`'s table in memory? `t()` answers in English until it is, so anything that
 *  cares (the entry points, and the test that pins this) asks first. */
export function isLocaleLoaded(locale: Locale): boolean {
  return MESSAGES[locale] !== undefined;
}

let currentLocale: Locale = DEFAULT_LOCALE;

export function getLocale(): Locale {
  return currentLocale;
}

/**
 * Point `t()` at `locale`. Synchronous, and deliberately kept that way — it is read by every
 * one of the ~1,500 `t()` call sites in this client and an async seam there would be an async
 * seam everywhere.
 *
 * It does NOT load anything. A locale whose table has not been registered renders English
 * (see `lookup`), which is a silent fallback and therefore the one failure mode worth naming:
 * **callers that CHANGE language use `useLocale` from `loadLocale.ts`**, which loads and then
 * calls this. This stays exported for the paths that only mirror an already-loaded choice —
 * `settingsBinding.load()` at boot, after an entry point has already ensured it.
 */
export function setLocale(locale: Locale): void {
  currentLocale = locale;
}

/** Test-only: reset to the default locale so a test that calls `setLocale` doesn't leak
 * into the next one (same convention as `net/session.ts`'s `resetSessionCacheForTests`). */
export function resetLocaleForTests(): void {
  currentLocale = DEFAULT_LOCALE;
}

/** Test-only: forget every lazily-registered table, leaving the statically bundled `en`.
 *  Without it a locale loaded in one test file stays in memory for the whole run, and the
 *  case that matters most — what `t()` does BEFORE a table lands — can never be reached
 *  twice. Reached through `loadLocale.ts`'s `resetLoadedLocalesForTests`, which owns the
 *  other half of the same state. */
export function clearLoadedLocalesForTests(): void {
  for (const locale of LOCALES) if (locale !== DEFAULT_LOCALE) delete MESSAGES[locale];
}

/**
 * Maps a browser/system language-tag list (`navigator.languages`-shaped — most to
 * least preferred) to a supported `Locale`, or `DEFAULT_LOCALE` if none match.
 * Pure/injectable so `settings/store.ts`'s first-boot detection is testable without a
 * real `navigator` — matches this project's DI convention elsewhere (net/matchmaking.ts
 * etc). Only the base subtag is compared (`'zh-CN'`/`'zh-Hans'` → `'zh'`, `'pt-BR'` →
 * no match since Portuguese isn't a supported locale), so a region/script suffix never
 * blocks an otherwise-valid match.
 */
export function detectBrowserLocale(languages: readonly string[]): Locale {
  for (const tag of languages) {
    const base = tag.split('-')[0]?.toLowerCase();
    if ((LOCALES as readonly string[]).includes(base ?? '')) return base as Locale;
  }
  return DEFAULT_LOCALE;
}

function lookup(key: TranslationKey, locale: Locale): string {
  // `?? MESSAGES.en` is the not-loaded-yet arm (see MESSAGES above). English rather than the
  // raw key, because a lobby drawn one tick before its table lands should read as the game in
  // the wrong language, not as a screen full of `mainMenu.play`.
  let node: unknown = MESSAGES[locale] ?? MESSAGES.en;
  for (const part of key.split('.')) {
    // A `t()` call can never hit this branch — `TranslationKey` guarantees every
    // segment resolves to a nested object until the final string leaf. `tName()`
    // (a plain runtime string, not compile-checked) can: an uncatalogued content id
    // walks off the end of a real namespace mid-path (e.g. `weapon.<unknown-id>.name`
    // stops at `undefined` after the second segment) — bail out to the same "return
    // the raw key" miss behavior instead of throwing on `undefined['name']`.
    if (node === undefined || node === null) break;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === 'string' ? node : key;
}

/** Translate `key` in the active locale, substituting `{name}`-style placeholders from
 * `vars`. `key` is checked at compile time against `en.ts`'s own shape — a typo is a
 * build error, not a blank string at runtime. */
export function t(key: TranslationKey, vars?: Record<string, string | number>): string {
  const template = lookup(key, currentLocale);
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => (name in vars ? String(vars[name]) : whole));
}

/**
 * Translate a data-driven CONTENT nameKey — a `WeaponSpec`/`SkinDef`/`MaterialDef`/
 * `RunBuffDef`'s own `nameKey` field (design/09: "engine data carries only string
 * keys, never display text"). Unlike `t()`, `key` here is a plain runtime `string`,
 * not a compile-time-checked `TranslationKey` — content catalogs are open-ended data
 * (new weapons/skins keep getting added), not a fixed set of UI labels, so forcing
 * every content id through the same closed union would mean hand-maintaining a second
 * static map that just mirrors the engine's own `nameKey` values.
 *
 * Falls back to `key` itself on a miss (same as `t()`'s internal `lookup()`), so a
 * content id missing its translation renders as its own raw id/key rather than
 * crashing or going blank. `i18n/contentNames.test.ts`'s parity test is the test-time
 * safety net standing in for the compile-time exhaustiveness `t()` gets for free.
 */
export function tName(nameKey: string, vars?: Record<string, string | number>): string {
  return t(nameKey as TranslationKey, vars);
}
