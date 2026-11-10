/**
 * Whether the player's keys reach the game: the portal-iframe focus problem, as one module sink.
 *
 * A portal draws the game in an iframe, and the browser sends key presses to whichever document
 * has focus. Until the player clicks inside the frame that is the portal's page, so a first-time
 * desktop player dropped straight into the teaching run presses WASD and nothing moves. The
 * sandbox measured it (design/22 §4.1, 2026-11-10): of 46 first inputs, all 46 were pointer
 * presses and none a key, and 17 of 63 runs were never touched at all. Holy Kicker hit the same
 * wall on CrazyGames and Playgama (D:/standing `platform/web/WebPlatform.ts`), and this is its
 * answer, ported:
 *
 * - **Ask for the keys.** `installKeyFocus` calls `window.focus()` at boot and on every press
 *   inside the frame. A portal may still keep them until a click, so this narrows the problem
 *   rather than closing it.
 * - **Say so while they don't arrive.** `keysReach()` is read by the move lesson
 *   (`TutorialHintController`), which then asks for a click instead of teaching WASD, and
 *   flags that with `setAwaitingKeys` so a host session can hold the run still meanwhile
 *   (`PlaygamaSession.watchKeys`).
 * - **Count it.** `attention()` is what Playgama's events carry (`bridgeAnalytics.ts`).
 *
 * A sink rather than a dependency because its readers sit on both sides of the platform line:
 * the lesson in the pure game layer has to ask without importing the DOM. The defaults are the
 * answer for a host with no iframe (WeChat, a test): the keys always reach.
 */

/** What Playgama's events carry: has the game EVER had the keys this visit, and has the player
 *  pressed inside it. Both only ever go false → true. */
export interface Attention {
  focus: boolean;
  input: boolean;
}

/** The slice of `window` this needs. */
export interface KeyFocusWindow {
  focus(): void;
  addEventListener(type: string, fn: () => void, opts?: AddEventListenerOptions): void;
}

/** The slice of `document` this needs. */
export interface KeyFocusDocument {
  hasFocus(): boolean;
}

let reach: () => boolean = () => true;
let seen: Attention | null = null;
let awaiting = false;
let focusListeners: Array<() => void> = [];

/** Do key presses reach the game right now? */
export function keysReach(): boolean {
  return reach();
}

/** The visit's attention so far, or null before `installKeyFocus` (no fields are sent then). */
export function attention(): Attention | null {
  if (seen === null) return null;
  if (reach()) seen.focus = true;
  return { ...seen };
}

/** Set by the move lesson while its panel asks for a click instead of teaching the keys. */
export function setAwaitingKeys(on: boolean): void {
  awaiting = on;
}

/** Is a lesson waiting for the keys, and are they still elsewhere? A host holds the run on this. */
export function heldForKeys(): boolean {
  return awaiting && !reach();
}

/** Called each time the game's window gains focus — a held run cannot wait for a tick to notice. */
export function onKeyFocus(fn: () => void): void {
  focusListeners.push(fn);
}

/** Wire the sink to a real window. Once, at boot, before anything reads `attention()`. */
export function installKeyFocus(win: KeyFocusWindow, doc: KeyFocusDocument): void {
  const s: Attention = { focus: false, input: false };
  try {
    win.focus();
  } catch {
    // A host that refuses the call leaves the keys where they were; the hint covers that.
  }
  s.focus = doc.hasFocus();
  win.addEventListener('focus', () => {
    s.focus = true;
    for (const fn of focusListeners) fn();
  });
  // Capture phase, so nothing the game does with the press (Pixi's own handling) can hide it.
  win.addEventListener('pointerdown', () => {
    s.input = true;
    try {
      win.focus();
    } catch {
      // as above
    }
  }, { capture: true, passive: true });
  reach = () => doc.hasFocus();
  seen = s;
}

/** Back to the no-iframe defaults. Tests only. */
export function resetKeyFocus(): void {
  reach = () => true;
  seen = null;
  awaiting = false;
  focusListeners = [];
}
