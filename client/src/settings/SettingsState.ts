// Persistent client-side settings (design/10 "Settings" — volume once audio lands,
// design/11; `locale` added by design/17-i18n.md). Sits outside the sim exactly like
// MetaState (../meta/MetaState.ts): it is never read by @dd/engine, only by the
// render-side AudioBus wiring and the i18n module in Game.ts. `master` multiplies both
// buses rather than the AudioBus interface growing a third setter — one fewer
// platform-seam method to implement per backend (design/11's WebAudio/WeChatAudio).
import type { Locale } from '../i18n';
import { DEFAULT_LOCALE } from '../i18n';
import type { QualitySetting } from '../render/quality';

/** design/10 open question ("control layout … left-handed mirror") — 'mirrored' swaps
 * which half of the screen drives the movement vs. aim/fire stick, and moves the
 * weapon-swap buttons to the opposite corner (`platform/TouchControls.ts`). Desktop
 * mouse/keyboard play is unaffected either way. */
export type ControlLayout = 'standard' | 'mirrored';

export interface SettingsState {
  master: number; // 0..1
  sfx: number; // 0..1
  music: number; // 0..1
  muted: boolean;
  /** The persisted UI language — the live `t()` mirror is set via `setLocale()` at
   * boot and on every change (design/17-i18n.md), not read directly from here. */
  locale: Locale;
  controlLayout: ControlLayout;
  /** Render quality tier (`render/quality.ts`, 2026-08-25). `'auto'` starts on the high tier
   * and drops to low once the frame watchdog decides the device cannot hold it; `'high'`/
   * `'low'` pin it. Presentation-only — it never reaches the sim (design/06/12). */
  quality: QualitySetting;
}

export function defaultSettingsState(): SettingsState {
  // `music` is half of `sfx` by design: the bed should sit under the cues, not level with
  // them (2026-09-06 balance pass — the equal 0.5/0.5 default read as too loud relative to
  // the SFX bus). A save that already stores an explicit `music` value keeps it —
  // `store.ts`'s `migrate()` only falls back to this default when the field is absent.
  return { master: 1, sfx: 0.5, music: 0.25, muted: false, locale: DEFAULT_LOCALE, controlLayout: 'standard', quality: 'auto' };
}

/** The effective 0..1 gain to hand the AudioBus for a given slider — `muted` zeroes
 * both buses without discarding the stored slider values (so unmuting restores them). */
export function effectiveVolume(s: SettingsState, bus: 'sfx' | 'music'): number {
  if (s.muted) return 0;
  return Math.max(0, Math.min(1, s.master * s[bus]));
}
