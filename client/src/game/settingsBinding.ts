// Split out of Game.ts (2026-08-25, 500-line convention — the quality tier pushed that file
// past its recorded baseline, and CLAUDE.md's priority order says split rather than baseline).
//
// Owns one concern: the persisted `SettingsState` and the five places a change to it has to
// land — the audio bus (design/11), the touch control layout (design/10), the render quality
// tier (`renderQuality.ts`), the in-run frame cap (`powerBudget.ts`) and the live i18n mirror
// (design/17). Before this, they were private methods on `Game` plus a load block plus an
// `onChange` closure, all of which had to be kept in step by hand: `applyQuality` was added to
// the load path and to `onChange` separately, which is exactly the shape of the bug where a
// setting applies on change but not at boot.
//
// Form (2) from CLAUDE.md: the cross-boundary call list is `load`/`update`/`state` outward and
// the three-member `deps` object below inward, each narrowed to the methods actually used rather
// than being a handle on the whole `AudioBus`/`InputSource`/`RenderQualityController`.
import {
  createWebSettingsStore,
  defaultSettingsState,
  effectiveVolume,
  type SettingsState,
  type SettingsStore,
} from '../settings';
import { setLocale } from '../i18n';
import { isExternallyMuted, onExternalMuteChange } from '../audio/externalMute';
import type { QualitySetting } from '../render/quality';
import { setPlayFrameCap } from './powerBudget';

export interface SettingsBindingDeps {
  audio: { setSfxVolume(v: number): void; setMusicVolume(v: number): void };
  /** `setControlMirror` is optional on `InputSource` — a fake with no touch controls has
   *  nothing to mirror, and that is a legitimate host, not a missing implementation. */
  input: { setControlMirror?(mirrored: boolean): void };
  quality: { apply(setting: QualitySetting): void; pin(setting: QualitySetting): void };
}

export class SettingsBinding {
  private current: SettingsState = defaultSettingsState();

  constructor(
    private readonly deps: SettingsBindingDeps,
    private readonly store: SettingsStore = createWebSettingsStore(),
  ) {
    // This class is the ONE authority on what the audio bus is set to, so it is also the
    // one place an outside-the-game mute can land (`audio/externalMute.ts` explains why a
    // portal ad has to reach it through a module sink rather than a parameter). Re-applying
    // is all it takes: `applyAll` recomputes from the settings and the flag together, so
    // release restores whatever the player had rather than a default.
    onExternalMuteChange(() => this.applyAll());
  }

  /** The live state, for the screens that render it. Read-only by convention: every write goes
   *  through `update` so that persistence and application cannot be skipped. */
  get state(): SettingsState {
    return this.current;
  }

  /**
   * Load the persisted state and apply ALL of it. Volume, language, control layout, quality and
   * the in-run frame cap all take effect immediately at boot rather than only after the first
   * settings edit — the property that is easy to lose when each of them is wired separately.
   */
  load(): SettingsState {
    this.current = this.store.load();
    this.applyAll();
    // design/17-i18n.md: `setLocale` is the live mirror every `t()` call reads;
    // `current.locale` is only the persisted copy. Not in `applyAll` — the settings SCREEN
    // calls `setLocale` itself before reporting the change (so its own re-render is already in
    // the new language), and calling it twice on that path would be redundant, not wrong.
    setLocale(this.current.locale);
    this.deps.quality.apply(this.current.quality);
    return this.current;
  }

  /** The settings screen reported a change: persist it, then apply whatever moved. */
  update(next: SettingsState): void {
    const qualityChanged = next.quality !== this.current.quality;
    this.current = next;
    this.store.save(next);
    this.applyAll();
    // Only on an actual change: `pin` can reallocate the renderer's backing buffer, and a volume
    // drag must not pay for one on every frame of the drag.
    if (qualityChanged) this.deps.quality.pin(next.quality);
  }

  private applyAll(): void {
    // The external mute is a FACTOR over the settings, never a write to them: `this.current`
    // is untouched, so the settings screen keeps rendering the player's real values while an
    // ad is playing and the release path needs no saved copy to restore from.
    const gain = isExternallyMuted() ? 0 : 1;
    this.deps.audio.setSfxVolume(gain * effectiveVolume(this.current, 'sfx'));
    this.deps.audio.setMusicVolume(gain * effectiveVolume(this.current, 'music'));
    this.deps.input.setControlMirror?.(this.current.controlLayout === 'mirrored');
    // The in-run frame cap (`powerBudget.ts`), through its module mirror rather than a dep for
    // the reason that file's own note gives: the reader is the main loop, 60 times a second.
    // In `applyAll` and not next to `quality.apply` below, so it lands on BOTH paths — boot and
    // change — which is the bug shape this class was extracted to prevent.
    setPlayFrameCap(this.current.frameRate);
  }
}
