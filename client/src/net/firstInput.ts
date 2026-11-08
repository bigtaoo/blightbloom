/**
 * The visit's first key or pointer press, reported once as `first_input` (analyticsEvents.ts).
 *
 * It answers the one question the portal's sandbox numbers could not (design/22 §4.1,
 * 2026-11-08): of the visits that leave inside half a minute, how many never touched the
 * game at all, and how long the rest looked at it first. Measured from the moment the entry
 * point calls this — after the first frame is drawn — so a slow download does not read as a
 * hesitant player.
 *
 * Capture-phase listeners on the window, so nothing the game does with the event (Pixi's
 * own pointer handling, a `preventDefault` on a game key) can hide it; both listeners are
 * removed by whichever fires first, so the cost after that is zero.
 */
import { track } from './analytics';

export type FirstInputKind = 'key' | 'pointer';

/** The slice of `window` this needs. */
export interface FirstInputTarget {
  addEventListener: (type: string, fn: () => void, opts?: AddEventListenerOptions) => void;
  removeEventListener: (type: string, fn: () => void, opts?: EventListenerOptions) => void;
}

/** The vocabulary's bound on `ms`; a longer wait is reported AT the bound rather than dropped. */
export const FIRST_INPUT_MAX_MS = 600_000;

/**
 * Call `onFirst` once, on the first `keydown` or `pointerdown`, with the ms since this call.
 * Returns a disposer that removes the listeners if neither has fired.
 */
export function watchFirstInput(
  target: FirstInputTarget,
  now: () => number,
  onFirst: (kind: FirstInputKind, ms: number) => void,
): () => void {
  const start = now();
  const opts = { capture: true, passive: true } as const;
  let done = false;
  const stop = (): void => {
    done = true;
    target.removeEventListener('keydown', onKey, opts);
    target.removeEventListener('pointerdown', onPointer, opts);
  };
  const fire = (kind: FirstInputKind): void => {
    if (done) return;
    stop();
    onFirst(kind, Math.min(FIRST_INPUT_MAX_MS, Math.max(0, Math.round(now() - start))));
  };
  const onKey = (): void => fire('key');
  const onPointer = (): void => fire('pointer');
  target.addEventListener('keydown', onKey, opts);
  target.addEventListener('pointerdown', onPointer, opts);
  return stop;
}

/** {@link watchFirstInput} wired to analytics: `screen` is read when the press lands. */
export function trackFirstInput(target: FirstInputTarget, now: () => number, screen: () => string): () => void {
  return watchFirstInput(target, now, (kind, ms) => track('first_input', { ms, kind, screen: screen() }));
}
