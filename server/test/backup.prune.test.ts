/**
 * Retention. This is the one function in the backup path whose bug DESTROYS data rather
 * than failing to protect it, so it is pure and it gets a table of cases.
 *
 * Two rules carry it, and each has a case here that fails if the rule is dropped: only
 * files this worker itself wrote are ever candidates, and `keep` counts per SOURCE rather
 * than per directory.
 */
import { describe, it, expect } from 'vitest';
import { prunable } from '../src/backup/prune';
import { snapshotName } from '../src/backup/snapshot';

/** `n` snapshot names for one source, an hour apart, oldest first. */
function series(source: string, n: number): string[] {
  return Array.from({ length: n }, (_, i) => snapshotName(source, new Date(Date.UTC(2026, 8, 7, i))));
}

describe('prunable', () => {
  it('keeps the newest N of a source and returns the rest', () => {
    const files = series('/data/accounts.db', 5);
    expect(prunable(files, 2)).toEqual([files[0], files[1], files[2]]);
  });

  it('keeps everything while the set is at or under the limit', () => {
    const files = series('/data/accounts.db', 3);
    expect(prunable(files, 3)).toEqual([]);
    expect(prunable(files, 14)).toEqual([]);
  });

  it('counts PER SOURCE, so a big accounts history cannot age out billing', () => {
    // The directory-wide version of this function passes every test above and then, with
    // keep=3, leaves 3 files total: two accounts and one billing, or worse.
    const accounts = series('/data/accounts.db', 4);
    const billing = series('/data/billing.db', 2);
    const doomed = prunable([...accounts, ...billing], 3);
    expect(doomed).toEqual([accounts[0]]);
    for (const name of billing) expect(doomed).not.toContain(name);
  });

  it('ignores every file it did not write', () => {
    // A hand-made copy somebody is in the middle of examining, a half-written `.part`, the
    // status file, a restored database, a note. "Delete the oldest files in the directory"
    // deletes all five.
    const keepers = [
      'status.json',
      'accounts-2026-09-07T00-00-00Z.db.gz.part',
      'accounts-before-the-migration.db',
      'restored.db',
      'README',
      'billing-2026-09-07T00-00-00Z.db', // uncompressed: not our name either
    ];
    const ours = series('/data/accounts.db', 3);
    expect(prunable([...keepers, ...ours], 1)).toEqual([ours[0], ours[1]]);
  });

  it('orders by the timestamp in the NAME, not by listing order', () => {
    // mtimes lie after a restore or an `rsync -a`, which is why the stamp is in the name;
    // a shuffled listing must produce the same verdict.
    const files = series('/data/accounts.db', 4);
    const shuffled = [files[2]!, files[0]!, files[3]!, files[1]!];
    expect(new Set(prunable(shuffled, 2))).toEqual(new Set([files[0], files[1]]));
  });

  it('returns names in LISTING order, so a caller’s log is deterministic', () => {
    const files = series('/data/accounts.db', 4);
    expect(prunable([files[3]!, files[0]!, files[1]!], 1)).toEqual([files[0], files[1]]);
  });

  it('deletes nothing when keep is lost or nonsensical', () => {
    // Defence in depth against a config bug reaching this far: `keep < 1` here means
    // "something is wrong", and the safe reading of that is never "empty the directory".
    const files = series('/data/accounts.db', 5);
    expect(prunable(files, 0)).toEqual([]);
    expect(prunable(files, -1)).toEqual([]);
  });
});
