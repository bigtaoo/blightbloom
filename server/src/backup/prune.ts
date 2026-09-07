/**
 * Which snapshots to delete, as a pure function of the directory listing.
 *
 * Pure and separate from the deleting because this is the one part of a backup system
 * whose bug destroys data rather than merely failing to protect it. It gets a table of
 * cases (see `backup.prune.test.ts`) instead of a live directory.
 *
 * Two rules do the work:
 *
 *  1. **Only files this worker wrote are candidates.** Anything not matching
 *     `SNAPSHOT_RE` — a hand-made copy somebody scp'd in to compare, a half-written
 *     `.part`, a README, a restored `.db` — is invisible to this function. A pruner that
 *     deletes "the oldest files in the directory" deletes the evidence somebody was in
 *     the middle of examining.
 *  2. **`keep` is per SOURCE, not per directory.** accounts and billing land in the same
 *     directory at the same cadence, so a directory-wide count would keep 14 files, i.e.
 *     7 days of each, and one source failing for a week would silently push the other
 *     source's history out.
 */
import { SNAPSHOT_RE } from './snapshot';

/**
 * The snapshots to delete, given a directory listing and a per-source keep count.
 *
 * Ordering is by the timestamp ENCODED IN THE NAME (lexicographic on that field is
 * chronological, which is why the format is what it is), never by mtime — see
 * `snapshotName`. Returned in listing order so a caller's log reads deterministically.
 */
export function prunable(files: readonly string[], keep: number): string[] {
  if (keep < 1) return []; // a caller that lost its config must not sweep the directory
  const bySource = new Map<string, { name: string; stamp: string }[]>();
  for (const name of files) {
    const m = SNAPSHOT_RE.exec(name);
    if (!m) continue;
    const group = bySource.get(m[1]!) ?? [];
    group.push({ name, stamp: m[2]! });
    bySource.set(m[1]!, group);
  }
  const doomed = new Set<string>();
  for (const group of bySource.values()) {
    // Newest first, then everything past `keep`. No tie-break: a stamp collision would
    // mean two identical filenames, which a directory listing cannot contain — and adding
    // one anyway would be a branch no realistic input can reach.
    const ordered = [...group].sort((a, b) => b.stamp.localeCompare(a.stamp));
    for (const entry of ordered.slice(keep)) doomed.add(entry.name);
  }
  return files.filter((f) => doomed.has(f));
}
