/**
 * TextInputOverlay (design/05/15's party room-code field, design/16-accounts.md's
 * login/password fields). This project has no jsdom/happy-dom environment configured
 * (plain vitest — see net/transport.test.ts's own `FakeWebSocket` for the same
 * convention), so `document` is faked here with just the small, fixed surface this
 * class actually touches: `createElement`, `body.appendChild`, and an element with
 * `addEventListener`/`focus`/`remove`/`style`/`value`.
 *
 * The FakeInput's `remove()` deliberately mirrors a REAL browser's behavior of firing a
 * synchronous 'blur' event when a focused element is removed from the DOM — that's the
 * exact mechanic the blur-teardown fix below has to guard against re-triggering itself
 * (Enter/Escape/`close()` must not ALSO fire a duplicate `onCancel` via their own
 * `.remove()` call's synthetic blur).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { TextInputOverlay } from './TextInputOverlay';

type Listener = (e: unknown) => void;

class FakeInput {
  type = '';
  placeholder = '';
  maxLength = 0;
  autocapitalize = '';
  autocomplete = '';
  // Both are the `numeric` option's keypad hints, and both start empty so a test can tell
  // "never set" from "set to something" — a default of 'numeric' would make the converse
  // case below pass against an implementation that hard-wires the flag on.
  inputMode = '';
  pattern = '';
  spellcheck = false;
  style: Record<string, string> = {};
  value = '';
  focused = false;
  removed = false;
  private readonly listeners: Record<string, Listener[]> = {};

  addEventListener(type: string, fn: Listener): void {
    (this.listeners[type] ??= []).push(fn);
  }
  focus(): void {
    this.focused = true;
  }
  remove(): void {
    this.removed = true;
    // Real browsers fire a synchronous 'blur' when a focused element leaves the DOM.
    if (this.focused) {
      this.focused = false;
      this.fire('blur', {});
    }
  }
  fire(type: string, ev: unknown): void {
    for (const fn of [...(this.listeners[type] ?? [])]) fn(ev);
  }
  keydown(key: string): void {
    this.fire('keydown', { key, stopPropagation: () => {} });
  }
}

function stubDom(): { appended: FakeInput[] } {
  const appended: FakeInput[] = [];
  vi.stubGlobal('document', {
    createElement: () => new FakeInput(),
    body: { appendChild: (el: FakeInput) => appended.push(el) },
  });
  return { appended };
}

afterEach(() => vi.unstubAllGlobals());

describe('TextInputOverlay — submit / cancel (existing behavior, unaffected by the blur fix)', () => {
  it('Enter submits the typed value and closes, without a duplicate onCancel from remove()\'s own blur', () => {
    const { appended } = stubDom();
    const overlay = new TextInputOverlay();
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    overlay.open({ onSubmit, onCancel });
    const el = appended[0]!;
    el.value = 'ABCDE';
    el.keydown('Enter');

    expect(onSubmit).toHaveBeenCalledWith('ABCDE');
    expect(onCancel).not.toHaveBeenCalled();
    expect(overlay.isOpen).toBe(false);
    expect(el.removed).toBe(true);
  });

  it('Escape cancels and closes, without a duplicate onCancel from remove()\'s own blur', () => {
    const { appended } = stubDom();
    const overlay = new TextInputOverlay();
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    overlay.open({ onSubmit, onCancel });
    appended[0]!.keydown('Escape');

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(overlay.isOpen).toBe(false);
  });
});

describe('TextInputOverlay — blur teardown (previously documented but not implemented)', () => {
  it('a genuine external blur (e.g. tapping a Pixi button underneath) closes the overlay and fires onCancel', () => {
    const { appended } = stubDom();
    const overlay = new TextInputOverlay();
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    overlay.open({ onSubmit, onCancel });
    const el = appended[0]!;
    el.focused = true; // open() already focused it; explicit for clarity

    el.fire('blur', {}); // simulates the browser blurring it as focus moves elsewhere

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(overlay.isOpen).toBe(false);
    expect(el.removed).toBe(true);
  });

  it('never submits the typed value on blur — only a real Enter does', () => {
    const { appended } = stubDom();
    const overlay = new TextInputOverlay();
    const onSubmit = vi.fn();
    overlay.open({ onSubmit });
    const el = appended[0]!;
    el.value = 'partial';
    el.fire('blur', {});
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('close() called explicitly by a caller does not double-fire onCancel via its own blur', () => {
    const { appended } = stubDom();
    const overlay = new TextInputOverlay();
    const onCancel = vi.fn();
    overlay.open({ onSubmit: vi.fn(), onCancel });
    overlay.close();
    expect(onCancel).not.toHaveBeenCalled(); // close() is a plain teardown, not itself a "cancel"
    expect(appended[0]!.removed).toBe(true);
  });

  it('a blur firing AFTER the overlay was already closed some other way is inert (no crash, no second onCancel)', () => {
    const { appended } = stubDom();
    const overlay = new TextInputOverlay();
    const onCancel = vi.fn();
    overlay.open({ onSubmit: vi.fn(), onCancel });
    const el = appended[0]!;
    overlay.close();
    expect(() => el.fire('blur', {})).not.toThrow();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('opening a second overlay while one is already open tears down the first without its stale blur firing onCancel on the new one', () => {
    const { appended } = stubDom();
    const overlay = new TextInputOverlay();
    const onCancel1 = vi.fn();
    const onCancel2 = vi.fn();
    overlay.open({ onSubmit: vi.fn(), onCancel: onCancel1 });
    overlay.open({ onSubmit: vi.fn(), onCancel: onCancel2 }); // open() itself calls close() first
    expect(onCancel1).not.toHaveBeenCalled();
    expect(onCancel2).not.toHaveBeenCalled();
    expect(appended).toHaveLength(2);
    expect(appended[0]!.removed).toBe(true);
  });
});

/**
 * The `password` option, which had no test of any kind until 2026-09-17 — the flag was
 * declared, documented, passed by `LoginScreen` and asserted nowhere. Deleting the word
 * `password` from either side left 4000+ green tests and a player's password rendered in
 * plain text on a screen someone else may be looking at.
 *
 * Three attributes, not one, because each fails differently: `type` is the masking itself,
 * `autocapitalize` would otherwise upper-case a typed password (the join-code default this
 * class was built for), and `autocomplete` is what lets a password manager fill the field
 * instead of the player typing a long secret by hand on a phone.
 */
describe('TextInputOverlay — the password field', () => {
  it('masks the input, and turns off the join-code text handling around it', () => {
    const { appended } = stubDom();
    new TextInputOverlay().open({ password: true, onSubmit: vi.fn() });
    const el = appended[0]!;
    expect(el.type).toBe('password');
    expect(el.autocapitalize).toBe('off');
    expect(el.autocomplete).toBe('current-password');
  });

  it('leaves an ordinary field unmasked — the converse, so the flag cannot be hard-wired on', () => {
    const { appended } = stubDom();
    new TextInputOverlay().open({ onSubmit: vi.fn() });
    const el = appended[0]!;
    expect(el.type).toBe('text');
    expect(el.autocapitalize).toBe('characters');
    expect(el.autocomplete).toBe('off');
  });

  it('still submits the REAL typed value, not the mask', () => {
    // Masking is a render decision of the browser's. A test that only read `type` would
    // pass against an implementation that also mangled what the player typed.
    const { appended } = stubDom();
    const onSubmit = vi.fn();
    new TextInputOverlay().open({ password: true, maxLength: 64, onSubmit });
    const el = appended[0]!;
    expect(el.maxLength).toBe(64);
    el.value = 'hunter22';
    el.keydown('Enter');
    expect(onSubmit).toHaveBeenCalledWith('hunter22');
  });
});

/**
 * The `numeric` option — the room code became six digits on 2026-09-21
 * (`server/src/routes/party.ts`), which is the shape this field now has to produce.
 *
 * Each of the three things it sets fails differently, so each is asserted separately:
 * `inputMode` is what makes a phone show a keypad instead of a full keyboard, `pattern` is
 * what stops iOS Safari ignoring `inputMode` on a `type="text"` field, and the `input`
 * listener is the only one of the three that ENFORCES anything — both attributes are hints
 * that a hardware keyboard, an IME or a paste walks straight past.
 */
describe('TextInputOverlay — the numeric room-code field', () => {
  it('asks for a numeric keypad without using type=number', () => {
    // `type="number"` is the tempting shortcut and it is wrong here twice over: it strips a
    // leading zero, which `004271` needs, and it draws spinner arrows on a field that is not
    // a quantity.
    const { appended } = stubDom();
    new TextInputOverlay().open({ numeric: true, maxLength: 6, onSubmit: vi.fn() });
    const el = appended[0]!;
    expect(el.type).toBe('text');
    expect(el.inputMode).toBe('numeric');
    expect(el.pattern).toBe('[0-9]*');
    expect(el.maxLength).toBe(6);
    expect(el.autocapitalize).toBe('off'); // nothing to capitalize, and it would fight the keypad
  });

  it('leaves an ordinary field alone — the converse, so the flag cannot be hard-wired on', () => {
    const { appended } = stubDom();
    new TextInputOverlay().open({ onSubmit: vi.fn() });
    const el = appended[0]!;
    expect(el.inputMode).toBe('');
    expect(el.pattern).toBe('');
  });

  it('strips every non-digit as typed, including a pasted code with separators', () => {
    const { appended } = stubDom();
    new TextInputOverlay().open({ numeric: true, onSubmit: vi.fn() });
    const el = appended[0]!;
    for (const [typed, kept] of [
      ['4', '4'],
      ['abc', ''],
      ['12-34 56', '123456'],
      ['CODE: 004271', '004271'],
      ['一二三', ''], // an IME's output is not a digit either
    ] as const) {
      el.value = typed;
      el.fire('input', {});
      expect(el.value).toBe(kept);
    }
  });

  it('keeps a leading zero — 004271 is a code the server can mint', () => {
    const { appended } = stubDom();
    const onSubmit = vi.fn();
    new TextInputOverlay().open({ numeric: true, onSubmit });
    const el = appended[0]!;
    el.value = '004271';
    el.fire('input', {});
    expect(el.value).toBe('004271');
    el.keydown('Enter');
    expect(onSubmit).toHaveBeenCalledWith('004271');
  });

  it('supersedes `uppercase` rather than fighting it over the same value', () => {
    // Both listeners write `input.value` on the same event. With `numeric` winning there is
    // one writer; passing both must not resurrect the second.
    const { appended } = stubDom();
    new TextInputOverlay().open({ numeric: true, uppercase: true, onSubmit: vi.fn() });
    const el = appended[0]!;
    el.value = 'a1b2c3';
    el.fire('input', {});
    expect(el.value).toBe('123');
  });

  it('still up-cases when only `uppercase` is asked for — the option is not dead', () => {
    const { appended } = stubDom();
    new TextInputOverlay().open({ uppercase: true, onSubmit: vi.fn() });
    const el = appended[0]!;
    el.value = 'abc12';
    el.fire('input', {});
    expect(el.value).toBe('ABC12');
  });
});
