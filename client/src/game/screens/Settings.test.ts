/**
 * Settings (design/10 "Settings incl. SFX/music volume"; language toggle added by
 * design/17-i18n.md). Pure presentation: it renders a `SettingsState` and reports
 * changes via `onChange`, same convention as every other screen here — driven directly
 * through its private widgets (sliders/buttons), same escape hatch PartyScreen.test.ts/
 * MainMenu.test.ts use, since Pixi has no real pointer/drag simulation under vitest.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Settings } from './Settings';
import { defaultSettingsState, type SettingsState } from '../../settings';
import { getLocale, setLocale, resetLocaleForTests, LOCALES } from '../../i18n';
import { estimateMonoWidth } from '../ui/textWidth';
import { resetActiveQuality, setActiveQuality } from '../../render/quality';

type ButtonInternals = {
  label: { text: string };
  onTap: (() => void) | null;
  width: number;
  view: { position: { x: number; y: number } };
};

function privateOf(s: Settings) {
  return s as unknown as {
    title: { text: string };
    masterLabel: { text: string };
    sfxLabel: { text: string };
    musicLabel: { text: string };
    masterSlider: { onChange: ((v: number) => void) | null };
    sfxSlider: { onChange: ((v: number) => void) | null };
    musicSlider: { onChange: ((v: number) => void) | null };
    muteBtn: ButtonInternals;
    languageBtn: ButtonInternals;
    controlLayoutBtn: ButtonInternals;
    qualityBtn: ButtonInternals;
    backBtn: ButtonInternals;
  };
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
});

describe('Settings — back', () => {
  it('tapping back fires onBack', () => {
    const s = new Settings();
    s.show(800, 600, defaultSettingsState());
    const onBack = vi.fn();
    s.onBack = onBack;
    privateOf(s).backBtn.onTap?.();
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});

describe('Settings — language toggle (design/17-i18n.md)', () => {
  it('starts on English, showing its own name', () => {
    const s = new Settings();
    s.show(800, 600, defaultSettingsState());
    expect(privateOf(s).languageBtn.label.text).toBe('LANGUAGE: English');
  });

  it('tapping the toggle flips the live locale immediately and reports it via onChange', () => {
    const s = new Settings();
    s.show(800, 600, defaultSettingsState());
    const onChange = vi.fn();
    s.onChange = onChange;
    privateOf(s).languageBtn.onTap?.();
    expect(getLocale()).toBe('zh'); // setLocale() happens synchronously inside onTap
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ locale: 'zh' }));
  });

  it('the toggle relabels itself and every other static label in the same tap', () => {
    const s = new Settings();
    s.show(800, 600, defaultSettingsState());
    privateOf(s).languageBtn.onTap?.();
    const p = privateOf(s);
    expect(p.languageBtn.label.text).toBe('语言：中文');
    expect(p.title.text).toBe('设置');
    expect(p.backBtn.label.text).toBe('返回');
  });

  it('cycles through every locale in declared order and wraps back to English', () => {
    const s = new Settings();
    s.show(800, 600, defaultSettingsState());
    const p = privateOf(s);
    const seen: string[] = [getLocale()];
    for (let i = 0; i < LOCALES.length; i++) {
      p.languageBtn.onTap?.();
      seen.push(getLocale());
    }
    // One full cycle (LOCALES.length taps) visits every locale exactly once, in
    // LOCALES' own declared order, and lands back on English.
    expect(seen).toEqual(['en', ...LOCALES.slice(1), 'en']);
    expect(p.languageBtn.label.text).toBe('LANGUAGE: English');
  });

  it('a later show() re-applies the active locale, e.g. after re-entering from the pause menu', () => {
    const s = new Settings();
    s.show(800, 600, defaultSettingsState());
    setLocale('zh');
    const zhState: SettingsState = { ...defaultSettingsState(), locale: 'zh' };
    s.show(800, 600, zhState);
    expect(privateOf(s).title.text).toBe('设置');
    expect(privateOf(s).masterLabel.text).toContain('总音量');
  });
});

describe('Settings — control-layout toggle (design/10 open question, left-handed mirror)', () => {
  it('starts on standard', () => {
    const s = new Settings();
    s.show(800, 600, defaultSettingsState());
    expect(privateOf(s).controlLayoutBtn.label.text).toBe('CONTROLS: STANDARD');
  });

  it('tapping the toggle flips to mirrored and reports it via onChange', () => {
    const s = new Settings();
    s.show(800, 600, defaultSettingsState());
    const onChange = vi.fn();
    s.onChange = onChange;
    privateOf(s).controlLayoutBtn.onTap?.();
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ controlLayout: 'mirrored' }));
    expect(privateOf(s).controlLayoutBtn.label.text).toBe('CONTROLS: LEFT-HANDED');
  });

  it('tapping twice returns to standard', () => {
    const s = new Settings();
    s.show(800, 600, defaultSettingsState());
    privateOf(s).controlLayoutBtn.onTap?.();
    privateOf(s).controlLayoutBtn.onTap?.();
    expect(privateOf(s).controlLayoutBtn.label.text).toBe('CONTROLS: STANDARD');
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

  it('translates under zh', () => {
    setLocale('zh');
    const s = new Settings();
    s.show(800, 600, { ...defaultSettingsState(), locale: 'zh' });
    expect(privateOf(s).controlLayoutBtn.label.text).toBe('操作布局：标准');
    privateOf(s).controlLayoutBtn.onTap?.();
    expect(privateOf(s).controlLayoutBtn.label.text).toBe('操作布局：左手模式');
  });
});

// Regression coverage for the 2026-08-14 Russian-layout report: fixed-pixel-width
// buttons sized for English overflowed (`ВКЛЮЧИТЬ ЗВУК`) or sat off-center in a box
// too wide/narrow for the translated string (`ЯЗЫК: Русский`, `УПРАВЛЕНИЕ: ЛЕВША`).
// The fix made these four buttons `autoWidth` (widgets.ts) and re-centers them off
// their *current* width (Settings.ts's `layoutButtons`) instead of a value baked in
// for the English label's length. `Button.width` is a plain number derived from
// `estimateMonoWidth` — no real canvas needed, so these assertions run under plain
// vitest same as textWidth.test.ts.
describe('Settings — button width/centering across locales (autoWidth, 2026-08-14)', () => {
  const CX = 400; // screen width 800 / 2
  const PAD = 28; // matches widgets.ts Button.redraw()'s autoWidth padding

  function expectedWidth(text: string, minW: number, fontSize = 15): number {
    return Math.max(minW, estimateMonoWidth(text, fontSize) + PAD);
  }

  it('tracks the formula-computed width for the current label at every locale', () => {
    const s = new Settings();
    s.show(800, 600, defaultSettingsState());
    const p = privateOf(s);
    expect(p.languageBtn.width).toBeCloseTo(expectedWidth('LANGUAGE: English', 160), 6);

    setLocale('ru');
    s.show(800, 600, { ...defaultSettingsState(), locale: 'ru' });
    expect(p.languageBtn.label.text).toBe('ЯЗЫК: Русский');
    expect(p.languageBtn.width).toBeCloseTo(expectedWidth('ЯЗЫК: Русский', 160), 6);
  });

  it('grows the control-layout button to fit a longer translated label instead of clipping it', () => {
    setLocale('ru');
    const s = new Settings();
    s.show(800, 600, { ...defaultSettingsState(), locale: 'ru' });
    const btn = privateOf(s).controlLayoutBtn;
    // "УПРАВЛЕНИЕ: СТАНДАРТ" outgrows the 200px minimum sized for "CONTROLS: STANDARD" —
    // the box must widen to fit it, not clip it at the old fixed width.
    expect(btn.label.text).toBe('УПРАВЛЕНИЕ: СТАНДАРТ');
    expect(btn.width).toBeCloseTo(expectedWidth('УПРАВЛЕНИЕ: СТАНДАРТ', 200), 6);
    expect(btn.width).toBeGreaterThan(200);
  });

  it('never shrinks a button below its declared minimum width for a short label', () => {
    const s = new Settings();
    s.show(800, 600, defaultSettingsState());
    // "CONTROLS: STANDARD" easily fits under the 200px minimum given to controlLayoutBtn.
    expect(privateOf(s).controlLayoutBtn.width).toBeCloseTo(200, 0);
  });

  it('keeps the language button centered under the panel midpoint at every locale', () => {
    const s = new Settings();
    s.show(800, 600, defaultSettingsState());
    const btn = privateOf(s).languageBtn;
    const centerOf = () => btn.view.position.x + btn.width / 2;
    expect(centerOf()).toBeCloseTo(CX, 6);

    btn.onTap?.(); // cycles the live locale one step and re-lays-out in the same tap
    expect(centerOf()).toBeCloseTo(CX, 6); // still centered even though the box resized
  });

  it('keeps the control-layout button centered under the panel midpoint at every locale', () => {
    const s = new Settings();
    s.show(800, 600, defaultSettingsState());
    const btn = privateOf(s).controlLayoutBtn;
    const centerOf = () => btn.view.position.x + btn.width / 2;
    expect(centerOf()).toBeCloseTo(CX, 6);

    setLocale('ru');
    s.show(800, 600, { ...defaultSettingsState(), locale: 'ru' });
    btn.onTap?.();
    expect(centerOf()).toBeCloseTo(CX, 6);
  });

  it('lays out mute+back as a fixed-gap pair, centered together, at every width', () => {
    const s = new Settings();
    s.show(800, 600, defaultSettingsState());
    const p = privateOf(s);
    const GAP = 20;

    const assertPairLayout = () => {
      // Back sits immediately after mute with exactly GAP between them...
      expect(p.backBtn.view.position.x).toBeCloseTo(p.muteBtn.view.position.x + p.muteBtn.width + GAP, 6);
      // ...and the pair as a whole is centered under the panel midpoint.
      const pairLeft = p.muteBtn.view.position.x;
      const pairRight = p.backBtn.view.position.x + p.backBtn.width;
      expect((pairLeft + pairRight) / 2).toBeCloseTo(CX, 6);
    };
    assertPairLayout();

    // Toggling to UNMUTE swaps in "ВКЛЮЧИТЬ ЗВУК"-length text (here still English, but
    // exercises the same resize-then-relayout path) — the pair must stay glued together
    // and centered even though muteBtn's width just changed.
    p.muteBtn.onTap?.();
    assertPairLayout();

    setLocale('ru');
    s.show(800, 600, { ...defaultSettingsState(), locale: 'ru' });
    p.muteBtn.onTap?.(); // -> "ВКЛЮЧИТЬ ЗВУК", noticeably longer than "MUTE"/"БЕЗ ЗВУКА"
    expect(p.muteBtn.label.text).toBe('ВКЛЮЧИТЬ ЗВУК');
    expect(p.muteBtn.width).toBeGreaterThan(120);
    assertPairLayout();
  });
});

/**
 * The render-quality button (`render/quality.ts`, 2026-08-25). Two claims worth pinning: the
 * cycle visits every setting and wraps, and `'auto'` reports what it actually RESOLVED to —
 * a player whose phone was downgraded by the frame watchdog must not read "AUTO" on a screen
 * that is visibly running the low tier.
 */
describe('Settings — render quality', () => {
  afterEach(() => {
    resetActiveQuality();
    resetLocaleForTests();
  });

  it('cycles auto -> high -> low -> auto, reporting each pick through onChange', () => {
    const s = new Settings();
    const seen: SettingsState['quality'][] = [];
    s.onChange = (next) => { seen.push(next.quality); s.show(800, 600, next); };
    s.show(800, 600, { ...defaultSettingsState(), quality: 'auto' });
    const p = privateOf(s);
    p.qualityBtn.onTap?.();
    p.qualityBtn.onTap?.();
    p.qualityBtn.onTap?.();
    expect(seen).toEqual(['high', 'low', 'auto']);
  });

  it('labels a pinned tier from the setting alone', () => {
    const s = new Settings();
    const p = privateOf(s);
    s.show(800, 600, { ...defaultSettingsState(), quality: 'high' });
    expect(p.qualityBtn.label.text).toBe('QUALITY: HIGH');
    s.show(800, 600, { ...defaultSettingsState(), quality: 'low' });
    expect(p.qualityBtn.label.text).toBe('QUALITY: LOW');
  });

  it('says AUTO while auto is running high, and AUTO (LOW) once it has dropped', () => {
    const s = new Settings();
    const p = privateOf(s);
    setActiveQuality('high');
    s.show(800, 600, { ...defaultSettingsState(), quality: 'auto' });
    expect(p.qualityBtn.label.text).toBe('QUALITY: AUTO');

    // The watchdog fired. The SETTING is unchanged — only the resolved tier moved, and the
    // button is the only place the player can find that out.
    setActiveQuality('low');
    s.show(800, 600, { ...defaultSettingsState(), quality: 'auto' });
    expect(p.qualityBtn.label.text).toBe('QUALITY: AUTO (LOW)');
  });

  it('stays centred and translated in every locale', () => {
    const s = new Settings();
    const p = privateOf(s);
    for (const loc of LOCALES) {
      setLocale(loc);
      s.show(800, 600, { ...defaultSettingsState(), locale: loc, quality: 'low' });
      expect(p.qualityBtn.label.text, loc).not.toContain('{mode}');
      expect(p.qualityBtn.label.text, loc).not.toBe('settings.quality');
      const centre = p.qualityBtn.view.position.x + p.qualityBtn.width / 2;
      expect(centre, loc).toBeCloseTo(400, 6);
    }
  });
});
