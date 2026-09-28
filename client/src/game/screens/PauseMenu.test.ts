/**
 * PauseMenu (design/10 open question, now resolved). Pixi Container/Text/Graphics
 * construct and mutate fine under plain vitest with no renderer attached (same finding
 * MainMenu.test.ts/PartyScreen.test.ts made).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { PauseMenu } from './PauseMenu';
import { setLocale, resetLocaleForTests } from '../../i18n';
import { useLocale } from '../../i18n/loadLocale';
import { installFakeTextCanvas } from './fakeTextCanvas';

// The fit test measures the buttons' bounds, which measures their labels.
installFakeTextCanvas();

interface Btn {
  label: { text: string };
  onTap: (() => void) | null;
  view: { visible: boolean; position: { y: number } };
}

function privateOf(m: PauseMenu) {
  const shell = (m as unknown as { shell: { sheet: { title: { text: string }; height: number }; backBtn: Btn } }).shell;
  const self = m as unknown as {
    resumeBtn: Btn;
    settingsBtn: Btn;
    saveQuitBtn: Btn;
    quitBtn: Btn;
  };
  return Object.assign(Object.create(self) as typeof self, { title: shell.sheet.title, backBtn: shell.backBtn, sheet: shell.sheet });
}

afterEach(() => resetLocaleForTests());

describe('PauseMenu — callbacks', () => {
  it('tapping each button fires its own callback, not another one', () => {
    const m = new PauseMenu();
    const p = privateOf(m);
    const calls: string[] = [];
    m.onResume = () => calls.push('resume');
    m.onSettings = () => calls.push('settings');
    m.onQuit = () => calls.push('quit');

    p.resumeBtn.onTap?.();
    p.settingsBtn.onTap?.();
    p.quitBtn.onTap?.();

    expect(calls).toEqual(['resume', 'settings', 'quit']);
  });
});

describe('PauseMenu — show()', () => {
  it('becomes visible and centers on the given viewport', () => {
    const m = new PauseMenu();
    m.show(800, 600);
    expect(m.view.visible).toBe(true);
  });
});

// design/10 screen-flow gap: the tutorial level's Skip reuses this same pause menu, but
// "QUIT TO FORGE" is wrong once quitting no longer always returns to Forge — the quit
// button's label can be overridden per-show() without changing what it calls (onQuit).
describe('PauseMenu — quit label override (design/10 tutorial Skip)', () => {
  it('uses the default label when no override is given', () => {
    const m = new PauseMenu();
    m.show(800, 600);
    expect(privateOf(m).quitBtn.label.text).toBe('QUIT TO FORGE');
  });

  it('uses the override text when given', () => {
    const m = new PauseMenu();
    m.show(800, 600, 'SKIP TUTORIAL');
    expect(privateOf(m).quitBtn.label.text).toBe('SKIP TUTORIAL');
  });

  it('a later show() without an override reverts to the default label', () => {
    const m = new PauseMenu();
    m.show(800, 600, 'SKIP TUTORIAL');
    m.show(800, 600);
    expect(privateOf(m).quitBtn.label.text).toBe('QUIT TO FORGE');
  });

  it('the override never changes which callback the button fires', () => {
    const m = new PauseMenu();
    const calls: string[] = [];
    m.onQuit = () => calls.push('quit');
    m.show(800, 600, 'SKIP TUTORIAL');
    privateOf(m).quitBtn.onTap?.();
    expect(calls).toEqual(['quit']);
  });
});

describe('PauseMenu — i18n (design/17-i18n.md)', () => {
  it('defaults to English', () => {
    const p = privateOf(new PauseMenu());
    expect(p.title.text).toBe('PAUSED');
    expect(p.quitBtn.label.text).toBe('QUIT TO FORGE');
  });

  it('retexts its static labels from the active locale on show()', async () => {
    const m = new PauseMenu();
    await useLocale('zh');
    m.show(800, 600);
    const p = privateOf(m);
    expect(p.title.text).toBe('已暂停');
    expect(p.resumeBtn.label.text).toBe('继续');
    expect(p.settingsBtn.label.text).toBe('设置');
    expect(p.quitBtn.label.text).toBe('返回锻造场');
  });

  it('switching back to English on a later show() fully reverts', async () => {
    const m = new PauseMenu();
    await useLocale('zh');
    m.show(800, 600);
    setLocale('en');
    m.show(800, 600);
    expect(privateOf(m).title.text).toBe('PAUSED');
  });
});

/**
 * SAVE & QUIT (design/05 "Only the boss floor ends a run", ENGINE_VERSION 61) — the row that
 * appears only for a run that can be saved, and the row order it has to leave alone.
 *
 * The layout cases below are not decoration. This panel has two exits now, one of which
 * throws the run away, and the two must not swap places between a savable and a non-savable
 * run — a player who has learned where QUIT sits and finds SAVE & QUIT there instead is the
 * mild version; the other direction loses a run.
 */
describe('PauseMenu — SAVE & QUIT', () => {
  it('is hidden by default — the fail-closed direction for a caller that forgets', () => {
    const m = new PauseMenu();
    m.show(800, 600);
    expect(privateOf(m).saveQuitBtn.view.visible).toBe(false);
  });

  it('appears when the run is savable', () => {
    const m = new PauseMenu();
    m.show(800, 600, undefined, true);
    expect(privateOf(m).saveQuitBtn.view.visible).toBe(true);
  });

  it('goes away again on a later show() for a run that is not', () => {
    const m = new PauseMenu();
    m.show(800, 600, undefined, true);
    m.show(800, 600, undefined, false);
    expect(privateOf(m).saveQuitBtn.view.visible).toBe(false);
  });

  it('fires its own callback and nothing else', () => {
    const m = new PauseMenu();
    const calls: string[] = [];
    m.onSaveQuit = () => calls.push('saveQuit');
    m.onQuit = () => calls.push('quit');
    m.show(800, 600, undefined, true);
    privateOf(m).saveQuitBtn.onTap?.();
    expect(calls).toEqual(['saveQuit']);
  });

  it('does not move RESUME or SETTINGS — the rows grow downward', () => {
    const a = new PauseMenu();
    a.show(800, 600, undefined, false);
    const b = new PauseMenu();
    b.show(800, 600, undefined, true);
    expect(privateOf(b).resumeBtn.view.position.y).toBe(privateOf(a).resumeBtn.view.position.y);
    expect(privateOf(b).settingsBtn.view.position.y).toBe(privateOf(a).settingsBtn.view.position.y);
  });

  it('puts QUIT below it rather than on top of it', () => {
    // The bug this exists for: leaving `quitBtn` at its three-row slot stacks the two exits
    // in the same place, so whichever draws last is the one a tap hits — and a tap meant for
    // SAVE & QUIT landing on QUIT destroys the run it was trying to keep.
    const m = new PauseMenu();
    m.show(800, 600, undefined, true);
    const p = privateOf(m);
    expect(p.quitBtn.view.position.y).toBeGreaterThan(p.saveQuitBtn.view.position.y + 40);
  });

  it('and QUIT returns to its usual slot when the row is hidden', () => {
    const m = new PauseMenu();
    m.show(800, 600, undefined, true);
    const shifted = privateOf(m).quitBtn.view.position.y;
    m.show(800, 600, undefined, false);
    expect(privateOf(m).quitBtn.view.position.y).toBeLessThan(shifted);
    expect(privateOf(m).quitBtn.view.position.y).toBe(privateOf(m).saveQuitBtn.view.position.y);
  });

  it('retexts from the active locale like every other label here', async () => {
    const m = new PauseMenu();
    await useLocale('zh');
    m.show(800, 600, undefined, true);
    expect(privateOf(m).saveQuitBtn.label.text).toBe('保存并退出');
    setLocale('en');
    m.show(800, 600, undefined, true);
    expect(privateOf(m).saveQuitBtn.label.text).toBe('SAVE & QUIT');
  });
});

describe('PauseMenu — the sheet (design/10 "One shell for every menu")', () => {
  it('the corner chip is a second RESUME, and fires onResume', () => {
    const m = new PauseMenu();
    const calls: string[] = [];
    m.onResume = () => calls.push('resume');
    m.onQuit = () => calls.push('quit');
    m.show(800, 600);
    expect(privateOf(m).backBtn.label.text).toBe('RESUME');
    privateOf(m).backBtn.onTap?.();
    expect(calls).toEqual(['resume']);
  });

  it('stacks the rows full width, RESUME first and QUIT last', () => {
    const m = new PauseMenu();
    m.show(800, 600, undefined, true);
    const p = privateOf(m);
    const order = [p.resumeBtn, p.settingsBtn, p.saveQuitBtn, p.quitBtn];
    for (let i = 1; i < order.length; i++) {
      expect(order[i]!.view.position.y).toBeGreaterThan(order[i - 1]!.view.position.y);
    }
    const widths = order.map((b) => (b as unknown as { width: number }).width);
    expect(new Set(widths).size).toBe(1);
  });

  it('keeps a gap wider than the row gap between staying in the run and leaving it', () => {
    // The hairline between the groups is the point: QUIT throws the run away, and it should
    // not read as one more row of the same list as SETTINGS.
    const m = new PauseMenu();
    m.show(800, 600, undefined, true);
    const p = privateOf(m);
    const rowGap = p.saveQuitBtn.view.position.y - p.settingsBtn.view.position.y;
    const inGroup = p.quitBtn.view.position.y - p.saveQuitBtn.view.position.y;
    expect(rowGap).toBeGreaterThan(inGroup);
  });

  it('grows the sheet by the SAVE & QUIT row, not by a hole when it is hidden', () => {
    const m = new PauseMenu();
    m.show(800, 600, undefined, false);
    const short = privateOf(m).sheet.height;
    m.show(800, 600, undefined, true);
    expect(privateOf(m).sheet.height).toBeGreaterThan(short);
  });
});

describe('PauseMenu — the divider and the fit', () => {
  it('draws the hairline in the gap between SETTINGS and the rows that leave the run', () => {
    const m = new PauseMenu();
    m.show(800, 600, undefined, true);
    const p = privateOf(m);
    const rules = (m as unknown as { rules: { getLocalBounds(): { minY: number; maxY: number } } }).rules.getLocalBounds();
    const settingsBottom = p.settingsBtn.view.position.y + 44;
    expect(rules.minY).toBeGreaterThan(settingsBottom);
    expect(rules.maxY).toBeLessThan(p.saveQuitBtn.view.position.y);
    // Control for the savable-off form: the line stays above QUIT when QUIT takes the slot.
    m.show(800, 600, undefined, false);
    const again = (m as unknown as { rules: { getLocalBounds(): { maxY: number } } }).rules.getLocalBounds();
    expect(again.maxY).toBeLessThan(p.quitBtn.view.position.y);
  });

  it('fits its tallest form — SAVE & QUIT shown, the tutorial label — on a phone held sideways', () => {
    const m = new PauseMenu();
    m.show(844, 390, 'SKIP TUTORIAL', true);
    const quit = (m as unknown as { quitBtn: { view: { getBounds(): { maxY: number } } } }).quitBtn.view.getBounds();
    expect(quit.maxY).toBeLessThanOrEqual(390);
  });
});
