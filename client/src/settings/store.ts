// SettingsStore — persistence port for SettingsState, symmetric to ../meta/store.ts.
import { defaultSettingsState, type ControlLayout, type SettingsState } from './SettingsState';
import { LOCALES, detectBrowserLocale, type Locale } from '../i18n';
import { QUALITY_SETTINGS, type QualitySetting } from '../render/quality';
import { FRAME_RATE_SETTINGS, type FrameRateSetting } from '../game/powerBudget';

export interface SettingsStore {
  load(): SettingsState;
  save(s: SettingsState): void;
}

export class MemorySettingsStore implements SettingsStore {
  private state: SettingsState;
  constructor(initial: SettingsState = defaultSettingsState()) {
    this.state = initial;
  }
  load(): SettingsState {
    return this.state;
  }
  save(s: SettingsState): void {
    this.state = s;
  }
}

const DEFAULT_KEY = 'daydayup.settings.v1';

export interface SettingsStoreDeps {
  /** Overrides `navigator.languages`/`navigator.language` for first-boot locale
   * detection — tests inject a fixed list instead of depending on a real `navigator`. */
  languages?: readonly string[];
}

function browserLanguages(): readonly string[] {
  if (typeof navigator === 'undefined') return [];
  return navigator.languages && navigator.languages.length > 0 ? navigator.languages : [navigator.language];
}

/** localStorage-backed store for the web build. Fails soft, same convention as
 * ../meta/store.ts's createWebMetaStore: a corrupt/missing save falls back to
 * defaults rather than throwing.
 *
 * First boot (no save at ALL, `raw === null`) auto-selects a locale from the
 * browser/system language via `detectBrowserLocale` — falls back to English if
 * nothing matches. This deliberately does NOT apply to a save that merely predates
 * `locale` (a pre-i18n save, or a corrupt one) — that's a RETURNING player, whose
 * existing choice of "never touched the language setting" should never be
 * silently overridden after the fact; `migrate()`'s own `en` fallback (below)
 * already covers that case correctly. */
export function createWebSettingsStore(key: string = DEFAULT_KEY, deps: SettingsStoreDeps = {}): SettingsStore {
  const available = typeof localStorage !== 'undefined';
  const languages = deps.languages ?? browserLanguages();
  return {
    load(): SettingsState {
      if (!available) return defaultSettingsState();
      try {
        const raw = localStorage.getItem(key);
        if (raw === null) return { ...defaultSettingsState(), locale: detectBrowserLocale(languages) };
        return migrate(JSON.parse(raw));
      } catch {
        return defaultSettingsState();
      }
    },
    save(s: SettingsState): void {
      if (!available) return;
      try {
        localStorage.setItem(key, JSON.stringify(s));
      } catch {
        /* quota / private-mode — a lost save is acceptable, a crash is not */
      }
    },
  };
}

/**
 * The locale a returning player last chose, read straight off the persisted settings.
 *
 * Exists for one caller shape: an entry point has to have the active locale's table in memory
 * BEFORE `new Game(...)`, because screens read `t()` while being constructed — and `Game` is
 * also what loads the settings, so the entry cannot ask it. Reading the same store with the
 * same default key is what keeps the two answers identical; `SettingsBinding` constructs
 * `createWebSettingsStore()` with those same defaults.
 *
 * Fails soft in both directions, like the store it reads: no save, an unreadable one or no
 * `localStorage` at all yields the default locale, which is the one that is bundled anyway.
 */
export function persistedLocale(store: SettingsStore = createWebSettingsStore()): Locale {
  try {
    return store.load().locale;
  } catch {
    return defaultSettingsState().locale;
  }
}

function migrate(parsed: unknown): SettingsState {
  const d = defaultSettingsState();
  if (!parsed || typeof parsed !== 'object') return d;
  const p = parsed as Partial<SettingsState>;
  const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : fallback);
  const locale = (v: unknown, fallback: Locale) => (LOCALES.includes(v as Locale) ? (v as Locale) : fallback);
  const controlLayout = (v: unknown, fallback: ControlLayout): ControlLayout =>
    v === 'standard' || v === 'mirrored' ? v : fallback;
  // A save that predates the quality setting falls back to the default `'auto'`, same as every
  // other field here — a returning player gets the watchdog rather than being pinned to
  // whatever tier happened to be the default when they last played.
  const quality = (v: unknown, fallback: QualitySetting): QualitySetting =>
    QUALITY_SETTINGS.includes(v as QualitySetting) ? (v as QualitySetting) : fallback;
  // Validated against the LIST, not `typeof v === 'number'`: the cap is written straight onto
  // `Ticker.maxFPS`, where a hand-edited 0 would mean "no cap at all" (the exact state
  // powerBudget.ts exists to remove) and a 5 would silently widen the ticker's own catch-up
  // clamp — see IDLE_MAX_FPS's note.
  const frameRate = (v: unknown, fallback: FrameRateSetting): FrameRateSetting =>
    FRAME_RATE_SETTINGS.includes(v as FrameRateSetting) ? (v as FrameRateSetting) : fallback;
  return {
    master: num(p.master, d.master),
    sfx: num(p.sfx, d.sfx),
    music: num(p.music, d.music),
    muted: typeof p.muted === 'boolean' ? p.muted : d.muted,
    locale: locale(p.locale, d.locale),
    controlLayout: controlLayout(p.controlLayout, d.controlLayout),
    quality: quality(p.quality, d.quality),
    frameRate: frameRate(p.frameRate, d.frameRate),
    // A save written before this setting existed has no field, and `typeof undefined` is not
    // `'boolean'`, so it lands on the default — off, i.e. exactly how that player's game
    // already looked. Same shape as `muted` above deliberately: a boolean read out of storage
    // is the one kind of field where `!!v` would silently turn a string into a preference.
    reduceMotion: typeof p.reduceMotion === 'boolean' ? p.reduceMotion : d.reduceMotion,
  };
}
