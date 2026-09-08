/**
 * The backup worker's entry point — the fourth process in `docker-compose.yml`, and the
 * first one that is not an HTTP server.
 *
 * It exists because `accounts.db` and `billing.db` hold the two things this project cannot
 * regenerate: who somebody is, and what they paid for. Both live as single SQLite files on
 * a box this project only borrows, and `server/deploy/README.md` documented a MANUAL `scp`
 * as the backup procedure — which is a procedure in the sense that a note saying "remember
 * to breathe" is a procedure.
 *
 * ## Two modes, one bundle
 *
 *   node backup.mjs            the loop: one cycle now, then every BB_BACKUP_INTERVAL_HOURS
 *   node backup.mjs --health   read status.json, exit 0 if healthy, 1 if not
 *
 * The health mode is what compose's `healthcheck` runs. Putting it in the bundle rather
 * than inlining a `node -e` one-liner in the compose file is deliberate: the rule it
 * applies (every source ok, and the cycle recent enough) is real logic with real edge
 * cases, and logic in a YAML string is logic no test can reach.
 *
 * ## What it deliberately does not do
 *
 * No off-box copy. A snapshot beside the database survives every failure this project has
 * actually had (a bad migration, a hand-edited row, a `rm` in the wrong directory) and
 * none of the ones that take the host with it. Getting the `./backups` directory off the
 * machine is a human step, documented in `server/deploy/README.md`, and it is honest to
 * leave it visible there rather than pretend a container solved it.
 */
import { fileURLToPath } from 'node:url';
import { readBackupConfig, BackupConfigError, type BackupConfig } from './config';
import { isHealthy, readStatus, runCycle, writeStatus } from './runner';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** `--health`: the compose healthcheck. Never starts a cycle and never writes anything. */
export function healthExitCode(cfg: BackupConfig, now: Date): number {
  const status = readStatus(cfg.destDir);
  if (isHealthy(status, now, cfg.intervalMs)) return 0;
  const why = status === null ? 'no status.json yet' : status.ok ? `last cycle ${status.at} is stale` : `last cycle ${status.at} had failures`;
  console.error(`backup unhealthy: ${why}`);
  return 1;
}

/**
 * The loop. One cycle immediately, so a fresh deploy has a verified snapshot within
 * seconds instead of a day — and so the healthcheck has something to read before its
 * `start_period` runs out.
 */
export async function runForever(cfg: BackupConfig, now: () => Date = () => new Date()): Promise<never> {
  for (;;) {
    const result = runCycle(cfg, now());
    writeStatus(cfg.destDir, result);
    await sleep(cfg.intervalMs);
  }
}

/** Resolve config, or print the refusal and exit non-zero — see `config.ts` on why a
 *  misconfigured backup worker must not start rather than start and do nothing. */
export function loadOrExit(env: NodeJS.ProcessEnv): BackupConfig {
  try {
    return readBackupConfig(env);
  } catch (err) {
    if (err instanceof BackupConfigError) {
      console.error(`backup: ${err.message}`);
      process.exit(2);
    }
    throw err;
  }
}

export async function main(argv: readonly string[], env: NodeJS.ProcessEnv): Promise<void> {
  const cfg = loadOrExit(env);
  if (argv.includes('--health')) {
    process.exit(healthExitCode(cfg, new Date()));
  }
  console.log(
    `backup: ${cfg.sources.length} source(s) -> ${cfg.destDir}, every ${cfg.intervalMs / 3_600_000}h, keeping ${cfg.keep} per source`,
  );
  await runForever(cfg);
}

// Only auto-start when run directly — the same ESM `require.main === module` guard
// `index.ts`, `matchsvc.ts` and `billsvc/main.ts` use. It matters more here than there:
// what this file starts is a loop that never returns, so a test importing it without the
// guard would hang rather than fail.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void main(process.argv.slice(2), process.env);
}
