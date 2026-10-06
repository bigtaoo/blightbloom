import { Container, Graphics, Text } from 'pixi.js';
import type { ControlLayout, SettingsState } from '../../settings';
import { Button } from '../ui/widgets';
import { Slider } from '../ui/Slider';
import { MenuShell } from '../ui/MenuShell';
import type { LobbyBackdrop } from '../ui/LobbyBackdrop';
import { MENU_BUTTONS, MENU_COLORS, menuText } from '../ui/menuTheme';
import { SHEET_W, COL_W, CHIP_H, WIDE_BUTTON_H, layoutSettingsSheet, type OptionRow, type SliderRow } from './settingsSheet';
import { whenUiTexture } from '../../render/uiSkins';
import { t, LOCALES, type Locale } from '../../i18n';
import { useLocale } from '../../i18n/loadLocale';
import { QUALITY_SETTINGS, activeQuality, type QualitySetting } from '../../render/quality';
import { FRAME_RATE_SETTINGS, type FrameRateSetting } from '../powerBudget';
import { musicCreditLines } from '../../audio/musicCredits';

function nextControlLayout(current: ControlLayout): ControlLayout {
  return current === 'standard' ? 'mirrored' : 'standard';
}

/** Same tap-to-cycle shape as the language and control-layout chips — four values, so a
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
 * The quality chip's value. `'auto'` reports what auto actually RESOLVED to, not just that it
 * is auto: a player whose phone was downgraded by the frame watchdog (`render/qualityWatchdog.ts`)
 * would otherwise see "AUTO" on a screen that is visibly running the low tier, with nothing
 * anywhere connecting the two. The live mirror is the only place that knows — the setting alone
 * cannot answer it.
 */
function qualityValue(setting: QualitySetting): string {
  if (setting === 'high') return t('settings.qualityHigh');
  if (setting === 'medium') return t('settings.qualityMedium');
  if (setting === 'low') return t('settings.qualityLow');
  const tier = activeQuality().tier;
  if (tier === 'low') return t('settings.qualityAutoLow');
  if (tier === 'medium') return t('settings.qualityAutoMedium');
  return t('settings.qualityAuto');
}

/** Display name for the LANGUAGE chip — always shown in that language's own name
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

/** Minimum width of a value chip — `autoWidth` grows it for a longer translated value. */
const CHIP_MIN_W = 132;

/**
 * The settings screen (design/10 "Settings incl. SFX/music volume"), on the menu shell
 * (design/10 "One shell for every menu", 2026-09-27). Pure presentation: it renders a
 * `SettingsState` and reports changes via `onChange`; Game owns persistence (SettingsStore) and
 * applying volume to the AudioBus. Reached from the lobby's corner chip and the pause menu.
 *
 * ## The layout
 *
 * One framed sheet, two columns of titled sections: AUDIO on the left (three volumes and MUTE),
 * DISPLAY and GAME on the right. Every option is a ROW — its name on the left, its current value
 * on a chip on the right that cycles when tapped — so the name and the value are two things the
 * eye can find separately (`settingsSheet.ts` places them).
 *
 * It replaced one centred stack of eleven buttons that each read "NAME: VALUE", where a label
 * and a value were one string and nothing grouped the device knobs apart from the taste ones.
 */
export class Settings {
  readonly view = new Container();
  private readonly shell: MenuShell;
  /** The dimmed lobby painting. Named `panel` for `menuCoversWorld.test.ts`. */
  private readonly panel: LobbyBackdrop;
  private readonly rules = new Graphics();
  private audioHeading: Text;
  private displayHeading: Text;
  private gameHeading: Text;
  private masterLabel: Text;
  private sfxLabel: Text;
  private musicLabel: Text;
  private masterValue: Text;
  private sfxValue: Text;
  private musicValue: Text;
  private masterSlider: Slider;
  private sfxSlider: Slider;
  private musicSlider: Slider;
  private muteBtn: Button;
  private languageLabel: Text;
  private controlLayoutLabel: Text;
  private qualityLabel: Text;
  private frameRateLabel: Text;
  private reduceMotionLabel: Text;
  private languageBtn: Button;
  private controlLayoutBtn: Button;
  private qualityBtn: Button;
  private frameRateBtn: Button;
  private reduceMotionBtn: Button;
  /** A second door onto the standalone level (2026-09-22) — the lobby's own TUTORIAL row
   *  hides once `MetaState.hasSeenTutorial` (`LobbyRoutes.setRecommendTutorial`, "open it, or
   *  take it off the screen" rather than dim it), and a route may not become fully
   *  unreachable, so this is where a returning player who wants to see it again finds it. */
  private tutorialBtn: Button;
  /** Who wrote the music (`audio/musicCredits.ts`, 2026-10-06). Five of the six loops are
   *  CC-BY, which requires the credit where a player can see it; plain text, because WeChat
   *  cannot follow an outbound link. */
  private creditsText: Text;

  onChange: ((s: SettingsState) => void) | null = null;
  onBack: (() => void) | null = null;
  /** REPLAY TUTORIAL — a passthrough, same shape as `onBack`: this screen does not know how
   *  to start a run, only that something else does. `gameWiring.ts` points it at the same
   *  verb the lobby's own TUTORIAL row calls. */
  onTutorial: (() => void) | null = null;

  private state: SettingsState = {
    master: 1, sfx: 0.5, music: 0.5, muted: false, locale: 'en', controlLayout: 'standard',
    quality: 'auto', frameRate: 60, reduceMotion: false,
  };
  private size: { w: number; h: number } | null = null;

  constructor() {
    this.shell = new MenuShell({ title: t('settings.title'), back: t('settings.back') });
    this.shell.onBack = () => this.onBack?.();
    this.panel = this.shell.backdrop;

    const heading = () => new Text({ text: '', style: menuText('heading') });
    this.audioHeading = heading();
    this.displayHeading = heading();
    this.gameHeading = heading();

    const name = () => {
      const text = new Text({ text: '', style: menuText('label', { fontSize: 14, wordWrap: true, breakWords: true }) });
      text.anchor.set(0, 0.5);
      return text;
    };
    const volumeName = () => new Text({ text: '', style: menuText('label', { fontSize: 14 }) });
    const percent = () => {
      const text = new Text({ text: '', style: menuText('value', { fontSize: 14, fill: MENU_COLORS.accent }) });
      text.anchor.set(1, 0);
      return text;
    };
    this.masterLabel = volumeName();
    this.sfxLabel = volumeName();
    this.musicLabel = volumeName();
    this.masterValue = percent();
    this.sfxValue = percent();
    this.musicValue = percent();

    // Full-view eventMode is already 'static' below (needed for the sliders' drag
    // surface, design/10 "no DOM widgets" — everything is a Pixi hit-area).
    this.masterSlider = new Slider({ w: COL_W, dragSurface: this.view });
    this.sfxSlider = new Slider({ w: COL_W, dragSurface: this.view });
    this.musicSlider = new Slider({ w: COL_W, dragSurface: this.view });
    this.masterSlider.onChange = (v) => this.update({ ...this.state, master: v });
    this.sfxSlider.onChange = (v) => this.update({ ...this.state, sfx: v });
    this.musicSlider.onChange = (v) => this.update({ ...this.state, music: v });

    this.muteBtn = new Button('', { w: COL_W, h: WIDE_BUTTON_H, fontSize: 14, ...MENU_BUTTONS.secondary, sound: 'ui.toggle' });
    this.muteBtn.onTap = () => this.update({ ...this.state, muted: !this.state.muted });

    // Every value chip is `autoWidth` — its value is translated (design/17-i18n.md), and a
    // width sized for English overflows once a locale's string runs longer (Russian
    // "ЛЕВША", "АВТО (СРЕДНЕЕ)"); the `w` passed here is a minimum, not a fixed size.
    // Each construction still spells out its own `sound` (`buttonCueConventions.test.ts` reads
    // the source line by line).
    const chip = { w: CHIP_MIN_W, h: CHIP_H, fontSize: 14, autoWidth: true, ...MENU_BUTTONS.secondary };
    this.languageLabel = name();
    this.controlLayoutLabel = name();
    this.qualityLabel = name();
    this.frameRateLabel = name();
    this.reduceMotionLabel = name();

    // Language (design/17-i18n.md), stepping through `LOCALES` in declared order on each tap.
    //
    // `useLocale`, not `setLocale`, since 2026-09-21: the table is its own chunk now
    // (i18n/loadLocale.ts), and switching to one that has not landed would redraw this screen
    // in English and leave it there until something else re-rendered it. `useLocale` loads
    // first and switches second, so this chip's own next `syncWidgets()` still reads in the
    // new language. In practice the await is already settled: the entry points prefetch every
    // table once the lobby is up. `this.state` is read INSIDE the callback so a change that
    // landed while the chunk was in flight is not overwritten by a stale copy.
    this.languageBtn = new Button('', { ...chip, sound: 'ui.toggle' });
    this.languageBtn.onTap = () => {
      const next = nextLocale(this.state.locale);
      void useLocale(next).then(() => this.update({ ...this.state, locale: next }));
    };

    // Left-handed control layout (design/10 open question) — only meaningfully affects touch
    // play (TouchControls' stick/button geometry), but lives here rather than being hidden
    // behind a touch-only check, since a desktop player may still be setting this up for later.
    this.controlLayoutBtn = new Button('', { ...chip, sound: 'ui.toggle' });
    this.controlLayoutBtn.onTap = () => {
      this.update({ ...this.state, controlLayout: nextControlLayout(this.state.controlLayout) });
    };

    // Render quality (design/04 items 3/6, `render/quality.ts`) — the one setting here that is
    // about the DEVICE rather than about taste, which is why 'auto' is the default: most
    // players should never have to think about it, and the ones on hardware that cannot hold
    // 60fps get the drop without asking for it.
    this.qualityBtn = new Button('', { ...chip, sound: 'ui.toggle' });
    this.qualityBtn.onTap = () => {
      this.update({ ...this.state, quality: nextQuality(this.state.quality) });
    };

    // In-run frame rate (`game/powerBudget.ts`) — the battery knob the quality tier cannot
    // express, and the row directly under it because a player looking for either is looking
    // for the same thing. No 'auto': see `FrameRateSetting`'s note on why a second policy must
    // not also be steering off the frame-rate stream.
    this.frameRateBtn = new Button('', { ...chip, sound: 'ui.toggle' });
    this.frameRateBtn.onTap = () => {
      this.update({ ...this.state, frameRate: nextFrameRate(this.state.frameRate) });
    };

    // Reduce motion (`render/motion.ts`, 2026-09-22) — under the two device knobs because a
    // player who came to this screen because the game made them feel unwell will try all
    // three. An on/off switch rather than a cycle: there are two states and no third one worth
    // inventing, and its chip turns go-green while it is on, so the state reads at a glance.
    this.reduceMotionBtn = new Button('', { ...chip, sound: 'ui.toggle' });
    this.reduceMotionBtn.onTap = () => {
      this.update({ ...this.state, reduceMotion: !this.state.reduceMotion });
    };

    // REPLAY TUTORIAL (2026-09-22) — a fixed action: it does not read or write
    // `SettingsState`, it only fires a passthrough (see `onTutorial`). Closes the GAME section.
    this.tutorialBtn = new Button(t('settings.tutorial'), { w: COL_W, h: WIDE_BUTTON_H, fontSize: 14, ...MENU_BUTTONS.secondary, sound: 'ui.tap' });
    this.tutorialBtn.onTap = () => this.onTutorial?.();
    whenUiTexture('icon_play', (tex) => this.tutorialBtn.setIcon(tex));

    this.creditsText = new Text({ text: '', style: menuText('caption') });

    this.shell.content.addChild(
      this.rules, this.audioHeading, this.displayHeading, this.gameHeading,
      this.masterLabel, this.masterValue, this.masterSlider.view,
      this.sfxLabel, this.sfxValue, this.sfxSlider.view,
      this.musicLabel, this.musicValue, this.musicSlider.view,
      this.muteBtn.view,
      this.qualityLabel, this.qualityBtn.view, this.frameRateLabel, this.frameRateBtn.view,
      this.reduceMotionLabel, this.reduceMotionBtn.view,
      this.languageLabel, this.languageBtn.view, this.controlLayoutLabel, this.controlLayoutBtn.view,
      this.tutorialBtn.view, this.creditsText,
    );
    this.shell.mount(this.view);
    this.view.eventMode = 'static';
    this.view.visible = false;
  }

  private update(next: SettingsState) {
    this.state = next;
    this.syncWidgets();
    this.onChange?.(this.state);
  }

  private syncWidgets() {
    // Re-applies static labels too (not just the ones that vary with `state`), so a language
    // change (design/17-i18n.md) takes effect on the tap that made it.
    this.shell.setTitle(t('settings.title'));
    this.shell.setBack(t('settings.back'));
    this.audioHeading.text = t('settings.sectionAudio');
    this.displayHeading.text = t('settings.sectionDisplay');
    this.gameHeading.text = t('settings.sectionGame');
    this.tutorialBtn.setText(t('settings.tutorial'));
    this.creditsText.text = [t('settings.musicCredits'), ...musicCreditLines()].join('\n');

    const volumes: Array<[Text, Text, Slider, string, number]> = [
      [this.masterLabel, this.masterValue, this.masterSlider, t('settings.master'), this.state.master],
      [this.sfxLabel, this.sfxValue, this.sfxSlider, t('settings.sfx'), this.state.sfx],
      [this.musicLabel, this.musicValue, this.musicSlider, t('settings.music'), this.state.music],
    ];
    for (const [label, value, slider, text, v] of volumes) {
      label.text = text;
      value.text = pct(v);
      slider.set(v);
      // Muted, the three volumes are kept but not in force — drawn faded, still draggable.
      slider.view.alpha = this.state.muted ? 0.45 : 1;
      value.alpha = this.state.muted ? 0.45 : 1;
    }
    this.muteBtn.setText(this.state.muted ? t('settings.unmute') : t('settings.mute'));

    this.languageLabel.text = t('settings.language');
    this.languageBtn.setText(LOCALE_NAMES[this.state.locale]);
    this.controlLayoutLabel.text = t('settings.controlLayout');
    this.controlLayoutBtn.setText(t(this.state.controlLayout === 'mirrored' ? 'settings.controlLayoutMirrored' : 'settings.controlLayoutStandard'));
    this.qualityLabel.text = t('settings.quality');
    this.qualityBtn.setText(qualityValue(this.state.quality));
    this.frameRateLabel.text = t('settings.frameRate');
    this.frameRateBtn.setText(t('settings.fps', { fps: String(this.state.frameRate) }));
    this.reduceMotionLabel.text = t('settings.reduceMotion');
    this.reduceMotionBtn.setText(this.state.reduceMotion ? t('settings.on') : t('settings.off'));
    this.reduceMotionBtn.setFill(this.state.reduceMotion ? MENU_COLORS.go : MENU_COLORS.second);
    this.reduceMotionBtn.setBorder(this.state.reduceMotion ? MENU_COLORS.goBorder : MENU_COLORS.secondBorder);
    this.layout();
  }

  /** Re-flow the sheet — on `show()` and after every change, since a chip's `autoWidth` can
   *  move with its value or the locale. */
  private layout() {
    if (!this.size) return;
    this.shell.layout(this.size.w, this.size.h, SHEET_W, layoutSettingsSheet(this.parts()));
  }

  private parts() {
    const volume: SliderRow[] = [
      { label: this.masterLabel, value: this.masterValue, slider: this.masterSlider },
      { label: this.sfxLabel, value: this.sfxValue, slider: this.sfxSlider },
      { label: this.musicLabel, value: this.musicValue, slider: this.musicSlider },
    ];
    const display: OptionRow[] = [
      { label: this.qualityLabel, btn: this.qualityBtn },
      { label: this.frameRateLabel, btn: this.frameRateBtn },
      { label: this.reduceMotionLabel, btn: this.reduceMotionBtn },
    ];
    const game: OptionRow[] = [
      { label: this.languageLabel, btn: this.languageBtn },
      { label: this.controlLayoutLabel, btn: this.controlLayoutBtn },
    ];
    return {
      audioHeading: this.audioHeading, displayHeading: this.displayHeading, gameHeading: this.gameHeading,
      rules: this.rules, volume, muteBtn: this.muteBtn, display, game, tutorialBtn: this.tutorialBtn,
      credits: this.creditsText,
    };
  }

  show(w: number, h: number, s: SettingsState) {
    this.state = s;
    this.size = { w, h };
    this.syncWidgets();
    this.view.visible = true;
  }

  /** Per-frame: the backdrop's rocks, glow and motes. Driven from the main loop's
   *  `menuScreens`, and a no-op while this screen is hidden. */
  animate(dtMs: number): void {
    if (this.view.visible) this.panel.update(dtMs);
  }

  hide() {
    this.view.visible = false;
  }
}

function pct(v: number): string {
  return `${Math.round(v * 100)}%`;
}
