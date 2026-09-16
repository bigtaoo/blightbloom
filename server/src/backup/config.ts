/**
 * What the backup worker is configured with, and the refusals that keep a silent no-op
 * from looking like a working backup.
 *
 * The failure this file is written against is not a crash — it is a container that starts,
 * logs nothing interesting, stays green and backs up NOTHING, discovered on the day
 * somebody needs a restore. So every input is either present and valid or a startup
 * error: an absent cluster is refused rather than retried forever, and a zero/garbage
 * interval is refused rather than clamped into something plausible.
 */

import { mongoUriProblem, type StoreName } from '../mongo';

/** One resolved configuration. */
export interface BackupConfig {
  /** The logical databases to snapshot, in {@link BACKUP_STORES} order. */
  sources: readonly StoreName[];
  /** Where snapshots are written. Its own volume — never inside a source's directory. */
  destDir: string;
  /** Gap between cycles. */
  intervalMs: number;
  /** How many snapshots to keep PER SOURCE. Older ones are pruned. */
  keep: number;
}

export class BackupConfigError extends Error {
  override readonly name = 'BackupConfigError';
}

/**
 * What this worker snapshots: three of `mongo.ts`'s four logical databases.
 *
 * A compiled-in list rather than the three env vars it replaces. Those named FILE PATHS,
 * deliberately reusing the owning services' own variable names so that "which file is this"
 * stayed one fact with one name — a backup job that names its sources independently keeps
 * backing up the old path after a move. There are no paths now: `mongo.ts` owns the four
 * names, every service resolves a database from that same constant, and a list here that
 * could disagree with it would be the drift the env vars were guarding against.
 *
 * `ops` is deliberately NOT here, and the reason survived the move intact. Every document in
 * it is a value an operator typed, over a default that is in git — so a lost `ops` costs the
 * current override set, which the console shows and a human can retype in a minute, and
 * nothing that cannot be reconstructed. The other three hold identity, money and
 * measurement.
 */
export const BACKUP_STORES = ['accounts', 'billing', 'analytics'] as const satisfies readonly StoreName[];

const DEFAULT_DEST = '/backups';
const DEFAULT_INTERVAL_HOURS = 24;
const DEFAULT_KEEP = 14;

/**
 * An env var's value, treating an EMPTY string as absent.
 *
 * This is not defensive tidying: `design/19-server-platform.md` records a real failure in
 * the sibling project where a variable set to the empty string overrode a working default,
 * because `process.env.X ?? fallback` is only nullish-checked. A compose file with a
 * trailing `VAR:` produces exactly that.
 */
function pick(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const raw = env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** A positive finite number, or a startup error naming the variable. */
function positive(env: NodeJS.ProcessEnv, name: string, fallback: number, integer: boolean): number {
  const raw = pick(env, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || (integer && !Number.isInteger(value))) {
    throw new BackupConfigError(
      `${name} must be a positive ${integer ? 'integer' : 'number'}, got ${JSON.stringify(raw)}`,
    );
  }
  return value;
}

/**
 * Resolve the worker's configuration, or throw.
 *
 * The refusal that used to live here was "no sources": every source was an env var, so a
 * compose file that set none produced a container whose logs and health looked identical to
 * a working one. The sources are compiled in now, so that particular no-op cannot happen —
 * and it is replaced by the one that can. `BB_MONGO_URI` unset means this worker has no
 * cluster to read, and checking it HERE rather than letting the first cycle discover it is
 * the same distinction: a boot failure names the variable, while a failing cycle is a
 * status file somebody has to go and read.
 *
 * The drift the shared env-var names used to guard against — a store renamed in `mongo.ts`
 * and not here, so a database silently stops being backed up — is caught by
 * `BACKUP_STORES`'s `satisfies readonly StoreName[]` rather than by a check in this
 * function. That is a COMPILE error at the declaration, which is strictly stronger than a
 * throw at boot, and it is the reason there is no runtime loop here: a check that cannot
 * fail is a branch nothing can reach, which a coverage gate cannot tell apart from an
 * untested one.
 */
export function readBackupConfig(env: NodeJS.ProcessEnv): BackupConfig {
  const uri = pick(env, 'BB_MONGO_URI');
  if (uri === undefined) {
    throw new BackupConfigError(
      'BB_MONGO_URI is not set: there is no cluster to back up (a backup worker with nothing to read is a silent no-op)',
    );
  }
  // The shape check is shared with `mongoUri()` rather than restated, because this worker
  // reads the variable through its own path and would otherwise be the one service where a
  // placeholder URI still boots — into a cycle that fails, which is a status file somebody
  // has to go and read rather than a refusal at start.
  const problem = mongoUriProblem(uri);
  if (problem) {
    throw new BackupConfigError(`BB_MONGO_URI ${problem} (see server/deploy/README.md section 5)`);
  }
  return {
    sources: BACKUP_STORES,
    destDir: pick(env, 'BB_BACKUP_DIR') ?? DEFAULT_DEST,
    intervalMs: positive(env, 'BB_BACKUP_INTERVAL_HOURS', DEFAULT_INTERVAL_HOURS, false) * 3_600_000,
    keep: positive(env, 'BB_BACKUP_KEEP', DEFAULT_KEEP, true),
  };
}
