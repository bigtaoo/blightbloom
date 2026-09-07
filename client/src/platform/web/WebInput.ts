import type { InputCanvas, InputSource, InputState, TouchVisual } from '../types';
import { TouchControls } from '../TouchControls';

/**
 * Keys whose DEFAULT browser action has to be cancelled while the game has focus.
 *
 * The arrows and Space scroll the document. That is harmless on our own page (the body is
 * `overflow: hidden`), and it is not harmless inside somebody else's iframe: a portal
 * embeds the game in a scrollable page, and both the CrazyGames SDK docs and their
 * requirements ask for exactly this cancellation by name. Space is the worse of the two —
 * it is a game key here (the revive channel) as well as a page-scroll key, so without this
 * a held revive scrolls the host page under the player.
 *
 * Tab is not in the list on purpose: hijacking it breaks keyboard navigation out of the
 * frame, which is an accessibility regression rather than a scroll fix.
 */
const SCROLL_KEYS: ReadonlySet<string> = new Set([
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space',
]);

/**
 * True while a real DOM text field has focus — the login/party-code overlay
 * (`game/ui/TextInputOverlay.ts` puts a genuine `<input>` over the canvas).
 *
 * Space and the arrows are editing keys inside a text field: cancelling their default there
 * would stop the player typing a space in a username and stop the caret moving at all. The
 * scroll fix has to yield to that, which is why it is a condition and not an unconditional
 * `preventDefault`.
 */
function isTextFieldFocused(): boolean {
  const el = typeof document === 'undefined' ? null : document.activeElement;
  const tag = (el as HTMLElement | null)?.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || (el as HTMLElement | null)?.isContentEditable === true;
}

/**
 * Whether this session's PRIMARY pointer is coarse, i.e. this is a touch-first device and
 * the on-screen controls are the whole control scheme rather than an overlay over a mouse.
 *
 * `(pointer: coarse)` describes the primary pointer specifically, which is the distinction
 * that matters: a touchscreen laptop answers `false` here (its mouse is primary) and gets no
 * overlay, while a phone or tablet answers `true` and gets one before the player has touched
 * anything. `any-pointer` would be the wrong query — it answers `true` for the laptop too.
 *
 * A pure function over the matcher so the branch is testable with no DOM (design/18), and
 * every failure path answers `false`: an environment that cannot answer is not a phone.
 */
export function prefersTouchControls(
  matchMedia?: (query: string) => { matches: boolean },
): boolean {
  try {
    return matchMedia?.('(pointer: coarse)').matches === true;
  } catch {
    return false;
  }
}

// Web input. Desktop uses keyboard + mouse; touch devices (mobile browser, Capacitor
// webview) use the shared virtual twin-stick. Both are attached; read() returns the
// touch state whenever a control is being touched, otherwise keyboard/mouse.
export class WebInput implements InputSource {
  private keys = new Set<string>();
  private leftDown = false;

  private controls = new TouchControls();

  onSwitchWeapon: ((slot: number) => void) | null = null;

  attach(canvasLike: InputCanvas) {
    const canvas = canvasLike as unknown as HTMLCanvasElement;

    // ---- keyboard + mouse ----
    window.addEventListener('keydown', (e) => {
      // Cancel the page-scroll default BEFORE the repeat guard below, and on every repeat:
      // a HELD arrow key fires `keydown` continuously, and only the first one would reach
      // an early `return`. See SCROLL_KEYS for why this matters in an embedded frame.
      if (SCROLL_KEYS.has(e.code) && !isTextFieldFocused()) e.preventDefault();
      if (this.keys.has(e.code)) return;
      this.keys.add(e.code);
      if (e.code === 'Digit1') this.onSwitchWeapon?.(1);
      if (e.code === 'Digit2') this.onSwitchWeapon?.(2);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));

    canvas.addEventListener('mousedown', (e) => {
      if (e.button === 0) this.leftDown = true;
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.leftDown = false;
    });

    // ---- touch (mobile / Capacitor) ----
    this.controls.onSwitchWeapon = (slot) => this.onSwitchWeapon?.(slot);
    // Draw the controls from the first frame on a touch-first device, rather than waiting
    // for a touch that the player has no way to know where to make (TouchControls'
    // `assumeTouch` field has the full account).
    this.controls.setAssumeTouch(
      prefersTouchControls(
        typeof window.matchMedia === 'function' ? (q) => window.matchMedia(q) : undefined,
      ),
    );

    const relayout = () => {
      const r = canvas.getBoundingClientRect();
      this.controls.layout(r.width, r.height);
    };
    relayout();
    window.addEventListener('resize', relayout);

    const feed = (e: TouchEvent, fn: (id: number, x: number, y: number) => void) => {
      const r = canvas.getBoundingClientRect();
      for (const t of Array.from(e.changedTouches)) {
        fn(t.identifier, t.clientX - r.left, t.clientY - r.top);
      }
    };
    canvas.addEventListener('touchstart', (e) => { e.preventDefault(); feed(e, (id, x, y) => this.controls.pointerDown(id, x, y)); }, { passive: false });
    canvas.addEventListener('touchmove', (e) => { e.preventDefault(); feed(e, (id, x, y) => this.controls.pointerMove(id, x, y)); }, { passive: false });
    const end = (e: TouchEvent) => { e.preventDefault(); for (const t of Array.from(e.changedTouches)) this.controls.pointerUp(t.identifier); };
    canvas.addEventListener('touchend', end, { passive: false });
    canvas.addEventListener('touchcancel', end, { passive: false });
  }

  getTouchVisual(): TouchVisual {
    return this.controls.getVisual();
  }

  setControlMirror(mirrored: boolean): void {
    this.controls.setMirrored(mirrored);
  }

  read(): InputState {
    if (this.controls.hasActiveTouch()) return this.controls.read();

    const k = this.keys;
    let mx = 0;
    let my = 0;
    if (k.has('KeyW') || k.has('ArrowUp')) my -= 1;
    if (k.has('KeyS') || k.has('ArrowDown')) my += 1;
    if (k.has('KeyA') || k.has('ArrowLeft')) mx -= 1;
    if (k.has('KeyD') || k.has('ArrowRight')) mx += 1;
    const len = Math.hypot(mx, my) || 1;
    return {
      moveX: mx / len,
      moveY: my / len,
      firing: this.leftDown,
      // E or Space held = INTERACT (extraction checkpoint hold/tap, ROADMAP 1.4).
      interacting: k.has('KeyE') || k.has('Space'),
    };
  }
}
