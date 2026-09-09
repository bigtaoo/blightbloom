/**
 * What the backup worker is configured with, and the refusals that keep a silent no-op
 * from looking like a working backup.
 *
 * The failure this file is written against is not a crash — it is a container that starts,
 * logs nothing interesting, stays green and backs up NOTHING, discovered on the day
 * somebody needs a restore. So every input is either present and valid or a startup
 * error: no source path defaults to a guess, and a zero/garbage interval is refused
 * rather than clamped into something plausible.
 */

/** One resolved configuration. Paths are absolute, as they arrive from compose. */
export interface BackupConfig {
  /** The live SQLite files to snapshot, in the order they were declared. */
  sources: readonly string[];
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
 * The env names this worker reads. `BB_DB_PATH` / `BB_BILLING_DB_PATH` are deliberately
 * the SAME names matchsvc and billsvc use for the databases they own: a backup job that
 * names its sources independently is a job that keeps backing up the old path after a
 * move, and the compose file would then carry two spellings of one fact.
 */
export const SOURCE_VARS = ['BB_DB_PATH', 'BB_BILLING_DB_PATH', 'BB_ANALYTICS_DB_PATH'] as const;

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
 * Throwing on "no sources" is the load-bearing decision here. The alternative — start,
 * find nothing to do, sleep — is a container whose logs and health look identical to a
 * working one.
 */
export function readBackupConfig(env: NodeJS.ProcessEnv): BackupConfig {
  const sources = SOURCE_VARS.map((name) => pick(env, name)).filter((v): v is string => v !== undefined);
  if (sources.length === 0) {
    throw new BackupConfigError(
      `no databases to back up: set at least one of ${SOURCE_VARS.join(', ')} (a backup worker with nothing to back up is a silent no-op)`,
    );
  }
  const destDir = pick(env, 'BB_BACKUP_DIR') ?? DEFAULT_DEST;
  for (const source of sources) {
    // A snapshot written beside its source would be backed up by the next cycle, and the
    // directory would grow by a copy of a copy every interval.
    if (source.startsWith(`${destDir}/`)) {
      throw new BackupConfigError(`source ${source} lies inside the backup directory ${destDir}`);
    }
  }
  return {
    sources,
    destDir,
    intervalMs: positive(env, 'BB_BACKUP_INTERVAL_HOURS', DEFAULT_INTERVAL_HOURS, false) * 3_600_000,
    keep: positive(env, 'BB_BACKUP_KEEP', DEFAULT_KEEP, true),
  };
}
