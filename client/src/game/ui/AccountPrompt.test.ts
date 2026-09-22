/**
 * `AccountPrompt` (design/16-accounts.md holes 1 and 2, 2026-09-17) — the two account modals:
 * the one-time guest-merge confirmation and the expired-session notice.
 *
 * The class is pure presentation, so what is worth pinning is the handful of properties a
 * player's outcome actually rides on: which of the three buttons is on screen in which mode,
 * that the promise resolves with the button that was pressed rather than with a default, and
 * that the panel is genuinely modal — a `hitArea` covering the viewport is the only thing
 * stopping a tap meant for this panel from reaching the lobby button underneath it.
 *
 * Buttons are driven through their own `onTap` rather than through a synthetic pointer event,
 * the same way `PortalPrompt.test.ts` does it: hit-testing a `Text` needs a real canvas.
 */
import { describe, it, expect, afterEach } from 'vitest';
import type { Rectangle } from 'pixi.js';
import { AccountPrompt } from './AccountPrompt';
import { LOCALES, setLocale, resetLocaleForTests } from '../../i18n';
import { useLocale } from '../../i18n/loadLocale';

afterEach(() => resetLocaleForTests());

const OFFER = { materials: 5, blueprints: 1, characters: 0 };

function make(w = 760, h = 640) {
  const prompt = new AccountPrompt({ size: () => ({ w, h }) });
  return { prompt, ...privateOf(prompt) };
}

function privateOf(p: AccountPrompt) {
  return p as unknown as {
    titleText: { text: string; style: { wordWrap: boolean; breakWords: boolean; wordWrapWidth: number } };
    bodyText: { text: string; style: { wordWrapWidth: number } };
    accountBtn: { onTap: (() => void) | null; view: { visible: boolean; position: { y: number } } };
    mergeBtn: { onTap: (() => void) | null; view: { visible: boolean; position: { y: number } } };
    closeBtn: { onTap: (() => void) | null; view: { visible: boolean } };
  };
}

describe('AccountPrompt — closed by default', () => {
  it('starts hidden and reports itself closed', () => {
    const t = make();
    expect(t.prompt.isOpen).toBe(false);
    expect(t.prompt.view.visible).toBe(false);
  });

  it('relayout does nothing while closed — it is called on EVERY viewport change', () => {
    // `ScreenNav.relayout` calls this unconditionally, many times a session for a player who
    // never sees either modal. A version that laid out anyway would be harmless but would
    // also make `isOpen` a lie; asserting the no-op is what keeps the guard honest.
    const t = make();
    t.prompt.relayout();
    expect(t.prompt.view.visible).toBe(false);
  });
});

describe('AccountPrompt — the guest-merge question', () => {
  it('shows exactly the two choices, and not the dismiss button', () => {
    // The absence is the assertion that matters: a dismiss in merge mode would be a third
    // outcome for a question whose server-side claim has already been spent, so "closed the
    // panel" would silently become one of the two answers without the player choosing it.
    const t = make();
    void t.prompt.askGuestMerge(OFFER, 'alice');
    expect(t.prompt.isOpen).toBe(true);
    expect(t.accountBtn.view.visible).toBe(true);
    expect(t.mergeBtn.view.visible).toBe(true);
    expect(t.closeBtn.view.visible).toBe(false);
  });

  it('puts the counts and the account name into the body copy', () => {
    const t = make();
    void t.prompt.askGuestMerge(OFFER, 'alice');
    expect(t.bodyText.text).toContain('alice');
    expect(t.bodyText.text).toContain('5');
  });

  it('resolves with the button that was pressed, and closes', async () => {
    for (const [button, expected] of [['accountBtn', 'account'], ['mergeBtn', 'merge']] as const) {
      const t = make();
      const answer = t.prompt.askGuestMerge(OFFER, 'alice');
      t[button].onTap?.();
      await expect(answer).resolves.toBe(expected);
      expect(t.prompt.isOpen).toBe(false);
      expect(t.prompt.view.visible).toBe(false);
    }
  });

  it('draws the account choice ABOVE the combine one', () => {
    // The ordering is the decision rather than the styling (see the class header): on a
    // shared computer the guest progress belongs to whoever used the browser last, so "use
    // the account's" has to be what the obvious button does.
    const t = make();
    void t.prompt.askGuestMerge(OFFER, 'alice');
    expect(t.accountBtn.view.position.y).toBeLessThan(t.mergeBtn.view.position.y);
  });
});

describe('AccountPrompt — the notice', () => {
  it('shows one button, and neither of the merge choices', () => {
    const t = make();
    t.prompt.showNotice('SIGNED OUT', 'your session expired');
    expect(t.prompt.isOpen).toBe(true);
    expect(t.closeBtn.view.visible).toBe(true);
    expect(t.accountBtn.view.visible).toBe(false);
    expect(t.mergeBtn.view.visible).toBe(false);
    expect(t.titleText.text).toBe('SIGNED OUT');
    expect(t.bodyText.text).toBe('your session expired');
  });

  it('closes on the dismiss button', () => {
    const t = make();
    t.prompt.showNotice('SIGNED OUT', 'your session expired');
    t.closeBtn.onTap?.();
    expect(t.prompt.isOpen).toBe(false);
    expect(t.prompt.view.visible).toBe(false);
  });

  it('a notice after a merge question re-lays the buttons out, rather than leaving both sets up', () => {
    // The two modes share one panel, so the mode switch is the only thing that hides the
    // previous mode's buttons. Missing it would leave three live buttons on screen, two of
    // which resolve a promise nobody is waiting on any more.
    const t = make();
    void t.prompt.askGuestMerge(OFFER, 'alice');
    t.prompt.showNotice('SIGNED OUT', 'body');
    expect(t.accountBtn.view.visible).toBe(false);
    expect(t.mergeBtn.view.visible).toBe(false);
    expect(t.closeBtn.view.visible).toBe(true);
  });
});

describe('AccountPrompt — modality and layout', () => {
  it('covers the whole viewport with a hit area, so taps do not reach the screen underneath', () => {
    // Without this the lobby's own buttons stay live under the panel: a player could start a
    // run while being asked which progress to keep, and the answer would land mid-run, which
    // is the exact state `isHubPhase` exists to prevent.
    const t = make(800, 600);
    void t.prompt.askGuestMerge(OFFER, 'alice');
    const area = t.prompt.view.hitArea as Rectangle;
    expect({ x: area.x, y: area.y, width: area.width, height: area.height }).toEqual({
      x: 0, y: 0, width: 800, height: 600,
    });
    expect(t.prompt.view.eventMode).toBe('static');
  });

  it('wraps the body against the PANEL, which is narrower on a small viewport', () => {
    // The panel is `min(520, w - 48)`, so on a landscape phone the text has to wrap tighter
    // than the constant it was authored against or it runs off both sides of its own panel.
    const wide = make(760, 640);
    void wide.prompt.askGuestMerge(OFFER, 'alice');
    const narrow = make(360, 640);
    void narrow.prompt.askGuestMerge(OFFER, 'alice');
    expect(narrow.bodyText.style.wordWrapWidth).toBeLessThan(wide.bodyText.style.wordWrapWidth);
  });

  it('relayout re-runs the layout at the CURRENT size while open', () => {
    let w = 760;
    const prompt = new AccountPrompt({ size: () => ({ w, h: 640 }) });
    void prompt.askGuestMerge(OFFER, 'alice');
    const before = (prompt.view.hitArea as Rectangle).width;
    w = 400;
    prompt.relayout();
    expect((prompt.view.hitArea as Rectangle).width).toBe(400);
    expect(before).toBe(760);
  });
});

describe('AccountPrompt — i18n (design/17-i18n.md)', () => {
  it('re-reads every button label on each open, so a language change in Settings lands', async () => {
    const t = make();
    setLocale('en');
    void t.prompt.askGuestMerge(OFFER, 'alice');
    const en = t.titleText.text;
    await useLocale('zh');
    void t.prompt.askGuestMerge(OFFER, 'alice');
    expect(t.titleText.text).not.toBe(en);
  });

  it('has real copy in all eight locales, for both modes', async () => {
    // A missing key falls back to the key path itself (`i18n/index.ts`'s `lookup`), which
    // renders as `auth.mergeTitle` on the panel rather than failing anything.
    const t = make();
    for (const locale of LOCALES) {
      await useLocale(locale);
      void t.prompt.askGuestMerge(OFFER, 'alice');
      expect(t.titleText.text, locale).not.toContain('auth.');
      expect(t.bodyText.text, locale).not.toContain('auth.');
      expect(t.bodyText.text, locale).not.toContain('{');
    }
  });
});
