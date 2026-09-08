import { Container, Text } from 'pixi.js';
import type { ControlLayout, SettingsState } from '../../settings';
import { Panel, Slider, Button } from '../ui/widgets';
import { t, setLocale, LOCALES, type Locale } from '../../i18n';
import { QUALITY_SETTINGS, activeQuality, type QualitySetting } from '../../render/quality';
import { FRAME_RATE_SETTINGS, type FrameRateSetting } from '../powerBudget';

function nextControlLayout(current: ControlLayout): ControlLayout {
  return current === 'standard' ? 'mirrored' : 'standard';
}

/** Same tap-to-cycle shape as the language and control-layout buttons — four values, so a
 *  picker widget would be more ceremony than the setting is worth (see `nextLocale`). */
function nextQuality(current: QualitySetting): QualitySetting {
  const i = QUALITY_SETTINGS.indexOf(current);
  return QUALITY_SETTINGS[(i + 1) % QUALITY_SETTINGS.length]!;
}

/** ...and the in-run frame rate (`game/powerBudget.ts`), which is two values and so cycles
 *  rather than needing a picker at all. */
function nextFrameRate(current: FrameRateSetting): FrameRateSetting {
  const i = FRAME_RATE_SETTINGS.indexOf(current);
  return FRAME_RATE_SETTINGS[(i + 1) % FRAME_RATE_SETTINGS.length]!;
}

/**
 * The button's value half. `'auto'` reports what auto actually RESOLVED to, not just that it is
 * auto: a player whose phone was downgraded by the frame watchdog (`render/qualityWatchdog.ts`)
 * would otherwise see "AUTO" on a screen that is visibly running the low tier, with nothing
 * anywhere connecting the two. The live mirror is the only place that knows — the setting alone
 * cannot answer it.
 */
function qualityLabel(setting: QualitySetting): string {
  if (setting === 'high') return t('settings.qualityHigh');
  if (setting === 'medium') return t('settings.qualityMedium');
  if (setting === 'low') return t('settings.qualityLow');
  const tier = activeQuality().tier;
  if (tier === 'low') return t('settings.qualityAutoLow');
  if (tier === 'medium') return t('settings.qualityAutoMedium');
  return t('settings.qualityAuto');
}

/** Display name for the LANGUAGE toggle — always shown in that language's own name
 * (not translated), same convention most apps use for a language picker. */
const LOCALE_NAMES: Record<Locale, string> = {
  en: 'English',
  zh: '中文',
  de: 'Deutsch',
  fr: 'Français',
  es: 'Español',
  pl: 'Polski',
  ru: 'Русский',
  it: 'Italiano',
};

/** Cycles to the next locale in `LOCALES`' declared order, wrapping around — the
 * two-locale `OTHER_LOCALE` swap this replaced doesn't scale past 2 entries, but a
 * tap-to-cycle button still does for `LOCALES.length` this small (8). A real list/
 * picker widget would read better at this size; deliberately not built (design/17-
 * i18n.md), since it's a new widget shape this project doesn't have yet elsewhere. */
function nextLocale(current: Locale): Locale {
  const i = LOCALES.indexOf(current);
  return LOCALES[(i + 1) % LOCALES.length]!;
}

/**
 * The settings screen (design/10 "Settings incl. SFX/music volume"). Pure
 * presentation: it renders a `SettingsState` and reports changes via `onChange`; Game
 * owns persistence (SettingsStore) and applying volume to the AudioBus. Reached from
 * the forge outpost only — there's no in-run pause menu yet (design/10 open question).
 */
export class Settings {
  readonly view = new Container();
  private panel = new Panel({ alpha: 0.88, background: 'hub' });
  private title: Text;
  private masterLabel: Text;
  private sfxLabel: Text;
  private musicLabel: Text;
  private masterSlider: Slider;
  private sfxSlider: Slider;
  private musicSlider: Slider;
  private muteBtn: Button;
  private languageBtn: Button;
  private controlLayoutBtn: Button;
  private qualityBtn: Button;
  private frameRateBtn: Button;
  private backBtn: Button;

  onChange: ((s: SettingsState) => void) | null = null;
  onBack: (() => void) | null = null;

  private state: SettingsState = {
    master: 1, sfx: 0.5, music: 0.5, muted: false, locale: 'en', controlLayout: 'standard',
    quality: 'auto', frameRate: 60,
  };

  // Screen-space anchors for the buttons below, captured by `show()` and reused by
  // `layoutButtons()` on every locale/state change — `update()` (a mute/language/control
  // tap) doesn't re-run `show()`, but with `autoWidth` buttons a text change can still
  // change their width, so it must still re-run the positioning math to stay centered.
  private cx = 0;
  private languageY = 0;
  private controlY = 0;
  private qualityY = 0;
  private frameRateY = 0;
  private pairY = 0;

  constructor() {
    this.title = new Text({ text: t('settings.title'), style: { fill: 0xf7fafc, fontSize: 30, fontWeight: 'bold', fontFamily: 'sans-serif' } });
    this.title.anchor.set(0.5, 0);

    const labelStyle = { fill: 0xcbd5e0, fontSize: 16, fontFamily: 'monospace' as const };
    this.masterLabel = new Text({ text: '', style: labelStyle });
    this.sfxLabel = new Text({ text: '', style: labelStyle });
    this.musicLabel = new Text({ text: '', style: labelStyle });

    // Full-view eventMode is already 'static' below (needed for the sliders' drag
    // surface, design/10 "no DOM widgets" — everything is a Pixi hit-area).
    this.masterSlider = new Slider({ w: 260, dragSurface: this.view });
    this.sfxSlider = new Slider({ w: 260, dragSurface: this.view });
    this.musicSlider = new Slider({ w: 260, dragSurface: this.view });
    this.masterSlider.onChange = (v) => this.update({ ...this.state, master: v });
    this.sfxSlider.onChange = (v) => this.update({ ...this.state, sfx: v });
    this.musicSlider.onChange = (v) => this.update({ ...this.state, music: v });

    // `autoWidth: true` on every button below — their labels are translated (design/17-
    // i18n.md) and a fixed pixel width sized for English overflows once a locale's
    // string runs longer (e.g. Russian "ВКЛЮЧИТЬ ЗВУК", "УПРАВЛЕНИЕ: ЛЕВША"); the `w`
    // passed here becomes a minimum, not a fixed size — see widgets.ts's Button.
    this.muteBtn = new Button('', { w: 120, h: 34, autoWidth: true, sound: 'ui.toggle' });
    this.muteBtn.onTap = () => this.update({ ...this.state, muted: !this.state.muted });

    // Language cycle button (design/17-i18n.md) — same tappable pattern as muteBtn
    // (design/10 "no DOM widgets"), stepping through `LOCALES` in declared order on
    // each tap; `setLocale` takes effect immediately so this button's own next
    // `syncWidgets()` already reads in the new language.
    this.languageBtn = new Button('', { w: 160, h: 34, autoWidth: true, sound: 'ui.toggle' });
    this.languageBtn.onTap = () => {
      const next = nextLocale(this.state.locale);
      setLocale(next);
      this.update({ ...this.state, locale: next });
    };

    // Left-handed control-layout toggle (design/10 open question) — same tap-to-cycle
    // pattern as languageBtn; only meaningfully affects touch play (TouchControls'
    // stick/button geometry), but lives here rather than being hidden behind a touch-
    // only check, since a desktop player may still be setting this up for later.
    this.controlLayoutBtn = new Button('', { w: 200, h: 34, autoWidth: true, sound: 'ui.toggle' });
    this.controlLayoutBtn.onTap = () => {
      const next = nextControlLayout(this.state.controlLayout);
      this.update({ ...this.state, controlLayout: next });
    };

    // Render quality (design/04 items 3/6, `render/quality.ts`) — the one setting here that is
    // about the DEVICE rather than about taste, which is why 'auto' is the default and is
    // listed first: most players should never have to think about it, and the ones on hardware
    // that cannot hold 60fps get the drop without asking for it.
    this.qualityBtn = new Button('', { w: 200, h: 34, autoWidth: true, sound: 'ui.toggle' });
    this.qualityBtn.onTap = () => {
      this.update({ ...this.state, quality: nextQuality(this.state.quality) });
    };

    // In-run frame rate (`game/powerBudget.ts`) — the battery knob the quality tier cannot
    // express, and the one directly below it here because a player looking for either is
    // looking for the same thing. No 'auto': see `FrameRateSetting`'s note on why a second
    // policy must not also be steering off the frame-rate stream.
    this.frameRateBtn = new Button('', { w: 200, h: 34, autoWidth: true, sound: 'ui.toggle' });
    this.frameRateBtn.onTap = () => {
      this.update({ ...this.state, frameRate: nextFrameRate(this.state.frameRate) });
    };

    this.backBtn = new Button(t('settings.back'), { w: 120, h: 34, autoWidth: true, sound: 'ui.back' });
    this.backBtn.onTap = () => this.onBack?.();

    this.view.addChild(
      this.panel.view, this.title,
      this.masterLabel, this.masterSlider.view,
      this.sfxLabel, this.sfxSlider.view,
      this.musicLabel, this.musicSlider.view,
      this.muteBtn.view, this.languageBtn.view, this.controlLayoutBtn.view, this.qualityBtn.view,
      this.frameRateBtn.view, this.backBtn.view,
    );
    this.view.eventMode = 'static';
    this.view.visible = false;
  }

  private update(next: SettingsState) {
    this.state = next;
    this.syncWidgets();
    this.onChange?.(this.state);
  }

  private syncWidgets() {
    // Re-applies static labels too (not just the ones that vary with `state`) — same
    // "resync on every call" convention as the rest of this method, so a language
    // change (design/17-i18n.md) takes effect the next time this screen is shown.
    this.title.text = t('settings.title');
    this.backBtn.setText(t('settings.back'));
    this.masterSlider.set(this.state.master);
    this.sfxSlider.set(this.state.sfx);
    this.musicSlider.set(this.state.music);
    // `padEnd` (not a literal-spaces template) so the value column still lines up
    // regardless of how long the translated label word is.
    this.masterLabel.text = `${t('settings.master').padEnd(9)}${pct(this.state.master)}`;
    this.sfxLabel.text = `${t('settings.sfx').padEnd(9)}${pct(this.state.sfx)}`;
    this.musicLabel.text = `${t('settings.music').padEnd(9)}${pct(this.state.music)}`;
    this.muteBtn.setText(this.state.muted ? t('settings.unmute') : t('settings.mute'));
    this.languageBtn.setText(t('settings.language', { name: LOCALE_NAMES[this.state.locale] }));
    const modeKey = this.state.controlLayout === 'mirrored' ? 'settings.controlLayoutMirrored' : 'settings.controlLayoutStandard';
    this.controlLayoutBtn.setText(t('settings.controlLayout', { mode: t(modeKey) }));
    this.qualityBtn.setText(t('settings.quality', { mode: qualityLabel(this.state.quality) }));
    this.frameRateBtn.setText(t('settings.frameRate', { fps: String(this.state.frameRate) }));
    this.layoutButtons();
  }

  /** Positions the `autoWidth` buttons from their current (post-`setText`) widths,
   * not the fixed-pixel halves this used to be (`cx - 80`, `cx - 100`, `cx - 130`) —
   * those assumed the English string length and left longer translations off-center or
   * overflowing their box. Runs after every `syncWidgets()` — the anchors themselves
   * (`cx`/`languageY`/`controlY`/`pairY`) only change on `show()`, since only a resize
   * moves the rows, but a locale/mute/control-layout tap changes a label's width without
   * re-running `show()`. */
  private layoutButtons() {
    const cx = this.cx;
    this.languageBtn.view.position.set(cx - this.languageBtn.width / 2, this.languageY);
    this.controlLayoutBtn.view.position.set(cx - this.controlLayoutBtn.width / 2, this.controlY);
    this.qualityBtn.view.position.set(cx - this.qualityBtn.width / 2, this.qualityY);
    this.frameRateBtn.view.position.set(cx - this.frameRateBtn.width / 2, this.frameRateY);
    // Mute + Back sit side-by-side as a pair, centered as a unit under `cx` (was
    // `cx - 130` / `cx + 10`, i.e. two fixed 120px boxes with a 20px gap between them —
    // reproduced here from each button's actual width instead).
    const gap = 20;
    const pairW = this.muteBtn.width + gap + this.backBtn.width;
    const pairX = cx - pairW / 2;
    this.muteBtn.view.position.set(pairX, this.pairY);
    this.backBtn.view.position.set(pairX + this.muteBtn.width + gap, this.pairY);
  }

  show(w: number, h: number, s: SettingsState) {
    this.state = s;
    this.panel.layout(w, h);
    this.cx = w / 2;
    const rowX = this.cx - 130;
    let y = Math.max(40, h * 0.15);
    this.title.position.set(this.cx, y);
    y += 70;
    for (const [label, slider] of [
      [this.masterLabel, this.masterSlider] as const,
      [this.sfxLabel, this.sfxSlider] as const,
      [this.musicLabel, this.musicSlider] as const,
    ]) {
      label.position.set(rowX, y);
      slider.view.position.set(rowX, y + 30);
      y += 70;
    }
    this.languageY = y + 10;
    y += 44;
    this.controlY = y + 10;
    y += 44;
    this.qualityY = y + 10;
    y += 44;
    this.frameRateY = y + 10;
    y += 44;
    this.pairY = y + 10;
    this.syncWidgets();
    this.view.visible = true;
  }

  hide() {
    this.view.visible = false;
  }
}

function pct(v: number): string {
  return `${Math.round(v * 100)}%`;
}
