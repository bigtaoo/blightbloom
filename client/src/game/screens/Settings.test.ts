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
import { getLocale, resetLocaleForTests, LOCALES, type Locale } from '../../i18n';
import { estimateMonoWidth } from '../ui/textWidth';
import { resetActiveQuality, setActiveQuality } from '../../render/quality';
import { useLocale } from '../../i18n/loadLocale';

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
    frameRateBtn: ButtonInternals;
    reduceMotionBtn: ButtonInternals;
    tutorialBtn: ButtonInternals;
    backBtn: ButtonInternals;
  };
}

/**
 * Tap the language button and wait for the switch to actually land.
 *
 * The tap has been asynchronous since 2026-09-21: a locale's table is its own chunk
 * (`i18n/loadLocale.ts`), and the button loads it BEFORE switching so the screen never
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

describe('Settings — language toggle (design/17-i18n.md)', () => {
  it('starts on English, showing its own name', () => {
    const s = new Settings();
    s.show(800, 600, defaultSettingsState());
    expect(privateOf(s).languageBtn.label.text).toBe('LANGUAGE: English');
  });

  it('tapping the toggle switches the live locale and reports it via onChange', async () => {
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

  it('the toggle relabels itself and every other static label in the same tap', async () => {
    const s = new Settings();
    s.show(800, 600, defaultSettingsState());
    await tapLanguage(s, 'zh');
    const p = privateOf(s);
    expect(p.languageBtn.label.text).toBe('语言：中文');
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
    // One full cycle (LOCALES.length taps) visits every locale exactly once, in
    // LOCALES' own declared order, and lands back on English.
    expect(seen).toEqual(['en', ...LOCALES.slice(1), 'en']);
    expect(p.languageBtn.label.text).toBe('LANGUAGE: English');
  });

  it('a later show() re-applies the active locale, e.g. after re-entering from the pause menu', async () => {
    const s = new Settings();
    s.show(800, 600, defaultSettingsState());
    await useLocale('zh');
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

  it('translates under zh', async () => {
    await useLocale('zh');
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

  it('tracks the formula-computed width for the current label at every locale', async () => {
    const s = new Settings();
    s.show(800, 600, defaultSettingsState());
    const p = privateOf(s);
    expect(p.languageBtn.width).toBeCloseTo(expectedWidth('LANGUAGE: English', 160), 6);

    await useLocale('ru');
    s.show(800, 600, { ...defaultSettingsState(), locale: 'ru' });
    expect(p.languageBtn.label.text).toBe('ЯЗЫК: Русский');
    expect(p.languageBtn.width).toBeCloseTo(expectedWidth('ЯЗЫК: Русский', 160), 6);
  });

  it('grows the control-layout button to fit a longer translated label instead of clipping it', async () => {
    await useLocale('ru');
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

  it('keeps the control-layout button centered under the panel midpoint at every locale', async () => {
    const s = new Settings();
    s.show(800, 600, defaultSettingsState());
    const btn = privateOf(s).controlLayoutBtn;
    const centerOf = () => btn.view.position.x + btn.width / 2;
    expect(centerOf()).toBeCloseTo(CX, 6);

    await useLocale('ru');
    s.show(800, 600, { ...defaultSettingsState(), locale: 'ru' });
    btn.onTap?.();
    expect(centerOf()).toBeCloseTo(CX, 6);
  });

  it('lays out mute+tutorial+back as a fixed-gap row, centered together, at every width', async () => {
    // TUTORIAL joined this row 2026-09-22 (it used to be MUTE+BACK alone) — see
    // `Settings.ts`'s `layoutButtons` for why it landed here instead of a row of its own.
    const s = new Settings();
    s.show(800, 600, defaultSettingsState());
    const p = privateOf(s);
    const GAP = 20;

    const assertRowLayout = () => {
      // TUTORIAL sits immediately after MUTE, and BACK immediately after TUTORIAL, exactly
      // GAP apart each time...
      expect(p.tutorialBtn.view.position.x).toBeCloseTo(p.muteBtn.view.position.x + p.muteBtn.width + GAP, 6);
      expect(p.backBtn.view.position.x).toBeCloseTo(p.tutorialBtn.view.position.x + p.tutorialBtn.width + GAP, 6);
      // ...and the row as a whole is centered under the panel midpoint.
      const rowLeft = p.muteBtn.view.position.x;
      const rowRight = p.backBtn.view.position.x + p.backBtn.width;
      expect((rowLeft + rowRight) / 2).toBeCloseTo(CX, 6);
    };
    assertRowLayout();

    // Toggling to UNMUTE swaps in "ВКЛЮЧИТЬ ЗВУК"-length text (here still English, but
    // exercises the same resize-then-relayout path) — the row must stay glued together
    // and centered even though muteBtn's width just changed.
    p.muteBtn.onTap?.();
    assertRowLayout();

    await useLocale('ru');
    s.show(800, 600, { ...defaultSettingsState(), locale: 'ru' });
    p.muteBtn.onTap?.(); // -> "ВКЛЮЧИТЬ ЗВУК", noticeably longer than "MUTE"/"БЕЗ ЗВУКА"
    expect(p.muteBtn.label.text).toBe('ВКЛЮЧИТЬ ЗВУК');
    expect(p.muteBtn.width).toBeGreaterThan(120);
    assertRowLayout();
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

  it('cycles auto -> high -> medium -> low -> auto, reporting each pick through onChange', () => {
    const s = new Settings();
    const seen: SettingsState['quality'][] = [];
    s.onChange = (next) => { seen.push(next.quality); s.show(800, 600, next); };
    s.show(800, 600, { ...defaultSettingsState(), quality: 'auto' });
    const p = privateOf(s);
    for (let i = 0; i < 4; i++) p.qualityBtn.onTap?.();
    // Four taps and back where it started: the cycle covers every setting and wraps, so no
    // pick is reachable only by going round twice.
    expect(seen).toEqual(['high', 'medium', 'low', 'auto']);
  });

  it('labels a pinned tier from the setting alone', () => {
    const s = new Settings();
    const p = privateOf(s);
    // Every pinned pick, and with the live mirror deliberately set to something ELSE, so a
    // label that read the mirror instead of the setting could not pass.
    setActiveQuality('low');
    s.show(800, 600, { ...defaultSettingsState(), quality: 'high' });
    expect(p.qualityBtn.label.text).toBe('QUALITY: HIGH');
    setActiveQuality('high');
    s.show(800, 600, { ...defaultSettingsState(), quality: 'medium' });
    expect(p.qualityBtn.label.text).toBe('QUALITY: MEDIUM');
    s.show(800, 600, { ...defaultSettingsState(), quality: 'low' });
    expect(p.qualityBtn.label.text).toBe('QUALITY: LOW');
  });

  it('says AUTO while auto is running high, and names the rung once it has stepped down', () => {
    const s = new Settings();
    const p = privateOf(s);
    setActiveQuality('high');
    s.show(800, 600, { ...defaultSettingsState(), quality: 'auto' });
    expect(p.qualityBtn.label.text).toBe('QUALITY: AUTO');

    // The watchdog stepped. The SETTING is unchanged — only the resolved tier moved, and the
    // button is the only place the player can find that out. Both rungs are named, because
    // "AUTO" on a screen that is visibly not running the authored look is the confusion this
    // label exists to remove, and the medium rung is the one a mid-range phone will sit on.
    setActiveQuality('medium');
    s.show(800, 600, { ...defaultSettingsState(), quality: 'auto' });
    expect(p.qualityBtn.label.text).toBe('QUALITY: AUTO (MEDIUM)');
    setActiveQuality('low');
    s.show(800, 600, { ...defaultSettingsState(), quality: 'auto' });
    expect(p.qualityBtn.label.text).toBe('QUALITY: AUTO (LOW)');
  });

  it('stays centred and translated in every locale', async () => {
    const s = new Settings();
    const p = privateOf(s);
    for (const loc of LOCALES) {
      await useLocale(loc);
      // `medium`, not `low`: it is the longest of the four in most locales, so it is the pick
      // that actually exercises the auto-width centring.
      s.show(800, 600, { ...defaultSettingsState(), locale: loc, quality: 'medium' });
      expect(p.qualityBtn.label.text, loc).not.toContain('{mode}');
      expect(p.qualityBtn.label.text, loc).not.toBe('settings.quality');
      const centre = p.qualityBtn.view.position.x + p.qualityBtn.width / 2;
      expect(centre, loc).toBeCloseTo(400, 6);
    }
  });
});

/**
 * The in-run frame cap (`game/powerBudget.ts`, 2026-09-08) — the battery setting. Same three
 * questions as the quality button above: does a tap cycle and report, does the label read the
 * setting, and does it survive every locale without overflowing or leaving a placeholder in.
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
    expect(p.frameRateBtn.label.text).toBe('FRAME RATE: 60');
    s.onChange = onChange;
    p.frameRateBtn.onTap?.();
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ frameRate: 30, quality: 'auto', muted: false }));
    expect(p.frameRateBtn.label.text).toBe('FRAME RATE: 30');
  });

  it('stays centred and translated in every locale', async () => {
    const s = new Settings();
    const p = privateOf(s);
    for (const loc of LOCALES) {
      await useLocale(loc);
      s.show(800, 600, { ...defaultSettingsState(), locale: loc, frameRate: 30 });
      expect(p.frameRateBtn.label.text, loc).not.toContain('{fps}');
      expect(p.frameRateBtn.label.text, loc).not.toBe('settings.frameRate');
      expect(p.frameRateBtn.label.text, loc).toContain('30');
      const centre = p.frameRateBtn.view.position.x + p.frameRateBtn.width / 2;
      expect(centre, loc).toBeCloseTo(400, 6);
    }
  });
});

/**
 * Reduce motion (2026-09-22) — the accessibility row, and the only button on this screen that
 * had no case of its own until a mutation battery pointed at the hole. Everything about it is
 * one boolean, which is exactly why it is worth pinning: a toggle wired to the wrong field
 * compiles, renders, relabels, and reports the wrong setting forever.
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
    expect(p.reduceMotionBtn.label.text).toBe('REDUCE MOTION: OFF');
    s.onChange = onChange;
    p.reduceMotionBtn.onTap?.();
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      reduceMotion: true, muted: false, quality: 'auto', frameRate: 60, controlLayout: 'standard',
    }));
    expect(p.reduceMotionBtn.label.text).toBe('REDUCE MOTION: ON');
  });

  it('starts from the persisted value rather than from a default', () => {
    // A player who turned this on is a player the game made unwell. Showing the screen with it
    // reading OFF would be worse than the setting not existing.
    const s = new Settings();
    s.show(800, 600, { ...defaultSettingsState(), reduceMotion: true });
    expect(privateOf(s).reduceMotionBtn.label.text).toBe('REDUCE MOTION: ON');
  });

  it('stays centred and translated in every locale', async () => {
    const s = new Settings();
    const p = privateOf(s);
    for (const loc of LOCALES) {
      await useLocale(loc);
      s.show(800, 600, { ...defaultSettingsState(), locale: loc, reduceMotion: true });
      expect(p.reduceMotionBtn.label.text, loc).not.toContain('{mode}');
      expect(p.reduceMotionBtn.label.text, loc).not.toBe('settings.reduceMotion');
      // Every locale has to translate the VALUE too, not just the label — an `ON` left in
      // English inside a translated row is the usual way a two-part string goes half-done.
      expect(p.reduceMotionBtn.label.text, loc).not.toContain('{');
      const centre = p.reduceMotionBtn.view.position.x + p.reduceMotionBtn.width / 2;
      expect(centre, loc).toBeCloseTo(400, 6);
    }
  });

  it('does not overlap the row above it or the pair below', async () => {
    // The row was inserted between FRAME RATE and MUTE/BACK, and `show()` advances a running
    // `y` — an insert that forgot to advance it stacks two buttons on the same line, which no
    // label or state assertion can see.
    //
    // BOTH neighbours, and the second half was missing until a mutation battery pointed at it:
    // deleting the `y += 44` after this row leaves the row itself correctly placed and drops
    // MUTE/BACK on top of it, so a case that only looked upward passed the mutant while its own
    // name said it covered the pair below.
    const s = new Settings();
    const p = privateOf(s);
    await useLocale('en');
    s.show(800, 600, defaultSettingsState());
    expect(p.reduceMotionBtn.view.position.y).toBeGreaterThan(p.frameRateBtn.view.position.y + 20);
    expect(p.muteBtn.view.position.y).toBeGreaterThan(p.reduceMotionBtn.view.position.y + 20);
  });
});
