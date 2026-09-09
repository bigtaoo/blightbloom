/**
 * The backup worker's configuration, which is mostly a set of REFUSALS.
 *
 * The bug this file is written against does not throw and does not crash: a worker that
 * starts with nothing to do, logs one cheerful line, stays green, and is discovered on the
 * day somebody needs a restore. Every case below is a way that could happen.
 */
import { describe, it, expect } from 'vitest';
import { readBackupConfig, BackupConfigError, SOURCE_VARS } from '../src/backup/config';

const base = { BB_DB_PATH: '/sources/matchsvc/accounts.db' };

describe('readBackupConfig — sources', () => {
  it('takes every database, in declaration order, from the owning services’ own var names', () => {
    const cfg = readBackupConfig({
      BB_DB_PATH: '/sources/matchsvc/accounts.db',
      BB_BILLING_DB_PATH: '/sources/billsvc/billing.db',
      BB_ANALYTICS_DB_PATH: '/sources/matchsvc/analytics.db',
    });
    expect(cfg.sources).toEqual([
      '/sources/matchsvc/accounts.db',
      '/sources/billsvc/billing.db',
      '/sources/matchsvc/analytics.db',
    ]);
    // The names are shared with matchsvc/billsvc on purpose; a rename there must not leave
    // this worker backing up a path nobody writes to any more.
    expect(SOURCE_VARS).toEqual(['BB_DB_PATH', 'BB_BILLING_DB_PATH', 'BB_ANALYTICS_DB_PATH']);
  });

  it('keeps working when a source var is not set at all, which is how one is added', () => {
    // design/21 §2.4 adds the analytics database to this list before compose sets its var.
    // A worker that refused an unset member of SOURCE_VARS would turn "a new source is
    // being introduced" into "no backups at all" — the exact failure this worker exists to
    // prevent, arriving through its own configuration.
    const cfg = readBackupConfig({ BB_DB_PATH: '/a.db', BB_BILLING_DB_PATH: '/b.db' });
    expect(cfg.sources).toEqual(['/a.db', '/b.db']);
  });

  it('accepts either one alone — billing exists before accounts does not', () => {
    expect(readBackupConfig({ BB_BILLING_DB_PATH: '/b/billing.db' }).sources).toEqual(['/b/billing.db']);
  });

  it('REFUSES to start with no source at all', () => {
    expect(() => readBackupConfig({})).toThrow(BackupConfigError);
    expect(() => readBackupConfig({})).toThrow(/no databases to back up/);
  });

  it('treats an EMPTY var as absent, and so refuses on two empty ones', () => {
    // design/19 records this exact failure in the sibling project: a var set to '' beats a
    // `?? fallback`, because that only checks for nullish. A compose file with a trailing
    // `BB_DB_PATH:` and no value produces it.
    expect(() => readBackupConfig({ BB_DB_PATH: '', BB_BILLING_DB_PATH: '   ' })).toThrow(
      /no databases to back up/,
    );
  });

  it('trims a stray space rather than opening " /data/x.db"', () => {
    expect(readBackupConfig({ BB_DB_PATH: ' /data/x.db ' }).sources).toEqual(['/data/x.db']);
  });

  it('refuses a source INSIDE the backup directory — a copy of a copy every cycle', () => {
    expect(() => readBackupConfig({ BB_DB_PATH: '/backups/accounts.db' })).toThrow(/lies inside/);
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
    // meant to disable the worker, and a busy-loop of VACUUMs is a worse answer than a
    // container that will not start.
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
});
