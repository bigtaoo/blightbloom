/**
 * A real HTML `<input>` overlaid on top of the Pixi canvas (design/10 "no DOM
 * widgets" is about ON-CANVAS chrome — text entry is the one thing Pixi has no native
 * primitive for at all, and this repo has no on-screen-keyboard precedent to reuse).
 * Used for the party room-code field (design/05/15's squad follow-up) — a single
 * short field, not a form, so a fixed-position centered overlay is simpler and more
 * robust across resizes than trying to track the exact canvas pixel position of a
 * Pixi-drawn field.
 *
 * Lifecycle: `open()` creates and focuses the element; it tears itself down on
 * submit (Enter), cancel (Escape or the caller calling `close()`), or blur — never
 * left dangling in the DOM.
 */
export interface TextInputOverlayOptions {
  placeholder?: string;
  maxLength?: number;
  /** Upper-cased as typed. Kept for a field where case shouldn't matter to the player;
   *  {@link numeric} supersedes it for the room code, which has no letters left in it. */
  uppercase?: boolean;
  /**
   * Digits only (the room code since 2026-09-21, `server/src/routes/party.ts`).
   *
   * Three separate things, because a browser needs all three and no one of them is enough:
   * `inputmode="numeric"` is what makes a phone show a keypad instead of a full keyboard;
   * `pattern` is what stops iOS Safari from ignoring `inputmode` on a `type="text"` field;
   * and the `input` listener is the only one of the three that actually ENFORCES anything —
   * both attributes are hints a hardware keyboard, an IME or a paste blows straight past.
   * `type="number"` is deliberately not used: it strips leading zeros, which a code like
   * `004271` needs, and offers spinner arrows for a field that is not a quantity.
   */
  numeric?: boolean;
  /** Masks input as `••••` (design/16-accounts.md's password field) — otherwise plain text. */
  password?: boolean;
  onSubmit: (value: string) => void;
  onCancel?: () => void;
}

export class TextInputOverlay {
  private el: HTMLInputElement | null = null;

  get isOpen(): boolean {
    return this.el !== null;
  }

  open(opts: TextInputOverlayOptions): void {
    this.close(); // never stack two
    const input = document.createElement('input');
    input.type = opts.password ? 'password' : 'text';
    input.placeholder = opts.placeholder ?? '';
    input.maxLength = opts.maxLength ?? 32;
    input.autocapitalize = opts.password || opts.numeric ? 'off' : 'characters';
    input.autocomplete = opts.password ? 'current-password' : 'off';
    input.spellcheck = false;
    if (opts.numeric) {
      input.inputMode = 'numeric';
      input.pattern = '[0-9]*'; // see `numeric`'s note — this is what iOS Safari reads
    }
    Object.assign(input.style, {
      position: 'fixed',
      left: '50%',
      top: '50%',
      transform: 'translate(-50%, -50%)',
      zIndex: '10000',
      fontSize: '24px',
      fontFamily: 'monospace',
      textAlign: 'center',
      letterSpacing: '4px',
      padding: '10px 16px',
      borderRadius: '8px',
      border: '2px solid #63b3ed',
      background: '#0b0e14',
      color: '#e2e8f0',
      width: '220px',
    } satisfies Partial<CSSStyleDeclaration>);

    // `numeric` first and `else if`: stripping non-digits already covers case, and running
    // both would fight over `input.value` on the same event.
    if (opts.numeric) {
      input.addEventListener('input', () => {
        const digits = input.value.replace(/\D+/g, '');
        if (digits !== input.value) input.value = digits;
      });
    } else if (opts.uppercase) {
      input.addEventListener('input', () => {
        const upper = input.value.toUpperCase();
        if (upper !== input.value) input.value = upper;
      });
    }
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const value = input.value;
        this.close();
        opts.onSubmit(value);
      } else if (e.key === 'Escape') {
        this.close();
        opts.onCancel?.();
      }
      e.stopPropagation(); // never let a keystroke also drive the game's own key handlers
    });
    // Blur teardown (the class doc's third documented close trigger, previously
    // unimplemented): without this, tapping a nearby Pixi button instead of pressing
    // Escape left the still-focused/still-present DOM `<input>` sitting on top of the
    // canvas, able to intercept that very click instead of letting it reach the button
    // underneath. `this.el !== input` guards against `close()`'s own `.remove()` call
    // synchronously re-triggering this same blur handler (removing a focused element
    // fires a native blur) — that path already reset `this.el` to null first, so this
    // only ever proceeds for a GENUINE external blur.
    input.addEventListener('blur', () => {
      if (this.el !== input) return;
      this.close();
      opts.onCancel?.();
    });

    document.body.appendChild(input);
    this.el = input;
    input.focus();
  }

  close(): void {
    const el = this.el;
    if (!el) return;
    this.el = null; // clear BEFORE remove() — see the blur listener's re-entrancy guard above
    el.remove();
  }
}
