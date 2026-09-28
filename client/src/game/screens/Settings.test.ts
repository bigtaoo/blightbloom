/**
 * Settings (design/10 "Settings incl. SFX/music volume"; language toggle added by
 * design/17-i18n.md; on the menu shell since 2026-09-27). Pure presentation: it renders a
 * `SettingsState` and reports changes via `onChange`, same convention as every other screen
 * here — driven directly through its private widgets (sliders/buttons), same escape hatch
 * PartyScreen.test.ts/MainMenu.test.ts use, since Pixi has no real pointer/drag simulation
 * under vitest.
 *
 * Since the shell, every option is a ROW: the setting's name in its own Text on the left, its
 * value on a chip on the right. So the assertions below read the chip for the value and the
 * name Text for the name — the two used to be one "NAME: VALUE" string on one button.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Settings } from './Settings';
import { defaultSettingsState, type SettingsState } from '../../settings';
import { getLocale, resetLocaleForTests, LOCALES, type Locale } from '../../i18n';
import { estimateMonoWidth } from '../ui/textWidth';
import { resetActiveQuality, setActiveQuality } from '../../render/quality';
import { useLocale } from '../../i18n/loadLocale';
import { installFakeTextCanvas } from './fakeTextCanvas';
import { COL_W, COL_GAP, CONTENT_W, OPTION_ROW_H } from './settingsSheet';
import { MENU_COLORS } from '../ui/menuTheme';

installFakeTextCanvas();

type ButtonInternals = {
  label: { text: string };
  onTap: (() => void) | null;
  width: number;
  color: number;
  view: { position: { x: number; y: number } };
};
type TextInternals = { text: string; position: { x: number; y: number }; style: { wordWrapWidth: number } };
type SliderInternals = { onChange: ((v: number) => void) | null; get(): number; width: number; view: { alpha: number } };

function privateOf(s: Settings) {
  const shell = (s as unknown as { shell: { sheet: { title: { text: string } }; backBtn: ButtonInternals } }).shell;
  const self = s as unknown as {
    audioHeading: { text: string };
    displayHeading: { text: string };
    gameHeading: { text: string };
    masterLabel: { text: string };
    sfxLabel: { text: string };
    musicLabel: { text: string };
    masterValue: { text: string; alpha: number };
    sfxValue: { text: string };
    musicValue: { text: string };
    masterSlider: SliderInternals;
    sfxSlider: SliderInternals;
    musicSlider: SliderInternals;
    muteBtn: ButtonInternals;
    languageLabel: TextInternals;
    controlLayoutLabel: TextInternals;
    qualityLabel: TextInternals;
    frameRateLabel: TextInternals;
    reduceMotionLabel: TextInternals;
    languageBtn: ButtonInternals;
    controlLayoutBtn: ButtonInternals;
    qualityBtn: ButtonInternals;
    frameRateBtn: ButtonInternals;
    reduceMotionBtn: ButtonInternals;
    tutorialBtn: ButtonInternals;
  };
  return Object.assign(self, { title: shell.sheet.title, backBtn: shell.backBtn });
}

/** The option rows, name and chip, in the order they sit on the sheet. */
function optionRows(s: Settings): Array<[string, TextInternals, ButtonInternals]> {
  const p = privateOf(s);
  return [
    ['quality', p.qualityLabel, p.qualityBtn],
    ['frameRate', p.frameRateLabel, p.frameRateBtn],
    ['reduceMotion', p.reduceMotionLabel, p.reduceMotionBtn],
    ['language', p.languageLabel, p.languageBtn],
    ['controlLayout', p.controlLayoutLabel, p.controlLayoutBtn],
  ];
}

/**
 * Tap the language chip and wait for the switch to actually land.
 *
 * The tap has been asynchronous since 2026-09-21: a locale's table is its own chunk
 * (`i18n/loadLocale.ts`), and the chip loads it BEFORE switching so the screen never
 * redraws itself in English on the way. `vi.waitFor` rather than a fixed number of microtask
 * flushes, because how many ticks a dynamic import takes is not something a test should be
 * asserting by accident.
 */
async function tapLanguage(s: Settings, expected: Locale): Promise<void> {
  privateOf(s).languageBtn.onTap?.();
  await vi.waitFor(() => expect(getLocale()).toBe(expected));
}

afterEach(() => resetLocaleForTests());

describe('Settings — sliders', () => {
  it('dragging a slider reports the new state via onChange, other fields unchanged', () => {
    const s = new Settings();
    s.show(800, 600, defaultSettingsState());
    const onChange = vi.fn();
    s.onChange = onChange;
    privateOf(s).masterSlider.onChange?.(0.3);
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ master: 0.3, sfx: 0.5, music: 0.25, muted: false }));
  });

  it('shows each volume as a name and a percentage, and sets its knob from the state', () => {
    const s = new Settings();
    s.show(800, 600, { ...defaultSettingsState(), master: 0.8, sfx: 0.4, music: 0.1 });
    const p = privateOf(s);
    expect([p.masterLabel.text, p.sfxLabel.text, p.musicLabel.text]).toEqual(['Master', 'SFX', 'Music']);
    expect([p.masterValue.text, p.sfxValue.text, p.musicValue.text]).toEqual(['80%', '40%', '10%']);
    expect([p.masterSlider.get(), p.sfxSlider.get(), p.musicSlider.get()]).toEqual([0.8, 0.4, 0.1]);
  });

  it('re-reads the percentage on the drag that changed it', () => {
    const s = new Settings();
    s.show(800, 600, defaultSettingsState());
    privateOf(s).masterSlider.onChange?.(0.37);
    expect(privateOf(s).masterValue.text).toBe('37%');
  });

  it('sizes each track to the column', () => {
    const s = new Settings();
    s.show(800, 600, defaultSettingsState());
    const p = privateOf(s);
    for (const slider of [p.masterSlider, p.sfxSlider, p.musicSlider]) {
      expect(slider.width).toBeGreaterThan(COL_W * 0.8);
      expect(slider.width).toBeLessThanOrEqual(COL_W);
    }
  });
});

describe('Settings — mute toggle', () => {
  it('tapping mute flips `muted` and relabels to UNMUTE', () => {
    const s = new Settings();
    s.show(800, 600, defaultSettingsState());
    const onChange = vi.fn();
    s.onChange = onChange;
    privateOf(s).muteBtn.onTap?.();
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ muted: true }));
    expect(privateOf(s).muteBtn.label.text).toBe('UNMUTE');
  });

  it('fades the volumes while muted — kept, but not in force — and restores them on unmute', () => {
    const s = new Settings();
    s.show(800, 600, defaultSettingsState());
    const p = privateOf(s);
    expect(p.masterSlider.view.alpha).toBe(1);
    p.muteBtn.onTap?.();
    expect(p.masterSlider.view.alpha).toBeLessThan(1);
    expect(p.masterValue.alpha).toBeLessThan(1);
    // The values themselves are untouched: unmuting brings back exactly what was set.
    expect(p.masterValue.text).toBe('100%');
    p.muteBtn.onTap?.();
    expect(p.masterSlider.view.alpha).toBe(1);
  });
});

describe('Settings — back', () => {
  it('the shell\'s BACK fires onBack', () => {
    const s = new Settings();
    s.show(800, 600, defaultSettingsState());
    const onBack = vi.fn();
    s.onBack = onBack;
    privateOf(s).backBtn.onTap?.();
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});

describe('Settings — replay tutorial (2026-09-22)', () => {
  it('tapping it fires onTutorial, and touches no SettingsState field', () => {
    // Unlike every button above it, this one is a fixed action, not a toggle — the same
    // shape as `onBack`, and the reason `buttonCueConventions.test.ts` carries it as a
    // named exception to "every Settings option is ui.toggle".
    const s = new Settings();
    s.show(800, 600, defaultSettingsState());
    const onTutorial = vi.fn();
    const onChange = vi.fn();
    s.onTutorial = onTutorial;
    s.onChange = onChange;
    privateOf(s).tutorialBtn.onTap?.();
    expect(onTutorial).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('renders the label from the active locale, translated with the rest of the screen', async () => {
    const s = new Settings();
    s.show(800, 600, defaultSettingsState());
    expect(privateOf(s).tutorialBtn.label.text).toBe('REPLAY TUTORIAL');
    await useLocale('zh');
    s.show(800, 600, { ...defaultSettingsState(), locale: 'zh' });
    expect(privateOf(s).tutorialBtn.label.text).toBe('重玩教程');
  });
});

describe('Settings — sections', () => {
  it('titles the three groups, translated with the rest of the screen', async () => {
    const s = new Settings();
    s.show(800, 600, defaultSettingsState());
    const p = privateOf(s);
    expect([p.audioHeading.text, p.displayHeading.text, p.gameHeading.text]).toEqual(['AUDIO', 'DISPLAY', 'GAME']);
    await useLocale('zh');
    s.show(800, 600, { ...defaultSettingsState(), locale: 'zh' });
    expect([p.audioHeading.text, p.displayHeading.text, p.gameHeading.text]).toEqual(['音频', '画面', '游戏']);
  });

  it('names every option in its own text, apart from the value', () => {
    const s = new Settings();
    s.show(800, 600, defaultSettingsState());
    expect(optionRows(s).map(([, label]) => label.text)).toEqual(['Quality', 'Frame rate', 'Reduce motion', 'Language', 'Controls']);
  });
});

describe('Settings — language (design/17-i18n.md)', () => {
  it('starts on English, showing its own name', () => {
    const s = new Settings();
    s.show(800, 600, defaultSettingsState());
    expect(privateOf(s).languageBtn.label.text).toBe('English');
  });

  it('tapping the chip switches the live locale and reports it via onChange', async () => {
    const s = new Settings();
    s.show(800, 600, defaultSettingsState());
    const onChange = vi.fn();
    s.onChange = onChange;
    await tapLanguage(s, 'zh');
    // BOTH halves, and the order between them is the point: the table is loaded and the live
    // mirror moved before `onChange` fires, so whatever re-renders off that report is already
    // reading the new language rather than one frame of English.
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ locale: 'zh' }));
  });

  it('the chip relabels itself and every other static label in the same tap', async () => {
    const s = new Settings();
    s.show(800, 600, defaultSettingsState());
    await tapLanguage(s, 'zh');
    const p = privateOf(s);
    expect(p.languageBtn.label.text).toBe('中文');
    expect(p.languageLabel.text).toBe('语言');
    expect(p.title.text).toBe('设置');
    expect(p.backBtn.label.text).toBe('返回');
  });

  it('cycles through every locale in declared order and wraps back to English', async () => {
    const s = new Settings();
    s.show(800, 600, defaultSettingsState());
    const p = privateOf(s);
    const seen: string[] = [getLocale()];
    // Every locale in turn, which also means every one of the seven lazily-imported tables is
    // really fetched and registered here — the closest this suite gets to proving the split
    // did not simply drop seven languages on the floor.
    for (let i = 0; i < LOCALES.length; i++) {
      await tapLanguage(s, LOCALES[(i + 1) % LOCALES.length]!);
      seen.push(getLocale());
    }
    expect(seen).toEqual(['en', ...LOCALES.slice(1), 'en']);
    expect(p.languageBtn.label.text).toBe('English');
  });

  it('a later show() re-applies the active locale, e.g. after re-entering from the pause menu', async () => {
    const s = new Settings();
    s.show(800, 600, defaultSettingsState());
    await useLocale('zh');
    s.show(800, 600, { ...defaultSettingsState(), locale: 'zh' });
    expect(privateOf(s).title.text).toBe('设置');
    expect(privateOf(s).masterLabel.text).toBe('总音量');
  });
});

describe('Settings — control layout (design/10 open question, left-handed mirror)', () => {
  it('starts on standard', () => {
    const s = new Settings();
    s.show(800, 600, defaultSettingsState());
    expect(privateOf(s).controlLayoutBtn.label.text).toBe('STANDARD');
  });

  it('tapping the chip flips to mirrored and reports it via onChange', () => {
    const s = new Settings();
    s.show(800, 600, defaultSettingsState());
    const onChange = vi.fn();
    s.onChange = onChange;
    privateOf(s).controlLayoutBtn.onTap?.();
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ controlLayout: 'mirrored' }));
    expect(privateOf(s).controlLayoutBtn.label.text).toBe('LEFT-HANDED');
  });

  it('tapping twice returns to standard', () => {
    const s = new Settings();
    s.show(800, 600, defaultSettingsState());
    privateOf(s).controlLayoutBtn.onTap?.();
    privateOf(s).controlLayoutBtn.onTap?.();
    expect(privateOf(s).controlLayoutBtn.label.text).toBe('STANDARD');
  });

  it('does not disturb the other fields (master/sfx/music/muted/locale)', () => {
    const s = new Settings();
    s.show(800, 600, defaultSettingsState());
    const onChange = vi.fn();
    s.onChange = onChange;
    privateOf(s).controlLayoutBtn.onTap?.();
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ master: 1, sfx: 0.5, music: 0.25, muted: false, locale: 'en' }),
    );
  });

  it('translates under zh', async () => {
    await useLocale('zh');
    const s = new Settings();
    s.show(800, 600, { ...defaultSettingsState(), locale: 'zh' });
    expect(privateOf(s).controlLayoutBtn.label.text).toBe('标准');
    privateOf(s).controlLayoutBtn.onTap?.();
    expect(privateOf(s).controlLayoutBtn.label.text).toBe('左手模式');
  });
});

// Regression coverage for the 2026-08-14 Russian-layout report: fixed-pixel-width buttons sized
// for English overflowed (`ВКЛЮЧИТЬ ЗВУК`) or sat in a box too wide/narrow for the translated
// string. The chips are `autoWidth` (widgets.ts) and the sheet re-places them off their CURRENT
// width after every change (`settingsSheet.ts`). `Button.width` is a plain number derived from
// `estimateMonoWidth` — no real canvas needed.
describe('Settings — chip width and placement across locales (autoWidth, 2026-08-14)', () => {
  const PAD = 28; // matches widgets.ts Button.redraw()'s autoWidth padding
  const CHIP_MIN_W = 132;

  function expectedWidth(text: string, fontSize = 14): number {
    return Math.max(CHIP_MIN_W, estimateMonoWidth(text, fontSize) + PAD);
  }

  it('tracks the formula-computed width for the current value at every locale', async () => {
    const s = new Settings();
    s.show(800, 600, defaultSettingsState());
    const p = privateOf(s);
    expect(p.languageBtn.width).toBeCloseTo(expectedWidth('English'), 6);

    await useLocale('ru');
    s.show(800, 600, { ...defaultSettingsState(), locale: 'ru', quality: 'medium' });
    expect(p.languageBtn.label.text).toBe('Русский');
    expect(p.qualityBtn.width).toBeCloseTo(expectedWidth(p.qualityBtn.label.text), 6);
  });

  it('never shrinks a chip below its minimum for a short value', () => {
    const s = new Settings();
    s.show(800, 600, defaultSettingsState());
    expect(privateOf(s).frameRateBtn.width).toBe(CHIP_MIN_W);
  });

  it('pins every chip to the right edge of its column, and keeps the name short of it, in every locale', async () => {
    // The right column's right edge is the content's right edge — the two columns fill it.
    expect(COL_W * 2 + COL_GAP).toBe(CONTENT_W);
    const s = new Settings();
    for (const loc of LOCALES) {
      await useLocale(loc);
      // The longest value of each chip in most locales: auto's resolved rung, left-handed, ON.
      setActiveQuality('medium');
      s.show(800, 600, { ...defaultSettingsState(), locale: loc, controlLayout: 'mirrored', reduceMotion: true });
      for (const [key, label, btn] of optionRows(s)) {
        expect(btn.view.position.x + btn.width, `${loc} ${key}`).toBeCloseTo(CONTENT_W, 6);
        expect(label.position.x, `${loc} ${key}`).toBe(COL_W + COL_GAP);
        expect(label.position.x + label.style.wordWrapWidth, `${loc} ${key}`).toBeLessThan(btn.view.position.x);
      }
    }
    resetActiveQuality();
  });

  it('keeps a chip on the right edge after a tap changes its width', () => {
    setActiveQuality('medium');
    const s = new Settings();
    s.show(800, 600, { ...defaultSettingsState(), quality: 'low' });
    const btn = privateOf(s).qualityBtn;
    const before = btn.width;
    btn.onTap?.(); // LOW -> AUTO (MEDIUM), past the chip's minimum
    expect(btn.width).toBeGreaterThan(before);
    expect(btn.view.position.x + btn.width).toBeCloseTo(CONTENT_W, 6);
    resetActiveQuality();
  });

  it('stacks the rows of a section one under another, and the two sections apart', () => {
    const s = new Settings();
    s.show(800, 600, defaultSettingsState());
    const rows = optionRows(s);
    for (let i = 1; i < rows.length; i++) {
      const gap = rows[i]![2].view.position.y - rows[i - 1]![2].view.position.y;
      expect(gap, `${rows[i - 1]![0]} -> ${rows[i]![0]}`).toBeGreaterThanOrEqual(OPTION_ROW_H);
    }
    // TUTORIAL closes the GAME section, under its last row.
    const p = privateOf(s);
    expect(p.tutorialBtn.view.position.y).toBeGreaterThan(p.controlLayoutBtn.view.position.y + 30);
    // MUTE closes the AUDIO column, in the left one.
    expect(p.muteBtn.view.position.x).toBe(0);
    expect(p.muteBtn.width).toBe(COL_W);
    // ...on REPLAY TUTORIAL's baseline, so the two columns end together.
    expect(p.muteBtn.view.position.y).toBe(p.tutorialBtn.view.position.y);
    // The volume rows are spread to meet it rather than stacked tight at the top.
    const sliders = [p.masterSlider, p.sfxSlider, p.musicSlider] as unknown as Array<{ view: { position: { y: number } } }>;
    expect(sliders[1]!.view.position.y - sliders[0]!.view.position.y).toBeGreaterThan(62);
  });
});

/**
 * The render-quality chip (`render/quality.ts`, 2026-08-25). Two claims worth pinning: the
 * cycle visits every setting and wraps, and `'auto'` reports what it actually RESOLVED to —
 * a player whose phone was downgraded by the frame watchdog must not read "AUTO" on a screen
 * that is visibly running the low tier.
 */
describe('Settings — render quality', () => {
  afterEach(() => {
    resetActiveQuality();
    resetLocaleForTests();
  });

  it('cycles auto -> high -> medium -> low -> auto, reporting each pick through onChange', () => {
    const s = new Settings();
    const seen: SettingsState['quality'][] = [];
    s.onChange = (next) => { seen.push(next.quality); s.show(800, 600, next); };
    s.show(800, 600, { ...defaultSettingsState(), quality: 'auto' });
    const p = privateOf(s);
    for (let i = 0; i < 4; i++) p.qualityBtn.onTap?.();
    expect(seen).toEqual(['high', 'medium', 'low', 'auto']);
  });

  it('labels a pinned tier from the setting alone', () => {
    const s = new Settings();
    const p = privateOf(s);
    // With the live mirror deliberately set to something ELSE, so a label that read the mirror
    // instead of the setting could not pass.
    setActiveQuality('low');
    s.show(800, 600, { ...defaultSettingsState(), quality: 'high' });
    expect(p.qualityBtn.label.text).toBe('HIGH');
    setActiveQuality('high');
    s.show(800, 600, { ...defaultSettingsState(), quality: 'medium' });
    expect(p.qualityBtn.label.text).toBe('MEDIUM');
    s.show(800, 600, { ...defaultSettingsState(), quality: 'low' });
    expect(p.qualityBtn.label.text).toBe('LOW');
  });

  it('says AUTO while auto is running high, and names the rung once it has stepped down', () => {
    const s = new Settings();
    const p = privateOf(s);
    setActiveQuality('high');
    s.show(800, 600, { ...defaultSettingsState(), quality: 'auto' });
    expect(p.qualityBtn.label.text).toBe('AUTO');
    // The watchdog stepped. The SETTING is unchanged — only the resolved tier moved, and the
    // chip is the only place the player can find that out.
    setActiveQuality('medium');
    s.show(800, 600, { ...defaultSettingsState(), quality: 'auto' });
    expect(p.qualityBtn.label.text).toBe('AUTO (MEDIUM)');
    setActiveQuality('low');
    s.show(800, 600, { ...defaultSettingsState(), quality: 'auto' });
    expect(p.qualityBtn.label.text).toBe('AUTO (LOW)');
  });

  it('is translated in every locale — name and value both', async () => {
    const s = new Settings();
    const p = privateOf(s);
    for (const loc of LOCALES) {
      await useLocale(loc);
      s.show(800, 600, { ...defaultSettingsState(), locale: loc, quality: 'medium' });
      expect(p.qualityBtn.label.text, loc).not.toBe('settings.qualityMedium');
      expect(p.qualityLabel.text, loc).not.toBe('settings.quality');
      expect(p.qualityLabel.text, loc).not.toContain('{');
    }
  });
});

/**
 * The in-run frame cap (`game/powerBudget.ts`, 2026-09-08) — the battery setting.
 */
describe('Settings — frame rate', () => {
  afterEach(() => resetLocaleForTests());

  it('cycles 60 -> 30 -> 60, reporting each pick through onChange', () => {
    const s = new Settings();
    const seen: SettingsState['frameRate'][] = [];
    s.onChange = (next) => { seen.push(next.frameRate); s.show(800, 600, next); };
    s.show(800, 600, { ...defaultSettingsState(), frameRate: 60 });
    const p = privateOf(s);
    p.frameRateBtn.onTap?.();
    p.frameRateBtn.onTap?.();
    expect(seen).toEqual([30, 60]);
  });

  it('labels the rate the player is on, and changes nothing else', () => {
    const s = new Settings();
    const p = privateOf(s);
    const onChange = vi.fn();
    s.show(800, 600, { ...defaultSettingsState(), frameRate: 60 });
    expect(p.frameRateBtn.label.text).toBe('60 FPS');
    s.onChange = onChange;
    p.frameRateBtn.onTap?.();
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ frameRate: 30, quality: 'auto', muted: false }));
    expect(p.frameRateBtn.label.text).toBe('30 FPS');
  });

  it('fills the rate in every locale', async () => {
    const s = new Settings();
    const p = privateOf(s);
    for (const loc of LOCALES) {
      await useLocale(loc);
      s.show(800, 600, { ...defaultSettingsState(), locale: loc, frameRate: 30 });
      expect(p.frameRateBtn.label.text, loc).not.toContain('{fps}');
      expect(p.frameRateBtn.label.text, loc).toContain('30');
      expect(p.frameRateLabel.text, loc).not.toBe('settings.frameRate');
    }
  });
});

/**
 * Reduce motion (2026-09-22) — the accessibility row. Everything about it is one boolean, which
 * is exactly why it is worth pinning: a toggle wired to the wrong field compiles, renders,
 * relabels, and reports the wrong setting forever.
 */
describe('Settings — reduce motion', () => {
  afterEach(() => resetLocaleForTests());

  it('toggles on and off, reporting each state through onChange', () => {
    const s = new Settings();
    const seen: SettingsState['reduceMotion'][] = [];
    s.onChange = (next) => { seen.push(next.reduceMotion); s.show(800, 600, next); };
    s.show(800, 600, { ...defaultSettingsState(), reduceMotion: false });
    const p = privateOf(s);
    p.reduceMotionBtn.onTap?.();
    p.reduceMotionBtn.onTap?.();
    expect(seen).toEqual([true, false]);
  });

  it('labels the state the player is in, and changes nothing else', () => {
    // The "nothing else" half is the one that matters: the tap builds a whole new
    // `SettingsState`, so a spread that dropped a field — or a handler that flipped `muted`
    // because it was copied from the button above — reports a plausible object either way.
    const s = new Settings();
    const p = privateOf(s);
    const onChange = vi.fn();
    s.show(800, 600, { ...defaultSettingsState(), reduceMotion: false });
    expect(p.reduceMotionBtn.label.text).toBe('OFF');
    s.onChange = onChange;
    p.reduceMotionBtn.onTap?.();
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      reduceMotion: true, muted: false, quality: 'auto', frameRate: 60, controlLayout: 'standard',
    }));
    expect(p.reduceMotionBtn.label.text).toBe('ON');
  });

  it('turns its chip go-green while on, so the state reads without reading the word', () => {
    const s = new Settings();
    const p = privateOf(s);
    s.show(800, 600, { ...defaultSettingsState(), reduceMotion: false });
    expect(p.reduceMotionBtn.color).toBe(MENU_COLORS.second);
    p.reduceMotionBtn.onTap?.();
    expect(p.reduceMotionBtn.color).toBe(MENU_COLORS.go);
    p.reduceMotionBtn.onTap?.();
    expect(p.reduceMotionBtn.color).toBe(MENU_COLORS.second);
  });

  it('starts from the persisted value rather than from a default', () => {
    // A player who turned this on is a player the game made unwell. Showing the screen with it
    // reading OFF would be worse than the setting not existing.
    const s = new Settings();
    s.show(800, 600, { ...defaultSettingsState(), reduceMotion: true });
    expect(privateOf(s).reduceMotionBtn.label.text).toBe('ON');
  });

  it('translates the value in every locale, not just the name', async () => {
    const s = new Settings();
    const p = privateOf(s);
    for (const loc of LOCALES) {
      await useLocale(loc);
      s.show(800, 600, { ...defaultSettingsState(), locale: loc, reduceMotion: true });
      expect(p.reduceMotionLabel.text, loc).not.toBe('settings.reduceMotion');
      expect(p.reduceMotionBtn.label.text, loc).not.toBe('settings.on');
      if (loc !== 'en') expect(p.reduceMotionLabel.text, loc).not.toBe('Reduce motion');
    }
  });
});

describe('Settings — the backdrop', () => {
  it('moves only while the screen is up', () => {
    const s = new Settings();
    const panel = (s as unknown as { panel: { update: (dt: number) => void } }).panel;
    const spy = vi.spyOn(panel, 'update');
    s.animate(16);
    expect(spy).not.toHaveBeenCalled();
    s.show(800, 600, defaultSettingsState());
    s.animate(16);
    expect(spy).toHaveBeenCalledWith(16);
    s.hide();
    s.animate(16);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
