/**
 * The backup worker's configuration, which is mostly a set of REFUSALS.
 *
 * The bug this file is written against does not throw and does not crash: a worker that
 * starts with nothing to do, logs one cheerful line, stays green, and is discovered on the
 * day somebody needs a restore. Every case below is a way that could happen.
 *
 * ## The refusal that moved, 2026-09-15
 *
 * Seven cases here used to be about SOURCE PATHS: three env vars naming SQLite files,
 * deliberately sharing the owning services' own variable names so a rename could not leave
 * this worker backing up a path nobody writes. They are gone, and so is the failure they
 * covered — `BACKUP_STORES` is compiled in, so "no sources" is unrepresentable rather than
 * refused.
 *
 * What replaced them is not nothing. The same no-op is now reachable through an unset
 * `BB_MONGO_URI`, and the same drift is now reachable through a store renamed in `mongo.ts`
 * and not here. Both are cases below. Deleting the old ones without replacing them is how a
 * port quietly loses the property the deleted tests were protecting.
 */
import { describe, it, expect } from 'vitest';
import { readBackupConfig, BackupConfigError, BACKUP_STORES } from '../src/backup/config';
import { STORES } from '../src/mongo';

const base = { BB_MONGO_URI: 'mongodb://cluster.example/' };

describe('readBackupConfig — sources', () => {
  it('backs up three of the cluster\'s four logical databases, in a fixed order', () => {
    expect(readBackupConfig(base).sources).toEqual(['accounts', 'billing', 'analytics']);
  });

  it('leaves `ops` out, and that is a decision rather than an oversight', () => {
    // Every document in `ops` is a value an operator typed over a default that is in git, so
    // a lost flag store costs the current override set — which the console shows and a human
    // retypes in a minute. The other three hold identity, money and measurement. Asserted
    // rather than left implicit, because "add the fourth, it is free" is the obvious change
    // and the argument against it lives in a comment nobody has to read.
    expect(BACKUP_STORES).not.toContain('ops');
    expect(STORES).toContain('ops');
  });

  it('REFUSES to start with no cluster to read', () => {
    // The successor to "no databases to back up". Same failure — a container that starts,
    // logs one cheerful line and backs up nothing — reached through the one input that can
    // still be missing.
    expect(() => readBackupConfig({})).toThrow(BackupConfigError);
    expect(() => readBackupConfig({})).toThrow(/BB_MONGO_URI is not set/);
  });

  it('treats an EMPTY BB_MONGO_URI as absent', () => {
    // design/19 §9 records this exact failure in the sibling project: a var set to '' beats
    // a `?? fallback`, because that only checks for nullish. A compose file with a trailing
    // `BB_MONGO_URI:` and no value produces it, and the driver's own error for an empty
    // connection string arrives one cycle later in a status file rather than at boot.
    expect(() => readBackupConfig({ BB_MONGO_URI: '' })).toThrow(/BB_MONGO_URI is not set/);
    expect(() => readBackupConfig({ BB_MONGO_URI: '   ' })).toThrow(/BB_MONGO_URI is not set/);
  });

  it('names only stores mongo.ts declares', () => {
    // The successor to "the source var names are shared with matchsvc/billsvc on purpose".
    // That sharing existed so a rename could not leave this worker reading a path nobody
    // writes; the same drift is now a store renamed in `mongo.ts` and not here, and the
    // consequence is worse — a database that silently stops being backed up, with a green
    // container and a status file full of successes for the two that still resolve.
    //
    // `BACKUP_STORES`'s `satisfies readonly StoreName[]` is what actually catches it, at
    // COMPILE time, which is why `config.ts` has no runtime check. This is the same claim
    // asserted where a reader looks for it — and it would survive somebody weakening that
    // declaration to a plain `as const`.
    for (const source of BACKUP_STORES) expect(STORES, source).toContain(source);
  });
});

describe('readBackupConfig — schedule and retention', () => {
  it('defaults to daily, keeping 14 per source, in /backups', () => {
    const cfg = readBackupConfig(base);
    expect(cfg.destDir).toBe('/backups');
    expect(cfg.intervalMs).toBe(24 * 3_600_000);
    expect(cfg.keep).toBe(14);
  });

  it('takes a fractional interval — the knob an operator turns to test a change', () => {
    expect(readBackupConfig({ ...base, BB_BACKUP_INTERVAL_HOURS: '0.5' }).intervalMs).toBe(1_800_000);
  });

  it('refuses a zero, negative or unparseable interval instead of clamping it', () => {
    // Clamping is the tempting move and it is wrong: `0` almost certainly means somebody
    // meant to disable the worker, and a busy-loop of full-collection scans against a live
    // cluster is a worse answer than a container that will not start.
    for (const value of ['0', '-1', 'nightly', 'NaN', '']) {
      const env = { ...base, BB_BACKUP_INTERVAL_HOURS: value };
      if (value === '') {
        expect(readBackupConfig(env).intervalMs, 'empty means unset').toBe(24 * 3_600_000);
      } else {
        expect(() => readBackupConfig(env), value).toThrow(BackupConfigError);
      }
    }
  });

  it('refuses a fractional keep count — "keep 2.5 snapshots" has no meaning', () => {
    expect(() => readBackupConfig({ ...base, BB_BACKUP_KEEP: '2.5' })).toThrow(/positive integer/);
    expect(readBackupConfig({ ...base, BB_BACKUP_KEEP: '3' }).keep).toBe(3);
  });

  it('refuses keep=0 — that is "back up and immediately delete"', () => {
    expect(() => readBackupConfig({ ...base, BB_BACKUP_KEEP: '0' })).toThrow(BackupConfigError);
  });

  it('takes a destination directory from the environment', () => {
    expect(readBackupConfig({ ...base, BB_BACKUP_DIR: '/mnt/snapshots' }).destDir).toBe('/mnt/snapshots');
    // ...and an empty one is unset, not a directory named "".
    expect(readBackupConfig({ ...base, BB_BACKUP_DIR: '' }).destDir).toBe('/backups');
  });
});
