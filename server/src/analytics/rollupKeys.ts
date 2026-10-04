// Day keys, offsets and label keys for the analytics rollup — split out of `rollup.ts` as a
// leaf module so `rollup.ts` and `newInstalls.ts` can both read them without importing each other.

/** The offsets tracked, in one place — adding D14 is this line plus a dashboard panel. */
export const RETENTION_OFFSETS = [1, 2, 3, 4, 5, 6, 7] as const;

/** `YYYY-MM-DD` plus a signed number of days. Text in, text out — the format sorts
 *  chronologically, which is why every comparison in this module is a string compare. */
export function addDays(day: string, delta: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + delta * 86_400_000).toISOString().slice(0, 10);
}

/** The most recent day that is over. Everything computed here is about this day or earlier. */
export function lastCompleteDay(todayKey: string): string {
  return addDays(todayKey, -1);
}

/**
 * The newest cohort whose `offset`-day answer is known.
 *
 * Derived rather than passed in, because getting it wrong is the classic off-by-one here: a
 * cohort's D`n` is knowable once day `cohort + n` is COMPLETE, so the newest such cohort is
 * `lastCompleteDay - n`, not `today - n`.
 */
export function newestKnownCohort(todayKey: string, offset: number): string {
  return addDays(lastCompleteDay(todayKey), -offset);
}

/** Labels as a stable string, so the uniqueness key means what it looks like.
 *  `JSON.stringify` preserves insertion order, which two callers building the same object
 *  from different code paths would not — so the keys are sorted before serialising. */
export function canonicalLabels(labels: Record<string, string>): string {
  const keys = Object.keys(labels).sort();
  return JSON.stringify(Object.fromEntries(keys.map((k) => [k, labels[k]])));
}
