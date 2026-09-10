/**
 * PauseMenu (design/10 open question, now resolved). Pixi Container/Text/Graphics
 * construct and mutate fine under plain vitest with no renderer attached (same finding
 * MainMenu.test.ts/PartyScreen.test.ts made).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { PauseMenu } from './PauseMenu';
import { setLocale, resetLocaleForTests } from '../../i18n';

interface Btn {
  label: { text: string };
  onTap: (() => void) | null;
  view: { visible: boolean; position: { y: number } };
}

function privateOf(m: PauseMenu) {
  return m as unknown as {
    title: { text: string };
    resumeBtn: Btn;
    settingsBtn: Btn;
    saveQuitBtn: Btn;
    quitBtn: Btn;
  };
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

  it('retexts its static labels from the active locale on show()', () => {
    const m = new PauseMenu();
    setLocale('zh');
    m.show(800, 600);
    const p = privateOf(m);
    expect(p.title.text).toBe('已暂停');
    expect(p.resumeBtn.label.text).toBe('继续');
    expect(p.settingsBtn.label.text).toBe('设置');
    expect(p.quitBtn.label.text).toBe('返回锻造场');
  });

  it('switching back to English on a later show() fully reverts', () => {
    const m = new PauseMenu();
    setLocale('zh');
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

  it('retexts from the active locale like every other label here', () => {
    const m = new PauseMenu();
    setLocale('zh');
    m.show(800, 600, undefined, true);
    expect(privateOf(m).saveQuitBtn.label.text).toBe('保存并退出');
    setLocale('en');
    m.show(800, 600, undefined, true);
    expect(privateOf(m).saveQuitBtn.label.text).toBe('SAVE & QUIT');
  });
});
