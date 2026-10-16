/**
 * The visit's VISIBLE time (design/21 §2.9): wall time minus every stretch the page spent
 * hidden. Pure — a clock and a visibility flag in, milliseconds out — so the accounting is
 * testable without a document; `analyticsInstall.ts` feeds it `visibilitychange`.
 *
 * Playtime is read from this rather than from `session_end`'s `duration_s` because a tab
 * left open behind another for an hour is not an hour of play, and the platform judging the
 * launch (CrazyGames' "average playtime") counts the former, not the latter.
 */
export interface ActiveClock {
  /** Report the page's visibility. Idempotent: the same value twice changes nothing. */
  setVisible: (visible: boolean) => void;
  /** Visible milliseconds so far, including the stretch in progress. */
  activeMs: () => number;
}

export function createActiveClock(now: () => number, visible: boolean): ActiveClock {
  let banked = 0;
  // When the current visible stretch began, or null while hidden.
  let since: number | null = visible ? now() : null;

  return {
    setVisible(next) {
      if (next && since === null) {
        since = now();
      } else if (!next && since !== null) {
        // A clock that steps backwards (a suspended machine resynchronising) banks nothing
        // rather than a negative stretch.
        banked += Math.max(0, now() - since);
        since = null;
      }
    },
    activeMs() {
      return banked + (since === null ? 0 : Math.max(0, now() - since));
    },
  };
}
